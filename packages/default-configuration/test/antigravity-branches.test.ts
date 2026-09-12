/**
 * Exercises Antigravity branches of the consolidated action handlers (launch,
 * chat, interview, captain) through end-to-end scenarios. Locks in spawn argv
 * (terminal-owned `-i`, child-owned `-p --output-format stream-json`, never
 * `--dangerously-skip-permissions`), worktree cwd + card env vars, background
 * final-record classification (exit zero without the expected final record is
 * failure), cancellation drain, and branch-cleanup wiring for the Antigravity
 * path.
 *
 * @summary Tests Antigravity branches of consolidated action handlers
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cross-spawn', async () => {
  // spawnAgentCli routes the agent launch through cross-spawn; forward it to the
  // mocked node:child_process.spawn so spawn('agy', ...) assertions hold on
  // every platform (cross-spawn would otherwise rewrite the call into a cmd.exe
  // invocation on win32 and bypass the node:child_process mock).
  const cp = await import('node:child_process');
  return { default: cp.spawn };
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn()
}));

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn()
}));

vi.mock('node:fs/promises', async () => {
  // `constants` passes through un-mocked: the launcher probes the marker
  // store's writability with the real W_OK rather than a stubbed flag.
  const { constants } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    access: vi.fn(),
    constants,
    cp: vi.fn(),
    mkdir: vi.fn(),
    mkdtemp: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    realpath: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn()
  };
});

vi.mock('@cards.management/sdk/worktree', () => ({
  createWorktree: vi.fn(),
  checkWorktreeExists: vi.fn(),
  findGitRoots: vi.fn()
}));

vi.mock('@cards.management/sdk/bin/process-utils', () => ({
  readCardStatus: vi.fn()
}));

vi.mock('@cards.management/sdk/transcript-sync', () => ({
  finalizePersistedSqlitePollSession: vi.fn()
}));

// createWorktreeForCard wraps the pure createWorktree git primitive with the
// per-card outfit. Mock it as a thin adapter that forwards to the low-level
// createWorktree mock (see claude-session.test.ts) so these tests keep asserting
// the pure-primitive call shape without running the real outfit side effects.
vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

vi.mock('../src/lib/branch-cleanup-watcher.js', () => ({
  spawnBranchCleanupWatcher: vi.fn()
}));

const WORKTREE_PATH = '/test/workspace/.worktrees/cards/card-123/1';
const AGENT = 'antigravity-cli';
const ANTIGRAVITY_HOME = '/test/antigravity-cli';
const CONVERSATION_ID = '8724cd98-6b07-4080-82d3-1c617be236bf';

const originalFetch = globalThis.fetch;

/**
 * The Antigravity profile these branches start from: a project the user already
 * approved, whose freshly created card worktree is the checkout under test. The
 * checkout is already recorded as trusted, so workspace-trust preparation is a
 * read-only pass here and these tests keep asserting launch mechanics.
 */
const PROFILE_SETTINGS = JSON.stringify({
  toolPermission: 'always-proceed',
  trustedWorkspaces: [WORKTREE_PATH]
});

/**
 * Serves what mocked `fs.readFile` calls should see: the Antigravity profile,
 * and ENOENT for anything else.
 *
 * @param path - Path the launcher tried to read.
 * @returns The file contents that path should present.
 * @throws {NodeJS.ErrnoException} When the path should not exist.
 */
function readMockFile(path: string): string {
  if (path === `${ANTIGRAVITY_HOME}/settings.json`) {
    return PROFILE_SETTINGS;
  }
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['API_TEST_MODE'] = '1';
  process.env['ANTIGRAVITY_HOME'] = ANTIGRAVITY_HOME;
  delete process.env['CARDS_HOME'];
  delete process.env['EXIT_WHEN_DONE'];

  const { execFile, execFileSync } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const syncFs = await import('node:fs');

  // Git commands for the base-branch/worktree lifecycle.
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    const cmd = args[0] as string;
    const cmdArgs = args[1] as string[];
    const key = `${cmd} ${cmdArgs.join(' ')}`;

    if (typeof cb === 'function') {
      if (key.startsWith('git rev-parse --abbrev-ref HEAD')) {
        cb(null, { stdout: 'main\n', stderr: '' });
      } else if (key.startsWith('git rev-parse --git-common-dir')) {
        // Repository identity for the workspace-trust preparation: the card
        // worktree and the trusted project root report the same common dir.
        cb(null, { stdout: '/test/workspace/.git\n', stderr: '' });
      } else {
        cb(new Error(`mock: unhandled command: ${key}`));
      }
    }

    return {} as ReturnType<typeof execFile>;
  });
  vi.mocked(execFileSync).mockImplementation(() => '');

  vi.mocked(syncFs.readFileSync).mockImplementation((filePath: Parameters<typeof syncFs.readFileSync>[0]) => {
    throw Object.assign(new Error(`mock: unhandled readFileSync: ${String(filePath)}`), { code: 'ENOENT' });
  });

  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve(
        new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
      );
    }
    if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });

  const { createWorktree, checkWorktreeExists, findGitRoots } = await import('@cards.management/sdk/worktree');
  vi.mocked(findGitRoots).mockResolvedValue({ sourceRoot: '/test/workspace', repoRoot: '/test/workspace' });
  vi.mocked(checkWorktreeExists).mockResolvedValue(false);

  const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
  vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) => createWorktree(ref, { cwd: opts.cwd }));
  vi.mocked(createWorktree).mockResolvedValue({
    path: WORKTREE_PATH,
    settle: Promise.resolve({
      branch: 'cards/card-123/1',
      worktree: WORKTREE_PATH,
      baseSha: 'abc123',
      copiedFromInclude: 0,
      reroutedSymlinks: 0
    })
  });

  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  vi.mocked(fs.access).mockResolvedValue(undefined);
  vi.mocked(fs.readFile).mockImplementation(async (filePath) => readMockFile(String(filePath)));
  // Physical-path resolution is identity in these tests: the fixture paths are
  // already physical, and only the workspace-trust preparation uses realpath.
  vi.mocked(fs.realpath).mockImplementation(async (filePath) => String(filePath));
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: string | URL) => `${String(prefix)}XXXXXX`);
  vi.mocked(fs.cp).mockResolvedValue(undefined);
  vi.mocked(fs.rename).mockResolvedValue(undefined);
  vi.mocked(fs.rm).mockResolvedValue(undefined);
  vi.mocked(fs.readdir).mockImplementation(async (directory) => {
    if (String(directory).includes('/antigravity/runtime/markers/')) {
      return [] as never;
    }
    throw enoent;
  });
  vi.mocked(fs.stat).mockRejectedValue(enoent);
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
  vi.mocked(finalizePersistedSqlitePollSession).mockResolvedValue({ kind: 'flushed', emitted: 0, partial: 0 });
  const { readCardStatus } = await import('@cards.management/sdk/bin/process-utils');
  vi.mocked(readCardStatus).mockResolvedValue('needs_review');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
  delete process.env['CARDS_AGENT_MODEL'];
  delete process.env['CARDS_AGENT_EFFORT'];
  delete process.env['ANTIGRAVITY_HOME'];
});

function createMockContext(): ActionContext {
  return {
    logger: new Logger(),
    cwd: process.cwd(),
    onCancel: vi.fn(),
    onAgentShutdown: vi.fn(),
    onSwitchToInteractive: vi.fn()
  };
}

/**
 * Builds a mock child with EventEmitter stdout/stderr so background tests can
 * drive stream-json parsing and close/error deterministically.
 *
 * @returns A ChildProcess-shaped mock with event-driven stdio.
 */
function createMockChild(): ChildProcess {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    pid: 12345,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
      return true;
    }
  } as unknown as ChildProcess;
}

function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    repoRoot: '/test/workspace',
    cardRepoPath: '/test/repo',
    configPath: '/test/config',
    extensionPath: '/test/extension',
    codingAgent: AGENT,
    ...overrides,
    // Spreading a `Partial` widens these back to `| undefined`; both are
    // required by `ActionInput`, and both defaults mirror what the suite
    // exports in `beforeEach` / what the dispatcher supplies
    // (`opts?.exitWhenDone ?? false`). Supplying them after the spread keeps
    // the literal assignable without narrowing what a caller may override.
    exitWhenDone: overrides?.exitWhenDone ?? false,
    marketplacePath: overrides?.marketplacePath ?? '/test/extension/dist/marketplace'
  };
}

describe('resolveCodingAgent — antigravity', () => {
  it('resolves antigravity-cli to itself', async () => {
    const { resolveCodingAgent } = await import('../src/lib/coding-agent.js');

    expect(resolveCodingAgent({ codingAgent: 'antigravity-cli' })).toBe('antigravity-cli');
  });
});

describe('launch action — antigravity branch', () => {
  it('awaits worktree settlement and does not spawn when it rejects', async () => {
    const { spawn } = await import('node:child_process');
    const { createWorktree } = await import('@cards.management/sdk/worktree');

    let rejectSettle!: (reason: Error) => void;
    const settle = new Promise<{
      branch: string;
      worktree: string;
      baseSha: string;
      copiedFromInclude: number;
      reroutedSymlinks: number;
    }>((_resolve, reject) => {
      rejectSettle = reject;
    });
    vi.mocked(createWorktree).mockResolvedValue({ path: WORKTREE_PATH, settle });

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    const failure = expect(promise).rejects.toThrow(/worktree outfit failed/);
    await flushMicrotasks();
    expect(spawn).not.toHaveBeenCalled();

    rejectSettle(new Error('worktree outfit failed'));
    await failure;
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns terminal-owned agy -i in the card worktree with card env and the minted session id', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    expect(vi.mocked(spawn).mock.calls).toHaveLength(1);
    expect(vi.mocked(spawn).mock.calls[0]![0]).toBe('agy');

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[0]).toBe('-i');
    expect(args[1]).toMatch(/Load the `runtime:card` skill and follow the `<routing-instructions>`\.$/);
    expect(args).not.toContain('--dangerously-skip-permissions');

    const opts = vi.mocked(spawn).mock.calls[0]![2] as {
      cwd: string;
      stdio: string;
      detached: boolean;
      env: Record<string, string | undefined>;
    };
    expect(opts.cwd).toBe(WORKTREE_PATH);
    expect(opts.stdio).toBe('inherit');
    expect(opts.detached).toBe(process.platform !== 'win32');
    expect(opts.env['WORKSPACE_PATH']).toBe(WORKTREE_PATH);
    expect(opts.env['BASE_BRANCH']).toBe('main');
    expect(opts.env['PARENT_BRANCH']).toBe('main');
    expect(opts.env['WORKSPACE_BRANCH']).toBe('cards/card-123/1');
    // Pre-spawn session identity carrier: every in-session `cards` CLI
    // inherits the minted id through ANTIGRAVITY_SESSION_ID.
    expect(opts.env['ANTIGRAVITY_SESSION_ID']).toMatch(/^[0-9a-f-]{36}$/);

    child.emit('close', 0);
    await promise;

    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).toHaveBeenCalledWith(
      { cardId: 'card-123', repoRoot: '/test/workspace', cardRepoPath: '/test/repo', sessionId: expect.any(String) },
      expect.anything()
    );
  });

  it('does not settle a successful child exit before the launcher-owned final poll settles', async () => {
    const { spawn } = await import('node:child_process');
    const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    let releaseFinalization: (() => void) | undefined;
    vi.mocked(finalizePersistedSqlitePollSession).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFinalization = () => resolve({ kind: 'flushed', emitted: 1, partial: 0 });
      })
    );

    const action = (await import('../src/actions/launch.js')).default;
    let settled = false;
    const promise = action(baseInput(), createMockContext()).finally(() => {
      settled = true;
    });
    await flushMicrotasks();
    child.emit('close', 0);
    await flushMicrotasks();

    expect(settled).toBe(false);
    expect(finalizePersistedSqlitePollSession).toHaveBeenCalledWith(
      expect.objectContaining({ cardRepoPath: '/test/repo', sessionId: expect.any(String) })
    );
    releaseFinalization?.();
    await promise;
  });

  it('reports a degraded final transcript drain as a diagnostic without failing a successful exit', async () => {
    const { spawn } = await import('node:child_process');
    const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(finalizePersistedSqlitePollSession).mockResolvedValueOnce({
      kind: 'degraded',
      reason: 'db-absent',
      detail: 'conversation DB is absent at final drain'
    });
    const { Logger } = await import('@cards.management/sdk/config');
    const errorSpy = vi.spyOn(Logger.prototype, 'error');

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();
    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();

    // The export gap reaches the user through the structured log with both of
    // its fields, and the run keeps the outcome it earned.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/transcript finalization degraded/),
      expect.objectContaining({ reason: 'db-absent', detail: 'conversation DB is absent at final drain' })
    );
    errorSpy.mockRestore();
  });

  it('preserves the primary lifecycle failure when finalization also rejects', async () => {
    const { spawn } = await import('node:child_process');
    const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(finalizePersistedSqlitePollSession).mockRejectedValueOnce(new Error('finalizer unavailable'));

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();
    child.emit('close', 1);

    await expect(promise).rejects.toThrow(/agy exited with code 1/);
    expect(finalizePersistedSqlitePollSession).toHaveBeenCalledTimes(1);
  });

  it('drains surviving descendants before lifecycle settlement and cleanup', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    let drained = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') {
        drained = true;
        return true;
      }
      if (drained) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();
    child.emit('close', 0);
    await promise;

    const termCall = vi.mocked(killSpy).mock.calls.findIndex(([, signal]) => signal === 'SIGTERM');
    expect(termCall).toBeGreaterThanOrEqual(0);
    killSpy.mockRestore();
  });

  it('forwards action-selected model and effort as separate argv values', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    process.env['CARDS_AGENT_MODEL'] = 'gemini-3-pro';
    process.env['CARDS_AGENT_EFFORT'] = 'high';

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual([
      '-i',
      expect.stringMatching(/`runtime:card` skill/),
      '--model',
      'gemini-3-pro',
      '--effort',
      'high'
    ]);
    child.emit('close', 0);
    await promise;
  });

  it.each([
    'interactive',
    'background'
  ] as const)('fails %s action completion when a runtime hook wrote a failure marker', async (executionMode) => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(fs.readdir).mockResolvedValue(['conversation.failure'] as never);
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      const path = String(filePath);
      if (path === `${ANTIGRAVITY_HOME}/settings.json`) return PROFILE_SETTINGS;
      return JSON.stringify({ stage: 'watcher-setup', reason: 'attach failed' });
    });

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput({ executionMode }), createMockContext());
    await flushMicrotasks();
    child.emit('close', 0);
    await expect(promise).rejects.toThrow(/runtime hook failure \(watcher-setup: attach failed\)/);
  });

  it('fails a background launch on the marker a real hook failure wrote, with exit status and stderr both clean', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const realFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { dispatchAntigravityHook } = await import('../../agent-hooks/src/antigravity/internal/transport.js');
    const { HandlerFailure, handlePreInvocation } = await import(
      '../../agent-hooks/src/antigravity/internal/handlers.js'
    );
    const { defaultAntigravityHandlerDeps } = await import('../../agent-hooks/src/antigravity/internal/deps.js');

    // The marker store is a real directory: the hook produces the marker
    // through its own failure policy and the action reads it back from disk, so
    // this witnesses the kept producer/consumer pair rather than a fixture of
    // it. Nothing here hand-writes a marker or fakes the read that finds one.
    const cardsHome = await realFsp.mkdtemp(join(tmpdir(), 'agy-hook-failure-'));
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    process.env['CARDS_HOME'] = cardsHome;
    // The trigger is environment-only, exactly as the spike fires it: CARD_ID
    // makes the hook a Cards action session instead of an inert foreign one.
    process.env['CARD_ID'] = 'main-679';
    vi.mocked(fs.readdir).mockImplementation(((directory: string) => realFsp.readdir(directory)) as never);
    vi.mocked(fs.readFile).mockImplementation(((
      path: Parameters<typeof realFsp.readFile>[0],
      encoding: Parameters<typeof realFsp.readFile>[1]
    ) => {
      // The launch path's workspace-trust preparation reads the native profile
      // before the spawn; every other read comes from the real file system so
      // the marker the hook writes is the one the launcher reads back.
      if (String(path) === `${ANTIGRAVITY_HOME}/settings.json`) return PROFILE_SETTINGS;
      return realFsp.readFile(path, encoding);
    }) as never);

    try {
      const action = (await import('../src/actions/launch.js')).default;
      const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
      await flushMicrotasks();

      const spawnEnv = (vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string | undefined> }).env;
      const sessionId = spawnEnv['ANTIGRAVITY_SESSION_ID'] as string;
      process.env['ANTIGRAVITY_SESSION_ID'] = sessionId;

      // One real handler failure through the real transport: the launcher did
      // not hand the hook an action environment, which is a contract stage the
      // hook fails closed on rather than guesses past.
      const deps = {
        ...defaultAntigravityHandlerDeps(),
        // Admission is now the first protected boundary. Satisfy it through
        // the public dependency seam so this fixture continues to witness the
        // intended later action-envelope failure and its marker transport.
        workAuthority: {
          admit: async () => ({ workRevision: 1 }),
          observeRevision: async () => 1
        },
        cardsConfigDir: () => cardsHome,
        io: {
          ensureDirSync: (dir: string) => realFs.mkdirSync(dir, { recursive: true }),
          writeTextFileSync: (path: string, data: string) => realFs.writeFileSync(path, data, 'utf8'),
          existsSync: (path: string) => realFs.existsSync(path),
          readTextFileSync: (path: string) => realFs.readFileSync(path, 'utf8'),
          removeSync: (path: string) => realFs.rmSync(path, { force: true })
        },
        loadActionInput: () => null
      };
      await expect(
        dispatchAntigravityHook(
          {
            conversationId: CONVERSATION_ID,
            workspacePaths: ['/test/workspace'],
            transcriptPath: '/test/transcript',
            artifactDirectoryPath: '/test/artifacts',
            modelName: 'gemini-3-pro',
            invocationNum: 1,
            initialNumSteps: 0
          },
          handlePreInvocation,
          deps
        )
      ).rejects.toBeInstanceOf(HandlerFailure);

      // The reason carries the bracketed stage because the transport persists
      // the HandlerFailure's own message — the same shape the committed spike
      // capture carries (`{"stage":"input","reason":"[input] …"}`), so the
      // action's rendering repeats the stage it already names.
      const marker = join(cardsHome, 'antigravity', 'runtime', 'markers', sessionId, `${CONVERSATION_ID}.failure`);
      expect(JSON.parse(await realFsp.readFile(marker, 'utf8'))).toEqual({
        stage: 'action-env',
        reason: '[action-env] the Cards action environment is missing or malformed'
      });

      // Every channel a launcher could watch except the marker is blind on this
      // run: the child exits 0 and nothing reached its stderr.
      child.emit('close', 0);
      await expect(promise).rejects.toThrow(
        /runtime hook failure \(action-env: \[action-env\] the Cards action environment is missing or malformed\)/
      );
    } finally {
      delete process.env['CARDS_HOME'];
      delete process.env['CARD_ID'];
      delete process.env['ANTIGRAVITY_SESSION_ID'];
      await realFsp.rm(cardsHome, { recursive: true, force: true });
    }
  });

  it.each([
    'interactive',
    'background'
  ] as const)('refuses a %s launch by name when the marker store cannot be created', async (executionMode) => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const realFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { AntigravitySessionFailureError } = await import('../src/lib/antigravity-session.js');

    // The store root is routed through a regular file, so creating it fails
    // ENOTDIR for any uid — the uid-independent construction the ruling
    // mandated instead of permission bits, which a root user ignores.
    const cardsHome = await realFsp.mkdtemp(join(tmpdir(), 'agy-store-enotdir-'));
    await realFsp.mkdir(join(cardsHome, 'antigravity'), { recursive: true });
    await realFsp.writeFile(join(cardsHome, 'antigravity', 'runtime'), 'not a directory');
    process.env['CARDS_HOME'] = cardsHome;
    vi.mocked(fs.mkdir).mockImplementation(((path: string, options: object) => realFsp.mkdir(path, options)) as never);
    vi.mocked(fs.access).mockImplementation(((path: string, mode: number) => realFsp.access(path, mode)) as never);

    try {
      const action = (await import('../src/actions/launch.js')).default;
      const failure = await action(baseInput({ executionMode }), createMockContext()).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AntigravitySessionFailureError);
      expect(failure).toMatchObject({ reason: 'marker-store-unavailable' });
      expect((failure as Error).message).toContain(join('antigravity', 'runtime', 'markers'));
      expect((failure as Error).message).toMatch(/ENOTDIR/);

      // Nothing was spawned and nothing settled: the refusal happens before
      // the client, the worktree, and the child, on both modes.
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally {
      delete process.env['CARDS_HOME'];
      await realFsp.rm(cardsHome, { recursive: true, force: true });
    }
  });

  it.each([
    'interactive',
    'background'
  ] as const)('refuses a %s launch when the existing marker store root is not writable', async (executionMode) => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const realFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { AntigravitySessionFailureError } = await import('../src/lib/antigravity-session.js');

    // The steady state: the root exists, so the recursive mkdir is a no-op
    // and only the write probe can report the store.
    const cardsHome = await realFsp.mkdtemp(join(tmpdir(), 'agy-store-readonly-'));
    const markerRoot = join(cardsHome, 'antigravity', 'runtime', 'markers');
    await realFsp.mkdir(markerRoot, { recursive: true });
    await realFsp.chmod(markerRoot, 0o500);
    process.env['CARDS_HOME'] = cardsHome;
    vi.mocked(fs.mkdir).mockImplementation(((path: string, options: object) => realFsp.mkdir(path, options)) as never);
    vi.mocked(fs.access).mockImplementation(((path: string, mode: number) => realFsp.access(path, mode)) as never);

    try {
      // Vacuity guard: a root-run suite bypasses both the probe and the
      // launcher's check, so assert the fixture is genuinely unwritable before
      // trusting the refusal — a control that passes vacuously is worse than
      // no control.
      const probe = await realFsp
        .writeFile(join(markerRoot, 'probe'), 'x')
        .then(() => 'wrote')
        .catch((error: NodeJS.ErrnoException) => error.code);
      expect(probe, `fixture at ${markerRoot} is writable — run this suite unprivileged`).not.toBe('wrote');

      const action = (await import('../src/actions/launch.js')).default;
      const failure = await action(baseInput({ executionMode }), createMockContext()).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AntigravitySessionFailureError);
      expect(failure).toMatchObject({ reason: 'marker-store-unavailable' });
      expect((failure as Error).message).toMatch(/EACCES|permission denied/);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally {
      delete process.env['CARDS_HOME'];
      await realFsp.chmod(markerRoot, 0o700).catch(() => undefined);
      await realFsp.rm(cardsHome, { recursive: true, force: true });
    }
  });

  it('fails the action on the placeholder marker written for input without a conversation id', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const realFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { dispatchAntigravityHook } = await import('../../agent-hooks/src/antigravity/internal/transport.js');
    const { HandlerFailure, handlePreInvocation } = await import(
      '../../agent-hooks/src/antigravity/internal/handlers.js'
    );
    const { defaultAntigravityHandlerDeps } = await import('../../agent-hooks/src/antigravity/internal/deps.js');
    const { UNKNOWN_CONVERSATION } = await import('../../agent-hooks/src/antigravity/internal/markers.js');

    // Real store, real transport, real launcher read: malformed host input has
    // no conversation identity, so the transport deliberately writes the
    // failure under the placeholder the launcher's reader also checks.
    const cardsHome = await realFsp.mkdtemp(join(tmpdir(), 'agy-hook-placeholder-'));
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    process.env['CARDS_HOME'] = cardsHome;
    process.env['CARD_ID'] = 'main-679';
    // The establishment stays mocked here (it has its own controls above);
    // only the store the hook writes and the launcher reads is real.
    vi.mocked(fs.readdir).mockImplementation(((directory: string) => realFsp.readdir(directory)) as never);
    vi.mocked(fs.readFile).mockImplementation(((
      path: Parameters<typeof realFsp.readFile>[0],
      encoding: Parameters<typeof realFsp.readFile>[1]
    ) => {
      // The launch path's workspace-trust preparation reads the native profile
      // before the spawn; every other read comes from the real file system so
      // the marker the hook writes is the one the launcher reads back.
      if (String(path) === `${ANTIGRAVITY_HOME}/settings.json`) return PROFILE_SETTINGS;
      return realFsp.readFile(path, encoding);
    }) as never);

    try {
      const action = (await import('../src/actions/launch.js')).default;
      const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
      await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled());

      const spawnEnv = (vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string | undefined> }).env;
      const sessionId = spawnEnv['ANTIGRAVITY_SESSION_ID'] as string;
      process.env['ANTIGRAVITY_SESSION_ID'] = sessionId;

      const deps = {
        ...defaultAntigravityHandlerDeps(),
        // Credential/admission failure is covered at its own boundary. This
        // fixture deliberately reaches input parsing so missing conversation
        // identity selects the placeholder marker address.
        workAuthority: {
          admit: async () => ({ workRevision: 1 }),
          observeRevision: async () => 1
        },
        cardsConfigDir: () => cardsHome,
        io: {
          ensureDirSync: (dir: string) => realFs.mkdirSync(dir, { recursive: true }),
          writeTextFileSync: (path: string, data: string) => realFs.writeFileSync(path, data, 'utf8'),
          existsSync: (path: string) => realFs.existsSync(path),
          readTextFileSync: (path: string) => realFs.readFileSync(path, 'utf8'),
          removeSync: (path: string) => realFs.rmSync(path, { force: true })
        },
        loadActionInput: () => null
      };
      await expect(
        dispatchAntigravityHook(
          {
            workspacePaths: ['/test/workspace'],
            transcriptPath: '/test/transcript',
            artifactDirectoryPath: '/test/artifacts',
            modelName: 'gemini-3-pro',
            invocationNum: 1,
            initialNumSteps: 0
          },
          handlePreInvocation,
          deps
        )
      ).rejects.toBeInstanceOf(HandlerFailure);

      const retryPath = join(
        cardsHome,
        'antigravity',
        'runtime',
        'markers',
        sessionId,
        `${UNKNOWN_CONVERSATION}.failure`
      );
      expect(JSON.parse(await realFsp.readFile(retryPath, 'utf8'))).toEqual({
        stage: 'input',
        reason: expect.stringContaining('[input]')
      });

      // Exit status and stderr stay clean, exactly as the host behaves; the
      // placeholder marker is the channel that reaches the launcher's read.
      child.emit('close', 0);
      await expect(promise).rejects.toThrow(/runtime hook failure \(input: \[input\]/);
    } finally {
      delete process.env['CARDS_HOME'];
      delete process.env['CARD_ID'];
      delete process.env['ANTIGRAVITY_SESSION_ID'];
      await realFsp.rm(cardsHome, { recursive: true, force: true });
    }
  });

  it('settles a background launch whose lifecycle markers are absent or late instead of rejecting it', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const action = (await import('../src/actions/launch.js')).default;

    // Absent: the marker directory a hook would have created is not there.
    vi.mocked(fs.readdir).mockRejectedValue(enoent);
    const absentChild = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(absentChild);
    const absentPromise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();
    absentChild.emit('close', 0);
    await expect(absentPromise).resolves.toBeUndefined();

    // Late: the directory exists and is empty — the markers simply never came.
    vi.mocked(fs.readdir).mockResolvedValue([] as never);
    const lateChild = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(lateChild);
    const latePromise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();
    lateChild.emit('close', 0);
    await expect(latePromise).resolves.toBeUndefined();

    // Neither run was rejected, and both kept the completion path they earned.
  });

  it('fails an interactive action on a nonzero child exit', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();
    child.emit('close', 23);
    await expect(promise).rejects.toThrow(/agy exited with code 23/);
    const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
    expect(finalizePersistedSqlitePollSession).toHaveBeenCalledTimes(1);
  });

  it('rejects when the Antigravity process fails to spawn', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();
    child.emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }));

    await expect(promise).rejects.toThrow(/agy process could not be launched/);
  });

  it('spawns child-owned agy -p --output-format stream-json and settles on a clean exit', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args).toEqual([
      '-p',
      expect.stringMatching(/Load the `runtime:card` skill and follow the `<routing-instructions>`\.$/),
      '--output-format',
      'stream-json'
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');

    const opts = vi.mocked(spawn).mock.calls[0]![2] as { cwd: string; stdio: unknown };
    expect(opts.cwd).toBe(WORKTREE_PATH);
    // Background handlers are console-less: the stream-json transcript has no
    // reader, so stdout is ignored and only the diagnostic stderr is piped.
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);

    child.emit('close', 0);
    await promise;

    // Inline cleanup only — no detached watcher behind a headless run.
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).not.toHaveBeenCalled();
  });

  it('fails a background launch on nonzero exit and signal termination', async () => {
    const { spawn } = await import('node:child_process');
    const action = (await import('../src/actions/launch.js')).default;

    const nonzero = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(nonzero);
    const nonzeroPromise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();
    nonzero.emit('close', 1);
    await expect(nonzeroPromise).rejects.toThrow(/agy exited with code 1/);

    const signalled = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(signalled);
    const signalPromise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();
    signalled.emit('close', null, 'SIGTERM');
    await expect(signalPromise).rejects.toThrow(/terminated on signal SIGTERM/);

    const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
    expect(finalizePersistedSqlitePollSession).toHaveBeenCalledTimes(2);
  });

  it('does not fail a truncated run when Cards itself requested the termination', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    // The group "exits" (ESRCH on the existence probe) as soon as SIGTERM is
    // sent, simulating a cooperative child — same shape as the onCancel test
    // below, so the truncation latch is the only thing under test here.
    let exited = false;
    killSpy.mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') {
        exited = true;
        return true;
      }
      if (exited) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);

    const context = createMockContext();
    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput({ executionMode: 'background' }), context);
    await flushMicrotasks();

    const onCancel = vi.mocked(context.onCancel).mock.calls[0]![0] as () => Promise<void>;
    await onCancel();
    // The notice is the same one the committed captures carry; here it was
    // Cards' own cancellation that ended the turn, so the partial output is the
    // expected shape of a termination the user asked for, not a silent cut.
    child.stderr?.emit(
      'data',
      Buffer.from('[agy] print timeout after 5m0s with turn in progress; returning partial output\n')
    );
    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();

    // The run keeps the ordinary completion path a card-requested termination
    // has always taken; the latch adds no failure to it.
    killSpy.mockRestore();
  });

  it('registers onCancel that drains the owned process group', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    // Termination goes through createAntigravityTerminationController, which
    // signals the launcher-owned process group (-pid) — see
    // antigravity-termination.ts. The group "exits" (ESRCH on the existence
    // probe) as soon as SIGTERM is sent, simulating a cooperative child.
    let exited = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') {
        exited = true;
        return true;
      }
      if (exited) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    const context = createMockContext();
    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), context);
    await flushMicrotasks();

    const onCancel = vi.mocked(context.onCancel).mock.calls[0]![0] as () => Promise<void>;
    await onCancel();
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    child.emit('close', 0);
    await promise;

    killSpy.mockRestore();
  });
});

describe('chat action — antigravity branch', () => {
  it('spawns interactive agy -i with the native chat-routing address and suppressed exit-when-done', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/chat.js')).default;
    const promise = action(baseInput({ actionName: 'Chat' }), createMockContext());
    await flushMicrotasks();

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('agy');
    const args = calls[0]![1] as string[];
    expect(args[0]).toBe('-i');
    expect(args[1]).toMatch(/Load the `runtime:chat-routing` skill and follow the `<routing-instructions>`\.$/);

    const opts = calls[0]![2] as { cwd: string; env: Record<string, string | undefined> };
    expect(opts.cwd).toBe(WORKTREE_PATH);
    expect(opts.env['EXIT_WHEN_DONE']).toBe('false');

    child.emit('close', 0);
    await promise;
  });

  it('declares no background-mode support, keeping the action-wide declaration the single check', async () => {
    const action = (await import('../src/actions/chat.js')).default;
    expect(action.supportsBackgroundMode).toBe(false);
  });
});

describe('interview action — antigravity branch', () => {
  it('spawns interactive agy -i with the native interview address and suppressed exit-when-done', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/interview.js')).default;
    const promise = action(baseInput({ actionName: 'Interview' }), createMockContext());
    await flushMicrotasks();

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls).toHaveLength(1);
    const args = calls[0]![1] as string[];
    expect(args[0]).toBe('-i');
    expect(args[1]).toMatch(/Load the `runtime:interview` skill and follow the `<routing-instructions>`\.$/);

    const opts = calls[0]![2] as { env: Record<string, string | undefined> };
    expect(opts.env['EXIT_WHEN_DONE']).toBe('false');

    child.emit('close', 0);
    await promise;
  });

  it('declares no background-mode support, keeping the action-wide declaration the single check', async () => {
    const action = (await import('../src/actions/interview.js')).default;
    expect(action.supportsBackgroundMode).toBe(false);
  });
});

describe('captain action — antigravity branch', () => {
  it('spawns interactive agy -i with the native captain address', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/captain.js')).default;
    const promise = action(baseInput({ actionName: 'Captain' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[0]).toBe('-i');
    expect(args[1]).toMatch(/Load the `runtime:captain` skill and follow the `<routing-instructions>`\.$/);

    child.emit('close', 0);
    await promise;
  });

  it('spawns background agy -p with stream-json output and the captain address', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/captain.js')).default;
    const promise = action(baseInput({ actionName: 'Captain', executionMode: 'background' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args.slice(0, 2)).toEqual(['-p', expect.stringMatching(/`runtime:captain` skill/)]);
    expect(args.slice(2)).toEqual(['--output-format', 'stream-json']);

    child.stdout?.emit('data', Buffer.from(`${JSON.stringify({ conversation_id: 'conv-1', status: 'SUCCESS' })}\n`));
    child.emit('close', 0);
    await promise;
  });
});

/**
 * Outcome checks for a background Antigravity launch driven with the real
 * `agy` transcripts committed under `test/fixtures/antigravity/`.
 *
 * The fixtures are byte-identical copies of the captures committed with the
 * `spike/agy-stream-json-shape/` harness and are re-captured by its `run.sh`,
 * never hand-authored: a hand-written transcript is precisely the drift this
 * suite exists to catch. The launcher requests `--output-format stream-json`
 * (see {@link buildAntigravityArgs}), whose result record nests
 * `conversation_id`/`status` under `result`; the field set the retired parser
 * demanded at the top level belongs to `--output-format json`, the mode the
 * authentication probe uses. Driving the real capture through the real handler
 * is what keeps a minimal result adapter honest about which shape it reads.
 *
 * A clean exit is not sufficient, and the committed truncation captures are the
 * evidence: a `--print-timeout` run exits 0 with a record whose `status` is
 * `"SUCCESS"`, an empty response, and a partial turn. The only channel that
 * carries that class is the notice the CLI writes to stderr, matched on its
 * invariant suffix — the timeout value it embeds (`after 1s`, `after 5m0s`)
 * varies with the flag and the host default, so it is not part of the match —
 * against a bounded tail that survives a notice split across a chunk boundary.
 *
 * @summary Real-capture outcome checks for background Antigravity launches
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AntigravitySessionFailureError } from '../src/lib/antigravity-session.js';

vi.mock('../src/lib/antigravity-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/antigravity-termination.js')>();
  const { createSyntheticProcessTreeAuthority } = await import('./helpers/process-tree-authority.js');
  return {
    ...actual,
    createAntigravityTerminationController: (
      child: Parameters<typeof actual.createAntigravityTerminationController>[0],
      options: Parameters<typeof actual.createAntigravityTerminationController>[1]
    ) =>
      actual.createAntigravityTerminationController(child, {
        ...options,
        authority: createSyntheticProcessTreeAuthority()
      })
  };
});

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

vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

vi.mock('../src/lib/branch-cleanup-watcher.js', () => ({
  spawnBranchCleanupWatcher: vi.fn()
}));

const WORKTREE_PATH = '/test/workspace/.worktrees/cards/card-123/1';
const AGENT = 'antigravity-cli';
const ANTIGRAVITY_HOME = '/test/antigravity-cli';
const FIXTURE_DIR = join(new URL('.', import.meta.url).pathname, 'fixtures/antigravity');

/**
 * The Antigravity profile these launches start from: a project the user already
 * approved, whose freshly created card worktree is the checkout under test. The
 * checkout is already recorded as trusted, so workspace-trust preparation is a
 * read-only pass here and these tests keep asserting the capture-driven outcome.
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

const originalFetch = globalThis.fetch;

/**
 * Reads one committed capture with the real filesystem's promises API.
 *
 * `node:fs/promises` is mocked for the handler under test, so the fixture read
 * has to step around the module mock rather than share it.
 *
 * @param name - Fixture file name inside {@link FIXTURE_DIR}.
 * @returns The capture's exact bytes as text.
 */
let realFsPromises: typeof import('node:fs/promises') | undefined;
async function readFixture(name: string): Promise<string> {
  realFsPromises ??= await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return realFsPromises.readFile(join(FIXTURE_DIR, name), 'utf-8');
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
  // No runtime marker directory: a healthy session writes no failure marker, so
  // the hook-failure read sees an absent directory and reports nothing.
  vi.mocked(fs.readdir).mockRejectedValue(enoent);
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

/**
 * Builds a mock context whose hooks can be driven by the test.
 *
 * @returns An ActionContext shaped like the action dispatcher's.
 */
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
 * Builds a mock child with EventEmitter stdout/stderr so the capture can be
 * fed through the handler's own stdio listeners.
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

/**
 * Builds a background-mode action input for the Antigravity launch row.
 *
 * @param overrides - Input field overrides.
 * @returns The action input under test.
 */
function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'background',
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

/** How a driven background launch settled. */
type LaunchOutcome = { settled: true } | { settled: false; error: unknown };

/**
 * Drives one background launch over a mock child and reports how it settled.
 *
 * The chunks are emitted as separate `data` events so a caller can place a
 * chunk boundary inside a stderr notice; the exit is always `0`, because every
 * class this suite pins — success and truncation alike — exits zero.
 *
 * @param stdoutChunks - Transcript fragments emitted on stdout, in order.
 * @param stderrChunks - Stderr fragments emitted on stderr, in order.
 * @returns Whether the action settled, and the rejection reason when it did not.
 */
async function driveLaunch(stdoutChunks: readonly string[], stderrChunks: readonly string[]): Promise<LaunchOutcome> {
  const { spawn } = await import('node:child_process');
  const child = createMockChild();
  vi.mocked(spawn).mockReturnValue(child);

  const action = (await import('../src/actions/launch.js')).default;
  const promise = action(baseInput(), createMockContext());
  await flushMicrotasks();

  for (const chunk of stdoutChunks) child.stdout?.emit('data', Buffer.from(chunk));
  for (const chunk of stderrChunks) child.stderr?.emit('data', Buffer.from(chunk));
  child.emit('close', 0);

  try {
    await promise;
    return { settled: true };
  } catch (error) {
    return { settled: false, error };
  }
}

/**
 * Narrows a driven launch to its named failure.
 *
 * The error class is read through the same dynamic import the action itself
 * uses, keeping with the rest of this file: the top-level import is type-only,
 * so this file's import phase evaluates no part of the handler's graph.
 *
 * @param outcome - Outcome reported by {@link driveLaunch}.
 * @returns The named failure the launch rejected with.
 */
async function failureOf(outcome: LaunchOutcome): Promise<AntigravitySessionFailureError> {
  if (outcome.settled) throw new Error('expected the launch to fail, but it settled successfully');
  const { AntigravitySessionFailureError } = await import('../src/lib/antigravity-session.js');
  expect(outcome.error).toBeInstanceOf(AntigravitySessionFailureError);
  return outcome.error as AntigravitySessionFailureError;
}

describe('background launch outcome — real agy captures', () => {
  it('settles as success when driven with the committed successful transcript', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    const transcript = await readFixture('captured-stream-json-success.jsonl');

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    child.stdout?.emit('data', Buffer.from(transcript));
    child.emit('close', 0);
    await expect(promise).resolves.toBeUndefined();

    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).not.toHaveBeenCalled();
  });

  it('settles as a named failure when driven with the committed print-timeout capture', async () => {
    const transcript = await readFixture('captured-stream-json-print-timeout-1s.jsonl');
    const notice = await readFixture('captured-stream-json-print-timeout-1s.stderr');

    const error = await failureOf(await driveLaunch([transcript], [notice]));

    expect(error.reason).toBe('output-truncated');
    // The latch is a completion policy, not a diagnosis: it fires only because
    // Cards did not ask for this termination, which is the half of the rule the
    // notice itself cannot carry.
    expect(error.message).toMatch(/Cards did not request/);
  });

  it('latches the print-timeout notice when a chunk boundary splits it', async () => {
    const transcript = await readFixture('captured-stream-json-print-timeout-2s.jsonl');
    const notice = await readFixture('captured-stream-json-print-timeout-2s.stderr');
    // The hardest split the invariant suffix admits: the second chunk is the
    // notice's final `t` plus its newline, so it can never match on its own.
    // Only a tail still holding the whole prefix, tested for a match before it
    // is truncated to the bound, sees the suffix complete across the two.
    const boundary = notice.length - 2;
    expect(notice.slice(boundary)).toBe('t\n');

    const error = await failureOf(await driveLaunch([transcript], [notice.slice(0, boundary), notice.slice(boundary)]));

    expect(error.reason).toBe('output-truncated');
  });

  it('latches a notice whose timeout value appears in no capture', async () => {
    const transcript = await readFixture('captured-stream-json-print-timeout-3s.jsonl');
    const notice = await readFixture('captured-stream-json-print-timeout-3s.stderr');
    // `agy --help` reports `--print-timeout` defaulting to 5m0s and the action
    // arg builder passes none, so this is the notice the production path
    // inherits; only the value is substituted, leaving the capture's own bytes
    // around it. A match keyed on the whole line would stop at `after 1s`.
    const hostDefaultNotice = notice.replace('after 3s', 'after 5m0s');
    expect(hostDefaultNotice).not.toBe(notice);

    const error = await failureOf(await driveLaunch([transcript], [hostDefaultNotice]));

    expect(error.reason).toBe('output-truncated');
  });
});

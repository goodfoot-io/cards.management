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
 * @summary Real-capture outcome checks for background Antigravity launches
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
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

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock('@cards.management/sdk/worktree', () => ({
  createWorktree: vi.fn(),
  checkWorktreeExists: vi.fn(),
  findGitRoots: vi.fn()
}));

vi.mock('@cards.management/sdk/bin/process-utils', () => ({
  readCardStatus: vi.fn(),
  transitionCardStatus: vi.fn()
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
const FIXTURE_DIR = join(new URL('.', import.meta.url).pathname, 'fixtures/antigravity');

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
      } else {
        cb(new Error(`mock: unhandled command: ${key}`));
      }
    }

    return {} as ReturnType<typeof execFile>;
  });
  vi.mocked(execFileSync).mockImplementation(() => '');

  vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
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
  vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) =>
    createWorktree(ref, {
      cwd: opts.cwd,
      cardId: opts.cardId,
      compiledScriptPaths: opts.compiledScriptPaths
    })
  );
  vi.mocked(createWorktree).mockResolvedValue({
    path: WORKTREE_PATH,
    settle: Promise.resolve({
      branch: 'cards/card-123/1',
      worktree: WORKTREE_PATH,
      baseSha: 'abc123'
    })
  });

  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  vi.mocked(fs.access).mockResolvedValue(undefined);
  vi.mocked(fs.readFile).mockRejectedValue(enoent);
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
  const { readCardStatus, transitionCardStatus } = await import('@cards.management/sdk/bin/process-utils');
  vi.mocked(readCardStatus).mockResolvedValue('needs_review');
  vi.mocked(transitionCardStatus).mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
  delete process.env['CARDS_AGENT_MODEL'];
  delete process.env['CARDS_AGENT_EFFORT'];
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
    ...overrides
  };
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

    const { transitionCardStatus } = await import('@cards.management/sdk/bin/process-utils');
    expect(transitionCardStatus).toHaveBeenCalledWith('/test/repo', expect.anything());
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).not.toHaveBeenCalled();
  });
});

import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import type { BranchInfo } from '@cards.management/sdk/protocol';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reproduces a bug where the base branch (e.g. `main`) is registered
 * as a `branches/` entry, and `resolveOrCreateWorktree` Step 2 then
 * attempts to create a worktree for that base branch — failing with
 * `fatal: 'main' is already checked out`.
 *
 * Step 2 iterates all branches with `exists=true` but does not distinguish
 * base branches (like `main`) from worktree branches (like `cards/card-123/1`).
 * When the base branch was registered without a worktree path,
 * Step 2 incorrectly treats it as a branch needing worktree reattachment.
 *
 * @summary Regression test for base branch worktree collision in resolveOrCreateWorktree
 */

vi.mock('cross-spawn', async () => {
  // spawnAgentCli routes the agent launch through cross-spawn; forward it to the
  // mocked node:child_process.spawn so existing spawn('claude'/'codex', ...)
  // assertions hold on every platform (cross-spawn would otherwise rewrite the
  // call into a cmd.exe invocation on win32 and bypass the node:child_process mock).
  const cp = await import('node:child_process');
  return { default: cp.spawn };
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn()
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock('@cards.management/sdk/worktree', () => ({
  createWorktree: vi.fn(),
  checkWorktreeExists: vi.fn(),
  findGitRoots: vi.fn()
}));

// createWorktreeForCard wraps the pure createWorktree git primitive with the
// per-card outfit. Mock it as a thin adapter that forwards to the low-level
// createWorktree mock (see claude-session.test.ts) so these tests keep asserting
// the pure-primitive call shape without running the real outfit side effects.
vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual('node:crypto');
  return {
    ...actual,
    randomUUID: vi.fn(() => 'test-uuid-1234')
  };
});

const originalFetch = globalThis.fetch;

/**
 * Compiled-hook .mjs paths createWorktree() must be called with, derived from
 * the test ActionInput's extensionPath (`/test/extension`). Built with
 * path.join so the expectation matches production's `\`-separated paths on
 * Windows.
 */
const EXPECTED_COMPILED_SCRIPT_PATHS = {
  'pre-commit': path.join('/test/extension', 'dist', 'git-hooks', 'pre-commit.mjs'),
  'post-commit': path.join('/test/extension', 'dist', 'git-hooks', 'post-commit.mjs'),
  'post-rewrite': path.join('/test/extension', 'dist', 'git-hooks', 'post-rewrite.mjs')
};

beforeEach(async () => {
  vi.clearAllMocks();

  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['API_TEST_MODE'] = '1';

  const fsPromises = await import('node:fs/promises');
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  vi.mocked(fsPromises.readFile).mockRejectedValue(enoent);

  const { execFile } = await import('node:child_process');
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    const cmd = args[0] as string;
    const cmdArgs = args[1] as string[];
    const key = `${cmd} ${cmdArgs.join(' ')}`;

    if (typeof cb === 'function') {
      if (key.startsWith('git rev-parse --abbrev-ref HEAD')) {
        cb(null, { stdout: 'main\n', stderr: '' });
      } else if (key === 'which claude' || key === 'where claude') {
        cb(null, { stdout: '/usr/local/bin/claude\n', stderr: '' });
      } else {
        cb(new Error(`mock: unhandled command: ${key}`));
      }
    }
    return {} as ReturnType<typeof execFile>;
  });

  const { createWorktree, checkWorktreeExists, findGitRoots } = await import('@cards.management/sdk/worktree');
  vi.mocked(findGitRoots).mockResolvedValue({ sourceRoot: '/test/workspace', repoRoot: '/test/workspace' });
  vi.mocked(checkWorktreeExists).mockResolvedValue(false);

  // Forward the orchestrator to the low-level createWorktree mock with the
  // outfit-bearing options, so per-case createWorktree overrides and assertions
  // keep working against the pure-primitive call shape.
  const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
  vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) =>
    createWorktree(ref, {
      cwd: opts.cwd,
      cardId: opts.cardId,
      compiledScriptPaths: opts.compiledScriptPaths
    })
  );
  vi.mocked(createWorktree).mockResolvedValue({
    path: '/test/workspace/.worktrees/cards/card-123/1',
    settle: Promise.resolve({
      branch: 'cards/card-123/1',
      worktree: '/test/workspace/.worktrees/cards/card-123/1',
      baseSha: 'abc123'
    })
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
});

function createMockContext(): ActionContext {
  return {
    reportWorktreeAssignment: vi.fn().mockResolvedValue(undefined),
    logger: new Logger(),
    cwd: process.cwd(),
    onCancel: vi.fn(),
    onAgentShutdown: vi.fn(),
    onSwitchToInteractive: vi.fn()
  };
}

function createMockChild(overrides?: Partial<ChildProcess>): ChildProcess {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    pid: 12345,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    kill: vi.fn(),
    stdout: null,
    stderr: null,
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
      return true;
    },
    ...overrides
  } as unknown as ChildProcess;
}

function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    executionId: 'execution-test',
    worktreeDirective: { kind: 'reuse' },
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    repoRoot: '/test/workspace',
    cardRepoPath: '/test/repo',
    configPath: '/test/config',
    extensionPath: '/test/extension',
    ...overrides
  };
}

function configureBranchesResponse(branches: BranchInfo[]): void {
  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (opts?.method === 'PATCH')
      return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: 'revision-claimed' })));
    if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve(
        new Response(JSON.stringify({ branches, commits: [], defaultBranch: 'main' }), { status: 200 })
      );
    }
    if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
}

describe('base branch worktree collision', () => {
  it('should not call createWorktree for a registered base branch', async () => {
    const { spawn } = await import('node:child_process');
    const { createWorktree } = await import('@cards.management/sdk/worktree');

    // Simulate the state where the base branch `main` is registered.
    // getBranches returns `main` with exists=true but no worktree path —
    // exactly what gets written for non-cards/* branches.
    configureBranchesResponse([
      {
        name: 'main',
        parentBranch: 'main',
        addedAt: '2026-03-24T00:00:00Z',
        exists: true
        // no worktree — base branches don't have worktrees
      }
    ]);

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    // BUG: resolveOrCreateWorktree Step 2 calls createWorktree("main")
    // because it doesn't distinguish base branches from worktree branches.
    //
    // EXPECTED (after fix): createWorktree should be called with a new
    // cards/card-123/N branch, NOT with "main".
    //
    // This assertion will FAIL against unfixed code because Step 2 calls
    // createWorktree("main") before ever reaching Step 3.
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree).not.toHaveBeenCalledWith('main', expect.anything());
    expect(createWorktree).toHaveBeenCalledWith('cards/card-123/1', {
      cwd: '/test/workspace',
      cardId: 'card-123',
      compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
    });

    child.emit('close', 0);
    await promise;
  });
});

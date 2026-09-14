import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reproduces a bug where `resolveOrCreateWorktree` crashes with
 * "Worktree already exists" when a git worktree is registered in git but
 * not tracked by the Cards API.
 *
 * The function uses `client.getBranches()` as the sole source of truth for
 * existing worktrees when computing the next branch number, but
 * `createWorktree` validates against git's actual state. When these disagree
 * (API has no record, git has the worktree registered), the code picks a
 * branch name git already has, and `createWorktree` throws an unrecoverable
 * error.
 *
 * @summary Regression test for worktree-API desync bug in resolveOrCreateWorktree
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

  // Set EXTENSION_PATH for extensionPath in ActionInput
  process.env['EXTENSION_PATH'] = '/test/extension';
  // Set MARKETPLACE_PATH so resolveMarketplacePath() succeeds
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

  // Enable discovery test mode so createCardsClient() returns a client without
  // a real cards-api.json file on disk.
  process.env['API_TEST_MODE'] = '1';

  // Default: updateMarketplaceRegistration reads known_marketplaces.json — return
  // ENOENT so it exits early. Tests that need marketplace behaviour override explicitly.
  const fsPromises = await import('node:fs/promises');
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  vi.mocked(fsPromises.readFile).mockRejectedValue(enoent);

  // resolveBaseBranch → 'main'
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

  // Default fetch: getBranches → [], addBranch → 201
  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (opts?.method === 'PATCH')
      return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: 'revision-claimed' })));
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

  // Default: findGitRoots returns workspace as both roots, checkWorktreeExists returns false (no conflict)
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

  // Default createWorktree succeeds (overridden per-test below)
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

describe('worktree-API desync', () => {
  it('skips occupied slot and creates worktree at next available number', async () => {
    const { spawn } = await import('node:child_process');
    const { createWorktree, checkWorktreeExists } = await import('@cards.management/sdk/worktree');

    // API returns NO branches — it has no record of any worktree.
    // But git has cards/card-123/1 registered (checkWorktreeExists returns true for slot 1).
    vi.mocked(checkWorktreeExists)
      .mockResolvedValueOnce(true) // slot 1 occupied in git
      .mockResolvedValueOnce(false); // slot 2 free

    vi.mocked(createWorktree).mockResolvedValue({
      path: '/test/workspace/.worktrees/cards/card-123/2',
      settle: Promise.resolve({
        branch: 'cards/card-123/2',
        worktree: '/test/workspace/.worktrees/cards/card-123/2',
        baseSha: 'abc123'
      })
    });

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    // createWorktree should be called once with slot 2 (skipping occupied slot 1)
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree).toHaveBeenCalledWith('cards/card-123/2', {
      cwd: '/test/workspace',
      cardId: 'card-123',
      compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
    });

    child.emit('close', 0);
    await promise;
  });

  it('skips multiple occupied slots to find the first free one', async () => {
    const { spawn } = await import('node:child_process');
    const { createWorktree, checkWorktreeExists } = await import('@cards.management/sdk/worktree');

    // Git has slots 1-15 registered but the API knows nothing about them.
    const occupied = 15;
    for (let i = 0; i < occupied; i++) {
      vi.mocked(checkWorktreeExists).mockResolvedValueOnce(true);
    }
    vi.mocked(checkWorktreeExists).mockResolvedValueOnce(false); // slot 16 free

    vi.mocked(createWorktree).mockResolvedValue({
      path: '/test/workspace/.worktrees/cards/card-123/16',
      settle: Promise.resolve({
        branch: 'cards/card-123/16',
        worktree: '/test/workspace/.worktrees/cards/card-123/16',
        baseSha: 'abc123'
      })
    });

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    // Should skip slots 1-15 and create at 16
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(createWorktree).toHaveBeenCalledWith('cards/card-123/16', {
      cwd: '/test/workspace',
      cardId: 'card-123',
      compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
    });

    child.emit('close', 0);
    await promise;
  });
});

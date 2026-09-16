import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the shared claude-session utilities.
 *
 * Covers plugin settings construction, CLI arg building, worktree lifecycle
 * management, and branch cleanup. Uses the same mocking patterns as the
 * existing action tests.
 *
 * @summary Tests for shared claude-session utilities
 */

vi.mock('../src/lib/claude-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/claude-termination.js')>();
  const { createSyntheticProcessTreeAuthority } = await import('./helpers/process-tree-authority.js');
  return {
    ...actual,
    createClaudeTerminationController: (
      child: Parameters<typeof actual.createClaudeTerminationController>[0],
      options: Parameters<typeof actual.createClaudeTerminationController>[1]
    ) =>
      actual.createClaudeTerminationController(child, { ...options, authority: createSyntheticProcessTreeAuthority() })
  };
});

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
  execFile: vi.fn(),
  execFileSync: vi.fn()
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn()
}));

vi.mock('@cards.management/sdk/worktree', () => ({
  createWorktree: vi.fn(),
  checkWorktreeExists: vi.fn(),
  findGitRoots: vi.fn()
}));

// createWorktreeForCard is the orchestrator that wraps the pure `createWorktree`
// git primitive with the per-card outfit (writeCardBoundFile, hook provisioning,
// addBranch). Running the real orchestrator here would drive real disk/git work,
// so mock it as a thin adapter that forwards to the low-level `createWorktree`
// mock — preserving the "worktree created for <card>/<slot> with these compiled
// scripts" contract these tests assert on without the outfit side effects.
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
 * (Re)configures the default module mocks for a fresh module graph.
 *
 * Re-imports the mocked modules and installs their default implementations so
 * `spawnClaudeSession` can run end-to-end. Extracted from `beforeEach` so the
 * cross-platform spawn tests — which call `vi.resetModules()` to clear the
 * `resolveCliExecutable` cache — can re-establish the defaults against the fresh
 * module instances the reset produced.
 */
async function setupDefaultMocks(): Promise<void> {
  // Default: resolveBaseBranch → 'main', and resolveCliExecutable's `where/which
  // claude` probe succeeds so sessions spawn the real `claude` binary.
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

  // Default: no existing branches
  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve(
        new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
      );
    }
    if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 201 }));
    }
    if (opts?.method === 'PATCH')
      return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: 'revision-claimed' })));
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });

  const { createWorktree, checkWorktreeExists, findGitRoots } = await import('@cards.management/sdk/worktree');
  vi.mocked(findGitRoots).mockResolvedValue({ sourceRoot: '/test/workspace', repoRoot: '/test/workspace' });
  vi.mocked(checkWorktreeExists).mockResolvedValue(false);
  vi.mocked(createWorktree).mockResolvedValue({
    path: '/test/workspace/.worktrees/cards/card-123/1',
    settle: Promise.resolve({
      branch: 'cards/card-123/1',
      worktree: '/test/workspace/.worktrees/cards/card-123/1',
      baseSha: 'abc123',
      copiedFromInclude: 0,
      reroutedSymlinks: 0
    })
  });

  // Forward the orchestrator to the low-level createWorktree mock with the
  // outfit-bearing options, so per-case `createWorktree` overrides and
  // assertions keep working against the pure-primitive call shape. `cardId`
  // and `compiledScriptPaths` are not part of `CreateWorktreeOptions` — the
  // real `createWorktreeForCard` uses them for outfit work, not for the
  // `createWorktree` call itself — so they're forwarded through a typed
  // intermediate rather than an object literal to keep the excess fields
  // observable to per-case `toHaveBeenCalledWith` assertions without an
  // excess-property-check error at this call site.
  const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
  vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) => {
    const forwardedOptions = {
      cwd: opts.cwd,
      cardId: opts.cardId,
      compiledScriptPaths: opts.compiledScriptPaths
    };
    return createWorktree(ref, forwardedOptions).then((result) => ({ ...result, registrationRevision: 'revision-a' }));
  });
}

beforeEach(async () => {
  vi.clearAllMocks();

  // Enable discovery test mode so createCardsClient() returns a client without
  // a real cards-api.json file on disk.
  process.env['API_TEST_MODE'] = '1';

  await setupDefaultMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
});

function createMockLogger(): ActionContext['logger'] {
  return new Logger();
}

function createMockContext(): ActionContext {
  return {
    logger: new Logger(),
    cwd: process.cwd(),
    reportWorktreeAssignment: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
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

/**
 * Minimal event-emitter stand-in for `child.stderr`, matching the
 * `on`/`emit` shape `createMockChild` uses for the child process itself.
 *
 * @returns A stub with `on('data', cb)` registration and a synchronous `emit`.
 */
function createMockStderr(): {
  on: (event: string, cb: (chunk: Buffer) => void) => void;
  emit: (chunk: string) => void;
} {
  const handlers = new Map<string, (chunk: Buffer) => void>();
  return {
    on: (event: string, cb: (chunk: Buffer) => void) => {
      handlers.set(event, cb);
    },
    emit: (chunk: string) => {
      handlers.get('data')?.(Buffer.from(chunk));
    }
  };
}

function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    executionId: 'execution-test',
    worktreeDirective: { kind: 'reuse' },
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    exitWhenDone: false,
    repoRoot: '/test/workspace',
    cardRepoPath: '/test/repo',
    configPath: '/test/config',
    extensionPath: '/test/extension',
    marketplacePath: '/test/extension/dist/marketplace',
    ...overrides
  };
}

/**
 * Configures execFile mock to handle specific git commands.
 * @param handlers - Map of command strings to their mock stdout/stderr responses.
 */
async function configureExecFile(handlers: Record<string, { stdout: string; stderr?: string }>): Promise<void> {
  const { execFile } = await import('node:child_process');
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    const cmd = args[0] as string;
    const cmdArgs = args[1] as string[];
    const key = `${cmd} ${cmdArgs.join(' ')}`;

    if (typeof cb === 'function') {
      for (const [pattern, result] of Object.entries(handlers)) {
        if (key.startsWith(pattern) || key.includes(pattern)) {
          cb(null, { stdout: result.stdout, stderr: result.stderr ?? '' });
          return {} as ReturnType<typeof execFile>;
        }
      }
      cb(new Error(`mock: unhandled command: ${key}`));
    }
    return {} as ReturnType<typeof execFile>;
  });
}

function configureBranchesResponse(
  branches: Array<{
    name: string;
    worktree?: string;
    parentBranch: string;
    addedAt: string;
    revision?: string;
    activeExecutionOwner?: string;
    exists?: boolean;
  }>
): void {
  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve(
        new Response(JSON.stringify({ branches, commits: [], defaultBranch: 'main' }), { status: 200 })
      );
    }
    if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 201 }));
    }
    if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'PATCH') {
      return Promise.resolve(new Response(JSON.stringify({ outcome: 'idempotent', revision: 'revision-b' })));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
}

/**
 * Compiled-hook .mjs paths createWorktree() must be called with, derived from
 * the test ActionInput's extensionPath (`/test/extension`) — see
 * compiledHookScriptPaths() in claude-session.ts (Phase 4.5).
 */
const EXPECTED_COMPILED_SCRIPT_PATHS = {
  'pre-commit': path.join('/test/extension', 'dist', 'git-hooks', 'pre-commit.mjs'),
  'post-commit': path.join('/test/extension', 'dist', 'git-hooks', 'post-commit.mjs'),
  'post-rewrite': path.join('/test/extension', 'dist', 'git-hooks', 'post-rewrite.mjs')
};

describe('claude-session shared utilities', () => {
  describe('buildArgs', () => {
    it('includes --session-id for new sessions', async () => {
      const { buildArgs } = await import('../src/lib/claude-session.js');
      const args = buildArgs('my prompt', 'session-abc', false, 'interactive', '/card/repo', '/ext/path');
      expect(args).toContain('--session-id');
      expect(args).toContain('session-abc');
    });

    it('includes --resume for resumed sessions and omits --session-id', async () => {
      const { buildArgs } = await import('../src/lib/claude-session.js');
      const args = buildArgs('my prompt', 'session-abc', true, 'interactive', '/card/repo', '/ext/path');
      expect(args).toContain('--resume');
      expect(args).toContain('session-abc');
      expect(args).not.toContain('--session-id');
    });

    it('excludes --print in interactive mode', async () => {
      const { buildArgs } = await import('../src/lib/claude-session.js');
      const args = buildArgs('my prompt', 'session-abc', false, 'interactive', '/card/repo', '/ext/path');
      expect(args).not.toContain('--print');
    });

    it('includes --print in background mode', async () => {
      const { buildArgs } = await import('../src/lib/claude-session.js');
      const args = buildArgs('my prompt', 'session-abc', false, 'background', '/card/repo', '/ext/path');
      expect(args).toContain('--print');
    });

    it('omits prompt from args when undefined', async () => {
      const { buildArgs } = await import('../src/lib/claude-session.js');
      const args = buildArgs(undefined, 'session-abc', false, 'interactive', '/card/repo', '/ext/path');
      expect(args).toContain('--session-id');
      expect(args).toContain('session-abc');
      // First arg should be a flag, not a prompt string
      expect(args[0]).toBe('--session-id');
    });

    it('includes --settings, --add-dir, and --teammate-mode', async () => {
      const { buildArgs, buildPluginSettings } = await import('../src/lib/claude-session.js');
      const args = buildArgs('my prompt', 'session-abc', false, 'interactive', '/card/repo', '/ext/marketplace');
      expect(args).toContain('--settings');
      expect(args).toContain(buildPluginSettings('/ext/marketplace'));
      expect(args).not.toContain('--plugin-dir');
      expect(args).toContain('--add-dir');
      expect(args).toContain('/card/repo');
      expect(args).toContain('--teammate-mode');
      expect(args).toContain('in-process');
    });
  });

  describe('resolveBaseBranch', () => {
    it('returns trimmed branch name', async () => {
      const { resolveBaseBranch } = await import('../src/lib/claude-session.js');
      await configureExecFile({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
      });
      const result = await resolveBaseBranch('/test/workspace');
      expect(result).toBe('main');
    });

    it('propagates git errors', async () => {
      const { resolveBaseBranch } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') cb(new Error('not a git repo'));
        return {} as ReturnType<typeof execFile>;
      });
      await expect(resolveBaseBranch('/not/a/repo')).rejects.toThrow('not a git repo');
    });

    it('falls back to card-level parentBranch when branch records are absent', async () => {
      const { resolveBaseBranch } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');

      await configureExecFile({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'cards/card-123/1\n' }
      });

      // getBranches returns no records for this branch
      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(
            new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
          );
        }
        if (typeof url === 'string' && url.includes('/cards/card-123') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'card-123', title: 'Test', parentBranch: 'main' }), { status: 200 })
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      const result = await resolveBaseBranch('/test/workspace', client);
      expect(result).toBe('main');
    });

    it('rejects card-level parentBranch that is itself a cards/* branch', async () => {
      const { resolveBaseBranch } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');

      await configureExecFile({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'cards/card-123/1\n' }
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(
            new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
          );
        }
        if (typeof url === 'string' && url.includes('/cards/card-123') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'card-123', title: 'Test', parentBranch: 'cards/other-card/1' }), {
              status: 200
            })
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      await expect(resolveBaseBranch('/test/workspace', client)).rejects.toThrow(
        'Card branch "cards/card-123/1" has no parentBranch record.'
      );
    });

    it('throws when getCard API call fails and branch records are absent', async () => {
      const { resolveBaseBranch } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');

      await configureExecFile({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'cards/card-123/1\n' }
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(
            new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
          );
        }
        if (typeof url === 'string' && url.includes('/cards/card-123') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      await expect(resolveBaseBranch('/test/workspace', client)).rejects.toThrow(
        'Card branch "cards/card-123/1" has no parentBranch record.'
      );
    });
  });

  describe('resolveOrCreateWorktree', () => {
    it('reuses existing branch with valid worktree on disk', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const { access } = await import('node:fs/promises');
      const { createWorktree } = await import('@cards.management/sdk/worktree');

      configureBranchesResponse([
        {
          name: 'cards/card-123/1',
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z',
          exists: true
        }
      ]);

      vi.mocked(access).mockResolvedValue(undefined);

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      const result = await resolveOrCreateWorktree(baseInput(), client, 'main', createMockLogger());

      expect(result.worktreePath).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(result.branchName).toBe('cards/card-123/1');
      expect(result.parentBranch).toBe('main');
      expect(createWorktree).not.toHaveBeenCalled();
    });

    it('reattaches only the branch pre-owned by the exact successor execution', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const { access } = await import('node:fs/promises');
      configureBranchesResponse([
        {
          name: 'cards/card-123/1',
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z',
          revision: 'revision-a',
          activeExecutionOwner: 'execution-a',
          exists: true
        },
        {
          name: 'cards/card-123/2',
          worktree: '/test/workspace/.worktrees/cards/card-123/2',
          parentBranch: 'main',
          addedAt: '2025-01-02T00:00:00Z',
          revision: 'revision-b',
          activeExecutionOwner: 'execution-b',
          exists: true
        }
      ]);
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await resolveOrCreateWorktree(
        baseInput({
          executionId: 'execution-b',
          worktreeDirective: {
            kind: 'preowned',
            branch: 'cards/card-123/2',
            worktreePath: '/test/workspace/.worktrees/cards/card-123/2'
          }
        }),
        new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' }),
        'main',
        createMockLogger()
      );

      expect(result).toMatchObject({ branchName: 'cards/card-123/2', reason: 'reused' });
      expect(vi.mocked(fetch).mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    });

    it('does not convert a claim retry into a transfer from the sibling that won', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      const branch = {
        name: 'cards/card-123/1',
        revision: 'free',
        worktree: '/test/slot1',
        parentBranch: 'main',
        exists: true
      };
      vi.spyOn(client, 'getBranches')
        .mockResolvedValueOnce({ branches: [branch] } as never)
        .mockResolvedValue({
          branches: [{ ...branch, revision: 'sibling', activeExecutionOwner: 'execution-sibling' }]
        } as never);
      const update = vi
        .spyOn(client, 'updateBranchOwner')
        .mockRejectedValueOnce(Object.assign(new Error('contended'), { code: 'CONCURRENT_CARD_WRITE' }))
        .mockResolvedValue({ outcome: 'applied', revision: 'ours' });
      const result = await resolveOrCreateWorktree(baseInput(), client, 'main', createMockLogger());
      expect(result.branchName).toBe('cards/card-123/2');
      expect(update.mock.calls.filter((call) => call[1] === branch.name)).toHaveLength(1);
      expect(update.mock.calls.every((call) => call[2].expectedOwner.kind === 'none')).toBe(true);
    });

    it('creates new worktree when no branches exist', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const { createWorktree } = await import('@cards.management/sdk/worktree');

      configureBranchesResponse([]);

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      const result = await resolveOrCreateWorktree(baseInput(), client, 'main', createMockLogger());

      expect(createWorktree).toHaveBeenCalledWith('cards/card-123/1', {
        cwd: '/test/workspace',
        cardId: 'card-123',
        compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
      });
      expect(result.worktreePath).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(result.branchName).toBe('cards/card-123/1');
      expect(result.parentBranch).toBe('main');
    });

    it('advances through five synchronized contenders until every earlier slot has an owner', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
      const conflict = Object.assign(new Error('slot claimed'), { code: 'BRANCH_REGISTRATION_CONFLICT' });
      let releaseFirst!: () => void;
      const firstAttempt = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      vi.mocked(createWorktreeForCard)
        .mockImplementationOnce(async () => {
          await firstAttempt;
          throw conflict;
        })
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict)
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({
          path: '/test/workspace/.worktrees/cards/card-123/5',
          settle: Promise.resolve({
            branch: 'cards/card-123/5',
            worktree: '/test/workspace/.worktrees/cards/card-123/5',
            baseSha: 'abc123',
            copiedFromInclude: 0,
            reroutedSymlinks: 0
          })
        });
      configureBranchesResponse([]);

      const pending = resolveOrCreateWorktree(
        baseInput(),
        new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' }),
        'main',
        createMockLogger()
      );
      await Promise.resolve();
      releaseFirst();

      await expect(pending).resolves.toMatchObject({ branchName: 'cards/card-123/5', reason: 'allocated' });
      expect(vi.mocked(createWorktreeForCard).mock.calls.map((call) => call[1])).toEqual([
        'cards/card-123/1',
        'cards/card-123/2',
        'cards/card-123/3',
        'cards/card-123/4',
        'cards/card-123/5'
      ]);
    });

    it('skips occupied git slots when API and git are out of sync', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const { createWorktree, checkWorktreeExists } = await import('@cards.management/sdk/worktree');

      configureBranchesResponse([]);

      // Git has slot 1 occupied; slot 2 is free
      vi.mocked(checkWorktreeExists).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      vi.mocked(createWorktree).mockResolvedValue({
        path: '/test/workspace/.worktrees/cards/card-123/2',
        settle: Promise.resolve({
          branch: 'cards/card-123/2',
          worktree: '/test/workspace/.worktrees/cards/card-123/2',
          baseSha: 'abc123',
          copiedFromInclude: 0,
          reroutedSymlinks: 0
        })
      });

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      const result = await resolveOrCreateWorktree(baseInput(), client, 'main', createMockLogger());

      expect(createWorktree).toHaveBeenCalledWith('cards/card-123/2', {
        cwd: '/test/workspace',
        cardId: 'card-123',
        compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
      });
      expect(result.branchName).toBe('cards/card-123/2');
    });

    it('reattaches worktree for existing branch when worktree is missing from disk', async () => {
      const { resolveOrCreateWorktree } = await import('../src/lib/claude-session.js');
      const { CardsClient } = await import('@cards.management/sdk/client');
      const { createWorktree } = await import('@cards.management/sdk/worktree');
      const { access } = await import('node:fs/promises');

      configureBranchesResponse([
        {
          name: 'cards/card-123/1',
          worktree: '/nonexistent/worktree',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z',
          exists: true
        }
      ]);

      // fs.access rejects — worktree path doesn't exist on disk
      vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      vi.mocked(createWorktree).mockResolvedValue({
        path: '/test/workspace/.worktrees/cards/card-123/1',
        settle: Promise.resolve({
          branch: 'cards/card-123/1',
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          baseSha: 'abc123',
          copiedFromInclude: 0,
          reroutedSymlinks: 0
        })
      });

      const client = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'test-token' });
      const result = await resolveOrCreateWorktree(baseInput(), client, 'main', createMockLogger());

      // Should reattach the existing branch, not create a new one
      expect(createWorktree).toHaveBeenCalledWith('cards/card-123/1', {
        cwd: '/test/workspace',
        cardId: 'card-123',
        compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
      });
      expect(result.worktreePath).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(result.branchName).toBe('cards/card-123/1');
      expect(result.parentBranch).toBe('main');
    });
  });

  describe('cleanupMergedBranches', () => {
    /**
     * Installs a `globalThis.fetch` stub standing in for the Cards branch store.
     *
     * Cleanup decides reclamation from durable ownership read through
     * `getBranches`, and removes a branch record through the store's
     * conditional `DELETE` — so a sweep run against the default empty-branch
     * mock would classify every record as ownership-ambiguous and skip. This
     * serves both endpoints against an in-memory record map whose `revision`
     * rotates whenever a delete succeeds, mirroring the real store's CAS.
     *
     * @param records - Branch records keyed by branch name. `revision` is the
     *   opaque token the store would return for the current registration;
     *   `activeExecutionOwner` marks the branch claimed by a live execution.
     * @returns Handle exposing the observed `DELETE` calls and the mutable
     *   record map, so tests can assert both what was requested and what survived.
     */
    function configureBranchStore(records: Record<string, { revision: string; activeExecutionOwner?: string }>): {
      deletes: string[];
      records: Record<string, { revision: string; activeExecutionOwner?: string }>;
    } {
      const deletes: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const method = opts?.method ?? 'GET';
        if (typeof url === 'string' && url.includes('/branches')) {
          if (method === 'GET') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  branches: Object.entries(records).map(([name, record]) => ({ name, ...record })),
                  commits: [],
                  defaultBranch: 'main'
                }),
                { status: 200 }
              )
            );
          }
          if (method === 'PATCH') {
            const name = decodeURIComponent(new URL(url).pathname.split('/branches/')[1]!.replace(/\/owner$/, ''));
            const request = JSON.parse(String(opts?.body));
            const current = records[name];
            if (
              !current ||
              current.revision !== request.expectedRevision ||
              current.activeExecutionOwner !== undefined
            ) {
              return Promise.resolve(new Response(JSON.stringify({ outcome: 'owner_conflict' })));
            }
            current.activeExecutionOwner = request.replacementOwner;
            current.revision = `${current.revision}-claimed`;
            return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: current.revision })));
          }
          if (method === 'DELETE') {
            const parsed = new URL(url);
            const name = decodeURIComponent(parsed.pathname.split('/branches/')[1] ?? '');
            const expectedRevision = parsed.searchParams.get('expectedRevision') ?? '';
            deletes.push(`${name}@${expectedRevision}`);
            const current = records[name];
            if (current === undefined || current.revision !== expectedRevision) {
              return Promise.resolve(new Response(JSON.stringify({ outcome: 'preserved' }), { status: 200 }));
            }
            delete records[name];
            return Promise.resolve(new Response(JSON.stringify({ outcome: 'removed' }), { status: 200 }));
          }
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });
      return { deletes, records };
    }

    async function configureBranchesFile(
      branches: Record<
        string,
        { worktree?: string; parentBranch: string; addedAt: string; activeExecutionOwner?: string }
      >
    ): Promise<{ deletes: string[]; records: Record<string, { revision: string; activeExecutionOwner?: string }> }> {
      const { readFile, readdir, rm } = await import('node:fs/promises');
      const entryFiles = Object.keys(branches).map((name) => `${encodeURIComponent(name)}.json`);

      vi.mocked(readdir).mockImplementation(((dirPath: unknown) => {
        if (String(dirPath).endsWith('branches')) {
          return Promise.resolve(entryFiles);
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }) as unknown as typeof readdir);

      vi.mocked(readFile).mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        // A non-active, readable status lets the sweep proceed past the
        // fail-closed status guard so these tests exercise the branch loop.
        if (p.endsWith('CARD.meta.json')) {
          return Promise.resolve(JSON.stringify({ status: 'needs_review' }));
        }
        for (const [name, data] of Object.entries(branches)) {
          if (p.endsWith(`${encodeURIComponent(name)}.json`)) {
            return Promise.resolve(JSON.stringify({ name, ...data }, null, 2));
          }
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      vi.mocked(rm).mockResolvedValue(undefined);

      // Reachable store with one free (unclaimed) registration per on-disk
      // record, so a sweep can positively prove ownership absent. A test
      // needing a claimed or unreadable branch calls `configureBranchStore`
      // afterwards, which replaces this stub wholesale.
      return configureBranchStore(
        Object.fromEntries(
          Object.entries(branches).map(([name, data], index) => [
            name,
            {
              revision: `rev-${index + 1}`,
              ...(data.activeExecutionOwner !== undefined ? { activeExecutionOwner: data.activeExecutionOwner } : {})
            }
          ])
        )
      );
    }

    describe('readBranchEntries', () => {
      it('returns [] when the branches/ directory does not exist', async () => {
        const { readBranchEntries } = await import('../src/lib/claude-session.js');
        const { readdir } = await import('node:fs/promises');
        vi.mocked(readdir).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

        await expect(readBranchEntries('/test/repo', createMockLogger())).resolves.toEqual([]);
      });

      it("parses populated branch entry files, keyed by the file contents' name field", async () => {
        const { readBranchEntries } = await import('../src/lib/claude-session.js');
        await configureBranchesFile({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          },
          'cards/card-456/2': {
            parentBranch: 'develop',
            addedAt: '2025-01-02T00:00:00Z'
          }
        });

        const entries = await readBranchEntries('/test/repo', createMockLogger());

        expect(entries).toEqual([
          [
            'cards/card-123/1',
            {
              name: 'cards/card-123/1',
              worktree: '/test/workspace/.worktrees/cards/card-123/1',
              parentBranch: 'main',
              addedAt: '2025-01-01T00:00:00Z'
            }
          ],
          ['cards/card-456/2', { name: 'cards/card-456/2', parentBranch: 'develop', addedAt: '2025-01-02T00:00:00Z' }]
        ]);
      });

      it('propagates non-ENOENT read failures', async () => {
        const { readBranchEntries } = await import('../src/lib/claude-session.js');
        const { readdir } = await import('node:fs/promises');
        vi.mocked(readdir).mockRejectedValue(new Error('EACCES: permission denied'));

        await expect(readBranchEntries('/test/repo', createMockLogger())).rejects.toThrow('EACCES');
      });

      it('skips an unparseable record with a warning and still parses healthy records', async () => {
        const { readBranchEntries } = await import('../src/lib/claude-session.js');
        const { readFile, readdir } = await import('node:fs/promises');
        const logger = createMockLogger();
        const warnSpy = vi.spyOn(logger, 'warn');

        vi.mocked(readdir).mockResolvedValue(['good.json', 'corrupt.json'] as unknown as Awaited<
          ReturnType<typeof readdir>
        >);
        vi.mocked(readFile).mockImplementation((filePath: unknown) => {
          const p = String(filePath);
          if (p.endsWith('good.json')) {
            return Promise.resolve(
              JSON.stringify({ name: 'cards/card-123/1', parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' })
            );
          }
          if (p.endsWith('corrupt.json')) {
            return Promise.resolve('{ not json');
          }
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        });

        await expect(readBranchEntries('/test/repo', logger)).resolves.toEqual([
          ['cards/card-123/1', { name: 'cards/card-123/1', parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' }]
        ]);
        expect(warnSpy).toHaveBeenCalledWith(
          'Skipping unreadable branch record',
          expect.objectContaining({ file: expect.stringContaining('corrupt.json') })
        );
      });

      it('skips a single unreadable record file with a warning and keeps the rest', async () => {
        const { readBranchEntries } = await import('../src/lib/claude-session.js');
        const { readFile, readdir } = await import('node:fs/promises');
        const logger = createMockLogger();
        const warnSpy = vi.spyOn(logger, 'warn');

        vi.mocked(readdir).mockResolvedValue(['good.json', 'locked.json'] as unknown as Awaited<
          ReturnType<typeof readdir>
        >);
        vi.mocked(readFile).mockImplementation((filePath: unknown) => {
          const p = String(filePath);
          if (p.endsWith('good.json')) {
            return Promise.resolve(
              JSON.stringify({ name: 'cards/card-123/1', parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' })
            );
          }
          if (p.endsWith('locked.json')) {
            return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
          }
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        });

        await expect(readBranchEntries('/test/repo', logger)).resolves.toEqual([
          ['cards/card-123/1', { name: 'cards/card-123/1', parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' }]
        ]);
        expect(warnSpy).toHaveBeenCalledWith(
          'Skipping unreadable branch record',
          expect.objectContaining({ file: expect.stringContaining('locked.json') })
        );
      });

      it.each([
        ['missing name', { parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' }],
        ['empty-string name', { name: '', parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' }],
        ['non-string name', { name: 42, parentBranch: 'main', addedAt: '2025-01-01T00:00:00Z' }]
      ])('ignores a record with a %s and warns', async (_label, record) => {
        const { readBranchEntries } = await import('../src/lib/claude-session.js');
        const { readFile, readdir } = await import('node:fs/promises');
        const logger = createMockLogger();
        const warnSpy = vi.spyOn(logger, 'warn');

        vi.mocked(readdir).mockResolvedValue(['nameless.json'] as unknown as Awaited<ReturnType<typeof readdir>>);
        vi.mocked(readFile).mockImplementation((filePath: unknown) => {
          if (String(filePath).endsWith('nameless.json')) {
            return Promise.resolve(JSON.stringify(record));
          }
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        });

        await expect(readBranchEntries('/test/repo', logger)).resolves.toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          'Ignoring branch record without a usable name',
          expect.objectContaining({ file: expect.stringContaining('nameless.json') })
        );
      });
    });

    it('contains one corrupt record: healthy branches still clean up without a throw', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');
      const { readFile, readdir } = await import('node:fs/promises');
      const logger = createMockLogger();
      const warnSpy = vi.spyOn(logger, 'warn');

      vi.mocked(readdir).mockImplementation(((dirPath: unknown) => {
        if (String(dirPath).endsWith('branches')) {
          return Promise.resolve([
            `${encodeURIComponent('cards/card-123/1')}.json`,
            `${encodeURIComponent('cards/card-456/2')}.json`
          ]);
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }) as unknown as typeof readdir);

      vi.mocked(readFile).mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('CARD.meta.json')) {
          return Promise.resolve(JSON.stringify({ status: 'needs_review' }));
        }
        if (p.endsWith(`${encodeURIComponent('cards/card-123/1')}.json`)) {
          return Promise.resolve(
            JSON.stringify({
              name: 'cards/card-123/1',
              worktree: '/test/workspace/.worktrees/cards/card-123/1',
              parentBranch: 'main',
              addedAt: '2025-01-01T00:00:00Z'
            })
          );
        }
        if (p.endsWith(`${encodeURIComponent('cards/card-456/2')}.json`)) {
          return Promise.resolve('{ "name": broken');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        const cmdArgs = args[1] as string[];
        if (typeof cb === 'function') {
          if (cmdArgs?.includes('--list')) {
            cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      configureBranchStore({ 'cards/card-123/1': { revision: 'rev-1' } });

      const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', logger);

      expect(outcomes).toEqual([
        { cardId: 'card-123', branch: 'cards/card-123/1', action: 'cleaned', reason: 'merged' }
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        'Skipping unreadable branch record',
        expect.objectContaining({ file: expect.stringContaining(`${encodeURIComponent('cards/card-456/2')}.json`) })
      );
      expect(vi.mocked(execFile).mock.calls.some((c) => String(c[1]?.join(' ')).includes('card-456/2'))).toBe(false);
    });

    it('treats an all-corrupt branches/ directory as a warned no-op', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');
      const { readFile, readdir } = await import('node:fs/promises');
      const logger = createMockLogger();
      const warnSpy = vi.spyOn(logger, 'warn');

      vi.mocked(readdir).mockImplementation(((dirPath: unknown) => {
        if (String(dirPath).endsWith('branches')) {
          return Promise.resolve(['a.json', 'b.json']);
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }) as unknown as typeof readdir);

      vi.mocked(readFile).mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('CARD.meta.json')) {
          return Promise.resolve(JSON.stringify({ status: 'needs_review' }));
        }
        if (p.endsWith('.json')) {
          return Promise.resolve('not json at all');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', logger);

      expect(outcomes).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    });

    it('skips the entire sweep with zero git calls when the card is active', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');
      const { readFile, readdir } = await import('node:fs/promises');

      vi.mocked(readFile).mockImplementation((filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('CARD.meta.json')) {
          return Promise.resolve(JSON.stringify({ status: 'active' }));
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

      expect(outcomes).toEqual([{ cardId: 'card-123', branch: '(all)', action: 'skipped', reason: 'active' }]);
      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
      expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    });

    it('fails closed with zero git calls when the card status is unreadable (null)', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');
      const { readFile, readdir } = await import('node:fs/promises');

      // A missing/corrupt CARD.meta.json reads back as null status. The sweep
      // must not touch the card — it cannot prove the card is inactive.
      vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

      expect(outcomes).toEqual([
        { cardId: 'card-123', branch: '(all)', action: 'skipped', reason: 'status-unreadable' }
      ]);
      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
      expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    });

    it('removes fully merged branches (worktree, ref, and branch record)', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');
      const { rm } = await import('node:fs/promises');

      const { deletes } = await configureBranchesFile({
        'cards/card-123/1': {
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z'
        }
      });

      // All git commands succeed; branch --list returns the branch
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        const cmdArgs = args[1] as string[];
        if (typeof cb === 'function') {
          if (cmdArgs?.includes('--list')) {
            cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

      const execCalls = vi.mocked(execFile).mock.calls;

      // Verify merge-base check uses the branch's parentBranch
      const mergeBaseCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('merge-base') && (c[1] as string[])?.includes('--is-ancestor')
      );
      expect(mergeBaseCall).toBeDefined();
      expect(mergeBaseCall![1] as string[]).toContain('main');
      expect(mergeBaseCall![1] as string[]).toContain('cards/card-123/1');

      const worktreeRemoveCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('worktree') && (c[1] as string[])?.includes('remove')
      );
      expect(worktreeRemoveCall).toBeDefined();

      const branchDeleteCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('branch') && (c[1] as string[])?.includes('-d')
      );
      expect(branchDeleteCall).toBeDefined();

      // Verify the record was removed through the store's conditional path —
      // naming the revision whose freedom was proven — rather than by editing
      // branches/ and committing directly, which would race the store's CAS.
      expect(deletes).toEqual([`cards/card-123/1@rev-1-claimed`]);
      expect(rm).not.toHaveBeenCalled();
      const gitRmCall = execCalls.find(
        (c) => (c[1] as string[])?.[0] === 'rm' && (c[1] as string[])?.includes('--ignore-unmatch')
      );
      expect(gitRmCall).toBeUndefined();

      expect(outcomes).toContainEqual(expect.objectContaining({ action: 'cleaned', branch: 'cards/card-123/1' }));
    });

    it('checks each branch against its own parentBranch, not workspace HEAD', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');

      await configureBranchesFile({
        'cards/card-123/1': {
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'develop',
          addedAt: '2025-01-01T00:00:00Z'
        }
      });
      configureBranchStore({ 'cards/card-123/1': { revision: 'rev-1' } });

      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        const cmdArgs = args[1] as string[];
        if (typeof cb === 'function') {
          if (cmdArgs?.includes('--list')) {
            cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
          } else if (cmdArgs?.includes('merge-base')) {
            cb(new Error('exit code 1'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

      const execCalls = vi.mocked(execFile).mock.calls;
      const mergeBaseCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('merge-base') && (c[1] as string[])?.includes('--is-ancestor')
      );
      expect(mergeBaseCall).toBeDefined();
      expect(mergeBaseCall![1] as string[]).toContain('develop');
    });

    it('skips unmerged branches', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');

      await configureBranchesFile({
        'cards/card-123/1': {
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z'
        }
      });

      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        const cmdArgs = args[1] as string[];
        if (typeof cb === 'function') {
          if (cmdArgs?.includes('--list')) {
            cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
          } else {
            cb(new Error('exit code 1'));
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

      const execCalls = vi.mocked(execFile).mock.calls;
      const worktreeRemoveCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('worktree') && (c[1] as string[])?.includes('remove')
      );
      expect(worktreeRemoveCall).toBeUndefined();

      const branchDeleteCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('branch') && (c[1] as string[])?.includes('-d')
      );
      expect(branchDeleteCall).toBeUndefined();

      expect(outcomes).toContainEqual(expect.objectContaining({ action: 'skipped', reason: 'not-merged' }));
    });

    it('continues cleanup when individual operations fail (partial failure)', async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      const { execFile } = await import('node:child_process');

      await configureBranchesFile({
        'cards/card-123/1': {
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z'
        }
      });

      // merge-base succeeds but worktree remove fails; branch delete succeeds
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        const cmd = args[0] as string;
        const cmdArgs = args[1] as string[];
        const key = `${cmd} ${cmdArgs.join(' ')}`;

        if (typeof cb === 'function') {
          if (key.includes('branch --list')) {
            cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
          } else if (key.includes('merge-base --is-ancestor')) {
            cb(null, { stdout: '', stderr: '' });
          } else if (key.includes('worktree remove')) {
            cb(new Error('cannot remove worktree'));
          } else {
            cb(null, { stdout: '', stderr: '' });
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger())).resolves.toEqual(
        expect.any(Array)
      );

      const execCalls = vi.mocked(execFile).mock.calls;
      const branchDeleteCall = execCalls.find(
        (c) => (c[1] as string[])?.includes('branch') && (c[1] as string[])?.includes('-d')
      );
      expect(branchDeleteCall).toBeUndefined();
    });

    /**
     * Durable ownership — not a process scan — decides reclamation.
     *
     * These fixtures pin the fail-closed contract: a branch is reclaimed only
     * when its ownership has been positively proven absent by a read taken at
     * the point of decision. A claimed branch, an unreadable store, a record
     * the store no longer lists, and a store that moved on between the read and
     * the write must all leave every Git resource exactly where it was.
     */
    describe('durable ownership authority', () => {
      /** Merged-branch git responses: the branch exists and is an ancestor of its parent. */
      async function configureMergedGit(): Promise<void> {
        const { execFile } = await import('node:child_process');
        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
          const cb = args[args.length - 1];
          const cmdArgs = args[1] as string[];
          if (typeof cb === 'function') {
            if (cmdArgs?.includes('--list')) {
              cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
            } else {
              cb(null, { stdout: '', stderr: '' });
            }
          }
          return {} as ReturnType<typeof execFile>;
        });
      }

      /**
       * Asserts the sweep left the branch's Git resources untouched.
       *
       * @param execFile - The mocked `execFile` whose recorded calls are inspected.
       */
      function expectNothingDestructive(execFile: typeof import('node:child_process').execFile): void {
        const execCalls = vi.mocked(execFile).mock.calls;
        expect(
          execCalls.find((c) => (c[1] as string[])?.includes('worktree') && (c[1] as string[])?.includes('remove'))
        ).toBeUndefined();
        expect(
          execCalls.find((c) => (c[1] as string[])?.includes('branch') && (c[1] as string[])?.includes('-d'))
        ).toBeUndefined();
      }

      it('skips a branch claimed by another execution even when no process occupies its worktree', async () => {
        const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
        const { execFile } = await import('node:child_process');

        await configureBranchesFile({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });
        await configureMergedGit();
        // The store says a sibling execution owns this checkout. Nothing about
        // the process table can change that answer, so the sweep must skip
        // before it reaches any destructive step.
        const { deletes } = configureBranchStore({
          'cards/card-123/1': { revision: 'rev-1', activeExecutionOwner: 'execution-sibling' }
        });

        const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

        expect(outcomes).toContainEqual(
          expect.objectContaining({ branch: 'cards/card-123/1', action: 'skipped', reason: 'in-use' })
        );
        expectNothingDestructive(execFile);
        expect(deletes).toEqual([]);
      });

      it('performs no destructive effects when a sibling claims after the final ownership read', async () => {
        const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
        const { execFile } = await import('node:child_process');
        await configureBranchesFile({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });
        await configureMergedGit();
        const { records, deletes } = configureBranchStore({ 'cards/card-123/1': { revision: 'rev-1' } });
        const transport = globalThis.fetch;
        globalThis.fetch = vi.fn((url, options) => {
          if (options?.method === 'PATCH')
            records['cards/card-123/1'] = { revision: 'sibling-revision', activeExecutionOwner: 'sibling' };
          return transport(url, options);
        });
        await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());
        expectNothingDestructive(execFile);
        expect(deletes).toEqual([]);
        expect(records['cards/card-123/1']?.activeExecutionOwner).toBe('sibling');
      });

      it('skips the branch when the store cannot be listed', async () => {
        const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
        const { execFile } = await import('node:child_process');

        await configureBranchesFile({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });
        await configureMergedGit();
        globalThis.fetch = vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' }), { status: 403 }));
        const logger = createMockLogger();
        const warnSpy = vi.spyOn(logger, 'warn');

        const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', logger);

        expect(outcomes).toContainEqual(
          expect.objectContaining({ branch: 'cards/card-123/1', action: 'skipped', reason: 'ownership-unreadable' })
        );
        expect(warnSpy).toHaveBeenCalledWith(
          'Cannot read durable branch ownership — treating the branch as claimed',
          expect.objectContaining({ branch: 'cards/card-123/1' })
        );
        expectNothingDestructive(execFile);
      });

      it('skips the branch when the store no longer lists the record', async () => {
        const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
        const { execFile } = await import('node:child_process');

        await configureBranchesFile({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });
        await configureMergedGit();
        // The on-disk record exists but the authoritative store has no matching
        // registration: ownership is ambiguous, which is not the same as absent.
        const { deletes } = configureBranchStore({});

        const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

        expect(outcomes).toContainEqual(
          expect.objectContaining({ branch: 'cards/card-123/1', action: 'skipped', reason: 'ownership-unreadable' })
        );
        expectNothingDestructive(execFile);
        expect(deletes).toEqual([]);
      });

      it('preserves the record when the store moved on after the ownership read', async () => {
        const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
        const { execFile } = await import('node:child_process');

        await configureBranchesFile({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });
        await configureMergedGit();
        // The record frees itself at read time but carries a different revision
        // by the time the delete lands — the CAS the sweep must not bypass.
        const { deletes, records } = configureBranchStore({ 'cards/card-123/1': { revision: 'rev-1' } });
        records['cards/card-123/1'] = { revision: 'rev-2', activeExecutionOwner: 'execution-successor' };

        const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

        expect(deletes).toEqual([]);
        expectNothingDestructive(execFile);
        expect(outcomes).toContainEqual(
          expect.objectContaining({ branch: 'cards/card-123/1', action: 'skipped', reason: 'in-use' })
        );
      });

      it('skips the whole sweep when the Cards API cannot be discovered', async () => {
        const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
        const { execFile } = await import('node:child_process');
        const { readdir } = await import('node:fs/promises');

        // Discovery failure means there is no durable authority to consult, so
        // no branch can be proven free. Fail closed for the whole card before
        // reading any record or running any git command.
        const previous = process.env['API_TEST_MODE'];
        delete process.env['API_TEST_MODE'];
        try {
          const outcomes = await cleanupMergedBranches(baseInput(), '/test/repo', createMockLogger());

          expect(outcomes).toEqual([
            { cardId: 'card-123', branch: '(all)', action: 'skipped', reason: 'ownership-unreadable' }
          ]);
        } finally {
          if (previous !== undefined) process.env['API_TEST_MODE'] = previous;
        }
        expect(vi.mocked(execFile)).not.toHaveBeenCalled();
        expect(vi.mocked(readdir)).not.toHaveBeenCalled();
      });
    });
  });

  describe('errorMessage', () => {
    it('extracts Error.message', async () => {
      const { errorMessage } = await import('../src/lib/claude-session.js');
      const err = new Error('something failed');
      expect(errorMessage(err)).toBe('something failed');
    });

    it('stringifies non-Error values', async () => {
      const { errorMessage } = await import('../src/lib/claude-session.js');
      expect(errorMessage('plain string')).toBe('plain string');
      expect(errorMessage(42)).toBe('42');
      expect(errorMessage(null)).toBe('null');
    });
  });

  describe('resolveMarketplacePath', () => {
    it('returns marketplace path from MARKETPLACE_PATH', async () => {
      const { resolveMarketplacePath } = await import('../src/lib/claude-session.js');
      process.env['MARKETPLACE_PATH'] = '/test/marketplace';
      try {
        expect(resolveMarketplacePath()).toBe('/test/marketplace');
      } finally {
        delete process.env['MARKETPLACE_PATH'];
      }
    });

    it('throws when MARKETPLACE_PATH is not set', async () => {
      const { resolveMarketplacePath } = await import('../src/lib/claude-session.js');
      const saved = process.env['MARKETPLACE_PATH'];
      delete process.env['MARKETPLACE_PATH'];
      try {
        expect(() => resolveMarketplacePath()).toThrow('Missing required environment variable');
      } finally {
        if (saved !== undefined) process.env['MARKETPLACE_PATH'] = saved;
      }
    });
  });

  describe('buildPluginSettings', () => {
    it('produces JSON with marketplace directory source', async () => {
      const { buildPluginSettings } = await import('../src/lib/claude-session.js');
      const settings = JSON.parse(buildPluginSettings('/ext/dist/marketplace'));
      expect(settings.enabledPlugins).toEqual({ 'runtime@cards.management': true });
      expect(settings.extraKnownMarketplaces['cards.management'].source).toEqual({
        source: 'directory',
        path: '/ext/dist/marketplace'
      });
    });
  });

  describe('resolveClaudeConfigDir', () => {
    it('returns CLAUDE_CONFIG_DIR verbatim and unconditionally when set (no disk probe)', async () => {
      const { resolveClaudeConfigDir } = await import('../src/lib/claude-session.js');
      const { access } = await import('node:fs/promises');
      // An explicit override is authoritative — it must be honored even when its
      // `plugins/` subdir does not exist yet (e.g. a freshly relocated config
      // dir). The disk probe must NOT run for the override case.
      vi.mocked(access).mockClear();

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = '/custom/claude';
      try {
        const result = await resolveClaudeConfigDir();
        expect(result).toBe('/custom/claude');
        expect(access).not.toHaveBeenCalled();
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        else delete process.env['CLAUDE_CONFIG_DIR'];
      }
    });

    it('falls through to ~/.claude when earlier candidates lack plugins/', async () => {
      const { resolveClaudeConfigDir } = await import('../src/lib/claude-session.js');
      const { access } = await import('node:fs/promises');
      // Reject all candidates until the last one
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      vi.mocked(access).mockRejectedValue(enoent);
      // Allow the last candidate (~/.claude/plugins)
      vi.mocked(access).mockRejectedValueOnce(enoent); // ~/.config/claude/plugins
      vi.mocked(access).mockResolvedValueOnce(undefined); // ~/.claude/plugins

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      delete process.env['CLAUDE_CONFIG_DIR'];
      const savedXdg = process.env['XDG_DATA_HOME'];
      delete process.env['XDG_DATA_HOME'];
      const savedXdgConfig = process.env['XDG_CONFIG_HOME'];
      delete process.env['XDG_CONFIG_HOME'];
      try {
        const result = await resolveClaudeConfigDir();
        expect(result).toMatch(/\.claude$/);
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        if (savedXdg !== undefined) process.env['XDG_DATA_HOME'] = savedXdg;
        if (savedXdgConfig !== undefined) process.env['XDG_CONFIG_HOME'] = savedXdgConfig;
      }
    });

    it('returns null when no candidates exist', async () => {
      const { resolveClaudeConfigDir } = await import('../src/lib/claude-session.js');
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      delete process.env['CLAUDE_CONFIG_DIR'];
      const savedXdg = process.env['XDG_DATA_HOME'];
      delete process.env['XDG_DATA_HOME'];
      const savedXdgConfig = process.env['XDG_CONFIG_HOME'];
      delete process.env['XDG_CONFIG_HOME'];
      try {
        const result = await resolveClaudeConfigDir();
        expect(result).toBeNull();
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        if (savedXdg !== undefined) process.env['XDG_DATA_HOME'] = savedXdg;
        if (savedXdgConfig !== undefined) process.env['XDG_CONFIG_HOME'] = savedXdgConfig;
      }
    });
  });

  describe('updateMarketplaceRegistration', () => {
    it('updates known_marketplaces.json when cards.management has stale path', async () => {
      const { updateMarketplaceRegistration } = await import('../src/lib/claude-session.js');
      const fsPromises = await import('node:fs/promises');

      const existing = {
        'cards.management': {
          source: { source: 'directory', path: 'public' },
          installLocation: 'public',
          lastUpdated: '2025-01-01T00:00:00Z'
        }
      };

      vi.mocked(fsPromises.access).mockResolvedValueOnce(undefined);
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify(existing));
      vi.mocked(fsPromises.writeFile).mockResolvedValueOnce(undefined);

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = '/home/node/.claude';
      try {
        await updateMarketplaceRegistration('/ext/dist/marketplace', createMockLogger());
        expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
        const written = JSON.parse(vi.mocked(fsPromises.writeFile).mock.calls[0][1] as string);
        expect(written['cards.management'].source.path).toBe('/ext/dist/marketplace');
        expect(written['cards.management'].installLocation).toBe('/ext/dist/marketplace');
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        else delete process.env['CLAUDE_CONFIG_DIR'];
      }
    });

    it('skips write when path already matches', async () => {
      const { updateMarketplaceRegistration } = await import('../src/lib/claude-session.js');
      const fsPromises = await import('node:fs/promises');

      const existing = {
        'cards.management': {
          source: { source: 'directory', path: '/ext/dist/marketplace' },
          installLocation: '/ext/dist/marketplace',
          lastUpdated: '2025-01-01T00:00:00Z'
        }
      };

      vi.mocked(fsPromises.access).mockResolvedValueOnce(undefined);
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify(existing));

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = '/home/node/.claude';
      try {
        await updateMarketplaceRegistration('/ext/dist/marketplace', createMockLogger());
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        else delete process.env['CLAUDE_CONFIG_DIR'];
      }
    });

    it('skips when known_marketplaces.json does not exist', async () => {
      const { updateMarketplaceRegistration } = await import('../src/lib/claude-session.js');
      const fsPromises = await import('node:fs/promises');

      vi.mocked(fsPromises.access).mockResolvedValueOnce(undefined);
      const enoent = new Error('ENOENT') as Error & { code: string };
      enoent.code = 'ENOENT';
      vi.mocked(fsPromises.readFile).mockRejectedValueOnce(enoent);

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = '/home/node/.claude';
      try {
        await updateMarketplaceRegistration('/ext/dist/marketplace', createMockLogger());
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        else delete process.env['CLAUDE_CONFIG_DIR'];
      }
    });

    it('skips when cards.management entry uses non-directory source', async () => {
      const { updateMarketplaceRegistration } = await import('../src/lib/claude-session.js');
      const fsPromises = await import('node:fs/promises');

      const existing = {
        'cards.management': {
          source: { source: 'github', repo: 'some/repo' },
          installLocation: '/some/path'
        }
      };

      vi.mocked(fsPromises.access).mockResolvedValueOnce(undefined);
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify(existing));

      const saved = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = '/home/node/.claude';
      try {
        await updateMarketplaceRegistration('/ext/dist/marketplace', createMockLogger());
        expect(fsPromises.writeFile).not.toHaveBeenCalled();
      } finally {
        if (saved !== undefined) process.env['CLAUDE_CONFIG_DIR'] = saved;
        else delete process.env['CLAUDE_CONFIG_DIR'];
      }
    });
  });

  describe('spawnClaudeSession', () => {
    it('sets WORKSPACE_PATH to the worktree path, not the original workspace', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      // Set EXTENSION_PATH for extensionPath in ActionInput
      process.env['EXTENSION_PATH'] = '/test/extension';
      // Set MARKETPLACE_PATH for resolveMarketplacePath
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string>; cwd: string };
      // cwd and WORKSPACE_PATH must both be the worktree, not the original workspace
      expect(spawnOpts.cwd).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(spawnOpts.env.WORKSPACE_PATH).toBe('/test/workspace/.worktrees/cards/card-123/1');

      child.emit('close', 0);
      await promise;
    });

    it('sets BASE_BRANCH, PARENT_BRANCH, and WORKSPACE_BRANCH', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      // Set EXTENSION_PATH for extensionPath in ActionInput
      process.env['EXTENSION_PATH'] = '/test/extension';
      // Set MARKETPLACE_PATH for resolveMarketplacePath
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect(spawnOpts.env.BASE_BRANCH).toBe('main');
      expect(spawnOpts.env.PARENT_BRANCH).toBe('main');
      expect(spawnOpts.env.WORKSPACE_BRANCH).toBe('cards/card-123/1');

      child.emit('close', 0);
      await promise;
    });

    it('registers onSwitchToInteractive when supportsSwitchToInteractive is true', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      // Set EXTENSION_PATH for extensionPath in ActionInput
      process.env['EXTENSION_PATH'] = '/test/extension';
      // Set MARKETPLACE_PATH for resolveMarketplacePath
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: true
      });
      await flushMicrotasks();

      expect(context.onSwitchToInteractive).toHaveBeenCalledWith(expect.any(Function));

      const switchCallback = vi.mocked(context.onSwitchToInteractive).mock.calls[0]![0] as () => unknown;
      const result = switchCallback();
      expect(result).toEqual({ sessionId: 'session-123' });

      child.emit('close', null);
      await promise;
    });

    it('does not register onSwitchToInteractive when supportsSwitchToInteractive is false', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      // Set EXTENSION_PATH for extensionPath in ActionInput
      process.env['EXTENSION_PATH'] = '/test/extension';
      // Set MARKETPLACE_PATH for resolveMarketplacePath
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      expect(context.onSwitchToInteractive).not.toHaveBeenCalled();

      child.emit('close', 0);
      await promise;
    });

    it('registers owned-tree cancellation and reports the termination result', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      // Set EXTENSION_PATH for extensionPath in ActionInput
      process.env['EXTENSION_PATH'] = '/test/extension';
      // Set MARKETPLACE_PATH for resolveMarketplacePath
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      const spawnOptions = vi.mocked(spawn).mock.calls[0]![2] as Record<string, unknown>;
      expect(spawnOptions['detached']).toBeUndefined();

      const onCancel = vi.mocked(context.onCancel).mock.calls[0]![0] as () => Promise<void>;
      await expect(onCancel()).resolves.toBeUndefined();

      child.emit('close', 0);
      await promise;
    });

    it('logs candidate branches before spawning the branch-cleanup watcher (interactive mode)', async () => {
      const { spawn } = await import('node:child_process');
      const { readdir, readFile } = await import('node:fs/promises');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      vi.mocked(readdir).mockImplementation(((dirPath: unknown) => {
        if (String(dirPath).endsWith('branches')) {
          return Promise.resolve([`${encodeURIComponent('cards/card-123/1')}.json`]);
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }) as unknown as typeof readdir);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          name: 'cards/card-123/1',
          worktree: '/test/workspace/.worktrees/cards/card-123/1',
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z'
        })
      );

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const logSpy = vi.spyOn(context.logger, 'info');

      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      child.emit('close', 0);
      await promise;

      expect(logSpy).toHaveBeenCalledWith('Branch-cleanup watcher spawn attempt', {
        cardId: 'card-123',
        sessionId: 'session-123',
        candidateBranches: ['cards/card-123/1']
      });

      const spawnAttemptIndex = logSpy.mock.calls.findIndex(
        (call) => call[0] === 'Branch-cleanup watcher spawn attempt'
      );
      const actionCompletedIndex = logSpy.mock.calls.findIndex((call) => call[0] === 'Launch action completed');
      expect(spawnAttemptIndex).toBeGreaterThan(actionCompletedIndex);
    });

    describe('cross-platform CLI spawn', () => {
      const originalPlatform = process.platform;
      let savedComSpec: string | undefined;

      /**
       * Forces process.platform for the duration of a test so the win32 / POSIX
       * branch of spawnAgentCli is exercised. resolveCliExecutable caches its
       * result for the process lifetime, so platform overrides must be paired
       * with vi.resetModules() (done in each test) to re-import a fresh module.
       *
       * @param platform - Platform value to install on process.platform.
       */
      function forcePlatform(platform: NodeJS.Platform): void {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      }

      beforeEach(() => {
        process.env['EXTENSION_PATH'] = '/test/extension';
        process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
        savedComSpec = process.env['ComSpec'];
      });

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        if (savedComSpec !== undefined) process.env['ComSpec'] = savedComSpec;
        else delete process.env['ComSpec'];
      });

      it('spawns the bare CLI name through the shell on win32 so the PATHEXT .cmd shim resolves', async () => {
        vi.resetModules();
        await setupDefaultMocks();
        forcePlatform('win32');

        const { spawn } = await import('node:child_process');
        const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const promise = spawnClaudeSession(baseInput(), createMockContext(), {
          prompt: 'fix the bug',
          sessionId: 'session-123',
          resume: false,
          supportsSwitchToInteractive: false
        });
        await flushMicrotasks();

        const [command, spawnArgs, spawnOpts] = vi.mocked(spawn).mock.calls[0]! as [
          string,
          string[],
          Record<string, unknown>
        ];
        // Bare name forwarded to the launcher; cross-spawn (exercised for real in
        // spawn-cli.test.ts) resolves the win32 `claude.cmd` PATHEXT shim and escapes
        // args. The session code itself sets no `shell` option — that concern is
        // delegated to the launcher, so none leaks into the spawn options here.
        expect(command).toBe('claude');
        expect(spawnArgs).toContain('session-123');
        expect(spawnOpts['shell']).toBeUndefined();
        // Interactive mode inherits stdio; R2 — libuv ignores windowsHide when an
        // fd is inherited — so the session must NOT set it (the console-subsystem
        // interpreter switch, not windowsHide, fixes the interactive path).
        expect(spawnOpts['stdio']).toBe('inherit');
        expect(spawnOpts['windowsHide']).toBeUndefined();

        child.emit('close', 0);
        await promise;
      });

      it('passes windowsHide:true on win32 in background mode (no inherited stdio)', async () => {
        vi.resetModules();
        await setupDefaultMocks();
        forcePlatform('win32');

        const { spawn } = await import('node:child_process');
        const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const promise = spawnClaudeSession(baseInput({ executionMode: 'background' }), createMockContext(), {
          prompt: 'fix the bug',
          sessionId: 'session-123',
          resume: false,
          supportsSwitchToInteractive: false
        });
        await flushMicrotasks();

        const [command, , spawnOpts] = vi.mocked(spawn).mock.calls[0]! as [string, string[], Record<string, unknown>];
        // Background mode pipes stdio (no inherited fd), so the cross-spawn
        // `cmd.exe /c claude.cmd` hop would pop a console window under stock node
        // without windowsHide. libuv honors CREATE_NO_WINDOW here.
        expect(command).toBe('claude');
        expect(spawnOpts['stdio']).toEqual(['ignore', 'ignore', 'pipe']);
        expect(spawnOpts['windowsHide']).toBe(true);
        expect(spawnOpts['shell']).toBeUndefined();

        child.emit('close', 0);
        await promise;
      });

      it('spawns claude on win32 when the CLI resolves on PATH', async () => {
        vi.resetModules();
        await setupDefaultMocks();
        forcePlatform('win32');

        const { spawn, execFile } = await import('node:child_process');
        const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

        // resolveCliExecutable probes `where claude` via execFileAsync; success
        // selects claude as the spawn target.
        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
          const cb = args[args.length - 1];
          const cmd = args[0] as string;
          const cmdArgs = args[1] as string[];
          const key = `${cmd} ${cmdArgs.join(' ')}`;
          if (typeof cb === 'function') {
            if (key.startsWith('where claude')) {
              cb(null, { stdout: 'C:\\bin\\claude.cmd\r\n', stderr: '' });
            } else if (key.startsWith('git rev-parse --abbrev-ref HEAD')) {
              cb(null, { stdout: 'main\n', stderr: '' });
            } else {
              cb(new Error(`mock: unhandled command: ${key}`));
            }
          }
          return {} as ReturnType<typeof execFile>;
        });

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const promise = spawnClaudeSession(baseInput(), createMockContext(), {
          prompt: 'test prompt',
          sessionId: 'session-123',
          resume: false,
          supportsSwitchToInteractive: false
        });
        await flushMicrotasks();

        const [command, , spawnOpts] = vi.mocked(spawn).mock.calls[0]! as [string, string[], Record<string, unknown>];
        expect(command).toBe('claude');
        expect(spawnOpts['shell']).toBeUndefined();

        child.emit('close', 0);
        await promise;
      });

      it('fails closed naming `claude` when the CLI is absent from PATH and spawns nothing', async () => {
        vi.resetModules();
        await setupDefaultMocks();
        forcePlatform('win32');

        const { spawn, execFile } = await import('node:child_process');
        const { ClaudeCliMissingError, spawnClaudeSession } = await import('../src/lib/claude-session.js');

        // resolveCliExecutable's probe fails — no substitute binary may be
        // spawned with claude-specific flags it does not understand.
        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
          const cb = args[args.length - 1];
          const cmd = args[0] as string;
          const cmdArgs = args[1] as string[];
          const key = `${cmd} ${cmdArgs.join(' ')}`;
          if (typeof cb === 'function') {
            if (key.startsWith('where claude')) {
              cb(new Error('where: could not find claude'));
            } else if (key.startsWith('git rev-parse --abbrev-ref HEAD')) {
              cb(null, { stdout: 'main\n', stderr: '' });
            } else {
              cb(new Error(`mock: unhandled command: ${key}`));
            }
          }
          return {} as ReturnType<typeof execFile>;
        });

        await expect(
          spawnClaudeSession(baseInput(), createMockContext(), {
            prompt: 'test prompt',
            sessionId: 'session-123',
            resume: false,
            supportsSwitchToInteractive: false
          })
        ).rejects.toBeInstanceOf(ClaudeCliMissingError);

        expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      });

      it('spawns the bare CLI name with no shell on posix', async () => {
        vi.resetModules();
        await setupDefaultMocks();
        forcePlatform('linux');

        const { spawn } = await import('node:child_process');
        const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const promise = spawnClaudeSession(baseInput(), createMockContext(), {
          prompt: 'fix bug & echo OWNED',
          sessionId: 'session-123',
          resume: false,
          supportsSwitchToInteractive: false
        });
        await flushMicrotasks();

        const [command, spawnArgs, spawnOpts] = vi.mocked(spawn).mock.calls[0]! as [
          string,
          string[],
          Record<string, unknown>
        ];
        // POSIX: bare name, prompt carried verbatim. cross-spawn is a pass-through to
        // child_process.spawn on POSIX, so no `shell` option is set by the session code.
        expect(command).toBe('claude');
        expect(spawnArgs[0]).toBe('fix bug & echo OWNED');
        expect(spawnOpts['shell']).toBeUndefined();

        child.emit('close', 0);
        await promise;
      });
    });

    it('sets EXIT_WHEN_DONE=false in child env when suppressExitWhenDone is true', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false,
        suppressExitWhenDone: true
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect(spawnOpts.env.EXIT_WHEN_DONE).toBe('false');

      child.emit('close', 0);
      await promise;
    });

    it('does not override EXIT_WHEN_DONE in child env when suppressExitWhenDone is omitted', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const savedExitWhenDone = process.env['EXIT_WHEN_DONE'];
      process.env['EXIT_WHEN_DONE'] = 'true';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
        // suppressExitWhenDone deliberately omitted
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      // When suppressExitWhenDone is not set, EXIT_WHEN_DONE flows from process.env
      // — it is never explicitly overridden to 'false'.
      expect(spawnOpts.env.EXIT_WHEN_DONE).toBe('true');

      child.emit('close', 0);
      await promise;

      if (savedExitWhenDone !== undefined) {
        process.env['EXIT_WHEN_DONE'] = savedExitWhenDone;
      } else {
        delete process.env['EXIT_WHEN_DONE'];
      }
    });

    it('overrides CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS to 0 in background mode, even when the parent env has a finite value', async () => {
      // Reproduces main-678: Claude's own print-mode background-task wait
      // ceiling (600s) terminates background actions before Cards decides
      // to. Cards must own the lifetime by forcing this print-only setting
      // to unlimited (0) on every background child, regardless of what the
      // parent process env inherited.
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
      const saved = process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'];
      process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'] = '600000';

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput({ executionMode: 'background' }), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect(spawnOpts.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('0');

      child.emit('close', 0);
      await promise;

      if (saved !== undefined) {
        process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'] = saved;
      } else {
        delete process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'];
      }
    });

    it('fails the action when Claude emits its background wait-ceiling diagnostic across split stderr chunks, even though the child exits 0', async () => {
      // Reproduces main-678: the remote logs show Claude's print-mode
      // ceiling diagnostic immediately before an exit-0 "action completed"
      // log. Cards must recognize that diagnostic (latched across chunk
      // boundaries) as a failure through the same channel used elsewhere in
      // spawnClaudeSession (e.g. the settle-failure throw), rather than
      // reporting the interrupted run as a success.
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const stderr = createMockStderr();
      const child = createMockChild({ stderr: stderr as unknown as ChildProcess['stderr'] });
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput({ executionMode: 'background' }), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      // Split the diagnostic across two stderr chunks, as observed in the
      // remote logs, and never invoke onCancel — this is an unrequested
      // termination, not a Cards-initiated one.
      stderr.emit('Background tasks still running after 600s; term');
      stderr.emit('inating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.');

      child.emit('close', 0);

      await expect(promise).rejects.toThrow(/600s/);
    });

    it('completes successfully in background mode when the child exits 0 with no ceiling diagnostic on stderr', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const stderr = createMockStderr();
      const child = createMockChild({ stderr: stderr as unknown as ChildProcess['stderr'] });
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput({ executionMode: 'background' }), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      stderr.emit('some ordinary diagnostic output, unrelated to the wait ceiling');
      child.emit('close', 0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('does not fail the action on the ceiling diagnostic when Cards itself already requested cancellation', async () => {
      // Explicit Cards cancellation/shutdown retains its current outcome and
      // cleanup precedence over the diagnostic latch.
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

      const stderr = createMockStderr();
      const child = createMockChild({ stderr: stderr as unknown as ChildProcess['stderr'] });
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput({ executionMode: 'background' }), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      const onCancelHandler = vi.mocked(context.onCancel).mock.calls[0]![0] as () => Promise<void>;
      await onCancelHandler();

      stderr.emit('Background tasks still running after 600s; terminating.');
      child.emit('close', 0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('does not inject CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS in interactive mode when the parent env has no value', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnClaudeSession } = await import('../src/lib/claude-session.js');

      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
      const saved = process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'];
      delete process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'];

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnClaudeSession(baseInput(), context, {
        prompt: 'test prompt',
        sessionId: 'session-123',
        resume: false,
        supportsSwitchToInteractive: false
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS' in spawnOpts.env).toBe(false);

      child.emit('close', null);
      await promise;

      if (saved !== undefined) {
        process.env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'] = saved;
      }
    });
  });
});

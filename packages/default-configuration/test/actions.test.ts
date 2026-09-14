import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import type { BranchInfo } from '@cards.management/sdk/protocol';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises actions behavior in the test area through focused scenarios.
 * The cases lock in edge handling and regression coverage so refactors preserve expected state
 * transitions and output.
 *
 * @summary Tests actions behavior in test
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
  writeFile: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn()
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

vi.mock('@cards.management/sdk', async () => {
  const actual = await vi.importActual('@cards.management/sdk');
  const path = await import('node:path');
  return {
    ...actual,
    resolveWorktreeDir: vi.fn((repoRoot: string, ref: string) => {
      return path.join(repoRoot, '.worktrees', ref);
    })
  };
});

// Delegate the card-bound worktree orchestrator to the mocked bare primitive so
// tests can drive worktree creation without the real outfit machinery (locks,
// hook provisioning, attribution spawning). The orchestrator's contract is to
// call createWorktree(ref, { cwd, cardId, compiledScriptPaths }) and return its
// result, which is exactly what these tests assert against.
vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn(
    async (
      _client: unknown,
      ref: string,
      options: { cwd?: string; cardId: string; compiledScriptPaths: Record<string, string> }
    ) => {
      const worktree = await import('@cards.management/sdk/worktree');
      return worktree.createWorktree(ref, {
        cwd: options.cwd,
        cardId: options.cardId,
        compiledScriptPaths: options.compiledScriptPaths
      } as Parameters<typeof worktree.createWorktree>[1]);
    }
  )
}));

vi.mock('../src/lib/branch-cleanup-watcher.js', () => ({
  spawnBranchCleanupWatcher: vi.fn()
}));

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
  // Default: branches/ directory is absent so cleanupMergedBranches exits early.
  vi.mocked(fsPromises.readdir).mockRejectedValue(enoent);
  vi.mocked(fsPromises.rm).mockResolvedValue(undefined);

  // Default: worktree setup succeeds so all tests can call the action.
  // resolveBaseBranch → 'main', getBranches → [] (empty), createWorktree → default path.
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

  // Default: no existing branches → createWorktree is called
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

  const { createWorktree, checkWorktreeExists, findGitRoots } = await import('@cards.management/sdk/worktree');
  vi.mocked(findGitRoots).mockResolvedValue({ sourceRoot: '/test/workspace', repoRoot: '/test/workspace' });
  vi.mocked(checkWorktreeExists).mockResolvedValue(false);
  vi.mocked(createWorktree).mockResolvedValue({
    path: '/test/workspace/.worktrees/cards/card-123/1',
    settle: Promise.resolve({
      branch: 'cards/card-123/1',
      worktree: '/test/workspace/.worktrees/cards/card-123/1',
      baseSha: 'abc123'
    })
  });

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
    /**
     * Emits a registered child-process event for test control flow.
     *
     * @param event Event name to emit.
     * @param args Event payload arguments.
     * @returns True to match EventEmitter-style emit behavior.
     */
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
    codingAgent: 'claude-code-cli',
    ...overrides
  };
}

/**
 * Configures the fs/promises mock to serve per-branch entry files from the
 * card repo's `branches/` directory. `readdir` returns the encoded entry
 * filenames; `readFile` returns each entry's `{ name, ... }` JSON. Other
 * `readFile` paths fall back to ENOENT.
 *
 * @param branches - Branch data keyed by authoritative branch name.
 */
async function configureBranchEntries(
  branches: Record<string, { worktree?: string; parentBranch: string; addedAt: string }>
): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  const entryFiles = Object.keys(branches).map((name) => `${encodeURIComponent(name)}.json`);

  vi.mocked(readdir).mockImplementation(((dirPath: unknown) => {
    if (String(dirPath).endsWith('branches')) {
      return Promise.resolve(entryFiles);
    }
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  }) as unknown as typeof readdir);

  vi.mocked(readFile).mockImplementation((filePath: unknown) => {
    const p = String(filePath);
    // A readable, non-active status lets cleanupMergedBranches proceed past the
    // fail-closed status guard so these lifecycle tests exercise the branch loop.
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
}

describe('Default Actions', () => {
  describe('launch', () => {
    it('exports an action command', async () => {
      const action = (await import('../src/actions/launch.js')).default;
      expect(action.factoryType).toBe('action');
      expect(action.actionName).toBe('Launch');
    });

    it('spawns claude with inherited stdio in interactive mode', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--session-id', 'test-uuid-1234']),
        expect.objectContaining({ cwd: '/test/workspace/.worktrees/cards/card-123/1', stdio: 'inherit' })
      );

      // Should not include --print in interactive mode
      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).not.toContain('--print');

      // Should include --settings with inline plugin settings for the extension marketplace
      const { buildPluginSettings } = await import('../src/lib/claude-session.js');
      expect(args).toContain('--settings');
      expect(args).toContain(buildPluginSettings('/test/extension/dist/marketplace'));
      expect(args).not.toContain('--plugin-dir');

      child.emit('close', 0);
      await promise;
    });

    it('spawns claude with --print but without --output-format in background mode', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--print');
      expect(args).not.toContain('--output-format');
      expect(args).not.toContain('stream-json');

      const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { stdio: unknown };
      expect(spawnOpts.stdio).toEqual(['ignore', 'ignore', 'pipe']);

      child.emit('close', 0);
      await promise;
    });

    it('does not open a transcript stream in background mode', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (opts?.method === 'PATCH')
          return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: 'claimed' })));
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
      globalThis.fetch = fetchMock;

      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
      await flushMicrotasks();

      child.emit('close', 0);
      await promise;

      // No fetch call should target a stream endpoint
      const streamCalls = fetchMock.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('/streams/')
      );
      expect(streamCalls).toHaveLength(0);
    });

    it('captures stderr for diagnostic logging in background mode', async () => {
      const { spawn } = await import('node:child_process');
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const stderr = new EventEmitter();
      const child = {
        pid: 12345,
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          handlers.set(event, cb);
        }),
        kill: vi.fn(),
        stdout: null,
        stderr,
        emit(event: string, ...args: unknown[]) {
          handlers.get(event)?.(...args);
          return true;
        }
      } as unknown as ChildProcess;
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const context = createMockContext();
      const warnSpy = vi.spyOn(context.logger, 'warn');
      const promise = action(baseInput({ executionMode: 'background' }), context);
      await flushMicrotasks();

      stderr.emit('data', Buffer.from('something went wrong'));

      child.emit('close', 1);
      await promise;

      expect(warnSpy).toHaveBeenCalledWith('something went wrong');
    });

    it('registers onCancel that terminates the owned process tree', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const context = createMockContext();
      const promise = action(baseInput(), context);
      await flushMicrotasks();

      expect(context.onCancel).toHaveBeenCalledWith(expect.any(Function));

      // Invoke the registered cancel callback
      const cancelCallback = vi.mocked(context.onCancel).mock.calls[0][0] as () => Promise<void>;
      await expect(cancelCallback()).resolves.toBeUndefined();

      child.emit('close', null);
      await promise;
    });

    it('registers onSwitchToInteractive that returns session ID', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const context = createMockContext();
      const promise = action(baseInput(), context);
      await flushMicrotasks();

      expect(context.onSwitchToInteractive).toHaveBeenCalledWith(expect.any(Function));

      // Invoke the registered callback and verify it returns the session ID
      const switchCallback = vi.mocked(context.onSwitchToInteractive).mock.calls[0][0] as () => unknown;
      const result = switchCallback();
      expect(result).toEqual({ sessionId: 'test-uuid-1234' });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      child.emit('close', null);
      await promise;
    });

    it('resumes session from switchToInteractiveData', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      const promise = action(
        baseInput({ switchToInteractiveData: { sessionId: 'existing-session-456' } }),
        createMockContext()
      );
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--resume');
      expect(args).toContain('existing-session-456');
      expect(args).not.toContain('--session-id');

      child.emit('close', 0);
      await promise;
    });

    it('resolves only after child process exits', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/launch.js')).default;
      let resolved = false;
      const promise = action(baseInput(), createMockContext()).then(() => {
        resolved = true;
      });

      // Flush microtasks so worktree setup completes and spawn is called
      await flushMicrotasks();

      // Should not resolve before close event
      await Promise.resolve();
      expect(resolved).toBe(false);

      child.emit('close', 0);
      await promise;
      expect(resolved).toBe(true);
    });

    describe('worktree lifecycle', () => {
      /**
       * Configures execFile mock to handle specific git commands.
       * Commands not matched fall through to a default error callback.
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
            // Match against registered handlers by prefix
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
          if (typeof url === 'string' && url.includes('/branches') && opts?.method === 'DELETE') {
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          // Fallback for stream endpoints
          return Promise.resolve(
            new Response(
              JSON.stringify({
                filename: 'test.jsonl',
                streamType: 'claude-code-session',
                lineCount: 0,
                status: 'completed'
              }),
              { status: 200 }
            )
          );
        });
      }

      it('throws when resolveBaseBranch fails', async () => {
        const { execFile } = await import('node:child_process');
        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') cb(new Error('not a git repo'));
          return {} as ReturnType<typeof execFile>;
        });

        const action = (await import('../src/actions/launch.js')).default;
        await expect(action(baseInput(), createMockContext())).rejects.toThrow('not a git repo');
      });

      it('creates a new worktree when no branches exist', async () => {
        const { spawn } = await import('node:child_process');
        const { createWorktree } = await import('@cards.management/sdk/worktree');

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
        });

        configureBranchesResponse([]);

        vi.mocked(createWorktree).mockResolvedValue({
          path: '/test/workspace/.worktrees/cards/card-123/1',
          settle: Promise.resolve({
            branch: 'cards/card-123/1',
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            baseSha: 'abc123'
          })
        });

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput(), createMockContext());
        await flushMicrotasks();

        expect(createWorktree).toHaveBeenCalledWith('cards/card-123/1', {
          cwd: '/test/workspace',
          cardId: 'card-123',
          compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
        });

        const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { cwd: string };
        expect(spawnOpts.cwd).toBe('/test/workspace/.worktrees/cards/card-123/1');

        child.emit('close', 0);
        await promise;
      });

      it('reuses existing worktree when branch exists on disk', async () => {
        const { spawn } = await import('node:child_process');
        const { access } = await import('node:fs/promises');
        const { createWorktree } = await import('@cards.management/sdk/worktree');

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
        });

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

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput(), createMockContext());
        await flushMicrotasks();

        // Should NOT create a new worktree
        expect(createWorktree).not.toHaveBeenCalled();

        const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { cwd: string };
        expect(spawnOpts.cwd).toBe('/test/workspace/.worktrees/cards/card-123/1');

        child.emit('close', 0);
        await promise;
      });

      it('sets BASE_BRANCH, PARENT_BRANCH, and WORKSPACE_PATH env vars when worktree succeeds', async () => {
        const { spawn } = await import('node:child_process');
        const { access } = await import('node:fs/promises');

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
        });

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

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput(), createMockContext());
        await flushMicrotasks();

        const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { env: Record<string, string> };
        expect(spawnOpts.env.BASE_BRANCH).toBe('main');
        expect(spawnOpts.env.PARENT_BRANCH).toBe('main');
        expect(spawnOpts.env.WORKSPACE_PATH).toBe('/test/workspace/.worktrees/cards/card-123/1');

        child.emit('close', 0);
        await promise;
      });

      it('computes next branch number from existing branches', async () => {
        const { spawn } = await import('node:child_process');
        const { createWorktree } = await import('@cards.management/sdk/worktree');

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
        });

        // Existing branch exists=false (no worktree on disk), so must create new
        configureBranchesResponse([
          {
            name: 'cards/card-123/1',
            worktree: '/old/path',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z',
            exists: false
          },
          {
            name: 'cards/card-123/3',
            worktree: '/old/path2',
            parentBranch: 'main',
            addedAt: '2025-01-02T00:00:00Z',
            exists: false
          }
        ]);

        vi.mocked(createWorktree).mockResolvedValue({
          path: '/test/workspace/.worktrees/cards/card-123/4',
          settle: Promise.resolve({
            branch: 'cards/card-123/4',
            worktree: '/test/workspace/.worktrees/cards/card-123/4',
            baseSha: 'abc123'
          })
        });

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput(), createMockContext());
        await flushMicrotasks();

        // Should pick max(1,3)+1 = 4
        expect(createWorktree).toHaveBeenCalledWith('cards/card-123/4', {
          cwd: '/test/workspace',
          cardId: 'card-123',
          compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
        });

        child.emit('close', 0);
        await promise;
      });

      it('spawns branch-cleanup watcher in interactive mode', async () => {
        const { spawn } = await import('node:child_process');
        const { access } = await import('node:fs/promises');

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
        });

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

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput(), createMockContext());
        await flushMicrotasks();

        child.emit('close', 0);
        await promise;

        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
        expect(spawnBranchCleanupWatcher).toHaveBeenCalledWith(
          {
            cardId: 'card-123',
            repoRoot: '/test/workspace',
            cardRepoPath: '/test/repo',
            sessionId: 'test-uuid-1234'
          },
          expect.anything()
        );
      });

      it('cleans up fully-merged branches in background mode', async () => {
        const { spawn, execFile } = await import('node:child_process');
        const { access } = await import('node:fs/promises');

        await configureBranchEntries({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });

        const mergeBaseKey = 'git merge-base --is-ancestor cards/card-123/1 main';
        const worktreeRemoveKey = 'git worktree remove';
        const branchDeleteKey = 'git branch -d cards/card-123/1';

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
          'git branch --list': { stdout: '  cards/card-123/1\n' },
          [mergeBaseKey]: { stdout: '' },
          [worktreeRemoveKey]: { stdout: '' },
          [branchDeleteKey]: { stdout: '' },
          'git rm': { stdout: '' },
          'git commit': { stdout: '' }
        });

        globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
          if (opts?.method === 'PATCH')
            return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: 'revision-claimed' })));
          if (typeof url === 'string' && url.includes('/branches')) {
            if (!opts?.method || opts.method === 'GET') {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    branches: [{ name: 'cards/card-123/1', revision: 'cleanup-ready' }],
                    commits: [],
                    defaultBranch: 'main'
                  }),
                  { status: 200 }
                )
              );
            }
            if (opts?.method === 'DELETE') return Promise.resolve(new Response(JSON.stringify({ outcome: 'removed' })));
            if (opts?.method === 'POST') {
              return Promise.resolve(new Response(JSON.stringify({}), { status: 201 }));
            }
          }
          return Promise.resolve(
            new Response(JSON.stringify({ status: 'completed', lineCount: 0, filename: 'x' }), {
              status: 200
            })
          );
        });

        vi.mocked(access).mockResolvedValue(undefined);

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
        await flushMicrotasks();

        child.emit('close', 0);
        await promise;

        // Verify cleanup was attempted: worktree remove and branch delete
        const execCalls = vi.mocked(execFile).mock.calls;
        const worktreeRemoveCall = execCalls.find(
          (c) => (c[1] as string[])?.includes('worktree') && (c[1] as string[])?.includes('remove')
        );
        expect(worktreeRemoveCall).toBeDefined();

        const branchDeleteCall = execCalls.find(
          (c) => (c[1] as string[])?.includes('branch') && (c[1] as string[])?.includes('-d')
        );
        expect(branchDeleteCall).toBeDefined();

        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
        expect(spawnBranchCleanupWatcher).not.toHaveBeenCalled();
      });

      it('skips cleanup for unmerged branches in background mode', async () => {
        const { spawn, execFile } = await import('node:child_process');
        const { access } = await import('node:fs/promises');

        await configureBranchEntries({
          'cards/card-123/1': {
            worktree: '/test/workspace/.worktrees/cards/card-123/1',
            parentBranch: 'main',
            addedAt: '2025-01-01T00:00:00Z'
          }
        });

        const handlers: Record<string, { stdout: string }> = {
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
          'git branch --list': { stdout: '  cards/card-123/1\n' }
        };

        vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
          const cb = args[args.length - 1];
          const cmd = args[0] as string;
          const cmdArgs = args[1] as string[];
          const key = `${cmd} ${cmdArgs.join(' ')}`;

          if (typeof cb === 'function') {
            if (key.includes('merge-base --is-ancestor')) {
              cb(new Error('exit code 1'));
              return {} as ReturnType<typeof execFile>;
            }
            for (const [pattern, result] of Object.entries(handlers)) {
              if (key.startsWith(pattern) || key.includes(pattern)) {
                cb(null, { stdout: result.stdout, stderr: '' });
                return {} as ReturnType<typeof execFile>;
              }
            }
            cb(new Error(`mock: unhandled command: ${key}`));
          }
          return {} as ReturnType<typeof execFile>;
        });

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

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
        await flushMicrotasks();

        child.emit('close', 0);
        await promise;

        // Verify NO worktree remove or branch delete was called
        const execCalls = vi.mocked(execFile).mock.calls;
        const worktreeRemoveCall = execCalls.find(
          (c) => (c[1] as string[])?.includes('worktree') && (c[1] as string[])?.includes('remove')
        );
        expect(worktreeRemoveCall).toBeUndefined();

        const branchDeleteCall = execCalls.find(
          (c) => (c[1] as string[])?.includes('branch') && (c[1] as string[])?.includes('-d')
        );
        expect(branchDeleteCall).toBeUndefined();
      });

      it('reattaches existing branch when worktree path is missing from disk', async () => {
        const { spawn } = await import('node:child_process');
        const { access } = await import('node:fs/promises');
        const { createWorktree } = await import('@cards.management/sdk/worktree');

        await configureExecFile({
          'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' }
        });

        configureBranchesResponse([
          {
            name: 'cards/card-123/1',
            worktree: '/nonexistent/worktree/path',
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
            baseSha: 'abc123'
          })
        });

        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput(), createMockContext());
        await flushMicrotasks();

        // Should reattach the existing branch, not create a new one
        expect(createWorktree).toHaveBeenCalledWith('cards/card-123/1', {
          cwd: '/test/workspace',
          cardId: 'card-123',
          compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
        });

        const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { cwd: string };
        expect(spawnOpts.cwd).toBe('/test/workspace/.worktrees/cards/card-123/1');

        child.emit('close', 0);
        await promise;
      });

      it('throws when createWorktree fails', async () => {
        const { createWorktree } = await import('@cards.management/sdk/worktree');
        vi.mocked(createWorktree).mockRejectedValue(new Error('disk full'));

        const action = (await import('../src/actions/launch.js')).default;
        await expect(action(baseInput(), createMockContext())).rejects.toThrow('disk full');
      });
    });

    describe('agent routing', () => {
      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['claude-code-extension', 'claude-code-extension']
      ])('resolves %s to Claude branch and spawns claude', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/launch.js')).default;
        const promise = action(baseInput({ codingAgent }), createMockContext());
        await flushMicrotasks();

        const spawnCmd = vi.mocked(spawn).mock.calls[0][0] as string;
        expect(spawnCmd).toBe('claude');

        child.emit('close', 0);
        await promise;
      });

      it.each([
        ['codex (pre-rename sentinel)', 'codex'],
        ['gemini-cli (removed harness)', 'gemini-cli'],
        ['claude (agent id not env value)', 'claude'],
        ['CLAUDE-CODE-CLI (wrong case)', 'CLAUDE-CODE-CLI']
      ])('rejects %s with a cards.defaultCodingAgent error and does not spawn', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');

        const action = (await import('../src/actions/launch.js')).default;
        await expect(action(baseInput({ codingAgent }), createMockContext())).rejects.toThrow(
          /cards\.defaultCodingAgent.*is not a supported value/
        );

        expect(spawn).not.toHaveBeenCalled();
      });
    });
  });

  describe('captain', () => {
    it('exports an action command', async () => {
      const action = (await import('../src/actions/captain.js')).default;
      expect(action.factoryType).toBe('action');
      expect(action.actionName).toBe('Captain');
    });

    it('spawns claude with inherited stdio in interactive mode', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/captain.js')).default;
      const promise = action(baseInput({ actionName: 'Captain' }), createMockContext());
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--session-id', 'test-uuid-1234']),
        expect.objectContaining({ cwd: '/test/workspace/.worktrees/cards/card-123/1', stdio: 'inherit' })
      );

      child.emit('close', 0);
      await promise;
    });

    describe('agent routing', () => {
      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['claude-code-extension', 'claude-code-extension']
      ])('resolves %s to Claude branch and spawns claude', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/captain.js')).default;
        const promise = action(baseInput({ codingAgent, actionName: 'Captain' }), createMockContext());
        await flushMicrotasks();

        const spawnCmd = vi.mocked(spawn).mock.calls[0]![0] as string;
        expect(spawnCmd).toBe('claude');

        child.emit('close', 0);
        await promise;
      });

      it.each([
        ['codex (pre-rename sentinel)', 'codex'],
        ['gemini-cli (removed harness)', 'gemini-cli'],
        ['claude (agent id not env value)', 'claude'],
        ['CLAUDE-CODE-CLI (wrong case)', 'CLAUDE-CODE-CLI']
      ])('rejects %s with a cards.defaultCodingAgent error and does not spawn', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');

        const action = (await import('../src/actions/captain.js')).default;
        await expect(action(baseInput({ codingAgent, actionName: 'Captain' }), createMockContext())).rejects.toThrow(
          /cards\.defaultCodingAgent.*is not a supported value/
        );

        expect(spawn).not.toHaveBeenCalled();
      });
    });
  });

  describe('chat', () => {
    describe('agent routing', () => {
      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['claude-code-extension', 'claude-code-extension']
      ])('resolves %s to Claude branch and spawns claude', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/chat.js')).default;
        const promise = action(baseInput({ codingAgent, actionName: 'Chat' }), createMockContext());
        await flushMicrotasks();

        const spawnCmd = vi.mocked(spawn).mock.calls[0][0] as string;
        expect(spawnCmd).toBe('claude');

        child.emit('close', 0);
        await promise;
      });

      it.each([
        ['codex (pre-rename sentinel)', 'codex'],
        ['gemini-cli (removed harness)', 'gemini-cli'],
        ['claude (agent id not env value)', 'claude'],
        ['CLAUDE-CODE-CLI (wrong case)', 'CLAUDE-CODE-CLI']
      ])('rejects %s with a cards.defaultCodingAgent error and does not spawn', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');

        const action = (await import('../src/actions/chat.js')).default;
        await expect(action(baseInput({ codingAgent, actionName: 'Chat' }), createMockContext())).rejects.toThrow(
          /cards\.defaultCodingAgent.*is not a supported value/
        );

        expect(spawn).not.toHaveBeenCalled();
      });
    });
  });
});

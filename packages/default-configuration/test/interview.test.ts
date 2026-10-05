import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the interview action behavior through focused scenarios.
 * The cases lock in edge handling and regression coverage so refactors preserve
 * expected state transitions and output.
 *
 * @summary Tests interview action behavior
 */

vi.mock('../src/lib/worktrees/index.js', async () => ({
  openSlotSession: (await import('./helpers/slot-session-stub.js')).openSlotSessionStub
}));

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

const originalFetch = globalThis.fetch;

/**
 * Compiled-hook .mjs paths createWorktree() must be called with, derived from
 * the test ActionInput's extensionPath (`/test/extension`). Built with
 * path.join so the expectation matches production's `\`-separated paths on
 * Windows.
 */
const _EXPECTED_COMPILED_SCRIPT_PATHS = {
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
    if (opts?.method === 'PATCH' && typeof url === 'string' && url.includes('/branches'))
      throw new Error('Provider branch-owner mutation is retired; use admitted assignment');
    if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            branches: [{ name: 'cards/card-123/1', parentBranch: 'main', addedAt: '2026-10-01T00:00:00.000Z' }],
            invalidEntries: [],
            commits: [],
            defaultBranch: 'main'
          }),
          { status: 200 }
        )
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
    logger: new Logger(),
    cwd: process.cwd(),
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
    cardId: 'card-123',
    actionName: 'Interview',
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
 * filenames; `readFile` returns each entry's `{ name, ... }` JSON.
 *
 * @param branches - Branch data keyed by authoritative branch name.
 */
async function _configureBranchEntries(
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
  describe('interview', () => {
    it('exports action command with correct metadata', async () => {
      const action = (await import('../src/actions/interview.js')).default;
      expect(action.factoryType).toBe('action');
      expect(action.actionName).toBe('Interview');
    });

    it('spawns claude with stdio: inherit', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { stdio: unknown };
      expect(spawnOpts.stdio).toBe('inherit');

      child.emit('close', 0);
      await promise;
    });

    it('passes skill-load instruction as prompt', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args[0]).toBe('Load the `runtime:interview` skill and follow the `<routing-instructions>`.');

      child.emit('close', 0);
      await promise;
    });

    it('does not include --print', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).not.toContain('--print');

      child.emit('close', 0);
      await promise;
    });

    it('includes --settings with inline plugin settings for the extension marketplace', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const { buildPluginSettings } = await import('../src/lib/claude-session.js');
      expect(args).toContain('--settings');
      expect(args).toContain(buildPluginSettings('/test/extension/dist/marketplace'));
      expect(args).not.toContain('--plugin-dir');

      child.emit('close', 0);
      await promise;
    });

    it('includes --add-dir with card repo path', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const addDirIdx = args.indexOf('--add-dir');
      expect(addDirIdx).toBeGreaterThan(-1);
      expect(args[addDirIdx + 1]).toBe('/test/repo');

      child.emit('close', 0);
      await promise;
    });

    it('sets env vars', async () => {
      const { spawn } = await import('node:child_process');
      const { access } = await import('node:fs/promises');

      const { execFile } = await import('node:child_process');
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

      globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (opts?.method === 'PATCH' && typeof url === 'string' && url.includes('/branches'))
          throw new Error('Provider branch-owner mutation is retired; use admitted assignment');
        if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                branches: [
                  {
                    name: 'cards/card-123/1',
                    worktree: '/test/workspace/.worktrees/cards/card-123/1',
                    parentBranch: 'main',
                    addedAt: '2025-01-01T00:00:00Z',
                    exists: true
                  }
                ]
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      });

      vi.mocked(access).mockResolvedValue(undefined);

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const promise = action(baseInput(), createMockContext());
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.WORKSPACE_PATH).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(spawnOpts.env.CLAUDE_CODE_TASK_LIST_ID).toBe('cards-extension-card-123');
      expect(spawnOpts.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
      expect(spawnOpts.env.BASE_BRANCH).toBe('main');
      expect(spawnOpts.env.PARENT_BRANCH).toBe('main');
      expect(spawnOpts.env.WORKSPACE_BRANCH).toBe('cards/card-123/1');

      child.emit('close', 0);
      await promise;
    });

    it('registers onCancel that terminates the owned process tree', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
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

    it('does NOT register onSwitchToInteractive', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      const context = createMockContext();
      const promise = action(baseInput(), context);
      await flushMicrotasks();

      expect(context.onSwitchToInteractive).not.toHaveBeenCalled();

      child.emit('close', 0);
      await promise;
    });

    it('always generates fresh session ID', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
      // Pass switchToInteractiveData to verify it is ignored
      const promise = action(
        baseInput({ switchToInteractiveData: { sessionId: 'existing-session-456' } }),
        createMockContext()
      );
      await flushMicrotasks();

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      // Should use randomUUID result, not the existing session ID
      expect(args).toContain('--session-id');
      expect(args).toContain('test-uuid-1234');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('existing-session-456');

      child.emit('close', 0);
      await promise;
    });

    it('resolves only after child process exits', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const action = (await import('../src/actions/interview.js')).default;
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

    describe('agent routing', () => {
      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['claude-code-extension', 'claude-code-extension']
      ])('resolves %s to Claude branch and spawns claude', async (_label, codingAgent) => {
        const { spawn } = await import('node:child_process');
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const action = (await import('../src/actions/interview.js')).default;
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

        const action = (await import('../src/actions/interview.js')).default;
        await expect(action(baseInput({ codingAgent }), createMockContext())).rejects.toThrow(
          /cards\.defaultCodingAgent.*is not a supported value/
        );

        expect(spawn).not.toHaveBeenCalled();
      });
    });
  });
});

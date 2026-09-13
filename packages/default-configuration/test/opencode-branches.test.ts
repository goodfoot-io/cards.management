/**
 * Exercises OpenCode branches of the consolidated action handlers (launch,
 * chat, interview, captain) through end-to-end scenarios. Locks in the
 * pre-spawn binary probe, plugin-cache population, staged-config writing,
 * spawn argv (interactive TUI via `--prompt`, background headless run), error paths,
 * cancellation, and branch-cleanup wiring for the OpenCode path.
 *
 * @summary Tests OpenCode branches of consolidated action handlers
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Production code builds paths with node:path, so on Windows the values passed
 * to fs mocks use backslash separators. Normalize to forward slashes so the
 * POSIX-keyed mock lookups and matchers below match regardless of platform.
 *
 * @param p - Path-like value (string, Buffer, or URL) to normalize.
 * @returns The value stringified with backslashes converted to forward slashes.
 */
function toPosix(p: unknown): string {
  return String(p).replace(/\\/g, '/');
}

/**
 * The default OpenCode config dir, resolved exactly as production's
 * `resolveDefaultOpencodeConfigDir` does ($XDG_CONFIG_HOME ?? ~/.config +
 * /opencode). XDG_CONFIG_HOME is deleted in beforeEach.
 */
const DEFAULT_OPENCODE_CONFIG_DIR = join(homedir(), '.config', 'opencode');
/** The Cards staging dir holding the per-set config documents. */
const CARDS_OPENCODE_STAGING_DIR = join(homedir(), '.cards', 'opencode');
const WORKTREE_PATH = '/test/workspace/.worktrees/cards/card-123/1';

vi.mock('../src/lib/opencode-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/opencode-termination.js')>();
  const { createSyntheticProcessTreeAuthority } = await import('./helpers/process-tree-authority.js');
  return {
    ...actual,
    createOpencodeTerminationController: (
      child: Parameters<typeof actual.createOpencodeTerminationController>[0],
      options: Parameters<typeof actual.createOpencodeTerminationController>[1]
    ) =>
      actual.createOpencodeTerminationController(child, {
        ...options,
        authority: createSyntheticProcessTreeAuthority()
      })
  };
});

vi.mock('cross-spawn', async () => {
  // spawnAgentCli routes the agent launch through cross-spawn; forward it to the
  // mocked node:child_process.spawn so spawn('opencode', ...) assertions hold on
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

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['API_TEST_MODE'] = '1';
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['CARDS_HOME'];
  delete process.env['EXIT_WHEN_DONE'];

  const { execFile, execFileSync } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const syncFs = await import('node:fs');

  // Git commands + the `which opencode` pre-spawn probe.
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    const cmd = args[0] as string;
    const cmdArgs = args[1] as string[];
    const key = `${cmd} ${cmdArgs.join(' ')}`;

    if (typeof cb === 'function') {
      if (key.startsWith('git rev-parse --abbrev-ref HEAD')) {
        cb(null, { stdout: 'main\n', stderr: '' });
      } else if (key === `${process.platform === 'win32' ? 'where' : 'which'} opencode`) {
        cb(null, { stdout: '/usr/bin/opencode\n', stderr: '' });
      } else {
        cb(new Error(`mock: unhandled command: ${key}`));
      }
    }

    return {} as ReturnType<typeof execFile>;
  });
  vi.mocked(execFileSync).mockImplementation(() => '');

  // Card-repo AGENTS.md for the opening-turn composition.
  vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
    if (toPosix(filePath) === '/test/repo/AGENTS.md') {
      return '# Card Repository Reference\n\nEach card is an isolated Git repository.\n';
    }
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

  vi.mocked(fs.access).mockResolvedValue(undefined);
  // Tiered package.json manifest service: source bundle paths carry the plugin
  // name segment; staged copies (.plugin-install-*) carry none and are served
  // in install order (cards first, then runtime); published slots end
  // <plugin>/<version>/package.json.
  let stagedReadIndex = 0;
  vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
    const p = toPosix(filePath);
    if (p.endsWith('.cards-content-hash')) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    if (p.endsWith('/package.json')) {
      if (p.includes('.plugin-install-')) {
        const name = ['cards', 'runtime'][stagedReadIndex++];
        if (name === undefined) {
          throw new Error(`Unexpected staged manifest read: ${p}`);
        }
        return JSON.stringify({ name: `cards-opencode-${name}`, version: '1.0.0' });
      }
      const published = /\/(cards|runtime|cards-assistant)\/[^/]+\/package\.json$/.exec(p);
      if (published !== null) {
        return JSON.stringify({ name: `cards-opencode-${published[1]}`, version: '1.0.0' });
      }
      const source = /\/(cards|runtime|cards-assistant)\/package\.json$/.exec(p);
      if (source !== null) {
        return JSON.stringify({ name: `cards-opencode-${source[1]}`, version: '1.0.0' });
      }
    }
    throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
  });
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: string | URL) => `${String(prefix)}XXXXXX`);
  vi.mocked(fs.cp).mockResolvedValue(undefined);
  vi.mocked(fs.rename).mockResolvedValue(undefined);
  vi.mocked(fs.rm).mockResolvedValue(undefined);
  // Empty listings: content-hash walks see no files; prune finds no siblings;
  // the staged config lists no hook modules beyond the fixtures above.
  vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
  vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
    onAgentShutdown: vi.fn(),
    onSwitchToInteractive: vi.fn()
  };
}

function createMockChild(): ChildProcess {
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
    codingAgent: 'opencode-cli',
    ...overrides
  };
}

describe('resolveCodingAgent — opencode', () => {
  it('resolves opencode-cli to itself', async () => {
    const { resolveCodingAgent } = await import('../src/lib/coding-agent.js');

    expect(resolveCodingAgent({ codingAgent: 'opencode-cli' })).toBe('opencode-cli');
  });

  it('lists all four supported values in the unsupported-value error', async () => {
    const { resolveCodingAgent } = await import('../src/lib/coding-agent.js');

    expect(() => resolveCodingAgent({ codingAgent: 'cursor-cli' })).toThrow(
      /'claude-code-cli', 'codex-cli', 'opencode-cli', or 'antigravity-cli'/
    );
  });
});

describe('launch action — opencode branch', () => {
  it('stages the cache and spawns opencode run with worktree argv and staged config env', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    // Bundled plugins are staged into the cache below the user's OpenCode
    // config dir (never the config dir root, never their own files).
    const cpDests = vi.mocked(fs.cp).mock.calls.map((call) => toPosix(call[1]));
    expect(cpDests.length).toBeGreaterThan(0);
    expect(
      cpDests.every((dest) => dest.startsWith(`${toPosix(DEFAULT_OPENCODE_CONFIG_DIR)}/plugins/cache/cards/`))
    ).toBe(true);
    const renameDests = vi.mocked(fs.rename).mock.calls.map((call) => toPosix(call[1]));
    expect(renameDests).toContain(toPosix(`${DEFAULT_OPENCODE_CONFIG_DIR}/plugins/cache/cards/cards/1.0.0`));
    expect(renameDests).toContain(toPosix(`${DEFAULT_OPENCODE_CONFIG_DIR}/plugins/cache/cards/runtime/1.0.0`));

    expect(vi.mocked(spawn).mock.calls).toHaveLength(1);
    expect(vi.mocked(spawn).mock.calls[0]![0]).toBe('/usr/bin/opencode');

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[0]).toBe('--prompt');
    expect(args[2]).toBe(WORKTREE_PATH);
    // The card-repo AGENTS.md leads the composed opening turn; the caller
    // prompt closes it.
    const openingTurn = args[1]!;
    expect(openingTurn).toContain('# Card Repository Reference');
    expect(openingTurn.endsWith('Load the `card` skill and follow the `<routing-instructions>`.')).toBe(true);

    const opts = vi.mocked(spawn).mock.calls[0]![2] as {
      cwd: string;
      stdio: string;
      env: Record<string, string | undefined>;
    };
    expect(opts.cwd).toBe(WORKTREE_PATH);
    expect(opts.stdio).toBe('inherit');
    expect(opts.env.WORKSPACE_PATH).toBe(WORKTREE_PATH);
    expect(opts.env.BASE_BRANCH).toBe('main');
    expect(opts.env.PARENT_BRANCH).toBe('main');
    expect(opts.env.WORKSPACE_BRANCH).toBe('cards/card-123/1');
    // Staged activation goes through OPENCODE_CONFIG pointing into the Cards
    // staging dir — never CODEX_HOME-style replacement of the config dir.
    const stagedConfig = String(opts.env.OPENCODE_CONFIG);
    expect(stagedConfig.startsWith(`${toPosix(CARDS_OPENCODE_STAGING_DIR)}/`)).toBe(true);
    expect(stagedConfig.endsWith('cards-launch.config.json')).toBe(true);
    // No enablement document is ever written into the user's config dir.
    const writeTargets = vi.mocked(fs.writeFile).mock.calls.map((call) => toPosix(call[0]));
    expect(
      writeTargets.some(
        (target) => target.startsWith(`${toPosix(DEFAULT_OPENCODE_CONFIG_DIR)}/`) && target.includes('.config.json')
      )
    ).toBe(false);

    child.emit('close', 0);
    await promise;

    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).toHaveBeenCalledWith(
      { cardId: 'card-123', repoRoot: '/test/workspace', cardRepoPath: '/test/repo' },
      expect.anything()
    );
  });

  it('registers onCancel that terminates the owned process tree', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    // Termination now goes through createOpencodeTerminationController, which
    // signals the launcher-owned process group (-pid) rather than calling
    // child.kill directly — see opencode-termination.ts. The group "exits"
    // (ESRCH on the existence probe) as soon as SIGTERM is sent, simulating a
    // cooperative child.
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

    const onCancel = vi.mocked(context.onCancel).mock.calls[0][0] as () => Promise<void>;
    await onCancel();
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    child.emit('close', 0);
    await promise;

    killSpy.mockRestore();
  });

  it('fails closed before spawning when the opencode binary is absent', async () => {
    const { execFile, spawn } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        cb(new Error('not found'));
      }
      return {} as ReturnType<typeof execFile>;
    });

    const action = (await import('../src/actions/launch.js')).default;

    await expect(action(baseInput(), createMockContext())).rejects.toThrow(/opencode/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('chat action — opencode branch', () => {
  it('spawns opencode chat with the routing skill as the single positional turn', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/chat.js')).default;
    const promise = action(baseInput({ actionName: 'Chat' }), createMockContext());
    await flushMicrotasks();

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('/usr/bin/opencode');
    const args = calls[0]![1] as string[];
    expect(args[0]).toBe('--prompt');
    expect(args[2]).toBe(WORKTREE_PATH);
    // Chat passes no guidance prompt — the composed turn carries only the
    // card-repo AGENTS.md plus the chat-routing skill.
    expect(args).toHaveLength(3);
    expect(args[1]).toContain('Route only — evaluate, select, and load');
    expect(args[1]).toContain('Each card is an isolated Git repository.');

    const opts = calls[0]![2] as { env: Record<string, string | undefined> };
    expect(opts.env.EXIT_WHEN_DONE).toBe('false');
    expect(String(opts.env.OPENCODE_CONFIG)).toMatch(/launch\.config\.json$/);

    child.emit('close', 0);
    await promise;
  });
});

describe('interview action — opencode branch', () => {
  it('spawns opencode with a short prompt referencing the interview skill', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/interview.js')).default;
    const promise = action(baseInput({ actionName: 'Interview' }), createMockContext());
    await flushMicrotasks();

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls).toHaveLength(1);
    const args = calls[0]![1] as string[];
    expect(args[0]).toBe('--prompt');
    expect(args[2]).toBe(WORKTREE_PATH);
    const openingTurn = args[1]!;
    expect(openingTurn.endsWith('Load the `interview` skill and follow the `<routing-instructions>`.')).toBe(true);

    const opts = calls[0]![2] as { env: Record<string, string | undefined> };
    expect(opts.env.EXIT_WHEN_DONE).toBe('false');

    child.emit('close', 0);
    await promise;
  });
});

describe('captain action — opencode branch', () => {
  it('spawns opencode with a short prompt referencing the captain skill', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/captain.js')).default;
    const promise = action(baseInput({ actionName: 'Captain' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[0]).toBe('--prompt');
    expect(args[2]).toBe(WORKTREE_PATH);
    expect(args[1]).toMatch(/Load the `captain` skill and follow the `<routing-instructions>`\.$/);

    child.emit('close', 0);
    await promise;
  });
});

describe('opencode branch — background-mode dispatch', () => {
  it('launch spawns the headless one-shot run with piped stdio and staged config env', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('/usr/bin/opencode');

    const args = calls[0]![1] as string[];
    expect(args.slice(0, 5)).toEqual(['run', '--dir', WORKTREE_PATH, '--title', 'card-123']);
    const openingTurn = args[5]!;
    expect(openingTurn).toContain('# Card Repository Reference');
    expect(openingTurn.endsWith('Load the `card` skill and follow the `<routing-instructions>`.')).toBe(true);

    const opts = calls[0]![2] as {
      cwd: string;
      stdio: unknown;
      env: Record<string, string | undefined>;
    };
    // Background handlers are console-less: stdout/stdin ignored, stderr piped
    // for diagnostic capture.
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(opts.cwd).toBe(WORKTREE_PATH);
    expect(String(opts.env.OPENCODE_CONFIG)).toMatch(/cards-launch\.config\.json$/);
    expect(opts.env.WORKSPACE_BRANCH).toBe('cards/card-123/1');

    child.emit('close', 0);
    await promise;
  });

  it('captain spawns the headless one-shot run with the captain routing skill', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/captain.js')).default;
    const promise = action(baseInput({ actionName: 'Captain', executionMode: 'background' }), createMockContext());
    await flushMicrotasks();

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('/usr/bin/opencode');

    const args = calls[0]![1] as string[];
    expect(args.slice(0, 5)).toEqual(['run', '--dir', WORKTREE_PATH, '--title', 'card-123']);
    expect(args[5]).toMatch(/Load the `captain` skill and follow the `<routing-instructions>`\.$/);

    child.emit('close', 0);
    await promise;
  });

  it('captures piped stderr into the logger in background mode', async () => {
    const { spawn } = await import('node:child_process');
    const stderr = new EventEmitter();
    const child = {
      pid: 12345,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        (child as unknown as Record<string, unknown>)[`_${event}`] = cb;
      }),
      kill: vi.fn(),
      stdout: null,
      stderr,
      emit(event: string, ...args: unknown[]) {
        ((child as unknown as Record<string, unknown>)[`_${event}`] as ((...a: unknown[]) => void) | undefined)?.(
          ...args
        );
        return true;
      }
    } as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const context = createMockContext();
    const warnSpy = vi.spyOn(context.logger, 'warn');
    const promise = action(baseInput({ executionMode: 'background' }), context);
    await flushMicrotasks();

    stderr.emit('data', Buffer.from('headless diagnostics'));

    child.emit('close', 1);
    await promise;

    expect(warnSpy).toHaveBeenCalledWith('headless diagnostics');
  });

  it('runs post-exit branch cleanup inline without spawning the detached watcher', async () => {
    const { execFile, spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');

    const entryFile = `${encodeURIComponent('cards/card-123/1')}.json`;
    // Superset of the beforeEach tiered manifest mock, extended with the card
    // status and branch-entry reads that inline cleanupMergedBranches performs.
    let stagedReadIndex = 0;
    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = toPosix(filePath);
      if (p.endsWith('.cards-content-hash')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      // A readable, non-active status passes cleanupMergedBranches' fail-closed
      // status guard so this test exercises the branch loop.
      if (p.endsWith('CARD.meta.json')) {
        return JSON.stringify({ status: 'needs_review' });
      }
      if (p.endsWith(`/branches/${entryFile}`)) {
        return JSON.stringify({
          name: 'cards/card-123/1',
          worktree: WORKTREE_PATH,
          parentBranch: 'main',
          addedAt: '2025-01-01T00:00:00Z'
        });
      }
      if (p.endsWith('/package.json')) {
        if (p.includes('.plugin-install-')) {
          const name = ['cards', 'runtime'][stagedReadIndex++];
          if (name === undefined) {
            throw new Error(`Unexpected staged manifest read: ${p}`);
          }
          return JSON.stringify({ name: `cards-opencode-${name}`, version: '1.0.0' });
        }
        const published = /\/(cards|runtime|cards-assistant)\/[^/]+\/package\.json$/.exec(p);
        if (published !== null) {
          return JSON.stringify({ name: `cards-opencode-${published[1]}`, version: '1.0.0' });
        }
        const source = /\/(cards|runtime|cards-assistant)\/package\.json$/.exec(p);
        if (source !== null) {
          return JSON.stringify({ name: `cards-opencode-${source[1]}`, version: '1.0.0' });
        }
      }
      throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
    });

    vi.mocked(fs.readdir).mockImplementation(((dirPath: unknown) => {
      if (toPosix(dirPath).endsWith('/branches')) {
        return Promise.resolve([entryFile]);
      }
      return Promise.resolve([] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
    }) as unknown as typeof fs.readdir);

    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      const key = `${cmd} ${cmdArgs.join(' ')}`;

      if (typeof cb === 'function') {
        const handled: Record<string, { stdout?: string; error?: Error }> = {
          [`git rev-parse --abbrev-ref HEAD`]: { stdout: 'main\n' },
          [`${process.platform === 'win32' ? 'where' : 'which'} opencode`]: { stdout: '/usr/bin/opencode\n' },
          'git branch --list': { stdout: `  cards/card-123/1\n` },
          'git merge-base --is-ancestor cards/card-123/1 main': { stdout: '' },
          'git worktree remove': { stdout: '' },
          'git branch -d': { stdout: '' },
          'git rm': { stdout: '' },
          'git commit': { stdout: '' }
        };
        for (const [pattern, result] of Object.entries(handled)) {
          if (key.startsWith(pattern)) {
            if (result.error) cb(result.error);
            else cb(null, { stdout: result.stdout ?? '', stderr: '' });
            return {} as ReturnType<typeof execFile>;
          }
        }
        cb(new Error(`mock: unhandled command: ${key}`));
      }
      return {} as ReturnType<typeof execFile>;
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
        return Promise.resolve(
          new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput({ executionMode: 'background' }), createMockContext());
    await flushMicrotasks();

    child.emit('close', 0);
    await promise;

    // Inline cleanup ran the merged-branch reclamation steps itself…
    const execCalls = vi.mocked(execFile).mock.calls;
    expect(execCalls.some((c) => String(c[0]) === 'git' && (c[1] as string[])[0] === 'worktree')).toBe(true);
    expect(execCalls.some((c) => String(c[0]) === 'git' && (c[1] as string[]).join(' ').startsWith('branch -d'))).toBe(
      true
    );
    // …and no detached watcher was spawned behind the headless run.
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).not.toHaveBeenCalled();
  });
});

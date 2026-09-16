/**
 * Exercises Codex branches of the consolidated action handlers (launch, chat,
 * interview) through end-to-end scenarios. Locks in plugin-cache population,
 * spawn argv (including the `--profile cards` enablement and the separate
 * profile-config write), error paths, cancellation, and branch-cleanup wiring
 * for the Codex path.
 *
 * @summary Tests Codex branches of consolidated action handlers
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
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
 * Asymmetric matcher that compares a (possibly backslash-separated) path
 * argument against a POSIX-form regex by normalizing separators first.
 *
 * @param re - POSIX-form regular expression to test the normalized path against.
 * @returns A Vitest-compatible asymmetric matcher object.
 */
function posixMatching(re: RegExp): unknown {
  return {
    asymmetricMatch: (actual: unknown) => typeof actual === 'string' && re.test(toPosix(actual)),
    toString: () => `posixMatching(${String(re)})`
  };
}

/**
 * Native-separator form of a POSIX-written expected path so equality holds on
 * every platform (mirrors what production's path.join produces).
 *
 * @param posix - Expected path written with forward slashes.
 * @returns The same path using the host's native path separator.
 */
function nativePath(posix: string): string {
  return posix.split('/').join(sep);
}

/**
 * The default Codex source home, resolved exactly as production's
 * `resolveDefaultCodexHome` does (CODEX_HOME ?? <homedir>/.codex). Hardcoding
 * `/home/node/.codex` only works where the host home is `/home/node`; this
 * keeps the source-home cp/stat path cross-platform.
 */
const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const TEST_CODEX_PLUGIN_VERSIONS = {
  cards: 'cards-test-version',
  runtime: 'runtime-test-version'
} as const;

vi.mock('../src/lib/codex-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/codex-termination.js')>();
  const { createSyntheticProcessTreeAuthority } = await import('./helpers/process-tree-authority.js');
  return {
    ...actual,
    createCodexTerminationController: (
      child: Parameters<typeof actual.createCodexTerminationController>[0],
      options: Parameters<typeof actual.createCodexTerminationController>[1]
    ) =>
      actual.createCodexTerminationController(child, { ...options, authority: createSyntheticProcessTreeAuthority() })
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
  delete process.env['CODEX_HOME'];
  delete process.env['CARDS_HOME'];
  delete process.env['XDG_DATA_HOME'];
  delete process.env['XDG_CONFIG_HOME'];

  const { execFile } = await import('node:child_process');
  const { execFileSync } = await import('node:child_process');
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
  vi.mocked(execFileSync).mockImplementation((command: string, args?: readonly string[], options?: unknown) => {
    const normalizedArgs = [...(args ?? [])];
    const cwd =
      options && typeof options === 'object' && options !== null && 'cwd' in options
        ? String((options as { cwd?: unknown }).cwd)
        : '';
    const key = `${command} ${normalizedArgs.join(' ')}`;

    if (cwd === '/test/repo' && key.startsWith('git log -5 --reverse --pretty=format:%h%x00%an%x00%s -- .')) {
      return '123abcd\0Test User\0Add card plan';
    }
    if (cwd === '/test/repo' && key === 'git rev-list --count HEAD') {
      return '3';
    }
    if (cwd === '/test/workspace' && key === 'git log --format=%H cards/card-123/1') {
      return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    }
    if (cwd === '/test/workspace' && key === 'git log --format=%H main') {
      return ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].join('\n');
    }
    if (
      cwd === '/test/workspace' &&
      key === 'git log --no-walk --pretty=format:%H%x00%h%x00%s aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ) {
      return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0abcdef1\0Branch change';
    }
    if (
      cwd === '/test/workspace' &&
      key === 'git log --no-walk --pretty=format:%H%x00%h%x00%s bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ) {
      return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0bcdefg2\0Merged fix';
    }
    if (cwd === '/test/workspace' && key === 'git cat-file --batch-check') {
      return '';
    }

    throw new Error(`mock: unhandled execFileSync: ${key} cwd=${cwd}`);
  });

  const cardRepoDirents = [
    {
      name: 'CARD.md',
      isDirectory: () => false,
      isFile: () => true
    },
    {
      name: 'plan',
      isDirectory: () => true,
      isFile: () => false
    },
    {
      name: 'streams',
      isDirectory: () => true,
      isFile: () => false
    }
  ];
  const streamDirents = [
    {
      name: 'claude-code-session',
      isDirectory: () => true,
      isFile: () => false
    }
  ];
  const streamFileDirents = [
    {
      name: 'a.jsonl',
      isDirectory: () => false,
      isFile: () => true
    }
  ];

  vi.mocked(syncFs.readdirSync).mockImplementation((targetPath: string | Buffer | URL) => {
    if (toPosix(targetPath) === '/test/repo') {
      return cardRepoDirents as ReturnType<typeof syncFs.readdirSync>;
    }
    if (toPosix(targetPath) === '/test/repo/streams') {
      return streamDirents as ReturnType<typeof syncFs.readdirSync>;
    }
    if (toPosix(targetPath) === '/test/repo/streams/claude-code-session') {
      return streamFileDirents as ReturnType<typeof syncFs.readdirSync>;
    }
    throw Object.assign(new Error(`mock: unhandled readdirSync: ${String(targetPath)}`), { code: 'ENOENT' });
  });
  vi.mocked(syncFs.statSync).mockImplementation((_targetPath: string | Buffer | URL) => {
    return {
      mtimeMs: new Date('2026-04-02T12:34:56Z').getTime()
    } as ReturnType<typeof syncFs.statSync>;
  });
  vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
    if (toPosix(filePath) === '/test/repo/CARD.meta.json') {
      return JSON.stringify({
        id: 'card-123',
        title: 'Test card',
        status: 'active',
        gates: {
          planRequired: true,
          planApproved: false,
          mergeRequestRequired: false,
          mergeApproved: false
        }
      });
    }
    if (toPosix(filePath) === `/test/repo/branches/${encodeURIComponent('cards/card-123/1')}.json`) {
      return JSON.stringify({
        name: 'cards/card-123/1',
        parentBranch: 'main',
        addedAt: '2026-04-02T00:00:00.000Z'
      });
    }
    if (toPosix(filePath) === '/test/repo/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
      return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
    }
    if (toPosix(filePath) === '/test/repo/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
      return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';
    }
    if (toPosix(filePath) === '/test/repo/AGENTS.md') {
      return '# Card Repository Reference\n\nEach card is an isolated Git repository.\n';
    }
    throw Object.assign(new Error(`mock: unhandled readFileSync: ${String(filePath)}`), { code: 'ENOENT' });
  });

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

  vi.mocked(fs.access).mockResolvedValue(undefined);
  vi.mocked(fs.stat).mockImplementation(async (targetPath: string | URL) => {
    if (String(targetPath) === DEFAULT_CODEX_HOME) {
      return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
    }
    throw Object.assign(new Error(`mock: unhandled stat: ${String(targetPath)}`), { code: 'ENOENT' });
  });
  vi.mocked(fs.readdir).mockImplementation(async (targetPath: string | URL) => {
    if (toPosix(targetPath) === '/test/extension/dist/codex') {
      return ['.agents', 'cards', 'runtime'] as Awaited<ReturnType<typeof fs.readdir>>;
    }
    // The content-hash walk enumerates each bundled plugin source dir. An empty
    // listing keeps the fixture minimal — the digest just needs to be stable, and
    // these tests assert on the cp/spawn sequence rather than the hash itself.
    if (toPosix(targetPath).startsWith('/test/extension/dist/codex/')) {
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
    }
    throw Object.assign(new Error(`mock: unhandled readdir: ${String(targetPath)}`), { code: 'ENOENT' });
  });
  vi.mocked(fs.readFile).mockImplementation(async (filePath: string | URL) => {
    const p = toPosix(filePath);
    // Bundle (`.../cards/...`), staged (`.../.plugin-install-*/<version>/...`), and
    // published (`.../cards/<version>/...`) manifests all resolve.
    if (
      p.endsWith('.codex-plugin/plugin.json') &&
      (/(^|\/)cards\//.test(p) || p.includes(`/${TEST_CODEX_PLUGIN_VERSIONS.cards}/`))
    ) {
      return JSON.stringify({
        name: 'cards',
        version: TEST_CODEX_PLUGIN_VERSIONS.cards,
        description: 'Codex cards plugin for interacting with the Cards extension APIs'
      });
    }
    if (
      p.endsWith('.codex-plugin/plugin.json') &&
      (/(^|\/)runtime\//.test(p) || p.includes(`/${TEST_CODEX_PLUGIN_VERSIONS.runtime}/`))
    ) {
      return JSON.stringify({
        name: 'runtime',
        version: TEST_CODEX_PLUGIN_VERSIONS.runtime,
        description: 'Codex runtime plugin for the Cards extension'
      });
    }
    if (p.endsWith('/.agents/plugins/marketplace.json')) {
      return JSON.stringify({
        name: 'local',
        plugins: [
          {
            name: 'cards',
            source: {
              source: 'local',
              path: './cards'
            }
          },
          {
            name: 'runtime',
            source: {
              source: 'local',
              path: './runtime'
            }
          }
        ]
      });
    }
    throw Object.assign(new Error(`mock: unhandled readFile: ${String(filePath)}`), { code: 'ENOENT' });
  });
  vi.mocked(fs.rm).mockResolvedValue(undefined);
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: string | URL) => `${String(prefix)}XXXXXX`);
  vi.mocked(fs.cp).mockResolvedValue(undefined);
  vi.mocked(fs.rename).mockResolvedValue(undefined);
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
    codingAgent: 'codex-cli',
    ...overrides
  };
}

describe('launch action — codex branch', () => {
  it('populates the plugin cache and spawns codex with the resolved CODEX_HOME and --profile enablement', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    // The bundled plugins are staged into mkdtemp dirs under the cache (a sibling
    // of the scanned base root), never the resolved home itself. Production builds
    // these paths with path.join, so on Windows the args use native separators —
    // compare via separator-insensitive matchers.
    expect(fs.cp).toHaveBeenCalledWith(
      nativePath('/test/extension/dist/codex/cards'),
      posixMatching(new RegExp(`/plugins/cache/local/\\.plugin-install-[^/]+/${TEST_CODEX_PLUGIN_VERSIONS.cards}$`)),
      { force: true, recursive: true }
    );
    expect(fs.cp).toHaveBeenCalledWith(
      nativePath('/test/extension/dist/codex/runtime'),
      posixMatching(new RegExp(`/plugins/cache/local/\\.plugin-install-[^/]+/${TEST_CODEX_PLUGIN_VERSIONS.runtime}$`)),
      { force: true, recursive: true }
    );
    // No copy of the resolved home.
    expect(fs.cp).not.toHaveBeenCalledWith(DEFAULT_CODEX_HOME, expect.any(String), expect.anything());

    // Enablement is written to the SEPARATE profile file, never the user's config.toml.
    const writeTargets = vi.mocked(fs.writeFile).mock.calls.map((call) => toPosix(call[0]));
    expect(writeTargets).toContain(`${toPosix(DEFAULT_CODEX_HOME)}/cards.config.toml`);
    expect(writeTargets).not.toContain(`${toPosix(DEFAULT_CODEX_HOME)}/config.toml`);

    // No app-server install RPC — only the interactive codex spawn.
    expect(spawn).not.toHaveBeenCalledWith('codex', ['app-server'], expect.anything());
    expect(vi.mocked(spawn).mock.calls).toHaveLength(1);

    // The publish rename lands each plugin at plugins/cache/local/<plugin>/<version>.
    const renameDests = vi.mocked(fs.rename).mock.calls.map((call) => toPosix(call[1]));
    expect(renameDests).toContain(
      toPosix(`${DEFAULT_CODEX_HOME}/plugins/cache/local/cards/${TEST_CODEX_PLUGIN_VERSIONS.cards}`)
    );
    expect(renameDests).toContain(
      toPosix(`${DEFAULT_CODEX_HOME}/plugins/cache/local/runtime/${TEST_CODEX_PLUGIN_VERSIONS.runtime}`)
    );

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['--dangerously-bypass-approvals-and-sandbox']),
      expect.objectContaining({
        cwd: '/test/workspace/.worktrees/cards/card-123/1',
        stdio: 'inherit',
        env: expect.objectContaining({
          CODEX_HOME: DEFAULT_CODEX_HOME,
          WORKSPACE_PATH: '/test/workspace/.worktrees/cards/card-123/1',
          BASE_BRANCH: 'main',
          PARENT_BRANCH: 'main',
          WORKSPACE_BRANCH: 'cards/card-123/1'
        })
      })
    );

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--cd');
    expect(args).toContain('/test/workspace/.worktrees/cards/card-123/1');
    expect(args).toContain('--add-dir');
    expect(args).toContain('/test/repo');
    // Enablement is via the Cards profile-v2 layer, not retired -c plugin flags.
    expect(args[args.indexOf('--profile') + 1]).toBe('cards');
    const cFlagValues = args.filter((_value, index) => args[index - 1] === '-c');
    expect(cFlagValues).not.toContain('features.plugins=true');
    expect(cFlagValues.some((value) => value.startsWith('plugins.'))).toBe(false);
    // The card-repo AGENTS.md is folded into developer_instructions via -c.
    const developerInstructions = cFlagValues.find((value) => value.startsWith('developer_instructions'));
    expect(developerInstructions).toBeDefined();
    expect(developerInstructions).toContain('Card Repository Reference');
    expect(developerInstructions).toContain('Each card is an isolated Git repository.');
    expect(args[args.length - 1]).toMatch(/Load the `\$runtime:card` skill and follow the `<routing-instructions>`\.$/);

    child.emit('close', 0);
    await promise;
  });

  it('populates the cache under the resolved home when CODEX_HOME is provided', async () => {
    process.env['CODEX_HOME'] = '/custom/codex-home';
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), createMockContext());
    await flushMicrotasks();

    const cpDests = vi.mocked(fs.cp).mock.calls.map((call) => toPosix(call[1]));
    expect(cpDests.length).toBeGreaterThan(0);
    expect(cpDests.every((dest) => dest.startsWith('/custom/codex-home/plugins/cache/local/'))).toBe(true);
    expect(vi.mocked(spawn).mock.calls[0][2]).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: '/custom/codex-home' }) })
    );

    child.emit('close', 0);
    await promise;
  });

  it('fails closed when the bundled marketplace manifest is missing', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockImplementation(async (targetPath: string | URL) => {
      if (toPosix(targetPath) === '/test/extension/dist/codex/.agents/plugins/marketplace.json') {
        throw Object.assign(new Error('marketplace missing'), { code: 'ENOENT' });
      }
    });

    const action = (await import('../src/actions/launch.js')).default;

    await expect(action(baseInput(), createMockContext())).rejects.toThrow('marketplace missing');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed when the cache directory creation fails', async () => {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs/promises');
    vi.mocked(fs.mkdir).mockImplementation(async (dirPath: unknown) => {
      if (/plugins\/cache\/local/.test(toPosix(dirPath))) {
        throw new Error('mkdir failed');
      }
      return undefined;
    });

    const action = (await import('../src/actions/launch.js')).default;

    await expect(action(baseInput(), createMockContext())).rejects.toThrow('mkdir failed');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('registers owned-tree cancellation and reports the termination result', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const context = createMockContext();
    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput(), context);
    await flushMicrotasks();

    const spawnOptions = vi.mocked(spawn).mock.calls[0]![2] as Record<string, unknown>;
    expect(spawnOptions['detached']).toBeUndefined();

    const onCancel = vi.mocked(context.onCancel).mock.calls[0][0] as () => Promise<void>;
    await expect(onCancel()).resolves.toBeUndefined();

    child.emit('close', 0);
    await promise;
  });

  it('calls spawnBranchCleanupWatcher after session exits', async () => {
    const { spawn, execFile } = await import('node:child_process');
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
        cardRepoPath: '/test/repo'
      },
      expect.anything()
    );

    const execCalls = vi.mocked(execFile).mock.calls;
    const mergeBaseCall = execCalls.find((call) => (call[1] as string[])?.includes('merge-base'));
    expect(mergeBaseCall).toBeUndefined();
  });

  it('runs background-mode launch through codex exec with console-less stdio and inline cleanup', async () => {
    const { spawn } = await import('node:child_process');
    const stderr = new EventEmitter();
    const child = createMockChild();
    child.stderr = stderr as ChildProcess['stderr'];
    vi.mocked(spawn).mockReturnValue(child);
    const context = createMockContext();
    const warn = vi.spyOn(context.logger, 'warn');

    const action = (await import('../src/actions/launch.js')).default;
    const promise = action(baseInput({ executionMode: 'background' }), context);
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[0]).toBe('exec');
    expect(vi.mocked(spawn).mock.calls[0]![2]).toEqual(
      expect.objectContaining({
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
    );

    stderr.emit('data', Buffer.from('codex progress'));
    expect(warn).toHaveBeenCalledWith('codex progress');

    child.emit('close', 0);
    await promise;

    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    expect(spawnBranchCleanupWatcher).not.toHaveBeenCalled();
  });
});

describe('captain action — codex branch', () => {
  it('runs background-mode captain through codex exec', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/captain.js')).default;
    const promise = action(baseInput({ actionName: 'Captain', executionMode: 'background' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args[0]).toBe('exec');
    expect(args[args.length - 1]).toMatch(
      /Load the `\$runtime:captain` skill and follow the `<routing-instructions>`\.$/
    );

    child.emit('close', 0);
    await promise;
  });
});

describe('chat action — codex branch', () => {
  it('spawns codex chat without a seeded guidance prompt', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/chat.js')).default;
    const promise = action(baseInput({ actionName: 'Chat' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd',
        '/test/workspace/.worktrees/cards/card-123/1',
        '--add-dir',
        '/test/repo'
      ])
    );
    // Enablement is via the Cards profile-v2 layer, alongside the chat
    // developer_instructions -c value.
    expect(args[args.indexOf('--profile') + 1]).toBe('cards');
    const cFlagValues = args.filter((_value, index) => args[index - 1] === '-c');
    expect(cFlagValues).not.toContain('features.plugins=true');
    expect(cFlagValues.some((value) => value.startsWith('plugins.'))).toBe(false);
    const developerInstructionsArg = cFlagValues.find((value) => value.startsWith('developer_instructions'));
    expect(developerInstructionsArg).toMatch(/^developer_instructions = "/);
    // No seeded guidance prompt: the last arg is a -c value, not a prompt string.
    expect(args[args.length - 2]).toBe('-c');

    child.emit('close', 0);
    await promise;
  });
});

describe('interview action — codex branch', () => {
  it('spawns codex with a short prompt referencing the interview skill', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const action = (await import('../src/actions/interview.js')).default;
    const promise = action(baseInput({ actionName: 'Interview' }), createMockContext());
    await flushMicrotasks();

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain('--cd');
    expect(args).toContain('/test/workspace/.worktrees/cards/card-123/1');
    expect(args).toContain('--add-dir');
    expect(args).toContain('/test/repo');
    // Enablement is via the Cards profile-v2 layer; interview passes no session
    // guidance, so developer_instructions carries only the card-repo AGENTS.md.
    expect(args[args.indexOf('--profile') + 1]).toBe('cards');
    const cFlagValues = args.filter((_value, index) => args[index - 1] === '-c');
    expect(cFlagValues).not.toContain('features.plugins=true');
    expect(cFlagValues.some((value) => value.startsWith('plugins.'))).toBe(false);
    const developerInstructions = cFlagValues.find((value) => value.startsWith('developer_instructions'));
    expect(developerInstructions).toBeDefined();
    expect(developerInstructions).toContain('Card Repository Reference');
    expect(args[args.length - 1]).toMatch(
      /Load the `\$runtime:interview` skill and follow the `<routing-instructions>`\.$/
    );

    child.emit('close', 0);
    await promise;
  });
});

import type { ChildProcess } from 'node:child_process';
import type { CardsAssistantContext, CardsAssistantInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the default cards-assistant handler through focused scenarios.
 *
 * The cases lock in the cross-platform `claude` launch: routing through
 * cross-spawn (no `shell` option) so the win32 `claude.cmd` PATHEXT shim resolves
 * and its arguments are escaped for cmd.exe, the multi-line `--append-system-prompt`
 * surviving intact (cross-spawn escapes embedded newlines — no collapsing needed),
 * the inline marketplace settings, inherited stdio, the fail-closed spawn-error
 * path, and the registration-before-spawn ordering. They guard against the win32
 * regression where a `shell: true` spawn concatenated argv unquoted and cmd.exe
 * mangled the `--settings '{…JSON…}'` argument. The codex branch is covered for
 * the same cross-spawn routing and fail-closed spawn-`error` guard as claude.
 * The antigravity branch additionally pins its launch outcome onto the
 * handler's own exit code: a spawn error and a non-zero `agy` exit both throw
 * the action path's named failure, while an exit zero or a signal-terminated
 * child (null exit code — user cancellation is an expected shutdown) settles.
 *
 * @summary Tests default cards-assistant handler behavior
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
  // @cards.management/sdk's index runs `promisify(execFile)` at module load, and execFileSync
  // is used by the worktree primitives, so both must exist on the mock for the
  // module graph to import even though these tests only assert on spawn.
  execFile: vi.fn(),
  execFileSync: vi.fn()
}));

vi.mock('../src/lib/claude-session.js', () => ({
  updateMarketplaceRegistration: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../src/lib/codex-session.js', () => ({
  CODEX_ASSISTANT_PLUGIN_NAMES: ['cards', 'cards-assistant'],
  formatDeveloperInstructionsOverride: vi.fn((value: string) => `developer_instructions=${value}`),
  populateCodexPluginCache: vi.fn().mockResolvedValue({ pluginCachePaths: [] }),
  resolveDefaultCodexHome: vi.fn(() => '/test/codex-home'),
  writeCodexProfileConfig: vi.fn().mockResolvedValue('/test/codex-home/config.toml')
}));

vi.mock('../src/lib/opencode-session.js', () => ({
  OPENCODE_ASSISTANT_PLUGIN_NAMES: ['cards', 'cards-assistant'],
  assertOpencodeBinaryAvailable: vi.fn().mockResolvedValue('/usr/bin/opencode'),
  populateOpencodePluginCache: vi.fn().mockResolvedValue({ bundlePath: '', pluginPaths: {}, pluginCachePaths: {} }),
  readGlobalPluginEntries: vi.fn().mockResolvedValue({ entries: [] }),
  resolveCardsOpencodeStagingDir: vi.fn(() => '/test/cards-opencode-staging'),
  resolveDefaultOpencodeConfigDir: vi.fn(() => '/test/oc-config'),
  writeCardsLaunchConfig: vi.fn().mockResolvedValue('/test/cards-opencode-staging/cards-assistant.config.json')
}));

vi.mock('../src/lib/antigravity-session.js', () => ({
  // The antigravity branch propagates a failed launch by throwing this class,
  // so the mock must carry it — the real one lives inside the mocked module and
  // the handler imports it from there.
  AntigravitySessionFailureError: class extends Error {
    constructor(
      public readonly reason: string,
      message: string
    ) {
      super(message);
    }
  },
  spawnAntigravitySession: vi.fn()
}));

const ORIGINAL_PLATFORM = process.platform;

/**
 * Forces `process.platform` for the duration of a test so the win32 / POSIX
 * branch of the handler's spawn is exercised. Restored in `afterEach`.
 *
 * @param platform - Platform value to install on process.platform.
 */
function forcePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Builds a fake ChildProcess that records `on(...)` handlers and lets a test
 * drive the `close` / `error` events deterministically.
 *
 * @param overrides - Partial overrides merged onto the fake child.
 * @returns A ChildProcess-shaped mock.
 */
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

function createMockContext(): CardsAssistantContext {
  return {
    logger: new Logger(),
    cwd: '/test/workspace'
  };
}

function baseInput(overrides?: Partial<CardsAssistantInput>): CardsAssistantInput {
  return {
    marketplacePath: '/test/extension/dist/marketplace',
    extensionPath: '/test/extension',
    repoRoot: '/test/workspace',
    ...overrides
  };
}

/**
 * Reads an indexed slot that `noUncheckedIndexedAccess` widens to `| undefined`,
 * failing the test rather than the type check when the slot is empty. Every
 * `mock.calls[0]` / `args[i]` read below is non-optional by construction: the
 * scenario that reaches it already asserted the call or argument exists.
 *
 * @param values - Indexed collection to read.
 * @param index - Zero-based index to read.
 * @returns The value at `index`.
 * @throws {Error} When the collection has no value at `index`.
 */
function requiredAt<T>(values: readonly (T | undefined)[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Expected a value at index ${index}, but the collection has ${values.length}`);
  }
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
});

describe('cards-assistant handler', () => {
  it.each<NodeJS.Platform>([
    'win32',
    'linux',
    'darwin'
  ])('spawns claude through cross-spawn with no shell option on %s', async (platform) => {
    forcePlatform(platform);
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(baseInput(), createMockContext());
    await flushMicrotasks();

    const spawnCall = requiredAt(vi.mocked(spawn).mock.calls, 0);
    expect(spawnCall[0]).toBe('claude');
    // cross-spawn owns win32 shim resolution + argv escaping; the caller must NOT
    // set `shell` (a `shell: true` spawn is what mangled the JSON --settings arg).
    const opts = spawnCall[2] as { shell?: boolean };
    expect(opts.shell).toBeUndefined();

    child.emit('close', 0);
    await promise;
  });

  it.each<NodeJS.Platform>(['win32', 'linux'])('preserves cwd and inherited stdio on %s', async (platform) => {
    forcePlatform(platform);
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(baseInput({ repoRoot: '/custom/repo' }), createMockContext());
    await flushMicrotasks();

    const opts = requiredAt(vi.mocked(spawn).mock.calls, 0)[2] as { cwd?: string; stdio?: unknown };
    expect(opts.cwd).toBe('/custom/repo');
    expect(opts.stdio).toBe('inherit');

    child.emit('close', 0);
    await promise;
  });

  it('passes the multi-line interview system prompt intact (cross-spawn escapes it)', async () => {
    forcePlatform('win32');
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(baseInput(), createMockContext());
    await flushMicrotasks();

    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    const promptIdx = args.indexOf('--append-system-prompt');
    expect(promptIdx).toBeGreaterThan(-1);

    const prompt = requiredAt(args, promptIdx + 1);
    expect(prompt).toContain('Load the `cards:cards` skill');
    // cross-spawn escapes embedded newlines for cmd.exe, so the prompt is passed
    // verbatim — the previous single-line collapse (a shell:true workaround) is
    // gone. The multi-line structure must survive to reach the agent unchanged.
    expect(prompt).toContain('\n');
    expect(prompt.trimStart().startsWith('<instructions>')).toBe(true);

    child.emit('close', 0);
    await promise;
  });

  it('passes inline marketplace plugin settings for the extension bundle', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const input = baseInput({ marketplacePath: '/global/storage/marketplace' });
    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(input, createMockContext());
    await flushMicrotasks();

    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(-1);

    const settings = JSON.parse(requiredAt(args, settingsIdx + 1)) as {
      enabledPlugins: Record<string, boolean>;
      extraKnownMarketplaces: Record<string, { source: { source: string; path: string } }>;
    };
    expect(settings.enabledPlugins['cards@cards.management']).toBe(true);
    expect(settings.extraKnownMarketplaces['cards.management']?.source.path).toBe('/global/storage/marketplace');

    child.emit('close', 0);
    await promise;
  });

  it('appends initialPrompt behind a -- terminator at the end of cliArgs', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const input = baseInput({ initialPrompt: 'explain this error' });
    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(input, createMockContext());
    await flushMicrotasks();

    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    expect(args[0]).toBe('--append-system-prompt');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('explain this error');

    child.emit('close', 0);
    await promise;
  });

  it('survives a --prefixed prompt as a literal trailing arg behind the -- terminator', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const input = baseInput({ initialPrompt: '--dangerously-skip-permissions' });
    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(input, createMockContext());
    await flushMicrotasks();

    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('--dangerously-skip-permissions');

    child.emit('close', 0);
    await promise;
  });

  it('omits the -- terminator and positional arg when initialPrompt is absent', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(baseInput(), createMockContext());
    await flushMicrotasks();

    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    expect(args[0]).toBe('--append-system-prompt');
    expect(args).not.toContain('--');

    child.emit('close', 0);
    await promise;
  });

  it('omits the -- terminator and positional arg when initialPrompt is an empty string', async () => {
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(baseInput({ initialPrompt: '' }), createMockContext());
    await flushMicrotasks();

    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    expect(args[0]).toBe('--append-system-prompt');
    expect(args).not.toContain('--');

    child.emit('close', 0);
    await promise;
  });

  it('fails closed when spawn errors: logs and settles without hanging', async () => {
    forcePlatform('win32');
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const context = createMockContext();
    const errorSpy = vi.spyOn(context.logger, 'error');

    const handler = (await import('../src/cards-assistant.js')).default;
    let resolved = false;
    const promise = handler(baseInput(), context).then(() => {
      resolved = true;
    });
    await flushMicrotasks();

    expect(resolved).toBe(false);

    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoent);

    await promise;
    expect(resolved).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('Failed to spawn claude', { error: 'spawn claude ENOENT' });
  });

  it('routes the codex branch through cross-spawn and fails closed on a spawn error', async () => {
    forcePlatform('win32');
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const context = createMockContext();
    const errorSpy = vi.spyOn(context.logger, 'error');

    const handler = (await import('../src/cards-assistant.js')).default;
    let resolved = false;
    const promise = handler(baseInput({ codingAgent: 'codex-cli' }), context).then(() => {
      resolved = true;
    });
    await flushMicrotasks();

    // The codex branch was taken (not claude) and routed through cross-spawn with
    // no `shell` option, mirroring the claude launch.
    const spawnCall = requiredAt(vi.mocked(spawn).mock.calls, 0);
    expect(spawnCall[0]).toBe('codex');
    const opts = spawnCall[2] as { shell?: boolean };
    expect(opts.shell).toBeUndefined();
    expect(resolved).toBe(false);

    // A `codex`/`codex.cmd` shim that cannot spawn emits `error`, never `close`.
    // Without the codex-branch guard this promise would hang forever.
    const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoent);

    await promise;
    expect(resolved).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('Failed to spawn codex', { error: 'spawn codex ENOENT' });
  });

  it('routes the opencode branch through cross-spawn with interactive TUI argv, staged config env, and the opening turn', async () => {
    forcePlatform('win32');
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(baseInput({ codingAgent: 'opencode-cli' }), createMockContext());
    await flushMicrotasks();

    const spawnCall = requiredAt(vi.mocked(spawn).mock.calls, 0);
    expect(spawnCall[0]).toBe('/usr/bin/opencode');
    // The writer receives the global layer's registrations so globally
    // registered plugins stage their colliding pointer spec instead of a
    // second copy of every hook module.
    const { readGlobalPluginEntries, writeCardsLaunchConfig } = await import('../src/lib/opencode-session.js');
    expect(readGlobalPluginEntries).toHaveBeenCalledWith('/test/oc-config');
    expect(vi.mocked(writeCardsLaunchConfig).mock.calls[0]?.[4]).toEqual({
      globalPluginEntries: expect.any(Array)
    });
    const opts = spawnCall[2] as {
      shell?: boolean;
      cwd?: string;
      stdio?: unknown;
      env?: Record<string, string | undefined>;
    };
    expect(opts.shell).toBeUndefined();
    expect(opts.cwd).toBe('/test/workspace');
    expect(opts.stdio).toBe('inherit');
    // The per-set staged config document rides OPENCODE_CONFIG — never a
    // CODEX_HOME-style replacement of the config dir.
    expect(opts.env?.['OPENCODE_CONFIG']).toBe('/test/cards-opencode-staging/cards-assistant.config.json');

    // Interactive TUI contract pinned at the repo root; the interview
    // instructions are the seeded opening turn (`--prompt`) and the repo root
    // is the project positional — mirroring the action path's interactive
    // launch surface (the TUI accepts neither `run` nor `--dir`).
    const args = requiredAt(vi.mocked(spawn).mock.calls, 0)[1];
    expect(args[0]).toBe('--prompt');
    const prompt = requiredAt(args, 1);
    expect(prompt).toContain('Load the `cards:cards` skill');
    expect(prompt.trimStart().startsWith('<instructions>')).toBe(true);
    expect(args[2]).toBe('/test/workspace');
    // The assistant session runs prompt-less beyond that — initialPrompt is
    // not read by this branch (unreachable via cards.startCardsAssistant).
    expect(args).toHaveLength(3);

    child.emit('close', 0);
    await promise;
  });

  it('fails closed on an opencode spawn error without hanging', async () => {
    forcePlatform('win32');
    const { spawn } = await import('node:child_process');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const context = createMockContext();
    const errorSpy = vi.spyOn(context.logger, 'error');

    const handler = (await import('../src/cards-assistant.js')).default;
    let resolved = false;
    const promise = handler(baseInput({ codingAgent: 'opencode-cli' }), context).then(() => {
      resolved = true;
    });
    await flushMicrotasks();

    expect(resolved).toBe(false);

    const enoent = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoent);

    await promise;
    expect(resolved).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('Failed to spawn opencode', { error: 'spawn opencode ENOENT' });
  });

  it('updates marketplace registration before spawning claude', async () => {
    const { spawn } = await import('node:child_process');
    const { updateMarketplaceRegistration } = await import('../src/lib/claude-session.js');
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const input = baseInput();
    const context = createMockContext();
    const handler = (await import('../src/cards-assistant.js')).default;
    const promise = handler(input, context);
    await flushMicrotasks();

    expect(updateMarketplaceRegistration).toHaveBeenCalledWith(input.marketplacePath, context.logger);

    const registrationOrder = requiredAt(vi.mocked(updateMarketplaceRegistration).mock.invocationCallOrder, 0);
    const spawnOrder = requiredAt(vi.mocked(spawn).mock.invocationCallOrder, 0);
    expect(registrationOrder).toBeLessThan(spawnOrder);

    child.emit('close', 0);
    await promise;
  });

  describe('antigravity branch', () => {
    it('spawns interactive agy -i with the assistant instructions in the workspace cwd', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const handler = (await import('../src/cards-assistant.js')).default;
      const promise = handler(baseInput({ codingAgent: 'antigravity-cli' }), createMockContext());
      await flushMicrotasks();

      const spawnCall = requiredAt(vi.mocked(spawn).mock.calls, 0);
      expect(spawnCall[0]).toBe('agy');
      const args = spawnCall[1];
      expect(args[0]).toBe('-i');
      // The assistant prompt is the packaged assistant instructions (same
      // bundle the other hosts launch with); no card fields ride the argv.
      const prompt = requiredAt(args, 1);
      expect(prompt).toContain('Load the `cards:cards` skill');
      expect(prompt.trimStart().startsWith('<instructions>')).toBe(true);
      expect(args).toHaveLength(2);
      expect(args).not.toContain('--dangerously-skip-permissions');

      const opts = spawnCall[2] as {
        cwd?: string;
        stdio?: unknown;
        detached?: boolean;
        shell?: boolean;
        env?: Record<string, string | undefined>;
      };
      expect(opts.cwd).toBe('/test/workspace');
      expect(opts.stdio).toBe('inherit');
      expect(opts.detached).toBe(process.platform !== 'win32');
      expect(opts.shell).toBeUndefined();
      // Workspace/window-owned session: no EXIT_WHEN_DONE override is ever set.
      expect(opts.env?.['EXIT_WHEN_DONE']).not.toBe('false');

      child.emit('close', 0);
      await promise;
    });

    it('makes no card settlement calls — no card session, watcher, or status settle', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnAntigravitySession } = await import('../src/lib/antigravity-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const handler = (await import('../src/cards-assistant.js')).default;
      const promise = handler(baseInput({ codingAgent: 'antigravity-cli' }), createMockContext());
      await flushMicrotasks();

      // The assistant launch never goes through the card-session spawner: it
      // is workspace/window-owned, with no worktree, watcher, or settlement.
      expect(vi.mocked(spawnAntigravitySession)).not.toHaveBeenCalled();
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

      child.emit('close', 0);
      await promise;
    });

    it('fails closed on a spawn error without hanging, and surfaces it as a non-zero handler exit', async () => {
      const { spawn } = await import('node:child_process');
      const { AntigravitySessionFailureError } = await import('../src/lib/antigravity-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const errorSpy = vi.spyOn(context.logger, 'error');

      const handler = (await import('../src/cards-assistant.js')).default;
      let settled = false;
      const promise = handler(baseInput({ codingAgent: 'antigravity-cli' }), context).finally(() => {
        settled = true;
      });
      await flushMicrotasks();

      // A spawn failure emits `error` and never `close`; without the guard this
      // promise would hang forever.
      expect(settled).toBe(false);

      const enoent = Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' });
      child.emit('error', enoent);

      await expect(promise).rejects.toBeInstanceOf(AntigravitySessionFailureError);
      await expect(promise).rejects.toThrow('the agy process could not be launched (spawn agy ENOENT)');
      expect(settled).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith('Failed to spawn agy', { error: 'spawn agy ENOENT' });
    });

    it('propagates a non-zero agy exit as a non-zero handler exit', async () => {
      const { spawn } = await import('node:child_process');
      const { AntigravitySessionFailureError } = await import('../src/lib/antigravity-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const handler = (await import('../src/cards-assistant.js')).default;
      const promise = handler(baseInput({ codingAgent: 'antigravity-cli' }), context);
      await flushMicrotasks();

      child.emit('close', 7);

      // The handler's own exit code is what the extension's terminal lifecycle
      // reads, so a non-zero child exit must not settle as a clean exit.
      await expect(promise).rejects.toBeInstanceOf(AntigravitySessionFailureError);
      await expect(promise).rejects.toThrow('agy exited with code 7');
    });

    it('settles clean when agy exits zero or is terminated without an exit code', async () => {
      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const handler = (await import('../src/cards-assistant.js')).default;
      const promise = handler(baseInput({ codingAgent: 'antigravity-cli' }), createMockContext());
      await flushMicrotasks();

      // User cancellation is an expected shutdown: a signal-terminated child
      // arrives as a null exit code and must not be reported as a failure.
      child.emit('close', null);

      await expect(promise).resolves.toBeUndefined();
    });
  });
});

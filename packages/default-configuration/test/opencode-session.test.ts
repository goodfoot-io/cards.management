/**
 * Exercises OpenCode session library helpers through focused scenarios.
 * The cases lock in the plugin-cache stamping discipline, the per-set staged
 * config determinism, the argv builder, and the spawn failure paths so
 * refactors do not drift the packaged OpenCode runtime contract.
 *
 * @summary Tests OpenCode session library helpers
 */

import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Production code builds paths with node:path, so on Windows the values passed
 * to fs mocks use backslash separators. Normalize to forward slashes so the
 * POSIX-keyed mock lookups below match regardless of platform.
 *
 * @param p - Path-like value (string, Buffer, or URL) to normalize.
 * @returns The value stringified with backslashes converted to forward slashes.
 */
function toPosix(p: unknown): string {
  return String(p).replace(/\\/g, '/');
}

const DEFAULT_OPENCODE_CONFIG_DIR = join(homedir(), '.config', 'opencode');
const CARDS_OPENCODE_STAGING_DIR = join(homedir(), '.cards', 'opencode');

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

// Detached-watcher spawns are out of scope here; lock only the wiring.
vi.mock('../src/lib/branch-cleanup-watcher.js', () => ({
  spawnBranchCleanupWatcher: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@cards.management/sdk/bin/resolve-branch-cleanup-watcher', () => ({
  resolveBranchCleanupWatcher: vi.fn(() => '/resolved/dist/bin/branch-cleanup-watcher')
}));

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn()
}));

vi.mock('node:fs/promises', () => ({
  // Production code reads fs.constants.X_OK for executability checks on the
  // well-known binary fallback; mirror the shape it needs.
  constants: { X_OK: 0o1 },
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

vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

beforeEach(async () => {
  vi.clearAllMocks();
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['API_TEST_MODE'] = '1';
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['CARDS_HOME'];
  delete process.env['EXIT_WHEN_DONE'];

  const fs = await import('node:fs/promises');
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env['API_TEST_MODE'];
});

describe('opencode-session library', () => {
  describe('resolveDefaultOpencodeConfigDir', () => {
    it('joins $XDG_CONFIG_HOME with /opencode when set', async () => {
      process.env['XDG_CONFIG_HOME'] = '/xdg/config-home';
      const { resolveDefaultOpencodeConfigDir } = await import('../src/lib/opencode-session.js');

      expect(toPosix(resolveDefaultOpencodeConfigDir())).toBe('/xdg/config-home/opencode');
    });

    it('falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset', async () => {
      const { resolveDefaultOpencodeConfigDir } = await import('../src/lib/opencode-session.js');

      expect(toPosix(resolveDefaultOpencodeConfigDir())).toBe(toPosix(DEFAULT_OPENCODE_CONFIG_DIR));
    });
  });

  describe('populateOpencodePluginCache', () => {
    /**
     * Wires the fs mocks needed for a successful `populateOpencodePluginCache`
     * run: bundle/plugin paths resolve, package.json manifests parse (source,
     * staged, and published locations), and all writes succeed.
     *
     * @param version - Version string served for every plugin manifest.
     * @returns The mocked `node:fs/promises` module for per-test assertions.
     */
    async function mockSuccessfulCacheFs(version = '1.0.0'): Promise<typeof import('node:fs/promises')> {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.access).mockResolvedValue(undefined);
      // Staging copies live under `.plugin-install-*` dirs that carry no plugin
      // name segment, so manifests there are served in install order.
      let stagedReadIndex = 0;
      const stagedPluginNames = ['cards', 'runtime', 'cards-assistant'];
      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        const p = toPosix(filePath);
        if (p.endsWith('/package.json')) {
          if (p.includes('.plugin-install-')) {
            const name = stagedPluginNames[stagedReadIndex++];
            if (name === undefined) {
              throw new Error(`Unexpected staged manifest read: ${p}`);
            }
            return JSON.stringify({ name: `cards-opencode-${name}`, version });
          }
          // Published slots end <plugin>/<version>/package.json; source bundle
          // paths end <plugin>/package.json. Two-segment first so cache-root
          // segments named `cards` never shadow the plugin segment.
          const published = /\/(cards|runtime|cards-assistant)\/[^/]+\/package\.json$/.exec(p);
          if (published !== null) {
            return JSON.stringify({ name: `cards-opencode-${published[1]}`, version });
          }
          const source = /\/(cards|runtime|cards-assistant)\/package\.json$/.exec(p);
          if (source !== null) {
            return JSON.stringify({ name: `cards-opencode-${source[1]}`, version });
          }
        }
        throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      vi.mocked(fs.cp).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.rm).mockResolvedValue(undefined);
      // No sibling version dirs to prune and no plugin content to hash in the
      // unit fixture.
      vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return fs;
    }

    it('stages plugins under <configDir>/plugins/cache/cards/<plugin>/<version>', async () => {
      const fs = await mockSuccessfulCacheFs();
      const { populateOpencodePluginCache } = await import('../src/lib/opencode-session.js');

      const { pluginCachePaths } = await populateOpencodePluginCache(
        '/test/opencode-config',
        '/test/extension/dist/marketplace'
      );

      expect(toPosix(pluginCachePaths['cards']!)).toBe(
        toPosix('/test/opencode-config/plugins/cache/cards/cards/1.0.0')
      );
      expect(toPosix(pluginCachePaths['runtime']!)).toBe(
        toPosix('/test/opencode-config/plugins/cache/cards/runtime/1.0.0')
      );
      // Copies come from the bundled payload tree next to the marketplace.
      const cpSources = vi.mocked(fs.cp).mock.calls.map((call) => toPosix(call[0]));
      expect(cpSources).toContain('/test/extension/dist/opencode/cards');
      expect(cpSources).toContain('/test/extension/dist/opencode/runtime');
    });

    it('skips restaging when the published slot stamp matches the bundle content', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.access).mockResolvedValue(undefined);
      let cardsSourceHash: string | undefined;
      let stagedReadIndex = 0;
      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        const p = toPosix(filePath);
        if (
          cardsSourceHash !== undefined &&
          p === '/test/opencode-config/plugins/cache/cards/cards/1.0.0/.cards-content-hash'
        ) {
          return cardsSourceHash;
        }
        if (p.endsWith('/package.json')) {
          if (p.includes('.plugin-install-')) {
            // The cards slot hits the matching-stamp fast path and never
            // stages, so the only staged manifest read belongs to runtime.
            const name = ['runtime'][stagedReadIndex++];
            if (name === undefined) {
              throw new Error(`Unexpected staged manifest read: ${p}`);
            }
            return JSON.stringify({ name: `cards-opencode-${name}`, version: '1.0.0' });
          }
          const published = /\/(cards|runtime)\/[^/]+\/package\.json$/.exec(p);
          if (published !== null) {
            return JSON.stringify({ name: `cards-opencode-${published[1]}`, version: '1.0.0' });
          }
          const source = /\/(cards|runtime)\/package\.json$/.exec(p);
          if (source !== null) {
            return JSON.stringify({ name: `cards-opencode-${source[1]}`, version: '1.0.0' });
          }
        }
        throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      vi.mocked(fs.cp).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.rm).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      const { computePluginContentHash } = await import('../src/lib/codex-session.js');
      const { populateOpencodePluginCache } = await import('../src/lib/opencode-session.js');
      cardsSourceHash = await computePluginContentHash('/test/extension/dist/opencode/cards');

      await populateOpencodePluginCache('/test/opencode-config', '/test/extension/dist/marketplace');

      // The cards slot was byte-current: no staging copy or publish rename for
      // it; runtime still stages normally.
      const cpDestinations = vi.mocked(fs.cp).mock.calls.map((call) => toPosix(call[1]));
      expect(cpDestinations.some((dest) => dest.includes('/cache/cards/cards/'))).toBe(false);
      expect(cpDestinations.some((dest) => dest.includes('/cache/cards/runtime/'))).toBe(false);
      expect(cpDestinations.some((dest) => dest.includes('.plugin-install-'))).toBe(true);
    });

    it('fails closed when a bundled plugin manifest disagrees with the requested name', async () => {
      await mockSuccessfulCacheFs();
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        const p = toPosix(filePath);
        if (p.endsWith('/package.json')) {
          return JSON.stringify({ name: 'some-other-plugin', version: '1.0.0' });
        }
        throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
      });
      const { populateOpencodePluginCache } = await import('../src/lib/opencode-session.js');

      await expect(
        populateOpencodePluginCache('/test/opencode-config', '/test/extension/dist/marketplace')
      ).rejects.toThrow(/package\.json/);
    });

    it('fails closed on a manifest version that is not a single safe path segment', async () => {
      await mockSuccessfulCacheFs('../../evil');
      const { populateOpencodePluginCache } = await import('../src/lib/opencode-session.js');

      await expect(
        populateOpencodePluginCache('/test/opencode-config', '/test/extension/dist/marketplace')
      ).rejects.toThrow(/version segment/i);
    });

    it('propagates cache-write errors (fail closed)', async () => {
      const fs = await mockSuccessfulCacheFs();
      vi.mocked(fs.mkdir).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      const { populateOpencodePluginCache } = await import('../src/lib/opencode-session.js');

      await expect(
        populateOpencodePluginCache('/test/opencode-config', '/test/extension/dist/marketplace')
      ).rejects.toMatchObject({ code: 'EACCES' });
    });
  });

  describe('writeCardsLaunchConfig', () => {
    /**
     * Builds plugin-cache-path fixtures rooted at a base directory.
     *
     * @param base - Absolute base dir standing in for the populated cache root.
     * @returns Plugin name → cache dir map covering both launch-set plugins.
     */
    function cachePaths(base: string): Record<string, string> {
      return {
        cards: `${base}/cards/1.0.0`,
        runtime: `${base}/runtime/1.0.0`
      };
    }

    /**
     * Builds a Dirent-shaped object for readdir-withFileTypes mocks.
     *
     * @param name - Entry name.
     * @returns A minimal file-Dirent-shaped fixture.
     */
    function fileDirent(name: string): { name: string; isFile(): boolean; isDirectory(): boolean } {
      return { name, isFile: () => true, isDirectory: () => false };
    }

    it('writes one deterministic file per set listing every plugin .mjs sorted', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      vi.mocked(fs.readdir).mockImplementation(async (targetPath: unknown) => {
        const p = toPosix(targetPath);
        if (p === '/cache/cards/1.0.0/plugin') {
          return [fileDirent('user-prompt-submit.mjs'), fileDirent('post-tool-use-skill.mjs')] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >;
        }
        if (p === '/cache/runtime/1.0.0/plugin') {
          return [fileDirent('session-start.mjs')] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
        }
        throw Object.assign(new Error(`mock: unhandled readdir: ${p}`), { code: 'ENOENT' });
      });
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      const { writeCardsLaunchConfig } = await import('../src/lib/opencode-session.js');

      const configPath = await writeCardsLaunchConfig('/staging', 'launch', ['cards', 'runtime'], cachePaths('/cache'));

      expect(toPosix(configPath)).toBe('/staging/cards-launch.config.json');
      expect(vi.mocked(fs.writeFile).mock.calls).toHaveLength(1);
      const written = String(vi.mocked(fs.writeFile).mock.calls[0]![1]);
      const doc = JSON.parse(written) as {
        $schema?: string;
        plugin: string[];
        permission: Record<string, Record<string, string>>;
        skills?: { paths: string[] };
      };
      // Live-verified v1 contract (see writeCardsLaunchConfig): singular
      // `plugin`, nested `permission` record, legacy `skills` object — and
      // nothing else.
      expect(Object.keys(doc).sort()).toEqual(['$schema', 'permission', 'plugin', 'skills']);
      expect(doc.plugin).toEqual([
        '/cache/cards/1.0.0/plugin/post-tool-use-skill.mjs',
        '/cache/cards/1.0.0/plugin/user-prompt-submit.mjs',
        '/cache/runtime/1.0.0/plugin/session-start.mjs'
      ]);
      expect(doc.permission).toEqual({ '*': { '*': 'allow' } });
      expect(doc.skills).toEqual({
        paths: ['/cache/cards/1.0.0/skills', '/cache/runtime/1.0.0/skills']
      });

      // Deterministic: an identical second call produces identical bytes.
      const firstBytes = written;
      vi.mocked(fs.writeFile).mockClear();
      await writeCardsLaunchConfig('/staging', 'launch', ['cards', 'runtime'], cachePaths('/cache'));
      expect(String(vi.mocked(fs.writeFile).mock.calls[0]![1])).toBe(firstBytes);
    });

    it('uses one file per set: the assistant set lands in its own document', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      const { writeCardsLaunchConfig } = await import('../src/lib/opencode-session.js');

      const assistantPath = await writeCardsLaunchConfig('/staging', 'assistant', ['cards'], {
        cards: '/cache/cards/1.0.0'
      });
      expect(toPosix(assistantPath)).toBe('/staging/cards-assistant.config.json');
      const targets = vi.mocked(fs.writeFile).mock.calls.map((call) => toPosix(call[0]));
      expect(targets.every((target) => target.includes('cards-assistant.config.json'))).toBe(true);
    });

    it('skips the write entirely when the on-disk file already holds these exact bytes', async () => {
      const fs = await import('node:fs/promises');
      let payload: string | null = null;
      vi.mocked(fs.writeFile).mockImplementation(async (_filePath, data) => {
        payload = String(data);
        return undefined;
      });
      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        if (payload !== null && toPosix(filePath) === '/staging/cards-assistant.config.json') {
          return payload;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      const { writeCardsLaunchConfig } = await import('../src/lib/opencode-session.js');

      await writeCardsLaunchConfig('/staging', 'assistant', ['cards'], { cards: '/cache/cards/1.0.0' });
      expect(payload).not.toBeNull();

      vi.mocked(fs.writeFile).mockClear();
      vi.mocked(fs.rename).mockClear();
      await writeCardsLaunchConfig('/staging', 'assistant', ['cards'], { cards: '/cache/cards/1.0.0' });

      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
    });

    it('publishes atomically via a sibling temp file rename', async () => {
      const fs = await import('node:fs/promises');
      vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      const { writeCardsLaunchConfig } = await import('../src/lib/opencode-session.js');

      await writeCardsLaunchConfig('/staging', 'launch', ['cards'], { cards: '/cache/cards/1.0.0' });

      const renames = vi.mocked(fs.rename).mock.calls.map((call) => [toPosix(call[0]), toPosix(call[1])]);
      expect(renames).toHaveLength(1);
      expect(renames[0]![0]).toMatch(/^\/staging\/\.config-write-[^/]+\/cards-launch\.config\.json$/);
      expect(renames[0]![1]).toBe('/staging/cards-launch.config.json');
    });

    it('fails closed when an enabled plugin has no cache path', async () => {
      const { writeCardsLaunchConfig } = await import('../src/lib/opencode-session.js');

      await expect(writeCardsLaunchConfig('/staging', 'launch', ['cards', 'runtime'], {})).rejects.toThrow(/cards/);
    });
  });

  describe('buildOpencodeArgs', () => {
    it('interactive mode boots the TUI: --prompt <composed> <worktree>', async () => {
      const { buildOpencodeArgs } = await import('../src/lib/opencode-session.js');

      expect(buildOpencodeArgs('do the thing', '/wt', 'card-123', undefined, 'interactive')).toEqual([
        '--prompt',
        'do the thing',
        '/wt'
      ]);
      // Prompt-less interactive sessions still target the worktree positional.
      expect(buildOpencodeArgs(undefined, '/wt', 'card-123', undefined, 'interactive')).toEqual(['/wt']);
    });

    it('background mode pins the headless run contract: run --dir <worktree> --title <cardId> [prompt…]', async () => {
      const { buildOpencodeArgs } = await import('../src/lib/opencode-session.js');

      expect(buildOpencodeArgs('do the thing', '/wt', 'card-123', undefined, 'background')).toEqual([
        'run',
        '--dir',
        '/wt',
        '--title',
        'card-123',
        'do the thing'
      ]);
      // Prompt-less background sessions pass no positionals after --title.
      expect(buildOpencodeArgs(undefined, '/wt', 'card-123', undefined, 'background')).toEqual([
        'run',
        '--dir',
        '/wt',
        '--title',
        'card-123'
      ]);
    });

    it('prepends appendSystemPrompt ahead of the prompt for both modes', async () => {
      const { buildOpencodeArgs } = await import('../src/lib/opencode-session.js');

      const interactive = buildOpencodeArgs('do the thing', '/wt', 'card-123', 'ROUTING SKILL', 'interactive');
      expect(interactive).toEqual(['--prompt', 'ROUTING SKILL\n\ndo the thing', '/wt']);
      // Guidance alone still yields a single composed turn.
      expect(buildOpencodeArgs(undefined, '/wt', 'card-123', 'ROUTING SKILL', 'interactive')).toEqual([
        '--prompt',
        'ROUTING SKILL',
        '/wt'
      ]);

      const background = buildOpencodeArgs('do the thing', '/wt', 'card-123', 'ROUTING SKILL', 'background');
      expect(background.slice(0, 5)).toEqual(['run', '--dir', '/wt', '--title', 'card-123']);
      expect(background.slice(5)).toEqual(['ROUTING SKILL\n\ndo the thing']);
    });
  });

  describe('spawnOpencodeSession', () => {
    const originalFetch = globalThis.fetch;

    /**
     * Wires the tiered package.json manifest mock shared by the spawn-flow
     * tests: source, staged (`.plugin-install-*`, served in install order),
     * and published manifest locations all resolve.
     *
     * @param fs - The mocked node:fs/promises module.
     */
    function mockManifestReads(fs: typeof import('node:fs/promises')): void {
      let stagedReadIndex = 0;
      const stagedPluginNames = ['cards', 'runtime'];
      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        const p = toPosix(filePath);
        if (p.endsWith('.cards-content-hash')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (p.endsWith('/package.json')) {
          if (p.includes('.plugin-install-')) {
            const name = stagedPluginNames[stagedReadIndex++];
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
    }

    beforeEach(async () => {
      vi.clearAllMocks();
      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
      process.env['API_TEST_MODE'] = '1';
      delete process.env['CARDS_HOME'];
      delete process.env['XDG_CONFIG_HOME'];

      const fs = await import('node:fs/promises');

      // API: workspace discovery + branches
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

      // Git commands + binary probe (`which opencode`)
      const { execFile } = await import('node:child_process');
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

      // Worktree
      const { findGitRoots, checkWorktreeExists, createWorktree } = await import('@cards.management/sdk/worktree');
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

      const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
      vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) =>
        createWorktree(ref, {
          cwd: opts.cwd,
          cardId: opts.cardId,
          compiledScriptPaths: opts.compiledScriptPaths
        })
      );

      // Plugin cache: everything resolves; empty plugin dirs (no .mjs entries).
      vi.mocked(fs.access).mockResolvedValue(undefined);
      mockManifestReads(fs);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      vi.mocked(fs.cp).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.rm).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockImplementation(async () => [] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
      vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      // Card-repo AGENTS.md for the opening-turn composition
      const syncFs = await import('node:fs');
      vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
        if (toPosix(filePath) === '/test/repo/AGENTS.md') {
          return '# Card Repo Reference\n';
        }
        throw Object.assign(new Error(`mock: unhandled readFileSync: ${String(filePath)}`), { code: 'ENOENT' });
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
        codingAgent: 'opencode-cli',
        ...overrides
      };
    }

    it('resolves instead of hanging when the child fails to spawn (ENOENT)', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnOpencodeSession } = await import('../src/lib/opencode-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const promise = spawnOpencodeSession(baseInput(), createMockContext(), {});
      await flushMicrotasks();

      child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }));
      await expect(promise).resolves.toBeUndefined();
    });

    it('spawns opencode run with worktree argv, OPENCODE_CONFIG, and card env vars', async () => {
      const { spawn } = await import('node:child_process');
      const fs = await import('node:fs/promises');
      const { spawnOpencodeSession } = await import('../src/lib/opencode-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const context = createMockContext();
      const promise = spawnOpencodeSession(baseInput(), context, {
        prompt: 'Load the `card` skill.'
      });
      await flushMicrotasks();

      const calls = vi.mocked(spawn).mock.calls;
      expect(calls).toHaveLength(1);
      // The launcher resolves the binary once (PATH probe here) and spawns the
      // absolute path, so a PATH-less child environment can never turn the
      // verified install into a spawn ENOENT.
      expect(calls[0]![0]).toBe('/usr/bin/opencode');
      const args = calls[0]![1] as string[];
      // Interactive dispatch boots the TUI seeded with the composed turn.
      expect(args[0]).toBe('--prompt');
      expect(args[args.length - 1]).toBe('/test/workspace/.worktrees/cards/card-123/1');
      // The card-repo AGENTS.md leads the composed opening turn; the caller
      // prompt closes it.
      const openingTurn = args[1]!;
      expect(openingTurn).toContain('# Card Repo Reference');
      expect(openingTurn.endsWith('Load the `card` skill.')).toBe(true);

      const opts = calls[0]![2] as { cwd: string; stdio: string; env: Record<string, string | undefined> };
      expect(opts.cwd).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(opts.stdio).toBe('inherit');
      expect(opts.env.WORKSPACE_PATH).toBe('/test/workspace/.worktrees/cards/card-123/1');
      expect(opts.env.BASE_BRANCH).toBe('main');
      expect(opts.env.PARENT_BRANCH).toBe('main');
      expect(opts.env.WORKSPACE_BRANCH).toBe('cards/card-123/1');
      // A staged config document is passed via OPENCODE_CONFIG (never
      // CODEX_HOME-style replacement), written under the Cards home staging
      // dir — never into the user's OpenCode config dir.
      const stagedConfig = String(opts.env.OPENCODE_CONFIG);
      expect(stagedConfig.startsWith(`${toPosix(CARDS_OPENCODE_STAGING_DIR)}/`)).toBe(true);
      expect(stagedConfig.endsWith('cards-launch.config.json')).toBe(true);
      const launchConfigWrites = vi
        .mocked(fs.writeFile)
        .mock.calls.map((call) => toPosix(call[0]))
        .filter((target) => target.includes('cards-launch.config.json'));
      expect(launchConfigWrites.length).toBeGreaterThan(0);
      expect(launchConfigWrites.every((target) => target.startsWith(`${toPosix(CARDS_OPENCODE_STAGING_DIR)}/`))).toBe(
        true
      );
      expect(launchConfigWrites.every((target) => !target.startsWith(toPosix(DEFAULT_OPENCODE_CONFIG_DIR)))).toBe(true);

      child.emit('close', 0);
      await promise;
    });

    it('sets EXIT_WHEN_DONE=false in child env when suppressExitWhenDone is true', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnOpencodeSession } = await import('../src/lib/opencode-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const promise = spawnOpencodeSession(baseInput({ actionName: 'Chat' }), createMockContext(), {
        suppressExitWhenDone: true
      });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string | undefined> };
      expect(spawnOpts.env.EXIT_WHEN_DONE).toBe('false');

      child.emit('close', 0);
      await promise;
    });

    it('registers onCancel that terminates the owned process tree and runs the branch-cleanup watcher after exit', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnOpencodeSession } = await import('../src/lib/opencode-session.js');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);
      // Termination now goes through createOpencodeTerminationController,
      // which signals the launcher-owned process group (-pid) rather than
      // calling child.kill directly — see opencode-termination.ts. The group
      // "exits" (ESRCH on the existence probe) as soon as SIGTERM is sent,
      // simulating a cooperative child.
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
      const promise = spawnOpencodeSession(baseInput(), context, {});
      await flushMicrotasks();

      const onCancel = vi.mocked(context.onCancel).mock.calls[0][0] as () => Promise<void>;
      await onCancel();
      expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

      child.emit('close', 0);
      await promise;

      const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
      expect(spawnBranchCleanupWatcher).toHaveBeenCalledWith(
        { cardId: 'card-123', repoRoot: '/test/workspace', cardRepoPath: '/test/repo' },
        expect.anything(),
        expect.anything()
      );

      killSpy.mockRestore();
    });

    it('fails closed before staging when the opencode binary is absent', async () => {
      const { execFile } = await import('node:child_process');
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        if (typeof cb === 'function') {
          cb(new Error('not found'));
        }
        return {} as ReturnType<typeof execFile>;
      });
      const fs = await import('node:fs/promises');
      // The well-known-location fallback must also miss for the probe to fail.
      vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const { spawn } = await import('node:child_process');
      const { spawnOpencodeSession } = await import('../src/lib/opencode-session.js');

      await expect(spawnOpencodeSession(baseInput(), createMockContext(), {})).rejects.toThrow(/opencode/i);
      expect(spawn).not.toHaveBeenCalled();
      // No staging happened before the probe failed.
      expect(vi.mocked(fs.cp)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    });

    it('spawns the well-known installer location when which fails but <home>/.opencode/bin/opencode exists', async () => {
      const { execFile } = await import('node:child_process');
      // Fail ONLY the PATH probe; later flow steps (git) still succeed so the
      // launch proceeds far enough to reach the spawn.
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1];
        const cmd = args[0] as string;
        const cmdArgs = args[1] as string[];
        const key = `${cmd} ${cmdArgs.join(' ')}`;
        if (typeof cb === 'function') {
          if (key === `${process.platform === 'win32' ? 'where' : 'which'} opencode`) {
            cb(new Error('not found'));
          } else if (key.startsWith('git rev-parse --abbrev-ref HEAD')) {
            cb(null, { stdout: 'main\n', stderr: '' });
          } else {
            cb(new Error(`mock: unhandled command: ${key}`));
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      const fs = await import('node:fs/promises');
      // With the PATH probe failing, the resolver's very next check is the
      // well-known installer location; let every fs.access succeed so the rest
      // of the launch flow (plugin-cache staging) proceeds as in the happy
      // path. Spawning the computed candidate proves the fallback resolved.
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const { spawn } = await import('node:child_process');
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);
      const { spawnOpencodeSession } = await import('../src/lib/opencode-session.js');

      // Mirror the resolver's candidate computation (production uses the real
      // os.homedir()).
      const wellKnownBinary = join(homedir(), '.opencode', 'bin', 'opencode');

      const context = createMockContext();
      const promise = spawnOpencodeSession(baseInput(), context, { prompt: 'Load the `card` skill.' });
      await flushMicrotasks();

      const calls = vi.mocked(spawn).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(wellKnownBinary);

      child.emit('close', 0);
      await promise;
    });
  });
});

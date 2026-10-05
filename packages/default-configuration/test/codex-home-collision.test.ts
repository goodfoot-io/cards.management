/**
 * Concurrency and atomicity coverage for `populateCodexPluginCache`.
 *
 * The cache-install path replaces the staged-home copy: each bundled plugin is
 * staged in an OS-unique `mkdtemp` dir under `plugins/cache/local/` and published
 * into its own manifest-version slot `plugins/cache/local/<plugin>/<version>`
 * with a single atomic rename. A published slot is never moved or removed, so
 * concurrent launches against one `$CODEX_HOME` cannot move a slot out from under
 * another's read — the FM-1 race the old shared-`local` step-aside introduced.
 * These tests run against a real filesystem sandbox: `node:fs/promises` is
 * wrapped so every call delegates to the real implementation while recording its
 * arguments, so the assertions exercise the production move sequence, not a stub.
 *
 * @summary Tests concurrent populateCodexPluginCache cache installs
 */

import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wrap `node:fs/promises` so every call delegates to the real implementation
 * while recording its arguments. ESM forbids `vi.spyOn` on module exports, so
 * the module is mocked with real-backed spies — no behavior is stubbed.
 */
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const wrapped = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(actual)) {
    wrapped[key] = typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value;
  }
  return wrapped;
});

/**
 * Production code builds paths with node:path, so on Windows the values passed
 * to fs spies use backslash separators. Normalize to forward slashes so the
 * POSIX suffix checks below match regardless of platform.
 *
 * @param p - Path-like value (string, Buffer, or URL) to normalize.
 * @returns The value stringified with backslashes converted to forward slashes.
 */
function toPosix(p: unknown): string {
  return String(p).replace(/\\/g, '/');
}

let fs: typeof import('node:fs/promises');
let sandbox: string;
let codexHome: string;
let marketplacePath: string;
const savedEnv: Record<string, string | undefined> = {};

const PLUGIN_VERSIONS = {
  cards: 'cards-test-version',
  runtime: 'runtime-test-version'
} as const;

/**
 * Writes a JSON file, creating parent directories as needed.
 *
 * @param filePath - Absolute path to write.
 * @param value - Value serialized as JSON.
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

beforeEach(async () => {
  fs = await import('node:fs/promises');
  vi.clearAllMocks();

  for (const key of ['CODEX_HOME', 'CARDS_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  sandbox = await fs.mkdtemp(path.join(tmpdir(), 'codex-collision-'));

  // A real marketplace bundle that satisfies ensureCodexBundleAvailable().
  // bundlePath = dirname(marketplacePath)/codex
  marketplacePath = path.join(sandbox, 'marketplace');
  const bundlePath = path.join(sandbox, 'codex');
  await writeJson(path.join(bundlePath, '.agents', 'plugins', 'marketplace.json'), { name: 'local' });
  await writeJson(path.join(bundlePath, 'cards', '.codex-plugin', 'plugin.json'), {
    name: 'cards',
    version: PLUGIN_VERSIONS.cards
  });
  await writeJson(path.join(bundlePath, 'runtime', '.codex-plugin', 'plugin.json'), {
    name: 'runtime',
    version: PLUGIN_VERSIONS.runtime
  });

  codexHome = path.join(sandbox, 'codexhome');
  process.env['CODEX_HOME'] = codexHome;
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/**
 * Asserts the cache holds a valid manifest for `pluginName` at the exact
 * version-segmented load path
 * `<codexHome>/plugins/cache/local/<plugin>/<version>/.codex-plugin/plugin.json`.
 *
 * @param pluginName - Bundled plugin name to verify.
 * @param version - Version segment expected for that plugin.
 */
async function expectCachedManifest(pluginName: 'cards' | 'runtime', version: string): Promise<void> {
  const manifestPath = path.join(
    codexHome,
    'plugins',
    'cache',
    'local',
    pluginName,
    version,
    '.codex-plugin',
    'plugin.json'
  );
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as { name: string; version: string };
  expect(manifest).toEqual({ name: pluginName, version });
}

describe('populateCodexPluginCache concurrency and atomicity', () => {
  it('concurrent populateCodexPluginCache calls both succeed and produce the same cache', async () => {
    const { populateCodexPluginCache } = await import('../src/lib/codex-session.js');

    const [result1, result2] = await Promise.all([
      populateCodexPluginCache(codexHome, marketplacePath),
      populateCodexPluginCache(codexHome, marketplacePath)
    ]);

    // Both calls resolve and resolve the same version-segmented load paths.
    for (const result of [result1, result2]) {
      expect(result.pluginCachePaths['cards']).toBe(
        path.join(codexHome, 'plugins', 'cache', 'local', 'cards', PLUGIN_VERSIONS.cards)
      );
      expect(result.pluginCachePaths['runtime']).toBe(
        path.join(codexHome, 'plugins', 'cache', 'local', 'runtime', PLUGIN_VERSIONS.runtime)
      );
    }

    // Each plugin is staged in an mkdtemp dir under the marketplace dir, then
    // copied there (a sibling of the scanned base root) before publication.
    const cpDestinations = vi.mocked(fs.cp).mock.calls.map((call) => toPosix(call[1]));
    expect(
      cpDestinations.some((dest) =>
        new RegExp(`/plugins/cache/local/\\.plugin-install-[^/]+/${PLUGIN_VERSIONS.cards}$`).test(dest)
      )
    ).toBe(true);
    expect(
      cpDestinations.some((dest) =>
        new RegExp(`/plugins/cache/local/\\.plugin-install-[^/]+/${PLUGIN_VERSIONS.runtime}$`).test(dest)
      )
    ).toBe(true);

    // The shared cache ends with valid manifests at the load paths, and no
    // staging dir is left behind.
    await expectCachedManifest('cards', PLUGIN_VERSIONS.cards);
    await expectCachedManifest('runtime', PLUGIN_VERSIONS.runtime);
    for (const pluginName of ['cards', 'runtime'] as const) {
      const baseRoot = path.join(codexHome, 'plugins', 'cache', 'local', pluginName);
      const siblings = await fs.readdir(baseRoot);
      expect(siblings).toEqual([PLUGIN_VERSIONS[pluginName]]);
    }
    const marketplaceEntries = await fs.readdir(path.join(codexHome, 'plugins', 'cache', 'local'));
    expect(marketplaceEntries.filter((entry) => entry.startsWith('.plugin-install-'))).toEqual([]);
  });

  it('publishes each plugin into its version slot with a single atomic rename', async () => {
    const { populateCodexPluginCache } = await import('../src/lib/codex-session.js');

    await populateCodexPluginCache(codexHome, marketplacePath);

    // The publish rename lands each plugin at plugins/cache/local/<plugin>/<version>.
    const renameDestinations = vi.mocked(fs.rename).mock.calls.map((call) => toPosix(call[1]));
    expect(renameDestinations).toContain(
      toPosix(path.join(codexHome, 'plugins', 'cache', 'local', 'cards', PLUGIN_VERSIONS.cards))
    );
    expect(renameDestinations).toContain(
      toPosix(path.join(codexHome, 'plugins', 'cache', 'local', 'runtime', PLUGIN_VERSIONS.runtime))
    );

    await expectCachedManifest('cards', PLUGIN_VERSIONS.cards);
    await expectCachedManifest('runtime', PLUGIN_VERSIONS.runtime);
  });

  it('a higher bundle version supersedes and prunes the older slot', async () => {
    const { populateCodexPluginCache } = await import('../src/lib/codex-session.js');

    // First launch installs the current versions.
    await populateCodexPluginCache(codexHome, marketplacePath);

    // Simulate an extension upgrade: the bundle now ships a higher cards version.
    const upgraded = 'cards-test-version-z';
    await writeJson(path.join(sandbox, 'codex', 'cards', '.codex-plugin', 'plugin.json'), {
      name: 'cards',
      version: upgraded
    });

    const result = await populateCodexPluginCache(codexHome, marketplacePath);

    // The new launch resolves to the higher version slot...
    expect(result.pluginCachePaths['cards']).toBe(path.join(codexHome, 'plugins', 'cache', 'local', 'cards', upgraded));
    await expectCachedManifest('cards', upgraded);

    // ...and the strictly-older slot is pruned, leaving only the current one.
    const cardsBaseRoot = path.join(codexHome, 'plugins', 'cache', 'local', 'cards');
    const remaining = await fs.readdir(cardsBaseRoot);
    expect(remaining).toEqual([upgraded]);
  });
});

/**
 * Exercises Codex session library helpers through focused scenarios.
 * The cases lock in context assembly, config merging, Codex-skill translation,
 * and AGENTS.md composition so refactors do not drift the packaged Codex
 * runtime contract.
 *
 * @summary Tests Codex session library helpers
 */

import type { ChildProcess } from 'node:child_process';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { flushMicrotasks } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Bundled hook definitions, imported as JSON modules (not via the mocked
// `node:fs`) so the trust-seeding tests below feed production code the real
// command strings the ground-truth hashes were captured from.
import assistantHooksJson from '../../../codex/cards-assistant/hooks/hooks.json';
import runtimeHooksJson from '../../../codex/runtime/hooks/hooks.json';

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

const TEST_CODEX_PLUGIN_VERSIONS = {
  cards: 'cards-test-version',
  runtime: 'runtime-test-version'
} as const;

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
  findGitRoots: vi.fn(),
  checkWorktreeExists: vi.fn(),
  createWorktree: vi.fn()
}));

vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

beforeEach(async () => {
  vi.clearAllMocks();
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['API_TEST_MODE'] = '1';
  delete process.env['CODEX_HOME'];
  delete process.env['CARDS_HOME'];
  delete process.env['XDG_DATA_HOME'];
  delete process.env['XDG_CONFIG_HOME'];

  const fs = await import('node:fs/promises');
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env['API_TEST_MODE'];
});

describe('codex-session library', () => {
  /**
   * Wires the fs mocks needed for a successful `populateCodexPluginCache` run:
   * bundle/plugin paths resolve, manifests parse, and all writes succeed.
   *
   * @returns The mocked `node:fs/promises` module for per-test assertions.
   */
  async function mockSuccessfulCacheFs(): Promise<typeof import('node:fs/promises')> {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = toPosix(filePath);
      // Plugin manifests resolve for bundle, staged, and published load paths.
      if (
        p.endsWith('.codex-plugin/plugin.json') &&
        (/(^|\/)cards\//.test(p) || p.includes(`/${TEST_CODEX_PLUGIN_VERSIONS.cards}/`))
      ) {
        return JSON.stringify({ name: 'cards', version: TEST_CODEX_PLUGIN_VERSIONS.cards });
      }
      if (
        p.endsWith('.codex-plugin/plugin.json') &&
        (/(^|\/)runtime\//.test(p) || p.includes(`/${TEST_CODEX_PLUGIN_VERSIONS.runtime}/`))
      ) {
        return JSON.stringify({ name: 'runtime', version: TEST_CODEX_PLUGIN_VERSIONS.runtime });
      }
      if (p.endsWith('marketplace.json')) {
        return JSON.stringify({ name: 'local' });
      }
      throw Object.assign(new Error(`mock: unhandled readFile: ${String(filePath)}`), { code: 'ENOENT' });
    });
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    // mkdtemp returns the staging dir the install renames its version child out of.
    vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
    vi.mocked(fs.cp).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    // No sibling version dirs to prune in the unit fixture.
    vi.mocked(fs.readdir).mockResolvedValue([]);
    return fs;
  }

  it('buildCodexArgs enables plugins via --profile, not -c plugin flags', async () => {
    const { buildCodexArgs } = await import('../src/lib/codex-session.js');

    const args = buildCodexArgs('do the thing', '/test/workspace', '/test/repo', 'be helpful', 'interactive');

    // Enablement is supplied by the Cards profile-v2 layer, selected here.
    expect(args[args.indexOf('--profile') + 1]).toBe('cards');

    // The retired runtime per-plugin / features -c flags must be gone — they
    // landed in the SessionFlags layer and never enabled the plugins.
    const cFlagValues = args.filter((_arg, index) => args[index - 1] === '-c');
    expect(cFlagValues).not.toContain('features.plugins=true');
    expect(cFlagValues.some((value) => value.startsWith('plugins.'))).toBe(false);

    // Existing args are preserved.
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args[args.indexOf('--cd') + 1]).toBe('/test/workspace');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/test/repo');
    // developer_instructions is still injected via -c.
    expect(cFlagValues.some((value) => value.startsWith('developer_instructions'))).toBe(true);
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('buildCodexArgs selects codex exec for background mode', async () => {
    const { buildCodexArgs } = await import('../src/lib/codex-session.js');

    const args = buildCodexArgs('do the thing', '/test/workspace', '/test/repo', undefined, 'background');

    expect(args[0]).toBe('exec');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('readCardRepoAgentsMd returns the trimmed AGENTS.md contents', async () => {
    const syncFs = await import('node:fs');
    vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
      if (toPosix(filePath) === '/test/repo/AGENTS.md') {
        return '\n\n# Card Repository Reference\n\nCommit everything that must persist.\n\n';
      }
      throw Object.assign(new Error(`mock: unhandled readFileSync: ${String(filePath)}`), { code: 'ENOENT' });
    });
    const { readCardRepoAgentsMd } = await import('../src/lib/codex-session.js');

    expect(readCardRepoAgentsMd('/test/repo')).toBe(
      '# Card Repository Reference\n\nCommit everything that must persist.'
    );
  });

  it('readCardRepoAgentsMd fails closed when AGENTS.md is unreadable', async () => {
    const syncFs = await import('node:fs');
    vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
      throw Object.assign(new Error(`ENOENT: ${String(filePath)}`), { code: 'ENOENT' });
    });
    const { readCardRepoAgentsMd, CardRepoAccessError } = await import('../src/lib/codex-session.js');

    expect(() => readCardRepoAgentsMd('/test/repo')).toThrow(CardRepoAccessError);
  });

  it('composeDeveloperInstructions orders fragments and drops empty ones', async () => {
    const { composeDeveloperInstructions } = await import('../src/lib/codex-session.js');

    // Card-repo AGENTS.md leads; caller guidance follows.
    expect(composeDeveloperInstructions(['AGENTS', 'SKILL'])).toBe('AGENTS\n\nSKILL');
    // Whitespace is trimmed and blank/undefined fragments are skipped.
    expect(composeDeveloperInstructions(['  AGENTS  ', undefined, '', '   ', 'SKILL'])).toBe('AGENTS\n\nSKILL');
    // A single surviving fragment is returned without a separator.
    expect(composeDeveloperInstructions([undefined, 'AGENTS'])).toBe('AGENTS');
    // All-empty input collapses to undefined so no -c flag is emitted.
    expect(composeDeveloperInstructions([undefined, '   '])).toBeUndefined();
    expect(composeDeveloperInstructions([])).toBeUndefined();
  });

  it('writeCodexProfileConfig writes the enablement profile without touching config.toml', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    const profilePath = await writeCodexProfileConfig('/test/codexhome');

    expect(toPosix(profilePath)).toBe('/test/codexhome/cards.config.toml');
    const writes = vi.mocked(fs.writeFile).mock.calls.map((call) => toPosix(call[0]));
    expect(writes).toEqual(['/test/codexhome/cards.config.toml']);
    // The user's own config.toml is never written.
    expect(writes).not.toContain('/test/codexhome/config.toml');
    const written = String(vi.mocked(fs.writeFile).mock.calls[0]![1]);
    expect(written).toContain('[features]');
    expect(written).toContain('plugins = true');
    expect(written).toContain('[plugins."cards@local"]');
    expect(written).toContain('[plugins."runtime@local"]');
    expect(written).toContain('enabled = true');
  });

  it('writeCodexProfileConfig fails closed on a legacy profile collision', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockResolvedValue('[profiles.cards]\nmodel = "x"\n');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    await expect(writeCodexProfileConfig('/test/codexhome')).rejects.toThrow(/legacy/i);
    // It must not write the profile when codex would reject the launch.
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('writeCodexProfileConfig writes the assistant profile enabling cards + cards-assistant, not runtime', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    const profilePath = await writeCodexProfileConfig('/test/codexhome', {
      profileName: 'cards-assistant',
      pluginNames: ['cards', 'cards-assistant']
    });

    // The assistant profile lands in its own <home>/cards-assistant.config.toml file.
    expect(toPosix(profilePath)).toBe('/test/codexhome/cards-assistant.config.toml');
    const writes = vi.mocked(fs.writeFile).mock.calls.map((call) => toPosix(call[0]));
    expect(writes).toEqual(['/test/codexhome/cards-assistant.config.toml']);

    const written = String(vi.mocked(fs.writeFile).mock.calls[0]![1]);
    expect(written).toContain('[features]');
    expect(written).toContain('plugins = true');
    expect(written).toContain('[plugins."cards@local"]');
    expect(written).toContain('[plugins."cards-assistant@local"]');
    expect(written).toContain('enabled = true');
    // The assistant session must NOT enable the runtime plugin.
    expect(written).not.toContain('runtime@local');
  });

  it('writeCodexProfileConfig seeds hooks.state from the runtime bundle hooks.json', async () => {
    const runtimeHooks = JSON.stringify(runtimeHooksJson);
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = toPosix(filePath);
      if (p.endsWith('/config.toml')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (p === '/cache/runtime/hooks/hooks.json') {
        return runtimeHooks;
      }
      throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    await writeCodexProfileConfig('/test/codexhome', {
      pluginCachePaths: { cards: '/cache/cards', runtime: '/cache/runtime' }
    });

    const written = String(vi.mocked(fs.writeFile).mock.calls[0]![1]);
    // All five runtime keys/hashes land as top-level [hooks.state."…"] tables.
    expect(written).toContain(
      '[hooks.state."runtime@local:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:21d730d0414d7091677bd53ef201c488c18439fc3ac718785df55646241eaae8"'
    );
    expect(written).toContain('"runtime@local:hooks/hooks.json:session_start:1:0"');
    expect(written).toContain('sha256:6146bc10073c31e58aa110b6221c8876f1111120ff014cb6382dc556e27e38a9');
    expect(written).toContain('"runtime@local:hooks/hooks.json:subagent_start:0:0"');
    expect(written).toContain('sha256:0bd046db0832f7f396d80a6c048087a24b2d17ed59c9d6113ef07c02f3bf8fdd');
    expect(written).toContain('"runtime@local:hooks/hooks.json:subagent_stop:0:0"');
    expect(written).toContain('sha256:66e82567070ae6fb22862a19bcdb46ef3bd4517dca31c385705baf6e9aa56c99');
    expect(written).toContain('"runtime@local:hooks/hooks.json:stop:0:0"');
    expect(written).toContain('sha256:295405e4ed87f8b94dbe4959dd53247b1f0de243566a5926292fd56de2ba4f23');
    // No bypass flag is involved — trust comes entirely from the profile.
    expect(written).not.toContain('bypass');
  });

  it('writeCodexProfileConfig seeds only the assistant bundle, never runtime, for the assistant profile', async () => {
    const assistantHooks = JSON.stringify(assistantHooksJson);
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = toPosix(filePath);
      if (p.endsWith('/config.toml')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (p === '/cache/cards-assistant/hooks/hooks.json') {
        return assistantHooks;
      }
      throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    await writeCodexProfileConfig('/test/codexhome', {
      profileName: 'cards-assistant',
      pluginNames: ['cards', 'cards-assistant'],
      pluginCachePaths: { cards: '/cache/cards', 'cards-assistant': '/cache/cards-assistant' }
    });

    const written = String(vi.mocked(fs.writeFile).mock.calls[0]![1]);
    expect(written).toContain(
      '[hooks.state."cards-assistant@local:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:21d730d0414d7091677bd53ef201c488c18439fc3ac718785df55646241eaae8"'
    );
    // The assistant profile must never carry runtime trust entries.
    expect(written).not.toContain('runtime@local');
  });

  it('writeCodexProfileConfig writes no hooks.state when no enabled plugin ships hooks.json', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = toPosix(filePath);
      if (p.endsWith('/config.toml')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      // No hooks.json on disk for the enabled plugin → fall through to ENOENT.
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    await writeCodexProfileConfig('/test/codexhome', {
      pluginNames: ['cards'],
      pluginCachePaths: { cards: '/cache/cards' }
    });

    const written = String(vi.mocked(fs.writeFile).mock.calls[0]![1]);
    expect(written).not.toContain('hooks.state');
  });

  it('writeCodexProfileConfig fails closed with a path-named error on a malformed bundle hooks.json', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
      const p = toPosix(filePath);
      if (p.endsWith('/config.toml')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      // The bundle hooks.json is present but corrupt (truncated JSON).
      if (p === '/cache/runtime/hooks/hooks.json') {
        return '{ "hooks": ';
      }
      throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    const promise = writeCodexProfileConfig('/test/codexhome', {
      pluginCachePaths: { cards: '/cache/cards', runtime: '/cache/runtime' }
    });
    // The error names the offending path and identifies a bundle-integrity failure.
    // Match either separator: the path is built with path.join, so it carries
    // native separators (`\` on Windows, `/` on POSIX).
    await expect(promise).rejects.toThrow(/[\\/]cache[\\/]runtime[\\/]hooks[\\/]hooks\.json/);
    await expect(promise).rejects.toThrow(/Corrupt Cards bundle/i);
    // A corrupt bundle must abort the launch, not write a profile.
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('writeCodexProfileConfig fails closed on a legacy collision with the assistant profile name', async () => {
    const fs = await import('node:fs/promises');
    // A legacy [profiles.cards-assistant] table is present, but no [profiles.cards].
    vi.mocked(fs.readFile).mockResolvedValue('[profiles.cards-assistant]\nmodel = "x"\n');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const { writeCodexProfileConfig } = await import('../src/lib/codex-session.js');

    await expect(
      writeCodexProfileConfig('/test/codexhome', {
        profileName: 'cards-assistant',
        pluginNames: ['cards', 'cards-assistant']
      })
    ).rejects.toThrow(/cards-assistant/);
    // It must not write the profile when codex would reject the launch.
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('populateCodexPluginCache respects CODEX_HOME env override', async () => {
    process.env['CODEX_HOME'] = '/alt/home';
    const fs = await mockSuccessfulCacheFs();
    const { populateCodexPluginCache, resolveDefaultCodexHome } = await import('../src/lib/codex-session.js');

    await populateCodexPluginCache(resolveDefaultCodexHome(), '/test/extension/dist/marketplace');

    const cpDestinations = vi.mocked(fs.cp).mock.calls.map((call) => toPosix(call[1]));
    expect(cpDestinations.length).toBeGreaterThan(0);
    expect(cpDestinations.every((dest) => dest.startsWith('/alt/home/plugins/cache/local/'))).toBe(true);
  });

  it('populateCodexPluginCache does not touch config.toml', async () => {
    const fs = await mockSuccessfulCacheFs();
    const { populateCodexPluginCache } = await import('../src/lib/codex-session.js');

    await populateCodexPluginCache('/test/codexhome', '/test/extension/dist/marketplace');

    // Staging writes only the per-slot content stamp; enablement config
    // (config.toml / <profile>.config.toml) is owned by writeCodexProfileConfig.
    const writeTargets = vi.mocked(fs.writeFile).mock.calls.map((call) => toPosix(call[0]));
    expect(writeTargets.every((target) => target.endsWith('/.cards-content-hash'))).toBe(true);
    expect(writeTargets.some((target) => target.endsWith('.toml'))).toBe(false);
  });

  it('populateCodexPluginCache propagates cache-write errors (fail closed)', async () => {
    const fs = await mockSuccessfulCacheFs();
    vi.mocked(fs.mkdir).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const { populateCodexPluginCache } = await import('../src/lib/codex-session.js');

    await expect(populateCodexPluginCache('/test/codexhome', '/test/extension/dist/marketplace')).rejects.toMatchObject(
      {
        code: 'EACCES'
      }
    );
  });

  it('uses translated Codex skills instead of Claude CLI env vars', async () => {
    const cardsApiSkill = (await import('../../../codex/cards/skills/cards/SKILL.md')).default;
    const notesSkill = (await import('../../../codex/cards/skills/notes/SKILL.md')).default;
    const implementationSkill = (await import('../../../codex/runtime/skills/card/references/implementation.md'))
      .default;
    const blockedSkill = (await import('../../../codex/runtime/skills/card/references/blocked.md')).default;

    expect(cardsApiSkill).not.toContain('$CARD_CLI');
    expect(cardsApiSkill).not.toContain('$NOTIFICATION_CLI');
    expect(cardsApiSkill).not.toContain('$COMPARE_CLI');
    expect(notesSkill).not.toContain('$CARD_CLI');
    expect(implementationSkill).not.toContain('$CREATE_WORKTREE_CLI');
    expect(blockedSkill).not.toContain('$CARD_CLI');
  });

  describe('spawnCodexSession', () => {
    const originalFetch = globalThis.fetch;
    let savedExitWhenDone: string | undefined;

    beforeEach(async () => {
      vi.clearAllMocks();
      process.env['EXTENSION_PATH'] = '/test/extension';
      process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
      process.env['API_TEST_MODE'] = '1';
      process.env['CODEX_HOME'] = '/test/codexhome';
      delete process.env['CARDS_HOME'];
      delete process.env['XDG_DATA_HOME'];
      delete process.env['XDG_CONFIG_HOME'];
      savedExitWhenDone = process.env['EXIT_WHEN_DONE'];

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

      // Git commands: rev-parse for resolveBaseBranch
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

      // createWorktreeForCard forwards to createWorktree mock
      const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
      vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) =>
        createWorktree(ref, {
          cwd: opts.cwd,
          cardId: opts.cardId,
          compiledScriptPaths: opts.compiledScriptPaths
        })
      );

      // Plugin cache: manifests resolve
      vi.mocked(fs.access).mockResolvedValue(undefined);

      // Plugin manifests are read from three locations during populateCodexPluginCache:
      // 1. Source bundle: <bundlePath>/<plugin>/.codex-plugin/plugin.json
      // 2. Staging temp dir: .plugin-install-XXXX/<version>/.codex-plugin/plugin.json
      // 3. Published cache: <plugin>/<version>/.codex-plugin/plugin.json
      // The staging path does not carry the plugin name, so serve manifests in the
      // order installPluginToCache is called (cards first, then runtime).
      let stagingReadIndex = 0;
      const stagingPluginNames = ['cards', 'runtime'];

      vi.mocked(fs.readFile).mockImplementation(async (filePath: unknown) => {
        const p = toPosix(filePath);
        // Staging read (from mkdtemp .plugin-install-XXXX)
        if (p.endsWith('.codex-plugin/plugin.json') && p.includes('.plugin-install-')) {
          const name = stagingPluginNames[stagingReadIndex++];
          if (name === undefined) {
            throw new Error(`Unexpected staging read: ${p}`);
          }
          return JSON.stringify({ name, version: '1.0.0' });
        }
        if (p.endsWith('.codex-plugin/plugin.json') && (/(^|\/)cards\//.test(p) || /\/cards-test-version\//.test(p))) {
          return JSON.stringify({ name: 'cards', version: '1.0.0' });
        }
        if (
          p.endsWith('.codex-plugin/plugin.json') &&
          (/(^|\/)runtime\//.test(p) || /\/runtime-test-version\//.test(p))
        ) {
          return JSON.stringify({ name: 'runtime', version: '1.0.0' });
        }
        if (p.endsWith('marketplace.json')) {
          return JSON.stringify({ name: 'local' });
        }
        if (p.endsWith('/config.toml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error(`mock: unhandled readFile: ${p}`), { code: 'ENOENT' });
      });
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.mkdtemp).mockImplementation(async (prefix: unknown) => `${toPosix(prefix)}XXXXXX`);
      vi.mocked(fs.cp).mockResolvedValue(undefined);
      vi.mocked(fs.rename).mockResolvedValue(undefined);
      vi.mocked(fs.rm).mockResolvedValue(undefined);
      vi.mocked(fs.readdir).mockResolvedValue([]);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      // AGENTS.md for readCardRepoAgentsMd
      const syncFs = await import('node:fs');
      vi.mocked(syncFs.readFileSync).mockImplementation((filePath: string | Buffer | URL) => {
        if (toPosix(filePath) === '/test/repo/AGENTS.md') {
          return '# Card Repo\n';
        }
        throw Object.assign(new Error(`mock: unhandled readFileSync: ${String(filePath)}`), { code: 'ENOENT' });
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env['API_TEST_MODE'];
      delete process.env['CODEX_HOME'];
      if (savedExitWhenDone !== undefined) {
        process.env['EXIT_WHEN_DONE'] = savedExitWhenDone;
      } else {
        delete process.env['EXIT_WHEN_DONE'];
      }
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

    it('sets EXIT_WHEN_DONE=false in child env when suppressExitWhenDone is true', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnCodexSession } = await import('../src/lib/codex-session.js');

      const handlers = new Map<string, (...args: unknown[]) => void>();
      const child = {
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

      vi.mocked(spawn).mockReturnValue(child);

      const input: ActionInput = {
        executionId: 'execution-test',
        worktreeDirective: { kind: 'reuse' },
        cardId: 'card-123',
        actionName: 'Chat',
        environment: 'default',
        executionMode: 'interactive',
        repoRoot: '/test/workspace',
        cardRepoPath: '/test/repo',
        configPath: '/test/config',
        extensionPath: '/test/extension',
        exitWhenDone: true
      };

      const promise = spawnCodexSession(input, createMockContext(), { suppressExitWhenDone: true });
      await flushMicrotasks();

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect(spawnOpts.env.EXIT_WHEN_DONE).toBe('false');

      child.emit('close', 0);
      await promise;
    });
  });
});

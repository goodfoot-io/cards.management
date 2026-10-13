/**
 * Vitest configuration for the default-configuration package.
 *
 * @summary Vitest config — allows serving `.md` assets from the repo root
 * @module vitest.config
 */

import { existsSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

// Repo root — the `.md` assets live at `<root>/public/claude/...`, outside this
// package. Vitest 4 computes its own serve allowlist (`resolveFsAllow`: config
// file dir + workspace root), which covers the repo root, so no explicit
// `server.fs.allow` config is needed or accepted here (`test.server` no longer
// has an `fs` key in vitest 4).
const repoRoot = resolve(__dirname, '../../..');

/**
 * Configures vitest behavior for the package package.
 * Settings are centralized here so tooling and runtime assumptions remain consistent across
 * environments.
 *
 * @summary Vitest logic for package
 */

// Mirror the working `@cards.management/agent-hooks` plugin: no custom
// `resolveId` (returning a raw absolute path there is what makes Vite
// synthesize the broken `C:\@fs\C:\...` URL on Windows). Vite's default
// resolver hands `load` the resolved id; normalize a `/@fs/` prefix and a
// leading-slash-before-drive (`/C:/...`) so `readFileSync` gets a valid path
// on every platform.
const textAssetPlugin = {
  name: 'text-asset-loader',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.endsWith('.md')) {
      return null;
    }
    let filePath = id.replace(/^\/?@fs/, '');
    if (/^\/[A-Za-z]:\//.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return `export default ${JSON.stringify(readFileSync(filePath, 'utf-8'))};`;
  }
};

// vitest's experimental fs module cache (`--experimental.fsModuleCache`, set by
// the vitest-unchanged runner) fetches `/@fs/` ids without the `url[0] !== '/'
// resolveId` stage, so a `.js`-suffixed import whose source is the `.ts` sibling
// (e.g. the sdk's internal `./childProcess.js`) skips vite's `.js`→`.ts`
// probing, and the unmapped id is handed to node's native loader, which cannot
// map extensions ("Cannot find module '/@fs/.../childProcess.js'"). Re-probe the
// sibling source file here so the id resolves to the real `.ts` file regardless
// of which fetch path the cache uses.
const jsToTsSiblingResolve = {
  name: 'js-to-ts-sibling-resolve',
  enforce: 'pre' as const,
  resolveId(id: string, importer: string | undefined) {
    if (!id.endsWith('.js')) {
      return null;
    }
    // The id is either a relative specifier (resolve against the importer) or an
    // already-absolute `/@fs/`/filesystem path.
    const candidate = id.startsWith('/') ? id : importer ? resolve(dirname(importer), id) : id;
    const tsSibling = `${candidate.replace(/^\/@fs/, '').slice(0, -3)}.ts`;
    if (existsSync(tsSibling)) {
      return tsSibling;
    }
    return null;
  }
};

// vitest's experimental fs module cache (`--experimental.fsModuleCache`, set by
// the vitest-unchanged runner) skips the resolveId stage that would otherwise
// let `publicDir: false` (below) prevent Vite's public-directory URL rewrite.
// A relative import that walks outside this package into the sibling `public/`
// workspace root (e.g. `../../../codex/cards-assistant/hooks/hooks.json`,
// which resolves to `<publicRoot>/codex/cards-assistant/hooks/hooks.json`)
// still gets its `<publicRoot>` prefix stripped into a root-absolute
// public-URL id (`/codex/cards-assistant/hooks/hooks.json`) before this
// config's `publicDir: false` is consulted, and that stripped id is then
// handed to node's native loader, which cannot resolve it
// ("Cannot find module '/codex/.../hooks.json'"). Re-map any root-absolute id
// whose stripped-prefix form exists under the `public/` workspace root back
// to the real file.
const publicRoot = resolve(__dirname, '../..');
const publicRootRewrite = {
  name: 'public-root-rewrite',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (!id.startsWith('/') || id.startsWith('/@fs')) {
      return null;
    }
    const candidate = resolve(publicRoot, `.${id}`);
    return existsSync(candidate) ? candidate : null;
  }
};

export default defineConfig({
  // This monorepo's workspace-root directory is literally named `public/`
  // (`<repoRoot>/public/packages/...`). Vite's default `publicDir` detection
  // walks up to that same workspace root and treats it as the static-asset
  // public directory, then rewrites any absolute import that resolves inside
  // it (e.g. `../../../codex/.../hooks.json`, outside this package) into a
  // stripped `/codex/.../hooks.json` public-URL id instead of a loadable
  // module id, breaking the import ("Cannot find module"). There is no dev
  // server here — disable the feature entirely.
  publicDir: false,
  plugins: [textAssetPlugin, jsToTsSiblingResolve, publicRootRewrite],
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/browser/**'],
    globals: false,
    reporters: ['dot'],
    testTimeout: 30000,
    env: {
      // `os.devNull` is `/dev/null` on POSIX and `\\.\nul` on Windows.
      CARDS_HOOKS_LOG_FILE: devNull
    }
  },
  resolve: {
    // Suites that load the logger (transitively via `@cards.management/sdk`) pull in
    // `@cards.management/vscode-logging`, whose `import { window } from 'vscode'` has no
    // runtime module outside VS Code. Alias `vscode` to the shared shim so
    // these tests load — mirroring the cards server/git-hooks/hybrid-store configs.
    alias: {
      vscode: resolve(repoRoot, 'packages/vscode-logging/src/vscode-shim.ts')
    }
  }
});

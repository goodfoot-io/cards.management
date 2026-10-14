/**
 * Configures vitest behavior for the @cards.management/agent-hooks package.
 * Settings are centralized here so tooling and runtime assumptions remain consistent across
 * environments. This is the superset of the five former agent-hook package configs: it carries
 * the text-asset loader (`.md`/`.txt` → text), the `vscode` → shim alias, and the 30s timeouts
 * the runtime suites need.
 *
 * @summary Vitest logic for agent-hooks
 */

import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { loadCacheContract, withTestOutput } from '@goodfoot/vitest-cache/policy';
import { defineConfig } from 'vitest/config';

const textAssetPlugin = {
  name: 'text-asset-loader',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.endsWith('.md') && !id.endsWith('.txt')) {
      return null;
    }

    return `export default ${JSON.stringify(readFileSync(id, 'utf-8'))};`;
  }
};

export default withTestOutput(
  defineConfig({
    plugins: [textAssetPlugin],
    test: {
      include: ['test/**/*.test.ts'],
      globals: false,
      globalSetup: ['./test/setup/build-once.ts'],
      // Several suites spin up real git workspaces (TestGitWorkspace). git
      // subprocess overhead on Windows pushes setup past the 5s/10s defaults;
      // these allowances are ample on Linux/macOS where the work finishes fast.
      testTimeout: 30000,
      hookTimeout: 30000,
      env: {
        // `os.devNull` is `/dev/null` on POSIX and `\\.\nul` on Windows.
        CARDS_HOOKS_LOG_FILE: devNull
      }
    },
    resolve: {
      alias: {
        // Tests reach `@cards.management/vscode-logging` transitively, which would otherwise
        // pull in the real `vscode` module that only exists in the extension
        // host. Alias `vscode` to the shared shim, matching the other packages
        // whose test chains reach `vscode-logging`.
        vscode: path.resolve(import.meta.dirname, '../../../packages/vscode-logging/src/vscode-shim.ts')
      }
    }
  }),
  loadCacheContract(new URL('./vitest.cache.json', import.meta.url))
);

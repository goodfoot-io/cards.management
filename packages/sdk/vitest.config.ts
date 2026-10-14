import path from 'node:path';
import { loadCacheContract, withTestOutput } from '@goodfoot/vitest-cache/policy';
import { defineConfig } from 'vitest/config';

/**
 * Configures vitest behavior for the package package.
 * Settings are centralized here so tooling and runtime assumptions remain consistent across
 * environments.
 *
 * @summary Vitest logic for package
 */

export default withTestOutput(
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      globals: false,
      reporters: ['dot'],
      // Many suites spawn real processes (node + tsx, git worktree, detached bin
      // scripts). On Windows process spawn is far slower than on POSIX and, under
      // the full parallel run, these integration tests routinely exceed vitest's
      // 5s default. Allow more headroom so the slow-spawn host passes.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // Run the whole package serially. The spawn-heavy suites above, distributed
      // across reused parallel forks, intermittently crash a sibling fork on
      // teardown (`Worker exited unexpectedly`: every test passes but the run exits
      // non-zero). `fileParallelism: false` forces `maxWorkers` to 1, so every file
      // runs sequentially in one worker and no two files ever share or crash a
      // fork. (`singleFork` is NOT a valid top-level Vitest 4 option — it is
      // silently ignored.) Determinism on the validation gate is worth the
      // wall-clock; matches @cards/cards-server.
      pool: 'forks',
      fileParallelism: false,
      setupFiles: ['./test/setup.ts'],
      env: {
        CARDS_HOOKS_LOG_FILE: '/dev/null'
      }
    },
    resolve: {
      // Suites that load the logger pull in `@cards.management/vscode-logging`, whose
      // `import { window } from 'vscode'` has no runtime module outside VS Code.
      // Alias `vscode` to the shared shim so these tests load — mirroring the
      // cards server/git-hooks/hybrid-store configs.
      alias: {
        vscode: path.resolve(import.meta.dirname, '../../../packages/vscode-logging/src/vscode-shim.ts')
      }
    }
  }),
  loadCacheContract(new URL('./vitest.cache.json', import.meta.url))
);

/**
 * Vitest configuration for @cards.management/test-utils.
 *
 * Why: keep test behavior (timeouts, environment, reporters) consistent across
 * the package's integration-heavy test suite.
 *
 * Behavior: runs Node-based tests with a longer
 * timeout to accommodate filesystem and socket operations.
 *
 * @summary Vitest configuration for @cards.management/test-utils
 */

import { loadCacheContract, withTestOutput } from '@goodfoot/vitest-cache/policy';
import { defineConfig } from 'vitest/config';

export default withTestOutput(
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30000,
      reporters: ['dot'],
      env: {
        CARDS_HOOKS_LOG_FILE: '/dev/null'
      }
    }
  }),
  loadCacheContract(new URL('./vitest.cache.json', import.meta.url))
);

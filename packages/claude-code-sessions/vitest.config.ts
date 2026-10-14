/**
 * @file Vitest configuration for sessions.
 * @summary Vitest configuration for sessions.
 */
import { loadCacheContract, withTestOutput } from '@goodfoot/vitest-cache/policy';
import { defineConfig } from 'vitest/config';

export default withTestOutput(
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      globals: false,
      env: {
        CARDS_HOOKS_LOG_FILE: '/dev/null'
      }
    }
  }),
  loadCacheContract(new URL('./vitest.cache.json', import.meta.url))
);

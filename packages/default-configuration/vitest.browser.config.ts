/**
 * Opt-in standalone Chromium tests, serialized to bound browser resource use.
 * @summary Default configuration browser test selection
 */
import { configDefaults, defineConfig } from 'vitest/config';
import config from './vitest.config';

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ['test/browser/**/*.test.ts'],
    exclude: configDefaults.exclude,
    fileParallelism: false
  }
});

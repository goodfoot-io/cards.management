/**
 * Tests for the `branch-cleanup-watcher` wrapper resolver.
 *
 * Covers both platform branches of the wrapper basename and the absolute-path
 * join. `process.platform` is redefined per case and restored afterwards.
 *
 * @summary Unit tests for resolveBranchCleanupWatcher
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  branchCleanupWatcherWrapperName,
  resolveBranchCleanupWatcher
} from '../../src/bin/resolve-branch-cleanup-watcher.js';

describe('resolveBranchCleanupWatcher', () => {
  let savedPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  it('uses the extension-less name on non-win32', () => {
    setPlatform('linux');
    expect(branchCleanupWatcherWrapperName()).toBe('branch-cleanup-watcher');
  });

  it('uses the .cmd name on win32', () => {
    setPlatform('win32');
    expect(branchCleanupWatcherWrapperName()).toBe('branch-cleanup-watcher.cmd');
  });

  it('resolves an absolute path under the given bin directory', () => {
    setPlatform('linux');
    expect(resolveBranchCleanupWatcher('/ext/dist/bin')).toBe('/ext/dist/bin/branch-cleanup-watcher');
  });

  it('carries the platform-correct basename into the resolved path', () => {
    setPlatform('win32');
    expect(resolveBranchCleanupWatcher('/ext/dist/bin')).toMatch(/branch-cleanup-watcher\.cmd$/);
  });
});

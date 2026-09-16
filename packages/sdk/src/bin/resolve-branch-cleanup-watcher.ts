/**
 * Locates the installed `branch-cleanup-watcher` wrapper in the extension's
 * bin directory.
 *
 * Only the lookup lives here, never the worker. The cleanup logic belongs to
 * `@cards.management/default-configuration`, which already depends on this
 * package — importing it back would close a cycle between two shipped
 * packages. Answering "where did the extension build install this" is this
 * package's existing job, and it needs nothing from the worker to answer it.
 *
 * @summary Resolves the installed branch-cleanup-watcher wrapper path
 * @module
 */

import { join } from 'node:path';

/**
 * Returns the platform-correct basename of the `branch-cleanup-watcher`
 * wrapper: `branch-cleanup-watcher.cmd` on win32 (Windows cannot exec the
 * extension-less POSIX script) and `branch-cleanup-watcher` elsewhere.
 *
 * @returns The wrapper basename for the current platform.
 */
export function branchCleanupWatcherWrapperName(): string {
  return process.platform === 'win32' ? 'branch-cleanup-watcher.cmd' : 'branch-cleanup-watcher';
}

/**
 * Resolves the absolute path to the `branch-cleanup-watcher` wrapper within
 * the extension's bin directory.
 *
 * The wrapper is produced by the extension build into `<extensionPath>/dist/bin`.
 * A session-end hook cannot rely on it being on PATH — a background Launch
 * action enables only the `runtime` plugin, so the `cards` plugin's bin is
 * never prepended. Resolving an absolute path from the caller-supplied
 * `binPath` removes that cross-plugin PATH dependency.
 *
 * The returned path is a wrapper script, not a JavaScript module: a caller
 * spawning it must exec it directly rather than passing it to `node`.
 *
 * @param binPath - Absolute path to the extension's `dist/bin` directory.
 * @returns Absolute path to the platform-correct `branch-cleanup-watcher`
 *   wrapper under `<binPath>/`.
 */
export function resolveBranchCleanupWatcher(binPath: string): string {
  return join(binPath, branchCleanupWatcherWrapperName());
}

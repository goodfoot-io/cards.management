/**
 * Thin CLI entry for the installed `branch-cleanup-watcher` binary.
 *
 * Unlike `../lib/branch-cleanup-watcher.js`'s dual-purpose self-invocation
 * guard (importable as a library, or self-exec'd via a `--branch-cleanup`
 * argv flag as an interim shim), this file has exactly one job: it is the
 * installed binary's entry point, always invoked as the process root, so it
 * unconditionally reads params off stdin and runs the worker — no flag needed
 * to distinguish "imported" from "invoked as a script".
 *
 * @summary Installed-binary CLI entry for the branch-cleanup watcher
 * @module
 */

import { runDetachedCleanup } from '../lib/branch-cleanup-watcher.js';

/**
 * Runs the detached cleanup worker to completion and sets the process exit
 * code accordingly.
 */
export async function main(): Promise<void> {
  process.exitCode = await runDetachedCleanup();
}

if (process.argv[1]?.endsWith('branch-cleanup-watcher.mjs') || process.argv[1]?.endsWith('branch-cleanup-watcher.ts')) {
  main().catch((error) => {
    process.stderr.write(`branch-cleanup-watcher: fatal error: ${String(error)}\n`);
    process.exitCode = 1;
  });
}

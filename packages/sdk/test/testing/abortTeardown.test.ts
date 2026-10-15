/**
 * Regression test: teardown's guarded `abort()` must never let the abort plugin's
 * task-promise rejection escape as a process-fatal unhandled rejection — even when
 * the SIGINT'd git child is slow to close.
 *
 * Why: replacing `clearQueue()` with `AbortController.abort()` introduced a path
 * where aborting a still-spawned git child rejects the in-flight task promise.
 * The abort plugin sends SIGINT and the rejection surfaces only when the child's
 * async `close` event fires — an arbitrary amount of wall-clock time later. A
 * guard that removed its `unhandledRejection` listener on a fixed `setTimeout(0)`
 * macrotask therefore lost the race for any child that took longer than a tick to
 * die (a commit running hooks, a large checkout, gc, CI jitter): the listener was
 * already gone when the rejection arrived, and — in the default Node
 * `unhandledRejection` mode used by the extension test host — it terminated the
 * whole process. This test proves the process-lifetime guard contains that
 * rejection regardless of how long the child takes to close.
 *
 * Mechanism: the scenario is exercised in a child Node process (default
 * unhandled-rejections mode) because the fatal consequence is only observable as
 * a non-zero process exit; every in-process listener fires regardless of the fix.
 * The child installs a slow (~0.6s) pre-commit hook and tears down ~120ms into a
 * never-awaited commit, so the child is still alive when the guard runs.
 *
 * @summary Teardown abort must not surface a fatal unhandled rejection (slow child)
 * @module sdk/test/testing/abortTeardown
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const childScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'abortUnhandledRejectionChild.ts');

/** Survival sentinel the child prints after a contained abort rejection. */
const POST_ABORT_SENTINEL = 'POST_ABORT_SENTINEL_REACHED';

/**
 * Runs the child harness and resolves with its exit code, stdout, and stderr.
 *
 * @returns The child process exit code (null if killed by signal), stdout, and stderr.
 */
function runChild(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Run the harness in a real Node process under the default unhandledRejection
    // mode (the mode the extension test host uses), where an escaped abort
    // rejection terminates the process with a non-zero exit. tsx provides
    // TypeScript + workspace-export (`.js` -> `.ts`) resolution.
    const child = spawn(process.execPath, ['--import', 'tsx', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(childScript)
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('TestCardRepository teardown abort', () => {
  it('contains the abort rejection of a slow-to-close git child during teardown', async () => {
    const { code, stdout, stderr } = await runChild();

    // The abort-plugin rejection must be swallowed, not surfaced.
    expect(stderr).not.toMatch(/GitPluginError/);
    // The process must survive to the post-abort sentinel and exit cleanly.
    expect(stdout).toContain(POST_ABORT_SENTINEL);
    expect(code).toBe(0);
  }, 30000);
});

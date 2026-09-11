/**
 * Bounded, idempotent termination for launcher-owned Antigravity process trees.
 *
 * Antigravity actions spawn `agy` detached on POSIX, giving the launcher a
 * process group whose id is the root pid. Cancellation, shutdown, and timeout
 * drain the whole group with the same graceful-then-forced escalation used by
 * the other per-host termination modules.
 *
 * @summary Drain-safe Antigravity process-tree termination
 * @module
 */

import { type ChildProcess, execFile } from 'node:child_process';

/**
 * Outcome of one {@link AntigravityTerminationController.terminate} escalation.
 */
export type AntigravityTerminationResult = 'graceful' | 'forced' | 'failed';

/**
 * Options for {@link createAntigravityTerminationController}.
 */
export interface AntigravityTerminationOptions {
  /** How long the graceful SIGTERM phase waits before escalating. */
  gracefulTimeoutMs: number;
  /** How long the forced SIGKILL phase waits before reporting failure. */
  forceTimeoutMs: number;
  /** Test/platform seam; production uses the launcher-owned tree adapter. */
  signalTree?: (child: ChildProcess, signal: NodeJS.Signals) => void | Promise<void>;
}

/**
 * Idempotent handle shared by cancellation and shutdown handlers.
 */
export interface AntigravityTerminationController {
  /**
   * Drains the owned process tree exactly once; concurrent callers share the
   * same escalation promise.
   *
   * Every caller drains the same way — cancellation, shutdown, and the
   * normal-close drain differ in their own logging and in what they do with
   * the outcome, not in how the tree is terminated — so it takes no reason.
   *
   * @returns The escalation outcome.
   */
  terminate(): Promise<AntigravityTerminationResult>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Force-terminates a win32 process tree, including descendants.
 *
 * @param pid - Root process id.
 * @param force - When true, hard-kills instead of requesting a graceful end.
 */
function windowsTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Signals the launcher-owned tree: `taskkill /T` on win32, negative-pid
 * signalling on POSIX.
 *
 * @param child - Root process launched into the owned tree.
 * @param signal - Signal to deliver.
 * @throws {Error} When the child has no pid to signal.
 */
async function signalOwnedTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) throw new Error('Cannot terminate Antigravity process tree without a root pid');

  if (process.platform === 'win32') {
    await windowsTaskkill(pid, signal === 'SIGKILL');
    return;
  }

  // `spawnAntigravitySession` launches `agy` detached on POSIX, giving the
  // action a process group whose id is the root pid. Negative-pid signalling
  // stays inside that launcher-owned group and cannot sweep unrelated
  // processes.
  process.kill(-pid, signal);
}

/**
 * Probes whether the owned tree still has a live root.
 *
 * @param child - Root process launched into the owned tree.
 * @returns True while the tree is alive.
 * @throws {Error} When the liveness probe fails with an unexpected error.
 */
function ownedTreeExists(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/**
 * Polls until the owned tree exits or the timeout elapses.
 *
 * @param child - Root process launched into the owned tree.
 * @param timeoutMs - Bounded wait for the tree to drain.
 * @returns True when the tree exited within the bound.
 */
async function waitForTreeExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ownedTreeExists(child)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(10, remaining));
  }
  return true;
}

/**
 * Creates one termination controller for a launcher-owned Antigravity process
 * tree. Concurrent requests share the exact same promise and escalation
 * sequence.
 *
 * @param child - Root process launched into the owned tree.
 * @param options - Grace and force deadlines plus an optional signal adapter.
 * @returns An idempotent controller shared by cancellation and shutdown.
 */
export function createAntigravityTerminationController(
  child: ChildProcess,
  options: AntigravityTerminationOptions
): AntigravityTerminationController {
  const signalTree = options.signalTree ?? signalOwnedTree;
  let termination: Promise<AntigravityTerminationResult> | undefined;

  return {
    terminate(): Promise<AntigravityTerminationResult> {
      if (termination !== undefined) return termination;

      termination = (async () => {
        if (!ownedTreeExists(child)) return 'graceful';

        try {
          await signalTree(child, 'SIGTERM');
        } catch {
          return ownedTreeExists(child) ? 'failed' : 'graceful';
        }

        if (await waitForTreeExit(child, options.gracefulTimeoutMs)) return 'graceful';

        try {
          await signalTree(child, 'SIGKILL');
        } catch {
          return ownedTreeExists(child) ? 'failed' : 'forced';
        }

        return (await waitForTreeExit(child, options.forceTimeoutMs)) ? 'forced' : 'failed';
      })();

      return termination;
    }
  };
}

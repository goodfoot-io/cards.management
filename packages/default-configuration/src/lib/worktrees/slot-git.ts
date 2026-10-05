/**
 * Slot git: every git call the slot layer makes runs through the SDK bounded
 * runner with `core.fsmonitor=false`, so git stays inside the handler's
 * recorded process group and its tree is ended at the call's deadline.
 *
 * @summary Bounded, fsmonitor-free git runner for worktree slots
 * @module
 */

import type { BoundedGitRunner, GitBoundedResult, GitChildEvent } from '@cards.management/sdk/bounded-git';
import type { WorktreeGitRunner } from '@cards.management/sdk/worktree';

/** Deadline of a read-only slot git call. */
export const SLOT_GIT_READ_TIMEOUT_MS = 30_000;

/** Deadline of a checkout-populating call (`worktree add`, provisioning steps). */
export const SLOT_GIT_CHECKOUT_TIMEOUT_MS = 600_000;

/** Options of one slot git call. */
export interface SlotGitCallOptions {
  /** Deadline; defaults to {@link SLOT_GIT_READ_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** The holding lock's `recordGit`, passed for mutating calls. */
  readonly record?: (event: GitChildEvent) => void;
  /** Text written to git's standard input. */
  readonly input?: string;
}

/** A slot git call that exited non-zero, timed out or was aborted. */
export class SlotGitError extends Error {
  /**
   * Wraps a failed call.
   * @param args - The git arguments, without the fsmonitor override.
   * @param result - The completed call.
   */
  constructor(
    readonly args: readonly string[],
    readonly result: GitBoundedResult
  ) {
    const cause = result.timedOut
      ? 'timed out'
      : result.aborted
        ? 'was aborted'
        : `exited ${result.exitCode ?? 'by signal'}`;
    super(`git ${args.join(' ')} ${cause}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`);
    this.name = 'SlotGitError';
  }

  /**
   * Exit code of the failed call.
   * @returns The code, or null when git was ended by a signal.
   */
  get exitCode(): number | null {
    return this.result.exitCode;
  }
}

/** Git as the slot layer uses it. */
export interface SlotGit {
  /**
   * Runs git and returns the completed call whatever its exit code.
   * @param cwd - Working directory.
   * @param args - Git arguments.
   * @param options - Deadline, record callback and input.
   * @returns The completed call.
   */
  run(cwd: string, args: readonly string[], options?: SlotGitCallOptions): Promise<GitBoundedResult>;
  /**
   * Runs git and returns its stdout.
   * @param cwd - Working directory.
   * @param args - Git arguments.
   * @param options - Deadline, record callback and input.
   * @returns Standard output.
   * @throws {SlotGitError} When git exited non-zero, timed out or was aborted.
   */
  text(cwd: string, args: readonly string[], options?: SlotGitCallOptions): Promise<string>;
  /**
   * Adapts this runner to the SDK provisioning helpers' runner shape.
   * @param options - Deadline and record callback for every call.
   * @returns A runner that throws on failure.
   */
  provisioningRunner(options: SlotGitCallOptions): WorktreeGitRunner;
}

/**
 * Creates the slot git runner over a bounded runner.
 * @param runner - The bounded runner; the host's `runGitBounded` in production.
 * @returns A runner that prefixes every call with `-c core.fsmonitor=false`.
 */
export function createSlotGit(runner: Pick<BoundedGitRunner, 'run'>): SlotGit {
  const run = (cwd: string, args: readonly string[], options: SlotGitCallOptions = {}): Promise<GitBoundedResult> =>
    runner.run(cwd, ['-c', 'core.fsmonitor=false', ...args], {
      timeoutMs: options.timeoutMs ?? SLOT_GIT_READ_TIMEOUT_MS,
      ...(options.record === undefined ? {} : { record: options.record }),
      ...(options.input === undefined ? {} : { input: options.input })
    });
  const text = async (cwd: string, args: readonly string[], options?: SlotGitCallOptions): Promise<string> => {
    const result = await run(cwd, args, options);
    if (result.exitCode !== 0 || result.timedOut || result.aborted) throw new SlotGitError(args, result);
    return result.stdout;
  };
  return {
    run,
    text,
    provisioningRunner: (options) => (cwd, args, input) =>
      text(cwd, args, { ...options, ...(input === undefined ? {} : { input }) })
  };
}

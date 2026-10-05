/**
 * Slot git under a deadline, inside the caller's process group, behind the
 * runtime's shutdown fence.
 *
 * Git is spawned without `detached`, so on POSIX it and its hooks and filters
 * belong to the group a slot lock records from the moment they are forked. At
 * the deadline the runner ends git's own process tree — never the group, which
 * also holds the handler and the agent: it enumerates git's descendants by
 * parent PID, sends SIGTERM to each, and after the grace period sends SIGKILL
 * only to those whose start identity still matches. On Windows the deadline is
 * `taskkill /PID <git> /T /F`. Once {@link shutdownSignal} has aborted, no new
 * git starts.
 *
 * @summary Deadline-bounded slot git that stays in the recorded group and stops at the shutdown fence
 * @module
 */
import { ShutdownError } from './config/runtime-shutdown.js';
import type { ProcessIdentity } from './process-identity.js';

export { ShutdownError };

/** Default wait between the polite and the forced stop of a timed-out git tree. */
export const DEFAULT_GIT_GRACE_MS = 3_000;

/** One stage of a git child's life, reported to {@link RunGitBoundedOptions.record}. */
export type GitChildEvent =
  /** Synchronously after spawn, before the identity probe. */
  | { readonly kind: 'spawned'; readonly pid: number }
  /** The probed identity; `unknown` when the probe could not read it. */
  | { readonly kind: 'identified'; readonly pid: number; readonly identity: ProcessIdentity | 'unknown' }
  /** Git has exited. */
  | { readonly kind: 'exited'; readonly pid: number };

/** A descendant of git found by parent PID. */
export interface GitDescendant {
  readonly pid: number;
  readonly startIdentity: string;
}

/** Options of one bounded git call. */
export interface RunGitBoundedOptions {
  /** Elapsed-time ceiling before git's tree is stopped. */
  readonly timeoutMs: number;
  /** Wait between SIGTERM and SIGKILL on POSIX; defaults to {@link DEFAULT_GIT_GRACE_MS}. */
  readonly graceMs?: number;
  /** Lifecycle callback for mutating calls; Windows slot code records git as a companion through it. */
  readonly record?: (event: GitChildEvent) => void;
  /** Extra environment for git, merged over the process's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Text written to git's standard input, which is otherwise closed. */
  readonly input?: string;
}

/** The outcome of one bounded git call. */
export interface GitBoundedResult {
  /** Exit code, or null when git was ended by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether the deadline stopped git. */
  readonly timedOut: boolean;
  /** Whether {@link abortAll} stopped git. */
  readonly aborted: boolean;
}

/** OS boundaries of the runner; every one is injectable for tests. */
export interface BoundedGitPlatform {
  readonly platform: NodeJS.Platform;
  /**
   * Lists the live descendants of a process, by parent PID, with their start identities.
   * @param pid - Root of the tree.
   * @returns The descendants found, root excluded.
   */
  readonly descendants: (pid: number) => Promise<readonly GitDescendant[]>;
  /**
   * Reads one process's start identity.
   * @param pid - Process to read.
   * @returns Its start identity, `null` when absent, or `unknown`.
   */
  readonly startIdentity: (pid: number) => Promise<string | null | 'unknown'>;
  /** Sends a signal to one PID, with `process.kill` semantics. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Ends a Windows process tree; resolves once `taskkill` has returned. */
  readonly killTree: (pid: number) => Promise<void>;
  /** Shutdown fence; defaults to the runtime's `shutdownSignal`. */
  readonly shutdownSignal: AbortSignal;
}

/** A runner bound to one platform, tracking its own in-flight calls. */
export interface BoundedGitRunner {
  /**
   * Runs one git command under a deadline.
   * @param cwd - Working directory for git.
   * @param args - Literal git arguments.
   * @param options - Deadline, grace and lifecycle callback.
   * @returns The completed call; settles only after git has exited.
   * @throws {ShutdownError} When the fence has closed, before any process starts.
   */
  run(cwd: string, args: readonly string[], options: RunGitBoundedOptions): Promise<GitBoundedResult>;
  /**
   * Stops every in-flight call's tree, as at its deadline.
   * @param options - How long to wait after the polite stop.
   * @param options.graceMs - Wait between SIGTERM and SIGKILL on POSIX.
   * @returns Once every in-flight git has exited.
   */
  abortAll(options: { readonly graceMs: number }): Promise<void>;
}

/**
 * Creates a runner over the given OS boundaries.
 * @param platform - Overrides for any OS boundary; defaults are the host's.
 * @returns A runner with its own in-flight set.
 * @throws {Error} Always: not implemented yet.
 */
export function createBoundedGit(platform: Partial<BoundedGitPlatform> = {}): BoundedGitRunner {
  void platform;
  throw new Error('Not Implemented');
}

let defaultRunner: BoundedGitRunner | undefined;

function runner(): BoundedGitRunner {
  defaultRunner ??= createBoundedGit();
  return defaultRunner;
}

/**
 * Runs one git command under a deadline on the host's process-wide runner.
 * @param cwd - Working directory for git.
 * @param args - Literal git arguments.
 * @param options - Deadline, grace and lifecycle callback.
 * @returns The completed call; settles only after git has exited.
 * @throws {ShutdownError} When the fence has closed, before any process starts.
 */
export function runGitBounded(
  cwd: string,
  args: readonly string[],
  options: RunGitBoundedOptions
): Promise<GitBoundedResult> {
  return runner().run(cwd, args, options);
}

/**
 * Stops every in-flight call of the host's process-wide runner.
 * @param options - How long to wait after the polite stop.
 * @param options.graceMs - Wait between SIGTERM and SIGKILL on POSIX.
 * @returns Once every in-flight git has exited.
 */
export function abortAll(options: { readonly graceMs: number }): Promise<void> {
  return runner().abortAll(options);
}

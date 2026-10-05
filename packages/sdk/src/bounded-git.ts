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
import { spawn } from 'node:child_process';
import { ShutdownError, shutdownSignal } from './config/runtime-shutdown.js';
import { type IdentityProbe, type ProcessIdentity, processIdentity, runBoundedCommand } from './process-identity.js';

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
   * Reads one process's full identity, for the `identified` event.
   * @param pid - Process to read.
   * @returns Its identity, `null` when absent, or `unknown`.
   */
  readonly identify: (pid: number) => Promise<IdentityProbe>;
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

/** Budget of each process-identity read the runner makes. */
const PROBE_TIMEOUT_MS = 2_000;

/** How long `taskkill` may take before the runner stops waiting on it. */
const TASKKILL_TIMEOUT_MS = 10_000;

/** How long buffered output may trail git's exit before the pipes are closed. */
const DRAIN_MS = 100;

/**
 * The host's OS boundaries.
 * @returns Boundaries over the process-wide identity service, `process.kill` and `taskkill`.
 */
function hostPlatform(): BoundedGitPlatform {
  const identity = processIdentity();
  return {
    platform: process.platform,
    identify: (pid) => identity.identify(pid, PROBE_TIMEOUT_MS),
    descendants: async (root) => {
      const roster = await identity.enumerate(PROBE_TIMEOUT_MS);
      if (roster === 'unknown') return [];
      const found: GitDescendant[] = [];
      const parents = new Set([root]);
      // Walk to a fixed point: a roster is not ordered parent-first.
      for (let grew = true; grew; ) {
        grew = false;
        for (const entry of roster) {
          if (parents.has(entry.parentPid) && !parents.has(entry.pid) && entry.pid !== root) {
            parents.add(entry.pid);
            found.push({ pid: entry.pid, startIdentity: entry.startIdentity });
            grew = true;
          }
        }
      }
      return found;
    },
    startIdentity: async (pid) => {
      const probe = await identity.identify(pid, PROBE_TIMEOUT_MS);
      return probe === null || probe === 'unknown' ? probe : probe.startIdentity;
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    killTree: async (pid) => {
      await runBoundedCommand('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: TASKKILL_TIMEOUT_MS });
    },
    shutdownSignal
  };
}

/** One git call still running. */
interface InFlight {
  /** Ends git's tree; `aborted` marks the call as stopped by {@link BoundedGitRunner.abortAll}. */
  stop(graceMs: number, aborted: boolean): Promise<void>;
  readonly settled: Promise<unknown>;
}

/**
 * Creates a runner over the given OS boundaries.
 * @param platform - Overrides for any OS boundary; defaults are the host's.
 * @returns A runner with its own in-flight set.
 */
export function createBoundedGit(platform: Partial<BoundedGitPlatform> = {}): BoundedGitRunner {
  const os: BoundedGitPlatform = { ...hostPlatform(), ...platform };
  const inFlight = new Set<InFlight>();

  const signal = (pid: number, name: NodeJS.Signals): void => {
    try {
      os.kill(pid, name);
    } catch {
      // ESRCH: already gone. EPERM: not ours to end.
    }
  };

  return {
    run(cwd, args, options) {
      if (os.shutdownSignal.aborted) return Promise.reject(new ShutdownError());
      const graceMs = options.graceMs ?? DEFAULT_GIT_GRACE_MS;
      return new Promise<GitBoundedResult>((resolve, reject) => {
        // Not detached: git and everything it forks stay in the group a slot lock records.
        const child = spawn('git', [...args], {
          cwd,
          env: { ...process.env, ...options.env },
          stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true
        });
        const pid = child.pid;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        if (options.input !== undefined) {
          child.stdin?.on('error', () => {});
          child.stdin?.end(options.input);
        }

        let exited = false;
        let timedOut = false;
        let aborted = false;
        let stopping: Promise<void> | undefined;
        let markExited: () => void = () => {};
        const exitedPromise = new Promise<void>((resolveExit) => {
          markExited = resolveExit;
        });
        const identified =
          pid === undefined || options.record === undefined
            ? Promise.resolve()
            : (() => {
                options.record({ kind: 'spawned', pid });
                return os.identify(pid).then(
                  (probe) => {
                    options.record?.({
                      kind: 'identified',
                      pid,
                      identity: probe === null || probe === 'unknown' ? 'unknown' : probe
                    });
                  },
                  () => options.record?.({ kind: 'identified', pid, identity: 'unknown' })
                );
              })();

        const stopTree = async (grace: number): Promise<void> => {
          if (pid === undefined || exited) return;
          if (os.platform === 'win32') {
            // A console git.exe can only be ended forcefully [R14].
            await os.killTree(pid).catch(() => {});
            return;
          }
          // Enumerate before signalling: once git dies its children are reparented.
          const tree = await os.descendants(pid).catch(() => [] as readonly GitDescendant[]);
          if (!exited) child.kill('SIGTERM');
          for (const member of tree) signal(member.pid, 'SIGTERM');
          await new Promise<void>((resolveGrace) => {
            const timer = setTimeout(resolveGrace, grace);
            void exitedPromise.then(() => {
              if (tree.length === 0) {
                clearTimeout(timer);
                resolveGrace();
              }
            });
          });
          for (const member of tree) {
            // A PID whose start identity changed was reused; it is no longer git's.
            if ((await os.startIdentity(member.pid).catch(() => 'unknown' as const)) === member.startIdentity)
              signal(member.pid, 'SIGKILL');
          }
          // Git itself is this call's unreaped child, so its PID cannot have been reused.
          if (!exited) child.kill('SIGKILL');
        };

        const entry: InFlight = {
          stop(grace, byAbort) {
            if (byAbort) aborted = true;
            stopping ??= stopTree(grace);
            return stopping;
          },
          settled: exitedPromise
        };
        inFlight.add(entry);
        const timer = setTimeout(() => {
          timedOut = true;
          void entry.stop(graceMs, false);
        }, options.timeoutMs);

        child.once('error', (error) => {
          if (pid !== undefined) return;
          clearTimeout(timer);
          inFlight.delete(entry);
          markExited();
          reject(error);
        });
        child.once('exit', (code) => {
          exited = true;
          clearTimeout(timer);
          markExited();
          // An escaped descendant may hold git's pipes open; settle on git's exit.
          const drained = new Promise<void>((resolveDrain) => {
            const drainTimer = setTimeout(resolveDrain, DRAIN_MS);
            child.once('close', () => {
              clearTimeout(drainTimer);
              resolveDrain();
            });
          });
          void Promise.all([drained, identified, stopping]).then(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            inFlight.delete(entry);
            if (pid !== undefined) options.record?.({ kind: 'exited', pid });
            resolve({
              exitCode: code,
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              timedOut,
              aborted
            });
          });
        });
      });
    },
    async abortAll(options) {
      const calls = [...inFlight];
      await Promise.all(calls.map((call) => call.stop(options.graceMs, true)));
      await Promise.all(calls.map((call) => call.settled));
    }
  };
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

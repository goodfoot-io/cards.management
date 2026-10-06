/**
 * Slot git under a deadline, inside the caller's process group, behind the
 * runtime's shutdown fence.
 *
 * Git is spawned without `detached`, so on POSIX it and its hooks and filters
 * belong to the group a slot lock records from the moment they are forked. At
 * the deadline the runner ends git's own process tree — never the group, which
 * also holds the handler and the agent: it enumerates git's descendants by
 * parent PID, sends SIGTERM to each, enumerates again after the grace period
 * to catch what they forked meanwhile, and sends SIGKILL only to members whose
 * start identity still matches. On Windows the deadline is
 * `taskkill /PID <git> /T /F`. Either way the stop fails closed: a tree it
 * could not list, a member whose identity it could not read, or a member still
 * alive after SIGKILL is reported in {@link GitStopReport}, never assumed gone.
 * Once {@link shutdownSignal} has aborted, no new git starts.
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

/** What stopping git's tree left behind. */
export interface GitStopReport {
  /** Members still alive after the forced stop, or whose identity could not be read to stop them. */
  readonly survivors: readonly GitDescendant[];
  /** False when the tree could not be listed, so members may be missing from {@link survivors}. */
  readonly complete: boolean;
}

/** The report of a tree that was never stopped, or stopped without a trace. */
const NOTHING_LEFT: GitStopReport = { survivors: [], complete: true };

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
  /** What a deadline or abort stop left of git's tree; empty and complete when git was not stopped. */
  readonly stopReport: GitStopReport;
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
   * Lists the live descendants of some processes, by parent PID, with their start identities.
   * @param roots - Roots of the walk, each with the start identity it must still have to count
   *   as the same process, or null for git itself, this runner's unreaped child.
   * @returns The descendants found, roots excluded, or `unknown` when the process table is unreadable.
   */
  readonly descendants: (roots: ReadonlyMap<number, string | null>) => Promise<readonly GitDescendant[] | 'unknown'>;
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
   * @returns Once every in-flight git has exited, what the stops left of their trees.
   */
  abortAll(options: { readonly graceMs: number }): Promise<GitStopReport>;
}

/** Budget of each process-identity read the runner makes. */
const PROBE_TIMEOUT_MS = 2_000;

/** How long `taskkill` may take before the runner stops waiting on it. */
const TASKKILL_TIMEOUT_MS = 10_000;

/** How long buffered output may trail git's exit before the pipes are closed. */
const DRAIN_MS = 100;

/** How long SIGKILLed members may take to vanish before they are reported as survivors. */
const KILL_SETTLE_MS = 500;

/** Interval between checks while SIGKILLed members vanish. */
const KILL_SETTLE_POLL_MS = 25;

/**
 * The host's OS boundaries.
 * @returns Boundaries over the process-wide identity service, `process.kill` and `taskkill`.
 */
function hostPlatform(): BoundedGitPlatform {
  const identity = processIdentity();
  return {
    platform: process.platform,
    identify: (pid) => identity.identify(pid, PROBE_TIMEOUT_MS),
    descendants: async (roots) => {
      const roster = await identity.enumerate(PROBE_TIMEOUT_MS);
      if (roster === 'unknown') return 'unknown';
      // A root whose PID now belongs to another process roots nothing: its children are not git's.
      const parents = new Set(
        [...roots]
          .filter(
            ([pid, start]) =>
              start === null || roster.some((entry) => entry.pid === pid && entry.startIdentity === start)
          )
          .map(([pid]) => pid)
      );
      const found: GitDescendant[] = [];
      // Walk to a fixed point: a roster is not ordered parent-first.
      for (let grew = true; grew; ) {
        grew = false;
        for (const entry of roster) {
          if (parents.has(entry.parentPid) && !parents.has(entry.pid) && !roots.has(entry.pid)) {
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
  stop(graceMs: number, aborted: boolean): Promise<GitStopReport>;
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

  /**
   * Waits up to {@link KILL_SETTLE_MS} for SIGKILLed members to vanish.
   * @param killed - Members sent SIGKILL.
   * @returns Those still running under the same identity, or whose identity became unreadable.
   */
  const stillAlive = async (killed: readonly GitDescendant[]): Promise<GitDescendant[]> => {
    let left = [...killed];
    const until = Date.now() + KILL_SETTLE_MS;
    while (left.length > 0) {
      const states = await Promise.all(
        left.map((member) => os.startIdentity(member.pid).catch(() => 'unknown' as const))
      );
      left = left.filter((member, index) => states[index] === 'unknown' || states[index] === member.startIdentity);
      if (left.length === 0 || Date.now() >= until) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, KILL_SETTLE_POLL_MS));
    }
    return left;
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
        let stopping: Promise<GitStopReport> | undefined;
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

        const stopTree = async (grace: number): Promise<GitStopReport> => {
          if (pid === undefined || exited) return NOTHING_LEFT;
          const list = (roots: ReadonlyMap<number, string | null>): Promise<readonly GitDescendant[] | 'unknown'> =>
            os.descendants(roots).catch(() => 'unknown' as const);
          if (os.platform === 'win32') {
            // A console git.exe can only be ended forcefully [R14]. Windows never reparents,
            // so whatever still names git as an ancestor afterwards escaped the tree kill.
            await os.killTree(pid).catch(() => {});
            const left = await list(new Map([[pid, null]]));
            return left === 'unknown' ? { survivors: [], complete: false } : { survivors: left, complete: true };
          }
          let complete = true;
          const tree = new Map<number, string>();
          const add = (found: readonly GitDescendant[] | 'unknown'): void => {
            if (found === 'unknown') complete = false;
            else for (const member of found) if (!tree.has(member.pid)) tree.set(member.pid, member.startIdentity);
          };
          // Enumerate before signalling: once git dies its children are reparented.
          add(await list(new Map([[pid, null]])));
          if (!exited) child.kill('SIGTERM');
          for (const member of tree.keys()) signal(member, 'SIGTERM');
          await new Promise<void>((resolveGrace) => {
            const timer = setTimeout(resolveGrace, grace);
            void exitedPromise.then(() => {
              if (tree.size === 0) {
                clearTimeout(timer);
                resolveGrace();
              }
            });
          });
          // Enumerate again: a member that ignored SIGTERM may have forked during the grace period.
          // Git roots the walk only while unreaped; after its exit its PID may be another process's.
          const roots = new Map<number, string | null>([...tree].map(([member, start]) => [member, start]));
          if (!exited) roots.set(pid, null);
          add(await list(roots));
          const killed: GitDescendant[] = [];
          const survivors: GitDescendant[] = [];
          for (const [member, startIdentity] of tree) {
            const now = await os.startIdentity(member).catch(() => 'unknown' as const);
            // Unreadable is not evidence of death, and not licence to signal: report it.
            if (now === 'unknown') survivors.push({ pid: member, startIdentity });
            // A PID whose start identity changed was reused; it is no longer git's.
            else if (now === startIdentity) {
              signal(member, 'SIGKILL');
              killed.push({ pid: member, startIdentity });
            }
          }
          // Git itself is this call's unreaped child, so its PID cannot have been reused.
          if (!exited) child.kill('SIGKILL');
          survivors.push(...(await stillAlive(killed)));
          return { survivors, complete };
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
          void Promise.all([drained, identified, stopping]).then(([, , report]) => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            inFlight.delete(entry);
            if (pid !== undefined) options.record?.({ kind: 'exited', pid });
            resolve({
              exitCode: code,
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              timedOut,
              aborted,
              stopReport: report ?? NOTHING_LEFT
            });
          });
        });
      });
    },
    async abortAll(options) {
      const calls = [...inFlight];
      const reports = await Promise.all(calls.map((call) => call.stop(options.graceMs, true)));
      await Promise.all(calls.map((call) => call.settled));
      return {
        survivors: reports.flatMap((report) => report.survivors),
        complete: reports.every((report) => report.complete)
      };
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
 * @returns Once every in-flight git has exited, what the stops left of their trees.
 */
export function abortAll(options: { readonly graceMs: number }): Promise<GitStopReport> {
  return runner().abortAll(options);
}

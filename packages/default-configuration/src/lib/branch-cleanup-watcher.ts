/**
 * Detached branch-cleanup watcher for interactive sessions.
 *
 * Provides a fire-and-forget mechanism for running branch cleanup after the
 * interactive CLI exits. The watcher spawns itself as a detached Node.js
 * process, receives cleanup parameters via stdin, calls
 * {@link cleanupMergedBranches}, then exits.
 *
 * @summary Detached branch-cleanup watcher for interactive sessions
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import type { ActionContext } from '@cards.management/sdk/config';
import {
  type ILogger,
  Logger,
  prepareDetachedChildOutputCapture,
  resolveLogFilePath
} from '@cards.management/sdk/config';
import { cleanupMergedBranches, errorMessage } from './claude-session.js';
import {
  createProcessTreeAuthority,
  type ProcessTreeAuthority,
  terminateProcessMembers
} from './process-tree-termination.js';

/**
 * The subsystem name the parent's own singleton `Logger` is constructed with
 * (see `executeCommand()` in the SDK's `runtime.ts`). Passed to
 * {@link resolveLogFilePath} so the detached child resolves to the exact same
 * log file the parent actually writes to, honoring any
 * `CARDS_HOOKS_LOG_FILE`/`CARDS_LOG_DIR` override transparently rather than
 * recomputing a possibly-divergent default.
 */
const HOOKS_LOGGER_SUBSYSTEM = 'cards-default-configuration-hooks';

/**
 * How long, in milliseconds, the parent waits after spawning the detached
 * cleanup child for it to either emit `'exit'` on its own or be observed
 * alive. This is a short grace window, not a wait for the child's real work
 * to finish — see {@link spawnBranchCleanupWatcher}.
 */
const EXIT_GRACE_MS = 500;

/**
 * Parameters required to run branch cleanup in a detached process.
 */
export interface BranchCleanupParams {
  /** The card ID for the session being cleaned up. */
  cardId: string;
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Absolute path to the card's git repository. */
  cardRepoPath: string;
  /** Optional session ID for log correlation. */
  sessionId?: string;
}

/**
 * Spawns a detached Node.js process that calls {@link cleanupMergedBranches}
 * after receiving serialized parameters via stdin.
 *
 * The spawned process is fully detached (`detached: true`, `child.unref()`)
 * and survives parent exit — this call does not wait for the child's actual
 * cleanup work (network discovery, git operations, up to an hour of
 * backoff), which continues fire-and-forget after this function returns.
 * Stdout and stderr are appended to the detached-child output capture when it
 * can be prepared; capture failures warn and fall back to discarded sinks so
 * cleanup remains fail-open. The child is also handed a
 * `CARDS_HOOKS_LOG_FILE` env var pointing at the same log file the parent's
 * own `logger` actually resolves to (via {@link resolveLogFilePath}), so it
 * can construct its own working `Logger` before it has parsed anything off
 * stdin, and so both processes' lifecycle events land in one file even under
 * a `CARDS_HOOKS_LOG_FILE`/`CARDS_LOG_DIR` override.
 *
 * Immediately after a successful `spawn()`, this also writes the
 * cleanup-attempt marker (see {@link writeCleanupMarker}) from the parent —
 * not the child. The parent is the only process guaranteed to run before a
 * child that dies during its own Node/ESM module bootstrap (i.e. before it
 * can log anything at all), so writing the marker here, and logging its path
 * alongside the "spawned" log line, is what lets an external observer
 * distinguish "cleanup attempt started but the child never even got far
 * enough to log" from "cleanup never attempted."
 *
 * After wiring up stdin/unref, this awaits a short, bounded race between the
 * child's own `'exit'` event and a grace-period timer
 * ({@link EXIT_GRACE_MS}). This does not observe the child's eventual real
 * exit (which can be up to an hour away) — it only narrows the blind spot to
 * "child crashed or was killed within the grace window right after spawn,"
 * catching failures that would otherwise go completely unlogged because the
 * parent process was already gone by the time they happened.
 *
 * @param params - Parameters for the cleanup run.
 * @param logger - Logger used for spawn/exit lifecycle diagnostics.
 */
export async function spawnBranchCleanupWatcher(
  params: BranchCleanupParams,
  logger: ActionContext['logger']
): Promise<void> {
  // `fileURLToPath` (not `new URL(...).pathname`) so the path is a real OS path
  // on win32: `new URL(import.meta.url).pathname` yields `/C:/Users/…`, which is
  // not a spawnable script path. Mirrors wrapper.ts's spawnDetachedCleanup.
  const selfPath = fileURLToPath(import.meta.url);
  const nodeBin = process.execPath;

  // Resolve to the exact file the parent's own singleton Logger writes to
  // (same subsystem, same env-driven resolution order), not a hardcoded
  // recomputation that could diverge under a CARDS_HOOKS_LOG_FILE/CARDS_LOG_DIR
  // override.
  const logFilePath = resolveLogFilePath({ subsystem: HOOKS_LOGGER_SUBSYSTEM });

  const capture = prepareDetachedChildOutputCapture({
    cardId: params.cardId,
    sessionId: params.sessionId,
    childKind: 'branch-cleanup-watcher'
  });
  if (!capture.ok) {
    logger.warn('Branch-cleanup watcher output capture unavailable', {
      reason: capture.reason,
      cardId: params.cardId,
      sessionId: params.sessionId
    });
  }
  const capturePath = capture.ok ? capture.path : null;
  const childArgs = capture.ok ? [capture.preloadArg, selfPath, '--branch-cleanup'] : [selfPath, '--branch-cleanup'];
  const outputSink = capture.ok ? capture.fd : 'ignore';

  let child: ChildProcess;
  try {
    try {
      child = spawn(nodeBin, childArgs, {
        detached: true,
        stdio: ['pipe', outputSink, outputSink],
        // Detached, console-less root. On win32 the interpreter is a stock
        // console-subsystem `node.exe`; `windowsHide` prevents it and its `git`
        // descendants from opening console windows. The inherited regular-file
        // descriptor used for output capture remains compatible with this mode.
        // No-op on POSIX.
        windowsHide: true,
        // Give the detached child a working Logger target before it has even
        // parsed stdin — see resolveLogFilePath() in the SDK's Logger, which
        // checks this env var before falling back to repo-root discovery. Skip
        // setting it entirely when file logging is disabled (null) rather than
        // passing an empty/null value.
        env: logFilePath === null ? process.env : { ...process.env, CARDS_HOOKS_LOG_FILE: logFilePath }
      });
    } finally {
      if (capture.ok) capture.close();
    }
  } catch (error) {
    // Fail-open: log and return; cleanup will not run this session
    logger.error('Branch-cleanup watcher failed to spawn', {
      error: errorMessage(error),
      cardId: params.cardId,
      sessionId: params.sessionId
    });
    return;
  }

  // Registered synchronously, before any `await`, so a child that exits
  // immediately (as simulated in tests, or in a real fast crash) can never
  // fire 'exit' before this listener exists — inserting an `await` (e.g. for
  // the marker write below) ahead of this registration would open exactly
  // that race.
  let exited = false;
  let onExitedForGrace: (() => void) | undefined;
  child.on('exit', (code, signal) => {
    exited = true;
    logger.info('Branch-cleanup watcher process exited', {
      pid: child.pid,
      code,
      signal,
      cardId: params.cardId,
      sessionId: params.sessionId
    });
    onExitedForGrace?.();
  });

  child.stdin!.on('error', (err) => {
    // The parent may exit before stdin is fully drained; this is expected
    logger.warn('Branch-cleanup watcher stdin pipe error', {
      error: errorMessage(err),
      cardId: params.cardId,
      sessionId: params.sessionId
    });
  });

  child.stdin!.write(`${JSON.stringify(params)}\n`);
  child.stdin!.end();

  child.unref();

  // The grace-period race timer is constructed here — synchronously, still
  // before any `await` — rather than after the marker write below, so its
  // window starts counting from the moment the child was spawned, not from
  // whenever the (async) marker write happens to settle.
  //
  // Bounded race: give the parent a brief window to observe a child that
  // crashes or is killed immediately after spawn (the 'exit' handler above
  // otherwise fires far too late to matter — the parent tears down via
  // process.exit() before the detached child, which may retry for up to an
  // hour, ever gets there). Not a wait for the child's real work to finish.
  const graceRace = exited
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EXIT_GRACE_MS);
        onExitedForGrace = () => {
          clearTimeout(timer);
          resolve();
        };
      });

  const markerPath = await writeCleanupMarker(params.cardId, params.sessionId, logger);

  logger.info('Branch-cleanup watcher spawned', {
    pid: child.pid,
    cardId: params.cardId,
    sessionId: params.sessionId,
    markerPath,
    capturePath
  });

  await graceRace;
}

// ============================================================================
// Detached entry point
// ============================================================================

// How long the detached process waits for params on stdin before giving up.
const STDIN_TIMEOUT_MS = 10_000;

/**
 * Maximum time {@link cleanupMergedBranches} is allowed to run inside the
 * standalone worker before its git descendants are torn down and the worker
 * exits regardless of whether the underlying git work ever settles.
 */
const CLEANUP_DEADLINE_MS = 60_000;

/** Escalation windows applied to a git descendant that survives the deadline. */
const DESCENDANT_GRACEFUL_TIMEOUT_MS = 5_000;
const DESCENDANT_FORCE_TIMEOUT_MS = 5_000;

/** Outcome of {@link runCleanupWithDeadline}. */
export type CleanupDeadlineOutcome = 'completed' | 'timed-out';

/**
 * Runs {@link cleanupMergedBranches} under a hard wall-clock deadline.
 *
 * A bare `setTimeout`/`Promise.race` alone would abandon the git subprocess
 * tree {@link cleanupMergedBranches} spawns (fetch/merge/branch-delete
 * invocations) — the worker process would exit while orphaned git
 * descendants kept running unbounded. On timeout, this instead walks the
 * worker's own process-group membership through {@link ProcessTreeAuthority},
 * excludes the worker's own live pid (its control identity — the worker
 * itself is left to exit normally, never self-signalled), and TERM/KILLs
 * every remaining identity-verified descendant individually via
 * {@link terminateProcessMembers} — the same discipline the action-tree
 * terminator uses, never a group-wide signal.
 *
 * @param input - The card id and repo root {@link cleanupMergedBranches} needs.
 * @param input.cardId - The card ID for the session being cleaned up.
 * @param input.repoRoot - Absolute path to the repository root.
 * @param cardRepoPath - Absolute path to the card's git repository.
 * @param logger - Logger for diagnostics.
 * @param sessionId - Optional session id for correlation.
 * @param options - Overrides for tests.
 * @param options.authority - Injected process-tree authority (defaults to the real one).
 * @param options.deadlineMs - Deadline override (defaults to the real 60s).
 * @param options.descendantGracefulTimeoutMs - Descendant graceful-timeout override (defaults to the real 5s).
 * @param options.descendantForceTimeoutMs - Descendant force-timeout override (defaults to the real 5s).
 * @returns `'completed'` if cleanup settled before the deadline, otherwise
 *   `'timed-out'` after surviving descendants have been signalled.
 */
export async function runCleanupWithDeadline(
  input: { cardId: string; repoRoot: string },
  cardRepoPath: string,
  logger: ILogger,
  sessionId: string | undefined,
  options: {
    authority?: ProcessTreeAuthority;
    deadlineMs?: number;
    descendantGracefulTimeoutMs?: number;
    descendantForceTimeoutMs?: number;
  } = {}
): Promise<CleanupDeadlineOutcome> {
  const authority = options.authority ?? createProcessTreeAuthority();
  const deadlineMs = options.deadlineMs ?? CLEANUP_DEADLINE_MS;

  const work = cleanupMergedBranches(input, cardRepoPath, logger, sessionId);
  const timedOut = Symbol('timed-out');
  const raced = await Promise.race([
    work.then(() => 'completed' as const),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), deadlineMs))
  ]);

  if (raced === 'completed') return 'completed';

  logger.error('Branch-cleanup worker exceeded its deadline; terminating surviving git descendants', {
    deadlineMs,
    cardId: input.cardId,
    sessionId
  });
  await terminateSurvivingDescendants(authority, logger, {
    gracefulTimeoutMs: options.descendantGracefulTimeoutMs ?? DESCENDANT_GRACEFUL_TIMEOUT_MS,
    forceTimeoutMs: options.descendantForceTimeoutMs ?? DESCENDANT_FORCE_TIMEOUT_MS
  });
  // The abandoned cleanup work may still settle (or reject) later; observe it
  // so it never becomes an unhandled rejection. The worker exits regardless.
  work.catch((error: unknown) => {
    logger.warn('Branch-cleanup worker: abandoned cleanup settled after the deadline', {
      error: errorMessage(error),
      cardId: input.cardId,
      sessionId
    });
  });
  return 'timed-out';
}

/**
 * Finds every process sharing the worker's own process group, excludes the
 * worker's own live pid, and TERM/KILLs the rest individually.
 *
 * @param authority - Identity and signaling authority.
 * @param logger - Logger for diagnostics.
 * @param escalation - Graceful/force escalation windows for descendants.
 * @param escalation.gracefulTimeoutMs - How long to wait after SIGTERM before escalating to SIGKILL.
 * @param escalation.forceTimeoutMs - How long to wait after SIGKILL before giving up.
 */
async function terminateSurvivingDescendants(
  authority: ProcessTreeAuthority,
  logger: ILogger,
  escalation: { gracefulTimeoutMs: number; forceTimeoutMs: number }
): Promise<void> {
  const own = await authority.identify(process.pid);
  if (own === null || !authority.members) {
    logger.warn('Branch-cleanup worker could not identify its own process group; skipping descendant termination');
    return;
  }
  const members = await authority.members(own);
  if (members === null) {
    logger.warn('Branch-cleanup worker could not enumerate its process group; skipping descendant termination');
    return;
  }
  const descendants = members.filter((member) => member.processId !== process.pid);
  if (descendants.length === 0) {
    logger.info('Branch-cleanup worker deadline exceeded, but no surviving git descendants were found');
    return;
  }
  const result = await terminateProcessMembers(descendants, authority, {
    gracefulTimeoutMs: escalation.gracefulTimeoutMs,
    forceTimeoutMs: escalation.forceTimeoutMs,
    excludeProcessId: process.pid
  });
  logger.info('Branch-cleanup worker terminated surviving git descendants', {
    result,
    descendantCount: descendants.length
  });
}

/**
 * Computes the deterministic absolute path for a card/session's
 * cleanup-attempt marker. Both the parent (which writes the marker in
 * {@link writeCleanupMarker}) and the detached child (which removes it once
 * cleanup settles) derive the same path from `cardId`/`sessionId` alone, so
 * the path never needs to be passed to the child over stdin.
 *
 * @param cardId - The card ID for the session being cleaned up.
 * @param sessionId - Optional session ID for correlation.
 * @returns The absolute marker path.
 */
function cleanupMarkerPath(cardId: string, sessionId: string | undefined): string {
  const markerDir = path.join(os.homedir(), '.cards', 'branch-cleanup-markers');
  return path.join(markerDir, `${cardId}-${sessionId ?? 'unknown'}.json`);
}

/**
 * Writes a marker file recording that a cleanup attempt started for this
 * card/session, so an external observer can distinguish "cleanup never
 * started" from "cleanup started but the process was killed before it could
 * log completion" — including the case where the detached child dies during
 * its own Node/ESM module bootstrap, before it can log anything at all.
 *
 * Called from the parent ({@link spawnBranchCleanupWatcher}), immediately
 * after a successful `spawn()`, rather than from the child — the parent is
 * the only process guaranteed to run before that bootstrap-kill window.
 * Degrades gracefully: a failure to create the marker is logged and
 * swallowed, matching this file's fail-open posture, and does not block or
 * fail the watcher spawn.
 *
 * @param cardId - The card ID for the session being cleaned up.
 * @param sessionId - Optional session ID for correlation.
 * @param logger - Logger for diagnostic output.
 * @returns The absolute marker path on success, or `undefined` if it could not be written.
 */
async function writeCleanupMarker(
  cardId: string,
  sessionId: string | undefined,
  logger: ILogger
): Promise<string | undefined> {
  const markerPath = cleanupMarkerPath(cardId, sessionId);
  try {
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ startedAt: new Date().toISOString() }));
    return markerPath;
  } catch (error) {
    logger.warn('Branch-cleanup watcher failed to write cleanup-attempt marker', {
      error: errorMessage(error),
      cardId,
      sessionId
    });
    return undefined;
  }
}

/**
 * Removes a cleanup-attempt marker written by {@link writeCleanupMarker}.
 * Called from the detached child, in its own `finally` block, once
 * {@link cleanupMergedBranches} settles (success or failure) — the child
 * recomputes the marker path via {@link cleanupMarkerPath} rather than
 * receiving it from the parent. Failures are logged and swallowed — a marker
 * that fails to delete is a stale-but-harmless leftover, not a reason to fail
 * the cleanup run.
 *
 * @param markerPath - Absolute path to the marker file.
 * @param logger - Logger for diagnostic output.
 */
async function removeCleanupMarker(markerPath: string, logger: ILogger): Promise<void> {
  try {
    await fs.rm(markerPath, { force: true });
  } catch (error) {
    logger.warn('Branch-cleanup watcher failed to remove cleanup-attempt marker', {
      error: errorMessage(error),
      markerPath
    });
  }
}

/**
 * Runs the detached branch-cleanup entry point: reads serialized
 * {@link BranchCleanupParams} from `stdin`, then calls
 * {@link cleanupMergedBranches}.
 *
 * Constructs its `Logger` immediately — before touching `stdin` at all — so
 * every failure mode between process start and cleanup completion leaves a
 * trace, including the stdin-timeout and JSON-parse-failure paths that
 * previously exited silently. The `Logger` resolves its target file via the
 * `CARDS_HOOKS_LOG_FILE` env var the parent sets in
 * {@link spawnBranchCleanupWatcher}.
 *
 * @param stdin - Readable stream to read serialized params from. Defaults to
 *   `process.stdin`; overridable so tests can inject a fake stream.
 * @returns `0` on success, `1` on any failure (stdin timeout, parse failure,
 *   or cleanup failure).
 */
export async function runDetachedCleanup(stdin: NodeJS.ReadableStream = process.stdin): Promise<number> {
  const logger = new Logger();
  logger.info('Branch-cleanup watcher process started', { pid: process.pid });

  // Mirrors executeCommand()'s parent-process SIGHUP handler (runtime.ts) —
  // the detached child gets its own process group via `detached: true`, but
  // nothing guarantees it can't still receive SIGHUP (e.g. if it inherits a
  // group before unref). Registering any 'SIGHUP' listener removes Node's
  // default terminate-on-SIGHUP disposition, so this is not just a log line:
  // a SIGHUP received mid-cleanup now runs to completion instead of killing
  // the process. That's intentional, mirroring the parent's own rationale
  // for surviving terminal-close signals — a closed terminal should not cut
  // off cleanup that is already in flight.
  process.on('SIGHUP', () => {
    logger.info('Branch-cleanup watcher received SIGHUP');
  });

  return new Promise<number>((resolve) => {
    const chunks: Buffer[] = [];

    // Fail-safe: if the parent dies before writing params, don't hang forever.
    const stdinTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      logger.error('Branch-cleanup watcher timed out waiting for stdin params', { timeoutMs: STDIN_TIMEOUT_MS });
      logger.close();
      process.exitCode = 1;
      resolve(1);
      process.exit(1);
    }, STDIN_TIMEOUT_MS);

    stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stdin.on('end', () => {
      clearTimeout(stdinTimer);

      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let params: BranchCleanupParams | undefined;
        try {
          params = JSON.parse(raw) as BranchCleanupParams;
        } catch (_error) {
          // Fatal: can't parse params. Unlike the pre-refactor version, the
          // logger already exists (it resolved via CARDS_HOOKS_LOG_FILE, set
          // by the parent before spawn), so this failure is no longer silent.
          logger.error('Branch-cleanup watcher failed to parse stdin params', { rawLength: raw.length });
          logger.close();
          process.exitCode = 1;
          resolve(1);
          process.exit(1);
        }

        // `process.exit()` above is `never`-typed and always terminates the
        // real process; this guard only matters in tests where it's stubbed,
        // so execution doesn't fall through into the destructure below with
        // an unset `params`.
        if (params === undefined) return;

        const { cardId, repoRoot, cardRepoPath, sessionId } = params;
        const input = { cardId, repoRoot };
        logger.info('Branch-cleanup watcher started', { cardId, sessionId });

        // Recomputed rather than passed over stdin: the marker path is a
        // deterministic function of cardId/sessionId, and the marker itself
        // was already written by the parent in spawnBranchCleanupWatcher()
        // before this child could have logged anything.
        const markerPath = cleanupMarkerPath(cardId, sessionId);
        try {
          const client = await createCardsClient();
          if (!client) {
            throw new Error('Cards API discovery failed — cannot run branch cleanup');
          }

          const startedAt = performance.now();
          const outcome = await runCleanupWithDeadline(input, cardRepoPath, logger, sessionId);
          logger.info('Branch-cleanup watcher completed', {
            cardId,
            sessionId,
            outcome,
            elapsedMs: Math.round(performance.now() - startedAt)
          });
          resolve(outcome === 'completed' ? 0 : 1);
        } catch (error) {
          const message = errorMessage(error);
          logger.error('Branch-cleanup watcher failed', { error: message, cardId, sessionId });
          resolve(1);
        } finally {
          await removeCleanupMarker(markerPath, logger);
          logger.close();
        }
      })();
    });
  });
}

if (process.argv.includes('--branch-cleanup')) {
  void runDetachedCleanup().then((code) => {
    process.exitCode = code;
  });
}

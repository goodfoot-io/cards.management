/**
 * Detached ad-hoc session cleanup process.
 *
 * Spawned by the EnterWorktree (PostToolUse) hook when a plain (non-action)
 * Claude session enters a card-owned worktree. Marks the card `active` via the API client,
 * writes a per-card reference file (recording the agent PID and its start-time
 * to defeat PID reuse), then polls the agent PID. On PID death it performs
 * ref-counted teardown — asking the Cards API to move the card to
 * `needs_review` only when no other live ad-hoc session remains. API failure is
 * surfaced and the reference remains for an explicit retry; teardown never
 * edits or commits card metadata directly. The de-dupe lock is released only by the
 * cleanup that owns it: when a second card binds within an already-locked
 * session, its cleanup is spawned with an EMPTY lock path and never touches
 * the lock (or the session-scoped unbound-candidate state) on teardown.
 *
 * Touches status only — no `git clean -fd` (that is the wrapper's job for
 * action-spawned sessions).
 *
 * @summary Detached ad-hoc session cleanup process
 * @module
 */

import { mkdir, unlink } from 'node:fs/promises';
import { createCardsClient } from '../client/api-discovery.js';
import type { CardUpdateData } from '../client/types/client.js';
import { clearUnboundCandidates } from '../unboundWorktreeCandidates.js';
import { adhocActiveDir, liveRefsRemain, removeRef, writeRef } from './adhoc-refs.js';
import { readProcessStartTime } from './process-utils.js';

export { adhocActiveDir, liveRefsRemain } from './adhoc-refs.js';

/** Interval for periodic PID liveness checks (5 seconds). */
export const PID_POLL_INTERVAL_MS = 5_000;

/**
 * Arguments parsed from process.argv for the ad-hoc cleanup process.
 */
export interface AdhocCleanupArgs {
  /** PID of the Claude agent process to monitor. */
  agentPid: number;
  /** Session identifier (UUID) for this ad-hoc session. */
  sessionId: string;
  /** Card identifier (e.g. `main-96`). */
  cardId: string;
  /** Filesystem path to the card repository. */
  cardRepoPath: string;
  /**
   * Filesystem path to the de-dupe lock file to remove on exit, or the empty
   * string when this cleanup does not own the session lock (a later card
   * bound while an earlier card's cleanup held it). Non-owners skip the lock
   * release and the session-scoped candidate clear on teardown.
   */
  lockPath: string;
}

/**
 * Parses cleanup arguments from process.argv.
 *
 * Expects argv in the format:
 * `[node, script, agentPid, sessionId, cardId, cardRepoPath, lockPath]`
 *
 * @param argv - The process.argv array.
 * @returns Parsed cleanup arguments.
 */
export function parseArgs(argv: string[]): AdhocCleanupArgs {
  return {
    agentPid: Number(argv[2]),
    sessionId: argv[3]!,
    cardId: argv[4]!,
    cardRepoPath: argv[5]!,
    lockPath: argv[6]!
  };
}

/**
 * Minimal logger interface used by ad-hoc cleanup.
 */
export interface CleanupLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * Minimal Cards client surface the teardown depends on — just the status
 * update. Declared as a structural interface so {@link performTeardown} can be
 * exercised against a real in-test implementation rather than the full client.
 */
export interface TeardownClient {
  updateCard(cardId: string, data: CardUpdateData): Promise<unknown>;
}

const consoleLogger: CleanupLogger = {
  warn(message, data) {
    process.stderr.write(`adhoc-cleanup: ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`);
  }
};

/**
 * Removes a file, ignoring ENOENT.
 *
 * @param path - Absolute path to remove.
 */
async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Main entry point for the detached ad-hoc cleanup process.
 *
 * The agent PID's start-time is captured up front (and persisted in the ref
 * file) so the poll loop treats a recycled PID — same number, different
 * process — as dead rather than waiting forever on a stranger.
 *
 * @param logger - Logger for warn output (defaults to a stderr logger).
 */
export async function main(logger: CleanupLogger = consoleLogger): Promise<void> {
  const { agentPid, sessionId, cardId, cardRepoPath, lockPath } = parseArgs(process.argv);

  // Capture the monitored PID's start-time to defeat PID reuse.
  const startTime = readProcessStartTime(agentPid);
  if (startTime === null) {
    throw new Error(`Cannot monitor PID ${agentPid}: process start time is unavailable`);
  }

  const client = await createCardsClient();
  if (client === null) {
    // No server means no watchable card. Skip active write and teardown,
    // remove the lock (if this cleanup owns it), and exit.
    if (lockPath !== '') {
      await unlinkIfExists(lockPath);
    }
    return;
  }

  // 1. Mark active via API. (The hook's entry guard has already confirmed the
  //    card is in a working/pre-work state before spawning this process.)
  try {
    await client.updateCard(cardId, { status: 'active', author: 'system <system@cards.local>' });
  } catch (error) {
    // Transient API error — leave the lock in place so stale-recovery covers it.
    logger.warn('failed to mark card active — exiting without lock removal', {
      cardId,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  // 2. Write the per-card reference file (records pid + start-time).
  await mkdir(adhocActiveDir(cardId), { recursive: true });
  await writeRef(cardId, sessionId, agentPid);

  // 3. Poll the PID until it dies (or is recycled to a different process).
  while (readProcessStartTime(agentPid) === startTime) {
    await new Promise<void>((resolve) => setTimeout(resolve, PID_POLL_INTERVAL_MS));
  }

  // 4 + 5. Teardown (status resolution + lock release).
  await performTeardown(client, { sessionId, cardId, cardRepoPath, lockPath }, logger);
}

/**
 * Teardown invoked once the monitored agent PID is dead: resolve the card's
 * status and release the de-dupe lock.
 *
 * The de-dupe lock is keyed on this (now-dead) session and is released on
 * exit by the cleanup that OWNS it (`lockPath` non-empty); a non-owner cleanup
 * (second card bound under an already-held session lock, spawned with an
 * empty `lockPath`) leaves both the lock and the session-scoped
 * unbound-candidate state to the owner. This session's ref is removed only
 * after another live session is confirmed or the Cards API accepts the final
 * status update. An API failure keeps the ref as durable retry evidence.
 *
 * @param client - Cards client used for the `needs_review` API write.
 * @param args - The session/card/lock identifiers for this teardown.
 * @param logger - Logger for warn output.
 */
export async function performTeardown(
  client: TeardownClient,
  args: Pick<AdhocCleanupArgs, 'sessionId' | 'cardId' | 'cardRepoPath' | 'lockPath'>,
  logger: CleanupLogger
): Promise<void> {
  const { sessionId, cardId, lockPath } = args;
  try {
    if (await liveRefsRemain(cardId, sessionId, logger)) {
      // Another live ad-hoc session already owns `active`. This session's ref
      // is no longer needed; remove it and leave status to the surviving ref.
      await removeRef(cardId, sessionId);
    } else {
      // No other live ad-hoc session remains, so this session resolves the card.
      await client.updateCard(cardId, { status: 'needs_review', author: 'system <system@cards.local>' });
      await removeRef(cardId, sessionId);
    }
  } finally {
    // Session-end teardown — lock-owner only. In a `finally` so a rethrow from
    // API failure does not leak the lock or strand the per-session candidate
    // directory. A non-owner cleanup
    // (empty lockPath) skips both: unlinking the lock would break the
    // one-watcher-per-session de-dupe, and the session-scoped candidate state
    // belongs to the lock owner.
    if (lockPath !== '') {
      // Release the de-dupe lock.
      await unlinkIfExists(lockPath);
      // Remove this session's unbound-worktree candidate directory so per-session
      // `~/.cards/adhoc-sessions/<sid>/unbound-candidates/` dirs do not leak. The
      // clear is ENOENT-tolerant (sessions that never created a candidate have no
      // directory to remove).
      await clearUnboundCandidates(sessionId);
    }
  }
}

if (process.argv[1]?.endsWith('adhoc-cleanup.mjs') || process.argv[1]?.endsWith('adhoc-cleanup.ts')) {
  main().catch((error) => {
    process.stderr.write(`adhoc-cleanup: fatal error: ${String(error)}\n`);
    process.exitCode = 1;
  });
}

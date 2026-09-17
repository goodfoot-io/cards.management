/**
 * Standalone branch-cleanup worker, run out-of-process after an interactive
 * session ends.
 *
 * The provider durably registers `execution.branchCleanupRegistration` while
 * it still holds its session-specific inputs (see `context
 * .reportBranchCleanupRegistration` in the four `*-session.ts` files); the
 * server journals `execution.branchCleanupEffect` from that registration once
 * the wrapper reports the session drained, and the extension's effect
 * authority spawns this module's packaged `dist/bin/branch-cleanup-watcher`
 * binary to actually run {@link cleanupMergedBranches}. This module owns only
 * that worker logic — spawning it is the extension's job
 * (`branchCleanupEffect.ts`), not this package's.
 *
 * @summary Standalone branch-cleanup worker
 * @module
 */

import { createCardsClient } from '@cards.management/sdk/client/discovery';
import type { ILogger } from '@cards.management/sdk/config';
import { cleanupMergedBranches, errorMessage } from './claude-session.js';
import {
  createProcessTreeAuthority,
  type ProcessTreeAuthority,
  terminateProcessMembers
} from './process-tree-termination.js';

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
 * Runs branch cleanup for one already-parsed set of parameters — the worker
 * logic the installed `dist/bin/branch-cleanup-watcher` CLI entry delegates
 * to once it has read {@link BranchCleanupParams} off the environment the
 * extension's effect authority spawned it with.
 *
 * Runs {@link cleanupMergedBranches} under {@link runCleanupWithDeadline}.
 *
 * @param params - The cleanup parameters.
 * @param logger - Logger for diagnostics; this function does not construct
 *   or close one itself.
 * @param options - Forwarded to {@link runCleanupWithDeadline} (deadline,
 *   descendant escalation windows, and an injectable authority for tests).
 * @returns `0` on success, `1` on any failure (discovery failure, cleanup
 *   failure, or deadline timeout).
 */
export async function runBranchCleanupWorker(
  params: BranchCleanupParams,
  logger: ILogger,
  options: Parameters<typeof runCleanupWithDeadline>[4] = {}
): Promise<number> {
  const { cardId, repoRoot, cardRepoPath, sessionId } = params;
  const input = { cardId, repoRoot };
  logger.info('Branch-cleanup watcher started', { cardId, sessionId });

  try {
    const client = await createCardsClient();
    if (!client) {
      throw new Error('Cards API discovery failed — cannot run branch cleanup');
    }

    const startedAt = performance.now();
    const outcome = await runCleanupWithDeadline(input, cardRepoPath, logger, sessionId, options);
    logger.info('Branch-cleanup watcher completed', {
      cardId,
      sessionId,
      outcome,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
    return outcome === 'completed' ? 0 : 1;
  } catch (error) {
    const message = errorMessage(error);
    logger.error('Branch-cleanup watcher failed', { error: message, cardId, sessionId });
    return 1;
  }
}

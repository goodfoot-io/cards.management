/**
 * Orchestrators that pair git-worktree creation/removal with the card-repo
 * branch record via CardsClient. The bare createWorktree / removeWorktree
 * primitives in worktree.ts remain client-free; this module is the only place
 * that imports CardsClient alongside those primitives.
 *
 * @summary Card-bound worktree lifecycle orchestrators
 * @module worktreeForCard
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireLock, releaseLock } from '@cards.management/sessions/internal';
import { resolveCardRepoPath } from './adhocAttribution.js';
import { isKnownAgentComm } from './bin/process-utils.js';
import { spawnAdhocAttribution } from './bin/spawnAdhocAttribution.js';
import { resolveGlobalCardsConfigDir } from './cards-config.js';
import { writeCardsParentConfig } from './cardsParentBranch.js';
import type { CardsClient } from './client/cardsClient.js';
import { findAgentPid } from './process-tree.js';
import {
  appendWorktreeGitExcludes,
  captureOriginalHooksPath,
  cleanupFailedWorktree,
  clearCardBoundFile,
  createWorktree,
  type EarlyWorktreeResult,
  findGitRoots,
  gitConfigWithRetry,
  provisionSharedHooksDir,
  removeWorktree,
  resolveHomeDir,
  WorktreeSettlementCleanupError,
  writeCardBoundFile
} from './worktree.js';
import { createWorktreePerf } from './worktreePerf.js';

const execFileAsync = promisify(execFile);

/**
 * Returns the initiating settle failure, excluding stale inner cleanup diagnostics.
 *
 * @param error - Settlement rejection from the lower worktree lifecycle.
 * @returns The underlying initiating failure when cleanup was retried.
 */
function initiatingSettlementFailure(error: unknown): unknown {
  return error instanceof WorktreeSettlementCleanupError ? error.settlementCause : error;
}

/**
 * Resolves the shared hooks dispatcher directory every card-bound worktree's
 * per-worktree `core.hooksPath` points at.
 *
 * Single source of truth for the durable bind artifact: {@link outfitWorktreeForCard}
 * installs it and {@link releaseWorktreeForCard} restores the original value, so
 * a worktree whose effective `core.hooksPath` equals this path carries cards
 * binding machinery even when the `.cards/CARD_ID` marker was lost. The bind
 * gates in the CLI consult this so "already bound" survives marker loss.
 *
 * @returns Absolute path of the shared hooks dispatcher dir.
 */
export function cardsSharedHooksDir(): string {
  return join(resolveHomeDir(), '.cards', 'workspace-hooks');
}

/**
 * Minimal stderr logger shared by the outfit/release attribution path.
 *
 * The orchestrators have no structured logger, but {@link spawnAdhocAttribution}
 * and the adhoc-attribution helpers require a `warn`/`error` interface. Routing
 * diagnostics to stderr keeps stdout clean for any CLI caller whose stdout is a
 * machine-readable payload.
 */
const stderrLogger = {
  warn(message: string, data?: Record<string, unknown>): void {
    process.stderr.write(`${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`);
  },
  error(message: string, data?: Record<string, unknown>): void {
    process.stderr.write(`${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`);
  }
};

/** Maximum wait for the cross-process bind lock before failing closed. */
const BIND_LOCK_TIMEOUT_MS = 5_000;

/**
 * Resolves the cross-process advisory lock path for binding a given worktree.
 *
 * The worktree's absolute path is hashed (sha-256, hex) into a single safe
 * filename under `<globalCardsConfigDir>/bind-locks/`, so two `cards create`
 * invocations targeting the same worktree contend on the same lock file
 * regardless of process. Hashing avoids path-separator and length issues from
 * embedding the directory verbatim in a filename.
 *
 * @param worktreeDir - Absolute worktree root.
 * @returns Absolute path to the worktree's bind lock file.
 */
function resolveBindLockPath(worktreeDir: string): string {
  const hash = createHash('sha256').update(worktreeDir).digest('hex');
  return join(resolveGlobalCardsConfigDir(), 'bind-locks', `${hash}.lock`);
}

/**
 * Raised by {@link removeWorktreeForCard} when the worktree was torn down from
 * disk successfully but unregistering its branch record failed.
 *
 * This makes the failed phase explicit so callers can apply the correct
 * fail-open stance (the disk teardown succeeded; only the recoverable branch
 * record is orphaned) instead of inferring the phase from path existence. A
 * teardown failure ({@link removeWorktree} rejecting) propagates untouched and
 * is therefore *not* wrapped in this error.
 */
export class BranchUnregisterError extends Error {
  /** The underlying error thrown by `client.removeBranch`. */
  public readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `Failed to unregister branch record after worktree removal: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = 'BranchUnregisterError';
    this.cause = cause;
  }
}

export interface OutfitWorktreeForCardOptions {
  /** Card identifier this worktree is bound to. */
  cardId: string;
  /** Parent branch from which the worktree's branch was created, recorded in branches.json. */
  parentBranch: string;
  /** Session ID forwarded to addBranch and the attribution spawn for commit attribution. */
  sessionId?: string;
  /**
   * Path to the session transcript to watch. When omitted/empty the attribution
   * phase is skipped — this is the creation-time path, where attribution is
   * owned by the runtime session machinery, not the worktree orchestrator.
   */
  transcriptPath?: string;
  /**
   * Open runtime identifier for the session supplying `transcriptPath`, e.g.
   * `'claude-code'` or `'codex'` — forwarded to {@link spawnAdhocAttribution}
   * to select the {@link SessionSyncManifest} adapter. Required whenever
   * `transcriptPath` is supplied (checked below); irrelevant otherwise, since
   * no attribution attempt is made without a transcript.
   */
  runtime?: string;
  /** Map of git hook name to compiled .mjs path — required to avoid D10a attribution loss. */
  compiledScriptPaths: Record<string, string>;
  /**
   * Agent PID to monitor for cleanup teardown. When provided by the caller
   * (e.g. the `cards create` CLI passing its own `process.pid`), this PID is
   * forwarded to {@link spawnAdhocAttribution} instead of resolving one via
   * {@link findAgentPid}. When omitted the orchestrator resolves the PID by
   * walking the process tree — correct for re-attach paths where the ambient
   * agent session IS the work session, but wrong for first-bind paths where
   * the CLI process exit (not the agent exit) marks the end of the logical
   * unit of work on the card.
   */
  agentPid?: number;
  /** Registration intent. Binding/reattachment upserts unless creation explicitly requires absence. */
  registrationIntent?: 'create' | 'upsert';
}

/**
 * Attribution outcome resolved by {@link outfitWorktreeForCard}.
 *
 * `attribution: 'spawned'` means {@link spawnAdhocAttribution} ran and did not
 * report a skipped activation. `attribution: 'skipped'` means session
 * activation did not happen, with `reason` naming why (preflight skip such as
 * `'no-transcript'`, `'card-repo-path-unresolved'`, `'agent-pid-unresolved'`,
 * or a guard skip propagated from the spawn helper:
 * `'not-activatable'`). `activated: false` is set when the spawn helper itself
 * reported the skip. The branch registration and disk phases have already
 * succeeded by the time this outcome is produced — a skip means "branch
 * registered but card not activated".
 */
export interface OutfitAttributionOutcome {
  /** Whether transcript attribution was spawned or skipped. */
  attribution: 'spawned' | 'skipped';
  /** Set to false when {@link spawnAdhocAttribution} reported a skipped activation. */
  activated?: boolean;
  /** Why attribution was skipped; present only when `attribution` is `'skipped'`. */
  reason?: string;
  /** Opaque revision returned by the branch registration write. */
  registrationRevision: string;
}

/**
 * Outfits an existing worktree as card-bound: installs the commit-attribution
 * hooks on disk, registers the branch with the Cards API, and (when a transcript
 * is supplied) spawns transcript attribution.
 *
 * This is the single orchestrator both the creation-time and bind-time paths
 * funnel through, so the on-disk binding and API registration cannot drift
 * between them. It owns three ordered phases:
 *
 * **Disk phase** (synchronous before any caller commits, for the creation-time
 * flow — preserves the A2 guarantee). Every step is idempotent so a re-run after
 * a partial crash heals the worktree rather than corrupting it:
 * 1. Write `.cards/CARD_ID` ({@link writeCardBoundFile}, idempotent overwrite).
 * 2. Snapshot the original hooks path — GUARDED: skipped if
 *    `.cards/CARD_ORIGINAL_HOOK_PATH` already exists, so a re-run can never
 *    capture the cards hooks dir as the "original".
 * 3. Provision the shared dispatcher dir (idempotent).
 * 4. Enable `extensions.worktreeConfig` (idempotent git config).
 * 5. Set per-worktree `core.hooksPath` (idempotent git config --worktree).
 * 6. Append `.cards/CARD_ID` and `.cards/CARD_ORIGINAL_HOOK_PATH` to git excludes.
 *
 * **API phase** — `client.addBranch(...)` under the cross-process advisory bind
 * lock. No client-side pre-check (that would reintroduce the TOCTOU); the store's
 * upsert semantics make a re-run safe.
 *
 * **Attribution phase** — when `transcriptPath` is supplied, run
 * {@link spawnAdhocAttribution}. Activation is deliberately NOT written here — it
 * stays inside `adhoc-cleanup`, preserving the invariant that an `active` card
 * always has a live monitor and ref. The activatable-status guard and de-dupe
 * lock inside `spawnAdhocAttribution` are preserved untouched.
 *
 * @param client - CardsClient used to register the branch record.
 * @param worktreeDir - Absolute path to the (already-created) worktree root.
 * @param options - Card id, parent branch, session, transcript, and compiled hook paths.
 * @returns An {@link OutfitAttributionOutcome} describing whether attribution
 *   was spawned or skipped (and why), so callers like `cards <id> attach` can
 *   fail closed when the branch was registered but the card was not activated.
 */
export async function outfitWorktreeForCard(
  client: CardsClient,
  worktreeDir: string,
  options: OutfitWorktreeForCardOptions
): Promise<OutfitAttributionOutcome> {
  const { cardId, parentBranch, sessionId, transcriptPath, runtime, compiledScriptPaths } = options;

  if (cardId.length === 0) {
    throw new Error('outfitWorktreeForCard: cardId must be a non-empty string');
  }
  // D10a guard: dispatchers without .mjs files silently lose attribution.
  if (Object.keys(compiledScriptPaths).length === 0) {
    throw new Error('outfitWorktreeForCard: compiledScriptPaths must be non-empty');
  }

  // --- Disk phase (A2-critical for creation-time, idempotent for re-runs) ---

  // Opt-in phase timing (CARDS_WORKTREE_PERF). outfit runs synchronously before
  // the card-bound launch hands the worktree to the agent, so its local ops are
  // on the perceived-latency path; a no-op fast path when the env var is unset.
  const perf = createWorktreePerf();

  const { repoRoot } = await perf.measure('outfit:findGitRoots', () => findGitRoots(worktreeDir));

  const sharedHooksDir = cardsSharedHooksDir();
  const originalHookPathFile = join(worktreeDir, '.cards', 'CARD_ORIGINAL_HOOK_PATH');

  // 1. Write .cards/CARD_ID first — this mkdir -p's .cards, which the hooks-path
  //    snapshot below writes into. Cheap (one mkdir + small write).
  await perf.measure('outfit:writeCardBoundFile', () => writeCardBoundFile(worktreeDir, cardId));

  // The remaining disk-phase steps are mutually independent — they write disjoint
  // paths and none performs a shared git-config WRITE (the two reads, rev-parse
  // and `config --get core.hooksPath`, do not take the config lock) — so they run
  // concurrently instead of serially. The branch name is resolved here too so it
  // is ready for the API phase. The ordered git-config writes (steps below) are
  // the only part that must stay sequential.
  const [, , , branchName] = await perf.measure('outfit:disk-parallel', () =>
    Promise.all([
      // 2. Snapshot the pre-existing hooks dir — GUARDED. If the snapshot already
      //    exists, a previous outfit already captured the user's original hooks
      //    dir; re-capturing now would record the cards shared dispatcher dir as
      //    the "original" and break hook chaining. Skip on re-run. The per-worktree
      //    `core.hooksPath` set below is a `--worktree` write, so it cannot change
      //    the repo-level `core.hooksPath` this reads — capture is order-independent.
      perf.measure('outfit:captureOriginalHooks', async () => {
        let originalHookPathExists = false;
        try {
          await access(originalHookPathFile);
          originalHookPathExists = true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        if (!originalHookPathExists) {
          const originalHooksDir = await captureOriginalHooksPath(repoRoot);
          await writeFile(originalHookPathFile, originalHooksDir);
        }
      }),
      // 3. Provision the shared dispatcher dir (idempotent, content-addressed skip).
      //    Global flat location (`~/.cards/workspace-hooks`); byte-identical across
      //    worktrees. `$HOME` is the same anchor the dispatcher uses for VSCODE_NODE.
      perf.measure('outfit:provisionSharedHooksDir', () =>
        provisionSharedHooksDir(sharedHooksDir, compiledScriptPaths)
      ),
      // 6. Hide the binding markers from git status so they are never staged.
      perf.measure('outfit:appendWorktreeGitExcludes', () =>
        appendWorktreeGitExcludes(worktreeDir, ['.cards/CARD_ID', '.cards/CARD_ORIGINAL_HOOK_PATH'])
      ),
      // Resolve the branch name now so the API phase need not wait on a git read.
      perf.measure('outfit:resolveBranchName', () => resolveWorktreeBranchName(worktreeDir))
    ])
  );

  // 4 + 5. Ordered git-config chain: enable per-worktree config on the repo
  //   (MUST precede the --worktree write, D9), then point this worktree at the
  //   shared dispatcher dir. Retried on config-lock contention: createWorktree's
  //   settle phase writes the same repo key concurrently on the early path.
  await perf.measure('outfit:config:worktreeConfig', () =>
    gitConfigWithRetry(['-C', repoRoot, 'config', 'extensions.worktreeConfig', 'true'])
  );
  await perf.measure('outfit:config:hooksPath', () =>
    gitConfigWithRetry(['-C', worktreeDir, 'config', '--worktree', 'core.hooksPath', sharedHooksDir])
  );

  // --- API phase ---

  // Serialize concurrent outfits against the same worktree across processes so
  // a re-run race cannot duplicate the addBranch POST. No client-side
  // pre-check: the store upserts, and a pre-check would reintroduce the TOCTOU.
  // Fail-closed: a lock-acquire timeout propagates.
  const lockPath = resolveBindLockPath(worktreeDir);
  let registrationRevision!: string;
  await perf.measure('outfit:acquireLock', () => acquireLock(lockPath, BIND_LOCK_TIMEOUT_MS));
  try {
    // Record the parent branch as durable `branch.<name>.cardsParent` git
    // config — the first source resolveCardsParentBranch consults at bind
    // time — so card-bound worktrees carry the same lineage record as unbound
    // ones and never depend on fragile reflog decoration. Idempotent overwrite.
    await perf.measure('outfit:writeCardsParentConfig', () =>
      writeCardsParentConfig(worktreeDir, branchName, parentBranch)
    );
    const registration = await perf.measure('outfit:addBranch', () =>
      client.addBranch(
        cardId,
        {
          name: branchName,
          worktree: worktreeDir,
          parentBranch,
          intent: options.registrationIntent ?? 'upsert'
        },
        { sessionId }
      )
    );
    registrationRevision = registration.revision;
  } finally {
    releaseLock(lockPath);
  }

  // --- Attribution phase ---

  // Only spawn when a transcript is supplied. The creation-time flow omits it —
  // attribution there is owned by the runtime session machinery, not this
  // orchestrator — so omitting the transcript leaves action-launch behavior
  // unchanged. Activation is NOT written here; it stays inside adhoc-cleanup so
  // an `active` card always has a live monitor + ref.
  if (!transcriptPath || transcriptPath.length === 0 || !sessionId || sessionId.length === 0) {
    return { attribution: 'skipped', reason: 'no-transcript', registrationRevision };
  }

  // A transcript with no resolvable runtime cannot select a SessionSyncManifest
  // adapter — fail closed rather than guess at the caller's agent.
  if (!runtime || runtime.length === 0) {
    stderrLogger.warn(
      'outfitWorktreeForCard: bound worktree but could not resolve the session runtime — attribution not spawned',
      { cardId }
    );
    return { attribution: 'skipped', reason: 'runtime-unresolved', registrationRevision };
  }

  const cardRepoPath = await resolveCardRepoPath(cardId, stderrLogger);
  if (!cardRepoPath) {
    stderrLogger.warn(
      'outfitWorktreeForCard: bound worktree but could not resolve card repository path — attribution not spawned',
      {
        cardId
      }
    );
    return { attribution: 'skipped', reason: 'card-repo-path-unresolved', registrationRevision };
  }

  const agentPid = options.agentPid ?? (await findAgentPid());
  if (!agentPid || !isKnownAgentComm(agentPid, stderrLogger)) {
    stderrLogger.warn(
      'outfitWorktreeForCard: bound worktree but could not resolve a known agent PID — attribution not spawned',
      {
        cardId
      }
    );
    return { attribution: 'skipped', reason: 'agent-pid-unresolved', registrationRevision };
  }

  const attributionLockPath = join(resolveGlobalCardsConfigDir(), 'adhoc-sessions', `${sessionId}.lock`);
  const spawnOutcome = await spawnAdhocAttribution(
    { agentPid, sessionId, transcriptPath, cardId, cardRepoPath, lockPath: attributionLockPath, runtime },
    stderrLogger
  );
  if (spawnOutcome && spawnOutcome.activated === false) {
    return { attribution: 'skipped', activated: false, reason: spawnOutcome.reason, registrationRevision };
  }
  return { attribution: 'spawned', registrationRevision };
}

/**
 * Resolves a worktree's checked-out branch name via
 * `git -C <dir> rev-parse --abbrev-ref HEAD`.
 *
 * @param worktreeDir - Absolute worktree root.
 * @returns The trimmed branch name.
 */
async function resolveWorktreeBranchName(worktreeDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    timeout: 5_000
  });
  return stdout.trim();
}

export interface CreateWorktreeForCardOptions {
  /** Working directory used when locating git roots. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Card identifier — required because every caller of this orchestrator is card-bound. */
  cardId: string;
  /** Map of git hook name to compiled .mjs path — required to avoid D10a attribution loss. */
  compiledScriptPaths: Record<string, string>;
  /** Parent branch from which the worktree's branch was created, recorded in branches.json. */
  parentBranch: string;
  /** Session ID forwarded to addBranch for commit attribution. */
  sessionId?: string;
  /** Whether registration must create a new record or may repair an existing one. */
  registrationIntent: 'create' | 'upsert';
}

/**
 * Creates a card-bound worktree and registers the branch with the Cards API.
 *
 * Composes the pure {@link createWorktree} git primitive with
 * {@link outfitWorktreeForCard}: it creates the worktree on disk, then — using
 * the EARLY worktree path (before `settle` resolves) — outfits it (installs the
 * attribution hooks and registers the branch) so the agent session can spawn
 * immediately without waiting for symlink wiring to finish. Outfit runs
 * synchronously before `settle` is returned, preserving the A2 guarantee for the
 * creation-time flow (the disk phase is in place before any caller can commit).
 *
 * Returns the same `{ path, settle }` shape after settlement completes. The
 * early path remains available internally to outfit, but is not handed to an
 * external consumer while rollback still owns the right to remove it.
 *
 * @param client - CardsClient used to register the branch record.
 * @param ref - Branch name to create.
 * @param options - Card-binding options.
 * @returns EarlyWorktreeResult — path is usable immediately, settle resolves later.
 */
export async function createWorktreeForCard(
  client: CardsClient,
  ref: string,
  options: CreateWorktreeForCardOptions
): Promise<EarlyWorktreeResult> {
  const { cwd, cardId, compiledScriptPaths, parentBranch, sessionId, registrationIntent } = options;

  // Settlement and outfit deliberately overlap on the early path. Keep cleanup
  // here, above both operations, so settlement cannot remove the worktree while
  // outfit is still configuring it. Standalone createWorktree callers retain
  // the primitive's default fail-closed cleanup behavior.
  const result = await createWorktree(ref, { cwd, cleanupOnSettleFailure: false });
  const cleanupCreatedResources = async (): Promise<string[]> => {
    if (!result.repoRoot) {
      // Legacy/test implementations without ownership metadata can still
      // remove the worktree, but must never guess that a branch is ours.
      try {
        await removeWorktree(result.path);
        return [];
      } catch (error: unknown) {
        return [`worktree=${result.path} may remain: ${error instanceof Error ? error.message : String(error)}`];
      }
    }
    return cleanupFailedWorktree(result.repoRoot, result.path, result.createdBranch);
  };

  // Attach a no-op rejection handler to settle immediately, before any
  // outfit work or await points. The settle promise runs concurrently with
  // outfitWorktreeForCard — if settle rejects (e.g. copyCardsDirectory
  // hitting EEXIST because outfit already created .cards/) before a caller
  // attaches its own handler, the rejection surfaces as an unhandled
  // rejection and crashes the process. Callers that care about settle
  // health attach their own handler and observe the outcome; this handler
  // is a safety net, not a semantic consumer.
  void result.settle.catch(() => undefined);

  try {
    const outfit = await outfitWorktreeForCard(client, result.path, {
      cardId,
      parentBranch,
      sessionId,
      compiledScriptPaths,
      registrationIntent
    });

    // Settlement owns all asynchronous materialization. If it fails, wait for
    // that work to become quiescent (the rejection is the boundary), then
    // conditionally release only the registration revision created here before
    // removing the invocation-owned Git worktree and branch.
    const settle = result.settle.catch(async (settleError: unknown) => {
      const initiatingError = initiatingSettlementFailure(settleError);
      try {
        await client.removeBranch(cardId, ref, {
          sessionId,
          expectedRevision: outfit.registrationRevision
        });
      } catch (error: unknown) {
        // A conditional unregister failure can mean a newer registration now
        // owns this path. Preserve the Git resources rather than deleting them
        // beneath that owner. It is also the safest response to an ambiguous
        // transport failure: retry/reconciliation can inspect intact state.
        throw new Error(
          `createWorktreeForCard: settlement failed and rollback was not attempted at ${result.path}: ` +
            `settle=${initiatingError instanceof Error ? initiatingError.message : String(initiatingError)}; ` +
            `registration=${error instanceof Error ? error.message : String(error)}`,
          { cause: initiatingError }
        );
      }
      const cleanupFailures = await cleanupCreatedResources();
      if (cleanupFailures.length > 0) {
        throw new Error(
          `createWorktreeForCard: settlement failed and rollback was incomplete at ${result.path}: ` +
            `settle=${initiatingError instanceof Error ? initiatingError.message : String(initiatingError)}; ` +
            cleanupFailures.join('; ')
        );
      }
      throw initiatingError;
    });

    // Do not publish the worktree path while this invocation can still roll it
    // back. Awaiting here preserves the early overlap between settlement and
    // outfit without allowing a launched process to acquire the path first.
    // Return (rather than await) the guarded handoff promise so a settlement
    // rejection is not mistaken for an outfit failure by the catch below.
    return settle.then(() => ({ path: result.path, settle }));
  } catch (outfitError) {
    // Atomicity: the worktree dir + git branch now exist on disk but outfit
    // failed partway (e.g. addBranch rejected), so no fully-registered worktree
    // exists. First quiesce createWorktree's asynchronous materialization: its
    // copy/symlink/config work owns paths inside the worktree and must not race
    // teardown. Settlement failure is cleanup context; outfitError remains the
    // primary failure that caused rollback.
    let settlementFailure: unknown;
    try {
      await result.settle;
    } catch (settleError) {
      settlementFailure = initiatingSettlementFailure(settleError);
    }
    const rollbackFailures = await cleanupCreatedResources();
    if (rollbackFailures.length > 0) {
      throw new Error(
        `createWorktreeForCard: outfit failed and rollback was incomplete at ${result.path}: ` +
          `outfit=${outfitError instanceof Error ? outfitError.message : String(outfitError)}; ` +
          (settlementFailure === undefined
            ? ''
            : `settle=${settlementFailure instanceof Error ? settlementFailure.message : String(settlementFailure)}; `) +
          rollbackFailures.join('; '),
        { cause: outfitError }
      );
    }
    if (settlementFailure !== undefined) {
      throw new Error(
        `createWorktreeForCard: outfit and settlement failed, but rollback completed at ${result.path}: ` +
          `outfit=${outfitError instanceof Error ? outfitError.message : String(outfitError)}; ` +
          `settle=${settlementFailure instanceof Error ? settlementFailure.message : String(settlementFailure)}`,
        { cause: outfitError }
      );
    }
    throw outfitError;
  }
}

export interface ReleaseWorktreeForCardOptions {
  /** Card identifier whose branch record will be unregistered. */
  cardId: string;
  /** Session ID forwarded to removeBranch for commit attribution. */
  sessionId?: string;
}

/**
 * Releases a worktree's card binding WITHOUT removing the worktree from disk.
 *
 * The inverse of {@link outfitWorktreeForCard}: it unregisters the branch
 * record, restores the worktree's original `core.hooksPath`, and clears the
 * `.cards/CARD_ID` marker. It is a standalone step — it never calls
 * {@link removeWorktree} — so it is usable on externally-located worktrees a
 * caller wants to un-bind but keep on disk.
 *
 * Steps:
 * 1. Derive the branch name via `git rev-parse --abbrev-ref HEAD`. On detached
 *    HEAD (`"HEAD"`) or a git error, log a warning and skip the branch
 *    unregister — there is no branch record we can confidently remove.
 * 2. `client.removeBranch(...)`, wrapped in {@link BranchUnregisterError} on
 *    failure so callers can apply the fail-open stance to the unregister phase.
 * 3. Restore `core.hooksPath` from `.cards/CARD_ORIGINAL_HOOK_PATH`. If the
 *    snapshot is missing (hand-made worktree, partial outfit), skip with a
 *    warning rather than fail.
 * 4. Clear `.cards/CARD_ID`.
 *
 * @param client - CardsClient used to unregister the branch record.
 * @param worktreeDir - Absolute path to the worktree directory (must still exist).
 * @param options - Card id and optional session id forwarded to removeBranch.
 * @throws BranchUnregisterError when removeBranch failed.
 */
export async function releaseWorktreeForCard(
  client: CardsClient,
  worktreeDir: string,
  options: ReleaseWorktreeForCardOptions
): Promise<void> {
  const { cardId, sessionId } = options;

  // Step 1 — Derive the branch name. Skip-with-warning on detached HEAD or a
  // git error, matching the existing worktree-remove stance.
  let branchName: string | undefined;
  try {
    branchName = await resolveWorktreeBranchName(worktreeDir);
    if (branchName === 'HEAD' || branchName.length === 0) {
      stderrLogger.warn(
        'releaseWorktreeForCard: worktree HEAD is detached; branch record could not be resolved, skipping branch unregister',
        { cardId, worktreeDir }
      );
      branchName = undefined;
    }
  } catch (gitError) {
    stderrLogger.warn('releaseWorktreeForCard: failed to resolve worktree branch name; skipping branch unregister', {
      cardId,
      worktreeDir,
      error: gitError instanceof Error ? gitError.message : String(gitError)
    });
    branchName = undefined;
  }

  // Step 2 — Unregister the branch record. Wrap in a distinct typed error so
  // callers branch on the unregister phase explicitly.
  if (branchName !== undefined) {
    try {
      await client.removeBranch(cardId, branchName, { sessionId });
    } catch (error) {
      throw new BranchUnregisterError(error);
    }
  }

  // Step 3 — Restore the worktree's original core.hooksPath from the snapshot.
  // Skip-with-warning if the snapshot is missing (hand-made worktree or a
  // partial outfit never wrote it).
  const originalHookPathFile = join(worktreeDir, '.cards', 'CARD_ORIGINAL_HOOK_PATH');
  let originalHooksDir: string | undefined;
  try {
    originalHooksDir = (await readFile(originalHookPathFile, 'utf-8')).trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (originalHooksDir && originalHooksDir.length > 0) {
    // Retried on config-lock contention: a release can race other config
    // writers (sibling binds, settle phases) on the same repository.
    await gitConfigWithRetry(['-C', worktreeDir, 'config', '--worktree', 'core.hooksPath', originalHooksDir]);
  } else {
    stderrLogger.warn(
      'releaseWorktreeForCard: no CARD_ORIGINAL_HOOK_PATH snapshot found; leaving core.hooksPath unchanged',
      { cardId, worktreeDir }
    );
  }

  // Step 4 — Clear the CARD_ID marker.
  await clearCardBoundFile(worktreeDir);
}

export interface RemoveWorktreeForCardOptions {
  /** Card identifier whose branch record will be unregistered. */
  cardId: string;
  /**
   * Exact branch name to remove from the card's branch record. Retained for
   * caller compatibility; the branch is now derived inside
   * {@link releaseWorktreeForCard} from the worktree's HEAD.
   */
  branchName?: string;
  /** Session ID forwarded to removeBranch for commit attribution. */
  sessionId?: string;
}

/**
 * Removes a card-bound worktree and unregisters its branch from the Cards API.
 *
 * Composes {@link releaseWorktreeForCard} with the pure {@link removeWorktree}
 * git primitive. Release runs FIRST — it reads the worktree's HEAD and the
 * `CARD_ORIGINAL_HOOK_PATH` snapshot, both of which require the worktree to
 * still exist on disk — then the worktree is torn down.
 *
 * Teardown still runs even when release throws: a release failure (e.g. a
 * {@link BranchUnregisterError} from a failed removeBranch) leaves only a
 * recoverable orphaned record, so the disk teardown proceeds regardless and the
 * release error is rethrown afterward. A {@link removeWorktree} failure (the
 * teardown phase) propagates untouched so callers can apply their teardown
 * stance to it.
 *
 * @param client - CardsClient used to unregister the branch record.
 * @param worktreePath - Absolute path to the worktree directory.
 * @param options - Card-binding options.
 * @throws BranchUnregisterError when release failed but disk teardown succeeded.
 */
export async function removeWorktreeForCard(
  client: CardsClient,
  worktreePath: string,
  options: RemoveWorktreeForCardOptions
): Promise<void> {
  const { cardId, sessionId } = options;

  // Release first (needs the worktree on disk), capturing any failure so disk
  // teardown still runs. removeWorktree always executes; the release failure is
  // rethrown only after teardown completes.
  let releaseError: unknown;
  try {
    await releaseWorktreeForCard(client, worktreePath, { cardId, sessionId });
  } catch (error) {
    releaseError = error;
  }

  // Teardown phase: any failure here propagates untouched — it is the
  // worktree-removal failure the callers' teardown stance handles.
  await removeWorktree(worktreePath);

  if (releaseError !== undefined) {
    throw releaseError;
  }
}

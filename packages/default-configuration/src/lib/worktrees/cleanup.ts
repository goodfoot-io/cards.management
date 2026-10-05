/**
 * `cleanupCardSlots`: removes a card's merged, clean, unused slots and reports
 * a decision for every slot. A lock-free pre-check decides which slots are
 * candidates; only those, and slots with residue to recover, are taken under
 * a `removal` lock, where every check is repeated. A pass never rejects.
 *
 * @summary Slot cleanup pass for in-handler passes and worktree maintenance
 * @module
 */

import type { ActionContext, WorktreeCleanupDecision, WorktreeCleanupReason } from '@cards.management/sdk';
import { resolveMainRepoRoot, resolveSlotRoot } from '@cards.management/sdk/cards-config';
import {
  createSlotJudgeContext,
  readSlotLock,
  readSlotLockSnapshot,
  type SlotJudgeContext,
  type SlotLock,
  type SlotLockPrevious,
  type SlotLockState,
  slotLockPids,
  withSlotLock
} from '@cards.management/sdk/slot-lock';
import type { SlotClient } from './acquire.js';
import { judgeUsability, pathExists, refOid, samePath } from './checkout.js';
import { type DiscoveredSlot, discoverSlots, type SlotInventory, type SlotPlace } from './discovery.js';
import type { CreationContext } from './intent.js';
import { defaultSlotLayer, type SlotLayer } from './layer.js';
import { recoverSlot } from './recovery.js';
import { unregisterSlot } from './registration.js';
import type { SlotOccupant } from './seams.js';

/** What a pass does: report only, remove, or remove and require that nothing remains. */
export type SlotCleanupMode = 'preview' | 'cleanup' | 'prepare-delete';

/** Budget of an in-handler start or end pass, and of `preview`. */
export const SLOT_CLEANUP_PASS_BUDGET_MS = 60_000;

/** Budget of a maintenance `cleanup` or `prepare-delete`, inside the root command's 300 s deadline. */
export const SLOT_CLEANUP_MAINTENANCE_BUDGET_MS = 270_000;

/** Budget of a pass's batched identity read, and of its one retry; cleanup is off the launch path. */
const CLEANUP_JUDGE_TIMEOUT_MS = 15_000;

/**
 * The reported reason for a slot an interrupted creation left in an uncertain state.
 * TODO(S2): `creation_residue` joins `WorktreeCleanupReason` with the S2 merge; report it directly then.
 */
const CREATION_RESIDUE_REASON: WorktreeCleanupReason = 'unusable_checkout';

/** Where and for whom a pass runs. */
export interface SlotCleanupContext {
  readonly client: SlotClient;
  readonly logger: ActionContext['logger'];
  readonly cardId: string;
  /** Execution running the pass; it owns the pass's `removal` locks. */
  readonly executionId: string;
  /** Any checkout of the workspace repository; the main repository and slot root are resolved from it. */
  readonly workspacePath: string;
  /** Git, seams and lock environment; the host's by default. */
  readonly layer?: SlotLayer;
}

/** Options of one pass. */
export interface SlotCleanupOptions {
  /**
   * Execution whose own slot is spared, reported `requester_slot`; null for
   * maintenance. `prepare-delete` treats it as absent.
   */
  readonly requester: string | null;
  readonly mode: SlotCleanupMode;
  /**
   * Time after which slots not yet started are reported `budget_exhausted`
   * and not locked. Defaults to {@link SLOT_CLEANUP_PASS_BUDGET_MS} for
   * `preview` and in-handler passes (a non-null requester), and to
   * {@link SLOT_CLEANUP_MAINTENANCE_BUDGET_MS} otherwise.
   */
  readonly budgetMs?: number;
}

/** Where a pass failed outside any one slot. */
export type SlotCleanupStage = 'discovery' | 'self_probe';

/** A pass's outcome. */
export interface SlotCleanupResult {
  /** One decision per discovered slot, in ordinal order. */
  readonly decisions: readonly WorktreeCleanupDecision[];
  /** Set when the pass stopped outside any slot; `decisions` holds those made before. */
  readonly failure?: { readonly stage: SlotCleanupStage; readonly message: string };
  /** Slots whose lock could not be judged, and how many of those record an unverified owner. */
  readonly unknownLocks: { readonly count: number; readonly unverifiedOwners: number };
  /**
   * Whether the pass met its mode's bar: for `prepare-delete`, no slot is
   * preserved, `budget_exhausted` or `cleanup_failed` and no `failure` is
   * set; for the other modes, no `failure` is set.
   */
  readonly ok: boolean;
}

/** A check's verdict on one slot. */
type Verdict =
  | { readonly reason: 'eligible'; readonly oid: string; readonly detail: string }
  | { readonly reason: 'missing'; readonly detail: string }
  | { readonly reason: Exclude<WorktreeCleanupReason, 'eligible' | 'missing'>; readonly detail: string };

/**
 * Formats an error for a decision or log.
 * @param error - Anything thrown.
 * @returns Its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Describes a lock this pass will not take.
 * @param state - A held lock's judgement.
 * @returns The holder's execution, PID, host and purpose, and any surviving processes.
 */
function describeHolder(state: Extract<SlotLockState, { state: 'held' }>): string {
  const { owner } = state.snapshot;
  const parts = [
    `held by execution ${owner.executionId} (pid ${owner.holder.pid} on ${owner.hostname}, ${owner.purpose})`
  ];
  if (state.handoffPending) parts.push('handoff pending');
  const { survivors } = state;
  if (!survivors.holderAlive) {
    const alive = [
      ...(survivors.groupAlive === true && owner.holder.processGroupId !== null
        ? [`process group ${owner.holder.processGroupId}`]
        : []),
      ...survivors.companions.map((pid) => `pid ${pid}`)
    ];
    if (alive.length > 0) parts.push(`its handler is gone but ${alive.join(', ')} still run`);
  }
  return parts.join('; ');
}

/**
 * Attributes occupants to the previous holder of the slot.
 * @param occupants - Processes found inside the checkout.
 * @param previous - The generation judged before this lock.
 * @returns A description naming which occupants are left over from that execution.
 */
function describeOccupants(occupants: readonly SlotOccupant[], previous: SlotLockPrevious): string {
  const recorded = new Set<number>([
    ...(previous.owner === null ? [] : [previous.owner.holder.pid]),
    ...previous.companions.map((companion) => companion.pid)
  ]);
  return occupants
    .map((occupant) =>
      recorded.has(occupant.pid) && previous.owner !== null
        ? `pid ${occupant.pid} (${occupant.command}) is left over from execution ${previous.owner.executionId}`
        : `pid ${occupant.pid} (${occupant.command}) is unrelated to the slot's last holder`
    )
    .join('; ');
}

/**
 * Runs one cleanup pass over a card's slots.
 * @param context - Client, logger, card and workspace.
 * @param options - Requester, mode and budget.
 * @returns Every slot's decision, any pass-level failure, and whether the mode's bar was met. Never rejects.
 */
export async function cleanupCardSlots(
  context: SlotCleanupContext,
  options: SlotCleanupOptions
): Promise<SlotCleanupResult> {
  const { mode } = options;
  const requester = mode === 'prepare-delete' ? null : options.requester;
  const budgetMs =
    options.budgetMs ??
    (mode === 'preview' || options.requester !== null
      ? SLOT_CLEANUP_PASS_BUDGET_MS
      : SLOT_CLEANUP_MAINTENANCE_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const { client, logger, cardId } = context;
  const decisions: WorktreeCleanupDecision[] = [];
  const unknownLocks = { count: 0, unverifiedOwners: 0 };

  const conclude = (failure?: SlotCleanupResult['failure']): SlotCleanupResult => {
    const ok =
      failure === undefined &&
      (mode !== 'prepare-delete' ||
        decisions.every((decision) => decision.outcome === 'removed' || decision.outcome === 'eligible'));
    logger.info('Slot cleanup pass finished', {
      cardId,
      mode,
      requester,
      ok,
      decisions: decisions.length,
      unknownLocks,
      ...(failure === undefined ? {} : { failure })
    });
    return { decisions, unknownLocks, ok, ...(failure === undefined ? {} : { failure }) };
  };
  const record = (
    slot: Pick<DiscoveredSlot, 'branch' | 'path'>,
    reason: WorktreeCleanupReason,
    detail: string,
    outcome: WorktreeCleanupDecision['outcome']
  ): void => {
    const decision: WorktreeCleanupDecision = { branch: slot.branch, worktreePath: slot.path, reason, detail, outcome };
    logger.info('Slot cleanup decision', { cardId, mode, ...decision });
    decisions.push(decision);
  };

  let layer: SlotLayer;
  let place: SlotPlace;
  let inventory: SlotInventory;
  try {
    layer = context.layer ?? defaultSlotLayer();
    place = {
      cardId,
      repoRoot: await resolveMainRepoRoot(context.workspacePath),
      slotRoot: await resolveSlotRoot(context.workspacePath, cardId)
    };
    inventory = await discoverSlots(layer.git, client, place);
  } catch (error) {
    return conclude({ stage: 'discovery', message: describe(error) });
  }
  const { git } = layer;
  const { repoRoot, slotRoot } = place;
  const removal = layer.seams.removal;
  const environment = layer.lockEnvironment === undefined ? {} : { environment: layer.lockEnvironment };
  const creation: CreationContext = {
    git,
    client,
    place,
    log: (message, fields) => logger.info(message, { cardId, ...fields })
  };

  let judge: SlotJudgeContext;
  try {
    const pids: number[] = [];
    for (const slot of inventory.slots) {
      const snapshot = await readSlotLockSnapshot(slotRoot, slot.ordinal);
      if (snapshot !== null && !('unreadable' in snapshot)) pids.push(...slotLockPids(snapshot));
    }
    judge = await createSlotJudgeContext(pids, {
      timeoutMs: CLEANUP_JUDGE_TIMEOUT_MS,
      retryTimeoutMs: CLEANUP_JUDGE_TIMEOUT_MS,
      ...(layer.lockEnvironment?.identity === undefined ? {} : { identity: layer.lockEnvironment.identity })
    });
  } catch (error) {
    return conclude({ stage: 'self_probe', message: describe(error) });
  }
  if (!judge.verified)
    logger.warn('This pass could not read its own process identity; its removal locks record an unverified owner', {
      cardId,
      reason: judge.unverifiedReason
    });

  let cardParent: Promise<string | null> | undefined;
  const parentOf = (slot: DiscoveredSlot): Promise<string | null> => {
    if (slot.registration !== null) return Promise.resolve(slot.registration.parentBranch);
    cardParent ??= client
      .getCard(cardId)
      .then(({ parentBranch }) => (typeof parentBranch === 'string' && parentBranch !== '' ? parentBranch : null));
    return cardParent;
  };

  /**
   * Runs the content, registration and checkout checks on one slot.
   * @param slot - The slot as just discovered.
   * @param current - The inventory it came from.
   * @returns The first failing check, `missing`, or `eligible` with the ref oid to delete.
   */
  const inspect = async (slot: DiscoveredSlot, current: SlotInventory): Promise<Verdict> => {
    if (slot.registration === null) {
      if (slot.invalidEntry !== null)
        return { reason: 'invalid_entry', detail: `the slot's branch file is invalid: ${slot.invalidEntry}` };
      if (current.registrationsUncertain)
        return {
          reason: 'invalid_entry',
          detail:
            current.registrationError === null
              ? 'an invalid branch file could not be attributed, so this unregistered slot is kept'
              : `registrations could not be read (${current.registrationError}), so this unregistered slot is kept`
        };
      if (slot.residue.length > 0)
        return { reason: 'invalid_entry', detail: 'an unregistered slot with quarantine residue needs repair first' };
    } else {
      const owner = slot.registration.legacyExecutionOwner;
      if (owner !== undefined) {
        const status = await client.getExecutionStatus(owner);
        if (status === 'running')
          return { reason: 'locked', detail: `registered as owned by running execution ${owner} (legacy owner)` };
      }
    }
    if (slot.directoryExists) {
      const usability = await judgeUsability(git, repoRoot, slot.path, slot.branch, current.entries);
      if (usability.status === 'head_off_branch' || usability.status === 'unusable_checkout')
        return { reason: usability.status, detail: usability.detail };
    }
    if (slot.oid === null && !slot.directoryExists)
      return { reason: 'missing', detail: 'neither the slot ref nor its checkout exists' };
    for (const path of slot.checkedOutAt) {
      if (!(await samePath(path, slot.path)))
        return { reason: 'checked_out_elsewhere', detail: `${slot.branch} is checked out at ${path}` };
    }
    const parent = await parentOf(slot);
    if (parent === null || (await refOid(git, repoRoot, parent)) === null)
      return { reason: 'parent_branch_missing', detail: `parent branch ${parent ?? '(none)'} does not exist` };
    if (slot.oid === null)
      return { reason: 'unmerged_commits', detail: 'the checkout exists but the slot ref is missing' };
    const merged = await git.run(repoRoot, ['merge-base', '--is-ancestor', slot.oid, `refs/heads/${parent}`]);
    if (merged.exitCode === 1)
      return { reason: 'unmerged_commits', detail: `${slot.branch} has commits not in ${parent}` };
    if (merged.exitCode !== 0 || merged.timedOut || merged.aborted)
      throw new Error(`git merge-base --is-ancestor failed: ${merged.stderr.trim()}`);
    if (slot.directoryExists) {
      if ((await git.text(slot.path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '')
        return { reason: 'uncommitted_changes', detail: `${slot.path} has uncommitted or untracked changes` };
      const staged = await git.text(slot.path, ['ls-files', '--stage']);
      if (staged.split('\n').some((line) => line.startsWith('160000 ')))
        return { reason: 'submodules', detail: `${slot.path} contains submodules` };
    }
    return {
      reason: 'eligible',
      oid: slot.oid,
      detail:
        slot.registration === null
          ? 'unregistered slot ref or checkout is clean and merged into the card parent'
          : `clean and merged into ${parent}`
    };
  };

  /**
   * Removes one slot under its `removal` lock: recovery, the checks again,
   * the occupant probe, verified removal, the ref and the registration.
   * @param lock - The slot's `removal` lock.
   * @param previous - The generation judged before this lock.
   * @param ordinal - The slot.
   * @returns The slot's decision.
   */
  const removeUnderLock = async (
    lock: SlotLock,
    previous: SlotLockPrevious,
    ordinal: number
  ): Promise<Pick<WorktreeCleanupDecision, 'reason' | 'detail' | 'outcome'>> => {
    const checkpoint = (): void => lock.checkpoint();
    const before = (await discoverSlots(git, client, place)).slots.find((slot) => slot.ordinal === ordinal);
    const recovery = await recoverSlot(
      lock,
      previous,
      before?.path ?? `${slotRoot}/${ordinal}`,
      (before?.residue.length ?? 0) > 0,
      {
        creation,
        removal
      }
    );
    if (recovery.unsettled !== null)
      return {
        reason:
          recovery.unsettled.reason === 'creation_residue'
            ? CREATION_RESIDUE_REASON
            : recovery.unsettled.reason === 'removal_restored'
              ? 'removal_restored'
              : 'quarantine_stranded',
        detail: recovery.unsettled.detail,
        outcome: 'preserved'
      };
    lock.checkpoint();
    const current = await discoverSlots(git, client, place);
    const slot = current.slots.find((candidate) => candidate.ordinal === ordinal);
    if (slot === undefined)
      return { reason: 'missing', detail: 'recovery left nothing of the slot', outcome: 'removed' };
    const verdict = await inspect(slot, current);
    if (verdict.reason !== 'eligible' && verdict.reason !== 'missing')
      return { reason: verdict.reason, detail: verdict.detail, outcome: 'preserved' };
    let detail = verdict.detail;
    if (slot.directoryExists) {
      await removal.stopSlotFsmonitor(slot.path, { checkpoint });
      let probe: Awaited<ReturnType<typeof removal.findSlotOccupants>>;
      try {
        probe = await removal.findSlotOccupants(slot.path, { checkpoint });
      } catch (error) {
        return { reason: 'in_use', detail: `the occupant probe failed: ${describe(error)}`, outcome: 'preserved' };
      }
      if (probe.occupants.length > 0)
        return { reason: 'in_use', detail: describeOccupants(probe.occupants, previous), outcome: 'preserved' };
      if (probe.unprobed > 0) detail = `${detail}; ${probe.unprobed} processes could not be probed`;
      lock.checkpoint();
      const quarantine = await removal.quarantineSlot(repoRoot, slot.path, { checkpoint });
      const removed = await removal.removeQuarantinedSlot(
        { repoRoot, slotPath: slot.path, quarantine, lock },
        { checkpoint }
      );
      if (removed.status === 'refused') return { reason: removed.reason, detail: removed.detail, outcome: 'preserved' };
    } else if (slot.entry !== null) {
      lock.checkpoint();
      const pruned = await git.run(repoRoot, ['worktree', 'remove', '-f', '-f', slot.path], {
        record: (event) => lock.recordGit(event)
      });
      if (pruned.exitCode !== 0 && !/is not a working tree/.test(pruned.stderr))
        throw new Error(`git worktree remove -f -f ${slot.path} failed: ${pruned.stderr.trim()}`);
    }
    if (verdict.reason === 'eligible') {
      lock.checkpoint();
      const deleted = await git.run(repoRoot, ['update-ref', '-d', `refs/heads/${slot.branch}`, verdict.oid], {
        record: (event) => lock.recordGit(event)
      });
      if (deleted.exitCode !== 0) {
        const now = await refOid(git, repoRoot, slot.branch);
        if (now !== null && now !== verdict.oid)
          return {
            reason: 'unmerged_commits',
            detail: `${slot.branch} moved to ${now} during removal; the ref is kept`,
            outcome: 'preserved'
          };
        if (now !== null)
          throw new Error(`git update-ref -d refs/heads/${slot.branch} failed: ${deleted.stderr.trim()}`);
      }
    }
    if (await pathExists(slot.path))
      return {
        reason: 'removal_blocked',
        detail: `${slot.path} was recreated during removal; its registration is kept`,
        outcome: 'preserved'
      };
    if (slot.registration !== null) {
      lock.checkpoint();
      await unregisterSlot(client, cardId, slot.branch);
    }
    return { reason: verdict.reason, detail, outcome: 'removed' };
  };

  for (const slot of inventory.slots) {
    if (Date.now() >= deadline) {
      record(slot, 'budget_exhausted', `the ${budgetMs} ms budget ran out before this slot was started`, 'preserved');
      continue;
    }
    try {
      // 2. Lock-free pre-check [F6].
      const state = await readSlotLock(slotRoot, slot.ordinal, { context: judge, ...environment });
      if (state.state === 'held') {
        if (requester !== null && state.snapshot.owner.executionId === requester)
          record(slot, 'requester_slot', 'the slot of the execution running this pass', 'preserved');
        else record(slot, 'locked', describeHolder(state), 'preserved');
        continue;
      }
      if (state.state === 'unknown') {
        unknownLocks.count++;
        if (state.detail.unverifiedOwner) unknownLocks.unverifiedOwners++;
        record(slot, 'lock_unknown', state.detail.reason, 'preserved');
        continue;
      }
      // A slot with residue goes straight to its lock: a partial checkout can fail the lock-free checks.
      const residue = slot.residue.length > 0 || (state.snapshot?.creating ?? null) !== null;
      if (mode === 'preview' || !residue) {
        const verdict = await inspect(slot, inventory);
        if (mode === 'preview') {
          record(slot, verdict.reason, verdict.detail, verdict.reason === 'eligible' ? 'eligible' : 'preserved');
          continue;
        }
        if (verdict.reason !== 'eligible' && verdict.reason !== 'missing') {
          record(slot, verdict.reason, verdict.detail, 'preserved');
          continue;
        }
      }
      // 3. Lock only candidates and slots with residue.
      const done = await withSlotLock(
        slotRoot,
        slot.ordinal,
        'removal',
        { executionId: context.executionId, cardId, context: judge, ...environment },
        (lock, previous) => removeUnderLock(lock, previous, slot.ordinal)
      );
      switch (done.status) {
        case 'done':
          record(slot, done.value.reason, done.value.detail, done.value.outcome);
          break;
        case 'held':
          record(
            slot,
            'locked',
            `taken first by execution ${done.holder.executionId} (pid ${done.holder.holder.pid} on ${done.holder.hostname})`,
            'preserved'
          );
          break;
        case 'taken':
          record(slot, 'locked', done.detail, 'preserved');
          break;
        case 'unknown':
          unknownLocks.count++;
          if (done.detail.unverifiedOwner) unknownLocks.unverifiedOwners++;
          record(slot, 'lock_unknown', done.detail.reason, 'preserved');
          break;
        case 'unavailable':
          record(slot, 'lock_unavailable', done.detail, 'preserved');
          break;
      }
    } catch (error) {
      record(slot, 'cleanup_failed', describe(error), 'failed');
    }
  }
  return conclude();
}

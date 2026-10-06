/**
 * `cleanupCardSlots`: removes a card's merged, clean, unused slots and reports
 * a decision for every slot. A lock-free pre-check decides which slots are
 * candidates; only those, and slots with residue to recover, are taken under
 * a `removal` lock, where every check is repeated. A pass never rejects.
 *
 * @summary Slot cleanup pass for in-handler passes and worktree maintenance
 * @module
 */

import type {
  ActionContext,
  WorktreeCleanupDecision,
  WorktreeCleanupReason,
  WorktreeMaintenanceStageFailure,
  WorktreeUnknownLocks
} from '@cards.management/sdk';
import { resolveMainRepoRoot, resolveSlotRoot } from '@cards.management/sdk/cards-config';
import { clearsCardDeletion } from '@cards.management/sdk/protocol';
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
import { describeSlotOccupancy, type SlotOccupantProbe, slotOccupied } from '@cards.management/sdk/worktree-removal';
import type { SlotClient } from './acquire.js';
import { judgeUsability, pathExists, refOid, samePath } from './checkout.js';
import { type DiscoveredSlot, discoverSlots, type SlotInventory, type SlotPlace } from './discovery.js';
import type { CreationContext } from './intent.js';
import { defaultSlotLayer, type SlotLayer } from './layer.js';
import { recoverSlot } from './recovery.js';
import { unregisterSlot } from './registration.js';

/** What a pass does: report only, remove, or remove and require that nothing remains. */
export type SlotCleanupMode = 'preview' | 'cleanup' | 'prepare-delete';

/** Budget of an in-handler start or end pass, and of `preview`. */
export const SLOT_CLEANUP_PASS_BUDGET_MS = 60_000;

/** Budget of a maintenance `cleanup` or `prepare-delete`, inside the root command's 300 s deadline. */
export const SLOT_CLEANUP_MAINTENANCE_BUDGET_MS = 270_000;

/** Budget of a pass's batched identity read, and of its one retry; cleanup is off the launch path. */
const CLEANUP_JUDGE_TIMEOUT_MS = 15_000;

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

/** A pass's outcome. */
export interface SlotCleanupResult {
  /** One decision per discovered slot, in ordinal order. */
  readonly decisions: readonly WorktreeCleanupDecision[];
  /** Set when the pass stopped outside any slot; `decisions` holds those made before. */
  readonly failure?: WorktreeMaintenanceStageFailure;
  /** Slots whose lock could not be judged, and how many of those record an unverified owner. */
  readonly unknownLocks: WorktreeUnknownLocks;
  /**
   * The most processes owned by other users that one occupant probe could
   * not inspect. They never block removal, so the count belongs to the pass,
   * never to a slot's detail.
   */
  readonly otherUsersNotInspected: number;
  /**
   * Whether the pass met its mode's bar: for `prepare-delete`, the SDK's
   * `clearsCardDeletion` (no stage failed, no lock unknown, every slot
   * removed or eligible); for the other modes, no `failure` is set.
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
 * Describes why a probe found the slot occupied, attributing visible
 * occupants to the previous holder of the slot.
 * @param probe - A probe for which `slotOccupied` holds.
 * @param previous - The generation judged before this lock, or the last one read by a preview; null when none.
 * @returns Which occupants are left over from that execution, and which of the user's own processes could not be inspected.
 */
function describeOccupants(
  probe: SlotOccupantProbe,
  previous: Pick<SlotLockPrevious, 'owner' | 'companions'> | null
): string {
  const owner = previous?.owner ?? null;
  const recorded = new Set<number>([
    ...(owner === null ? [] : [owner.holder.pid]),
    ...(previous?.companions ?? []).map((companion) => companion.pid)
  ]);
  const visible = probe.occupants.map((occupant) =>
    recorded.has(occupant.pid) && owner !== null
      ? `pid ${occupant.pid} (${occupant.command}) is left over from execution ${owner.executionId}`
      : `pid ${occupant.pid} (${occupant.command}) is unrelated to the slot's last holder`
  );
  const hidden =
    probe.uninspectable.length > 0 ? [describeSlotOccupancy({ ...probe, occupants: [], otherUsers: 0 })] : [];
  return [...visible, ...hidden].join('; ');
}

/** Reasons that keep a slot until the user acts on it; no later pass clears them alone. */
type PermanentRefusal =
  | 'unmerged_commits'
  | 'uncommitted_changes'
  | 'head_off_branch'
  | 'parent_branch_missing'
  | 'invalid_entry'
  | 'checked_out_elsewhere'
  | 'in_use'
  | 'submodules';

/** How every next step ends: the pass that removes the cleared slot. */
const RUN_AGAIN = 'then run Clean Up Worktrees again';

/**
 * The next step for a permanent refusal, naming the slot's own path and branch.
 * Abandoning work never removes anything by hand: it resets the slot to its
 * parent inside the checkout, so the next pass proves it merged and clean and
 * removes it under its lock, as it removes any other slot.
 * @param reason - Why the slot is kept.
 * @param slot - The slot's branch and checkout path.
 * @param parent - The slot's parent branch; null when unknown.
 * @returns What the user does before a pass can remove the slot.
 */
function nextStep(
  reason: PermanentRefusal,
  slot: Pick<DiscoveredSlot, 'branch' | 'path'>,
  parent: string | null
): string {
  const target = parent ?? '<parent branch>';
  const discard = `copy anything wanted elsewhere, then run \`git -C ${slot.path} reset --hard ${target}\` and \`git -C ${slot.path} clean -ffd\``;
  const abandon = `abandon its work: ${discard}`;
  switch (reason) {
    case 'unmerged_commits':
      return `merge ${slot.branch} into ${target}, or ${abandon}; ${RUN_AGAIN}`;
    case 'uncommitted_changes':
      return `commit, stash or discard them, or ${abandon}; ${RUN_AGAIN}`;
    case 'head_off_branch':
      return `keep any commits made there, then run \`git -C ${slot.path} switch --discard-changes ${slot.branch}\`; to abandon the slot's work as well, ${discard}; ${RUN_AGAIN}`;
    case 'parent_branch_missing':
      return `recreate ${target} in the main repository, for example with \`git branch ${target} <commit>\`; ${RUN_AGAIN}`;
    case 'invalid_entry':
      return `fix or delete the slot's file under branches/ in the card repository and commit; ${RUN_AGAIN}`;
    case 'checked_out_elsewhere':
      return `switch that checkout to another branch or remove it; ${RUN_AGAIN}`;
    case 'in_use':
      return `stop the processes working in ${slot.path} or wait for them to exit; ${RUN_AGAIN}`;
    case 'submodules':
      return `cleanup cannot prove a checkout with submodules clean, so while ${target} has submodules no pass removes this slot; if they were added on ${slot.branch} only, ${abandon}; ${RUN_AGAIN}`;
  }
}

/**
 * A permanent refusal whose detail ends with the user's next step.
 * @param reason - Why the slot is kept.
 * @param slot - The slot's branch and checkout path.
 * @param detail - What the check found.
 * @param parent - The slot's parent branch, named by the step; null when unknown.
 * @param step - A next step for this instance; the reason's own by default.
 * @returns The verdict.
 */
function refusal<R extends PermanentRefusal>(
  reason: R,
  slot: Pick<DiscoveredSlot, 'branch' | 'path'>,
  detail: string,
  parent: string | null = null,
  step: string = nextStep(reason, slot, parent)
): { readonly reason: R; readonly detail: string } {
  return { reason, detail: `${detail}; ${step}` };
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
  let otherUsersNotInspected = 0;

  const conclude = (failure?: SlotCleanupResult['failure']): SlotCleanupResult => {
    const ok =
      mode === 'prepare-delete'
        ? clearsCardDeletion({ decisions, unknownLocks, ...(failure === undefined ? {} : { failure }) })
        : failure === undefined;
    logger.info('Slot cleanup pass finished', {
      cardId,
      mode,
      requester,
      ok,
      decisions: decisions.length,
      unknownLocks,
      otherUsersNotInspected,
      ...(failure === undefined ? {} : { failure })
    });
    return { decisions, unknownLocks, otherUsersNotInspected, ok, ...(failure === undefined ? {} : { failure }) };
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
        return refusal('invalid_entry', slot, `the slot's branch file is invalid: ${slot.invalidEntry}`);
      if (current.registrationsUncertain)
        return current.registrationError === null
          ? refusal(
              'invalid_entry',
              slot,
              'an invalid branch file could not be attributed, so this unregistered slot is kept'
            )
          : refusal(
              'invalid_entry',
              slot,
              `registrations could not be read (${current.registrationError}), so this unregistered slot is kept`,
              null,
              `${RUN_AGAIN} once the Cards server lists the card's branches`
            );
      if (slot.residue.length > 0)
        return refusal(
          'invalid_entry',
          slot,
          `an unregistered slot has quarantine residue at ${slot.residue.join(', ')}`,
          null,
          `compare it with ${slot.path}, keep what is wanted and remove the rest; ${RUN_AGAIN}`
        );
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
      if (usability.status === 'head_off_branch')
        // The parent only names the reset in the step, so a failure to read it does not hide the refusal.
        return refusal('head_off_branch', slot, usability.detail, await parentOf(slot).catch(() => null));
      if (usability.status === 'unusable_checkout') return { reason: usability.status, detail: usability.detail };
    }
    if (slot.oid === null && !slot.directoryExists)
      return { reason: 'missing', detail: 'neither the slot ref nor its checkout exists' };
    for (const path of slot.checkedOutAt) {
      if (!(await samePath(path, slot.path)))
        return refusal('checked_out_elsewhere', slot, `${slot.branch} is checked out at ${path}`);
    }
    const parent = await parentOf(slot);
    if (parent === null || (await refOid(git, repoRoot, parent)) === null)
      return refusal('parent_branch_missing', slot, `parent branch ${parent ?? '(none)'} does not exist`, parent);
    if (slot.oid === null)
      return refusal('unmerged_commits', slot, 'the checkout exists but the slot ref is missing', parent);
    const merged = await git.run(repoRoot, ['merge-base', '--is-ancestor', slot.oid, `refs/heads/${parent}`]);
    if (merged.exitCode === 1)
      return refusal('unmerged_commits', slot, `${slot.branch} has commits not in ${parent}`, parent);
    if (merged.exitCode !== 0 || merged.timedOut || merged.aborted)
      throw new Error(`git merge-base --is-ancestor failed: ${merged.stderr.trim()}`);
    if (slot.directoryExists) {
      if ((await git.text(slot.path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '')
        return refusal('uncommitted_changes', slot, `${slot.path} has uncommitted or untracked changes`, parent);
      const staged = await git.text(slot.path, ['ls-files', '--stage']);
      if (staged.split('\n').some((line) => line.startsWith('160000 ')))
        return refusal('submodules', slot, `${slot.path} contains submodules`, parent);
    }
    const merged_ =
      slot.registration === null
        ? 'unregistered slot ref or checkout is clean and merged into the card parent'
        : `clean and merged into ${parent}`;
    return {
      reason: 'eligible',
      oid: slot.oid,
      // Removal deletes git-ignored content (.env files, nested repositories, build output) with the checkout.
      detail: slot.directoryExists ? `${merged_}; git-ignored files in ${slot.path} are deleted with it` : merged_
    };
  };

  /**
   * Stops the slot's fsmonitor daemon, then lists the processes inside its checkout.
   * @param slot - The slot, whose checkout exists.
   * @param previous - The slot's last holder, to attribute occupants to; null when none.
   * @param removalGit - Git for the fsmonitor stop, recording its children into the lock when there is one.
   * @param checkpoint - Throws when the pass must stop; a no-op outside a lock.
   * @returns An `in_use` refusal, or null when the slot is unoccupied. Other users' processes
   * the probe could not inspect never refuse; their count is kept for the pass.
   */
  const probeOccupants = async (
    slot: DiscoveredSlot,
    previous: Pick<SlotLockPrevious, 'owner' | 'companions'> | null,
    removalGit: Parameters<SlotLayer['seams']['removal']['stopSlotFsmonitor']>[1],
    checkpoint: () => void
  ): Promise<{ readonly reason: 'in_use'; readonly detail: string } | null> => {
    checkpoint();
    await removal.stopSlotFsmonitor(slot.path, removalGit);
    let probe: Awaited<ReturnType<typeof removal.findSlotOccupants>>;
    try {
      checkpoint();
      probe = await removal.findSlotOccupants(slot.path);
    } catch (error) {
      return refusal('in_use', slot, `the occupant probe failed: ${describe(error)}`);
    }
    otherUsersNotInspected = Math.max(otherUsersNotInspected, probe.otherUsers);
    return slotOccupied(probe) ? refusal('in_use', slot, describeOccupants(probe, previous)) : null;
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
    const before = (await discoverSlots(git, client, place)).slots.find((slot) => slot.ordinal === ordinal);
    const recovery = await recoverSlot(lock, previous, before?.path ?? `${slotRoot}/${ordinal}`, {
      creation,
      removal
    });
    if (recovery.unsettled !== null)
      return {
        // A holding area that could not be recovered has no reason of its own; its manifest is kept.
        reason: recovery.unsettled.reason === 'recovery_failed' ? 'cleanup_failed' : recovery.unsettled.reason,
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
    if (slot.directoryExists) {
      const removalGit = { git: git.removalRunner((event) => lock.recordGit(event)) };
      const probe = await probeOccupants(slot, previous, removalGit, () => lock.checkpoint());
      if (probe !== null) return { ...probe, outcome: 'preserved' };
      lock.checkpoint();
      const quarantine = await removal.quarantineSlot(repoRoot, slot.path, removalGit);
      const removed = await removal.removeQuarantinedSlot(
        { repoRoot, slotPath: slot.path, quarantine, lock },
        removalGit
      );
      if (removed.status === 'refused')
        // The quarantined checkout is probed again, so a process that entered after the probe above refuses too.
        return removed.reason === 'in_use'
          ? { ...refusal('in_use', slot, removed.detail), outcome: 'preserved' }
          : { reason: removed.reason, detail: removed.detail, outcome: 'preserved' };
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
            ...refusal(
              'unmerged_commits',
              slot,
              `${slot.branch} moved to ${now} during removal; the ref is kept`,
              await parentOf(slot).catch(() => null)
            ),
            outcome: 'preserved'
          };
        if (now !== null)
          throw new Error(`git update-ref -d refs/heads/${slot.branch} failed: ${deleted.stderr.trim()}`);
      }
    }
    if (await pathExists(slot.path)) {
      // A writer recreated the path. Keep ref and registration together, so that once the path is
      // cleared the next pass finds a merged ref without a checkout and removes the slot as usual.
      if (verdict.reason === 'eligible') {
        lock.checkpoint();
        const restored = await git.run(repoRoot, ['update-ref', `refs/heads/${slot.branch}`, verdict.oid, ''], {
          record: (event) => lock.recordGit(event)
        });
        if (restored.exitCode !== 0 && (await refOid(git, repoRoot, slot.branch)) === null)
          throw new Error(`git update-ref refs/heads/${slot.branch} failed: ${restored.stderr.trim()}`);
      }
      return {
        reason: 'removal_blocked',
        detail: `${slot.path} was recreated after the checkout was removed, so the slot's ref and registration are kept; keep anything wanted from ${slot.path} and remove it, ${RUN_AGAIN}`,
        outcome: 'preserved'
      };
    }
    if (slot.registration !== null) {
      lock.checkpoint();
      await unregisterSlot(client, cardId, slot.branch);
    }
    return { reason: verdict.reason, detail: verdict.detail, outcome: 'removed' };
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
          // The removal's occupant probe, without a lock, so a slot a cleanup would refuse as in_use is not
          // shown eligible. Stopping the fsmonitor daemon changes no content; git restarts it on demand.
          const probe =
            verdict.reason === 'eligible' && slot.directoryExists
              ? await probeOccupants(slot, state.snapshot, { git: git.removalRunner(() => {}) }, () => {})
              : null;
          const judged = probe ?? verdict;
          // A missing slot is only unregistered by a cleanup, so it does not keep the card.
          const removable = judged.reason === 'eligible' || judged.reason === 'missing';
          record(slot, judged.reason, judged.detail, removable ? 'eligible' : 'preserved');
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

/**
 * What every fresh holder of an ordinal settles before using or removing the
 * slot: an interrupted creation carried in `creating.json`, then the
 * quarantine residue an interrupted removal left beside the checkout.
 *
 * @summary Recovery of a slot's previous holder's creation and removal residue
 * @module
 */

import type { SlotLock, SlotLockPrevious } from '@cards.management/sdk/slot-lock';
import { type CreationContext, type CreationRecovery, recoverCreationIntent } from './intent.js';
import type { SlotRemoval, SlotResidueReport } from './seams.js';

/** Residue reports after which the slot is not in a state to use or remove. */
type UnsettledResidue = Extract<
  SlotResidueReport,
  { readonly kind: 'removal_restored' | 'quarantine_stranded' | 'recovery_failed' }
>;

/**
 * Tells whether a residue report leaves the slot unsettled.
 * @param report - One residue report.
 * @returns True for a restoration, a stranded quarantine or a failed recovery.
 */
const isUnsettled = (report: SlotResidueReport): report is UnsettledResidue =>
  report.kind === 'removal_restored' || report.kind === 'quarantine_stranded' || report.kind === 'recovery_failed';

/**
 * Says what a residue report left behind, for a cleanup decision or a launch error.
 * @param report - One residue report.
 * @returns The paths involved and, for a restoration, what changed.
 */
export function describeResidue(report: SlotResidueReport): string {
  switch (report.kind) {
    case 'removal_finished':
      return `the removal of ${report.quarantine} was finished`;
    case 'moved_back':
      return `${report.quarantine} was moved back to ${report.slotPath}`;
    case 'removal_restored': {
      const changes = [
        ...(report.changed.length === 0 ? [] : [`changed: ${report.changed.join(', ')}`]),
        ...(report.displaced.length === 0 ? [] : [`displaced: ${report.displaced.join(', ')}`])
      ];
      return `an interrupted removal was restored at ${report.quarantine} for ${report.slotPath}${changes.length === 0 ? '' : ` (${changes.join('; ')})`}`;
    }
    case 'quarantine_stranded':
      return `${report.quarantine} cannot return to ${report.slotPath}, which exists`;
    case 'pruned':
      return `git's record of the vanished ${report.quarantine} was dropped`;
    case 'recovery_failed':
      return `the holding area ${report.holding} could not be recovered: ${report.detail}`;
  }
}

/** What recovery settled. */
export interface SlotRecovery {
  /** The carried creation's outcome; null when none was carried. */
  readonly creation: CreationRecovery | null;
  /** Residue reports; empty when there was no residue. */
  readonly residue: readonly SlotResidueReport[];
  /** Why the slot must not be used or removed now; null when it is settled. */
  readonly unsettled: {
    readonly reason: 'creation_residue' | UnsettledResidue['kind'];
    readonly detail: string;
  } | null;
}

/**
 * Settles what the previous holder of a freshly acquired ordinal left.
 * @param lock - The ordinal's freshly acquired lock.
 * @param previous - The generation judged before GC.
 * @param slotPath - The slot checkout path.
 * @param hasResidue - Whether quarantine residue was found beside the slot.
 * @param context - Creation context and the removal seam.
 * @param context.creation - Git, client, place and log.
 * @param context.removal - The SDK verified-removal seam.
 * @returns The creation outcome, residue reports and whether the slot is settled.
 */
export async function recoverSlot(
  lock: SlotLock,
  previous: SlotLockPrevious,
  slotPath: string,
  hasResidue: boolean,
  context: { readonly creation: CreationContext; readonly removal: SlotRemoval }
): Promise<SlotRecovery> {
  const creation =
    previous.creating === null
      ? null
      : await recoverCreationIntent(lock, previous.creating, previous.owner?.executionId ?? null, context.creation);
  let residue: readonly SlotResidueReport[] = [];
  if (hasResidue) {
    lock.checkpoint();
    residue = await context.removal.recoverSlotResidueLocked(
      { repoRoot: context.creation.place.repoRoot, slotPath, lock },
      { git: context.creation.git.removalRunner((event) => lock.recordGit(event)) }
    );
  }
  const stuck = residue.find(isUnsettled);
  const unsettled =
    creation?.status === 'creation_residue'
      ? { reason: 'creation_residue' as const, detail: creation.detail }
      : stuck === undefined
        ? null
        : { reason: stuck.kind, detail: describeResidue(stuck) };
  return { creation, residue, unsettled };
}

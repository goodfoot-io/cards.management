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

/** Residue report kinds after which the slot is not in a state to use or remove. */
const UNSETTLED_RESIDUE: ReadonlySet<SlotResidueReport['kind']> = new Set([
  'removal_restored',
  'quarantine_stranded',
  'recovery_failed'
]);

/** What recovery settled. */
export interface SlotRecovery {
  /** The carried creation's outcome; null when none was carried. */
  readonly creation: CreationRecovery | null;
  /** Residue reports; empty when there was no residue. */
  readonly residue: readonly SlotResidueReport[];
  /** Why the slot must not be used or removed now; null when it is settled. */
  readonly unsettled: {
    readonly reason: 'creation_residue' | SlotResidueReport['kind'];
    readonly detail: string;
  } | null;
}

/**
 * Settles what the previous holder of a freshly acquired ordinal left.
 * @param lock - The ordinal's freshly acquired lock.
 * @param previous - The generation judged before GC.
 * @param slotPath - The slot checkout path.
 * @param hasResidue - Whether quarantine residue was found beside the slot.
 * @param context - Creation context and the S2 removal seam.
 * @param context.creation - Git, client, place and log.
 * @param context.removal - The S2 seam.
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
      { checkpoint: () => lock.checkpoint() }
    );
  }
  const stuck = residue.find((report) => UNSETTLED_RESIDUE.has(report.kind));
  const unsettled =
    creation?.status === 'creation_residue'
      ? { reason: 'creation_residue' as const, detail: creation.detail }
      : stuck === undefined
        ? null
        : { reason: stuck.kind, detail: stuck.detail };
  return { creation, residue, unsettled };
}

/**
 * What every fresh holder of an ordinal settles before using or removing the
 * slot: an interrupted creation carried in `creating.json`, then the
 * quarantine residue an interrupted removal left beside the checkout.
 *
 * @summary Recovery of a slot's previous holder's creation and removal residue
 * @module
 */

import { readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { SlotLock, SlotLockPrevious } from '@cards.management/sdk/slot-lock';
import { type CreationContext, type CreationRecovery, recoverCreationIntent } from './intent.js';
import type { SlotRemoval, SlotResidueReport } from './seams.js';

/** Residue reports after which the slot is not in a state to use or remove. */
type UnsettledResidue = Extract<SlotResidueReport, { readonly kind: 'quarantine_stranded' | 'recovery_failed' }>;

/**
 * Tells whether a residue report leaves the slot unsettled.
 * @param report - One residue report.
 * @returns True for a stranded quarantine or a failed recovery; set-aside submodules put back are settled.
 */
const isUnsettled = (report: SlotResidueReport): report is UnsettledResidue =>
  report.kind === 'quarantine_stranded' || report.kind === 'recovery_failed';

/**
 * Says what a residue report left behind, for a cleanup decision or a launch error.
 * @param report - One residue report.
 * @returns The paths involved and, for a failed recovery, why.
 */
export function describeResidue(report: SlotResidueReport): string {
  switch (report.kind) {
    case 'removal_finished':
      return `the set-aside submodules of ${report.quarantine} joined its removed copy`;
    case 'moved_back':
      return `${report.quarantine} was moved back to ${report.slotPath}`;
    case 'submodules_restored':
      return `submodules set aside at ${report.setAside} were put back into ${report.slotPath}`;
    case 'quarantine_stranded':
      return `${report.quarantine} cannot return to ${report.slotPath}, which exists`;
    case 'pruned':
      return `git's record of the vanished ${report.quarantine} was dropped`;
    case 'recovery_failed':
      return `the set-aside area ${report.holding} could not be put back: ${report.detail}`;
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
 * Whether quarantine residue (`<slot>.deleting-*`) lies beside the slot now.
 * @param slotPath - The slot checkout path.
 * @returns True when any residue name is present.
 */
async function hasResidue(slotPath: string): Promise<boolean> {
  const base = basename(slotPath);
  const names = await readdir(dirname(slotPath)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  return names.some((name) => name.startsWith(`${base}.deleting-`));
}

/**
 * Settles what the previous holder of a freshly acquired ordinal left.
 * Residue is read here, under the lock: what a scan saw before the lock may be
 * stale, because an interrupted removal can leave residue after it.
 * @param lock - The ordinal's freshly acquired lock.
 * @param previous - The generation judged before GC.
 * @param slotPath - The slot checkout path.
 * @param context - Creation context and the removal seam.
 * @param context.creation - Git, client, place and log.
 * @param context.removal - The SDK verified-removal seam.
 * @returns The creation outcome, residue reports and whether the slot is settled.
 */
export async function recoverSlot(
  lock: SlotLock,
  previous: SlotLockPrevious,
  slotPath: string,
  context: { readonly creation: CreationContext; readonly removal: SlotRemoval }
): Promise<SlotRecovery> {
  const creation =
    previous.creating === null
      ? null
      : await recoverCreationIntent(lock, previous.creating, previous.owner?.executionId ?? null, context.creation);
  let residue: readonly SlotResidueReport[] = [];
  if (await hasResidue(slotPath)) {
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

/**
 * The SDK operations the slot layer drives but does not own: checkout
 * provisioning (`@cards.management/sdk/slot-checkout`) and verified removal
 * with its residue recovery and occupant probe
 * (`@cards.management/sdk/worktree-removal`).
 *
 * Both are bound through {@link SlotSeams}, so tests can wrap them to stop a
 * holder at a chosen step.
 *
 * @summary Provisioning and verified-removal seams of the slot layer
 * @module
 */

import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk/cards-config';
import { provisionSlotCheckout } from '@cards.management/sdk/slot-checkout';
import {
  findSlotOccupants,
  findSlotResidue,
  purgeRemovedSlots,
  quarantineSlot,
  recoverSlotResidueLocked,
  removeQuarantinedSlot,
  stopSlotFsmonitor
} from '@cards.management/sdk/worktree-removal';

export type {
  ProvisionedSlotCheckout,
  ProvisionSlotCheckoutOptions
} from '@cards.management/sdk/slot-checkout';
export type {
  SlotOccupant,
  SlotRemovalOptions,
  SlotResidue,
  SlotResidueReport
} from '@cards.management/sdk/worktree-removal';

/** Materializes and binds a fresh slot checkout. */
export type ProvisionSlotCheckout = typeof provisionSlotCheckout;

/** Verified removal, residue recovery, the occupant probe and the purge of removed copies the slot layer drives. */
export interface SlotRemoval {
  readonly quarantineSlot: typeof quarantineSlot;
  readonly removeQuarantinedSlot: typeof removeQuarantinedSlot;
  readonly findSlotResidue: typeof findSlotResidue;
  readonly recoverSlotResidueLocked: typeof recoverSlotResidueLocked;
  readonly stopSlotFsmonitor: typeof stopSlotFsmonitor;
  readonly findSlotOccupants: typeof findSlotOccupants;
  readonly purgeRemovedSlots: typeof purgeRemovedSlots;
}

/** The SDK operations the slot layer is bound to. */
export interface SlotSeams {
  readonly provisionSlotCheckout: ProvisionSlotCheckout;
  readonly removal: SlotRemoval;
}

/**
 * Directory that holds the shared hook dispatcher every slot checkout points at.
 * @returns `<cards config>/workspace-hooks`.
 */
export function slotSharedHooksDir(): string {
  return join(resolveGlobalCardsConfigDir(), 'workspace-hooks');
}

/** Production bindings: the SDK's own operations. */
export const defaultSlotSeams: SlotSeams = {
  provisionSlotCheckout,
  removal: {
    quarantineSlot,
    removeQuarantinedSlot,
    findSlotResidue,
    recoverSlotResidueLocked,
    stopSlotFsmonitor,
    findSlotOccupants,
    purgeRemovedSlots
  }
};

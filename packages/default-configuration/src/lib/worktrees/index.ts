/**
 * Worktree slot lifecycle owned by default-configuration: acquisition,
 * creation-intent recovery, registration and the provider-facing session.
 *
 * @summary Worktree slot lifecycle for agent providers
 * @module
 */

export {
  type AcquiredSlot,
  type AcquireSlotOptions,
  acquireSlot,
  describeSkippedSlots,
  type SkippedSlot,
  type SlotAcquisitionOutcome,
  type SlotActionInput,
  type SlotClient,
  type SlotHandoffData
} from './acquire.js';
export {
  cleanupCardSlots,
  clearsCardDeletion,
  SLOT_CLEANUP_MAINTENANCE_BUDGET_MS,
  SLOT_CLEANUP_PASS_BUDGET_MS,
  type SlotCleanupContext,
  type SlotCleanupMode,
  type SlotCleanupOptions,
  type SlotCleanupResult,
  type SlotCleanupStage
} from './cleanup.js';
export { type CreationRecovery, recoverCreationIntent, rollbackCreation } from './intent.js';
export { defaultSlotLayer, type SlotLayer } from './layer.js';
export type {
  ProvisionSlotCheckout,
  ProvisionSlotCheckoutOptions,
  SlotRemoval,
  SlotSeams
} from './seams.js';
export {
  type OpenSlotSessionOptions,
  openSlotSession,
  type SlotSession,
  type SwitchToInteractiveData
} from './session.js';

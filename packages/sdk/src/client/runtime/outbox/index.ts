/**
 * Client outbox: durable recovery storage for obligations a producer has formed
 * but not yet had acknowledged.
 *
 * Card main-672 milestone 2 requires that a producer which exits before durable
 * acknowledgment does not lose its obligation. Records live outside every card
 * Git repository, in the protected Cards runtime directory beside the admission
 * journal, one atomic file per message so that concurrent short-lived hooks never
 * edit a shared JSON file.
 *
 * This is recovery storage. It is not a control transport, and it is not a
 * fallback for the runtime protocol — there is no delivery API here, and that is
 * deliberate.
 *
 * @summary Client outbox public surface
 * @module runtime/outbox
 */

export { type DrainDelivery, type DrainReport, drainOwnRecords } from './drain.js';
export { reconcileOutboxOnStartup } from './reconcile.js';
export {
  createFileClientOutbox,
  enqueueRecord,
  type FileClientOutboxOptions,
  refFor,
  resolveOutboxRoot,
  retireRecord,
  scanAllRecords,
  scanScope
} from './store.js';
export {
  type ClientOutbox,
  type EnqueueResult,
  type JournalAcknowledgment,
  OUTBOX_DELIVERY_CLASSES,
  OUTBOX_SCHEMA_VERSION,
  type OutboxCorruption,
  type OutboxDeliveryClass,
  type OutboxDrainScope,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxRecordRef,
  type OutboxScanResult,
  type OutcomeAcceptance,
  type OutcomeAcceptor,
  type ReconciliationFailure,
  type ReconciliationReport,
  type RetirementResult
} from './types.js';

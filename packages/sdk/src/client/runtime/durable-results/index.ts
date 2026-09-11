/**
 * Durable custody of terminal results whose producer has exited.
 *
 * Card main-672 milestone 2 requires that reconciliation never delete the last
 * copy of an obligation. For a `durable-result` record that means something must
 * take real custody before the producer's copy is retired, and this module is
 * that something.
 *
 * It is a store, not an authority. Nothing here decides whether a result is
 * legitimate — admission does that for the intents it owns — and nothing here
 * delivers anything. It only guarantees that a recovered envelope is on disk and
 * flushed before anyone is told it is safe to let go of theirs.
 *
 * @summary Durable-result custody store public surface
 * @module runtime/durable-results
 */

export {
  createDurableResultReader,
  type DurableResultInventory,
  type DurableResultReader,
  describeDurableResult,
  listDurableResults
} from './read.js';
export {
  createFileResultCustodian,
  type FileResultCustodianOptions,
  readResultCustody,
  resolveDurableResultRoot,
  takeResultCustody
} from './store.js';
export {
  DURABLE_RESULT_SCHEMA_VERSION,
  type DurableResultCustodyInput,
  type DurableResultCustodyOutcome,
  type DurableResultCustodyRecord,
  type DurableResultMessageType
} from './types.js';

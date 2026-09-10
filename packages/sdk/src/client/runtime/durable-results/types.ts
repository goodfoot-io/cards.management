/**
 * Contract types for the durable-result custody store.
 *
 * A custody record is what makes retiring an outbox record safe. The outbox holds
 * a producer's copy of an obligation; this holds the copy that survives after the
 * producer's is deleted. The two are deliberately separate stores rather than one
 * with a status field, because their lifetimes are opposites: an outbox record
 * exists only until the obligation is held elsewhere, and a custody record exists
 * from that moment onward.
 *
 * @summary Types describing durably held terminal results
 */

import type { RuntimeEnvelope } from '../../../protocol/index.js';

/** Schema version stamped into every custody record this build writes. */
export const DURABLE_RESULT_SCHEMA_VERSION = 1;

/**
 * One terminal result held durably on behalf of a producer that has exited.
 *
 * Carries the envelope whole rather than a summary of it. A summary would be a
 * second decoding of the protocol, and the point of custody is that whatever
 * eventually processes this result sees exactly what the producer sent.
 */
export interface DurableResultCustodyRecord {
  /** Version of this schema, so an older build's record is refused, not misread. */
  readonly schemaVersion: number;
  /** Stable message identity; the deduplication key and the file name's preimage. */
  readonly messageId: string;
  /** Execution this result belongs to. */
  readonly executionId: string;
  /** Original caller request ID the execution was admitted under. */
  readonly requestId: string;
  /** The result itself, as the protocol will decode it. */
  readonly envelope: RuntimeEnvelope;
  /** When custody was taken, ISO 8601. */
  readonly custodiedAt: string;
}

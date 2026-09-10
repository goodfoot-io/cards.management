/**
 * The drain a running producer performs over its own records.
 *
 * A live wrapper is the best party to settle its own obligations: it still has
 * the connection, the identity, and the context that produced them. This module
 * is the loop that lets it do so, and its whole job is to enforce that the
 * producer only ever touches what it produced.
 *
 * The scoping is not a convenience filter. Two roles on one execution — a wrapper
 * and an agent hook, say — hold independent obligations, and each holds its own
 * acknowledgment. A wrapper that retired a hook's record would delete the last
 * copy of an obligation for which it never saw an acknowledgment, which is the
 * exact failure the durable-copy handoff exists to prevent.
 *
 * @summary Role-scoped drain of a producer's own outbox records
 * @module runtime/outbox/drain
 */

import type {
  ClientOutbox,
  JournalAcknowledgment,
  OutboxCorruption,
  OutboxDrainScope,
  OutboxRecordRef
} from './types.js';

/**
 * Settles one record by handing it to whatever holds the live connection.
 *
 * Returning an acknowledgment means the authoritative journal has durably taken
 * the obligation; returning null means it has not, and the record must stay.
 */
export interface DrainDelivery {
  /**
   * Offers one record for durable acceptance.
   *
   * @param ref - Identity of the record being settled.
   * @returns An acknowledgment when the journal durably accepted it, or null when
   *   it did not — a lost acknowledgment must keep the copy, never assume it.
   */
  settle(ref: OutboxRecordRef): Promise<JournalAcknowledgment | null>;
}

/** What one drain pass accomplished. */
export interface DrainReport {
  /** Records read for this scope. */
  readonly scanned: number;
  /** Records acknowledged and consequently retired. */
  readonly retired: readonly OutboxRecordRef[];
  /** Records still owed, because settlement did not return an acknowledgment. */
  readonly pending: readonly OutboxRecordRef[];
  /** Unreadable files, left exactly as found. */
  readonly corrupt: readonly OutboxCorruption[];
  /** True only when every record in scope was retired and nothing was corrupt. */
  readonly ok: boolean;
}

/**
 * Drains the records a producer owns, retiring only what is acknowledged.
 *
 * @param outbox - The store to drain from.
 * @param scope - Execution and authenticated role of the calling producer.
 * @param delivery - How each record is offered for durable acceptance.
 * @returns What the pass retired, what it left owed, and what it could not read.
 */
export async function drainOwnRecords(
  outbox: ClientOutbox,
  scope: OutboxDrainScope,
  delivery: DrainDelivery
): Promise<DrainReport> {
  const scan = await outbox.scan(scope);
  const retired: OutboxRecordRef[] = [];
  const pending: OutboxRecordRef[] = [];

  for (const record of scan.records) {
    const ref = outbox.refFor(record);
    const ack = await delivery.settle(ref);
    if (ack === null) {
      pending.push(ref);
      continue;
    }
    const result = await outbox.retire(ref, ack);
    // `already-retired` counts as retired: the obligation is demonstrably not
    // ours any more. A refusal does not — the record is still on disk and still
    // owed, and calling it drained would be the one lie this module cannot tell.
    if (result.kind === 'retired' || result.kind === 'already-retired') {
      retired.push(ref);
    } else {
      pending.push(ref);
    }
  }

  return {
    scanned: scan.records.length,
    retired,
    pending,
    corrupt: scan.corrupt,
    ok: pending.length === 0 && scan.corrupt.length === 0
  };
}

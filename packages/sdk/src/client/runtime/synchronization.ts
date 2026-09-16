import type { ClientOutbox, ReconciliationAuthorities, ReconciliationReport } from './outbox/index.js';
import { reconcileOutboxOnStartup } from './outbox/index.js';
import type { SynchronizationReport } from './types.js';

/**
 * The explicit phase between a registered socket and a usable one.
 *
 * Registration proves who the client is; it does not establish what either side already
 * knows. Until that is settled the client holds a set of durable obligations it cannot tell
 * apart from ones the server already accepted. Delivering new work on top of them is how a
 * duplicate effect happens, so the barrier below is a correctness boundary rather than a
 * startup nicety.
 *
 * @summary Reconciles pending obligations and recovered records before new work
 * @module
 */

/** What the server reported in response to `runtime.resume`. */
export interface ResumeAcknowledgment {
  /** Obligations the server has already durably accepted; the client retires exactly these. */
  readonly acceptedMessageIds: readonly string[];
}

/** What a reconnect reports when recovery was not its job to run. */
const EMPTY_RECONCILIATION: ReconciliationReport = {
  scanned: 0,
  retired: [],
  untrusted: [],
  blocked: [],
  unowned: [],
  corrupt: [],
  ok: true
};

/** Inputs to one synchronization pass. */
export interface SynchronizationInput {
  readonly outbox: ClientOutbox;
  readonly authorities: ReconciliationAuthorities;
  readonly executionId: string;
  readonly acknowledgment: ResumeAcknowledgment;
  /**
   * Whether to offer crash-surviving records to the recovery authorities first.
   *
   * True only on a client's first connection, never on a reconnect. Recovery claims records
   * whose originating process is gone, while the resume barrier settles records this client
   * still owes; run both over the same set and a record gets claimed twice, once on a
   * recovery authority's word and once on the server's. The distinction is which process
   * owns the obligation, and only the caller knows whether this is a fresh start.
   */
  readonly recoverOrphans: boolean;
}

/**
 * Settles the shared view before any new command is delivered.
 *
 * Runs startup reconciliation over crash-surviving records, then splits the client's
 * outstanding obligations into those the server confirmed and those still owed.
 *
 * @param input - Outbox, authorities, and the server's resume acknowledgment.
 * @returns What was reconciled and what remains pending.
 */
export async function synchronize(input: SynchronizationInput): Promise<SynchronizationReport> {
  const reconciliation = input.recoverOrphans
    ? await reconcileOutboxOnStartup(input.outbox, input.authorities)
    : EMPTY_RECONCILIATION;

  const outstanding = await collectOutstandingMessageIds(input.outbox, input.executionId);
  const accepted = new Set(input.acknowledgment.acceptedMessageIds);

  const { records } = await input.outbox.scanAll();
  for (const record of records) {
    if (record.executionId === input.executionId && accepted.has(record.messageId)) {
      await input.outbox.retire(input.outbox.refFor(record), {
        messageId: record.messageId,
        acknowledgedAt: new Date().toISOString()
      });
    }
  }

  return {
    acceptedMessageIds: outstanding.filter((id) => accepted.has(id)),
    pendingMessageIds: outstanding.filter((id) => !accepted.has(id)),
    reconciliation
  };
}

/**
 * Collects the message ids this client still owes, for the `runtime.resume` payload.
 *
 * Only durable classes appear here: the outbox excludes disposable telemetry by delivery
 * class, because a telemetry record replayed from disk claims an observation the client is
 * no longer making.
 *
 * @param outbox - The client's durable outbox.
 * @param executionId - Execution whose obligations to collect.
 * @returns Stable message ids awaiting durable acceptance.
 */
export async function collectOutstandingMessageIds(
  outbox: ClientOutbox,
  executionId: string
): Promise<readonly string[]> {
  const { records } = await outbox.scanAll();
  return records.filter((record) => record.executionId === executionId).map((record) => record.messageId);
}

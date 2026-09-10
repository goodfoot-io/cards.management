import type { ClientOutbox, ReconciliationAuthorities } from './outbox/index.js';
import type { SynchronizationReport } from './types.js';

/**
 * The explicit phase between a registered socket and a usable one.
 *
 * Registration proves who the client is; it does not establish what either side already
 * knows. Until that is settled the client holds two stale beliefs — an old work revision,
 * and a set of durable obligations it cannot tell apart from ones the server already
 * accepted. Delivering new work on top of either is how a duplicate effect happens, so the
 * barrier below is a correctness boundary rather than a startup nicety.
 *
 * @summary Reconciles revision, pending obligations, and recovered records before new work
 * @module
 */

/** What the server reported in response to `runtime.resume`. */
export interface ResumeAcknowledgment {
  readonly workRevision: number;
  /** Obligations the server has already durably accepted; the client retires exactly these. */
  readonly acceptedMessageIds: readonly string[];
}

/** Inputs to one synchronization pass. */
export interface SynchronizationInput {
  readonly outbox: ClientOutbox;
  readonly authorities: ReconciliationAuthorities;
  readonly executionId: string;
  readonly acknowledgment: ResumeAcknowledgment;
}

/**
 * Settles the shared view before any new command is delivered.
 *
 * Runs startup reconciliation over crash-surviving records, then splits the client's
 * outstanding obligations into those the server confirmed and those still owed.
 *
 * @param input - Outbox, authorities, and the server's resume acknowledgment.
 * @returns What was reconciled and what remains pending.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export async function synchronize(input: SynchronizationInput): Promise<SynchronizationReport> {
  void input;
  throw new Error('Not Implemented');
}

/**
 * Collects the message ids this client still owes, for the `runtime.resume` payload.
 *
 * Readiness never appears here: the outbox excludes it by delivery class, because a
 * readiness record replayed from disk cannot distinguish itself from a fresh observation
 * of idleness and would read as a false idle claim.
 *
 * @param outbox - The client's durable outbox.
 * @param executionId - Execution whose obligations to collect.
 * @returns Stable message ids awaiting durable acceptance.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export async function collectOutstandingMessageIds(
  outbox: ClientOutbox,
  executionId: string
): Promise<readonly string[]> {
  void outbox;
  void executionId;
  throw new Error('Not Implemented');
}

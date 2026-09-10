/**
 * Server startup reconciliation of records whose producers have exited.
 *
 * The drain in `./drain.js` covers the producer that is still alive. This covers
 * the one that is not: a hook that ran for two seconds, a CLI process the user
 * closed, a detached wrapper that finished after its editor window was gone. Its
 * obligation is still real, and nothing else will ever speak for it.
 *
 * Two refusals here are the substance of the module.
 *
 * A record for an execution the authority does not recognise is *untrusted*, not
 * garbage. It stays on disk and is reported. Deleting it would destroy the only
 * evidence of a claim that a later journal repair might well vindicate.
 *
 * A journal that cannot be consulted at all *blocks*. It does not read as an
 * empty journal, and an empty journal would be catastrophic here in a way that
 * is worth stating plainly: every record would come back `not-admitted`, every
 * obligation would look spurious, and a store full of real work would be
 * reported as a clean startup. That is why {@link OutcomeAcceptance} separates
 * "no" from "no answer", and why {@link ReconciliationReport.ok} is false the
 * moment anything blocks.
 *
 * @summary Startup reconciliation of exited producers' outbox records
 * @module runtime/outbox/reconcile
 */

import type {
  ClientOutbox,
  OutboxRecordRef,
  OutcomeAcceptor,
  ReconciliationFailure,
  ReconciliationReport
} from './types.js';

/**
 * Reconciles every record left by an exited producer.
 *
 * Retires a record only when the authoritative journal returns an acknowledgment
 * for it. Everything else is preserved and reported.
 *
 * @param outbox - The store to reconcile.
 * @param acceptor - Seam into the authoritative journal's acceptance path.
 * @returns What was retired, what was left, and whether startup may report clean.
 */
export async function reconcileOutboxOnStartup(
  outbox: ClientOutbox,
  acceptor: OutcomeAcceptor
): Promise<ReconciliationReport> {
  const scan = await outbox.scanAll();
  const retired: OutboxRecordRef[] = [];
  const untrusted: ReconciliationFailure[] = [];
  const blocked: ReconciliationFailure[] = [];

  for (const record of scan.records) {
    const ref = outbox.refFor(record);
    const acceptance = await acceptor.acceptRecovered(record);

    if (acceptance.kind === 'not-admitted') {
      untrusted.push({ ref, detail: acceptance.detail });
      continue;
    }
    if (acceptance.kind === 'authority-unavailable') {
      blocked.push({ ref, detail: acceptance.detail });
      continue;
    }

    const result = await outbox.retire(ref, acceptance.acknowledgment);
    if (result.kind === 'retired' || result.kind === 'already-retired') {
      retired.push(ref);
    } else {
      // The journal accepted it but the store would not release it. The
      // obligation is now held twice, which is safe, and leaving the record is
      // the only option that keeps it that way rather than risking zero.
      blocked.push({ ref, detail: `retirement refused: ${result.detail}` });
    }
  }

  return {
    scanned: scan.records.length,
    retired,
    untrusted,
    blocked,
    corrupt: scan.corrupt,
    ok: untrusted.length === 0 && blocked.length === 0 && scan.corrupt.length === 0
  };
}

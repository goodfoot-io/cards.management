/**
 * Server startup reconciliation of records whose producers have exited.
 *
 * The drain in `./drain.js` covers the producer that is still alive. This covers
 * the one that is not: a hook that ran for two seconds, a CLI process the user
 * closed, a detached wrapper that finished after its editor window was gone. Its
 * obligation is still real, and nothing else will ever speak for it.
 *
 * Which authority a record goes to depends on what the record is, because the
 * question that has to be answered before deleting the producer's copy differs
 * by kind.
 *
 * A `durable-result` record carries the only surviving copy of its envelope, so
 * something must take real custody of it. That goes to
 * {@link ReconciliationAuthorities.resultCustodian}, which writes and flushes its
 * own copy before acknowledging.
 *
 * A launch intent is different: admission's own record of the request is already
 * a durable copy, so the question is legitimacy, not custody, and
 * {@link ReconciliationAuthorities.launchIntentValidator} answers it.
 *
 * Every other durable intent — cancels, shutdown requests, watcher stops — has no
 * durable owner in this build. Those are never routed anywhere: the router
 * recognises that nothing can answer for them and reports them `unowned` without
 * asking. Offering one to either port would be inviting a component to vouch for
 * a copy it does not have, which is precisely how the only copy of an obligation
 * gets deleted.
 *
 * Three refusals here are the substance of the module.
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
 * A record nothing owns is *unowned*, which is neither. Nothing is broken and
 * the record may be entirely valid; there is simply no component in this build
 * that can hold it. Retrying will not help, so it is reported apart from
 * `blocked` — but it still keeps `ok` false, because an obligation with no home
 * is not a clean startup. This is a routing outcome rather than an authority's
 * answer, which is why {@link OutcomeAcceptance} has no branch for it: no
 * authority is consulted, so none of them has to have an opinion.
 *
 * A caller wiring this into a real startup sequence will have to decide whether
 * `ok: false` with only `unowned` populated should hard-fail or merely warn. That
 * question is deliberately left open here — nothing wires this to a startup
 * sequence yet, so answering it now would be guessing at a consumer that does not
 * exist. It resolves in milestone 3, when cancels, shutdown requests and watcher
 * stops get an owner and the bucket empties on its own.
 *
 * @summary Startup reconciliation of exited producers' outbox records
 * @module runtime/outbox/reconcile
 */

import type {
  ClientOutbox,
  OutboxRecord,
  OutboxRecordRef,
  OutcomeAcceptance,
  ReconciliationAuthorities,
  ReconciliationFailure,
  ReconciliationReport
} from './types.js';
import { LAUNCH_INTENT_MESSAGE_TYPES } from './types.js';

const LAUNCH_INTENT_TYPES: ReadonlySet<string> = new Set(LAUNCH_INTENT_MESSAGE_TYPES);

/**
 * Asks the authority that is entitled to answer for this particular record.
 *
 * @param record - A trusted, parsed record whose producer has exited.
 * @param authorities - The custody and validation ports.
 * @returns That authority's answer, or `no-custodian` when none is entitled.
 */
async function routeToAuthority(
  record: OutboxRecord,
  authorities: ReconciliationAuthorities
): Promise<OutcomeAcceptance | null> {
  if (record.deliveryClass === 'durable-result') {
    return authorities.resultCustodian.takeCustody(record);
  }
  if (LAUNCH_INTENT_TYPES.has(record.envelope.type)) {
    return authorities.launchIntentValidator.validateRecoveredObligation(record);
  }
  return null;
}

/**
 * Reconciles every record left by an exited producer.
 *
 * Retires a record only when the authority entitled to answer for it returns an
 * acknowledgment. Everything else is preserved and reported.
 *
 * @param outbox - The store to reconcile.
 * @param authorities - Custody and validation seams, routed to per record kind.
 * @returns What was retired, what was left, and whether startup may report clean.
 */
export async function reconcileOutboxOnStartup(
  outbox: ClientOutbox,
  authorities: ReconciliationAuthorities
): Promise<ReconciliationReport> {
  const scan = await outbox.scanAll();
  const retired: OutboxRecordRef[] = [];
  const untrusted: ReconciliationFailure[] = [];
  const blocked: ReconciliationFailure[] = [];
  const unowned: ReconciliationFailure[] = [];

  for (const record of scan.records) {
    const ref = outbox.refFor(record);
    const acceptance = await routeToAuthority(record, authorities);

    if (acceptance === null) {
      unowned.push({
        ref,
        detail: `no component durably holds '${record.envelope.type}' obligations in this build`
      });
      continue;
    }
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
      // The authority took custody but the store would not release the record.
      // The obligation is now held twice, which is safe, and leaving the record
      // is the only option that keeps it that way rather than risking zero.
      blocked.push({ ref, detail: `retirement refused: ${result.detail}` });
    }
  }

  return {
    scanned: scan.records.length,
    retired,
    untrusted,
    blocked,
    unowned,
    corrupt: scan.corrupt,
    ok: untrusted.length === 0 && blocked.length === 0 && unowned.length === 0 && scan.corrupt.length === 0
  };
}

/**
 * Contract types for the client outbox: the recovery storage a producer writes
 * an obligation into before it has been durably acknowledged.
 *
 * The outbox exists because of one asymmetry. A short-lived producer — an agent
 * hook, a CLI invocation, a detached wrapper finishing after its editor window is
 * gone — can form a durable obligation and then exit before anything authoritative
 * has accepted it. Without a durable local copy that obligation is simply lost. So
 * the producer writes it here first, and only deletes it once the authoritative
 * journal has confirmed it holds it instead. That handoff is the whole point: at
 * every instant exactly one party is responsible for the obligation, never zero
 * and never two.
 *
 * Three boundaries are deliberate and load-bearing.
 *
 * **This is not a transport.** There is no send, deliver, or flush in this module.
 * Live delivery is the runtime protocol's job; the outbox only makes a record
 * survive a process exit. A future caller reaching for the outbox to move a
 * message between two live parties is using the wrong thing, and the absence of a
 * delivery API is the guardrail.
 *
 * **This is not authority.** A record here is a producer's claim, not a decision.
 * Reconciliation may only retire a record once the authoritative journal has said
 * it durably accepted the obligation; a journal that is missing or corrupt blocks
 * reconciliation rather than being read as an empty journal that trivially accepts
 * everything. Retiring on unverified authority would delete the last copy of an
 * obligation nobody holds.
 *
 * **This never ingests a client-supplied path.** The root comes from server or SDK
 * configuration, and every caller-supplied identifier reaches the filesystem only
 * as a SHA-256 digest. Message IDs and execution IDs come from callers, and a
 * caller-supplied string must never reach a path join.
 *
 * @summary Types describing outbox records, role-scoped drain, and startup reconciliation
 */

import type { ProducerRole, RuntimeEnvelope } from '../../../protocol/index.js';

/** Schema version stamped into every record this build writes. */
export const OUTBOX_SCHEMA_VERSION = 1;

/**
 * Delivery classes the outbox will store.
 *
 * Only durable intents and durable results are retained until acknowledged, which
 * is exactly what makes a local copy meaningful. Reconciled snapshots and disposable
 * telemetry are excluded on purpose: both are claims about a moment, and replaying
 * one from disk after a crash would re-assert a state the producer is no longer
 * observing. They are re-established on reconnect, never recovered.
 */
export const OUTBOX_DELIVERY_CLASSES = ['durable-intent', 'durable-result'] as const;

/** A delivery class the outbox will store. */
export type OutboxDeliveryClass = (typeof OUTBOX_DELIVERY_CLASSES)[number];

/**
 * One durable obligation a producer has formed but not yet had acknowledged.
 *
 * `messageId` is the identity everything here keys on, because the protocol
 * already defines it as stable across retransmissions of the same logical
 * message. A producer that never learned whether its first write landed writes
 * again under the same ID and gets `exists`, not a duplicate obligation.
 */
export interface OutboxRecord {
  /** Version of this schema, so an older build's record is refused, not misread. */
  readonly schemaVersion: number;
  /** Stable message identity; the deduplication key and the file name's preimage. */
  readonly messageId: string;
  /** Execution this obligation belongs to; scopes both drain and reconciliation. */
  readonly executionId: string;
  /**
   * Original caller request ID the execution was admitted under.
   *
   * Carried even though `executionId` identifies the execution, because this is
   * the key the admission journal indexes by, and reconciliation must be able to
   * ask about a record without first resolving one identity into the other.
   */
  readonly requestId: string;
  /** Role that produced this record; drain is scoped to a single role. */
  readonly role: ProducerRole;
  /** Delivery class governing acceptance, restricted per {@link OUTBOX_DELIVERY_CLASSES}. */
  readonly deliveryClass: OutboxDeliveryClass;
  /** The message itself, as the protocol will decode it. */
  readonly envelope: RuntimeEnvelope;
  /** When the producer enqueued it, ISO 8601. Advisory; never used for ordering decisions. */
  readonly enqueuedAt: string;
}

/** The fields a producer supplies; the store stamps the rest. */
export type OutboxRecordInput = Omit<OutboxRecord, 'schemaVersion' | 'enqueuedAt'>;

/**
 * Where one record lives, without exposing its content.
 *
 * Carries the path so that a corrupt or blocked record can be named in an
 * operator-facing report; the path is produced by this module, never accepted
 * from a caller.
 */
export interface OutboxRecordRef {
  readonly messageId: string;
  readonly executionId: string;
  readonly role: ProducerRole;
  /** Absolute path of the record file, for evidence and diagnostics. */
  readonly path: string;
}

/** A record that exists but cannot be trusted, left exactly as found. */
export interface OutboxCorruption {
  /** Absolute path of the unreadable file. */
  readonly path: string;
  /** Why it could not be trusted — parse failure, unknown schema, missing field. */
  readonly detail: string;
}

/** Result of an exclusive enqueue attempt. */
export type EnqueueResult = 'created' | 'exists';

/** Which records a caller is entitled to see. */
export interface OutboxDrainScope {
  /** Execution whose records are being drained. */
  readonly executionId: string;
  /**
   * Role the caller authenticated as.
   *
   * A producer drains only what it produced. This is not a filter for
   * convenience: two roles on one execution hold independent obligations, and a
   * wrapper retiring a hook's record would delete a copy it never had the
   * acknowledgment for.
   */
  readonly role: ProducerRole;
}

/**
 * What one scan found.
 *
 * Readable records and corruption are reported together rather than the scan
 * failing on the first bad file, because one unreadable record must not strand
 * every healthy obligation beside it — and must not be silently skipped either.
 */
export interface OutboxScanResult {
  /** Records that parsed and are eligible for the requested scope. */
  readonly records: readonly OutboxRecord[];
  /** Files that could not be trusted. Non-empty means the caller must not report clean. */
  readonly corrupt: readonly OutboxCorruption[];
}

/**
 * Proof that the authoritative journal has durably taken an obligation.
 *
 * Retirement requires one of these rather than a boolean, so that a caller
 * cannot retire a record on the strength of a value it invented.
 */
export interface JournalAcknowledgment {
  /** Message the journal accepted; must match the record being retired. */
  readonly messageId: string;
  /** When the journal confirmed durable acceptance, ISO 8601. */
  readonly acknowledgedAt: string;
}

/** Outcome of attempting to retire one record. */
export type RetirementResult =
  | { readonly kind: 'retired' }
  /** No record for that ID — a retirement replayed after the first one succeeded. */
  | { readonly kind: 'already-retired' }
  /** The acknowledgment did not name this record; nothing was deleted. */
  | { readonly kind: 'refused'; readonly detail: string };

/**
 * Durable storage port for outbox records.
 *
 * Deliberately narrow: create, scan, retire. There is no update-in-place, because
 * a record's content is the obligation and rewriting it would let a producer
 * change what it promised after the fact; and no read-by-id, because every
 * legitimate consumer works from a scope, not from an ID it guessed.
 */
export interface ClientOutbox {
  /**
   * Writes one record, atomically and idempotently on its message ID.
   *
   * @param input - The obligation to persist.
   * @returns `created` on first write, `exists` when this message ID is already stored.
   */
  enqueue(input: OutboxRecordInput): Promise<EnqueueResult>;

  /**
   * Lists the records visible to one execution-and-role scope.
   *
   * @param scope - Execution and authenticated role of the caller.
   * @returns Readable records plus any corruption found while scanning.
   */
  scan(scope: OutboxDrainScope): Promise<OutboxScanResult>;

  /**
   * Lists every record in the store, for server startup reconciliation.
   *
   * Unscoped because the originating producers have exited and no longer speak
   * for themselves; this is the only caller entitled to that view.
   *
   * @returns Every readable record plus any corruption found while scanning.
   */
  scanAll(): Promise<OutboxScanResult>;

  /**
   * Names where one record lives, so a report can cite it as evidence.
   *
   * The store computes the path; a caller never supplies one. This is the only
   * way to obtain an {@link OutboxRecordRef}, which is what keeps the retirement
   * path from ever being handed a location a caller invented.
   *
   * @param record - A record this store returned.
   * @returns Its identifiers together with its computed path.
   */
  refFor(record: OutboxRecord): OutboxRecordRef;

  /**
   * Deletes one record, and only against an acknowledgment naming it.
   *
   * Deletion is correct here, unlike in the admission journal: an outbox record
   * is the producer's copy, and the handoff is complete precisely when it is
   * gone. Retiring without acknowledgment would leave the obligation held by
   * nobody.
   *
   * @param ref - The record to retire.
   * @param ack - Journal acknowledgment that must name the same message.
   * @returns Whether the record was retired, already gone, or refused.
   */
  retire(ref: OutboxRecordRef, ack: JournalAcknowledgment): Promise<RetirementResult>;
}

/**
 * Message types that are an execution's original launch intent.
 *
 * These are the durable intents whose durable copy is already held elsewhere:
 * admission's own record of the request. Reconciliation may therefore retire one
 * on a validator's say-so, because it is confirming legitimacy rather than taking
 * custody — the copy it is vouching for already exists.
 *
 * Every other durable intent — cancels, shutdown requests, watcher stops — has no
 * durable owner yet. Routing keys on this list rather than on `deliveryClass`
 * alone precisely so that a type nobody holds a copy of cannot be retired by
 * accident when a new intent is added to the protocol.
 */
export const LAUNCH_INTENT_MESSAGE_TYPES = ['execution.launchRequest'] as const;

/** A durable intent whose durable copy admission already holds. */
export type LaunchIntentMessageType = (typeof LAUNCH_INTENT_MESSAGE_TYPES)[number];

/**
 * What an authority said about one recovered record.
 *
 * `accepted` has exactly one meaning wherever it appears: it is safe to retire
 * this record, because a durable copy of the obligation exists that is not this
 * one. Whether that copy was just written by a custodian or already existed
 * elsewhere is the answering party's business, not the caller's.
 *
 * The two refusals are distinct on purpose. `not-admitted` is a definite answer:
 * the record is untrusted and stays put. `authority-unavailable` is no answer at
 * all, and reading it as `not-admitted` would turn a corrupt journal into a
 * licence to retire every obligation it failed to recognise.
 */
export type OutcomeAcceptance =
  | { readonly kind: 'accepted'; readonly acknowledgment: JournalAcknowledgment }
  | { readonly kind: 'not-admitted'; readonly detail: string }
  | { readonly kind: 'authority-unavailable'; readonly detail: string };

/**
 * The seam into whatever durably persists a recovered result envelope.
 *
 * A `durable-result` record carries the only surviving copy of its envelope, so
 * the party that authorises its retirement must be the party that has written a
 * copy of its own and flushed it. Naming this port for custody rather than for
 * acceptance is the whole correction: an implementation that merely recognises a
 * record and returns `accepted` satisfies an acceptance-shaped interface while
 * leaving the obligation held by nobody.
 */
export interface RecoveredResultCustodian {
  /**
   * Takes durable custody of one recovered result, then acknowledges it.
   *
   * An implementation must not return `accepted` until its own copy of
   * {@link OutboxRecord.envelope} is durable — flushed, not merely queued. The
   * caller deletes the last other copy on the strength of that answer.
   *
   * @param record - A trusted, parsed `durable-result` record whose producer has exited.
   * @returns Acknowledgment of durable custody, a definite refusal, or the
   *   statement that the custodian could not be consulted at all.
   */
  takeCustody(record: OutboxRecord): Promise<OutcomeAcceptance>;
}

/**
 * The seam into admission's validation of a recovered launch intent.
 *
 * Unlike {@link RecoveredResultCustodian} this port takes no custody, and does
 * not need to: admission's own record of the launch request is already the
 * durable copy. It answers only whether the obligation is legitimate — admitted,
 * matching the execution it names, and neither revoked nor already retired.
 */
export interface RecoveredIntentValidator {
  /**
   * Confirms one recovered launch intent is legitimate and already durably held.
   *
   * @param record - A trusted, parsed launch-intent record whose producer has exited.
   * @returns Acknowledgment that admission holds it, a definite refusal, or the
   *   statement that admission could not be consulted at all.
   */
  validateRecoveredObligation(record: OutboxRecord): Promise<OutcomeAcceptance>;
}

/**
 * The authorities reconciliation routes to, one per kind of obligation.
 *
 * There is deliberately no single acceptor. The two ports answer different
 * questions — one takes custody, one attests that custody already exists — and a
 * single method would have to mean both, which is exactly the ambiguity that let
 * a recognition-only implementation authorise deletion of the only copy.
 */
export interface ReconciliationAuthorities {
  /** Takes custody of recovered `durable-result` records. */
  readonly resultCustodian: RecoveredResultCustodian;
  /** Validates recovered launch intents, whose copy admission already holds. */
  readonly launchIntentValidator: RecoveredIntentValidator;
}

/** One record reconciliation could not complete, and why. */
export interface ReconciliationFailure {
  readonly ref: OutboxRecordRef;
  readonly detail: string;
}

/**
 * What one startup reconciliation pass did.
 *
 * `ok` is false whenever anything was left behind, so a caller cannot report a
 * clean startup while evidence of an unheld obligation sits on disk. That
 * includes `unowned`: an obligation no component can discharge is a real gap,
 * and a build that reports clean while carrying one is lying about its state.
 */
export interface ReconciliationReport {
  /** Records read, including ones that were then refused. */
  readonly scanned: number;
  /** Records an authority took or attested custody of, and that were consequently retired. */
  readonly retired: readonly OutboxRecordRef[];
  /** Records for executions the journal does not recognise. Left in place. */
  readonly untrusted: readonly ReconciliationFailure[];
  /** Records left in place because authority could not be consulted. */
  readonly blocked: readonly ReconciliationFailure[];
  /**
   * Records of a kind nothing durably holds yet. Left in place.
   *
   * Separate from `blocked` because the cause is structural rather than
   * operational: nothing is broken and retrying will not help until the owning
   * component exists. An operator reading a report needs to tell "the journal is
   * down" apart from "this obligation has no home in this build".
   */
  readonly unowned: readonly ReconciliationFailure[];
  /** Unreadable files, left exactly as found. */
  readonly corrupt: readonly OutboxCorruption[];
  /** True only when every record was reconciled and nothing was corrupt. */
  readonly ok: boolean;
}

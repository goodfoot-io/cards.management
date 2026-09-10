/**
 * The five delivery classes and their acceptance and replay semantics.
 *
 * Every runtime message belongs to exactly one class, and the class — not the
 * handler — decides what a duplicate means, whether the message may be dropped,
 * and whether it can ever be treated as evidence that work finished. Putting
 * this in one place is the point: the previous transport let each call site
 * invent its own answer, which is how a replayed readiness record could
 * terminate an agent that had since started new work.
 *
 * The classes differ along one axis each:
 *
 * - A reconciled snapshot describes current truth, so the newest one wins and
 *   older ones are discarded rather than applied.
 * - A durable intent asks for an effect, so it is persisted before it is
 *   acknowledged and replayed until it is accepted, and a duplicate returns the
 *   recorded outcome rather than performing the effect again.
 * - Revocable readiness evidence is true only at an instant, so receipt and
 *   authorization are separated: acknowledging it confirms it was stored, never
 *   that the agent is still idle.
 * - A durable result reports a terminal fact, so its producer keeps a local
 *   copy until the authoritative journal confirms it has taken over the
 *   obligation.
 * - Disposable telemetry is observational, so it is bounded and droppable, and
 *   is never permitted to advance any consumer's durable state.
 *
 * @summary Delivery-class definitions with acceptance, replay, and authorization semantics
 * @module
 */

import { z } from 'zod';
import type { OwnershipStamp } from './runtime-identity.js';

/** The five delivery classes, in the order the protocol contract lists them. */
export const DELIVERY_CLASSES = [
  'reconciled-snapshot',
  'durable-intent',
  'revocable-readiness',
  'durable-result',
  'disposable-telemetry'
] as const;

/** A delivery class drawn from {@link DELIVERY_CLASSES}. */
export type DeliveryClass = (typeof DELIVERY_CLASSES)[number];

/** Zod schema for {@link DeliveryClass}. */
export const deliveryClassSchema = z.enum(DELIVERY_CLASSES);

/**
 * The invariants a delivery class asserts. These are declarative so that a
 * handler cannot quietly opt out of them: for example, no message whose class
 * has `completionEvidence: false` may be used to move an execution to a
 * terminal lifecycle state.
 */
export interface DeliveryClassPolicy {
  /** The class these invariants describe. */
  readonly deliveryClass: DeliveryClass;
  /** The receiver must durably persist the message before acknowledging it. */
  readonly persistBeforeAcknowledgment: boolean;
  /** The producer retransmits until the receiver reports acceptance. */
  readonly replayedUntilAccepted: boolean;
  /** The producer may retire its local copy only after acknowledged persistence. */
  readonly retainedUntilServerPersisted: boolean;
  /** The message may be dropped under back pressure, with the drop observable. */
  readonly droppable: boolean;
  /** A replay is answered with the recorded outcome instead of a repeated effect. */
  readonly replayReturnsRecordedOutcome: boolean;
  /** The message may be used as evidence that work completed. */
  readonly completionEvidence: boolean;
}

/** The invariants each delivery class asserts, keyed by class. */
export const DELIVERY_CLASS_POLICIES: Readonly<Record<DeliveryClass, DeliveryClassPolicy>> = {
  'reconciled-snapshot': {
    deliveryClass: 'reconciled-snapshot',
    persistBeforeAcknowledgment: false,
    replayedUntilAccepted: false,
    retainedUntilServerPersisted: false,
    droppable: false,
    replayReturnsRecordedOutcome: false,
    completionEvidence: false
  },
  'durable-intent': {
    deliveryClass: 'durable-intent',
    persistBeforeAcknowledgment: true,
    replayedUntilAccepted: true,
    retainedUntilServerPersisted: true,
    droppable: false,
    replayReturnsRecordedOutcome: true,
    completionEvidence: false
  },
  'revocable-readiness': {
    deliveryClass: 'revocable-readiness',
    persistBeforeAcknowledgment: true,
    replayedUntilAccepted: true,
    retainedUntilServerPersisted: true,
    droppable: false,
    replayReturnsRecordedOutcome: false,
    completionEvidence: false
  },
  'durable-result': {
    deliveryClass: 'durable-result',
    persistBeforeAcknowledgment: true,
    replayedUntilAccepted: true,
    retainedUntilServerPersisted: true,
    droppable: false,
    replayReturnsRecordedOutcome: true,
    completionEvidence: true
  },
  'disposable-telemetry': {
    deliveryClass: 'disposable-telemetry',
    persistBeforeAcknowledgment: false,
    replayedUntilAccepted: false,
    retainedUntilServerPersisted: false,
    droppable: true,
    replayReturnsRecordedOutcome: false,
    completionEvidence: false
  }
};

/**
 * What the receiver should do with an inbound message.
 *
 * `require-revalidation` is specific to revocable readiness: the message was
 * durably received and will be acknowledged, but it does not authorize the
 * effect it is evidence for until fresh authority is obtained.
 */
export type DeliveryDisposition =
  | 'accept'
  | 'ignore-stale'
  | 'replay-recorded-outcome'
  | 'reject-fenced'
  | 'drop-bounded'
  | 'require-revalidation';

/** A delivery decision and the reason it was reached, for diagnostics. */
export interface DeliveryDecision {
  /** What the receiver should do. */
  readonly disposition: DeliveryDisposition;
  /** Stable, human-readable justification suitable for structured logs. */
  readonly reason: string;
}

// --- Reconciled snapshot ---

/**
 * The precedence stamp on a reconciled snapshot. Ownership generation is
 * compared first and revision second, so a stale connection bearing a high
 * revision can never overwrite state written under a newer generation.
 */
export interface SnapshotStamp {
  /** Ownership fence the snapshot was produced under. */
  readonly ownership: OwnershipStamp;
  /** Snapshot revision within that ownership generation. */
  readonly revision: number;
}

/**
 * Decides whether a reconciled snapshot supersedes the recorded one.
 *
 * @param incoming - Stamp carried by the inbound snapshot.
 * @param current - Stamp of the snapshot currently recorded, or `undefined`
 *   when none has been recorded yet.
 * @returns `accept` when the snapshot is strictly newer, `ignore-stale` when it
 *   is equal or older within the same generation, and `reject-fenced` when its
 *   ownership generation is stale or conflicts with the recorded one.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function evaluateReconciledSnapshot(
  incoming: SnapshotStamp,
  current: SnapshotStamp | undefined
): DeliveryDecision {
  void incoming;
  void current;
  throw new Error('Not Implemented');
}

// --- Durable intent ---

/**
 * What the journal knows about one durable intent. `persisted` without
 * `accepted` is the crash window: the obligation is recorded but its effect has
 * not been performed, so a replay must still be accepted.
 */
export interface DurableIntentRecord {
  /** Stable message ID of the intent. */
  readonly messageId: string;
  /** The obligation has been durably written. */
  readonly persisted: boolean;
  /** The effect has been performed and its outcome recorded. */
  readonly accepted: boolean;
  /** Recorded outcome, present once `accepted` is true. */
  readonly outcome?: unknown;
}

/**
 * Decides whether a durable intent must be performed or answered from the
 * record.
 *
 * @param messageId - Stable message ID of the inbound intent.
 * @param record - Journal record for that ID, or `undefined` if unseen.
 * @returns `accept` when the intent is new or persisted-but-unaccepted, and
 *   `replay-recorded-outcome` when it has already been accepted.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function evaluateDurableIntent(messageId: string, record: DurableIntentRecord | undefined): DeliveryDecision {
  void messageId;
  void record;
  throw new Error('Not Implemented');
}

// --- Revocable readiness evidence ---

/** Stored readiness evidence, keyed by shutdown request and work revision. */
export interface ReadinessRecord {
  /** Shutdown request the readiness was reported against. */
  readonly shutdownRequestId: string;
  /** Work revision current at the moment idleness was observed. */
  readonly workRevision: number;
}

/**
 * Everything needed to decide whether stored readiness may authorize a
 * termination right now.
 *
 * `drain` describes a strict drain performed for the current revision, with a
 * barrier held against new work. It must be present, current, and held; a drain
 * performed for an earlier revision is not evidence about this one.
 */
export interface TerminationAuthorizationInput {
  /** Shutdown request whose effect is being considered. */
  readonly shutdownRequestId: string;
  /** Stored readiness evidence, or `undefined` when none was recorded. */
  readonly readiness: ReadinessRecord | undefined;
  /** Work revision the execution is on right now. */
  readonly currentWorkRevision: number;
  /** Freshly established strict drain, or `undefined` if none is held. */
  readonly drain:
    | {
        /** Revision the drain was established for. */
        readonly workRevision: number;
        /** Whether the new-work barrier is currently held. */
        readonly barrierHeld: boolean;
      }
    | undefined;
}

/** Why a termination was not authorized. */
export type TerminationRefusalReason =
  | 'no-readiness-recorded'
  | 'readiness-for-other-request'
  | 'readiness-superseded'
  | 'drain-missing'
  | 'drain-stale'
  | 'barrier-not-held';

/**
 * Whether stored readiness authorizes terminating the execution. Refusal is not
 * an error: the shutdown stays durably pending and visible until fresh
 * authority can be obtained.
 */
export type TerminationAuthorization =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: TerminationRefusalReason };

/**
 * Records readiness evidence. Acceptance here means the evidence was durably
 * stored, never that the agent is still idle.
 *
 * @param incoming - Readiness reported by the agent hook.
 * @param currentWorkRevision - Work revision the execution is on right now.
 * @returns `accept` when the evidence is current, and `require-revalidation`
 *   when it is stored but already superseded by a newer work revision.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function evaluateReadinessReceipt(incoming: ReadinessRecord, currentWorkRevision: number): DeliveryDecision {
  void incoming;
  void currentWorkRevision;
  throw new Error('Not Implemented');
}

/**
 * Decides whether stored readiness plus a held drain authorize termination.
 *
 * Every refusal path keeps the shutdown pending rather than forcing it forward;
 * there is deliberately no timeout parameter, because a deadline expiring is
 * not evidence that an agent is idle.
 *
 * @param input - Readiness, current revision, and the drain state.
 * @returns Authorization, or a refusal naming which invariant was not met.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function authorizeTermination(input: TerminationAuthorizationInput): TerminationAuthorization {
  void input;
  throw new Error('Not Implemented');
}

// --- Durable result ---

/**
 * What the journal knows about one durable result. The producer may retire its
 * local copy only once `serverPersisted` is true, which is the durable-copy
 * handoff: exactly one party holds the obligation at every instant.
 */
export interface DurableResultRecord {
  /** Stable message ID of the result. */
  readonly messageId: string;
  /** The authoritative journal has durably accepted this result. */
  readonly serverPersisted: boolean;
}

/**
 * Decides whether a durable result must be persisted or is a duplicate of one
 * already persisted.
 *
 * @param messageId - Stable message ID of the inbound result.
 * @param record - Journal record for that ID, or `undefined` if unseen.
 * @returns `accept` when unseen, `replay-recorded-outcome` when already
 *   persisted so the producer can retire its copy.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function evaluateDurableResult(messageId: string, record: DurableResultRecord | undefined): DeliveryDecision {
  void messageId;
  void record;
  throw new Error('Not Implemented');
}

/**
 * Whether a producer may delete its local copy of a durable result.
 *
 * @param record - Journal acknowledgment the producer has received, or
 *   `undefined` when it has received none.
 * @returns True only when the authoritative journal has confirmed it holds the
 *   obligation; a lost acknowledgment keeps the copy.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function canRetireDurableResult(record: DurableResultRecord | undefined): boolean {
  void record;
  throw new Error('Not Implemented');
}

// --- Disposable telemetry ---

/** Occupancy of a bounded telemetry buffer. */
export interface TelemetryBufferState {
  /** Messages currently buffered. */
  readonly depth: number;
  /** Maximum the buffer will hold. */
  readonly capacity: number;
}

/**
 * Decides whether a telemetry message fits in its bounded buffer.
 *
 * A `drop-bounded` decision must be counted and surfaced as a diagnostic. A
 * silent drop is what makes telemetry loss look like an idle agent.
 *
 * @param buffer - Current occupancy of the destination buffer.
 * @returns `accept` when there is room, `drop-bounded` when there is not.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function evaluateDisposableTelemetry(buffer: TelemetryBufferState): DeliveryDecision {
  void buffer;
  throw new Error('Not Implemented');
}

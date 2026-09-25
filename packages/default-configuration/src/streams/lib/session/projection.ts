/**
 * Source-local reconciliation and provider reducer contracts.
 *
 * Providers classify exact replay, documented updates, and conflicting native IDs
 * in their reducer. The shared cache owns physical range reconciliation only.
 *
 * @summary Incremental native transcript projection lifecycle
 * @module streams/lib/session/projection
 */

import type { NativeRecordProvenance, NativeTranscriptSource, SessionIdentity, SessionProjection } from './types';

/** A complete native record with provenance assigned before provider parsing. */
export interface NativeTranscriptRecord {
  readonly text: string;
  readonly provenance: NativeRecordProvenance;
}

/** The same ordered reducer is used for replay and ordinary append. */
export interface NativeTranscriptProjector<State, Parsed, Payloads extends object = Record<string, unknown>> {
  /** Diagnostic provider namespace, not a source identity. */
  readonly providerId: string;
  /** Creates source-local semantic event and tool association state. */
  createState(source: NativeTranscriptSource): State;
  /** Parses once per physical coordinate/content; malformed records must remain inspectable. */
  parseRecord(record: NativeTranscriptRecord): Parsed;
  /** Applies one ordered record, retaining all replay provenance and stable leaf identities. */
  reduce(state: State, parsed: Parsed, record: NativeTranscriptRecord): void;
  /** Projects current state and fresh metadata without parsing unchanged native lines. */
  project(state: State, source: NativeTranscriptSource): SessionProjection<Payloads>;
  /** Releases provider-owned caches when the generation changes, a rebuild occurs, or disposed. */
  disposeState?(state: State): void;
}

/** Reconciliation classification is diagnostic; it must not change provider display semantics. */
export type ProjectionUpdateKind = 'initial' | 'unchanged' | 'metadata' | 'append' | 'replay' | 'reset';

/** Removed identities let callers prune controlled view state for invalidated content only. */
export interface ProjectionUpdate<Payloads extends object> {
  readonly projection: SessionProjection<Payloads>;
  readonly kind: ProjectionUpdateKind;
  readonly invalidatedIds: readonly SessionIdentity[];
}

/** A controller belongs to exactly one source key and rejects updates after disposal. */
export interface TranscriptProjectionController<Payloads extends object> {
  /** Reconcile full supplied range by coordinate/content, including overlap/prepend/replacement. */
  update(source: NativeTranscriptSource): ProjectionUpdate<Payloads>;
  /** Clears the source state and parse cache; idempotent. */
  dispose(): void;
}

/**
 * Creates a source-local cache. A changed caller generation discards all prior state;
 * same-generation incompatible ranges rebuild through the same reducer using cached parsing.
 * @param projector - Provider-specific parser and semantic reducer.
 * @param sourceKey - Immutable qualified source identity for this controller.
 * @throws Until the contract implementation is completed.
 * @returns Disposable projection lifecycle.
 */
export function createTranscriptProjection<State, Parsed, Payloads extends object>(
  projector: NativeTranscriptProjector<State, Parsed, Payloads>,
  sourceKey: string
): TranscriptProjectionController<Payloads> {
  void projector;
  void sourceKey;
  throw new Error('Not Implemented');
}

/**
 * Replays a complete native range through exactly the same reducer used by the cache.
 * @param projector - Provider parser and semantic reducer.
 * @param source - Complete current native range.
 * @throws Until the contract implementation is completed.
 * @returns Display semantics used as the incremental conformance oracle.
 */
export function replayTranscript<State, Parsed, Payloads extends object>(
  projector: NativeTranscriptProjector<State, Parsed, Payloads>,
  source: NativeTranscriptSource
): SessionProjection<Payloads> {
  void projector;
  void source;
  throw new Error('Not Implemented');
}

/**
 * Encodes collision-free identity components without depending on rendered text or grouping.
 * @param source - Caller-qualified source identity and generation.
 * @param namespace - Provider-owned semantic entity namespace, such as tool or message.
 * @param selector - Proven semantic key or deterministic physical line/block selector.
 * @throws Until the contract implementation is completed.
 * @returns Stable source/generation-scoped display identity.
 */
export function sessionIdentity(
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>,
  namespace: string,
  selector: string
): SessionIdentity {
  void source;
  void namespace;
  void selector;
  throw new Error('Not Implemented');
}

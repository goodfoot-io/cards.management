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
  /** Projects current state and metadata; reuse untouched immutable rows so appends avoid rerendering history. */
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

/** Controls optional identity-diff bookkeeping for callers that reconcile their own view state. */
export interface TranscriptProjectionOptions {
  /** Compute removed row/leaf IDs after replacements; defaults to true. */
  readonly includeInvalidatedIds?: boolean;
}

/**
 * Creates a source-local cache. A changed caller generation discards all prior state;
 * same-generation incompatible ranges rebuild through the same reducer using cached parsing.
 * @param projector - Provider-specific parser and semantic reducer.
 * @param sourceKey - Immutable qualified source identity for this controller.
 * @param options - Optional invalidated-identity bookkeeping; projection semantics remain identical.
 * @returns Disposable projection lifecycle.
 */
export function createTranscriptProjection<State, Parsed, Payloads extends object>(
  projector: NativeTranscriptProjector<State, Parsed, Payloads>,
  sourceKey: string,
  options: TranscriptProjectionOptions = {}
): TranscriptProjectionController<Payloads> {
  let previous: NativeTranscriptSource | undefined;
  let state: State | undefined;
  let projection: SessionProjection<Payloads> | undefined;
  let disposed = false;
  let cache = new Map<number, { text: string; parsed: Parsed; record: NativeTranscriptRecord }>();
  const release = (): void => {
    if (state !== undefined) projector.disposeState?.(state);
    state = undefined;
  };
  return {
    update(source) {
      if (disposed) throw new Error('Transcript projection is disposed');
      if (source.sourceKey !== sourceKey) throw new Error('Transcript source key cannot change');
      validateSource(source);
      const reset = previous !== undefined && previous.generation !== source.generation;
      const sameStart = previous?.headLineNumber === source.headLineNumber;
      const prefix =
        !reset &&
        sameStart &&
        previous !== undefined &&
        previous.lines.length <= source.lines.length &&
        previous.lines.every((line, index) => source.lines[index] === line);
      const sameLines = prefix && previous?.lines.length === source.lines.length;
      if (sameLines && previous && projection && sameMetadata(previous, source)) {
        return { projection, kind: 'unchanged', invalidatedIds: [] };
      }
      const kind: ProjectionUpdateKind = !previous
        ? 'initial'
        : reset
          ? 'reset'
          : sameLines
            ? 'metadata'
            : prefix
              ? 'append'
              : 'replay';
      const oldProjection = projection;
      if (!prefix) {
        release();
        if (reset) cache.clear();
        state = projector.createState(source);
      }
      const current = state as State;
      const start = prefix ? (previous?.lines.length ?? 0) : 0;
      for (let index = start; index < source.lines.length; index++) {
        const text = source.lines[index]!;
        const lineNumber = source.headLineNumber + index;
        let entry = cache.get(lineNumber);
        if (!entry || entry.text !== text) {
          const record: NativeTranscriptRecord = {
            text,
            provenance: { sourceKey, generation: source.generation, lineNumber, selector: 'record' }
          };
          entry = { text, record, parsed: projector.parseRecord(record) };
          cache.set(lineNumber, entry);
        }
        projector.reduce(current, entry.parsed, entry.record);
      }
      if (!prefix) {
        const end = source.headLineNumber + source.lines.length;
        cache = new Map([...cache].filter(([line]) => line >= source.headLineNumber && line < end));
      }
      projection = projector.project(current, source);
      previous = source;
      let invalidatedIds: SessionIdentity[] = [];
      if (options.includeInvalidatedIds !== false && oldProjection) {
        const survivors = projectionIds(projection);
        invalidatedIds = [...projectionIds(oldProjection)].filter((id) => !survivors.has(id));
      }
      return { projection, kind, invalidatedIds };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
      cache.clear();
      previous = undefined;
      projection = undefined;
    }
  };
}

/**
 * Replays a complete native range through exactly the same reducer used by the cache.
 * @param projector - Provider parser and semantic reducer.
 * @param source - Complete current native range.
 * @returns Display semantics used as the incremental conformance oracle.
 */
export function replayTranscript<State, Parsed, Payloads extends object>(
  projector: NativeTranscriptProjector<State, Parsed, Payloads>,
  source: NativeTranscriptSource
): SessionProjection<Payloads> {
  const controller = createTranscriptProjection(projector, source.sourceKey);
  try {
    return controller.update(source).projection;
  } finally {
    controller.dispose();
  }
}

/**
 * Encodes collision-free identity components without depending on rendered text or grouping.
 * @param source - Caller-qualified source identity and generation.
 * @param namespace - Provider-owned semantic entity namespace, such as tool or message.
 * @param selector - Proven semantic key or deterministic physical line/block selector.
 * @returns Stable source/generation-scoped display identity.
 */
export function sessionIdentity(
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>,
  namespace: string,
  selector: string
): SessionIdentity {
  return JSON.stringify([source.sourceKey, source.generation, namespace, selector]);
}

/** Compare source metadata without making unrelated store changes trigger replay.
 * @param left - Previous source metadata.
 * @param right - Current source metadata.
 * @returns Metadata equality.
 */
function sameMetadata(left: NativeTranscriptSource, right: NativeTranscriptSource): boolean {
  return (
    left.filename === right.filename &&
    left.isLoading === right.isLoading &&
    left.error === right.error &&
    JSON.stringify(left.meta) === JSON.stringify(right.meta)
  );
}

/** Collect row and stable leaf identities so regrouping can preserve surviving disclosure state.
 * @param projection - Current display rows and parts.
 * @returns Unique displayed row and leaf identities.
 */
function projectionIds<Payloads extends object>(projection: SessionProjection<Payloads>): Set<SessionIdentity> {
  const ids = new Set<SessionIdentity>();
  for (const row of projection.rows) {
    ids.add(row.id);
    for (const part of row.parts) ids.add(part.id);
  }
  return ids;
}

/**
 * Reject invalid physical coordinates before mutating provider state.
 * @throws When a nonempty native range lacks a positive safe absolute coordinate.
 * @param source - Native contiguous source range.
 */
function validateSource(source: NativeTranscriptSource): void {
  if (
    source.lines.length > 0 &&
    (!Number.isSafeInteger(source.headLineNumber) ||
      source.headLineNumber < 1 ||
      !Number.isSafeInteger(source.headLineNumber + source.lines.length - 1))
  ) {
    throw new Error('Native transcript line coordinates must be positive safe integers');
  }
}

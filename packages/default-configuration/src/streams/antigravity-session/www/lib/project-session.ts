/**
 * Antigravity's native destination records to Cards-owned semantic session rows.
 * This provider keeps its own pinned parser and does not adapt records through Claude.
 * @summary Antigravity native transcript projection
 * @module streams/antigravity-session/www/lib/project-session
 */

import { type NativeTranscriptProjector, sessionIdentity } from '../../../lib/session/projection';
import type { NativeRecordProvenance, NativeTranscriptSource, SessionRow } from '../../../lib/session/types';
import type { AntigravityRecord, ParsedAntigravityLine } from './parser';
import { parseAntigravityLine, SCHEMA_DRIFT_SENTINEL_IDX } from './parser';

/** Provider-owned anomaly details retained as visible, typed event content. */
export interface AntigravityAnomalyPayload {
  readonly kind: 'host-drift' | 'flush-partial' | 'format-unknown' | 'schema-drift';
  readonly idx?: number;
  readonly stepType?: number;
  readonly status?: number;
  readonly detail: string;
  /** Only decodable partial or revised content is presented as evidence. */
  readonly content?: string;
  /** The unknown-format payload stays withheld; only its encoded size is retained. */
  readonly withheldBytes?: number;
}

/** A decoded native Antigravity invocation; it carries no executable action. */
export interface AntigravityToolCallPayload {
  readonly idx: number;
  readonly stepType: number;
  readonly status: number;
  readonly name: string;
  readonly arguments: unknown;
}

/** Antigravity-specific row and part payload registry. */
export interface AntigravityPayloads {
  readonly anomaly: AntigravityAnomalyPayload;
  readonly toolCall: AntigravityToolCallPayload;
}

/** Semantic rows emitted by the Antigravity projector. */
export type AntigravityRow = SessionRow<AntigravityPayloads>;

interface RecordEvent {
  readonly kind: 'record';
  readonly record: AntigravityRecord;
  readonly rawLine: string;
  provenance: NativeRecordProvenance[];
  row?: AntigravityRow;
}

interface MalformedEvent {
  readonly kind: 'malformed';
  readonly rawLine: string;
  readonly reason: string;
  readonly provenance: NativeRecordProvenance[];
  row?: AntigravityRow;
}

type ParsedRecord = ParsedAntigravityLine;
type AntigravityEvent = RecordEvent | MalformedEvent;

/** Source-local ordering and exact-replay state for one native transcript generation. */
export interface AntigravityProjectionState {
  readonly source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>;
  readonly seen: Map<string, RecordEvent>;
  readonly steps: RecordEvent[];
  readonly sentinels: RecordEvent[];
  readonly malformed: MalformedEvent[];
}

/**
 * Antigravity parser, replay classifier, ordering reducer, and semantic row builder.
 * @returns The source-local native transcript projector.
 */
export function createAntigravitySessionProjector(): NativeTranscriptProjector<
  AntigravityProjectionState,
  ParsedRecord,
  AntigravityPayloads
> {
  return {
    providerId: 'antigravity',
    createState(source) {
      return {
        source: { sourceKey: source.sourceKey, generation: source.generation },
        seen: new Map(),
        steps: [],
        sentinels: [],
        malformed: []
      };
    },
    parseRecord(record) {
      return parseAntigravityLine(record.text);
    },
    reduce(state, parsed, native) {
      if (parsed.kind === 'blank') return;
      if (parsed.kind === 'malformed') {
        state.malformed.push({
          kind: 'malformed',
          rawLine: parsed.rawLine,
          reason: parsed.reason,
          provenance: [native.provenance]
        });
        return;
      }

      // The destination contract defines exact semantic replay by (idx, hash).
      const key = recordKey(parsed.record);
      const previous = state.seen.get(key);
      if (previous) {
        previous.provenance.push(native.provenance);
        previous.row = recordRow(state.source, previous);
        return;
      }

      const event: RecordEvent = {
        kind: 'record',
        record: parsed.record,
        rawLine: native.text,
        provenance: [native.provenance]
      };
      state.seen.set(key, event);
      if (parsed.record.idx === SCHEMA_DRIFT_SENTINEL_IDX) {
        state.sentinels.push(event);
      } else {
        // Keep same-index arrival order; distinct content remains inspectable.
        const position = state.steps.findIndex((item) => item.record.idx > parsed.record.idx);
        state.steps.splice(position < 0 ? state.steps.length : position, 0, event);
      }
    },
    project(state, source) {
      const events: AntigravityEvent[] = [...state.steps, ...state.sentinels, ...state.malformed];
      const rows = events.map(
        (event) =>
          (event.row ??= event.kind === 'record' ? recordRow(state.source, event) : malformedRow(state.source, event))
      );
      const hasMalformed = state.malformed.length > 0;
      return {
        sourceKey: source.sourceKey,
        generation: source.generation,
        rows,
        header: {
          status: source.isLoading || source.meta?.isActive ? 'running' : hasMalformed ? 'error' : 'done'
        }
      };
    }
  };
}

/** The stable projector instance consumed by the expanded view and test fixtures. */
export const antigravitySessionProjector = createAntigravitySessionProjector();

/**
 * Converts one native event id and content hash into a collision-safe provider identity.
 * @param record - Parsed native destination record.
 * @returns Provider-qualified semantic event key.
 */
function recordKey(record: AntigravityRecord): string {
  return `${record.idx}/${record.hash}`;
}

/**
 * Builds source-scoped provenance before any semantic grouping or filtering.
 * @param source - Caller-owned source identity and generation.
 * @param event - Native record occurrence(s).
 * @param selector - Stable semantic leaf selector.
 * @param nativeEventId - Native Antigravity step index, when the line parsed as a record.
 * @returns All physical occurrences with the semantic selector attached.
 */
function origins(
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>,
  event: Pick<RecordEvent | MalformedEvent, 'provenance'>,
  selector: string,
  nativeEventId?: string
): NativeRecordProvenance[] {
  return event.provenance.map((origin) => ({
    ...origin,
    ...(nativeEventId === undefined ? {} : { nativeEventId }),
    selector,
    sourceKey: source.sourceKey,
    generation: source.generation
  }));
}

/**
 * Creates a typed anomaly row without presenting unknown-format payload bytes.
 * @param source - Source identity.
 * @param event - Native anomaly event.
 * @returns Structural row preserving the provider anomaly as a typed part.
 */
function anomalyRow(
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>,
  event: RecordEvent
): AntigravityRow {
  const { record } = event;
  const anomaly = record.anomaly!;
  const isSchemaDrift = record.idx === SCHEMA_DRIFT_SENTINEL_IDX;
  const kind = isSchemaDrift ? 'schema-drift' : anomaly.kind;
  const label = isSchemaDrift
    ? 'Host drift · schema changed'
    : anomaly.kind === 'host-drift'
      ? `Host drift · step ${record.idx}`
      : anomaly.kind === 'flush-partial'
        ? `Partial flush · step ${record.idx}`
        : `Unreadable content (format unknown) · step ${record.idx}`;
  const selector = `record/${recordKey(record)}`;
  const provenance = origins(source, event, 'anomaly', String(record.idx));
  const payload: AntigravityAnomalyPayload = {
    kind,
    ...(isSchemaDrift ? {} : { idx: record.idx, stepType: record.stepType, status: record.status }),
    detail: anomaly.detail,
    ...(anomaly.kind === 'format-unknown'
      ? { withheldBytes: new TextEncoder().encode(record.content).byteLength }
      : { content: record.content })
  };
  const partId = sessionIdentity(source, 'antigravity-part', `${selector}/anomaly`);
  return {
    id: sessionIdentity(source, 'antigravity-row', selector),
    semanticKey: selector,
    provenance: origins(source, event, 'row', String(record.idx)),
    kind: 'structural',
    label,
    tone: anomaly.kind === 'flush-partial' ? 'info' : 'error',
    anchor: 'none',
    parts: [
      {
        id: partId,
        semanticKey: selector,
        provenance,
        kind: 'provider',
        providerKind: 'anomaly',
        data: payload
      }
    ]
  };
}

/**
 * Parses the known Antigravity tool-invocation text shape without executing it.
 * @param text - Decoded source content.
 * @returns Name and JSON arguments only when the complete pinned shape is present.
 */
function parseToolInvocation(text: string): { name: string; args: unknown } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object['tool'] !== 'string' || !Object.hasOwn(object, 'arguments')) return undefined;
  return { name: object['tool'], args: object['arguments'] };
}

/**
 * Maps one Antigravity destination record to a native semantic row.
 * @param source - Source identity.
 * @param event - Dedupe-collated native event with all physical origins.
 * @returns Provider-specific row preserving supported structure and raw fallback.
 */
function recordRow(
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>,
  event: RecordEvent
): AntigravityRow {
  const { record } = event;
  if (record.anomaly) return anomalyRow(source, event);

  const semanticKey = recordKey(record);
  const selector = `record/${semanticKey}`;
  const rowId = sessionIdentity(source, 'antigravity-row', selector);
  const rowProvenance = origins(source, event, 'row', String(record.idx));

  if (record.stepType === 132) {
    const invocation = parseToolInvocation(record.content);
    if (invocation) {
      return {
        id: rowId,
        semanticKey,
        provenance: rowProvenance,
        kind: 'provider',
        providerKind: 'toolCall',
        anchor: 'none',
        data: {
          idx: record.idx,
          stepType: record.stepType,
          status: record.status,
          name: invocation.name,
          arguments: invocation.args
        },
        parts: []
      };
    }
  }

  if (record.stepType === 14 || record.stepType === 15) {
    const role = record.stepType === 14 ? 'user' : 'assistant';
    return {
      id: rowId,
      semanticKey,
      provenance: rowProvenance,
      kind: 'message',
      role,
      label: `${role === 'user' ? 'You' : 'Antigravity'} · step ${record.idx} · status ${record.status}`,
      anchor: role === 'user' || role === 'assistant' ? 'turn' : 'none',
      parts: [
        {
          id: sessionIdentity(source, 'antigravity-part', `${selector}/content`),
          semanticKey,
          provenance: origins(source, event, 'content', String(record.idx)),
          kind: 'text',
          text: record.content
        }
      ]
    };
  }

  return {
    id: rowId,
    semanticKey,
    provenance: rowProvenance,
    kind: 'structural',
    label: `Unsupported Antigravity step · type ${record.stepType} · step ${record.idx}`,
    tone: 'info',
    anchor: 'none',
    parts: [
      {
        id: sessionIdentity(source, 'antigravity-part', `${selector}/raw`),
        semanticKey,
        provenance: origins(source, event, 'raw', String(record.idx)),
        kind: 'raw',
        label: 'Raw Antigravity record',
        text: event.rawLine,
        reason: 'unknown'
      }
    ]
  };
}

/**
 * Keeps parser failures visible as bounded, inspectable native lines.
 * @param source - Source identity.
 * @param event - Malformed physical record.
 * @returns Error row retaining its complete source line and parser reason.
 */
function malformedRow(
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>,
  event: MalformedEvent
): AntigravityRow {
  const semanticKey = `malformed/${event.provenance[0]!.lineNumber}`;
  return {
    id: sessionIdentity(source, 'antigravity-row', semanticKey),
    semanticKey,
    provenance: origins(source, event, 'row'),
    kind: 'structural',
    label: `Malformed stream record (${event.reason})`,
    tone: 'error',
    anchor: 'none',
    parts: [
      {
        id: sessionIdentity(source, 'antigravity-part', `${semanticKey}/raw`),
        semanticKey,
        provenance: origins(source, event, 'raw'),
        kind: 'raw',
        label: 'Malformed Antigravity record',
        text: event.rawLine,
        reason: 'malformed'
      }
    ]
  };
}

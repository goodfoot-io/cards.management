/**
 * OpenCode native envelopes reduce into Cards-owned rows before visual grouping.
 * Message and part identities come from native IDs where possible; physical records keep provenance.
 * @summary OpenCode incremental native transcript projection
 * @module streams/opencode-session/www/lib/project-session
 */

import {
  type NativeTranscriptProjector,
  type NativeTranscriptRecord,
  sessionIdentity
} from '../../../lib/session/projection';
import type {
  NativeRecordProvenance,
  NativeTranscriptSource,
  SessionHeaderFacts,
  SessionPart,
  SessionProviderPart,
  SessionProviderRow,
  SessionRawPart,
  SessionRow,
  SessionTextPart,
  SessionToolPart
} from '../../../lib/session/types';
import { appendOpencodeNativeUpdate, type OpencodeNativeUpdates } from './native-updates';
import type { OpencodePart as NativeOpencodePart, OpencodeLine, OpencodeMessageInfo } from './parser';
import { parseOpencodeLine } from './parser';
import { formatToolValuePreview, toolPartIdentity } from './tool-part';

/** Maximum pretty-printed native tool value retained in its primary disclosure. */
const MAX_INLINE_TOOL_VALUE_TEXT = 65_536;
const LARGE_TOOL_VALUE_SUMMARY = 'Structured value exceeds the inline preview; open native details';

/** Native session identity and exporter facts kept outside conversation prose. */
export interface OpencodeSessionData {
  readonly sessionId?: string;
  readonly runtime?: string;
  readonly version?: string;
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** Message info retained for model, path, timing, token, agent, and mode details. */
export interface OpencodeMessageDetailsData {
  readonly messageId: string;
  readonly role: string;
  readonly model?: string;
  readonly provider?: string;
  readonly agent?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly created?: number;
  readonly completed?: number;
  readonly tokens?: { readonly input?: number; readonly output?: number };
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** OpenCode `file` part summary; its native URL is retained but never activated. */
export interface OpencodeAttachmentData {
  readonly filename: string;
  readonly mime?: string;
  readonly url?: string;
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** OpenCode `patch` part summary; full native details remain inspectable separately. */
export interface OpencodeEditedFilesData {
  readonly files: readonly string[];
  readonly hash?: string;
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** Visible boundary marker for OpenCode model steps. */
export interface OpencodeStepData {
  readonly type: 'step-start' | 'step-finish';
  readonly label: string;
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** Inspectable native event or part that this renderer does not yet interpret. */
export interface OpencodeEventData {
  readonly label: string;
  readonly tone: 'info' | 'error';
  readonly nativeType?: string;
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** Raw details for one semantic part, retained as immutable source-line references. */
export interface OpencodeNativeDetailsData {
  readonly label: string;
  readonly nativeUpdates: OpencodeNativeUpdates;
}

/** Typed OpenCode presentation payloads; no assistant-ui or vendor message types. */
export interface OpencodePayloads {
  readonly session: OpencodeSessionData;
  readonly messageDetails: OpencodeMessageDetailsData;
  readonly attachment: OpencodeAttachmentData;
  readonly editedFiles: OpencodeEditedFilesData;
  readonly step: OpencodeStepData;
  readonly event: OpencodeEventData;
  readonly nativeDetails: OpencodeNativeDetailsData;
}

/** Cards-owned OpenCode rows and shared/provider parts. */
export type OpencodeRow = SessionRow<OpencodePayloads>;

/** Cards-owned OpenCode semantic leaves. */
export type OpencodeSessionPart = SessionPart<OpencodePayloads>;

/** Minimum caller-owned fields needed to scope semantic identities. */
type OpencodeSourceIdentity = Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>;

interface MessageInfoState {
  value: OpencodeMessageInfo;
  nativeUpdates: OpencodeNativeUpdates;
  provenance: NativeRecordProvenance[];
  revision: number;
  projectedRevision: number;
  projectedPart?: SessionProviderPart<OpencodePayloads>;
}

interface PartState {
  readonly key: string;
  readonly selector: string;
  readonly firstLine: number;
  value: NativeOpencodePart;
  nativeUpdates: OpencodeNativeUpdates;
  provenance: NativeRecordProvenance[];
  revision: number;
  projectedRevision: number;
  projectedParts?: readonly OpencodeSessionPart[];
  toolValuePreviews?: Partial<Record<'input' | 'result', { readonly source: string; readonly summary: string }>>;
}

interface MessageState {
  readonly key: string;
  readonly selector: string;
  readonly nativeId?: string;
  role: 'user' | 'assistant' | 'developer';
  firstLine: number;
  info?: MessageInfoState;
  parts: Map<string, PartState>;
  partOrder: string[];
  revision: number;
  projectedRevision: number;
  projectedRow?: OpencodeRow;
}

interface SessionState {
  readonly firstLine: number;
  value: OpencodeSessionData;
  provenance: NativeRecordProvenance[];
  revision: number;
  projectedRevision: number;
  projectedRow?: OpencodeRow;
}

interface EventState {
  readonly firstLine: number;
  readonly order: number;
  readonly row: OpencodeRow;
}

interface OpencodeState {
  session?: SessionState;
  messages: Map<string, MessageState>;
  events: EventState[];
  idle: boolean;
  nextOrder: number;
}

/** Creates an OpenCode event id where the normalized envelope or native record supplies one.
 * @param line - Parsed native line.
 * @returns Native event identifier when the envelope or payload provides one.
 */
function nativeEventId(line: OpencodeLine): string | undefined {
  switch (line.kind) {
    case 'message':
      return typeof line.data.id === 'string' ? line.data.id : line.seq > 0 ? String(line.seq) : undefined;
    case 'part':
      return typeof line.data.id === 'string' ? line.data.id : line.seq > 0 ? String(line.seq) : undefined;
    case 'meta':
    case 'idle':
      return line.seq > 0 ? String(line.seq) : undefined;
    case 'unknown': {
      const id = line.raw['id'];
      const seq = line.raw['seq'];
      return typeof id === 'string' ? id : typeof seq === 'number' ? String(seq) : undefined;
    }
    case 'malformed':
      return undefined;
  }
}

/** Selects a native message/part identity before any display filtering or grouping.
 * @param line - Parsed native line.
 * @param lineNumber - Absolute source coordinate for line-scoped fallbacks.
 * @returns Provider-qualified selector derived from native identity or physical provenance.
 */
function nativeSelector(line: OpencodeLine, lineNumber: number): string {
  switch (line.kind) {
    case 'meta':
      return 'session/meta';
    case 'message':
      return typeof line.data.id === 'string' ? `message/${line.data.id}` : `message-line/${lineNumber}`;
    case 'part': {
      const messageId = typeof line.data['messageID'] === 'string' ? line.data['messageID'] : '';
      const callId = line.data.type === 'tool' && typeof line.data.callID === 'string' ? line.data.callID : '';
      const partId = typeof line.data.id === 'string' ? line.data.id : '';
      if (callId.length > 0) return `tool/${messageId}/${callId}`;
      return partId.length > 0 ? `part/${messageId}/${partId}` : `part-line/${lineNumber}`;
    }
    case 'idle':
      return `idle/${line.seq > 0 ? line.seq : lineNumber}`;
    case 'unknown':
      return `event/${lineNumber}`;
    case 'malformed':
      return `malformed/${lineNumber}`;
  }
}

/** Replaces the shared cache's generic record selector with native OpenCode provenance.
 * @param line - Parsed OpenCode line.
 * @param record - Physical source record and shared provenance.
 * @returns OpenCode provenance retaining source coordinates and native identity.
 */
function provenanceFor(line: OpencodeLine, record: NativeTranscriptRecord): NativeRecordProvenance {
  return {
    sourceKey: record.provenance.sourceKey,
    generation: record.provenance.generation,
    lineNumber: record.provenance.lineNumber,
    nativeEventId: nativeEventId(line),
    selector: nativeSelector(line, record.provenance.lineNumber)
  };
}

/** Narrows parsed JSON values before reading provider-specific nested fields.
 * @param value - Untrusted decoded JSON value.
 * @returns Whether the value is a non-array record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Skips JSON whitespace from a starting offset.
 * @param source - Original native JSONL line.
 * @param offset - Current source offset.
 * @returns First non-whitespace offset.
 */
function skipJsonWhitespace(source: string, offset: number): number {
  while (
    offset < source.length &&
    (source[offset] === ' ' || source[offset] === '\n' || source[offset] === '\r' || source[offset] === '\t')
  ) {
    offset++;
  }
  return offset;
}

/** Finds the end of a JSON string without decoding or copying its contents.
 * @param source - Original native JSONL line.
 * @param start - Opening quote offset.
 * @param maximumEnd - Scan bound that prevents oversized payload walks.
 * @returns Exclusive string end, or undefined when it exceeds the bound.
 */
function jsonStringEnd(source: string, start: number, maximumEnd: number): number | undefined {
  for (let offset = start + 1; offset < source.length && offset < maximumEnd; offset++) {
    if (source[offset] === '\\') {
      offset++;
    } else if (source[offset] === '"') {
      return offset + 1;
    }
  }
  return undefined;
}

/** Finds a JSON value end while stopping as soon as the preview bound is crossed.
 * @param source - Original native JSONL line.
 * @param start - First value character.
 * @param limit - Maximum number of source characters to inspect.
 * @returns Exclusive value end, or undefined when the source value is oversized.
 */
function jsonValueEnd(source: string, start: number, limit: number): number | undefined {
  const maximumEnd = Math.min(source.length, start + limit);
  const first = source[start];
  if (first === '"') return jsonStringEnd(source, start, maximumEnd);
  if (first !== '{' && first !== '[') {
    for (let offset = start; offset < maximumEnd; offset++) {
      const character = source[offset];
      if (
        character === ',' ||
        character === '}' ||
        character === ']' ||
        character === ' ' ||
        character === '\n' ||
        character === '\r' ||
        character === '\t'
      ) {
        return offset;
      }
    }
    return undefined;
  }

  const stack: string[] = [first === '{' ? '}' : ']'];
  for (let offset = start + 1; offset < maximumEnd; offset++) {
    const character = source[offset];
    if (character === '"') {
      const end = jsonStringEnd(source, offset, maximumEnd);
      if (end === undefined) return undefined;
      offset = end - 1;
    } else if (character === '{') {
      stack.push('}');
    } else if (character === '[') {
      stack.push(']');
    } else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return undefined;
      if (stack.length === 0) return offset + 1;
    }
  }
  return undefined;
}

/** Locates one plain JSON property without decoding its value.
 * @param source - Original native JSONL line.
 * @param objectStart - Opening brace offset.
 * @param property - Canonical property name emitted by the OpenCode writer.
 * @param limit - Maximum source characters inspected for a value.
 * @param includeEnd - Whether to scan the target value to find its exclusive end.
 * @returns Bounded property value span, `null` for an oversized value, or undefined when absent.
 */
function jsonObjectPropertySpan(
  source: string,
  objectStart: number,
  property: string,
  limit: number,
  includeEnd = true
): { readonly start: number; readonly end: number } | null | undefined {
  if (source[objectStart] !== '{') return undefined;
  let offset = objectStart + 1;
  while (offset < source.length) {
    offset = skipJsonWhitespace(source, offset);
    if (source[offset] === '}') return undefined;
    if (source[offset] !== '"') return undefined;
    const keyEnd = jsonStringEnd(source, offset, Math.min(source.length, offset + 256));
    if (keyEnd === undefined) return undefined;
    const keyMatches = source.slice(offset, keyEnd) === JSON.stringify(property);
    offset = skipJsonWhitespace(source, keyEnd);
    if (source[offset] !== ':') return undefined;
    const valueStart = skipJsonWhitespace(source, offset + 1);
    if (keyMatches && !includeEnd) return { start: valueStart, end: valueStart };
    const valueEnd = jsonValueEnd(source, valueStart, keyMatches ? limit : source.length);
    if (keyMatches) return valueEnd === undefined ? null : { start: valueStart, end: valueEnd };
    if (valueEnd === undefined) return undefined;
    offset = skipJsonWhitespace(source, valueEnd);
    if (source[offset] === ',') offset++;
    else if (source[offset] !== '}') return undefined;
  }
  return undefined;
}

/** Finds a bounded native input/result span inside one OpenCode part update.
 * @param source - Original native JSONL line.
 * @param slot - Tool value field to locate.
 * @returns Small source text, a large-value marker, or undefined when absent.
 */
function toolValueSourceText(
  source: string,
  slot: 'input' | 'result'
): { readonly kind: 'small'; readonly source: string } | { readonly kind: 'large' } | undefined {
  const rootData = jsonObjectPropertySpan(source, 0, 'data', source.length, false);
  if (!rootData || rootData === null) return undefined;
  const dataState = jsonObjectPropertySpan(source, rootData.start, 'state', source.length, false);
  if (!dataState || dataState === null) return undefined;
  const value = jsonObjectPropertySpan(source, dataState.start, slot, MAX_INLINE_TOOL_VALUE_TEXT);
  if (value === null) return { kind: 'large' };
  return value ? { kind: 'small', source: source.slice(value.start, value.end) } : undefined;
}

/** Keeps small values visible and directs oversized structured values to native disclosures.
 * @param entry - Reduced native tool part and its source-backed updates.
 * @param slot - Tool value cache slot.
 * @param value - Native value to display.
 * @returns Bounded summary or an empty string for absent values.
 */
function toolValueSummary(entry: PartState, slot: 'input' | 'result', value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const source = toolValueSourceText(entry.nativeUpdates.line, slot);
    if (source?.kind === 'large') return LARGE_TOOL_VALUE_SUMMARY;
    const cached = entry.toolValuePreviews?.[slot];
    if (source?.kind === 'small' && cached?.source === source.source) return cached.summary;
    const preview = formatToolValuePreview(value, MAX_INLINE_TOOL_VALUE_TEXT);
    const summary = `${preview.text}${preview.truncated ? '…' : ''}`;
    if (source?.kind === 'small') {
      entry.toolValuePreviews = { ...entry.toolValuePreviews, [slot]: { source: source.source, summary } };
    }
    return summary;
  }
  return String(value);
}

/** Reads a model/provider identity from either OpenCode's flat or nested user-message shape.
 * @param info - Native OpenCode message info.
 * @returns Model and provider identifiers when present.
 */
function messageModel(info: OpencodeMessageInfo): { model?: string; provider?: string } {
  const model = typeof info.modelID === 'string' ? info.modelID : info.model?.modelID;
  const provider = typeof info.providerID === 'string' ? info.providerID : info.model?.providerID;
  return {
    model: typeof model === 'string' ? model : undefined,
    provider: typeof provider === 'string' ? provider : undefined
  };
}

/** Appends physical occurrences without erasing the first semantic part identity.
 * @param target - Source occurrence list owned by one semantic record.
 * @param provenance - New physical occurrence to retain.
 */
function appendOccurrence(target: NativeRecordProvenance[], provenance: NativeRecordProvenance): void {
  target.push(provenance);
}

/** Creates a provider row for a root event whose native payload has no message owner.
 * @param source - Caller-qualified source identity.
 * @param label - Visible structural event label.
 * @param tone - Shared structural severity or boundary tone.
 * @param selector - Stable native or physical event selector.
 * @param raw - Original JSONL event text.
 * @param provenance - Physical event occurrence.
 * @param reason - Shared raw-detail classification.
 * @returns Structural row with a bounded native-detail leaf.
 */
function eventRow(
  source: OpencodeSourceIdentity,
  label: string,
  tone: 'info' | 'error' | 'boundary',
  selector: string,
  raw: string,
  provenance: NativeRecordProvenance[],
  reason: SessionRawPart['reason']
): OpencodeRow {
  return {
    id: sessionIdentity(source, 'opencode-event-row', selector),
    semanticKey: `opencode/event/${selector}`,
    provenance,
    kind: 'structural',
    label,
    tone,
    anchor: 'none',
    parts: [
      {
        id: sessionIdentity(source, 'opencode-event-detail', selector),
        semanticKey: `opencode/event-detail/${selector}`,
        provenance,
        kind: 'raw',
        label: 'Native event details',
        text: raw,
        reason
      }
    ]
  };
}

/** Creates or finds the source-local message group for a native part.
 * @param state - Source-local OpenCode reducer state.
 * @param nativeId - Native message identity when available.
 * @param partSelector - Stable fallback selector for orphaned parts.
 * @param lineNumber - Absolute coordinate of the first encountered record.
 * @returns Mutable source-local message state.
 */
function ensureMessage(state: OpencodeState, nativeId: string, partSelector: string, lineNumber: number): MessageState {
  const key = nativeId.length > 0 ? JSON.stringify(['message', nativeId]) : JSON.stringify(['orphan', partSelector]);
  const previous = state.messages.get(key);
  if (previous) {
    previous.firstLine = Math.min(previous.firstLine, lineNumber);
    return previous;
  }
  const selector = nativeId.length > 0 ? `message/${nativeId}` : `orphan/${partSelector}`;
  const message: MessageState = {
    key,
    selector,
    nativeId: nativeId || undefined,
    role: 'assistant',
    firstLine: lineNumber,
    parts: new Map(),
    partOrder: [],
    revision: 0,
    projectedRevision: -1
  };
  state.messages.set(key, message);
  return message;
}

/** Adds an inspectable native event as a provider-owned leaf inside its message row.
 * @param source - Caller-qualified source identity.
 * @param selector - Stable native or physical part selector.
 * @param label - Visible event label.
 * @param nativeUpdates - Source-backed native updates contributing to the semantic event.
 * @param provenance - Physical occurrences contributing to the event.
 * @param tone - Event presentation severity.
 * @param nativeType - Native event discriminator when available.
 * @returns Typed OpenCode event leaf.
 */
function providerEventPart(
  source: OpencodeSourceIdentity,
  selector: string,
  label: string,
  nativeUpdates: OpencodeNativeUpdates,
  provenance: NativeRecordProvenance[],
  tone: 'info' | 'error' = 'info',
  nativeType?: string
): SessionProviderPart<OpencodePayloads> {
  return {
    id: sessionIdentity(source, 'opencode-event-part', selector),
    semanticKey: `opencode/event/${selector}`,
    provenance,
    kind: 'provider',
    providerKind: 'event',
    data: { label, tone, nativeType, nativeUpdates }
  };
}

/** Projects source-backed native updates into a typed OpenCode details disclosure.
 * @param source - Caller-qualified source identity.
 * @param entry - Reduced native part and all its source occurrences.
 * @param label - Visible disclosure label.
 * @param suffix - Distinguishes additional raw detail views under one semantic part.
 * @returns Typed OpenCode raw-details leaf.
 */
function nativeDetailsPart(
  source: OpencodeSourceIdentity,
  entry: PartState,
  label: string,
  suffix = 'native-details'
): SessionProviderPart<OpencodePayloads> {
  return {
    id: sessionIdentity(source, 'opencode-native-details', `${entry.selector}/${suffix}`),
    semanticKey: `opencode/native-details/${entry.selector}/${suffix}`,
    provenance: entry.provenance,
    kind: 'provider',
    providerKind: 'nativeDetails',
    data: { label, nativeUpdates: entry.nativeUpdates }
  };
}

/** Maps one native part identity into shared or typed OpenCode semantic leaves.
 * @param source - Caller-qualified source identity.
 * @param entry - Reduced native part and its physical occurrences.
 * @returns Shared text/tool leaves or typed OpenCode provider leaves.
 */
function projectPart(source: OpencodeSourceIdentity, entry: PartState): readonly OpencodeSessionPart[] {
  if (entry.projectedRevision === entry.revision && entry.projectedParts) return entry.projectedParts;
  const native = entry.value;
  const provenance = entry.provenance;
  const base = {
    id: sessionIdentity(source, 'opencode-part', entry.selector),
    semanticKey: `opencode/${entry.selector}`,
    provenance
  };
  let result: readonly OpencodeSessionPart[];

  switch (native.type) {
    case 'text':
    case 'reasoning': {
      if (typeof native.text !== 'string') {
        result = [
          providerEventPart(
            source,
            entry.selector,
            `Malformed OpenCode ${native.type} part`,
            entry.nativeUpdates,
            provenance,
            'error',
            native.type
          )
        ];
        break;
      }
      const textPart: SessionTextPart = {
        ...base,
        kind: native.type,
        text: native.text
      };
      result = [textPart, nativeDetailsPart(source, entry, `OpenCode ${native.type} part details`)];
      break;
    }

    case 'tool': {
      const identity = toolPartIdentity(native);
      const state = isRecord(native.state) ? native.state : {};
      const nativeStatus = state['status'];
      const status: SessionToolPart['status'] =
        nativeStatus === 'pending'
          ? 'pending'
          : nativeStatus === 'running'
            ? 'running'
            : nativeStatus === 'completed'
              ? 'complete'
              : nativeStatus === 'error'
                ? 'error'
                : 'orphan';
      const error = state['error'];
      const errorText =
        typeof error === 'string'
          ? error
          : isRecord(error) && typeof error['message'] === 'string'
            ? error['message']
            : '';
      const resultValue = state['result'] !== undefined ? state['result'] : state['output'];
      const outputParts = [errorText, toolValueSummary(entry, 'result', resultValue)].filter(
        (value) => value.length > 0
      );
      const tool: SessionToolPart = {
        ...base,
        semanticKey: `opencode/tool/${entry.selector}`,
        kind: 'tool',
        callId: identity.callId || entry.selector,
        name: identity.name,
        input: toolValueSummary(entry, 'input', state['input']),
        output: outputParts.length > 0 ? outputParts.join('\n') : undefined,
        status
      };
      result = [tool, nativeDetailsPart(source, entry, 'OpenCode tool event details')];
      break;
    }

    case 'patch': {
      if (
        !Array.isArray(native.files) ||
        native.files.length === 0 ||
        !native.files.every((file): file is string => typeof file === 'string')
      ) {
        result = [
          providerEventPart(
            source,
            entry.selector,
            'Malformed OpenCode patch part',
            entry.nativeUpdates,
            provenance,
            'error',
            'patch'
          )
        ];
        break;
      }
      result = [
        {
          ...base,
          kind: 'provider',
          providerKind: 'editedFiles',
          data: {
            files: native.files,
            hash: typeof native.hash === 'string' ? native.hash : undefined,
            nativeUpdates: entry.nativeUpdates
          }
        }
      ];
      break;
    }

    case 'file': {
      if (typeof native.filename !== 'string' || native.filename.length === 0) {
        result = [
          providerEventPart(
            source,
            entry.selector,
            'Malformed OpenCode file part',
            entry.nativeUpdates,
            provenance,
            'error',
            'file'
          )
        ];
        break;
      }
      result = [
        {
          ...base,
          kind: 'provider',
          providerKind: 'attachment',
          data: {
            filename: native.filename,
            mime: typeof native.mime === 'string' ? native.mime : undefined,
            url: typeof native.url === 'string' ? native.url : undefined,
            nativeUpdates: entry.nativeUpdates
          }
        }
      ];
      break;
    }

    case 'step-start':
    case 'step-finish': {
      const label = native.type === 'step-start' ? 'Model step started' : 'Model step finished';
      result = [
        {
          ...base,
          kind: 'provider',
          providerKind: 'step',
          data: { type: native.type, label, nativeUpdates: entry.nativeUpdates }
        }
      ];
      break;
    }

    default:
      result = [
        providerEventPart(
          source,
          entry.selector,
          `Unsupported OpenCode part (${typeof native.type === 'string' ? native.type : 'unknown'})`,
          entry.nativeUpdates,
          provenance,
          'info',
          typeof native.type === 'string' ? native.type : undefined
        )
      ];
      break;
  }

  entry.projectedRevision = entry.revision;
  entry.projectedParts = result;
  return result;
}

/** Projects a native message info record into a typed part without losing its physical updates.
 * @param source - Caller-qualified source identity.
 * @param message - Reduced native message and info occurrences.
 * @returns Typed metadata leaf, when the message has an info record.
 */
function projectMessageInfo(
  source: OpencodeSourceIdentity,
  message: MessageState
): SessionProviderPart<OpencodePayloads> | undefined {
  const info = message.info;
  if (!info) return undefined;
  if (info.projectedRevision === info.revision && info.projectedPart) return info.projectedPart;
  const model = messageModel(info.value);
  const nativeTime = info.value.time;
  const part: SessionProviderPart<OpencodePayloads> = {
    id: sessionIdentity(source, 'opencode-message-details', message.selector),
    semanticKey: `opencode/message/${message.selector}`,
    provenance: info.provenance,
    kind: 'provider',
    providerKind: 'messageDetails',
    data: {
      messageId: message.nativeId ?? message.selector,
      role: typeof info.value.role === 'string' ? info.value.role : message.role,
      model: model.model,
      provider: model.provider,
      agent: typeof info.value.agent === 'string' ? info.value.agent : undefined,
      mode: typeof info.value.mode === 'string' ? info.value.mode : undefined,
      cwd: typeof info.value.path?.cwd === 'string' ? info.value.path.cwd : undefined,
      created: typeof nativeTime?.created === 'number' ? nativeTime.created : undefined,
      completed: typeof nativeTime?.completed === 'number' ? nativeTime.completed : undefined,
      tokens: info.value.tokens,
      nativeUpdates: info.nativeUpdates
    }
  };
  info.projectedRevision = info.revision;
  info.projectedPart = part;
  return part;
}

/** Builds a message row while preserving unchanged native leaves across appends.
 * @param source - Caller-qualified source identity.
 * @param message - Reduced native message state.
 * @returns Cards-owned semantic row for this native message.
 */
function projectMessage(source: OpencodeSourceIdentity, message: MessageState): OpencodeRow {
  if (message.projectedRevision === message.revision && message.projectedRow) return message.projectedRow;
  const provenance = [
    ...(message.info?.provenance ?? []),
    ...message.partOrder.flatMap((key) => message.parts.get(key)?.provenance ?? [])
  ].sort((left, right) => left.lineNumber - right.lineNumber);
  const info = projectMessageInfo(source, message);
  const content = message.partOrder.flatMap((key) => {
    const part = message.parts.get(key);
    return part ? projectPart(source, part) : [];
  });
  const row: OpencodeRow = {
    id: sessionIdentity(source, 'opencode-message-row', message.selector),
    semanticKey: `opencode/message-row/${message.selector}`,
    provenance,
    kind: 'message',
    role: message.role,
    anchor: message.role === 'user' ? 'turn' : 'none',
    parts: [...(info ? [info] : []), ...content]
  };
  message.projectedRevision = message.revision;
  message.projectedRow = row;
  return row;
}

/** Projects the merged metadata record into one stable provider row.
 * @param source - Caller-qualified source identity.
 * @param session - Reduced metadata record and physical occurrences.
 * @returns Typed Cards-owned session row.
 */
function projectSession(source: OpencodeSourceIdentity, session: SessionState): OpencodeRow {
  if (session.projectedRevision === session.revision && session.projectedRow) return session.projectedRow;
  const row: SessionProviderRow<OpencodePayloads> = {
    id: sessionIdentity(source, 'opencode-session', 'meta'),
    semanticKey: 'opencode/session/meta',
    provenance: session.provenance,
    kind: 'provider',
    providerKind: 'session',
    data: session.value,
    anchor: 'none',
    parts: []
  };
  session.projectedRevision = session.revision;
  session.projectedRow = row;
  return row;
}

/** Selects the first available model/path and computes lifecycle from native idle/tool state.
 * @param state - Source-local OpenCode reducer state.
 * @param source - Current native source metadata, including liveness and sidecar facts.
 * @returns Provider-neutral sticky header facts.
 */
function projectHeader(state: OpencodeState, source: NativeTranscriptSource): SessionHeaderFacts {
  const ordered = [...state.messages.values()].sort((left, right) => left.firstLine - right.firstLine);
  let model: string | undefined;
  let cwd: string | undefined;
  for (const message of ordered) {
    if (!message.info) continue;
    const identity = messageModel(message.info.value);
    if (model === undefined) model = identity.model;
    if (cwd === undefined && typeof message.info.value.path?.cwd === 'string') cwd = message.info.value.path.cwd;
    if (model !== undefined && cwd !== undefined) break;
  }
  const hasToolError = ordered.some((message) =>
    message.partOrder.some((key) => {
      const part = message.parts.get(key);
      return part?.value.type === 'tool' && part.value.state?.status === 'error';
    })
  );
  return {
    model,
    cwd,
    status: hasToolError ? 'error' : source.meta?.isActive && !state.idle ? 'running' : 'done',
    agentId: source.meta?.role === 'subagent' || source.meta?.role === 'auxiliary' ? source.meta.agentId : undefined,
    title: source.meta?.title
  };
}

/** Adds one raw provider event row in native source order.
 * @param state - Source-local OpenCode reducer state.
 * @param source - Caller-qualified source identity.
 * @param lineNumber - Absolute coordinate of the event.
 * @param provenance - Native and physical event identity.
 * @param label - Visible structural event label.
 * @param tone - Structural severity or boundary tone.
 * @param raw - Original event JSONL record.
 * @param reason - Shared raw-detail classification.
 */
function pushEvent(
  state: OpencodeState,
  source: OpencodeSourceIdentity,
  lineNumber: number,
  provenance: NativeRecordProvenance,
  label: string,
  tone: 'info' | 'error' | 'boundary',
  raw: string,
  reason: SessionRawPart['reason']
): void {
  const row = eventRow(source, label, tone, provenance.selector, raw, [provenance], reason);
  state.events.push({ firstLine: lineNumber, order: state.nextOrder++, row });
}

/** Parses malformed known part shapes without turning them into silently discarded records.
 * @param state - Source-local OpenCode reducer state.
 * @param source - Caller-qualified source identity.
 * @param line - Parsed malformed native part envelope.
 * @param record - Physical source record retaining original JSONL text.
 * @param provenance - Native and physical event identity.
 * @param label - Visible malformed-part label.
 * @param nativeType - Expected part discriminator, when known.
 */
function appendMalformedPart(
  state: OpencodeState,
  source: OpencodeSourceIdentity,
  line: OpencodeLine,
  record: NativeTranscriptRecord,
  provenance: NativeRecordProvenance,
  label: string,
  nativeType?: string
): void {
  const rawMessageId = line.kind === 'part' && typeof line.data['messageID'] === 'string' ? line.data['messageID'] : '';
  if (rawMessageId.length === 0) {
    pushEvent(state, source, provenance.lineNumber, provenance, label, 'error', record.text, 'malformed');
    return;
  }
  const message = ensureMessage(state, rawMessageId, provenance.selector, provenance.lineNumber);
  const key = `invalid/${provenance.selector}/${provenance.lineNumber}`;
  const nativeUpdates = appendOpencodeNativeUpdate(undefined, record.text, provenance.lineNumber);
  const invalid: PartState = {
    key,
    selector: key,
    firstLine: provenance.lineNumber,
    value: { type: nativeType ?? 'malformed' },
    nativeUpdates,
    provenance: [provenance],
    revision: 1,
    projectedRevision: -1,
    projectedParts: [providerEventPart(source, key, label, nativeUpdates, [provenance], 'error', nativeType)]
  };
  message.parts.set(key, invalid);
  message.partOrder.push(key);
  message.revision++;
}

/** Adds or replaces one stable native part while keeping every physical update inspectable.
 * @param state - Source-local OpenCode reducer state.
 * @param source - Caller-qualified source identity.
 * @param line - Parsed native part envelope.
 * @param record - Physical source record retaining original JSONL text.
 * @param provenance - Native and physical event identity.
 */
function reducePart(
  state: OpencodeState,
  source: OpencodeSourceIdentity,
  line: Extract<OpencodeLine, { kind: 'part' }>,
  record: NativeTranscriptRecord,
  provenance: NativeRecordProvenance
): void {
  const data = line.data as unknown;
  if (!isRecord(data) || typeof data['type'] !== 'string') {
    appendMalformedPart(state, source, line, record, provenance, 'Malformed OpenCode part');
    return;
  }
  const native = data as NativeOpencodePart;
  const messageId = typeof native['messageID'] === 'string' ? native['messageID'] : '';
  const selector = provenance.selector;
  const partKey = selector;
  const message = ensureMessage(state, messageId, partKey, provenance.lineNumber);
  const previous = message.parts.get(partKey);
  if (previous && previous.value.type !== native.type) {
    const conflictKey = `conflict/${partKey}/${provenance.lineNumber}`;
    const nativeUpdates = appendOpencodeNativeUpdate(undefined, record.text, provenance.lineNumber);
    const conflict: PartState = {
      key: conflictKey,
      selector: conflictKey,
      firstLine: provenance.lineNumber,
      value: { type: 'conflicting-id' },
      nativeUpdates,
      provenance: [provenance],
      revision: 1,
      projectedRevision: 1,
      projectedParts: [
        providerEventPart(
          source,
          conflictKey,
          `Conflicting OpenCode part identity (${native.type})`,
          nativeUpdates,
          [provenance],
          'error',
          native.type
        )
      ]
    };
    message.parts.set(conflictKey, conflict);
    message.partOrder.push(conflictKey);
    message.revision++;
    return;
  }
  if (previous) {
    previous.value = native;
    previous.nativeUpdates = appendOpencodeNativeUpdate(previous.nativeUpdates, record.text, provenance.lineNumber);
    appendOccurrence(previous.provenance, provenance);
    previous.revision++;
  } else {
    const part: PartState = {
      key: partKey,
      selector,
      firstLine: provenance.lineNumber,
      value: native,
      nativeUpdates: appendOpencodeNativeUpdate(undefined, record.text, provenance.lineNumber),
      provenance: [provenance],
      revision: 1,
      projectedRevision: -1
    };
    message.parts.set(partKey, part);
    message.partOrder.push(partKey);
  }
  message.revision++;
}

/** Creates or updates a source-local message record and its accumulated native details.
 * @param state - Source-local OpenCode reducer state.
 * @param source - Caller-qualified source identity.
 * @param line - Parsed native message envelope.
 * @param record - Physical source record retaining original JSONL text.
 * @param provenance - Native and physical event identity.
 */
function reduceMessage(
  state: OpencodeState,
  source: OpencodeSourceIdentity,
  line: Extract<OpencodeLine, { kind: 'message' }>,
  record: NativeTranscriptRecord,
  provenance: NativeRecordProvenance
): void {
  const data = line.data as unknown;
  if (!isRecord(data) || typeof data['id'] !== 'string' || typeof data['role'] !== 'string') {
    pushEvent(
      state,
      source,
      provenance.lineNumber,
      provenance,
      'Malformed OpenCode message record',
      'error',
      record.text,
      'malformed'
    );
    return;
  }
  const nativeId = data['id'];
  const role = data['role'];
  if (role !== 'user' && role !== 'assistant' && role !== 'developer') {
    pushEvent(
      state,
      source,
      provenance.lineNumber,
      provenance,
      `Unsupported OpenCode message role (${role})`,
      'info',
      record.text,
      'unknown'
    );
    return;
  }
  const message = ensureMessage(state, nativeId, provenance.selector, provenance.lineNumber);
  if (message.info && message.role !== role) {
    pushEvent(
      state,
      source,
      provenance.lineNumber,
      provenance,
      `Conflicting OpenCode message identity (${nativeId})`,
      'error',
      record.text,
      'conflicting-id'
    );
    return;
  }
  message.role = role;
  message.firstLine = Math.min(message.firstLine, provenance.lineNumber);
  if (message.info) {
    message.info.value = data as OpencodeMessageInfo;
    message.info.nativeUpdates = appendOpencodeNativeUpdate(
      message.info.nativeUpdates,
      record.text,
      provenance.lineNumber
    );
    appendOccurrence(message.info.provenance, provenance);
    message.info.revision++;
  } else {
    message.info = {
      value: data as OpencodeMessageInfo,
      nativeUpdates: appendOpencodeNativeUpdate(undefined, record.text, provenance.lineNumber),
      provenance: [provenance],
      revision: 1,
      projectedRevision: -1
    };
  }
  message.revision++;
  state.idle = false;
}

/** Merges session metadata while retaining one stable row and all native meta occurrences.
 * @param state - Source-local OpenCode reducer state.
 * @param source - Caller-qualified source identity.
 * @param line - Parsed native metadata envelope.
 * @param record - Physical source record retaining original JSONL text.
 * @param provenance - Native and physical event identity.
 */
function reduceMeta(
  state: OpencodeState,
  source: OpencodeSourceIdentity,
  line: Extract<OpencodeLine, { kind: 'meta' }>,
  record: NativeTranscriptRecord,
  provenance: NativeRecordProvenance
): void {
  const data = line.data as unknown;
  if (!isRecord(data)) {
    pushEvent(
      state,
      source,
      provenance.lineNumber,
      provenance,
      'Malformed OpenCode session metadata',
      'error',
      record.text,
      'malformed'
    );
    return;
  }
  const previous = state.session;
  const sessionId = line.sessionId || (typeof data['sessionId'] === 'string' ? data['sessionId'] : undefined);
  const sessionData: OpencodeSessionData = {
    sessionId: sessionId ?? previous?.value.sessionId,
    runtime: typeof data['runtime'] === 'string' ? data['runtime'] : previous?.value.runtime,
    version: typeof data['opencodeVersion'] === 'string' ? data['opencodeVersion'] : previous?.value.version,
    nativeUpdates: appendOpencodeNativeUpdate(previous?.value.nativeUpdates, record.text, provenance.lineNumber)
  };
  if (previous) {
    previous.value = sessionData;
    appendOccurrence(previous.provenance, provenance);
    previous.revision++;
  } else {
    state.session = {
      firstLine: provenance.lineNumber,
      value: sessionData,
      provenance: [provenance],
      revision: 1,
      projectedRevision: -1
    };
  }
}

/** Reduces one complete native record while preserving malformed and future content.
 * @param state - Source-local OpenCode reducer state.
 * @param line - Parsed native line using OpenCode's parser path.
 * @param record - Physical source record and its absolute provenance.
 */
function reduceRecord(state: OpencodeState, line: OpencodeLine, record: NativeTranscriptRecord): void {
  const source: OpencodeSourceIdentity = {
    sourceKey: record.provenance.sourceKey,
    generation: record.provenance.generation
  };
  const provenance = provenanceFor(line, record);
  switch (line.kind) {
    case 'meta':
      reduceMeta(state, source, line, record, provenance);
      break;
    case 'message':
      reduceMessage(state, source, line, record, provenance);
      break;
    case 'part':
      state.idle = false;
      reducePart(state, source, line, record, provenance);
      break;
    case 'idle':
      state.idle = true;
      pushEvent(state, source, provenance.lineNumber, provenance, 'Turn ended', 'boundary', record.text, 'detail');
      break;
    case 'unknown': {
      const nativeType = typeof line.raw['type'] === 'string' ? line.raw['type'] : undefined;
      pushEvent(
        state,
        source,
        provenance.lineNumber,
        provenance,
        `Unsupported OpenCode event${nativeType ? ` (${nativeType})` : ''}`,
        'info',
        record.text,
        'unknown'
      );
      break;
    }
    case 'malformed':
      pushEvent(
        state,
        source,
        provenance.lineNumber,
        provenance,
        'Malformed OpenCode record',
        'error',
        record.text,
        'malformed'
      );
      break;
  }
}

/** One source-local OpenCode projector; compact view continues to consume the same parser separately. */
export const opencodeSessionProjector: NativeTranscriptProjector<OpencodeState, OpencodeLine, OpencodePayloads> = {
  providerId: 'opencode',
  createState: () => ({ messages: new Map(), events: [], idle: false, nextOrder: 0 }),
  parseRecord: (record) => parseOpencodeLine(record.text),
  reduce(state, parsed, record) {
    reduceRecord(state, parsed, record);
  },
  project(state, source) {
    const candidates: { line: number; order: number; row: OpencodeRow }[] = [];
    if (state.session)
      candidates.push({ line: state.session.firstLine, order: -1, row: projectSession(source, state.session) });
    for (const message of state.messages.values()) {
      candidates.push({ line: message.firstLine, order: message.firstLine, row: projectMessage(source, message) });
    }
    for (const event of state.events) candidates.push({ line: event.firstLine, order: event.order, row: event.row });
    candidates.sort((left, right) => left.line - right.line || left.order - right.order);
    const rows = candidates.map((candidate) => candidate.row);
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      rows,
      header: projectHeader(state, source)
    };
  }
};

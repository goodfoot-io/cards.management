/**
 * Codex native records projected into Cards-owned semantic transcript rows.
 * The Codex parser and established Codex item conversion remain the only input path.
 * @summary Codex incremental native transcript projector
 * @module streams/codex-session/www/lib/project-session
 */

import { formatDuration } from '../../../lib/compact-facts';
import { stripMarkup, truncate } from '../../../lib/markdown';
import { type NativeTranscriptProjector, sessionIdentity } from '../../../lib/session/projection';
import type {
  NativeRecordProvenance,
  NativeTranscriptSource,
  SessionPart,
  SessionRow
} from '../../../lib/session/types';
import { countImageItems, createTurnDedupMatcher, extractMessageText, type TurnDedupMatcher } from './dedup';
import type { CodexRolloutLine, ContentItem, EventMsgPayload } from './parser';
import { parseCodexLine } from './parser';
import { lineToItems, shellExitSeverity, type TranscriptItem } from './render-transcript';

/** A retained native event line for lazy tool inspection. */
export interface CodexNativeDetail {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly provenance: readonly NativeRecordProvenance[];
}

/** Complete tool call, result, severity, and raw native details. */
export interface CodexToolData {
  readonly callId: string;
  readonly name: string;
  readonly argsLabel: string;
  readonly argumentsText: string;
  readonly prettyPrinted: boolean;
  readonly deferredArgumentsRecord?: string;
  readonly outputText?: string;
  readonly outputImageCount?: number;
  readonly status: 'pending' | 'complete' | 'error' | 'orphan';
  readonly errorLabel?: string;
  readonly details: readonly CodexNativeDetail[];
}

/** Provider payloads that keep Codex presentation details typed and inspectable. */
export interface CodexPayloads {
  imageNote: { readonly count: number };
  eventActivity: { readonly label: string; readonly detailText?: string };
  turnTime: { readonly text: string };
  sessionStart: {
    readonly summary: string;
    readonly entries: readonly {
      readonly id: string;
      readonly label: string;
      readonly text: string;
      readonly imageCount?: number;
    }[];
  };
  tool: CodexToolData;
  boundary: { readonly kind: 'turn' | 'compaction'; readonly tooltip?: string; readonly label?: string };
}

export type CodexPart = SessionPart<CodexPayloads>;
export type CodexRow = SessionRow<CodexPayloads>;

interface StoredEntry {
  readonly item: TranscriptItem;
  readonly line: CodexRolloutLine;
  readonly id: string;
  readonly source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>;
  readonly provenance: NativeRecordProvenance[];
  readonly details: CodexNativeDetail[];
  readonly rawLine: string;
  preambleLabel?: string;
}

interface PreambleEntry {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly imageCount?: number;
}

/** Mutable source-local reducer state. */
export interface CodexProjectionState {
  readonly source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>;
  readonly entries: StoredEntry[];
  readonly calls: Map<string, StoredEntry>;
  readonly dedup: TurnDedupMatcher;
  readonly pendingMirrors: Map<string, StoredEntry[]>;
  readonly preamble: PreambleEntry[];
  readonly previousRows: Map<string, CodexRow>;
  sessionId?: string;
  provider?: string;
  cwd?: string;
  model?: string;
  preambleClosed: boolean;
  preambleInsertionIndex?: number;
  hasError: boolean;
  lastAssistantText?: string;
}

/** Native Codex projection contract used by both replay and incremental snapshots. */
export const codexSessionProjector: NativeTranscriptProjector<CodexProjectionState, CodexRolloutLine, CodexPayloads> = {
  providerId: 'codex',
  createState(source) {
    return {
      source: { sourceKey: source.sourceKey, generation: source.generation },
      entries: [],
      calls: new Map(),
      dedup: createTurnDedupMatcher(),
      pendingMirrors: new Map(),
      preamble: [],
      previousRows: new Map(),
      preambleClosed: false,
      hasError: false
    };
  },
  parseRecord(record) {
    return parseCodexLine(record.text);
  },
  reduce(state, line, record) {
    if (line.kind === 'turn_context') {
      state.dedup.reset();
      state.pendingMirrors.clear();
    }
    if (line.kind === 'session_meta') {
      state.sessionId ??= line.payload.id;
      state.provider ??= line.payload.model_provider;
      state.cwd ??= line.payload.cwd;
    }
    if (line.kind === 'turn_context') {
      state.model ??= line.payload.model;
      state.cwd ??= line.payload.cwd;
    }

    const mirror = mirroredSignature(line);
    const mirrorSide =
      line.kind === 'response_item' ? 'response_item' : line.kind === 'event_msg' ? 'event_msg' : undefined;
    if (mirror) {
      let duplicate = false;
      if (line.kind === 'response_item') duplicate = state.dedup.processResponseItem(line.payload);
      else if (line.kind === 'event_msg') duplicate = state.dedup.processEventMsg(line.payload);
      if (duplicate) {
        const original = takeMirror(state, mirror, mirrorSide === 'response_item' ? 'event_msg' : 'response_item');
        if (original) original.provenance.push(withSelector(record.provenance, itemSelector(line)));
        return;
      }
    }

    const items = lineToItems(line, record.text);
    const knownUnsupportedEvent = line.kind === 'event_msg' && isUnsupportedEvent(line.payload);
    const retainLine = (label: string, raw = record.text): void => {
      const item: TranscriptItem = { kind: 'unknown_item', raw: raw, timestamp: lineTimestamp(line) };
      addEntry(state, item, line, record, 'raw', label);
    };

    if (line.kind === 'event_msg') {
      const payload = line.payload as Record<string, unknown> & { type: string };
      if (payload.type === 'error') state.hasError = true;
      if (payload.type === 'patch_apply_end' && payload['success'] === false) {
        const callId = payload['call_id'];
        if (typeof callId === 'string') {
          const target = state.calls.get(callId);
          if (target?.item.kind === 'tool_call') {
            target.item.severity = 'error';
            target.item.errorLabel = 'patch failed';
            target.details.push(detailFor(record, line, 'Patch result'));
            target.provenance.push(withSelector(record.provenance, 'tool-result/patch_apply_end'));
          }
        }
      }
      if (knownUnsupportedEvent) retainLine('Unsupported event');
    }

    if (items.length === 0) {
      if (line.kind === 'unknown') retainLine('Unrecognized item');
      if (line.kind === 'malformed')
        addEntry(state, { kind: 'malformed', rawLine: line.raw }, line, record, 'malformed');
      return;
    }

    for (const item of items) {
      if (item.kind === 'session_header') continue;

      if (item.kind === 'orphan_output') {
        const target = state.calls.get(item.callId);
        if (target?.item.kind === 'tool_call') {
          target.item.outputText = item.outputText;
          target.item.hasOutput = true;
          target.item.outputImageCount = item.imageCount;
          if (target.item.name === 'shell' || target.item.name === 'local_shell_call') {
            const severity = shellExitSeverity(item.outputText);
            target.item.severity = severity.severity;
            target.item.errorLabel = severity.errorLabel;
          }
          target.details.push(detailFor(record, line, 'Tool result'));
          target.provenance.push(withSelector(record.provenance, 'tool-result/output'));
          continue;
        }
      }

      const selector = itemSelector(line);
      if (isPreamble(state, item)) {
        if (item.kind !== 'user_message' && item.kind !== 'assistant_message') continue;
        const label = item.kind === 'user_message' ? 'Instructions' : 'Developer instructions';
        const imageCount = messageImageCount(line, item);
        state.preamble.push({
          id: sessionIdentity(state.source, 'codex-preamble', `${record.provenance.lineNumber}/${selector}`),
          label,
          text: item.text,
          imageCount
        });
        const entry = addEntry(state, item, line, record, selector);
        entry.preambleLabel = label;
        if (mirror && mirrorSide) registerMirror(state, mirror, mirrorSide, entry);
        continue;
      }

      if (closesPreamble(state, item)) {
        state.preambleClosed = true;
        state.preambleInsertionIndex = state.entries.length;
      }

      const entry = addEntry(state, item, line, record, selector);
      if (mirror && mirrorSide && (item.kind === 'user_message' || item.kind === 'assistant_message'))
        registerMirror(state, mirror, mirrorSide, entry);
      if (item.kind === 'tool_call') {
        entry.details.push(detailFor(record, line, 'Tool call'));
        if (item.callId) state.calls.set(item.callId, entry);
      } else if (item.kind === 'assistant_message') {
        state.lastAssistantText = item.text;
      } else if (item.kind === 'error') {
        state.hasError = true;
      }
    }
  },
  project(state, source) {
    const rows: CodexRow[] = [];
    const pushPreamble = (): void => {
      if (state.preamble.length === 0) return;
      const first = state.entries.find((entry) => entry.preambleLabel)?.provenance[0];
      const origins = state.entries.filter((entry) => entry.preambleLabel).flatMap((entry) => entry.provenance);
      if (!first || origins.length === 0) return;
      rows.push(
        providerRow(
          source,
          'sessionStart',
          first.lineNumber,
          'session-start',
          {
            summary: summarizeSessionStart(state.preamble, state.model),
            entries: state.preamble.map((entry) => ({ ...entry }))
          },
          origins
        )
      );
    };

    let preambleInserted = false;
    for (let index = 0; index < state.entries.length; index++) {
      if (!preambleInserted && state.preambleInsertionIndex === index) {
        pushPreamble();
        preambleInserted = true;
      }
      const entry = state.entries[index]!;
      if (entry.preambleLabel) continue;
      const projected = projectEntry(state, entry);
      rows.push(...projected);
    }
    if (!preambleInserted) pushPreamble();

    const stableRows = rows.map((row) => {
      const previous = state.previousRows.get(row.id);
      return previous && projectionEqual(previous, row) ? previous : row;
    });
    state.previousRows.clear();
    for (const row of stableRows) state.previousRows.set(row.id, row);

    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      rows: stableRows,
      header: {
        provider: state.provider,
        threadId: state.sessionId,
        model: state.model,
        cwd: state.cwd,
        status: source.meta?.isActive ? 'running' : state.hasError || hasToolError(state.entries) ? 'error' : 'done'
      }
    };
  },
  disposeState(state) {
    state.entries.length = 0;
    state.calls.clear();
    state.pendingMirrors.clear();
    state.previousRows.clear();
  }
};

function projectEntry(state: CodexProjectionState, entry: StoredEntry): CodexRow[] {
  const item = entry.item;
  const provenance = entry.provenance;
  const rowId = entry.id;
  switch (item.kind) {
    case 'user_message':
    case 'assistant_message': {
      const role = item.kind === 'user_message' ? 'user' : 'assistant';
      const parts: CodexPart[] = [];
      const text = item.text;
      if (text.length > 0) {
        parts.push({
          id: identityAt(entry, 'message/text'),
          kind: 'text',
          text,
          provenance: provenanceFor(entry, 'message/text')
        });
      }
      const imageCount = messageImageCount(entry.line, item);
      if (imageCount > 0) {
        parts.push({
          id: identityAt(entry, 'message/images'),
          kind: 'provider',
          providerKind: 'imageNote',
          data: { count: imageCount },
          provenance: provenanceFor(entry, 'message/images')
        });
      }
      for (const rawPart of unsupportedMessageParts(entry)) {
        parts.push({
          id: identityAt(entry, rawPart.selector),
          kind: 'raw',
          label: rawPart.label,
          text: rawPart.text,
          reason: 'unknown',
          provenance: provenanceFor(entry, rawPart.selector)
        });
      }
      return [
        {
          id: rowId,
          provenance: [...provenance],
          kind: 'message',
          role,
          anchor: role === 'user' ? 'turn' : 'none',
          parts
        }
      ];
    }
    case 'reasoning': {
      const hasContent = Boolean(item.contentText);
      const text =
        hasContent && item.summaryText.length > 0
          ? `${item.summaryText}\n\n${item.contentText}`
          : (item.contentText ?? item.summaryText);
      const parts: CodexPart[] =
        hasContent && text.length > 0
          ? [
              {
                id: identityAt(entry, 'reasoning'),
                kind: 'reasoning',
                text,
                provenance: provenanceFor(entry, 'reasoning')
              }
            ]
          : text.length > 0
            ? [
                {
                  id: identityAt(entry, 'reasoning-summary'),
                  kind: 'text',
                  text: stripMarkup(text),
                  provenance: provenanceFor(entry, 'reasoning-summary')
                }
              ]
            : [];
      for (const rawPart of unsupportedReasoningParts(entry)) {
        parts.push({
          id: identityAt(entry, rawPart.selector),
          kind: 'raw',
          label: rawPart.label,
          text: rawPart.text,
          reason: 'detail',
          provenance: provenanceFor(entry, rawPart.selector)
        });
      }
      return parts.length ? [baseRow(entry, 'Reasoning', parts)] : [];
    }
    case 'tool_call': {
      const callId = item.callId || `anonymous:${entry.provenance[0]?.lineNumber ?? 0}`;
      const tool: CodexToolData = {
        callId,
        name: item.name,
        argsLabel: item.argsLabel ?? 'arguments',
        argumentsText: item.argumentsText,
        prettyPrinted: item.prettyPrinted,
        deferredArgumentsRecord: item.deferredArgumentsRecord,
        outputText: item.outputText,
        outputImageCount: item.outputImageCount,
        status: item.severity === 'error' ? 'error' : item.hasOutput ? 'complete' : 'pending',
        errorLabel: item.errorLabel,
        details: [...entry.details]
      };
      return [providerRowFromEntry(entry, 'tool', tool)];
    }
    case 'orphan_output': {
      const detail = entry.details[0] ?? detailForRaw(entry, 'Tool result');
      return [
        providerRowFromEntry(entry, 'tool', {
          callId: item.callId,
          name: 'function_call_output',
          argsLabel: 'arguments',
          argumentsText: '',
          prettyPrinted: false,
          outputText: item.outputText,
          outputImageCount: item.imageCount,
          status: 'orphan',
          details: [detail]
        })
      ];
    }
    case 'turn_boundary':
    case 'task_started':
      return [
        providerRowFromEntry(entry, 'boundary', {
          kind: 'turn',
          tooltip:
            item.kind === 'task_started'
              ? item.turnId
                ? `Task started · ${item.turnId}`
                : 'Task started'
              : item.turnId
        })
      ];
    case 'compaction': {
      const parts: CodexPart[] = item.message
        ? [
            {
              id: identityAt(entry, 'compaction/message'),
              kind: 'text',
              text: item.message,
              provenance: provenanceFor(entry, 'compaction/message')
            }
          ]
        : [];
      return [providerRowFromEntry(entry, 'boundary', { kind: 'compaction', label: 'Context compacted' }, parts)];
    }
    case 'event_activity':
      return [providerRowFromEntry(entry, 'eventActivity', { label: item.label, detailText: item.detailText })];
    case 'task_complete': {
      const rows = [
        providerRowFromEntry(entry, 'turnTime', {
          text: item.durationMs !== undefined ? formatDuration(item.durationMs) : 'Turn complete'
        })
      ];
      if (item.lastAgentMessage && item.lastAgentMessage.trim() !== state.lastAssistantText?.trim()) {
        rows.push(
          providerRowFromEntry(
            entry,
            'eventActivity',
            { label: 'Last assistant message', detailText: truncate(stripMarkup(item.lastAgentMessage), 140) },
            [],
            'last-assistant-message'
          )
        );
      }
      return rows;
    }
    case 'error':
      return [
        baseRow(
          entry,
          'Error',
          [
            {
              id: identityAt(entry, 'error/message'),
              kind: 'text',
              text: item.message,
              provenance: provenanceFor(entry, 'error/message')
            }
          ],
          'error'
        )
      ];
    case 'unknown_item':
      return [
        baseRow(entry, 'Unrecognized item', [
          {
            id: identityAt(entry, 'unknown/raw'),
            kind: 'raw',
            label: 'Unrecognized item',
            text: entry.rawLine,
            reason: 'unknown',
            provenance: provenanceFor(entry, 'unknown/raw')
          }
        ])
      ];
    case 'malformed':
      return [
        baseRow(
          entry,
          'Malformed line',
          [
            {
              id: identityAt(entry, 'malformed/raw'),
              kind: 'raw',
              label: 'Malformed line',
              text: item.rawLine,
              reason: 'malformed',
              provenance: provenanceFor(entry, 'malformed/raw')
            }
          ],
          'error'
        )
      ];
    case 'session_header':
      return [];
  }
}

function baseRow(
  entry: StoredEntry,
  label: string,
  parts: readonly CodexPart[],
  tone: 'info' | 'error' = 'info'
): CodexRow {
  return {
    id: entry.id,
    provenance: [...entry.provenance],
    kind: 'structural',
    label,
    tone,
    anchor: 'none',
    parts
  };
}

function providerRow<K extends keyof CodexPayloads>(
  source: NativeTranscriptSource,
  kind: K,
  lineNumber: number,
  selector: string,
  data: CodexPayloads[K],
  provenance: readonly NativeRecordProvenance[]
): CodexRow {
  return {
    id: sessionIdentity(source, `codex-${kind}`, `${lineNumber}/${selector}`),
    provenance,
    kind: 'provider',
    providerKind: kind,
    data,
    anchor: 'none',
    parts: []
  } as CodexRow;
}

function providerRowFromEntry<K extends keyof CodexPayloads>(
  entry: StoredEntry,
  kind: K,
  data: CodexPayloads[K],
  parts: readonly CodexPart[] = [],
  selector = String(kind)
): CodexRow {
  return {
    id: sessionIdentity(
      entry.source,
      `codex-${String(kind)}`,
      `${entry.provenance[0]?.lineNumber ?? 0}/${entry.provenance[0]?.selector ?? 'record'}/${selector}`
    ),
    provenance: [...entry.provenance],
    kind: 'provider',
    providerKind: kind,
    data,
    anchor: 'none',
    parts
  } as CodexRow;
}

function addEntry(
  state: CodexProjectionState,
  item: TranscriptItem,
  line: CodexRolloutLine,
  record: { readonly text: string; readonly provenance: NativeRecordProvenance },
  selector: string,
  detailLabel?: string
): StoredEntry {
  const provenance = withSelector(record.provenance, selector, nativeEventId(line));
  const entry: StoredEntry = {
    item,
    line,
    id: sessionIdentity(state.source, 'codex-row', `${record.provenance.lineNumber}/${selector}`),
    source: state.source,
    provenance: [provenance],
    details: detailLabel ? [detailFor(record, line, detailLabel, selector)] : [],
    rawLine: record.text
  };
  state.entries.push(entry);
  return entry;
}

function withSelector(
  provenance: NativeRecordProvenance,
  selector: string,
  nativeEventId = provenance.nativeEventId
): NativeRecordProvenance {
  return { ...provenance, selector, ...(nativeEventId ? { nativeEventId } : {}) };
}

function provenanceFor(entry: StoredEntry, selector: string): NativeRecordProvenance[] {
  return entry.provenance.map((origin) => withSelector(origin, selector));
}

function identityAt(entry: StoredEntry, selector: string): string {
  return sessionIdentity(entry.source, 'codex-part', `${entry.provenance[0]?.lineNumber ?? 0}/${selector}`);
}

function detailFor(
  record: { readonly text: string; readonly provenance: NativeRecordProvenance },
  line: CodexRolloutLine,
  label: string,
  selector = itemSelector(line)
): CodexNativeDetail {
  const provenance = withSelector(record.provenance, `detail/${selector}`, nativeEventId(line));
  return {
    id: sessionIdentity(
      { sourceKey: record.provenance.sourceKey, generation: record.provenance.generation },
      'codex-detail',
      `${record.provenance.lineNumber}/${selector}`
    ),
    label,
    text: record.text,
    provenance: [provenance]
  };
}

function detailForRaw(entry: StoredEntry, label: string): CodexNativeDetail {
  return {
    id: sessionIdentity(entry.source, 'codex-detail', `${entry.provenance[0]?.lineNumber ?? 0}/raw`),
    label,
    text: entry.rawLine,
    provenance: entry.provenance
  };
}

function lineTimestamp(line: CodexRolloutLine): string | undefined {
  return 'timestamp' in line ? line.timestamp : undefined;
}

function itemSelector(line: CodexRolloutLine): string {
  if (line.kind === 'response_item') return `response_item/${line.payload.type}`;
  if (line.kind === 'event_msg') return `event_msg/${line.payload.type}`;
  return line.kind;
}

function nativeEventId(line: CodexRolloutLine): string | undefined {
  if (line.kind === 'session_meta') return line.payload.id;
  if (line.kind === 'turn_context') return line.payload.turn_id;
  if (line.kind === 'event_msg' || line.kind === 'response_item') {
    const payload = line.payload as Record<string, unknown>;
    for (const key of ['call_id', 'turn_id', 'client_id', 'id']) {
      if (typeof payload[key] === 'string') return payload[key];
    }
  }
  return undefined;
}

function mirroredSignature(line: CodexRolloutLine): string | undefined {
  if (line.kind === 'response_item' && line.payload.type === 'message') {
    const payload = line.payload as Record<string, unknown>;
    const role = payload['role'];
    if (role === 'assistant' || role === 'user') {
      const content = Array.isArray(payload['content']) ? (payload['content'] as ContentItem[]) : [];
      return `${role}:${extractMessageText(content).trim()}`;
    }
  }
  if (line.kind === 'event_msg') {
    const payload = line.payload as Record<string, unknown>;
    const role =
      payload['type'] === 'agent_message' ? 'assistant' : payload['type'] === 'user_message' ? 'user' : undefined;
    if (role) return `${role}:${(typeof payload['message'] === 'string' ? payload['message'] : '').trim()}`;
  }
  return undefined;
}

function takeMirror(
  state: CodexProjectionState,
  signature: string,
  side: 'response_item' | 'event_msg'
): StoredEntry | undefined {
  const key = `${side}:${signature}`;
  const pending = state.pendingMirrors.get(key);
  const result = pending?.shift();
  if (pending?.length === 0) state.pendingMirrors.delete(key);
  return result;
}

function registerMirror(
  state: CodexProjectionState,
  signature: string,
  side: 'response_item' | 'event_msg',
  entry: StoredEntry
): void {
  const key = `${side}:${signature}`;
  const pending = state.pendingMirrors.get(key) ?? [];
  pending.push(entry);
  state.pendingMirrors.set(key, pending);
}

function isPreamble(state: CodexProjectionState, item: TranscriptItem): boolean {
  if (state.preambleClosed) return false;
  if (item.kind === 'assistant_message') return item.role === 'developer';
  return (
    item.kind === 'user_message' &&
    (/^# AGENTS\.md instructions for /.test(item.text) || item.text.includes('<environment_context>'))
  );
}

function closesPreamble(state: CodexProjectionState, item: TranscriptItem): boolean {
  if (state.preambleClosed) return false;
  if (item.kind === 'user_message') return true;
  if (item.kind === 'assistant_message') return item.role !== 'developer';
  if (item.kind === 'tool_call') return true;
  return item.kind === 'reasoning' && (item.summaryText.length > 0 || Boolean(item.contentText));
}

function summarizeSessionStart(entries: readonly PreambleEntry[], model: string | undefined): string {
  const segments = ['Session started'];
  if (model) segments.push(model);
  if (entries.some((entry) => /^# AGENTS\.md instructions for /.test(entry.text))) segments.push('instructions');
  if (entries.some((entry) => entry.text.includes('<environment_context>'))) segments.push('environment');
  const developers = entries.filter((entry) => entry.label === 'Developer instructions').length;
  if (developers) segments.push(`${developers} developer note${developers === 1 ? '' : 's'}`);
  return segments.join(' · ');
}

function messageImageCount(line: CodexRolloutLine, item: TranscriptItem): number {
  if (item.kind !== 'user_message' && item.kind !== 'assistant_message') return 0;
  if (line.kind === 'response_item' && line.payload.type === 'message') {
    const content = Array.isArray(line.payload.content) ? (line.payload.content as ContentItem[]) : [];
    return countImageItems(content);
  }
  if (line.kind === 'event_msg' && line.payload.type === 'user_message') {
    return Array.isArray(line.payload.images) ? line.payload.images.length : 0;
  }
  return 0;
}

function unsupportedMessageParts(entry: StoredEntry): { selector: string; label: string; text: string }[] {
  const line = entry.line;
  if (line.kind !== 'response_item' || line.payload.type !== 'message' || !Array.isArray(line.payload.content))
    return [];
  return line.payload.content.flatMap((content, index) => {
    if (content.type === 'input_text' || content.type === 'output_text' || content.type === 'input_image') return [];
    return [
      {
        selector: `content/${index}`,
        label: `Unsupported content · ${content.type || 'unknown'}`,
        text: entry.rawLine
      }
    ];
  });
}

function unsupportedReasoningParts(entry: StoredEntry): { selector: string; label: string; text: string }[] {
  const line = entry.line;
  if (line.kind !== 'response_item' || line.payload.type !== 'reasoning') return [];
  const parts: { selector: string; label: string; text: string }[] = [];
  const summary = Array.isArray(line.payload.summary) ? line.payload.summary : [];
  summary.forEach((item, index) => {
    if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') return;
    parts.push({
      selector: `reasoning/summary/${index}`,
      label: 'Unsupported reasoning summary',
      text: entry.rawLine
    });
  });
  const content = Array.isArray(line.payload.content) ? line.payload.content : [];
  content.forEach((item, index) => {
    if (
      item &&
      typeof item === 'object' &&
      ['reasoning_text', 'text'].includes(String((item as { type?: unknown }).type)) &&
      typeof (item as { text?: unknown }).text === 'string'
    )
      return;
    parts.push({
      selector: `reasoning/content/${index}`,
      label: 'Unsupported reasoning content',
      text: entry.rawLine
    });
  });
  if (typeof line.payload.encrypted_content === 'string') {
    parts.push({
      selector: 'reasoning/encrypted',
      label: 'Encrypted reasoning payload',
      text: line.payload.encrypted_content
    });
  }
  return parts;
}

function isUnsupportedEvent(payload: EventMsgPayload): boolean {
  const type = (payload as Record<string, unknown>)['type'];
  return (
    typeof type === 'string' &&
    !new Set([
      'agent_message',
      'user_message',
      'token_count',
      'task_started',
      'task_complete',
      'error',
      'mcp_tool_call_end',
      'web_search_end',
      'image_generation_end',
      'patch_apply_end',
      'item_completed'
    ]).has(type)
  );
}

function hasToolError(entries: readonly StoredEntry[]): boolean {
  return entries.some((entry) => entry.item.kind === 'tool_call' && entry.item.severity === 'error');
}

function projectionEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const leftArray = left as unknown[];
    const rightArray = right as unknown[];
    return (
      leftArray.length === rightArray.length &&
      leftArray.every((value, index) => projectionEqual(value, rightArray[index]))
    );
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(rightObject, key) && projectionEqual(leftObject[key], rightObject[key]))
  );
}

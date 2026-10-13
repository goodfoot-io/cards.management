/**
 * Claude native records reduced into Cards-owned semantic leaves before visual grouping.
 * Physical replay provenance, UUID equivalence and tool associations are source-local.
 * @summary Claude incremental native transcript projector
 * @module streams/claude-code-session/www/lib/project-session
 */

import { stripMarkup, truncate } from '../../../lib/markdown';
import { type NativeTranscriptProjector, sessionIdentity } from '../../../lib/session/projection';
import type {
  NativeRecordProvenance,
  NativeTranscriptSource,
  SessionHeaderFacts,
  SessionPart,
  SessionRow
} from '../../../lib/session/types';
import { type AttachmentDescriptor, classifyAttachment } from './classify-attachment';
import { classifyCoordinationText, isCoordinationContent } from './classify-coordination';
import type { AttachmentPayload } from './parse-session';
import { summarizeTool } from './tool-summary';

/** Attachment presentation retains both the classifier result and complete native payload. */
export interface ClaudeAttachmentData {
  attachment: AttachmentPayload;
  descriptor: AttachmentDescriptor;
}
/** Tool associations retain supplemental text, native result details and stable hook leaves. */
export interface ClaudeToolData {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  supplemental?: string;
  status: 'pending' | 'complete' | 'error' | 'orphan';
  hooks: readonly ClaudePart[];
  details: readonly ClaudePart[];
}
/** Provider-only presentation payloads; no vendor message roles or transport normalization. */
export interface ClaudePayloads {
  attachment: ClaudeAttachmentData;
  tool: ClaudeToolData;
  group: { label: string; rows: readonly ClaudeRow[] };
  prose: { label: string; text: string };
}
export type ClaudePart = SessionPart<ClaudePayloads>;
export type ClaudeRow = SessionRow<ClaudePayloads>;
type Json = Record<string, unknown>;
interface Event {
  key: string;
  value: Json;
  text: string;
  provenance: NativeRecordProvenance[];
  segments: Segment[];
  tools: Set<string>;
}
interface Segment {
  event: Event;
  row: ClaudeRow;
  category: 'user' | 'assistant' | 'service' | 'boundary';
  ambient?: boolean;
  hidden?: boolean;
}
interface Tool {
  id: string;
  call?: { event: Event; segment: Segment; name: string; input: Json };
  result?: { event: Event; text: string; error: boolean; summary: boolean };
  orphan?: Segment;
  hooks: { event: Event; segment: Segment; part: ClaudePart }[];
  supplemental: { event: Event; segment: Segment; text: string }[];
  records: Set<Event>;
}
/** Reducer state owns native-event equivalence, semantic associations and immutable row reuse. */
export interface ClaudeProjectionState {
  source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>;
  events: Map<string, Event[]>;
  segments: Segment[];
  tools: Map<string, Tool>;
  coordination: Map<string, string>;
  header: SessionHeaderFacts;
  groups: Map<string, { rows: readonly ClaudeRow[]; row: ClaudeRow }>;
}
/** Parsing is deliberately independent of compact mode's filtering and UUID suppression. */
interface ParsedRecord {
  value?: Json;
  malformed?: boolean;
}
const HOOK_TYPES = new Set([
  'hook_success',
  'hook_additional_context',
  'hook_system_message',
  'hook_non_blocking_error',
  'hook_blocking_error',
  'hook_cancelled'
]);

/**
 * Reads a plain JSON object without trusting native record shape.
 * @param value - Untrusted native JSON value.
 * @returns The plain object, or undefined for other native shapes.
 */
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}
/**
 * Renders native scalar text without granting transcript strings executable behavior.
 * @param value - Untrusted native JSON value.
 * @returns The native string, or an empty string for a non-string value.
 */
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
/**
 * Source-scoped leaf identity is derived before filtering, pairing or grouping.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param selector - Deterministic native block or presentation selector.
 * @returns Stable semantic identity and physical provenance for this leaf.
 */
function identity(state: ClaudeProjectionState, event: Event, selector: string) {
  return {
    id: sessionIdentity(state.source, 'claude', `${event.key}/${selector}`),
    semanticKey: event.key,
    provenance: event.provenance.map((origin) => ({ ...origin, selector }))
  };
}
/**
 * Retains the complete native record for bounded inspection.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param selector - Deterministic native block or presentation selector.
 * @param reason - Why the complete native payload is inspectable.
 * @param label - Accessible structural or disclosure label.
 * @returns An inert raw part retaining the complete native record.
 */
function detail(
  state: ClaudeProjectionState,
  event: Event,
  selector = 'detail',
  reason: 'detail' | 'unknown' | 'malformed' | 'conflicting-id' = 'detail',
  label = 'Raw details'
): ClaudePart {
  return { ...identity(state, event, selector), kind: 'raw', label, text: event.text, reason };
}
/**
 * Appends an immutable semantic segment at its physical event position.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param selector - Deterministic native block or presentation selector.
 * @param category - Semantic placement before visual grouping.
 * @param parts - Ordered stable leaves belonging to this row.
 * @param label - Accessible structural or disclosure label.
 * @returns The appended segment retained for late association updates.
 */
function add(
  state: ClaudeProjectionState,
  event: Event,
  selector: string,
  category: Segment['category'],
  parts: ClaudePart[],
  label = ''
): Segment {
  const base = {
    ...identity(state, event, `row/${selector}`),
    anchor: category === 'user' || category === 'assistant' ? ('turn' as const) : ('none' as const),
    parts
  };
  const row: ClaudeRow =
    category === 'user' || category === 'assistant'
      ? { ...base, kind: 'message', role: category, label: category === 'assistant' ? 'Claude Code' : 'You' }
      : { ...base, kind: 'structural', label, tone: category === 'boundary' ? 'boundary' : 'info' };
  const segment = { event, row, category };
  event.segments.push(segment);
  state.segments.push(segment);
  return segment;
}
/**
 * Adds a structural status with its native payload still available.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param label - Accessible structural or disclosure label.
 * @param boundary - Whether this event remains outside preamble grouping.
 * @param error - Whether the native event reports an error.
 */
function status(state: ClaudeProjectionState, event: Event, label: string, boundary = false, error = false): void {
  const selector = `status/${event.segments.length}`;
  // One record can emit several statuses, so each carries its own detail leaf rather than sharing one ID.
  const segment = add(
    state,
    event,
    selector,
    boundary ? 'boundary' : 'service',
    [detail(state, event, `${selector}/detail`)],
    label
  );
  if (error && segment.row.kind === 'structural') segment.row = { ...segment.row, tone: 'error' };
}
/**
 * Classifies coordination text with the existing provider rules and deduplicates only coordination state.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param text - Complete native text retained for inspection.
 */
function coordination(state: ClaudeProjectionState, event: Event, text: string): void {
  for (const line of classifyCoordinationText(text)) coordinationLine(state, event, line);
}
/**
 * Repeated unchanged coordination facts are intentionally quiet, unlike repeated prompts.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param line - Classified coordination fact.
 */
function coordinationLine(state: ClaudeProjectionState, event: Event, line: string): void {
  const key = line.split(':')[0]!;
  if (state.coordination.get(key) === line) return;
  state.coordination.set(key, line);
  status(state, event, line);
}
/**
 * Looks up one source-scoped tool association without guessing from names or proximity.
 * @param state - Source-local semantic reducer state.
 * @param id - Source-local tool call or presentation identity.
 * @returns The existing or newly allocated tool association.
 */
function tool(state: ClaudeProjectionState, id: string): Tool {
  let entry = state.tools.get(id);
  if (!entry) {
    entry = { id, hooks: [], supplemental: [], records: new Set() };
    state.tools.set(id, entry);
  }
  return entry;
}
/**
 * Applies late results and hooks by replacing only the owning tool leaf.
 * @param state - Source-local semantic reducer state.
 * @param entry - Tool association being refreshed.
 */
function refreshTool(state: ClaudeProjectionState, entry: Tool): void {
  const result = entry.result;
  const target = entry.call?.segment ?? entry.orphan;
  for (const hook of entry.hooks) hook.segment.hidden = !!result;
  for (const supplemental of entry.supplemental) supplemental.segment.hidden = !!result;
  if (!target) return;
  if (entry.orphan) entry.orphan.hidden = !!entry.call;
  for (const event of [
    entry.call?.event,
    result?.event,
    ...entry.hooks.map((h) => h.event),
    ...entry.supplemental.map((s) => s.event)
  ])
    if (event) entry.records.add(event);
  const events = [...entry.records];
  const provenance = events.flatMap((e) => e.provenance.map((p) => ({ ...p, selector: `tool/${entry.id}` })));
  const hooks = result ? entry.hooks.map((h) => h.segment.row.parts[0]!) : [];
  const blocking = hooks.some(
    (h) => h.kind === 'provider' && h.providerKind === 'attachment' && h.data.attachment.type === 'hook_blocking_error'
  );
  const data: ClaudeToolData = {
    name: entry.call?.name ?? 'tool',
    input: entry.call?.input ?? {},
    ...(result ? { output: result.text } : {}),
    ...(result && entry.supplemental.length
      ? { supplemental: entry.supplemental.map((s) => s.text).join('\n\n') }
      : {}),
    status: blocking || result?.error ? 'error' : !entry.call ? 'orphan' : result ? 'complete' : 'pending',
    hooks,
    details: events.map((e) => ({
      ...detail(state, e),
      id: sessionIdentity(state.source, 'claude-tool-detail', `${entry.id}/${e.key}`)
    }))
  };
  const part: ClaudePart = {
    id: sessionIdentity(state.source, 'claude-tool', entry.id),
    semanticKey: `tool/${entry.id}`,
    provenance,
    kind: 'provider',
    providerKind: 'tool',
    data
  };
  target.row = { ...target.row, parts: [part], provenance };
}
/**
 * Joins textual tool results while retaining non-text blocks in their native details.
 * @param value - Untrusted native JSON value.
 * @returns Textual result content with unsupported blocks retained as JSON.
 */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value)
    ? value
        .map((block) => {
          const item = object(block);
          return item?.['type'] === 'text' ? string(item['text']) : JSON.stringify(block);
        })
        .join('\n')
    : (JSON.stringify(value) ?? '');
}
/**
 * A real result supersedes a summary; both records remain inspectable through native details.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 * @param id - Source-local tool call or presentation identity.
 * @param text - Complete native text retained for inspection.
 * @param error - Whether the native event reports an error.
 * @param summary - Whether this is a summary rather than a complete native result.
 */
function resolveTool(
  state: ClaudeProjectionState,
  event: Event,
  id: string,
  text: string,
  error: boolean,
  summary = false
): void {
  const entry = tool(state, id);
  event.tools.add(id);
  if (!entry.result || !summary || entry.result.summary) entry.result = { event, text, error, summary };
  if (!entry.call && !entry.orphan) entry.orphan = add(state, event, `orphan/${id}`, 'assistant', []);
  refreshTool(state, entry);
}
/**
 * Converts user/assistant content blocks with stable selectors, including unsupported blocks.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 */
function content(state: ClaudeProjectionState, event: Event): void {
  const value = event.value;
  const role = value['type'] === 'user' ? 'user' : 'assistant';
  const message = object(value['message']);
  const input = message?.['content'];
  if (value['error']) {
    status(state, event, `API Error: ${String(value['error'])}`, false, true);
    return;
  }
  const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : Array.isArray(input) ? input : [];
  if (!message || (typeof input !== 'string' && !Array.isArray(input))) {
    add(state, event, 'malformed-content', 'service', [
      detail(state, event, 'malformed', 'malformed', 'Malformed message content')
    ]);
    return;
  }
  const supplemental = role === 'user' && value['isMeta'] === true;
  if (supplemental && blocks.some((block) => object(block)?.['type'] === 'text')) {
    const text = blocks
      .map((block) => {
        const b = object(block);
        return b?.['type'] === 'text' ? string(b['text']) : '';
      })
      .filter(Boolean)
      .join('\n\n');
    const part: ClaudePart = {
      ...identity(state, event, 'supplemental'),
      kind: 'provider',
      providerKind: 'prose',
      data: { label: 'Supplemental content', text }
    };
    const segment = add(state, event, 'supplemental', 'service', [part, detail(state, event)]);
    const id = string(value['sourceToolUseID']);
    if (id) {
      const entry = tool(state, id);
      entry.supplemental.push({ event, segment, text });
      event.tools.add(id);
      refreshTool(state, entry);
    }
  }
  blocks.forEach((block, index) => {
    const b = object(block);
    // Supplemental classification applies to text, never to native tool-result blocks.
    if (supplemental && b?.['type'] === 'text') return;
    const selector = `message/content/${index}`;
    if (b?.['type'] === 'text' && typeof b['text'] === 'string') {
      if (isCoordinationContent(b['text'])) {
        const start = event.segments.length;
        coordination(state, event, b['text']);
        if (role === 'user') for (const segment of event.segments.slice(start)) segment.category = 'user';
      } else
        add(state, event, selector, role, [{ ...identity(state, event, selector), kind: 'text', text: b['text'] }]);
    } else if (b?.['type'] === 'thinking' && typeof b['thinking'] === 'string') {
      add(state, event, selector, role, [
        { ...identity(state, event, selector), kind: 'reasoning', text: b['thinking'] }
      ]);
    } else if (b?.['type'] === 'tool_use' && typeof b['id'] === 'string') {
      const entry = tool(state, b['id']);
      event.tools.add(b['id']);
      const name = string(b['name']) || 'tool';
      const args = object(b['input']) ?? {};
      if (entry.call) {
        add(state, event, selector, 'service', [
          detail(state, event, selector, 'conflicting-id', `Repeated tool call ID · ${b['id']}`)
        ]);
      } else {
        entry.call = { event, segment: add(state, event, selector, role, []), name, input: args };
        refreshTool(state, entry);
      }
    } else if (b?.['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
      resolveTool(state, event, b['tool_use_id'], resultText(b['content']), b['is_error'] === true);
    } else {
      add(state, event, selector, role, [
        {
          ...identity(state, event, selector),
          kind: 'raw',
          reason: 'unknown',
          label: `Unsupported content · ${string(b?.['type']) || 'block'}`,
          text: JSON.stringify(block)
        }
      ]);
    }
  });
}
/**
 * Validates collection fields before typed attachment summaries or lazy bodies consume them.
 * @param payload - Untrusted native attachment object.
 * @returns Whether its known collection fields have their required runtime shapes.
 */
function validAttachmentCollections(payload: Json): boolean {
  const lists: Record<string, readonly string[]> = {
    skill_listing: ['names'],
    command_permissions: ['allowedTools'],
    deferred_tools_delta: ['addedNames', 'readdedNames', 'removedNames'],
    mcp_instructions_delta: ['addedNames', 'addedBlocks'],
    agent_listing_delta: ['addedTypes', 'removedTypes'],
    dynamic_skill: ['skillNames']
  };
  const type = string(payload['type']);
  for (const field of lists[type] ?? []) {
    const value = payload[field];
    if (value === undefined && !(type === 'command_permissions' && field === 'allowedTools')) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return false;
  }
  if (type === 'invoked_skills' && payload['skills'] !== undefined) {
    const skills = payload['skills'];
    if (
      !Array.isArray(skills) ||
      !skills.every((value) => {
        const skill = object(value);
        return (
          skill &&
          ['name', 'path', 'content'].every((field) => skill[field] === undefined || typeof skill[field] === 'string')
        );
      })
    )
      return false;
  }
  if (type === 'task_reminder' && payload['content'] !== undefined && !Array.isArray(payload['content'])) return false;
  return true;
}

/**
 * Preserves classifier-driven attachment tiers, orphan hooks and tool nesting.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 */
function attachment(state: ClaudeProjectionState, event: Event): void {
  const payload = object(event.value['attachment']);
  if (!payload || typeof payload['type'] !== 'string' || !validAttachmentCollections(payload)) {
    add(state, event, 'attachment', 'service', [
      detail(state, event, 'attachment', 'malformed', 'Malformed attachment')
    ]);
    return;
  }
  const native = payload as unknown as AttachmentPayload;
  const descriptor = classifyAttachment(native);
  if (descriptor.hidden) return;
  const part: ClaudePart = {
    ...identity(state, event, 'attachment'),
    kind: 'provider',
    providerKind: 'attachment',
    data: { attachment: native, descriptor }
  };
  const segment = add(state, event, 'attachment', 'service', [part]);
  segment.ambient = descriptor.scope === 'turn' && descriptor.tier === 'ambient';
  const id = string(payload['toolUseID']);
  if (HOOK_TYPES.has(native.type) && id) {
    const entry = tool(state, id);
    entry.hooks.push({ event, segment, part });
    event.tools.add(id);
    refreshTool(state, entry);
  }
}
/**
 * Reduces provider structural records without coercing them into assistant messages.
 * @param state - Source-local semantic reducer state.
 * @param event - Native event and all verified physical occurrences.
 */
function structural(state: ClaudeProjectionState, event: Event): void {
  const v = event.value;
  const type = string(v['type']);
  const subtype = string(v['subtype']);
  switch (type) {
    // Session bookkeeping with no reader-facing meaning, like the permission and prompt latches.
    case 'permission-mode':
    case 'last-prompt':
    case 'atis-latch':
    case 'cost-state':
      return;
    case 'agent-name':
      if (v['agentName']) coordinationLine(state, event, `Agent: ${String(v['agentName'])}`);
      return;
    case 'relocated':
      status(state, event, `Relocated to ${string(v['relocatedCwd'])}`);
      return;
    case 'fork-context-ref':
      status(state, event, `Forked context from session ${string(v['parentSessionId'])}`);
      return;
    case 'mode':
      if (v['mode']) coordinationLine(state, event, `Mode: ${String(v['mode'])}`);
      return;
    case 'ai-title':
      if (v['aiTitle']) coordinationLine(state, event, `Title: "${String(v['aiTitle'])}"`);
      return;
    case 'auth_status':
      if (v['error']) status(state, event, `Auth error: ${String(v['error'])}`, false, true);
      else if (v['isAuthenticating']) status(state, event, 'Authenticating…');
      return;
    case 'result': {
      const success = subtype === 'success';
      state.header = { ...state.header, status: success ? 'done' : 'error' };
      const seconds = Math.round(Number(v['duration_ms'] ?? 0) / 1000);
      const cost = v['total_cost_usd'] != null ? ` · $${Number(v['total_cost_usd']).toFixed(4)}` : '';
      status(
        state,
        event,
        `${success ? 'Session complete' : `Session error (${subtype || 'unknown'})`} · ${v['num_turns'] ?? 0} turns · ${seconds}s${success ? cost : ''}`,
        true,
        !success
      );
      return;
    }
    case 'queue-operation': {
      const operation = string(v['operation']);
      if (operation === 'enqueue') {
        const preview = truncate(stripMarkup(string(v['content'])).trim(), 60);
        status(state, event, preview ? `Queued: ${preview}` : 'Queued');
      } else if (operation === 'remove' || operation === 'dequeue') status(state, event, `Queue: ${operation}`);
      else
        add(state, event, 'queue', 'service', [
          detail(state, event, 'queue', 'unknown', `Unrecognized queue operation · ${operation}`)
        ]);
      return;
    }
    case 'bridge-session':
      status(state, event, `Bridge session${v['bridgeSessionId'] ? ` ${String(v['bridgeSessionId'])}` : ''}`);
      return;
    case 'worktree-state':
      status(
        state,
        event,
        object(v['worktreeSession'])?.['worktreeName']
          ? `Worktree: ${String(object(v['worktreeSession'])!['worktreeName'])}`
          : 'Worktree state'
      );
      return;
    case 'progress': {
      const data = object(v['data']);
      if (data?.['type'] !== 'agent_progress') return;
      if (Array.isArray(data['content']))
        for (const block of data['content']) {
          const b = object(block);
          if (b?.['type'] !== 'tool_use') continue;
          const name = string(b['name']) || 'tool';
          const summary = summarizeTool(name, object(b['input']) ?? {});
          status(state, event, `↳ ${name}${summary ? ` ${summary}` : ''}`);
        }
      return;
    }
    case 'tool_use_summary': {
      const ids = Array.isArray(v['preceding_tool_use_ids'])
        ? v['preceding_tool_use_ids'].filter((id): id is string => typeof id === 'string')
        : [];
      const pending = ids.filter((id) => state.tools.get(id)?.call && !state.tools.get(id)?.result);
      if (pending.length) for (const id of pending) resolveTool(state, event, id, string(v['summary']), false, true);
      else
        add(state, event, 'summary', 'service', [
          {
            ...identity(state, event, 'summary'),
            kind: 'provider',
            providerKind: 'prose',
            data: { label: 'Tool summary', text: string(v['summary']) }
          }
        ]);
      return;
    }
    case 'system': {
      if (['hook_started', 'hook_progress', 'hook_response'].includes(subtype)) return;
      if (subtype === 'init') {
        state.header = { ...state.header, model: string(v['model']), cwd: string(v['cwd']) };
        const count = Array.isArray(v['tools']) ? v['tools'].length : 0;
        status(state, event, `Session started · ${count} tool${count === 1 ? '' : 's'}`, true);
        return;
      }
      if (subtype === 'status') {
        if (v['status'] === 'compacting') status(state, event, 'Compacting context…');
        return;
      }
      if (subtype === 'compact_boundary') {
        const meta = object(v['compact_metadata']);
        status(
          state,
          event,
          `Context compacted (${meta?.['trigger'] ?? 'auto'}) · ${Number(meta?.['pre_tokens'] ?? 0).toLocaleString()} tokens`,
          true
        );
        return;
      }
      if (subtype === 'files_persisted') {
        const saved = Array.isArray(v['files']) ? v['files'].length : 0;
        const failed = Array.isArray(v['failed']) ? v['failed'].length : 0;
        status(state, event, `Files persisted: ${saved} saved${failed ? `, ${failed} failed` : ''}`);
        return;
      }
      if (subtype === 'task_notification') {
        status(state, event, `Task ${v['task_id'] ?? ''}: ${v['status'] ?? ''} — ${v['summary'] ?? ''}`);
        return;
      }
      if (subtype === 'turn_duration') {
        const count = Number(v['messageCount'] ?? 0);
        status(
          state,
          event,
          `Turn · ${(Number(v['durationMs'] ?? 0) / 1000).toFixed(1)}s · ${count} message${count === 1 ? '' : 's'}`
        );
        return;
      }
      if (subtype === 'stop_hook_summary') {
        stopHookSummary(state, event);
        return;
      }
      if (['informational', 'scheduled_task_fire', 'bridge_status'].includes(subtype)) {
        status(state, event, string(v['content']), false, v['level'] === 'error');
        return;
      }
      if (subtype === 'local_command') {
        status(state, event, localCommandLabel(string(v['content'])));
        return;
      }
      if (subtype === 'away_summary') {
        add(state, event, 'away', 'boundary', [
          {
            ...identity(state, event, 'away'),
            kind: 'provider',
            providerKind: 'prose',
            data: { label: 'Away summary', text: string(v['content']) }
          }
        ]);
        return;
      }
    }
  }
  add(state, event, 'unknown', 'service', [
    detail(
      state,
      event,
      'unknown',
      'unknown',
      `Unrecognized ${type === 'system' ? `system event · ${subtype}` : `message · ${type || 'record'}`}`
    )
  ]);
}
/**
 * Summarizes Stop hook completion; failures and blocked continuation take the error tone.
 * @param state - Source-local semantic reducer state.
 * @param event - Native `stop_hook_summary` system event.
 */
function stopHookSummary(state: ClaudeProjectionState, event: Event): void {
  const v = event.value;
  const errors = Array.isArray(v['hookErrors']) ? v['hookErrors'].map(String).filter(Boolean) : [];
  if (v['preventedContinuation'] === true) {
    const reason = string(v['stopReason']);
    status(state, event, `Stop hook prevented continuation${reason ? ` · ${reason}` : ''}`, false, true);
    return;
  }
  if (errors.length) {
    status(state, event, `Stop hook errors · ${truncate(errors.join('; '), 120)}`, false, true);
    return;
  }
  const count = Number(v['hookCount'] ?? 0);
  const infos = Array.isArray(v['hookInfos']) ? v['hookInfos'] : [];
  const milliseconds = infos.reduce((total: number, info) => total + Number(object(info)?.['durationMs'] ?? 0), 0);
  status(state, event, `Stop hooks · ${count} hook${count === 1 ? '' : 's'} · ${(milliseconds / 1000).toFixed(1)}s`);
}
/**
 * Labels a local slash command or its captured output from Claude's tagged command text.
 * @param content - Native `local_command` content with command or output tags.
 * @returns A one-line command or output label.
 */
function localCommandLabel(content: string): string {
  const tagged = (tag: string): string | undefined =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(content)?.[1]?.trim();
  const name = tagged('command-name');
  const args = tagged('command-args');
  if (name) return `Command · ${name}${args ? ` ${args}` : ''}`;
  const output = tagged('local-command-stdout') ?? tagged('local-command-stderr');
  if (output !== undefined) return `Command output · ${truncate(stripMarkup(output).trim(), 120)}`;
  return `Command · ${truncate(stripMarkup(content).trim(), 120)}`;
}
/**
 * Reuses grouped row objects when their surviving leaves are unchanged.
 * @param state - Source-local semantic reducer state.
 * @param id - Source-local tool call or presentation identity.
 * @param rows - Projected rows including provider-owned nested groups.
 * @param label - Accessible structural or disclosure label.
 * @returns An immutable presentation row, reusing the prior row when unchanged.
 */
function grouped(state: ClaudeProjectionState, id: string, rows: readonly ClaudeRow[], label?: string): ClaudeRow {
  const parts = rows.flatMap((row) => row.parts);
  const previous = state.groups.get(id);
  if (
    previous &&
    previous.rows.length === rows.length &&
    previous.rows.every((row, i) => row === rows[i]) &&
    (previous.row.kind !== 'provider' || (previous.row.providerKind === 'group' && previous.row.data.label === label))
  )
    return previous.row;
  const provenance = rows.flatMap((row) => row.provenance);
  const row: ClaudeRow =
    label !== undefined
      ? { id, provenance, anchor: 'none', kind: 'provider', providerKind: 'group', data: { label, rows }, parts: [] }
      : { ...rows[0]!, id, provenance, parts };
  state.groups.set(id, { rows, row });
  return row;
}
/**
 * Builds only visual groups; semantic event and tool reducers never depend on batch boundaries.
 * @param state - Source-local semantic reducer state.
 * @returns Ordered visible rows with preamble and bounded assistant groups.
 */
function projectRows(state: ClaudeProjectionState): ClaudeRow[] {
  const rows: ClaudeRow[] = [];
  const preamble: ClaudeRow[] = [];
  let gathering = true;
  let insertion: number | undefined;
  let ambient: ClaudeRow[] = [];
  let assistant: ClaudeRow[] = [];
  const flushAssistant = (): void => {
    if (assistant.length) rows.push(grouped(state, `${assistant[0]!.id}/assistant-group`, assistant));
    assistant = [];
  };
  const emit = (row: ClaudeRow, category: Segment['category']): void => {
    if (category === 'assistant') {
      gathering = false;
      const bucket = (value: ClaudeRow): number => Math.floor(((value.provenance[0]?.lineNumber ?? 1) - 1) / 128);
      if (assistant.length && bucket(assistant[0]!) !== bucket(row)) flushAssistant();
      assistant.push(row);
      return;
    }
    flushAssistant();
    if (gathering && category === 'service') preamble.push(row);
    else {
      if (gathering && category === 'user' && insertion === undefined) insertion = rows.length;
      rows.push(row);
    }
  };
  const flushAmbient = (): void => {
    if (ambient.length)
      emit(grouped(state, `${ambient[0]!.id}/ambient`, ambient, `Context · ${ambient.length} updates`), 'service');
    ambient = [];
  };
  for (const segment of state.segments) {
    if (segment.hidden) continue;
    if (segment.ambient) {
      flushAssistant();
      ambient.push(segment.row);
      continue;
    }
    flushAmbient();
    emit(segment.row, segment.category);
  }
  flushAmbient();
  flushAssistant();
  if (preamble.length) {
    const labels = preamble.filter((row) => row.kind === 'structural').map((row) => row.label);
    const mode = labels.find((label) => label.startsWith('Mode: '))?.slice(6);
    const title = labels.find((label) => label.startsWith('Title: '))?.slice(7);
    const leaves = preamble.flatMap((row) => row.parts);
    const hooks = leaves.filter(
      (part) =>
        part.kind === 'provider' && part.providerKind === 'attachment' && HOOK_TYPES.has(part.data.attachment.type)
    ).length;
    const skills = leaves.find(
      (part) =>
        part.kind === 'provider' && part.providerKind === 'attachment' && part.data.attachment.type === 'skill_listing'
    );
    const count =
      skills?.kind === 'provider' && skills.providerKind === 'attachment'
        ? (skills.data.attachment as unknown as Json)['skillCount']
        : undefined;
    const label = [
      'Session started',
      mode,
      title,
      typeof count === 'number' ? `${count} skill${count === 1 ? '' : 's'}` : '',
      hooks ? `${hooks} hook${hooks === 1 ? '' : 's'}` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    rows.splice(
      insertion ?? rows.length,
      0,
      grouped(state, sessionIdentity(state.source, 'claude-group', 'preamble'), preamble, label)
    );
  }
  return rows;
}
/** Claude's native projector; explicit caller generations are the only reset authority. */
export const claudeSessionProjector: NativeTranscriptProjector<ClaudeProjectionState, ParsedRecord, ClaudePayloads> = {
  providerId: 'claude-code',
  createState: (source) => ({
    source: { sourceKey: source.sourceKey, generation: source.generation },
    events: new Map(),
    segments: [],
    tools: new Map(),
    coordination: new Map(),
    header: { status: 'running' },
    groups: new Map()
  }),
  parseRecord(record) {
    if (!record.text.trim()) return {};
    try {
      const value = object(JSON.parse(record.text));
      return value && typeof value['type'] === 'string' ? { value } : { malformed: true };
    } catch {
      return { malformed: true };
    }
  },
  reduce(state, parsed, record) {
    if (!parsed.value && !parsed.malformed) return;
    const value = parsed.value ?? { type: 'malformed' };
    const uuid = string(value['uuid']);
    const canonical = JSON.stringify(value);
    const existing = uuid ? (state.events.get(uuid) ?? []) : [];
    const replay = existing.find((event) => JSON.stringify(event.value) === canonical);
    const provenance = { ...record.provenance, ...(uuid ? { nativeEventId: uuid } : {}) };
    if (replay) {
      replay.provenance.push(provenance);
      for (const segment of replay.segments)
        segment.row = {
          ...segment.row,
          provenance: [...replay.provenance],
          parts: segment.row.parts.map((part) => ({
            ...part,
            provenance: [...part.provenance, { ...provenance, selector: part.provenance[0]?.selector ?? 'record' }]
          }))
        };
      for (const id of replay.tools) refreshTool(state, tool(state, id));
      return;
    }
    const event: Event = {
      key: uuid && !existing.length ? `uuid/${uuid}` : `line/${record.provenance.lineNumber}`,
      value,
      text: record.text,
      provenance: [provenance],
      segments: [],
      tools: new Set()
    };
    if (uuid) state.events.set(uuid, [...existing, event]);
    if (existing.length)
      add(state, event, 'conflict', 'service', [
        detail(state, event, 'conflict', 'conflicting-id', `Conflicting event ID · ${uuid}`)
      ]);
    if (parsed.malformed) {
      add(state, event, 'malformed', 'service', [
        detail(state, event, 'malformed', 'malformed', 'Malformed native record')
      ]);
      return;
    }
    try {
      if (value['type'] === 'user' || value['type'] === 'assistant') content(state, event);
      else if (value['type'] === 'attachment') attachment(state, event);
      else structural(state, event);
      if (
        (value['type'] === 'user' || value['type'] === 'assistant') &&
        !event.tools.size &&
        value['isMeta'] !== true
      ) {
        const last = event.segments.at(-1);
        // A status recategorized as a message already carries this record's details.
        if (
          last &&
          (last.category === 'user' || last.category === 'assistant') &&
          !last.row.parts.some((part) => part.kind === 'raw' && part.semanticKey === event.key)
        )
          last.row = { ...last.row, parts: [...last.row.parts, detail(state, event)] };
      }
    } catch {
      add(state, event, 'invalid-shape', 'service', [
        detail(state, event, 'invalid-shape', 'malformed', 'Malformed native record fields')
      ]);
    }
  },
  project(state, source) {
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      rows: projectRows(state),
      header: {
        ...state.header,
        // Stream lifecycle closure is authoritative when interactive transcripts omit a result.
        // Derive rather than persist this fallback so a resumed stream returns to running.
        status: state.header.status === 'running' && source.meta?.isActive === false ? 'done' : state.header.status,
        ...(source.meta?.role === 'subagent' || source.meta?.role === 'auxiliary'
          ? { agentId: source.meta.agentId }
          : {})
      }
    };
  }
};

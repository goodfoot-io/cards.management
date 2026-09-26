/**
 * Pure transform: Codex rollout JSONL lines → rendered transcript items.
 *
 * This module converts an array of raw rollout JSONL strings into a list of
 * {@link TranscriptItem} values that the `CodexExpandedView` renders. The
 * transform is stateless and rebuilds from scratch on every call, so an
 * incremental append or a file reset produces correct output from the
 * replacement lines alone.
 *
 * Three defensive contracts hold throughout:
 * 1. `function_call.arguments` is a raw string — pretty-print is attempted
 *    inside a try/catch and falls back to the raw string on failure.
 * 2. `function_call_output.output` is `string | ContentItem[]` — both shapes
 *    are handled without throwing on the other.
 * 3. Orphan `function_call_output` (no preceding `function_call` with a
 *    matching `call_id`) is rendered standalone in source order, not dropped.
 *
 * @summary Pure transform from raw Codex rollout lines to rendered transcript items
 * @module streams/codex-session/www/lib/render-transcript
 */

import { countImageItems, createTurnDedupMatcher, extractMessageText } from './dedup.js';
import type { ContentItem, EventMsgPayload, ResponseItemPayload } from './parser.js';
import { type CodexRolloutLine, parseCodexLine } from './parser.js';

/** Expanded Codex JSON presentation stays raw beyond the shared 65,536-character paging threshold. */
const MAX_PRETTY_ARGUMENT_CHARS = 65_536;

/**
 * A rendered transcript item produced by {@link renderCodexTranscript}.
 */
export type TranscriptItem =
  | { kind: 'session_header'; model?: string; provider?: string; threadId?: string; cwd?: string; timestamp?: string }
  | { kind: 'user_message'; text: string; imageCount?: number; timestamp?: string }
  | {
      kind: 'assistant_message';
      text: string;
      imageCount?: number;
      timestamp?: string;
      /**
       * Set to `'developer'` when this message's source `response_item` carried
       * `role: 'developer'` (a Codex-injected instructions blob — e.g. the
       * `<permissions instructions>` block — folded into this kind because
       * Codex's own protocol has no separate "developer message" transcript
       * concept). Omitted (rather than `'assistant'`) for genuine assistant
       * output, so existing structural-equality fixtures asserting a plain
       * `{ kind: 'assistant_message', text }` are unaffected. The converter's
       * session-preamble projection (./project-session.ts) is the reader of this field.
       */
      role?: 'developer';
    }
  | { kind: 'reasoning'; summaryText: string; contentText?: string; timestamp?: string }
  | {
      kind: 'tool_call';
      name: string;
      callId: string;
      argumentsText: string;
      argsLabel?: string;
      prettyPrinted: boolean;
      outputText?: string;
      hasOutput: boolean;
      /** Count of `input_image` items dropped from an array-shaped paired output's text extraction. */
      outputImageCount?: number;
      /** Failure escalation for the collapsed-header row (see {@link shellExitSeverity}). */
      severity?: 'normal' | 'error';
      /** Preview text shown when `severity` is `'error'` (e.g. `'✗ exit 1'`, `'patch failed'`). */
      errorLabel?: string;
      /** Original native line for oversized object-shaped input, formatted only after opening the disclosure. */
      deferredArgumentsRecord?: string;
      timestamp?: string;
    }
  | { kind: 'orphan_output'; callId: string; outputText: string; imageCount?: number; timestamp?: string }
  | { kind: 'turn_boundary'; turnId?: string; timestamp?: string }
  | { kind: 'compaction'; message: string; timestamp?: string }
  | { kind: 'event_activity'; label: string; detailText?: string; timestamp?: string }
  | { kind: 'error'; message: string; timestamp?: string }
  | { kind: 'task_started'; turnId?: string; timestamp?: string }
  | { kind: 'task_complete'; durationMs?: number; lastAgentMessage?: string; timestamp?: string }
  | { kind: 'unknown_item'; raw: unknown; timestamp?: string }
  | { kind: 'malformed'; rawLine: string };

/**
 * Converts raw rollout JSONL lines into a flat list of transcript items.
 *
 * Source order is preserved. `function_call` and `function_call_output` are
 * paired by `call_id` when available; unpaired calls render without an output
 * block; orphan outputs render standalone in source order. Malformed lines
 * produce an isolated error block so the rest of the transcript is unaffected.
 *
 * @param lines - Raw rollout JSONL lines from the stream store.
 * @returns Flat list of transcript items in display order.
 */
export function renderCodexTranscript(lines: string[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // Tracks the index in `items` of each emitted tool_call so a later output can
  // be attached to its originating call in place, preserving source order.
  const callItemIndex = new Map<string, number>();
  // Bidirectional, order-independent turn-scoped dedup matcher.
  // Works regardless of whether response_item or event_msg arrives first.
  const dedup = createTurnDedupMatcher();
  // Index of the emitted session_header, so the model (absent on SessionMeta)
  // can be back-patched from the first turn_context that carries one.
  let headerIndex: number | undefined;

  for (const raw of lines) {
    const line = parseCodexLine(raw);

    // Maintain the turn-scoped window for deduplication.
    if (line.kind === 'turn_context') {
      dedup.reset();
      // Back-patch the header model from the first turn_context carrying one.
      if (headerIndex !== undefined && typeof line.payload.model === 'string') {
        const header = items[headerIndex];
        if (header !== undefined && header.kind === 'session_header' && header.model === undefined) {
          header.model = line.payload.model;
        }
      }
    } else if (line.kind === 'response_item') {
      // Suppress response_item messages that mirror an already-seen event_msg.
      if (dedup.processResponseItem(line.payload)) {
        continue;
      }
    } else if (line.kind === 'event_msg') {
      // Suppress event_msg messages that mirror a same-turn response_item message.
      if (dedup.processEventMsg(line.payload)) {
        continue;
      }
    }

    // A failed patch_apply_end escalates its originating apply_patch tool_call
    // row (looked up by call_id in the same callItemIndex map used for output
    // pairing below). The standalone event_activity rendering (eventActivity,
    // case 'patch_apply_end') is independent of this and still emitted. Cast to
    // a loosely-typed record (as the eventMsgToItems/responseItemToItems
    // switches do above) rather than relying on `.type ===` narrowing, since
    // EventMsgPayload's open-ended `{ type: string; [key: string]: unknown }`
    // catch-all member widens `call_id` to `unknown` under real narrowing.
    if (line.kind === 'event_msg') {
      const eventPayload = line.payload as Record<string, unknown> & { type: string };
      if (
        eventPayload.type === 'patch_apply_end' &&
        eventPayload['success'] === false &&
        typeof eventPayload['call_id'] === 'string'
      ) {
        const callIdx = callItemIndex.get(eventPayload['call_id']);
        if (callIdx !== undefined) {
          const target = items[callIdx];
          if (target !== undefined && target.kind === 'tool_call') {
            target.severity = 'error';
            target.errorLabel = 'patch failed';
          }
        }
      }
    }

    const produced = lineToItems(line, raw);

    for (const item of produced) {
      if (item.kind === 'tool_call') {
        callItemIndex.set(item.callId, items.length);
        items.push(item);
      } else if (item.kind === 'orphan_output') {
        // Attach to a preceding call when one exists; otherwise render standalone.
        const callIdx = callItemIndex.get(item.callId);
        if (callIdx !== undefined) {
          const target = items[callIdx];
          if (target !== undefined && target.kind === 'tool_call') {
            target.outputText = item.outputText;
            target.hasOutput = true;
            target.outputImageCount = item.imageCount;
            if (target.name === 'shell' || target.name === 'local_shell_call') {
              const outcome = shellExitSeverity(target.outputText);
              target.severity = outcome.severity;
              target.errorLabel = outcome.errorLabel;
            }
            continue;
          }
        }
        items.push(item);
      } else {
        if (item.kind === 'session_header' && headerIndex === undefined) {
          headerIndex = items.length;
        }
        items.push(item);
      }
    }
  }

  return items;
}

/**
 * Extracts the per-variant display fields of a tool-call `response_item`.
 *
 * Centralizes the protocol-faithful read for every tool-call variant so the
 * renderer surfaces the field Codex actually writes (e.g. `custom_tool_call`
 * carries `input`, `local_shell_call` carries `action.command`, etc.) rather
 * than always reading `arguments`. `argsLabel` names the surfaced field so the
 * view can label it correctly. All reads are defensive — no `JSON.parse`
 * outside {@link parseArguments}'s try/catch.
 *
 * @param payload - A tool-call `response_item` payload (`payload.type` selects the variant).
 * @param nativeRecord - Original JSONL line used to defer oversized object-shaped input.
 * @returns The tool name, surfaced field label and text, formatting state, and any deferred native record.
 */
export function extractToolCall(
  payload: Record<string, unknown> & { type: string },
  nativeRecord?: string
): {
  name: string;
  argsLabel: string;
  argumentsText: string;
  prettyPrinted: boolean;
  deferredArgumentsRecord?: string;
} {
  const nameField = typeof payload['name'] === 'string' ? payload['name'] : payload.type;

  switch (payload.type) {
    case 'function_call': {
      const rawArgs = typeof payload['arguments'] === 'string' ? payload['arguments'] : '';
      const { text, prettyPrinted } = parseArguments(rawArgs);
      return { name: nameField, argsLabel: 'arguments', argumentsText: text, prettyPrinted };
    }

    case 'custom_tool_call': {
      // `input` is free-form: a JSON-schema custom tool sends JSON (pretty-print
      // it), while `apply_patch` sends raw patch syntax (`*** Begin Patch...`)
      // that never parses as JSON and falls back to raw text automatically —
      // no need to special-case the tool name.
      const input = typeof payload['input'] === 'string' ? payload['input'] : '';
      const { text, prettyPrinted } = parseArguments(input);
      return { name: nameField, argsLabel: 'input', argumentsText: text, prettyPrinted };
    }

    case 'local_shell_call': {
      const command = extractShellCommand(payload['action']);
      return { name: payload.type, argsLabel: 'command', argumentsText: command, prettyPrinted: false };
    }

    case 'web_search_call': {
      const { text, label } = extractWebSearch(payload['action']);
      return { name: payload.type, argsLabel: label, argumentsText: text, prettyPrinted: false };
    }

    case 'image_generation_call': {
      const parts: string[] = [];
      if (typeof payload['revised_prompt'] === 'string' && payload['revised_prompt'].length > 0) {
        parts.push(payload['revised_prompt']);
      }
      if (typeof payload['result'] === 'string' && payload['result'].length > 0) {
        parts.push(payload['result']);
      }
      return { name: payload.type, argsLabel: 'image', argumentsText: parts.join('\n'), prettyPrinted: false };
    }

    case 'tool_search_call': {
      const argsObj = payload['arguments'];
      if (argsObj !== undefined && nativeRecord !== undefined && nativeRecord.length > MAX_PRETTY_ARGUMENT_CHARS) {
        return {
          name: nameField,
          argsLabel: 'arguments',
          argumentsText: '',
          prettyPrinted: false,
          deferredArgumentsRecord: nativeRecord
        };
      }
      let text = argsObj === undefined ? '' : JSON.stringify(argsObj, null, 2);
      if (typeof payload['execution'] === 'string' && payload['execution'].length > 0) {
        text = text.length > 0 ? `${text}\nexecution: ${payload['execution']}` : `execution: ${payload['execution']}`;
      }
      return { name: nameField, argsLabel: 'arguments', argumentsText: text, prettyPrinted: argsObj !== undefined };
    }

    default: {
      const rawArgs = typeof payload['arguments'] === 'string' ? payload['arguments'] : '';
      const { text, prettyPrinted } = parseArguments(rawArgs);
      return { name: nameField, argsLabel: 'arguments', argumentsText: text, prettyPrinted };
    }
  }
}

/**
 * Reads the joined shell command from a `local_shell_call` `action`.
 *
 * Only the `exec` action shape (`{ type: 'exec', command: string[] }`) carries a
 * command; all reads are defensive and a non-conforming action yields `''`.
 *
 * @param action - The `local_shell_call.action` value (shape not guaranteed).
 * @returns The space-joined command, or `''` when unavailable.
 */
function extractShellCommand(action: unknown): string {
  if (action === null || typeof action !== 'object') {
    return '';
  }
  const a = action as { type?: unknown; command?: unknown };
  if (a.type === 'exec' && Array.isArray(a.command) && a.command.every((c) => typeof c === 'string')) {
    return (a.command as string[]).join(' ');
  }
  return '';
}

/**
 * Reads the searched term/url from a `web_search_call` `action`.
 *
 * Handles the `search` (`query`/`queries`), `open_page`/`find_in_page` (`url`,
 * `pattern`) shapes defensively; an unrecognized action yields empty text.
 *
 * @param action - The `web_search_call.action` value (shape not guaranteed).
 * @returns The display text and the label (`query` or `url`) for it.
 */
function extractWebSearch(action: unknown): { text: string; label: string } {
  if (action === null || typeof action !== 'object') {
    return { text: '', label: 'query' };
  }
  const a = action as { query?: unknown; queries?: unknown; url?: unknown; pattern?: unknown };
  if (typeof a.query === 'string' && a.query.length > 0) {
    return { text: a.query, label: 'query' };
  }
  if (Array.isArray(a.queries) && a.queries.every((q) => typeof q === 'string')) {
    return { text: (a.queries as string[]).join(', '), label: 'query' };
  }
  if (typeof a.url === 'string' && a.url.length > 0) {
    const text = typeof a.pattern === 'string' && a.pattern.length > 0 ? `${a.url} (${a.pattern})` : a.url;
    return { text, label: 'url' };
  }
  return { text: '', label: 'query' };
}

/**
 * Maps a persisted high-level `event_msg` (e.g. `mcp_tool_call_end`,
 * `web_search_end`, `image_generation_end`, `patch_apply_end`, plan
 * `item_completed`) to an `event_activity` transcript item, or `undefined`
 * when the event has no activity rendering.
 *
 * The returned item carries no timestamp; the caller stamps it.
 *
 * @param payload - An `event_msg` payload (`payload.type` selects the event).
 * @param nativeRecord - Original JSONL line used to retain oversized object details.
 * @returns An `event_activity` item (without timestamp), or `undefined` to skip.
 */
export function eventActivity(
  payload: Record<string, unknown> & { type: string },
  nativeRecord?: string
): Extract<TranscriptItem, { kind: 'event_activity' }> | undefined {
  switch (payload.type) {
    case 'mcp_tool_call_end': {
      const invocation = payload['invocation'];
      let server = '';
      let tool = '';
      let args: unknown;
      if (invocation !== null && typeof invocation === 'object') {
        const inv = invocation as { server?: unknown; tool?: unknown; arguments?: unknown };
        server = typeof inv.server === 'string' ? inv.server : '';
        tool = typeof inv.tool === 'string' ? inv.tool : '';
        args = inv.arguments;
      }
      if (nativeRecord !== undefined && nativeRecord.length > MAX_PRETTY_ARGUMENT_CHARS) {
        return { kind: 'event_activity', label: `mcp: ${server}.${tool}`, detailText: nativeRecord };
      }
      const detailParts: string[] = [];
      if (args !== undefined) {
        detailParts.push(`arguments: ${JSON.stringify(args, null, 2)}`);
      }
      if (payload['result'] !== undefined) {
        detailParts.push(`result: ${JSON.stringify(payload['result'], null, 2)}`);
      }
      return {
        kind: 'event_activity',
        label: `mcp: ${server}.${tool}`,
        detailText: detailParts.length > 0 ? detailParts.join('\n') : undefined
      };
    }

    case 'web_search_end': {
      const query = typeof payload['query'] === 'string' ? payload['query'] : '';
      return {
        kind: 'event_activity',
        label: 'web_search',
        detailText: query.length > 0 ? query : undefined
      };
    }

    case 'image_generation_end': {
      const parts: string[] = [];
      if (typeof payload['revised_prompt'] === 'string' && payload['revised_prompt'].length > 0) {
        parts.push(payload['revised_prompt']);
      }
      if (typeof payload['result'] === 'string' && payload['result'].length > 0) {
        parts.push(payload['result']);
      }
      return {
        kind: 'event_activity',
        label: 'image_generation',
        detailText: parts.length > 0 ? parts.join('\n') : undefined
      };
    }

    case 'patch_apply_end': {
      const stdout = typeof payload['stdout'] === 'string' ? payload['stdout'] : '';
      const stderr = typeof payload['stderr'] === 'string' ? payload['stderr'] : '';
      const success = typeof payload['success'] === 'boolean' ? payload['success'] : undefined;
      const parts: string[] = [];
      if (success !== undefined) {
        parts.push(`success: ${success}`);
      }
      if (stdout.length > 0) {
        parts.push(stdout);
      }
      if (stderr.length > 0) {
        parts.push(stderr);
      }
      return {
        kind: 'event_activity',
        label: 'patch_apply',
        detailText: parts.length > 0 ? parts.join('\n') : undefined
      };
    }

    case 'item_completed': {
      const summary = summarizePlanItem(payload['item']);
      if (summary === undefined) {
        return undefined;
      }
      return { kind: 'event_activity', label: 'plan_update', detailText: summary };
    }

    default:
      return undefined;
  }
}

/**
 * Summarizes a persisted `item_completed.item` for plan updates.
 *
 * The Codex persistence policy persists `ItemCompleted` only for `Plan`
 * variants. `TurnItem::Plan(PlanItem)` serializes (internally-tagged, fields
 * flattened beside the tag) as `{ "type": "Plan", "id": "...", "text": "..." }`.
 * There is no `plan`/`steps` array; the plan text lives directly on `item.text`.
 *
 * Returns `item.text` when `item.type === 'Plan'` and `item.text` is a
 * non-empty string; returns `undefined` otherwise so the caller skips the item.
 * All reads are defensive.
 *
 * @param item - The `item_completed.item` value (shape not guaranteed).
 * @returns The plan text string, or `undefined` when not a plan item.
 */
function summarizePlanItem(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') {
    return undefined;
  }
  const obj = item as { type?: unknown; text?: unknown };
  if (obj.type !== 'Plan') {
    return undefined;
  }
  const text = obj.text;
  if (typeof text !== 'string' || text.length === 0) {
    return undefined;
  }
  return text;
}

/**
 * Parses a `function_call.arguments` raw string for display.
 *
 * Attempts `JSON.parse` and pretty-prints values within the session paging
 * threshold. Larger strings stay unchanged, and invalid JSON falls back to
 * its raw form without throwing or blanking output.
 *
 * @param raw - The raw arguments string from the `function_call` payload.
 * @returns `{ text, prettyPrinted }` — the display string and whether it was pretty-printed.
 */
export function parseArguments(raw: string): { text: string; prettyPrinted: boolean } {
  if (raw.length > MAX_PRETTY_ARGUMENT_CHARS) return { text: raw, prettyPrinted: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    return { text: JSON.stringify(parsed, null, 2), prettyPrinted: true };
  } catch {
    return { text: raw, prettyPrinted: false };
  }
}

/**
 * Extracts a flat display string from a `function_call_output` or
 * `custom_tool_call_output` output value (`string | ContentItem[]`).
 *
 * A plain string is returned as-is. A `ContentItem[]` has its `input_text`
 * and `output_text` items concatenated in source order. `input_image` items
 * are dropped from this text (see {@link extractMessageText}) — callers pair
 * this with {@link extractOutputImageCount} so the dropped count can be
 * rendered as a visible placeholder rather than being silently lost. Neither
 * shape throws on the other.
 *
 * @param output - The output value from the function call output payload.
 * @returns The flat display string.
 */
export function extractOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return extractMessageText(output as ContentItem[]);
  }
  return '';
}

/**
 * Counts the `input_image` items an array-shaped output value carries, so a
 * caller can render a visible placeholder for what {@link extractOutputText}
 * drops from its text concatenation. A string output (never an array) has no
 * images to count.
 *
 * @param output - The output value from the function call output payload.
 * @returns The number of `input_image` items, or `0` for a string output.
 */
export function extractOutputImageCount(output: unknown): number {
  return Array.isArray(output) ? countImageItems(output as ContentItem[]) : 0;
}

/**
 * Returns `count` when positive, or `undefined` — the convention this module
 * follows throughout for optional numeric fields (a missing count is omitted
 * rather than rendered as a literal `0`).
 *
 * @param count - The raw count.
 * @returns `count` when `> 0`, otherwise `undefined`.
 */
function positiveOrUndefined(count: number): number | undefined {
  return count > 0 ? count : undefined;
}

/**
 * Matches a shell exit-code line inside a tool_call's output text (Codex shell
 * exit codes are not structured — they only appear as text). Captures the
 * (possibly negative) exit code.
 */
const SHELL_EXIT_CODE_RE = /^(?:Exit code|Process exited with code):?\s*(-?\d+)/m;

/**
 * Classifies a shell (`shell` / `local_shell_call`) tool_call's severity from
 * its paired output text.
 *
 * Codex shell exit codes are not structured — they appear only as a line of
 * text inside `outputText` matching `/^(?:Exit code|Process exited with
 * code):?\s*(-?\d+)/m`. A non-zero matched code escalates to `'error'` with an
 * `'✗ exit N'` label; a missing match, an unparseable code, or exit code `0`
 * stays `'normal'`.
 *
 * Scope boundary: only matches structured exit-code lines matching the regex
 * above. Shell failures producing different output — signals such as SIGKILL,
 * custom exit annotations, or differently-structured output — are not
 * classified and return `'normal'`.
 *
 * @param outputText - The tool_call's paired output text, or `undefined` when no output has arrived yet.
 * @returns The severity and, when escalated, the collapsed-header error label.
 */
export function shellExitSeverity(outputText: string | undefined): {
  severity: 'normal' | 'error';
  errorLabel?: string;
} {
  if (outputText === undefined) {
    return { severity: 'normal' };
  }
  const match = SHELL_EXIT_CODE_RE.exec(outputText);
  const code = match?.[1] === undefined ? undefined : Number(match[1]);
  if (code === undefined || Number.isNaN(code) || code === 0) {
    return { severity: 'normal' };
  }
  return { severity: 'error', errorLabel: `✗ exit ${code}` };
}

/**
 * Converts a {@link CodexRolloutLine} into zero or more transcript items.
 *
 * Accepts a pre-parsed line so callers can reuse a single parse pass.
 * Returns an empty array for lines that do not produce visible output
 * (e.g. `turn_context`, `compacted` markers); returns a single-element
 * array for most visible lines; may return more than one item only for
 * `response_item` lines that carry both a message and embedded reasoning.
 *
 * Deduplication (suppressing the later of a mirrored event_msg/response_item
 * message pair within a turn) is the caller's responsibility — callers should
 * filter through a {@link createTurnDedupMatcher} instance before passing the
 * line here.
 *
 * @param line - A pre-parsed Codex rollout line.
 * @param nativeRecord - Original JSONL line used to retain or defer oversized content.
 * @returns Zero or more transcript items derived from this line.
 */
export function lineToItems(line: CodexRolloutLine, nativeRecord?: string): TranscriptItem[] {
  switch (line.kind) {
    case 'malformed':
      return [{ kind: 'malformed', rawLine: line.raw }];

    case 'unknown':
      return [{ kind: 'unknown_item', raw: line.raw, timestamp: line.timestamp }];

    case 'session_meta':
      // The model is not on SessionMeta; it is back-patched from the first
      // turn_context that carries one (see renderCodexTranscript). Provider and
      // thread id come straight from the session_meta payload.
      return [
        {
          kind: 'session_header',
          provider: line.payload.model_provider,
          threadId: line.payload.id,
          cwd: line.payload.cwd,
          timestamp: line.timestamp === '' ? undefined : line.timestamp
        }
      ];

    case 'turn_context': {
      // A visible turn boundary. The dedup-window reset for turn_context is the
      // caller's responsibility (renderCodexTranscript); this only produces the
      // display item.
      const ts = line.timestamp === '' ? undefined : line.timestamp;
      return [{ kind: 'turn_boundary', turnId: line.payload.turn_id, timestamp: ts }];
    }

    case 'compacted': {
      const ts = line.timestamp === '' ? undefined : line.timestamp;
      const message = typeof line.payload.message === 'string' ? line.payload.message : '';
      return [{ kind: 'compaction', message, timestamp: ts }];
    }

    case 'event_msg':
      return eventMsgToItems(line.payload, line.timestamp, nativeRecord);

    case 'response_item':
      return responseItemToItems(line.payload, line.timestamp, nativeRecord);

    default:
      return [];
  }
}

/**
 * Converts an `event_msg` payload into zero or one transcript item.
 *
 * Only user/assistant message events render; token counts and lifecycle events
 * produce no standalone transcript entry here.
 *
 * @param rawPayload - The `event_msg` payload.
 * @param timestamp - The envelope timestamp (empty string when absent).
 * @param nativeRecord - Original JSONL line used for oversized raw activity details.
 * @returns Zero or one transcript item.
 */
function eventMsgToItems(rawPayload: EventMsgPayload, timestamp: string, nativeRecord?: string): TranscriptItem[] {
  const ts = timestamp === '' ? undefined : timestamp;
  const payload = rawPayload as Record<string, unknown> & { type: string };
  const message = typeof payload['message'] === 'string' ? payload['message'] : '';
  if (payload.type === 'agent_message') {
    return [{ kind: 'assistant_message', text: message, timestamp: ts }];
  }
  if (payload.type === 'user_message') {
    return [{ kind: 'user_message', text: message, timestamp: ts }];
  }
  if (payload.type === 'error') {
    // A session-level error event. Never dropped: an honest error signal must
    // stay visible, unlike the merely-unclassified content unknown/malformed
    // lines carry.
    return [{ kind: 'error', message, timestamp: ts }];
  }
  if (payload.type === 'task_started') {
    const turnId = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : undefined;
    return [{ kind: 'task_started', turnId, timestamp: ts }];
  }
  if (payload.type === 'task_complete') {
    const durationMs = typeof payload['duration_ms'] === 'number' ? payload['duration_ms'] : undefined;
    const lastAgentMessage =
      typeof payload['last_agent_message'] === 'string' ? payload['last_agent_message'] : undefined;
    return [{ kind: 'task_complete', durationMs, lastAgentMessage, timestamp: ts }];
  }
  // Persisted high-level tool-activity events (mcp/web_search/image/patch/plan)
  // render as event_activity; all other event_msg types (e.g. token_count,
  // folded separately into the compact card) produce no item.
  const activity = eventActivity(payload, nativeRecord);
  if (activity !== undefined) {
    return [{ ...activity, timestamp: ts }];
  }
  return [];
}

/**
 * Concatenates the `text` of `summary_text` items in a reasoning summary array.
 *
 * @param summary - The reasoning `summary` array.
 * @returns The concatenated summary text.
 */
function extractReasoningSummary(summary: unknown[]): string {
  let text = '';
  for (const item of summary) {
    if (item !== null && typeof item === 'object') {
      const candidate = item as { text?: unknown };
      if (typeof candidate.text === 'string') {
        text += candidate.text;
      }
    }
  }
  return text;
}

/**
 * Concatenates the `text` of `reasoning_text` / `text` items in a reasoning
 * `content` array (`ReasoningItemContent`, `models.rs` L1219).
 *
 * @param content - The reasoning `content` array.
 * @returns The concatenated content text.
 */
function extractReasoningContent(content: unknown[]): string {
  let text = '';
  for (const item of content) {
    if (item !== null && typeof item === 'object') {
      const candidate = item as { type?: unknown; text?: unknown };
      if ((candidate.type === 'reasoning_text' || candidate.type === 'text') && typeof candidate.text === 'string') {
        text += candidate.text;
      }
    }
  }
  return text;
}

/**
 * Converts a `response_item` payload into zero or more transcript items.
 *
 * Tool calls are emitted as `tool_call`; outputs are emitted as `orphan_output`
 * for the caller to pair by `call_id` or render standalone. Unknown nested
 * variants become a readable raw block.
 *
 * @param rawPayload - The `response_item` payload.
 * @param timestamp - The envelope timestamp (empty string when absent).
 * @param nativeRecord - Original JSONL line used to defer oversized object-shaped input.
 * @returns Zero or more transcript items.
 */
function responseItemToItems(
  rawPayload: ResponseItemPayload,
  timestamp: string,
  nativeRecord?: string
): TranscriptItem[] {
  const ts = timestamp === '' ? undefined : timestamp;
  const payload = rawPayload as Record<string, unknown> & { type: string };

  switch (payload.type) {
    case 'message': {
      const content = Array.isArray(payload['content']) ? (payload['content'] as ContentItem[]) : [];
      const text = extractMessageText(content);
      const imageCount = positiveOrUndefined(countImageItems(content));
      if (payload['role'] === 'user') {
        return [{ kind: 'user_message', text, imageCount, timestamp: ts }];
      }
      const role = payload['role'] === 'developer' ? ({ role: 'developer' } as const) : {};
      return [{ kind: 'assistant_message', text, imageCount, timestamp: ts, ...role }];
    }

    case 'reasoning': {
      const summary = Array.isArray(payload['summary']) ? payload['summary'] : [];
      const content = Array.isArray(payload['content']) ? payload['content'] : [];
      const contentText = extractReasoningContent(content);
      return [
        {
          kind: 'reasoning',
          summaryText: extractReasoningSummary(summary),
          contentText: contentText.length > 0 ? contentText : undefined,
          timestamp: ts
        }
      ];
    }

    case 'function_call':
    case 'local_shell_call':
    case 'custom_tool_call':
    case 'tool_search_call':
    case 'web_search_call':
    case 'image_generation_call': {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : '';
      const { name, argsLabel, argumentsText, prettyPrinted, deferredArgumentsRecord } = extractToolCall(
        payload,
        nativeRecord
      );
      return [
        {
          kind: 'tool_call',
          name,
          callId,
          argumentsText,
          argsLabel,
          prettyPrinted,
          ...(deferredArgumentsRecord === undefined ? {} : { deferredArgumentsRecord }),
          hasOutput: false,
          timestamp: ts
        }
      ];
    }

    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'tool_search_output': {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : '';
      const outputText = extractOutputText(payload['output']);
      const imageCount = positiveOrUndefined(extractOutputImageCount(payload['output']));
      return [{ kind: 'orphan_output', callId, outputText, imageCount, timestamp: ts }];
    }

    // Mid-turn compaction markers. These nested response_item variants carry
    // only an opaque `encrypted_content` — no human-readable message like the
    // root-level `compacted` line's `message` field — so they route to the
    // same compaction UI with an empty message body.
    case 'compaction':
    case 'compaction_trigger':
    case 'context_compaction':
      return [{ kind: 'compaction', message: '', timestamp: ts }];

    default:
      return [{ kind: 'unknown_item', raw: payload, timestamp: ts }];
  }
}

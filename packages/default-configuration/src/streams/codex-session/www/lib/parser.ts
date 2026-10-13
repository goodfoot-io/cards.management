/**
 * Defensive parser for Codex rollout JSONL lines.
 *
 * Each persisted rollout line is a UTC `timestamp` flattened together with a
 * `RolloutItem` (see `third_party/reference/codex/codex-rs/protocol/src/protocol.rs`
 * L2843-L2851), tagged by a snake_case `type` discriminator with the item body
 * under `payload`. The parser validates the root envelope without requiring any
 * nested payload field: unknown root types and unknown nested response/event
 * variants fall through to readable raw forms, and malformed JSONL is preserved
 * verbatim so the rest of the transcript survives a single bad line.
 *
 * All Rust `Option<T>` fields are modeled as `T | undefined`. Types are derived
 * from `protocol.rs` and `models.rs` at tag `rust-v0.137.0`.
 *
 * @summary Parses a Codex rollout JSONL line into a discriminated union
 * @module streams/codex-session/www/lib/parser
 */

/**
 * A single content item inside a `ResponseItem::Message` (`models.rs` L703-L716).
 *
 * `input_text` / `output_text` carry plain text; `input_image` carries an image
 * URL and optional detail hint. Text extraction concatenates the text variants.
 */
export type ContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: string; [key: string]: unknown };

/**
 * Output payload for `function_call_output` / `custom_tool_call_output`
 * (`models.rs` L808-L842). On the wire this is either a plain string or an array
 * of structured content items; both shapes must be handled without throwing on
 * the other.
 */
export type FunctionCallOutput = string | ContentItem[];

/**
 * Optional assistant-message phase (`models.rs` L735). Providers do not emit
 * this consistently, so it is never used as a reliable discriminator.
 */
export type MessagePhase = 'commentary' | 'final_answer';

/**
 * Discriminated union over the `payload.type` of a `response_item` line.
 *
 * Covers the presentation-relevant variants of `ResponseItem` (`models.rs`
 * L745-L898). Unknown future variants are caught by the open-ended final member
 * so the transcript can render a raw fallback rather than throwing.
 */
export type ResponseItemPayload =
  | { type: 'message'; role: string; content: ContentItem[]; phase?: MessagePhase }
  | { type: 'reasoning'; summary: unknown[]; content?: unknown[]; encrypted_content?: string }
  | {
      type: 'local_shell_call';
      call_id?: string;
      status: 'completed' | 'in_progress' | 'incomplete';
      action: unknown;
    }
  | { type: 'function_call'; name: string; namespace?: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; call_id: string; output: FunctionCallOutput }
  | { type: 'custom_tool_call'; status?: string; call_id: string; name: string; input: string }
  | { type: 'custom_tool_call_output'; call_id: string; name?: string; output: FunctionCallOutput }
  | { type: 'tool_search_call'; call_id?: string; status?: string; execution: string; arguments: unknown }
  | { type: 'tool_search_output'; call_id?: string; status: string; execution: string; tools: unknown[] }
  | { type: 'web_search_call'; status?: string; action?: unknown }
  | { type: 'image_generation_call'; id: string; status: string; revised_prompt?: string; result: string }
  | { type: 'compaction'; encrypted_content: string }
  | { type: 'compaction_trigger' }
  | { type: 'context_compaction'; encrypted_content?: string }
  | { type: string; [key: string]: unknown };

/**
 * Session metadata payload for a `session_meta` line (`SessionMeta`,
 * `protocol.rs` L2774).
 *
 * Flattens `SessionMeta` together with optional git info. `id` is the session's
 * `ThreadId` (the thread id), and `model_provider` is the optional provider id.
 * There is no `model` field here — the model lives on `TurnContextItem.model`.
 * All fields are treated as optional context — present-only header/context
 * information, never proof that a session or turn succeeded.
 */
export interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  git?: unknown;
  [key: string]: unknown;
}

/**
 * Compaction marker payload for a `compacted` line (`CompactedItem`,
 * `protocol.rs` L2854).
 *
 * `message` is the human-readable summary; `replacement_history` optionally
 * re-establishes context after mid-turn compaction.
 */
export interface CompactedPayload {
  message: string;
  replacement_history?: ResponseItemPayload[];
}

/**
 * Durable per-turn context baseline for a `turn_context` line (`TurnContextItem`,
 * `protocol.rs` L2884-L2920). Repeats once per real user turn and again after
 * compaction; the dedup window resets at each occurrence. `model` is required on
 * the wire (the model the turn ran under) and is the renderer's source of truth
 * for the session model.
 */
export interface TurnContextPayload {
  turn_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  current_date?: string;
  model?: string;
  [key: string]: unknown;
}

/**
 * Context snapshot carried by a root `world_state` line: a `full` baseline of
 * the instructions, environments, skills and permissions the model sees, or a
 * partial update of the changed keys. Every state key is optional on the wire.
 */
export interface WorldStatePayload {
  full?: boolean;
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Per-response token accounting carried by a root `token_usage_record` line. It
 * repeats the totals that the `event_msg` `token_count` event also reports.
 */
export interface TokenUsageRecordPayload {
  turn_id?: string;
  response_id?: string;
  usage?: TokenUsage;
  [key: string]: unknown;
}

/**
 * Token usage totals for an `event_msg` `token_count` event (`protocol.rs`
 * L1919-L1939, L2000-L2003).
 */
export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

/**
 * Discriminated union over the `payload.type` of an `event_msg` line.
 *
 * Covers the high-level events the renderer presents — user/assistant messages,
 * token counts, persisted tool-activity end events, and turn lifecycle markers
 * (`protocol.rs` L1160 onward). The open-ended final member preserves
 * unknown/future variants so they never invalidate the rest of the transcript.
 *
 * `AgentMessageEvent` does carry an optional `phase` (`protocol.rs` L2170-L2176);
 * the dedup discriminator deliberately omits it and matches structurally on the
 * message text instead, for robustness — providers do not emit `phase`
 * consistently, so keying on it would cause false negatives. The omission is a
 * design choice, not a reflection of the field being absent.
 */
export type EventMsgPayload =
  | { type: 'agent_message'; message: string; phase?: MessagePhase }
  | { type: 'user_message'; message: string; client_id?: string; images?: string[] }
  | { type: 'token_count'; info?: { total_token_usage: TokenUsage; last_token_usage: TokenUsage } }
  | { type: 'task_started'; turn_id?: string }
  | {
      type: 'task_complete';
      turn_id?: string;
      last_agent_message?: string;
      duration_ms?: number;
      [key: string]: unknown;
    }
  | { type: 'error'; message?: string }
  | {
      type: 'mcp_tool_call_end';
      call_id: string;
      invocation: { server: string; tool: string; arguments?: unknown };
      result?: unknown;
    }
  | { type: 'web_search_end'; call_id: string; query: string; action?: unknown }
  | { type: 'image_generation_end'; call_id: string; status: string; revised_prompt?: string; result: string }
  | { type: 'patch_apply_end'; call_id: string; stdout: string; stderr: string; success: boolean; status?: string }
  | { type: 'item_completed'; item: unknown }
  | { type: string; [key: string]: unknown };

/**
 * Result of parsing a single rollout JSONL line.
 *
 * The `unknown` member carries an unrecognized-but-valid root envelope (the
 * `timestamp` is preserved when present); `malformed` carries a line that was
 * not valid JSON or lacked a usable envelope, with the raw text retained so the
 * expanded view can render an isolated error block.
 */
export type CodexRolloutLine =
  | { kind: 'session_meta'; timestamp: string; payload: SessionMetaPayload }
  | { kind: 'response_item'; timestamp: string; payload: ResponseItemPayload }
  | { kind: 'compacted'; timestamp: string; payload: CompactedPayload }
  | { kind: 'turn_context'; timestamp: string; payload: TurnContextPayload }
  | { kind: 'event_msg'; timestamp: string; payload: EventMsgPayload }
  | { kind: 'world_state'; timestamp: string; payload: WorldStatePayload }
  | { kind: 'token_usage_record'; timestamp: string; payload: TokenUsageRecordPayload }
  | { kind: 'unknown'; timestamp?: string; raw: unknown }
  | { kind: 'malformed'; raw: string };

/**
 * The set of recognized root `type` discriminators for a rollout line.
 * Any other root type is preserved verbatim as a `kind: 'unknown'` result.
 */
const KNOWN_ROOT_TYPES = new Set([
  'session_meta',
  'response_item',
  'compacted',
  'turn_context',
  'event_msg',
  'world_state',
  'token_usage_record'
]);

/**
 * Reads a `string`-typed property from an arbitrary parsed object.
 *
 * @param obj - The parsed envelope object.
 * @param key - The property name.
 * @returns The string value, or `undefined` when absent or non-string.
 */
function readStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parses one raw rollout JSONL line into a {@link CodexRolloutLine}.
 *
 * Validates the root `{ timestamp, type, payload }` envelope without asserting
 * any nested payload shape. Invalid JSON or an unusable envelope yields
 * `{ kind: 'malformed', raw }`; an unrecognized root `type` yields
 * `{ kind: 'unknown', raw }`.
 *
 * @param raw - A single line of rollout JSONL.
 * @returns The discriminated parse result.
 */
export function parseCodexLine(raw: string): CodexRolloutLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed', raw };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', raw };
  }

  const envelope = parsed as Record<string, unknown>;
  const type = readStringField(envelope, 'type');
  if (type === undefined) {
    return { kind: 'malformed', raw };
  }

  const timestamp = readStringField(envelope, 'timestamp');

  if (!KNOWN_ROOT_TYPES.has(type)) {
    return { kind: 'unknown', timestamp, raw: parsed };
  }

  // A known root type without a usable timestamp is still rendered, defaulting
  // to an empty string rather than discarding an otherwise-valid line.
  const ts = timestamp ?? '';
  const payload = (envelope['payload'] ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'session_meta':
      return { kind: 'session_meta', timestamp: ts, payload: payload as SessionMetaPayload };
    case 'response_item':
      return { kind: 'response_item', timestamp: ts, payload: payload as ResponseItemPayload };
    case 'compacted':
      return { kind: 'compacted', timestamp: ts, payload: payload as unknown as CompactedPayload };
    case 'turn_context':
      return { kind: 'turn_context', timestamp: ts, payload: payload as TurnContextPayload };
    case 'event_msg':
      return { kind: 'event_msg', timestamp: ts, payload: payload as EventMsgPayload };
    case 'world_state':
      return { kind: 'world_state', timestamp: ts, payload: payload as WorldStatePayload };
    case 'token_usage_record':
      return { kind: 'token_usage_record', timestamp: ts, payload: payload as TokenUsageRecordPayload };
    default:
      return { kind: 'unknown', timestamp, raw: parsed };
  }
}

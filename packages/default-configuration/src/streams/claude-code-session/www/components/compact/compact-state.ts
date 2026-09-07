/**
 * Pure state machine for the compact claude-code-session view.
 *
 * Extracted from CompactView so that the state logic can be unit-tested
 * without a browser environment (streamStore requires window).
 *
 * @summary Compact session state types, factory, and reducer
 * @module components/compact/compact-state
 */

import { describeEvent, parseLineEvents, sanitizeHeadline } from '../../lib';
import type { CompactEvent, ContentBlock } from '../../lib/parse-session';

/** Tool names whose `input.file_path` represents a file the session touched. */
const FILE_TOUCH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** Rolling cap on {@link CompactState.tail}; the split panel shows the last 3. */
const TAIL_CAP = 6;

export interface CompactState {
  hasErrors: boolean;
  isSubagent: boolean;
  /** Agent identifier for a subagent/auxiliary stream, from the sidecar `agentId` field. Absent for main streams. */
  agentId?: string;
  durationS: number;
  /**
   * Rolling buffer of the most recent renderable events (newest last), capped at
   * {@link TAIL_CAP}. Infrastructure tool calls are dropped so the panel stays
   * meaningful; text, errors, `Agent`, `SendMessage`, and read/write tools enter.
   */
  tail: CompactEvent[];
  turnCount: number;
  outputTokensTotal: number;
  totalDurationMs: number;
  errorCount: number;
  awaySummary: string;
  /** Top-level `uuid`s already folded in, so the doubled transcript counts once. */
  seenUuids: Set<string>;
  /**
   * Assistant `message.id`s whose `usage` has been added to the token totals. The
   * producer splits one message across one line per content block — each a
   * distinct `uuid` but the same `message.id` — and repeats `usage` on every
   * line, so tokens are summed once per message id, not once per block line.
   */
  seenUsageMessageIds: Set<string>;
  /** De-duplicated count of `tool_use` blocks across assistant and subagent turns. */
  toolCallCount: number;
  /** De-duplicated count of `Agent` tool calls (sub-agent dispatches). */
  subagentCount: number;
  /** Distinct file paths written via Edit/Write/MultiEdit. */
  filesTouched: Set<string>;
  /** Latest assistant `message.model`, with any leading `claude-` prefix stripped. */
  model: string;
  /** Σ `message.usage.input_tokens`, de-duplicated by line `uuid`. */
  inputTokensTotal: number;
  /** Earliest line `timestamp` in epoch ms; 0 when unset. */
  firstTimestamp: number;
  /** Latest line `timestamp` in epoch ms; 0 when unset. */
  lastTimestamp: number;
  /** Most recent sanitized assistant text, used as a headline fallback. */
  lastAssistantText: string;
}

/**
 * Creates a fresh compact state with all fields set to their initial defaults.
 * @returns Initial compact state.
 */
export function makeInitialState(): CompactState {
  return {
    hasErrors: false,
    isSubagent: false,
    durationS: 0,
    tail: [],
    turnCount: 0,
    outputTokensTotal: 0,
    totalDurationMs: 0,
    errorCount: 0,
    awaySummary: '',
    seenUuids: new Set<string>(),
    seenUsageMessageIds: new Set<string>(),
    toolCallCount: 0,
    subagentCount: 0,
    filesTouched: new Set<string>(),
    model: '',
    inputTokensTotal: 0,
    firstTimestamp: 0,
    lastTimestamp: 0,
    lastAssistantText: ''
  };
}

/**
 * Selects the compact headline: the first non-empty of the sanitized
 * `away_summary`, the sanitized last assistant text, and the latest renderable
 * tail event (scanning from the end of {@link CompactState.tail}).
 *
 * The final fallback covers tool-only / subagent / slash-command sessions that
 * carry no genuine assistant prose: a `tool-call` becomes `<Tool> <summary>`
 * (e.g. `Agent Plan failure-mode review`), an `error` its message, and a `text`
 * event its sanitized prose — so the recap row is never a blank box when the
 * tail has anything to show. Text events still run through {@link sanitizeHeadline}
 * (skipping control traffic); tool/error events are already structured, so they
 * surface via {@link describeEvent} directly. When the tail is empty and there
 * is no prose (the degenerate slash-command-only session), the result is `''`
 * and the caller renders nothing for line 2.
 *
 * The pure {@link sanitizeHeadline} rule lives in `lib/sanitize`; this selector
 * is type-bound to {@link CompactState} and so stays here.
 *
 * @param state - The compact state to read from.
 * @returns The headline string, or `''` when no genuine prose is available.
 */
export function headline(state: CompactState): string {
  const fromAway = sanitizeHeadline(state.awaySummary);
  if (fromAway) return fromAway;
  const fromAssistant = sanitizeHeadline(state.lastAssistantText);
  if (fromAssistant) return fromAssistant;
  for (let i = state.tail.length - 1; i >= 0; i--) {
    const evt = state.tail[i];
    if (!evt) continue;
    if (evt.kind === 'text') {
      const fromTail = sanitizeHeadline(evt.text);
      if (fromTail) return fromTail;
      continue;
    }
    const described = describeEvent(evt);
    if (described) return described;
  }
  return '';
}

/**
 * Parses an ISO `timestamp` into epoch ms, or `null` when absent/unparseable.
 * @param value - Raw `timestamp` field (expected ISO string).
 * @returns Epoch milliseconds, or null.
 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Processes a single JSONL line into the mutable compact state.
 * @param state - The mutable compact state to update in place.
 * @param line - Raw JSONL line string to process.
 */
export function processLine(state: CompactState, line: string): void {
  if (!line?.trim()) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // De-dup first: the transcript is double-written, so every `uuid` arrives
  // twice. Fold each unique `uuid` once; the doubled copy is skipped before
  // any tally (turns, tokens, tool calls) can be inflated. Lines without a
  // `uuid` (e.g. some system/result lines) are never skipped.
  const uuid = msg['uuid'];
  if (typeof uuid === 'string' && uuid) {
    if (state.seenUuids.has(uuid)) return;
    state.seenUuids.add(uuid);
  }

  // Track the timestamp span (epoch ms) across all folded lines.
  const ts = parseTimestamp(msg['timestamp']);
  if (ts !== null) {
    state.firstTimestamp = state.firstTimestamp === 0 ? ts : Math.min(state.firstTimestamp, ts);
    state.lastTimestamp = Math.max(state.lastTimestamp, ts);
  }

  // Capture the model from assistant lines (latest wins), stripping the
  // display-noise `claude-` prefix (e.g. `claude-opus-4-8` → `opus-4-8`).
  if (msg['type'] === 'assistant') {
    const model = (msg['message'] as Record<string, unknown> | undefined)?.['model'];
    if (typeof model === 'string' && model) {
      state.model = model.startsWith('claude-') ? model.slice('claude-'.length) : model;
    }
  }

  // Extract away_summary content
  if (msg['type'] === 'system' && msg['subtype'] === 'away_summary') {
    const content = msg['content'];
    if (typeof content === 'string' && content.trim()) {
      state.awaySummary = content.trim();
    }
  }

  // Collect distinct Edit/Write/MultiEdit file paths from this line's tool_use
  // blocks (assistant content and subagent progress content).
  collectTouchedFiles(state, msg);

  const events = parseLineEvents(line);
  for (const evt of events) {
    switch (evt.kind) {
      case 'tool-call':
      case 'text':
      case 'error':
      case 'subagent-tool-call': {
        if (evt.kind === 'tool-call' || evt.kind === 'subagent-tool-call') {
          state.toolCallCount++;
        }
        // Sub-agents are top-level `Agent` dispatches only — never the
        // `subagent-tool-call` progress lines emitted from inside a subagent.
        if (evt.kind === 'tool-call' && evt.toolName === 'Agent') {
          state.subagentCount++;
        }
        if (evt.kind === 'text' && evt.role === 'assistant') {
          const sanitized = sanitizeHeadline(evt.text);
          if (sanitized) state.lastAssistantText = sanitized;
        }
        if (evt.kind === 'error') {
          state.errorCount++;
          state.hasErrors = true;
        }
        // Drop infrastructure tool calls from the rolling tail so the latest-
        // lines panel stays meaningful; text, errors, `Agent`, `SendMessage`,
        // and read/write tools all enter. Trim to the last TAIL_CAP on push.
        if ((evt.kind === 'tool-call' || evt.kind === 'subagent-tool-call') && evt.isInfrastructure) {
          break;
        }
        state.tail.push(evt);
        if (state.tail.length > TAIL_CAP) state.tail.splice(0, state.tail.length - TAIL_CAP);
        break;
      }
      case 'turn-duration':
        state.totalDurationMs += evt.durationMs;
        state.turnCount++;
        break;
      case 'usage': {
        // `usage` repeats verbatim on every per-content-block line of one
        // message, so count it once per `message.id`. When the id is absent
        // (legacy lines), count once as before — absence is rare.
        if (evt.messageId != null) {
          if (state.seenUsageMessageIds.has(evt.messageId)) break;
          state.seenUsageMessageIds.add(evt.messageId);
        }
        state.outputTokensTotal += evt.outputTokens;
        if (evt.inputTokens != null) state.inputTokensTotal += evt.inputTokens;
        break;
      }
      case 'result':
        state.turnCount = evt.turns;
        state.durationS = evt.durationS;
        break;
    }
  }
}

/**
 * Adds the `file_path` of every Edit/Write/MultiEdit `tool_use` block in this
 * line to {@link CompactState.filesTouched}. Walks both the assistant
 * `message.content` and subagent `data.content` block arrays.
 *
 * @param state - The mutable compact state to update.
 * @param msg - The parsed JSONL line.
 */
function collectTouchedFiles(state: CompactState, msg: Record<string, unknown>): void {
  const blockArrays: unknown[] = [];
  const message = msg['message'] as Record<string, unknown> | undefined;
  if (message && Array.isArray(message['content'])) blockArrays.push(message['content']);
  const data = msg['data'] as Record<string, unknown> | undefined;
  if (data && Array.isArray(data['content'])) blockArrays.push(data['content']);

  for (const blocks of blockArrays) {
    for (const block of blocks as ContentBlock[]) {
      if (block?.type !== 'tool_use' || !FILE_TOUCH_TOOLS.has(block.name)) continue;
      const filePath = (block.input as Record<string, unknown> | undefined)?.['file_path'];
      if (typeof filePath === 'string' && filePath) state.filesTouched.add(filePath);
    }
  }
}

/**
 * Builds the full compact state from an array of JSONL lines.
 * @param lines - Array of raw JSONL lines to process.
 * @param role - The primary stream's sidecar `role` (`'main'`/`'subagent'`/`'auxiliary'`), used to label subagent sessions instead of any filename shape.
 * @param agentId - The primary stream's sidecar `agentId`, present for subagent/auxiliary streams.
 * @returns Fully populated compact state derived from all lines.
 */
export function buildState(lines: string[], role: string | undefined, agentId?: string): CompactState {
  const state = makeInitialState();
  state.isSubagent = role === 'subagent' || role === 'auxiliary';
  state.agentId = agentId;
  for (const line of lines) {
    processLine(state, line);
  }
  return state;
}

/** A folded {@link CompactState} paired with the count of source lines folded into it. */
export interface FoldedState {
  /** The folded compact state. */
  state: CompactState;
  /** Number of `lines` already folded into {@link FoldedState.state}. */
  lineCount: number;
}

/**
 * Reconciles a previously folded {@link FoldedState} against the authoritative
 * current `lines`.
 *
 * Carrying the folded line count *inside* the returned value — rather than in a
 * watermark snapshotted separately from the state — is the invariant that keeps
 * the compact card from rendering blank: the watermark can never drift from the
 * lines the state was actually built from. The host boots the iframe with no
 * lines and the store delivers the history via an asynchronous
 * `subscribe:response`; that history is reconciled here whenever it lands,
 * whether before or after the view first subscribes, so no line is ever skipped.
 *
 * New trailing lines (the common append, and the initial history fold) are
 * folded incrementally onto the prior state; a shrink — `lines` shorter than
 * what was folded — triggers a full rebuild so no stale tally survives. When the
 * line count is unchanged the previous folded value is returned by reference so
 * React can bail out of a re-render.
 *
 * @param prev - The previously folded state and its line watermark.
 * @param lines - The authoritative current lines from the store.
 * @param role - Primary stream's sidecar `role` (subagent detection on rebuild).
 * @param agentId - Primary stream's sidecar `agentId` (subagent label on rebuild).
 * @returns The reconciled folded state; `prev` by reference when nothing changed.
 */
export function reconcileFolded(
  prev: FoldedState,
  lines: string[],
  role: string | undefined,
  agentId?: string
): FoldedState {
  const n = lines.length;
  if (n === prev.lineCount) return prev;
  if (n < prev.lineCount) return { state: buildState(lines, role, agentId), lineCount: n };
  // Fold only the lines past the watermark onto a fresh state object (new `tail`
  // array so React sees a changed reference); the de-dup Sets carry forward.
  const state: CompactState = { ...prev.state, tail: [...prev.state.tail] };
  for (let i = prev.lineCount; i < n; i++) {
    const line = lines[i];
    if (line !== undefined) processLine(state, line);
  }
  return { state, lineCount: n };
}

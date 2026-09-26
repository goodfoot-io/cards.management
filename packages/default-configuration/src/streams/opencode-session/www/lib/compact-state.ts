/**
 * Folds an OpenCode transcript into the bounded state the compact timeline
 * view shows.
 *
 * The compact view bootstraps from the stream store and reconciles
 * incrementally via {@link reconcileFolded}: lines past a
 * {@link FoldedState.lineCount} watermark are folded onto the prior
 * {@link OpencodeFoldState}, so appending costs work proportional to the new
 * lines rather than the whole session history. A shrink — `lines` shorter than
 * the watermark (truncation or stream replacement) — rebuilds fully from the
 * replacement lines alone.
 *
 * @summary Builds bounded compact-view state from OpenCode transcript lines
 * @module streams/opencode-session/www/lib/compact-state
 */

import type { OpencodeLine } from './parser.js';
import { parseOpencodeLine } from './parser.js';
import { extractToolPart } from './tool-part.js';

/**
 * A single bounded entry in the compact view's recent-activity tail.
 *
 * `kind` distinguishes an assistant/user message from a tool call from an
 * error; `text` is the already-trimmed display string.
 */
export interface OpencodeTailEvent {
  kind: 'message' | 'tool' | 'event';
  text: string;
  /** Escalation level — present only when the entry represents an error. */
  severity?: 'error';
}

/**
 * Bounded summary state for the OpenCode compact timeline view.
 *
 * `durationMs` is derived from the first and most recent line timestamps
 * rather than a lifecycle event, so it is available even for sessions that
 * ended abnormally (OpenCode has no session-end event). `tail` is capped at
 * roughly five items with the newest last.
 */
export interface OpencodeCompactState {
  isActive: boolean;
  headlineText: string;
  turnCount: number;
  toolCallCount: number;
  tokenCount: { input: number; output: number } | undefined;
  model: string | undefined;
  durationMs: number | undefined;
  tail: OpencodeTailEvent[];
  /** `true` when at least one tool call in the session errored. */
  hasErrors: boolean;
  /** `true` when the primary stream's sidecar role marks a child transcript (`'subagent'`/`'auxiliary'`). */
  isSubagent: boolean;
  /** Sidecar `agentId` of a subagent/auxiliary stream; absent for main streams. */
  agentId?: string;
}

/** Maximum number of items retained in the bounded recent-activity tail. */
const MAX_TAIL = 5;

/**
 * Parses the elapsed milliseconds between two ISO timestamps.
 *
 * @param first - The earliest line timestamp.
 * @param last - The most recent line timestamp.
 * @returns The non-negative duration, or `undefined` when either timestamp is unusable.
 */
function durationBetween(first: string | undefined, last: string | undefined): number | undefined {
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const start = Date.parse(first);
  const end = Date.parse(last);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  const delta = end - start;
  return delta >= 0 ? delta : undefined;
}

/**
 * Reads the owning message id off a part payload.
 *
 * @param line - The parsed part line.
 * @returns The message id, or `''` when absent.
 */
function partMessageId(line: Extract<OpencodeLine, { kind: 'part' }>): string {
  const id = line.data['messageID'];
  return typeof id === 'string' ? id : '';
}

/**
 * Builds the stable identity key for one part occurrence.
 *
 * @param messageId - Owning message id (possibly empty).
 * @param partId - Part id (possibly empty).
 * @returns The composite key.
 */
function partKeyOf(messageId: string, partId: string): string {
  return `${messageId}:${partId}`;
}

/**
 * Mutable fold accumulator: every piece of state that carries across lines
 * (tallies, bounded tail, streaming-update keys, de-dup sets). Carried forward
 * across incremental appends by {@link reconcileFolded}.
 */
export interface OpencodeFoldState {
  turnCount: number;
  toolCallCount: number;
  /** Latest tokens snapshot seen on a message record; later counts win. */
  tokenCount: { input: number; output: number } | undefined;
  model: string | undefined;

  latestAssistantText: string | undefined;
  latestToolName: string | undefined;
  hasErrors: boolean;
  tail: OpencodeTailEvent[];
  /** User message ids already counted as turns, so re-emitted records count once. */
  userMessageIds: Set<string>;
  /** Tool part keys already tallied, so re-fired part updates replace rather than stack. */
  seenToolParts: Set<string>;
  /** Tail entries keyed by text-part identity so streaming updates mutate in place. */
  tailTextByKey: Map<string, OpencodeTailEvent>;
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
}

/**
 * A folded {@link OpencodeCompactState} paired with the count of source lines
 * folded into it.
 */
export interface FoldedState {
  /** Bounded summary snapshot for rendering, fresh per reconcile/build. */
  state: OpencodeCompactState;
  /** Mutable accumulator every folded line has contributed to. */
  fold: OpencodeFoldState;
  /** Number of `lines` already folded into {@link FoldedState.fold}. */
  lineCount: number;
}

/**
 * Creates a fresh fold accumulator with all fields at their initial defaults.
 * @returns Initial fold accumulator.
 */
function makeFold(): OpencodeFoldState {
  return {
    turnCount: 0,
    toolCallCount: 0,
    tokenCount: undefined,
    model: undefined,
    latestAssistantText: undefined,
    latestToolName: undefined,
    hasErrors: false,
    tail: [],
    userMessageIds: new Set<string>(),
    seenToolParts: new Set<string>(),
    tailTextByKey: new Map<string, OpencodeTailEvent>(),
    firstTimestamp: undefined,
    lastTimestamp: undefined
  };
}

/**
 * Appends one entry to the bounded tail, dropping the oldest past the cap.
 *
 * @param fold - The mutable fold accumulator to append to.
 * @param event - The entry to append.
 * @returns The appended entry, so streaming updates can mutate it in place.
 */
function pushTail(fold: OpencodeFoldState, event: OpencodeTailEvent): OpencodeTailEvent {
  fold.tail.push(event);
  if (fold.tail.length > MAX_TAIL) {
    fold.tail.shift();
  }
  return event;
}

/**
 * Processes a single NDJSON transcript line into the mutable fold accumulator.
 * @param fold - The mutable fold accumulator to update in place.
 * @param raw - Raw transcript NDJSON line to process.
 */
function processLine(fold: OpencodeFoldState, raw: string): void {
  const line: OpencodeLine = parseOpencodeLine(raw);
  if (line.kind === 'malformed') {
    return;
  }

  // `unknown` envelopes carry an optional timestamp; known kinds a plain one.
  const currentTs = typeof line.ts === 'string' ? line.ts : undefined;
  if (currentTs !== undefined && currentTs.length > 0) {
    if (fold.firstTimestamp === undefined) {
      fold.firstTimestamp = currentTs;
    }
    fold.lastTimestamp = currentTs;
  }

  switch (line.kind) {
    case 'message': {
      // Assistant messages carry flat `modelID`; user messages nest it under
      // `model.modelID` — accept both shapes.
      if (fold.model === undefined) {
        const model =
          typeof line.data.modelID === 'string'
            ? line.data.modelID
            : typeof line.data.model?.modelID === 'string'
              ? line.data.model.modelID
              : undefined;
        if (model !== undefined) {
          fold.model = model;
        }
      }
      const tokens = line.data.tokens;
      if (tokens !== undefined && typeof tokens['input'] === 'number' && typeof tokens['output'] === 'number') {
        fold.tokenCount = { input: tokens['input'] as number, output: tokens['output'] as number };
      }
      // Each distinct user message opens a new turn.
      if (line.data.role === 'user' && typeof line.data.id === 'string' && !fold.userMessageIds.has(line.data.id)) {
        fold.userMessageIds.add(line.data.id);
        fold.turnCount += 1;
      }
      break;
    }

    case 'part': {
      const messageId = partMessageId(line);
      const partId = typeof line.data.id === 'string' ? line.data.id : '';

      switch (line.data.type) {
        case 'text': {
          const text = typeof line.data.text === 'string' ? line.data.text.trim() : '';
          if (text.length === 0) {
            break;
          }
          const key = `text:${messageId}:${partId}`;
          const existing = fold.tailTextByKey.get(key);
          if (existing !== undefined) {
            // Streaming update: refresh the entry's text in place.
            existing.text = text;
          } else {
            fold.tailTextByKey.set(key, pushTail(fold, { kind: 'message', text }));
          }
          if (!fold.userMessageIds.has(messageId)) {
            fold.latestAssistantText = text;
          }
          break;
        }

        case 'tool': {
          if (fold.seenToolParts.has(partKeyOf(messageId, partId))) {
            break;
          }
          fold.seenToolParts.add(partKeyOf(messageId, partId));
          const extracted = extractToolPart(line.data);
          fold.toolCallCount += 1;
          fold.latestToolName = extracted.name;
          if (extracted.severity === 'error') {
            fold.hasErrors = true;
            pushTail(fold, { kind: 'event', text: `${extracted.name} failed`, severity: 'error' });
          } else {
            pushTail(fold, { kind: 'tool', text: extracted.name });
          }
          break;
        }

        default:
          break;
      }
      break;
    }

    default:
      break;
  }
}

/**
 * Derives the bounded {@link OpencodeCompactState} snapshot from a fold
 * accumulator. Derived values (headline, duration) stay computed here so
 * appending never needs a post-pass over already-folded history. Sidecar
 * identity arrives per call (never folded from lines), mirroring
 * claude-code-session's labeling source.
 *
 * @param fold - The fold accumulator to snapshot.
 * @param isActive - Whether the underlying stream is still live.
 * @param role - The primary stream's sidecar `role`.
 * @param agentId - The primary stream's sidecar `agentId`, present for subagent/auxiliary streams.
 * @returns The bounded compact-view state snapshot.
 */
function snapshot(fold: OpencodeFoldState, isActive: boolean, role?: string, agentId?: string): OpencodeCompactState {
  return {
    isActive,
    headlineText: fold.latestAssistantText ?? fold.latestToolName ?? '',
    turnCount: fold.turnCount,
    toolCallCount: fold.toolCallCount,
    tokenCount: fold.tokenCount,
    model: fold.model,
    durationMs: durationBetween(fold.firstTimestamp, fold.lastTimestamp),
    // Fresh array reference so React sees a changed snapshot; entries may be
    // shared with the accumulator's tail and mutated in place by later
    // streaming updates.
    tail: [...fold.tail],
    hasErrors: fold.hasErrors,
    isSubagent: role === 'subagent' || role === 'auxiliary',
    agentId
  };
}

/**
 * Folds `lines` from scratch into a {@link FoldedState} ready for
 * {@link reconcileFolded}. This is the view's boot value.
 *
 * @param lines - The authoritative accumulated transcript NDJSON lines.
 * @param isActive - Whether the underlying stream is still live.
 * @param role - The primary stream's sidecar `role`.
 * @param agentId - The primary stream's sidecar `agentId`, present for subagent/auxiliary streams.
 * @returns The folded state with its line watermark.
 */
export function buildFoldedState(lines: string[], isActive: boolean, role?: string, agentId?: string): FoldedState {
  const fold = makeFold();
  for (const raw of lines) {
    processLine(fold, raw);
  }
  return { state: snapshot(fold, isActive, role, agentId), fold, lineCount: lines.length };
}

/**
 * Reconciles a previously folded {@link FoldedState} against the authoritative
 * current `lines`.
 *
 * Carrying the folded line count inside the returned value keeps the watermark
 * from ever drifting from the lines the state was actually built from: the host
 * boots the iframe with no lines and the store delivers the history via an
 * asynchronous `subscribe:response`, which is reconciled here whenever it lands.
 *
 * New trailing lines (the common append, and the initial history fold) are
 * folded incrementally onto the prior accumulator; a shrink — `lines` shorter
 * than what was folded — triggers a full rebuild so no stale tally survives.
 * When the line count, liveness, and sidecar identity are unchanged the
 * previous folded value is returned by reference so React can bail out of a
 * re-render.
 *
 * @param prev - The previously folded state and its line watermark.
 * @param lines - The authoritative current lines from the store.
 * @param isActive - Whether the underlying stream is still live.
 * @param role - The primary stream's sidecar `role`.
 * @param agentId - The primary stream's sidecar `agentId`, present for subagent/auxiliary streams.
 * @returns The reconciled folded state; `prev` by reference when nothing changed.
 */
export function reconcileFolded(
  prev: FoldedState,
  lines: string[],
  isActive: boolean,
  role?: string,
  agentId?: string
): FoldedState {
  const n = lines.length;
  const isSubagent = role === 'subagent' || role === 'auxiliary';
  if (
    n === prev.lineCount &&
    isActive === prev.state.isActive &&
    isSubagent === prev.state.isSubagent &&
    agentId === prev.state.agentId
  ) {
    return prev;
  }
  if (n < prev.lineCount) return buildFoldedState(lines, isActive, role, agentId);
  const fold = prev.fold;
  for (let i = prev.lineCount; i < n; i++) {
    const line = lines[i];
    if (line !== undefined) processLine(fold, line);
  }
  return { state: snapshot(fold, isActive, role, agentId), fold, lineCount: n };
}

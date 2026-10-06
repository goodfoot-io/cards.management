/**
 * Pure transform: Cards OpenCode transcript NDJSON lines → rendered transcript
 * items.
 *
 * Converts an array of raw NDJSON strings into a list of
 * {@link TranscriptItem} values that the `OpencodeExpandedView` renders. The
 * transform is stateless and rebuilds from scratch on every call, so an
 * incremental append or a file reset produces correct output from the
 * replacement lines alone.
 *
 * Two OpenCode streaming behaviors shape the transform:
 *
 * - **Role correlation**: content streams through parts while the message
 *   record (which only carries role/metadata) arrives separately. Each
 *   `message` line records its message id's role, and a `text` part renders as
 *   a user or assistant message according to that role. The `session_header`
 *   item is back-patched in place with model/provider/cwd once a message
 *   record carrying them arrives. `idle` lines mark its `idleAt` so the
 *   status derivation can tell "turn loop ended" from stream liveness — and
 *   idleness is positional: any later message/part line clears the mark again
 *   until the next idle (meta merges never touch it).
 * - **Part updates**: `message.part.updated` re-fires for the same part id as
 *   a tool or text part progresses, and the exporter appends every update.
 *   Later updates for an already-emitted part replace that item in place
 *   (stable indices — no splicing), so the transcript shows each part's latest
 *   state without stacking duplicates.
 *
 * Malformed lines — including torn trailing fragments left by a crash
 * mid-append — are skipped: the fragment is a partial duplicate of a record
 * lost with the crash (the exporter heals the tail on reopen), so rendering it
 * as a permanent error block would misrepresent a healed stream.
 *
 * @summary Pure transform from raw OpenCode transcript lines to rendered items
 * @module streams/opencode-session/www/lib/render-transcript
 */

import type { OpencodeLine, OpencodePart } from './parser.js';
import { parseOpencodeLine } from './parser.js';

/** The sticky header item, back-patched as session facts arrive. */
export type SessionHeaderItem = Extract<TranscriptItem, { kind: 'session_header' }>;

/**
 * A rendered transcript item produced by {@link renderOpencodeTranscript}.
 */
export type TranscriptItem =
  | {
      kind: 'session_header';
      sessionId?: string;
      opencodeVersion?: string;
      model?: string;
      provider?: string;
      cwd?: string;
      timestamp?: string;
      /** Envelope timestamp of the latest `idle` line — the session's turn loop has ended. */
      idleAt?: string;
    }
  | { kind: 'user_message'; text: string; timestamp?: string }
  | { kind: 'assistant_message'; text: string; timestamp?: string }
  | { kind: 'reasoning'; summaryText: string; timestamp?: string }
  /** A `patch` part's change set — full absolute paths; components derive basenames. */
  | { kind: 'edited_files'; files: string[]; timestamp?: string }
  /** A `file` part (prompt attachment); fields are optional, as observed on OpenCode v1.18.22. */
  | { kind: 'attachment'; filename: string; mime?: string; url?: string; timestamp?: string }
  | {
      kind: 'tool_call';
      name: string;
      callId: string;
      argumentsText: string;
      prettyPrinted: boolean;
      outputText?: string;
      hasOutput: boolean;
      severity?: 'normal' | 'error';
      errorLabel?: string;
      timestamp?: string;
    }
  | { kind: 'unknown_item'; raw: unknown; timestamp?: string };

/** Maximum characters of a tool's input JSON kept in the display. */
const MAX_ARGS_TEXT = 4000;

/**
 * Extracts a display string from an unknown tool output value. A plain string
 * passes through; anything else pretty-prints to JSON inside a try/catch and
 * falls back to `String()` — no throw, no blank output.
 *
 * @param value - The raw output/result/error value from a tool state.
 * @returns The flat display string.
 */
function toolOutputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Reads the human-facing error message out of a tool state's `error` value,
 * which OpenCode types as either a string or a structured record carrying a
 * `message`.
 *
 * @param error - The raw `state.error` value.
 * @returns The message text, or `''` when absent.
 */
function toolErrorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error !== null && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return '';
}

/**
 * Builds the display fields of a `tool` part from its state union.
 *
 * All reads are defensive — no `JSON.parse` outside try/catch, every field
 * optional. Pending/running states render their input alone; completed/error
 * states pair the input with their output/error text.
 *
 * @param part - The `tool` part payload.
 * @returns Name, call id, argument/output display texts, and severity.
 */
export function extractToolPart(part: OpencodePart): {
  name: string;
  callId: string;
  argumentsText: string;
  prettyPrinted: boolean;
  outputText?: string;
  severity: 'normal' | 'error';
} {
  const name = typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'tool';
  const callId = typeof part.callID === 'string' ? part.callID : typeof part.id === 'string' ? part.id : '';
  const state = (part.state ?? {}) as Record<string, unknown>;

  let argumentsText = toolOutputText(state['input']);
  let prettyPrinted = false;
  if (argumentsText.length > MAX_ARGS_TEXT) {
    argumentsText = `${argumentsText.slice(0, MAX_ARGS_TEXT)}…`;
  }
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed !== null && typeof parsed === 'object') {
      argumentsText = JSON.stringify(parsed, null, 2);
      prettyPrinted = true;
    }
  } catch {
    // Raw non-JSON input (e.g. a bash command string) displays as-is.
  }

  const status = state['status'];
  if (status === 'error') {
    const error = toolErrorText(state['error']);
    const result = toolOutputText(state['result']);
    const outputText = [error, result].filter((text) => text.length > 0).join('\n');
    return {
      name,
      callId,
      argumentsText,
      prettyPrinted,
      outputText: outputText.length > 0 ? outputText : undefined,
      severity: 'error'
    };
  }

  if (status === 'completed') {
    return {
      name,
      callId,
      argumentsText,
      prettyPrinted,
      outputText: toolOutputText(state['result']) || undefined,
      severity: 'normal'
    };
  }

  return { name, callId, argumentsText, prettyPrinted, severity: 'normal' };
}

/**
 * Reads the owning message id off a part payload.
 *
 * @param part - The part payload.
 * @returns The message id, or `''` when absent.
 */
function partMessageId(part: OpencodePart): string {
  const id = part['messageID'];
  return typeof id === 'string' ? id : '';
}

/**
 * Converts an OpenCode message part into at most one transcript item,
 * attributed to the owning message's role.
 *
 * Returns `null` for content with no visible contribution yet (empty text or
 * reasoning), structural step markers, and any other part whose latest state
 * should not displace an earlier rendered one. Unrecognized part types become
 * a readable raw block rather than being dropped.
 *
 * @param part - The part payload.
 * @param role - The owning message's role ('user' or otherwise assistant).
 * @param ts - The envelope timestamp (empty string when absent).
 * @returns One transcript item, or `null` when this state renders nothing.
 */
function partToItem(part: OpencodePart, role: string, ts: string): TranscriptItem | null {
  const timestamp = ts || undefined;

  switch (part.type) {
    case 'text': {
      const text = typeof part.text === 'string' ? part.text.trim() : '';
      if (text.length === 0) {
        return null;
      }
      return role === 'user'
        ? { kind: 'user_message', text, timestamp }
        : { kind: 'assistant_message', text, timestamp };
    }

    case 'reasoning': {
      const text = typeof part.text === 'string' ? part.text.trim() : '';
      if (text.length === 0) {
        return null;
      }
      return { kind: 'reasoning', summaryText: text, timestamp };
    }

    case 'tool': {
      const extracted = extractToolPart(part);
      return {
        kind: 'tool_call',
        name: extracted.name,
        callId: extracted.callId,
        argumentsText: extracted.argumentsText,
        prettyPrinted: extracted.prettyPrinted,
        outputText: extracted.outputText,
        hasOutput: extracted.outputText !== undefined,
        severity: extracted.severity,
        errorLabel: extracted.severity === 'error' ? '✗ tool error' : undefined,
        timestamp
      };
    }

    case 'patch': {
      const files = part.files;
      if (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === 'string')) {
        return { kind: 'unknown_item', raw: part, timestamp };
      }
      return { kind: 'edited_files', files, timestamp };
    }

    case 'file': {
      if (typeof part.filename !== 'string' || part.filename.length === 0) {
        return { kind: 'unknown_item', raw: part, timestamp };
      }
      return {
        kind: 'attachment',
        filename: part.filename,
        mime: typeof part.mime === 'string' ? part.mime : undefined,
        url: typeof part.url === 'string' ? part.url : undefined,
        timestamp
      };
    }

    // Structural markers fired around every model step — pure noise here.
    case 'step-start':
    case 'step-finish':
      return null;

    default:
      return { kind: 'unknown_item', raw: part, timestamp };
  }
}

/**
 * Converts raw transcript NDJSON lines into a flat list of transcript items.
 *
 * Source order is preserved for first emissions; part updates replace their
 * item in place. Malformed lines are skipped (see the module doc).
 *
 * @param lines - Raw transcript NDJSON lines from the stream store.
 * @returns Flat list of transcript items in display order.
 */
export function renderOpencodeTranscript(lines: string[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const roles = new Map<string, string>();
  const partItemIndex = new Map<string, number>();
  let header: SessionHeaderItem | undefined;

  for (const raw of lines) {
    const line: OpencodeLine = parseOpencodeLine(raw);
    if (line.kind === 'malformed') {
      continue;
    }

    switch (line.kind) {
      case 'meta': {
        const identity: SessionHeaderItem = {
          kind: 'session_header',
          sessionId: line.sessionId.length > 0 ? line.sessionId : undefined,
          opencodeVersion: line.data.opencodeVersion,
          timestamp: line.ts.length > 0 ? line.ts : undefined
        };
        if (header === undefined) {
          header = identity;
          items.push(header);
        } else {
          // A later meta (every resume appends one) merges into the existing
          // header: patch the identity fields it carries, never clearing the
          // accumulated model/provider/cwd facts.
          if (identity.sessionId !== undefined) header.sessionId = identity.sessionId;
          if (identity.opencodeVersion !== undefined) header.opencodeVersion = identity.opencodeVersion;
          if (identity.timestamp !== undefined) header.timestamp = identity.timestamp;
        }
        break;
      }

      case 'message': {
        // Idleness is positional, not existential: a message record is live
        // activity, so it supersedes a recorded idle until the NEXT idle
        // line. Meta merges never touch the mark (see the meta case).
        if (header !== undefined) {
          header.idleAt = undefined;
        }
        if (typeof line.data.id === 'string' && typeof line.data.role === 'string') {
          roles.set(line.data.id, line.data.role);
        }
        // Back-patch the header in place from the first informative record.
        // Assistant messages carry flat `modelID`/`providerID`; user messages
        // nest them under `model.{providerID, modelID}` — accept both shapes.
        const model =
          typeof line.data.modelID === 'string'
            ? line.data.modelID
            : typeof line.data.model?.modelID === 'string'
              ? line.data.model.modelID
              : undefined;
        const provider =
          typeof line.data.providerID === 'string'
            ? line.data.providerID
            : typeof line.data.model?.providerID === 'string'
              ? line.data.model.providerID
              : undefined;
        if (header !== undefined) {
          if (header.model === undefined && model !== undefined) {
            header.model = model;
          }
          if (header.provider === undefined && provider !== undefined) {
            header.provider = provider;
          }
          if (header.cwd === undefined && typeof line.data.path?.cwd === 'string') {
            header.cwd = line.data.path.cwd;
          }
        }
        break;
      }

      case 'idle': {
        // Live idle marker: fold onto the existing header rather than append a
        // row. Before any meta has arrived there is nothing to mark — drop. A
        // ts-less envelope cannot timestamp the marker, so it stays unmarked
        // (mirrors meta's defensive empty-ts read).
        if (header !== undefined && line.ts.length > 0) {
          header.idleAt = line.ts;
        }
        break;
      }

      case 'part': {
        // Same positional rule as messages: any part line — including a
        // replace-in-place update — is post-idle content activity and clears
        // the mark until the next idle line.
        if (header !== undefined) {
          header.idleAt = undefined;
        }
        const key = `${partMessageId(line.data)}:${typeof line.data.id === 'string' ? line.data.id : ''}`;
        const role = roles.get(partMessageId(line.data)) ?? 'assistant';
        const item = partToItem(line.data, role, line.ts);
        const existing = partItemIndex.get(key);

        if (existing !== undefined) {
          // An update for an already-rendered part replaces it in place;
          // indices stay stable. A null state leaves the last visible one.
          if (item !== null) {
            items[existing] = item;
          }
          break;
        }
        if (item !== null) {
          partItemIndex.set(key, items.length);
          items.push(item);
        }
        break;
      }

      default:
        items.push({ kind: 'unknown_item', raw: line.raw, timestamp: line.ts });
        break;
    }
  }

  return items;
}

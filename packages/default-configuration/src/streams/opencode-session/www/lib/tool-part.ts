/**
 * OpenCode tool-state extraction shared by compact summaries and native projection.
 * @summary Defensive display extraction for OpenCode tool parts
 * @module streams/opencode-session/www/lib/tool-part
 */
import type { OpencodePart } from './parser';

/** Maximum characters of a tool's input JSON retained by the compact summary. */
const MAX_ARGS_TEXT = 4000;

interface BoundedJsonWriter {
  readonly chunks: string[];
  length: number;
  truncated: boolean;
}

/** Appends a JSON fragment while retaining at most the requested prefix.
 * @param writer - Bounded streaming output buffer.
 * @param text - Next already-encoded JSON fragment.
 * @param limit - Maximum retained UTF-16 code units.
 */
function appendBounded(writer: BoundedJsonWriter, text: string, limit: number): void {
  if (writer.truncated || text.length === 0) return;
  const remaining = limit - writer.length;
  if (text.length <= remaining) {
    writer.chunks.push(text);
    writer.length += text.length;
    return;
  }
  if (remaining > 0) {
    writer.chunks.push(text.slice(0, remaining));
    writer.length += remaining;
  }
  writer.truncated = true;
}

/** Writes a quoted string incrementally so large native values never become one temporary JSON string.
 * @param writer - Bounded streaming output buffer.
 * @param value - String value to encode.
 * @param limit - Maximum retained UTF-16 code units.
 */
function appendJsonString(writer: BoundedJsonWriter, value: string, limit: number): void {
  appendBounded(writer, '"', limit);
  const escapes: Readonly<Record<string, string>> = {
    '"': '\\"',
    '\\': '\\\\',
    '\b': '\\b',
    '\f': '\\f',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t'
  };
  for (let index = 0; index < value.length && !writer.truncated; index++) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    const escaped = Object.hasOwn(escapes, character) ? escapes[character] : undefined;
    if (escaped) {
      appendBounded(writer, escaped, limit);
    } else if (code < 0x20) {
      appendBounded(writer, `\\u${code.toString(16).padStart(4, '0')}`, limit);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = value.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        appendBounded(writer, value.slice(index, index + 2), limit);
        index++;
      } else {
        appendBounded(writer, `\\u${code.toString(16).padStart(4, '0')}`, limit);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      appendBounded(writer, `\\u${code.toString(16).padStart(4, '0')}`, limit);
    } else {
      appendBounded(writer, character, limit);
    }
  }
  appendBounded(writer, '"', limit);
}

/** Encodes a JSON value as a pretty-printed prefix without allocating the complete object text.
 * @param writer - Bounded streaming output buffer.
 * @param value - JSON-compatible native value.
 * @param depth - Current pretty-print indentation depth.
 * @param limit - Maximum retained UTF-16 code units.
 */
function appendJsonValue(writer: BoundedJsonWriter, value: unknown, depth: number, limit: number): void {
  if (writer.truncated) return;
  if (typeof value === 'string') {
    appendJsonString(writer, value, limit);
    return;
  }
  if (value === null) {
    appendBounded(writer, 'null', limit);
    return;
  }
  if (typeof value === 'number') {
    appendBounded(writer, Number.isFinite(value) ? String(value) : 'null', limit);
    return;
  }
  if (typeof value === 'boolean') {
    appendBounded(writer, value ? 'true' : 'false', limit);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      appendBounded(writer, '[]', limit);
      return;
    }
    appendBounded(writer, '[\n', limit);
    for (let index = 0; index < value.length && !writer.truncated; index++) {
      if (index > 0) appendBounded(writer, ',\n', limit);
      appendBounded(writer, '  '.repeat(depth + 1), limit);
      appendJsonValue(writer, value[index] ?? null, depth + 1, limit);
    }
    if (!writer.truncated) {
      appendBounded(writer, '\n', limit);
      appendBounded(writer, '  '.repeat(depth), limit);
      appendBounded(writer, ']', limit);
    }
    return;
  }
  if (typeof value !== 'object' || value === undefined) return;

  const mark = writer.chunks.length;
  const markLength = writer.length;
  appendBounded(writer, '{', limit);
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const child: unknown = (value as Record<string, unknown>)[key];
    if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
    appendBounded(writer, count === 0 ? '\n' : ',\n', limit);
    appendBounded(writer, '  '.repeat(depth + 1), limit);
    appendJsonString(writer, key, limit);
    appendBounded(writer, ': ', limit);
    appendJsonValue(writer, child, depth + 1, limit);
    count++;
    if (writer.truncated) return;
  }
  if (count === 0) {
    writer.chunks.length = mark;
    writer.length = markLength;
    appendBounded(writer, '{}', limit);
  } else {
    appendBounded(writer, '\n', limit);
    appendBounded(writer, '  '.repeat(depth), limit);
    appendBounded(writer, '}', limit);
  }
}

/** Returns a pretty JSON prefix bounded before large native payloads are expanded.
 * @param value - JSON-compatible native value.
 * @param limit - Maximum retained prefix length.
 * @returns Prefix text with an ellipsis when additional encoded data remains.
 */
function boundedPrettyJson(value: unknown, limit: number): string {
  const writer: BoundedJsonWriter = { chunks: [], length: 0, truncated: false };
  appendJsonValue(writer, value, 0, limit);
  return `${writer.chunks.join('')}${writer.truncated ? '…' : ''}`;
}

/** Reads tool name and call identity without touching input or result values.
 * @param part - Native OpenCode tool part.
 * @returns Stable native call identity and display name.
 */
export function toolPartIdentity(part: OpencodePart): { name: string; callId: string } {
  return {
    name: typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'tool',
    callId: typeof part.callID === 'string' ? part.callID : typeof part.id === 'string' ? part.id : ''
  };
}

/** Extracts a display string from a native value without assuming it is text.
 * @param value - Arbitrary JSON-compatible OpenCode value.
 * @returns Readable native value text.
 */
export function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return boundedPrettyJson(value, MAX_ARGS_TEXT);
  } catch {
    return String(value);
  }
}

/** Reads an error message from a string or structured OpenCode error.
 * @param error - Native tool error value.
 * @returns The available error message or an empty string.
 */
function toolErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

/**
 * Builds compact display fields from an OpenCode tool part's current state.
 * @param part - The native `tool` part payload.
 * @returns Name, native call id, input/output text, and error severity.
 */
export function extractToolPart(part: OpencodePart): {
  name: string;
  callId: string;
  argumentsText: string;
  prettyPrinted: boolean;
  outputText?: string;
  severity: 'normal' | 'error';
} {
  const { name, callId } = toolPartIdentity(part);
  const state = (part.state ?? {}) as Record<string, unknown>;

  let argumentsText = toolOutputText(state['input']);
  let prettyPrinted = false;
  if (argumentsText.length > MAX_ARGS_TEXT) argumentsText = `${argumentsText.slice(0, MAX_ARGS_TEXT)}…`;
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed !== null && typeof parsed === 'object') {
      argumentsText = JSON.stringify(parsed, null, 2);
      prettyPrinted = true;
    }
  } catch {
    // Raw non-JSON input (e.g. a shell command) displays as-is.
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

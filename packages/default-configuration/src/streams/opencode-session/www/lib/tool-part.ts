/**
 * OpenCode tool-state extraction shared by compact summaries and native projection.
 * @summary Defensive display extraction for OpenCode tool parts
 * @module streams/opencode-session/www/lib/tool-part
 */
import type { OpencodePart } from './parser';

/** Maximum characters of a tool's input JSON retained by the compact summary. */
const MAX_ARGS_TEXT = 4000;

/** Extracts a display string from a native value without assuming it is text.
 * @param value - Arbitrary JSON-compatible OpenCode value.
 * @returns Readable native value text.
 */
export function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
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
  const name = typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' ? part.name : 'tool';
  const callId = typeof part.callID === 'string' ? part.callID : typeof part.id === 'string' ? part.id : '';
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

/**
 * Pure coordination-content classifier for the expanded transcript.
 *
 * Detects JSON/XML machine-generated content blocks (team messages, task ids,
 * idle notifications) embedded in otherwise-conversational text, and reduces
 * them to short display strings instead of dropping them — `idle_notification`
 * payloads are the one sanctioned suppression.
 *
 * The native projector (./project-session.ts) needs plain text for semantic
 * status rows rather than React elements, so this module carries no React
 * dependency.
 *
 * @summary Pure JSON/XML coordination-content detection and text summarization
 * @module lib/classify-coordination
 */

import { stripMarkup } from '../../../lib/markdown';

/**
 * Reduces a parsed coordination payload to its display text: `"{from}: {type}"`
 * when either is present, otherwise a truncated preview of the raw source.
 * @param parsed - The parsed JSON payload.
 * @param raw - The original raw text, for the truncated-preview fallback.
 * @returns Display text for the coordination line.
 */
function summarizeParsed(parsed: Record<string, unknown>, raw: string): string {
  const parts: string[] = [];
  if (typeof parsed['from'] === 'string') parts.push(parsed['from']);
  if (parsed['type'] !== undefined) parts.push(String(parsed['type']).replace(/_/g, ' '));
  return parts.length > 0 ? parts.join(': ') : `${raw.slice(0, 80)}…`;
}

/**
 * Classifies a single text block that may be machine-generated coordination
 * content (JSON or XML), reducing it to zero or more display strings.
 *
 * Returns an empty array when the content should be suppressed entirely
 * (e.g. an `idle_notification` payload) or when parsing yields nothing to show.
 *
 * @param raw - Raw text content of the block.
 * @returns Display strings for this coordination block, empty if suppressed.
 */
export function classifyCoordinationText(raw: string): string[] {
  if (/^\s*[{[]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed['type'] === 'idle_notification') return [];
      return [summarizeParsed(parsed, raw)];
    } catch {
      return [raw.slice(0, 120) + (raw.length > 120 ? '…' : '')];
    }
  }

  if (/^\s*</.test(raw)) {
    const result: string[] = [];
    let processedAny = false;
    for (const match of raw.matchAll(/<[^/][^>]*>([\s\S]*?)<\/[^>]+>/g)) {
      processedAny = true;
      const innerRaw = match[1];
      if (innerRaw === undefined) continue;
      const inner = innerRaw.trim();
      if (!inner) continue;

      if (/^\s*\{/.test(inner)) {
        try {
          const parsed = JSON.parse(inner) as Record<string, unknown>;
          if (parsed['type'] === 'idle_notification') continue;
          result.push(summarizeParsed(parsed, inner));
        } catch {
          result.push(inner.length > 120 ? `${inner.slice(0, 120)}…` : inner);
        }
      } else {
        result.push(inner.length > 120 ? `${inner.slice(0, 120)}…` : inner);
      }
    }

    if (!processedAny) {
      const stripped = stripMarkup(raw).trim();
      if (stripped.length > 0) {
        return [stripped.length > 120 ? `${stripped.slice(0, 120)}…` : stripped];
      }
    }

    return result;
  }

  return [];
}

/**
 * Returns true if the given raw text looks like machine-generated coordination
 * content (JSON or XML).
 * @param raw - Raw text to classify.
 * @returns True if the text starts with JSON or XML markers.
 */
export function isCoordinationContent(raw: string): boolean {
  return /^\s*[{[]/.test(raw) || /^\s*</.test(raw);
}

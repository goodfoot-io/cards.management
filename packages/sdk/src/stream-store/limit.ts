/**
 * Power-of-two rate limiting for identifier-only diagnostics shared by the
 * renderer store and the host bridge.
 *
 * A key is reported on its 1st, 2nd, 4th, 8th, ... occurrence, and each
 * reported line carries the weight accumulated since the previous one, so a
 * burst of any size costs a logarithmic number of lines and loses no count.
 *
 * @summary Shared diagnostic rate limiter
 * @module stream-store/limit
 */

/** Distinct keys tracked before the table is reset, bounding memory under hostile input. */
const MAX_LIMITED_KEYS = 64;

/**
 * Admits one occurrence of a key and returns the weight to report now.
 * @param key - Identifier-only key, such as a JSON tuple of code, source, and reason.
 * @param weight - Occurrences this one stands for, when the sender already coalesced several.
 * @returns Weight accumulated since the key's last report, or 0 when this occurrence is suppressed.
 */
export type DiagnosticLimiter = (key: string, weight?: number) => number;

/**
 * Creates an independent limiter with its own bounded key table.
 * @returns Limiter function.
 */
export function createDiagnosticLimiter(): DiagnosticLimiter {
  const entries = new Map<string, { seen: number; pending: number }>();
  return (key, weight = 1) => {
    if (!entries.has(key) && entries.size >= MAX_LIMITED_KEYS) entries.clear();
    const entry = entries.get(key) ?? { seen: 0, pending: 0 };
    entry.seen++;
    entry.pending += weight;
    entries.set(key, entry);
    if ((entry.seen & (entry.seen - 1)) !== 0) return 0;
    const reported = entry.pending;
    entry.pending = 0;
    return reported;
  };
}

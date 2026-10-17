/**
 * Typed native source read failures a session client may report.
 * @summary Session source read failure codes
 * @module stream-session/errors
 */

/** Identifier-only read failure categories surfaced on paused sources. */
export type SessionSourceFailure = 'not-found' | 'rejected-scope' | 'inconsistent-source' | 'load-error';

/**
 * Backoff before each automatic re-read of a source whose read failed with a
 * retryable code (`inconsistent-source`, `load-error`), and before each
 * recovery read of a source whose live buffer overflowed; its length is the
 * consecutive-attempt budget before the source pauses visibly and retryably.
 */
export const SESSION_READ_RETRY_DELAYS_MS: readonly number[] = [250, 1000, 2000];

/**
 * Whether a read failure is transient and may be retried automatically.
 * Missing or unbound sources wait for a new live event, refresh, or explicit retry.
 * @param code - Read failure category.
 * @returns True for coherence and availability failures.
 */
export function isRetryableSourceFailure(code: SessionSourceFailure): boolean {
  return code === 'inconsistent-source' || code === 'load-error';
}

/** Rejection a {@link SessionClient} read may use to classify its failure; any other rejection is `load-error`. */
export class SessionSourceError extends Error {
  /**
   * Creates a classified read failure.
   * @param code - Failure category; never native content or filesystem detail.
   */
  constructor(readonly code: SessionSourceFailure) {
    super(code);
    this.name = 'SessionSourceError';
  }
}

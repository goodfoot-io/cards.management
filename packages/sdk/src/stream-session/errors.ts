/**
 * Typed native source read failures a session client may report.
 * @summary Session source read failure codes
 * @module stream-session/errors
 */

/** Identifier-only read failure categories surfaced on paused sources. */
export type SessionSourceFailure = 'not-found' | 'rejected-scope' | 'inconsistent-source' | 'load-error';

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

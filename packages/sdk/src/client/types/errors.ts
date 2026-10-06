/**
 * Error classes for the Cards V2 SDK.
 *
 * These errors normalize server responses and network failures so callers can
 * distinguish API validation problems from transport issues.
 *
 *
 * @summary Error classes for the Cards V2 SDK
 * @module types/errors
 */

import type { FieldError } from '../../protocol/index.js';

/**
 * Error thrown when an API request fails with an error response.
 *
 * @example
 * ```typescript
 * try {
 *   await client.createCard(data);
 * } catch (error) {
 *   if (error instanceof ApiError) {
 *     console.error(`API error [${error.code}]: ${error.message}`);
 *     if (error.fields) {
 *       error.fields.forEach(f => console.error(`  ${f.field}: ${f.message}`));
 *     }
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /**
   * Creates a new ApiError instance.
   *
   * @param message - Human-readable error message
   * @param code - Machine-readable error code
   * @param fields - Optional array of field-specific validation errors
   */
  constructor(
    message: string,
    public readonly code: string,
    public readonly fields?: FieldError[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Why the server refused to delete a card. */
export type CardDeleteRefusalCode =
  /** 409: executions on the card are still running. */
  | 'running_execution'
  /** 409: the card changed after the cited prepare-delete run, which no longer vouches for it. */
  | 'card_changed'
  /** 400: `preparedBy` names no prepare-delete run of this card that the server accepts. */
  | 'invalid_prepared_by'
  /** 400: the delete cited no prepare-delete run. */
  | 'prepared_by_required';

/** Every {@link CardDeleteRefusalCode}. */
export const CARD_DELETE_REFUSAL_CODES: readonly CardDeleteRefusalCode[] = [
  'running_execution',
  'card_changed',
  'invalid_prepared_by',
  'prepared_by_required'
];

/**
 * Error thrown when the server refuses {@link CardsClient.deleteCard}. Nothing
 * was deleted. `executions` names the executions behind a 409, so a caller can
 * say which to stop or which changed the card; it is empty for
 * `invalid_prepared_by` and `prepared_by_required`.
 */
export class CardDeleteRefusedError extends ApiError {
  /**
   * Creates a new CardDeleteRefusedError instance.
   *
   * @param message - Human-readable error message from the server
   * @param code - Why the delete was refused
   * @param executions - IDs of the executions the refusal names
   */
  constructor(
    message: string,
    public override readonly code: CardDeleteRefusalCode,
    public readonly executions: readonly string[]
  ) {
    super(message, code);
    this.name = 'CardDeleteRefusedError';
  }
}

/**
 * Error thrown when a network request fails due to connectivity issues.
 *
 * @example
 * ```typescript
 * try {
 *   await client.listCards();
 * } catch (error) {
 *   if (error instanceof NetworkError) {
 *     console.error(`Network error: ${error.message}`);
 *     if (error.cause) {
 *       console.error(`Caused by: ${error.cause.message}`);
 *     }
 *   }
 * }
 * ```
 */
export class NetworkError extends Error {
  /**
   * Creates a new NetworkError instance.
   *
   * @param message - Human-readable error message
   * @param cause - Optional underlying error that caused this network failure
   */
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Error thrown when an idempotent request exhausts its retry budget without a
 * successful response — the server stayed unreachable for every attempt.
 *
 * Distinct from {@link RequestCancelledError}: this reports "gave up after N
 * attempts", not caller cancellation.
 *
 * @example
 * ```typescript
 * try {
 *   await client.listCards();
 * } catch (error) {
 *   if (error instanceof RetryExhaustedError) {
 *     console.error(`Server unreachable after ${error.attempts} attempts`);
 *   }
 * }
 * ```
 */
export class RetryExhaustedError extends Error {
  /**
   * Creates a new RetryExhaustedError instance.
   *
   * @param message - Human-readable error message
   * @param attempts - Number of attempts made before giving up (initial attempt included)
   * @param cause - Optional underlying error from the final failed attempt
   */
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

/**
 * Error thrown when a request is cancelled through the client's abort signal,
 * either before an attempt, mid-attempt, or while waiting in a backoff sleep.
 *
 * Distinct from {@link RetryExhaustedError}: the retry budget was not spent —
 * the caller stopped the request deliberately.
 *
 * @example
 * ```typescript
 * try {
 *   await client.listCards();
 * } catch (error) {
 *   if (error instanceof RequestCancelledError) {
 *     console.error('Request was cancelled');
 *   }
 * }
 * ```
 */
export class RequestCancelledError extends Error {
  /**
   * Creates a new RequestCancelledError instance.
   *
   * @param message - Human-readable error message
   * @param cause - Optional underlying error from the interrupted attempt
   */
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

/** Why a root command did not resolve with a report. */
export type RootCommandFailureCause =
  | 'no_report'
  | 'rejected'
  | 'uncertain'
  | 'timeout'
  | 'cancelled'
  | 'unconfigured'
  /** The server gave no response, or only server errors, until the wait ended. */
  | 'unavailable'
  /** 404 `card_not_found`: the server has no such card to run the command on. */
  | 'card_not_found'
  /** 404 `workspace_not_found`: the repository has no workspace to run the command in. */
  | 'workspace_not_found'
  /** The server answered with a body outside the root-command contract. */
  | 'invalid_response';

/**
 * Whether a root-command failure would recur for every card in the workspace or
 * belongs to this card alone. A caller sweeping many cards stops at the first
 * `workspace` failure instead of repeating it for each card.
 */
export type RootCommandFailureScope = 'workspace' | 'card';

/**
 * Error thrown when a root configuration command does not complete with a report.
 *
 * Only `completed` with a `commandReport` resolves {@link CardsClient.runRootCommand};
 * every other end names its cause here, so a caller never mistakes a missing report
 * for an empty one.
 */
export class RootCommandError extends Error {
  /**
   * Creates a new RootCommandError instance.
   *
   * @param message - Human-readable error message
   * @param cause - Machine-readable failure cause
   * @param requestId - Original caller request ID of the command launch
   * @param scope - Whether the failure would recur for every card in the workspace
   */
  constructor(
    message: string,
    public readonly cause: RootCommandFailureCause,
    public readonly requestId: string,
    public readonly scope: RootCommandFailureScope
  ) {
    super(message);
    this.name = 'RootCommandError';
  }
}

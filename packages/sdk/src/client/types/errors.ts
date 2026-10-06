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

/**
 * Error thrown when the server refuses to delete a card because executions on
 * it are still running (409 `running_execution`). It names those executions so
 * a caller can say which to stop.
 */
export class RunningExecutionError extends ApiError {
  /**
   * Creates a new RunningExecutionError instance.
   *
   * @param message - Human-readable error message naming the executions
   * @param executions - IDs of the executions still running on the card
   */
  constructor(
    message: string,
    public readonly executions: readonly string[]
  ) {
    super(message, 'running_execution');
    this.name = 'RunningExecutionError';
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
  /** The server has no such card to run the command on. */
  | 'not_found'
  /** The server answered with a body outside the root-command contract. */
  | 'invalid_response';

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
   */
  constructor(
    message: string,
    public readonly cause: RootCommandFailureCause,
    public readonly requestId: string
  ) {
    super(message);
    this.name = 'RootCommandError';
  }
}

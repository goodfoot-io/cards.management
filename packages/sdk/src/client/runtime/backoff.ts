import type { BackoffPolicy } from './types.js';

/**
 * Reconnect delay schedule: exponential growth from one second, clamped at sixty, jittered.
 *
 * The jitter is not decoration. Every wrapper and watcher on a machine loses its connection
 * at the same instant when the server restarts, so an unjittered schedule reconverges them
 * into synchronized retry waves that keep hitting the recovering server together.
 *
 * @summary Capped jittered backoff for runtime reconnect attempts
 */

/** Plan line 54: jitter from one second to a sixty-second cap. */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  capMs: 60_000,
  jitter: (span: number) => Math.random() * span
};

/**
 * Delay before retry number `attempt`, counting the first retry as zero.
 *
 * @param attempt - Zero-based retry count.
 * @param policy - Timing policy; defaults to {@link DEFAULT_BACKOFF_POLICY}.
 * @returns Milliseconds to wait, never below zero and never above the cap.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function nextBackoffDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY): number {
  void attempt;
  void policy;
  throw new Error('Not Implemented');
}

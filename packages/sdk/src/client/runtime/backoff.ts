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
 */
export function nextBackoffDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY): number {
  const steps = Math.min(Math.max(0, Math.floor(attempt)), 53);
  const ceiling = Math.min(policy.initialMs * 2 ** steps, policy.capMs);
  // Jitter subtracts from the ceiling rather than adding to a floor, so the spread survives
  // at the cap. Adding to a capped delay would clamp every client back onto the same value
  // after a few attempts, reviving the synchronized retry wave the jitter exists to break.
  const spread = policy.jitter(ceiling - policy.initialMs);
  return Math.min(Math.max(ceiling - spread, 0), policy.capMs);
}

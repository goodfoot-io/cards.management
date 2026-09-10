import type { HeartbeatPolicy } from './types.js';

/**
 * Heartbeat liveness, kept as a pure evaluation over observed timestamps.
 *
 * Heartbeats are disposable telemetry, and the asymmetry matters: missing them may close a
 * connection, but it may never advance any durable state. A silent socket means the
 * transport is gone, not that the agent behind it stopped — so the only thing this decides
 * is whether to reconnect.
 *
 * @summary Heartbeat cadence and missed-interval evaluation for the runtime client
 */

/** Plan line 54: detect a missing pong within two fifteen-second intervals. */
export const DEFAULT_HEARTBEAT_POLICY: HeartbeatPolicy = {
  intervalMs: 15_000,
  missedLimit: 2
};

/** Observed heartbeat progress on one connection. */
export interface HeartbeatState {
  /** Epoch ms of the last acknowledged heartbeat, or of connection open. */
  readonly lastAcknowledgedAtMs: number;
  /** Epoch ms the last heartbeat was sent, or `null` when none is outstanding. */
  readonly lastSentAtMs: number | null;
}

/**
 * What the client should do now.
 *
 * `expired` means the transport is dead and the connection must be torn down and retried;
 * it carries no implication about the execution's lifecycle state.
 */
export type HeartbeatDecision =
  | { readonly action: 'idle' }
  | { readonly action: 'send' }
  | { readonly action: 'expired'; readonly missedIntervals: number };

/**
 * Decides whether to stay idle, send a heartbeat, or declare the transport dead.
 *
 * @param state - Observed heartbeat progress.
 * @param nowMs - Current epoch milliseconds.
 * @param policy - Cadence policy; defaults to {@link DEFAULT_HEARTBEAT_POLICY}.
 * @returns The action to take.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function evaluateHeartbeat(
  state: HeartbeatState,
  nowMs: number,
  policy: HeartbeatPolicy = DEFAULT_HEARTBEAT_POLICY
): HeartbeatDecision {
  void state;
  void nowMs;
  void policy;
  throw new Error('Not Implemented');
}

import { describe, expect, it } from 'vitest';
import type { HeartbeatState } from '../../../src/client/runtime/index.js';
import { DEFAULT_HEARTBEAT_POLICY, evaluateHeartbeat } from '../../../src/client/runtime/index.js';

/**
 * Pins heartbeat cadence and the missed-interval threshold.
 *
 * The case that matters most is the one asserting silence is not evidence: a dead socket
 * tells you the transport is gone, and nothing whatsoever about whether the agent behind it
 * is still working. Treating a missed pong as completion is how a live agent gets reported
 * finished, so the decision this returns is only ever about the connection.
 *
 * @summary Tests heartbeat liveness evaluation
 */

const state = (overrides: Partial<HeartbeatState> = {}): HeartbeatState => ({
  lastAcknowledgedAtMs: 0,
  lastSentAtMs: null,
  ...overrides
});

describe('heartbeat policy', () => {
  it('defaults to the plan cadence of two fifteen-second intervals', () => {
    expect(DEFAULT_HEARTBEAT_POLICY.intervalMs).toBe(15_000);
    expect(DEFAULT_HEARTBEAT_POLICY.missedLimit).toBe(2);
  });
});

describe('heartbeat evaluation', () => {
  it('stays idle before an interval has elapsed', () => {
    expect(evaluateHeartbeat(state(), 14_999).action).toBe('idle');
  });

  it('sends once a full interval has elapsed', () => {
    expect(evaluateHeartbeat(state(), 15_000).action).toBe('send');
  });

  it('does not send again while one is already outstanding', () => {
    expect(evaluateHeartbeat(state({ lastSentAtMs: 15_000 }), 20_000).action).toBe('idle');
  });

  it('declares the transport dead only after the missed limit is exceeded', () => {
    expect(evaluateHeartbeat(state({ lastSentAtMs: 15_000 }), 29_999).action).not.toBe('expired');
    expect(evaluateHeartbeat(state({ lastSentAtMs: 15_000 }), 30_000)).toEqual({
      action: 'expired',
      missedIntervals: 2
    });
  });

  it('resumes normal cadence once an acknowledgment lands', () => {
    const acknowledged = state({ lastAcknowledgedAtMs: 30_000, lastSentAtMs: null });
    expect(evaluateHeartbeat(acknowledged, 40_000).action).toBe('idle');
    expect(evaluateHeartbeat(acknowledged, 45_000).action).toBe('send');
  });

  it('honours a policy that tolerates more missed intervals', () => {
    const tolerant = { intervalMs: 15_000, missedLimit: 4 };
    expect(evaluateHeartbeat(state({ lastSentAtMs: 15_000 }), 45_000, tolerant).action).not.toBe('expired');
    expect(evaluateHeartbeat(state({ lastSentAtMs: 15_000 }), 75_000, tolerant).action).toBe('expired');
  });

  it('reports only a transport verdict, never a lifecycle one', () => {
    const decision = evaluateHeartbeat(state({ lastSentAtMs: 15_000 }), 30_000);
    expect(Object.keys(decision).sort()).toEqual(['action', 'missedIntervals']);
  });
});

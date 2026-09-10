import { describe, expect, it } from 'vitest';
import type { BackoffPolicy } from '../../../src/client/runtime/index.js';
import { DEFAULT_BACKOFF_POLICY, nextBackoffDelayMs } from '../../../src/client/runtime/index.js';

/**
 * Pins the reconnect schedule: growth, the sixty-second ceiling, and real jitter.
 *
 * The ceiling and the jitter defend different failures. Without the ceiling a long outage
 * pushes retries into hours and an execution stays disconnected long after the server is
 * healthy; without the jitter every client on the machine retries in the same instant,
 * because they all lost the connection in the same instant.
 *
 * @summary Tests capped jittered reconnect backoff
 */

/**
 * A policy with the draw pinned to the top of the span, so bounds are exactly assertable.
 *
 * @param overrides - Policy fields to replace.
 * @returns The policy.
 */
const pinned = (overrides: Partial<BackoffPolicy> = {}): BackoffPolicy => ({
  initialMs: 1_000,
  capMs: 60_000,
  jitter: (span: number) => span,
  ...overrides
});

describe('reconnect backoff', () => {
  it('defaults to the plan floor and ceiling', () => {
    expect(DEFAULT_BACKOFF_POLICY.initialMs).toBe(1_000);
    expect(DEFAULT_BACKOFF_POLICY.capMs).toBe(60_000);
  });

  it('waits the initial delay before the first retry', () => {
    expect(nextBackoffDelayMs(0, pinned({ jitter: () => 0 }))).toBe(1_000);
  });

  it('grows exponentially while below the cap', () => {
    const noJitter = pinned({ jitter: () => 0 });
    expect(nextBackoffDelayMs(1, noJitter)).toBe(2_000);
    expect(nextBackoffDelayMs(2, noJitter)).toBe(4_000);
    expect(nextBackoffDelayMs(3, noJitter)).toBe(8_000);
  });

  it('clamps at the cap rather than growing without bound', () => {
    const noJitter = pinned({ jitter: () => 0 });
    expect(nextBackoffDelayMs(20, noJitter)).toBe(60_000);
    expect(nextBackoffDelayMs(1_000, noJitter)).toBe(60_000);
  });

  it('never exceeds the cap even at the top of the jitter draw', () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(nextBackoffDelayMs(attempt, pinned())).toBeLessThanOrEqual(60_000);
    }
  });

  it('never returns a negative delay at the bottom of the draw', () => {
    const bottom = pinned({ jitter: () => 0 });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(nextBackoffDelayMs(attempt, bottom)).toBeGreaterThanOrEqual(0);
    }
  });

  it('actually spreads attempts apart rather than returning one fixed delay', () => {
    const draws = new Set<number>();
    let seed = 0;
    const policy = pinned({
      jitter: (span: number) => {
        seed += 1;
        return (span * (seed % 7)) / 7;
      }
    });
    for (let i = 0; i < 7; i += 1) {
      draws.add(nextBackoffDelayMs(5, policy));
    }
    expect(draws.size).toBeGreaterThan(1);
  });

  it('draws jitter from the delay for the current attempt, not a constant window', () => {
    const spans: number[] = [];
    const policy = pinned({
      jitter: (span: number) => {
        spans.push(span);
        return 0;
      }
    });
    nextBackoffDelayMs(0, policy);
    nextBackoffDelayMs(3, policy);
    expect(spans[0]).toBeLessThan(spans[1] as number);
  });
});

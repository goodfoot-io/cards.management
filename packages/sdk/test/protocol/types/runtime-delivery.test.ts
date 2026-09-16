import { describe, expect, it } from 'vitest';
import { deliveryClassFor } from '../../../src/protocol/types/runtime-authorization.js';
import type { DurableIntentRecord, DurableResultRecord } from '../../../src/protocol/types/runtime-delivery.js';
import {
  canRetireDurableResult,
  DELIVERY_CLASS_POLICIES,
  evaluateDisposableTelemetry,
  evaluateDurableIntent,
  evaluateDurableResult,
  evaluateReconciledSnapshot
} from '../../../src/protocol/types/runtime-delivery.js';

/**
 * Exercises the four delivery classes in the types area through one representative message each.
 * The cases pin what a duplicate means, what may be dropped, and what may count as evidence that
 * work finished, so the class rather than the individual handler decides — which is what stops a
 * replayed cleanup result from re-finalizing an execution that has already been journaled.
 *
 * @summary Tests delivery-class acceptance and replay semantics in types
 */

describe('delivery-class assignment', () => {
  it('assigns each representative message to the class under test', () => {
    expect(deliveryClassFor('runtime.liveness')).toBe('reconciled-snapshot');
    expect(deliveryClassFor('execution.executeRequest')).toBe('durable-intent');
    expect(deliveryClassFor('execution.cleanupResult')).toBe('durable-result');
    expect(deliveryClassFor('watcher.telemetry')).toBe('disposable-telemetry');
  });

  it('permits completion evidence for durable results alone', () => {
    const evidenceClasses = Object.values(DELIVERY_CLASS_POLICIES)
      .filter((policy) => policy.completionEvidence)
      .map((policy) => policy.deliveryClass);
    expect(evidenceClasses).toEqual(['durable-result']);
  });

  it('permits dropping for disposable telemetry alone', () => {
    const droppableClasses = Object.values(DELIVERY_CLASS_POLICIES)
      .filter((policy) => policy.droppable)
      .map((policy) => policy.deliveryClass);
    expect(droppableClasses).toEqual(['disposable-telemetry']);
  });
});

describe('reconciled snapshot, via runtime.liveness', () => {
  const stamp = (generation: number, revision: number) => ({
    ownership: { ownerId: 'server-a', generation },
    revision
  });

  it('accepts the first snapshot when none is recorded', () => {
    expect(evaluateReconciledSnapshot(stamp(1, 1), undefined).disposition).toBe('accept');
  });

  it('accepts a higher revision within the same generation', () => {
    expect(evaluateReconciledSnapshot(stamp(1, 5), stamp(1, 4)).disposition).toBe('accept');
  });

  it('ignores a replayed snapshot rather than reapplying it', () => {
    expect(evaluateReconciledSnapshot(stamp(1, 4), stamp(1, 4)).disposition).toBe('ignore-stale');
  });

  it('ignores an older revision so the newest snapshot wins', () => {
    expect(evaluateReconciledSnapshot(stamp(1, 3), stamp(1, 4)).disposition).toBe('ignore-stale');
  });

  it('fences a stale generation even when it carries a higher revision', () => {
    expect(evaluateReconciledSnapshot(stamp(1, 99), stamp(2, 1)).disposition).toBe('reject-fenced');
  });
});

describe('durable intent, via execution.executeRequest', () => {
  it('accepts an intent never seen before', () => {
    expect(evaluateDurableIntent('msg-1', undefined).disposition).toBe('accept');
  });

  it('accepts a replay persisted but not yet accepted, closing the crash window', () => {
    const record: DurableIntentRecord = { messageId: 'msg-1', persisted: true, accepted: false };
    expect(evaluateDurableIntent('msg-1', record).disposition).toBe('accept');
  });

  it('answers a replay of an accepted intent from the record instead of repeating the effect', () => {
    const record: DurableIntentRecord = {
      messageId: 'msg-1',
      persisted: true,
      accepted: true,
      outcome: { exitCode: 0 }
    };
    expect(evaluateDurableIntent('msg-1', record).disposition).toBe('replay-recorded-outcome');
  });
});

describe('durable result, via execution.cleanupResult', () => {
  it('accepts a result never seen before', () => {
    expect(evaluateDurableResult('msg-1', undefined).disposition).toBe('accept');
  });

  it('answers a replay of a persisted result from the record', () => {
    const record: DurableResultRecord = { messageId: 'msg-1', serverPersisted: true };
    expect(evaluateDurableResult('msg-1', record).disposition).toBe('replay-recorded-outcome');
  });

  it('lets the producer retire its copy only once the journal has taken the obligation', () => {
    expect(canRetireDurableResult({ messageId: 'msg-1', serverPersisted: true })).toBe(true);
  });

  it('keeps the producer copy when persistence is unconfirmed or the acknowledgment was lost', () => {
    expect(canRetireDurableResult({ messageId: 'msg-1', serverPersisted: false })).toBe(false);
    expect(canRetireDurableResult(undefined)).toBe(false);
  });
});

describe('disposable telemetry, via watcher.telemetry', () => {
  it('accepts telemetry while the bounded buffer has room', () => {
    expect(evaluateDisposableTelemetry({ depth: 3, capacity: 10 }).disposition).toBe('accept');
  });

  it('drops telemetry once the buffer is full rather than growing without bound', () => {
    expect(evaluateDisposableTelemetry({ depth: 10, capacity: 10 }).disposition).toBe('drop-bounded');
  });

  it('gives a drop a stated reason so the loss is observable rather than silent', () => {
    expect(evaluateDisposableTelemetry({ depth: 10, capacity: 10 }).reason).not.toHaveLength(0);
  });
});

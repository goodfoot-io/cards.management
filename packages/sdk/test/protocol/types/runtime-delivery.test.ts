import { describe, expect, it } from 'vitest';
import { deliveryClassFor } from '../../../src/protocol/types/runtime-authorization.js';
import type { DurableIntentRecord, DurableResultRecord } from '../../../src/protocol/types/runtime-delivery.js';
import {
  authorizeTermination,
  canRetireDurableResult,
  DELIVERY_CLASS_POLICIES,
  evaluateDisposableTelemetry,
  evaluateDurableIntent,
  evaluateDurableResult,
  evaluateReadinessReceipt,
  evaluateReconciledSnapshot
} from '../../../src/protocol/types/runtime-delivery.js';

/**
 * Exercises the five delivery classes in the types area through one representative message each.
 * The cases pin what a duplicate means, what may be dropped, and what may count as evidence that
 * work finished, so the class rather than the individual handler decides — which is what stops a
 * replayed readiness record from terminating an agent that has since started new work.
 *
 * @summary Tests delivery-class acceptance and replay semantics in types
 */

describe('delivery-class assignment', () => {
  it('assigns each representative message to the class under test', () => {
    expect(deliveryClassFor('runtime.liveness')).toBe('reconciled-snapshot');
    expect(deliveryClassFor('execution.executeRequest')).toBe('durable-intent');
    expect(deliveryClassFor('execution.shutdownReadiness')).toBe('revocable-readiness');
    expect(deliveryClassFor('execution.agentTermination')).toBe('durable-result');
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

describe('revocable readiness, via execution.shutdownReadiness', () => {
  it('accepts current readiness as durably stored evidence', () => {
    expect(evaluateReadinessReceipt({ shutdownRequestId: 'sd-1', workRevision: 7 }, 7).disposition).toBe('accept');
  });

  it('stores superseded readiness but requires revalidation before it authorizes anything', () => {
    expect(evaluateReadinessReceipt({ shutdownRequestId: 'sd-1', workRevision: 6 }, 7).disposition).toBe(
      'require-revalidation'
    );
  });

  it('authorizes termination only with current readiness and a held drain', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-1',
        readiness: { shutdownRequestId: 'sd-1', workRevision: 7 },
        currentWorkRevision: 7,
        drain: { workRevision: 7, barrierHeld: true }
      })
    ).toEqual({ authorized: true });
  });

  it('refuses termination when no readiness was ever recorded', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-1',
        readiness: undefined,
        currentWorkRevision: 7,
        drain: { workRevision: 7, barrierHeld: true }
      })
    ).toEqual({ authorized: false, reason: 'no-readiness-recorded' });
  });

  it('refuses readiness recorded against a different shutdown request', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-2',
        readiness: { shutdownRequestId: 'sd-1', workRevision: 7 },
        currentWorkRevision: 7,
        drain: { workRevision: 7, barrierHeld: true }
      })
    ).toEqual({ authorized: false, reason: 'readiness-for-other-request' });
  });

  it('refuses a replayed readiness record once new work has started', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-1',
        readiness: { shutdownRequestId: 'sd-1', workRevision: 7 },
        currentWorkRevision: 8,
        drain: { workRevision: 8, barrierHeld: true }
      })
    ).toEqual({ authorized: false, reason: 'readiness-superseded' });
  });

  it('refuses termination when no drain is held', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-1',
        readiness: { shutdownRequestId: 'sd-1', workRevision: 7 },
        currentWorkRevision: 7,
        drain: undefined
      })
    ).toEqual({ authorized: false, reason: 'drain-missing' });
  });

  it('refuses a drain established for an earlier revision', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-1',
        readiness: { shutdownRequestId: 'sd-1', workRevision: 7 },
        currentWorkRevision: 7,
        drain: { workRevision: 6, barrierHeld: true }
      })
    ).toEqual({ authorized: false, reason: 'drain-stale' });
  });

  it('refuses a drain whose new-work barrier has been released', () => {
    expect(
      authorizeTermination({
        shutdownRequestId: 'sd-1',
        readiness: { shutdownRequestId: 'sd-1', workRevision: 7 },
        currentWorkRevision: 7,
        drain: { workRevision: 7, barrierHeld: false }
      })
    ).toEqual({ authorized: false, reason: 'barrier-not-held' });
  });
});

describe('durable result, via execution.agentTermination', () => {
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

import { describe, expect, it } from 'vitest';
import { collectOutstandingMessageIds, synchronize } from '../../../src/client/runtime/index.js';
import { MemoryOutbox, makeAcceptingAuthorities, makeRecordInput, makeUnavailableAuthorities } from './index.js';

/**
 * Pins the barrier a reconnect must clear before it may carry new work.
 *
 * Synchronization answers one question: of the obligations this client still holds, which
 * did the server already take? Getting that wrong in either direction is a real failure —
 * retiring an unaccepted record loses it silently, replaying an accepted one performs the
 * effect twice — so the split is asserted explicitly rather than inferred from a count.
 *
 * @summary Tests the reconnect synchronization phase
 */

const ackFor = (acceptedMessageIds: readonly string[] = []) => ({ acceptedMessageIds });

describe('collecting outstanding obligations', () => {
  it('reports nothing when the outbox is empty', async () => {
    await expect(collectOutstandingMessageIds(new MemoryOutbox(), 'exec-1')).resolves.toEqual([]);
  });

  it('reports the ids this execution still owes', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-2' }));
    await expect(collectOutstandingMessageIds(outbox, 'exec-1')).resolves.toEqual(
      expect.arrayContaining(['msg-1', 'msg-2'])
    );
  });

  it('does not report another execution obligations', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'mine', executionId: 'exec-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'theirs', executionId: 'exec-2' }));
    await expect(collectOutstandingMessageIds(outbox, 'exec-1')).resolves.toEqual(['mine']);
  });
});

describe('synchronization', () => {
  it('retires exactly the obligations the server confirmed it accepted', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'accepted-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'still-owed' }));

    const report = await synchronize({
      outbox,
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(['accepted-1']),
      recoverOrphans: false
    });

    expect(report.acceptedMessageIds).toEqual(['accepted-1']);
    expect(report.pendingMessageIds).toEqual(['still-owed']);
  });

  it('keeps an unconfirmed obligation on disk rather than assuming it landed', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'still-owed' }));

    await synchronize({
      outbox,
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor([]),
      recoverOrphans: false
    });

    expect(outbox.stored.map((record) => record.messageId)).toEqual(['still-owed']);
  });

  it('reconciles records left behind by a process that exited before acknowledgment', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'orphan', deliveryClass: 'durable-result' }));

    const report = await synchronize({
      outbox,
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(),
      recoverOrphans: true
    });

    expect(report.reconciliation.scanned).toBeGreaterThan(0);
    expect(report.reconciliation.ok).toBe(true);
  });

  it('reports rather than hides an unreachable recovery authority', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'orphan', deliveryClass: 'durable-result' }));

    const report = await synchronize({
      outbox,
      authorities: makeUnavailableAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(),
      recoverOrphans: true
    });

    expect(report.reconciliation.ok).toBe(false);
    expect(report.reconciliation.blocked.length).toBeGreaterThan(0);
  });

  it('never treats a missing authority as an empty set of obligations', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'orphan', deliveryClass: 'durable-result' }));

    await synchronize({
      outbox,
      authorities: makeUnavailableAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(),
      recoverOrphans: true
    });

    expect(outbox.stored).toHaveLength(1);
  });
});

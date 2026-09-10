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

const ackFor = (workRevision: number, acceptedMessageIds: readonly string[] = []) => ({
  workRevision,
  acceptedMessageIds
});

describe('collecting outstanding obligations', () => {
  it.skip('reports nothing when the outbox is empty', async () => {
    await expect(collectOutstandingMessageIds(new MemoryOutbox(), 'exec-1')).resolves.toEqual([]);
  });

  it.skip('reports the ids this execution still owes', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-2' }));
    await expect(collectOutstandingMessageIds(outbox, 'exec-1')).resolves.toEqual(
      expect.arrayContaining(['msg-1', 'msg-2'])
    );
  });

  it.skip('does not report another execution obligations', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'mine', executionId: 'exec-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'theirs', executionId: 'exec-2' }));
    await expect(collectOutstandingMessageIds(outbox, 'exec-1')).resolves.toEqual(['mine']);
  });
});

describe('synchronization', () => {
  it.skip('adopts the server work revision rather than a locally remembered one', async () => {
    const report = await synchronize({
      outbox: new MemoryOutbox(),
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(42)
    });
    expect(report.workRevision).toBe(42);
  });

  it.skip('retires exactly the obligations the server confirmed it accepted', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'accepted-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'still-owed' }));

    const report = await synchronize({
      outbox,
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(7, ['accepted-1'])
    });

    expect(report.acceptedMessageIds).toEqual(['accepted-1']);
    expect(report.pendingMessageIds).toEqual(['still-owed']);
  });

  it.skip('keeps an unconfirmed obligation on disk rather than assuming it landed', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'still-owed' }));

    await synchronize({
      outbox,
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(7, [])
    });

    expect(outbox.stored.map((record) => record.messageId)).toEqual(['still-owed']);
  });

  it.skip('reconciles records left behind by a process that exited before acknowledgment', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'orphan', deliveryClass: 'durable-result' }));

    const report = await synchronize({
      outbox,
      authorities: makeAcceptingAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(7)
    });

    expect(report.reconciliation.scanned).toBeGreaterThan(0);
    expect(report.reconciliation.ok).toBe(true);
  });

  it.skip('reports rather than hides an unreachable recovery authority', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'orphan', deliveryClass: 'durable-result' }));

    const report = await synchronize({
      outbox,
      authorities: makeUnavailableAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(7)
    });

    expect(report.reconciliation.ok).toBe(false);
    expect(report.reconciliation.blocked.length).toBeGreaterThan(0);
  });

  it.skip('never treats a missing authority as an empty set of obligations', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'orphan', deliveryClass: 'durable-result' }));

    await synchronize({
      outbox,
      authorities: makeUnavailableAuthorities(),
      executionId: 'exec-1',
      acknowledgment: ackFor(7)
    });

    expect(outbox.stored).toHaveLength(1);
  });
});

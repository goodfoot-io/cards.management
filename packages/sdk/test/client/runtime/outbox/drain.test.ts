/**
 * Acceptance checks for the drain a live producer performs over its own records.
 *
 * The property under test throughout is that a record survives anything short of
 * an acknowledgment. A settlement that returns nothing, a corrupt sibling, a
 * record belonging to another role — none of them may result in a deletion,
 * because the record is the last copy of an obligation and the acknowledgment is
 * the only evidence that someone else has taken it.
 *
 * @summary Checks that role-scoped drain retires only what was acknowledged
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ClientOutbox,
  createFileClientOutbox,
  drainOwnRecords
} from '../../../../src/client/runtime/outbox/index.js';
import { countRecordFiles, listRecordFiles, makeOutboxRoot, makeRecordInput, scriptedDelivery } from './index.js';

describe('draining a producer own records', () => {
  let root: string;
  let outbox: ClientOutbox;

  beforeEach(() => {
    root = makeOutboxRoot();
    outbox = createFileClientOutbox({ root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retires every record the journal acknowledged', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-b' }));
    const { delivery } = scriptedDelivery(['msg-a', 'msg-b']);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(report.retired.map((r) => r.messageId).sort()).toEqual(['msg-a', 'msg-b']);
    expect(report.ok).toBe(true);
    expect(countRecordFiles(root)).toBe(0);
  });

  it('keeps a record whose settlement returned no acknowledgment', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { delivery } = scriptedDelivery([]);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(report.pending.map((r) => r.messageId)).toEqual(['msg-a']);
    expect(report.retired).toEqual([]);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('does not report ok while an obligation is still owed', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { delivery } = scriptedDelivery([]);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(report.ok).toBe(false);
  });

  it('retires the acknowledged record and keeps the unacknowledged one', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-b' }));
    const { delivery } = scriptedDelivery(['msg-a']);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-a']);
    expect(report.pending.map((r) => r.messageId)).toEqual(['msg-b']);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('never offers another role a record to settle', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-wrapper', role: 'runtime-wrapper' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-hook', role: 'agent-hook' }));
    const { delivery, settled } = scriptedDelivery(['msg-wrapper', 'msg-hook']);

    await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(settled.map((r) => r.messageId)).toEqual(['msg-wrapper']);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('never touches another execution', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-1', executionId: 'exec-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-2', executionId: 'exec-2' }));
    const { delivery } = scriptedDelivery(['msg-1', 'msg-2']);

    await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(countRecordFiles(root)).toBe(1);
  });

  it('drains the healthy records beside a corrupt one', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-good' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-bad' }));
    const bad = listRecordFiles(root).find((f) => fs.readFileSync(f, 'utf-8').includes('msg-bad')) as string;
    fs.writeFileSync(bad, 'garbage');
    const { delivery } = scriptedDelivery(['msg-good']);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-good']);
    expect(report.corrupt).toHaveLength(1);
  });

  it('refuses to report ok when it could not read a record', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-bad' }));
    fs.writeFileSync(listRecordFiles(root)[0] as string, 'garbage');
    const { delivery } = scriptedDelivery([]);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-1', role: 'runtime-wrapper' }, delivery);

    expect(report.ok).toBe(false);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('reports a clean pass over an empty scope', async () => {
    const { delivery } = scriptedDelivery([]);

    const report = await drainOwnRecords(outbox, { executionId: 'exec-none', role: 'cli' }, delivery);

    expect(report).toMatchObject({ scanned: 0, retired: [], pending: [], corrupt: [], ok: true });
  });
});

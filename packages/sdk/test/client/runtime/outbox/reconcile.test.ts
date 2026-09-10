/**
 * Acceptance checks for startup reconciliation of records whose producers have
 * exited.
 *
 * One check in here is the reason the module exists in the shape it does: an
 * authority that cannot be consulted must not behave like an authority that
 * recognises nothing. Those two produce identical-looking answers — every record
 * comes back unaccepted — and treating them alike would let a corrupt journal
 * retire a store full of real obligations and call it a clean startup. So the
 * suite asserts the two answers diverge in what they leave on disk and in what
 * they report.
 *
 * @summary Checks that reconciliation retires only accepted records and blocks on missing authority
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ClientOutbox,
  createFileClientOutbox,
  reconcileOutboxOnStartup
} from '../../../../src/client/runtime/outbox/index.js';
import {
  ackFor,
  countRecordFiles,
  listRecordFiles,
  makeOutboxRoot,
  makeRecordInput,
  scriptedAcceptor
} from './index.js';

describe('startup reconciliation', () => {
  let root: string;
  let outbox: ClientOutbox;

  beforeEach(() => {
    root = makeOutboxRoot();
    outbox = createFileClientOutbox({ root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retires a record the journal durably accepted', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { acceptor } = scriptedAcceptor((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-a']);
    expect(report.ok).toBe(true);
    expect(countRecordFiles(root)).toBe(0);
  });

  it('reconciles across every execution and role, since no producer survives to speak', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-1', executionId: 'exec-1', role: 'runtime-wrapper' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-2', executionId: 'exec-2', role: 'agent-hook' }));
    const { acceptor } = scriptedAcceptor((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.scanned).toBe(2);
    expect(countRecordFiles(root)).toBe(0);
  });

  it('keeps a record for an execution the journal does not recognise', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { acceptor } = scriptedAcceptor(() => ({ kind: 'not-admitted', detail: 'no such execution' }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.untrusted.map((f) => f.ref.messageId)).toEqual(['msg-a']);
    expect(report.retired).toEqual([]);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('does not report a clean startup while an unrecognised record sits on disk', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { acceptor } = scriptedAcceptor(() => ({ kind: 'not-admitted', detail: 'no such execution' }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.ok).toBe(false);
  });

  it('retires nothing at all when the authority cannot be consulted', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-b' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-c', executionId: 'exec-2' }));
    const { acceptor } = scriptedAcceptor(() => ({ kind: 'authority-unavailable', detail: 'journal corrupt' }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.retired).toEqual([]);
    expect(report.blocked).toHaveLength(3);
    expect(countRecordFiles(root)).toBe(3);
  });

  it('reports blocked rather than untrusted when authority was unavailable', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { acceptor } = scriptedAcceptor(() => ({ kind: 'authority-unavailable', detail: 'journal corrupt' }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.untrusted).toEqual([]);
    expect(report.blocked.map((f) => f.ref.messageId)).toEqual(['msg-a']);
    expect(report.ok).toBe(false);
  });

  it('carries the reason forward so an operator can act on it', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { acceptor } = scriptedAcceptor(() => ({ kind: 'authority-unavailable', detail: 'journal digest mismatch' }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.blocked[0]?.detail).toContain('journal digest mismatch');
  });

  it('offers the journal the request id the admission record is keyed by', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a', requestId: 'req-42' }));
    const { acceptor, offered } = scriptedAcceptor((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    await reconcileOutboxOnStartup(outbox, acceptor);

    expect(offered.map((r) => r.requestId)).toEqual(['req-42']);
  });

  it('never offers a record it could not read', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    fs.writeFileSync(listRecordFiles(root)[0] as string, 'garbage');
    const { acceptor, offered } = scriptedAcceptor((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(offered).toEqual([]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it('leaves the unreadable file as evidence rather than clearing it', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const file = listRecordFiles(root)[0] as string;
    fs.writeFileSync(file, 'garbage');
    const { acceptor } = scriptedAcceptor((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    await reconcileOutboxOnStartup(outbox, acceptor);

    expect(fs.readFileSync(file, 'utf-8')).toBe('garbage');
  });

  it('settles the healthy records while one execution stays blocked', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-ok', executionId: 'exec-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-blocked', executionId: 'exec-2' }));
    const { acceptor } = scriptedAcceptor((r) =>
      r.messageId === 'msg-ok'
        ? { kind: 'accepted', acknowledgment: ackFor(r.messageId) }
        : { kind: 'authority-unavailable', detail: 'journal corrupt' }
    );

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-ok']);
    expect(report.blocked.map((f) => f.ref.messageId)).toEqual(['msg-blocked']);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('reports a clean pass over an empty store', async () => {
    const { acceptor } = scriptedAcceptor(() => ({ kind: 'not-admitted', detail: 'unused' }));

    const report = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(report).toMatchObject({ scanned: 0, retired: [], untrusted: [], blocked: [], corrupt: [], ok: true });
  });

  it('is idempotent when startup runs twice', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { acceptor, offered } = scriptedAcceptor((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    await reconcileOutboxOnStartup(outbox, acceptor);
    const second = await reconcileOutboxOnStartup(outbox, acceptor);

    expect(offered).toHaveLength(1);
    expect(second).toMatchObject({ scanned: 0, retired: [], ok: true });
  });
});

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
  LAUNCH_INTENT_MESSAGE_TYPES,
  reconcileOutboxOnStartup
} from '../../../../src/client/runtime/outbox/index.js';
import { RUNTIME_MESSAGE_CONTRACTS } from '../../../../src/protocol/index.js';
import {
  ackFor,
  countRecordFiles,
  listRecordFiles,
  makeLaunchIntentInput,
  makeOutboxRoot,
  makeRecordInput,
  makeUnownedIntentInput,
  scriptedAuthorities
} from './index.js';

describe('launch-intent routing list', () => {
  it('names only types the protocol actually classes as durable intents', () => {
    for (const type of LAUNCH_INTENT_MESSAGE_TYPES) {
      expect(RUNTIME_MESSAGE_CONTRACTS[type].deliveryClass).toBe('durable-intent');
    }
  });

  it('leaves every other durable intent off the list, so a new one defaults to unowned', () => {
    const durableIntents = Object.values(RUNTIME_MESSAGE_CONTRACTS)
      .filter((contract) => contract.deliveryClass === 'durable-intent')
      .map((contract) => contract.type);
    const unlisted = durableIntents.filter((type) => !LAUNCH_INTENT_MESSAGE_TYPES.includes(type as never));

    // Not an equality assertion against a frozen list: the point is that adding
    // an intent to the protocol must not silently make it retirable. It lands
    // here, in the bucket nothing can retire, until someone takes custody of it.
    expect(unlisted.length).toBeGreaterThan(0);
    expect(unlisted).not.toContain('execution.launchRequest');
  });
});

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
    const { authorities } = scriptedAuthorities((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-a']);
    expect(report.ok).toBe(true);
    expect(countRecordFiles(root)).toBe(0);
  });

  it('reconciles across every execution and role, since no producer survives to speak', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-1', executionId: 'exec-1', role: 'runtime-wrapper' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-2', executionId: 'exec-2', role: 'agent-hook' }));
    const { authorities } = scriptedAuthorities((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.scanned).toBe(2);
    expect(countRecordFiles(root)).toBe(0);
  });

  it('keeps a record for an execution the journal does not recognise', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { authorities } = scriptedAuthorities(() => ({ kind: 'not-admitted', detail: 'no such execution' }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.untrusted.map((f) => f.ref.messageId)).toEqual(['msg-a']);
    expect(report.retired).toEqual([]);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('does not report a clean startup while an unrecognised record sits on disk', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { authorities } = scriptedAuthorities(() => ({ kind: 'not-admitted', detail: 'no such execution' }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.ok).toBe(false);
  });

  it('retires nothing at all when the authority cannot be consulted', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-b' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-c', executionId: 'exec-2' }));
    const { authorities } = scriptedAuthorities(() => ({ kind: 'authority-unavailable', detail: 'journal corrupt' }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.retired).toEqual([]);
    expect(report.blocked).toHaveLength(3);
    expect(countRecordFiles(root)).toBe(3);
  });

  it('reports blocked rather than untrusted when authority was unavailable', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { authorities } = scriptedAuthorities(() => ({ kind: 'authority-unavailable', detail: 'journal corrupt' }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.untrusted).toEqual([]);
    expect(report.blocked.map((f) => f.ref.messageId)).toEqual(['msg-a']);
    expect(report.ok).toBe(false);
  });

  it('carries the reason forward so an operator can act on it', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { authorities } = scriptedAuthorities(() => ({
      kind: 'authority-unavailable',
      detail: 'journal digest mismatch'
    }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.blocked[0]?.detail).toContain('journal digest mismatch');
  });

  it('offers the journal the request id the admission record is keyed by', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a', requestId: 'req-42' }));
    const { authorities, custodied } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    await reconcileOutboxOnStartup(outbox, authorities);

    expect(custodied.map((r) => r.requestId)).toEqual(['req-42']);
  });

  it('never offers a record it could not read', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    fs.writeFileSync(listRecordFiles(root)[0] as string, 'garbage');
    const { authorities, custodied } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(custodied).toEqual([]);
    expect(report.corrupt).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it('leaves the unreadable file as evidence rather than clearing it', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const file = listRecordFiles(root)[0] as string;
    fs.writeFileSync(file, 'garbage');
    const { authorities } = scriptedAuthorities((r) => ({ kind: 'accepted', acknowledgment: ackFor(r.messageId) }));

    await reconcileOutboxOnStartup(outbox, authorities);

    expect(fs.readFileSync(file, 'utf-8')).toBe('garbage');
  });

  it('settles the healthy records while one execution stays blocked', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-ok', executionId: 'exec-1' }));
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-blocked', executionId: 'exec-2' }));
    const { authorities } = scriptedAuthorities((r) =>
      r.messageId === 'msg-ok'
        ? { kind: 'accepted', acknowledgment: ackFor(r.messageId) }
        : { kind: 'authority-unavailable', detail: 'journal corrupt' }
    );

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-ok']);
    expect(report.blocked.map((f) => f.ref.messageId)).toEqual(['msg-blocked']);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('reports a clean pass over an empty store', async () => {
    const { authorities } = scriptedAuthorities(() => ({ kind: 'not-admitted', detail: 'unused' }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report).toMatchObject({ scanned: 0, retired: [], untrusted: [], blocked: [], corrupt: [], ok: true });
  });

  it('sends a durable result to the custodian and never to the intent validator', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { authorities, custodied, validated } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    await reconcileOutboxOnStartup(outbox, authorities);

    expect(custodied.map((r) => r.messageId)).toEqual(['msg-a']);
    expect(validated).toEqual([]);
  });

  it('sends a launch intent to the validator, since admission already holds that copy', async () => {
    await outbox.enqueue(makeLaunchIntentInput({ messageId: 'msg-launch' }));
    const { authorities, custodied, validated } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(validated.map((r) => r.messageId)).toEqual(['msg-launch']);
    expect(custodied).toEqual([]);
    expect(report.retired.map((r) => r.messageId)).toEqual(['msg-launch']);
  });

  it('refuses an intent no component durably holds, even when both authorities would accept it', async () => {
    await outbox.enqueue(makeUnownedIntentInput({ messageId: 'msg-cancel' }));
    const { authorities, custodied, validated } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(custodied).toEqual([]);
    expect(validated).toEqual([]);
    expect(report.unowned.map((f) => f.ref.messageId)).toEqual(['msg-cancel']);
    expect(report.retired).toEqual([]);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('reports an unowned record apart from a blocked one, since retrying cannot help it', async () => {
    await outbox.enqueue(makeUnownedIntentInput({ messageId: 'msg-cancel' }));
    const { authorities } = scriptedAuthorities(() => ({
      kind: 'authority-unavailable',
      detail: 'journal corrupt'
    }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.blocked).toEqual([]);
    expect(report.untrusted).toEqual([]);
    expect(report.unowned).toHaveLength(1);
    expect(report.unowned[0]?.detail).toContain('execution.cancelRequest');
    expect(report.ok).toBe(false);
  });

  it('settles a result and a launch intent while an unowned intent stays put', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-result' }));
    await outbox.enqueue(makeLaunchIntentInput({ messageId: 'msg-launch' }));
    await outbox.enqueue(makeUnownedIntentInput({ messageId: 'msg-cancel' }));
    const { authorities } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    const report = await reconcileOutboxOnStartup(outbox, authorities);

    expect(report.retired.map((r) => r.messageId).sort()).toEqual(['msg-launch', 'msg-result']);
    expect(report.unowned.map((f) => f.ref.messageId)).toEqual(['msg-cancel']);
    expect(countRecordFiles(root)).toBe(1);
  });

  it('is idempotent when startup runs twice', async () => {
    await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
    const { authorities, custodied } = scriptedAuthorities((r) => ({
      kind: 'accepted',
      acknowledgment: ackFor(r.messageId)
    }));

    await reconcileOutboxOnStartup(outbox, authorities);
    const second = await reconcileOutboxOnStartup(outbox, authorities);

    expect(custodied).toHaveLength(1);
    expect(second).toMatchObject({ scanned: 0, retired: [], ok: true });
  });
});

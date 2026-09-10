/**
 * Acceptance checks for the custody lookups backing server-side acknowledgment.
 *
 * The checks that matter most here are about what these functions refuse to
 * claim. An acknowledgment produced for a message this store does not hold would
 * tell a client to delete the only copy of an obligation, so the suite asserts
 * `null` for absent, unreadable, and unknown-schema records alike — three
 * different reasons, one answer, because the caller can act safely on only one of
 * them.
 *
 * @summary Checks that custody lookups never overstate what the store holds
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDurableResultReader,
  describeDurableResult,
  listDurableResults,
  takeResultCustody
} from '../../../../src/client/runtime/durable-results/index.js';
import type { OutboxRecord } from '../../../../src/client/runtime/outbox/index.js';
import { makeRecordInput } from '../outbox/index.js';

const CLOCK = (): Date => new Date('2026-09-10T12:00:00.000Z');

function makeRecord(overrides: Parameters<typeof makeRecordInput>[0] = {}): OutboxRecord {
  return {
    ...makeRecordInput(overrides),
    schemaVersion: 1,
    enqueuedAt: '2026-09-10T11:59:00.000Z'
  };
}

function custodyFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

describe('describing custody of one message', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-read-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('acknowledges a message it holds', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);

    expect(await describeDurableResult(root, 'exec-1', 'msg-a')).toEqual({
      messageId: 'msg-a',
      acknowledgedAt: '2026-09-10T12:00:00.000Z'
    });
  });

  it('reports when custody was taken, not when the lookup ran', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);

    const ack = await describeDurableResult(root, 'exec-1', 'msg-a');

    // A fresh timestamp here would claim the obligation was accepted now, when
    // it may have been accepted several restarts ago.
    expect(ack?.acknowledgedAt).toBe('2026-09-10T12:00:00.000Z');
    expect(ack?.acknowledgedAt).not.toBe(new Date().toISOString());
  });

  it('claims nothing for a message it never held', async () => {
    expect(await describeDurableResult(root, 'exec-1', 'never-written')).toBeNull();
  });

  it('claims nothing for a message held under a different execution', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a', executionId: 'exec-1' }), CLOCK);

    expect(await describeDurableResult(root, 'exec-2', 'msg-a')).toBeNull();
  });

  it('claims nothing when the custody record cannot be parsed', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    fs.writeFileSync(custodyFiles(root)[0] as string, 'garbage');

    expect(await describeDurableResult(root, 'exec-1', 'msg-a')).toBeNull();
  });

  it('does not let one unreadable record throw out of a batch of lookups', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    await takeResultCustody(root, makeRecord({ messageId: 'msg-b' }), CLOCK);
    fs.writeFileSync(custodyFiles(root)[0] as string, 'garbage');

    const answers = await Promise.all([
      describeDurableResult(root, 'exec-1', 'msg-a'),
      describeDurableResult(root, 'exec-1', 'msg-b')
    ]);

    expect(answers.filter((a) => a !== null)).toHaveLength(1);
  });

  it('claims nothing for a record written by an unknown schema version', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    fs.writeFileSync(custodyFiles(root)[0] as string, JSON.stringify({ schemaVersion: 99, messageId: 'msg-a' }));

    expect(await describeDurableResult(root, 'exec-1', 'msg-a')).toBeNull();
  });

  it('acknowledges the message it was asked about, since retirement compares that id', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    await takeResultCustody(root, makeRecord({ messageId: 'msg-b' }), CLOCK);

    expect((await describeDurableResult(root, 'exec-1', 'msg-b'))?.messageId).toBe('msg-b');
  });

  it('finds a message whose id contains path separators', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg/with/slashes' }), CLOCK);

    expect(await describeDurableResult(root, 'exec-1', 'msg/with/slashes')).not.toBeNull();
  });
});

describe('listing custody for one execution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-read-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recovers plaintext ids the digest file names cannot yield', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    await takeResultCustody(root, makeRecord({ messageId: 'msg-b' }), CLOCK);

    const inventory = await listDurableResults(root, 'exec-1');

    expect([...inventory.messageIds].sort()).toEqual(['msg-a', 'msg-b']);
    expect(inventory.corrupt).toEqual([]);
  });

  it('reports an empty inventory for an execution it holds nothing for', async () => {
    expect(await listDurableResults(root, 'exec-unknown')).toEqual({ messageIds: [], corrupt: [] });
  });

  it('sees only the execution it was asked about', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a', executionId: 'exec-1' }), CLOCK);
    await takeResultCustody(root, makeRecord({ messageId: 'msg-b', executionId: 'exec-2' }), CLOCK);

    expect((await listDurableResults(root, 'exec-1')).messageIds).toEqual(['msg-a']);
  });

  it('leaves an unparseable record out of the inventory rather than guessing at it', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    await takeResultCustody(root, makeRecord({ messageId: 'msg-b' }), CLOCK);
    fs.writeFileSync(custodyFiles(root)[0] as string, 'garbage');

    const inventory = await listDurableResults(root, 'exec-1');

    // Under-reporting costs a retransmission. Over-reporting would tell a client
    // to drop the only copy of something this store cannot produce.
    expect(inventory.messageIds).toHaveLength(1);
    expect(inventory.corrupt).toHaveLength(1);
  });

  it('names the file it could not trust, so the exclusion is actionable', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    const file = custodyFiles(root)[0] as string;
    fs.writeFileSync(file, 'garbage');

    const inventory = await listDurableResults(root, 'exec-1');

    expect(inventory.corrupt[0]?.path).toBe(file);
    expect(inventory.corrupt[0]?.detail).toContain('unparseable');
  });

  it('excludes a record written by an unknown schema version', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    fs.writeFileSync(custodyFiles(root)[0] as string, JSON.stringify({ schemaVersion: 99, messageId: 'msg-a' }));

    const inventory = await listDurableResults(root, 'exec-1');

    expect(inventory.messageIds).toEqual([]);
    expect(inventory.corrupt[0]?.detail).toContain('unknown schema version');
  });

  it('excludes a record whose message id is missing, since it can prove nothing', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    fs.writeFileSync(custodyFiles(root)[0] as string, JSON.stringify({ schemaVersion: 1 }));

    const inventory = await listDurableResults(root, 'exec-1');

    expect(inventory.messageIds).toEqual([]);
    expect(inventory.corrupt[0]?.detail).toContain('messageId');
  });

  it('leaves the untrusted file on disk as evidence', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    const file = custodyFiles(root)[0] as string;
    fs.writeFileSync(file, 'garbage');

    await listDurableResults(root, 'exec-1');

    expect(fs.readFileSync(file, 'utf-8')).toBe('garbage');
  });

  it('ignores the temporary files the write path uses', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    const shard = path.dirname(custodyFiles(root)[0] as string);
    fs.writeFileSync(path.join(shard, '.tmp-leftover'), 'partial write');

    const inventory = await listDurableResults(root, 'exec-1');

    expect(inventory.messageIds).toEqual(['msg-a']);
    expect(inventory.corrupt).toEqual([]);
  });
});

describe('the bound reader', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-read-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers both lookups against the root it was built with', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    const reader = createDurableResultReader(root);

    expect((await reader.describe('exec-1', 'msg-a'))?.messageId).toBe('msg-a');
    expect((await reader.list('exec-1')).messageIds).toEqual(['msg-a']);
  });

  it('cannot be pointed at another root after construction', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-other-'));
    try {
      await takeResultCustody(other, makeRecord({ messageId: 'msg-a' }), CLOCK);
      const reader = createDurableResultReader(root);

      expect(await reader.describe('exec-1', 'msg-a')).toBeNull();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

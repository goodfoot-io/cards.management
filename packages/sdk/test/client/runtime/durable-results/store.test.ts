/**
 * Acceptance checks for the durable-result custody store.
 *
 * The load-bearing check in here is the one asserting that a copy of the envelope
 * is on disk *before* `accepted` comes back. That ordering is the entire reason
 * this module exists: reconciliation unlinks the producer's copy on the strength
 * of that answer, so an implementation that acknowledged first and wrote later
 * would satisfy every other check in this file and still lose obligations.
 *
 * @summary Checks that custody is durable, idempotent, and never acknowledges without a copy
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileResultCustodian,
  DURABLE_RESULT_SCHEMA_VERSION,
  readResultCustody,
  resolveDurableResultRoot,
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

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) {
    return 0;
  }
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
}

describe('durable-result custody root', () => {
  it('resolves under the protected runtime directory, beside the outbox', () => {
    expect(resolveDurableResultRoot('/cfg')).toBe(path.join('/cfg', 'runtime', 'durable-results'));
  });

  it('isolates an extension development host from the real store', () => {
    expect(resolveDurableResultRoot('/cfg', 'edh-1')).toBe(
      path.join('/cfg', 'edh', 'edh-1', 'runtime', 'durable-results')
    );
  });

  it('never places custody inside a card repository', () => {
    expect(resolveDurableResultRoot('/cfg')).not.toContain('.git');
  });
});

describe('taking custody', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the envelope whole, so nothing re-decodes the protocol later', async () => {
    const record = makeRecord({ messageId: 'msg-a' });

    await takeResultCustody(root, record, CLOCK);

    const held = await readResultCustody(root, record.executionId, 'msg-a');
    expect(held?.envelope).toEqual(record.envelope);
  });

  it('stamps the schema version and the custody time', async () => {
    const record = makeRecord({ messageId: 'msg-a' });

    await takeResultCustody(root, record, CLOCK);

    const held = await readResultCustody(root, record.executionId, 'msg-a');
    expect(held?.schemaVersion).toBe(DURABLE_RESULT_SCHEMA_VERSION);
    expect(held?.custodiedAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('carries the request id forward, so the result can be tied back to its admission', async () => {
    const record = makeRecord({ messageId: 'msg-a', requestId: 'req-42' });

    await takeResultCustody(root, record, CLOCK);

    expect((await readResultCustody(root, record.executionId, 'msg-a'))?.requestId).toBe('req-42');
  });

  it('reports the second custody of one message as already held, not as a new copy', async () => {
    const record = makeRecord({ messageId: 'msg-a' });

    expect(await takeResultCustody(root, record, CLOCK)).toBe('created');
    expect(await takeResultCustody(root, record, CLOCK)).toBe('exists');
    expect(countFiles(root)).toBe(1);
  });

  it('keeps two messages of one execution apart', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);
    await takeResultCustody(root, makeRecord({ messageId: 'msg-b' }), CLOCK);

    expect(countFiles(root)).toBe(2);
  });

  it('never lets a caller-supplied identifier reach the path as text', async () => {
    const record = makeRecord({ messageId: '../../escape', executionId: '../../../etc' });

    await takeResultCustody(root, record, CLOCK);

    const written = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(written).toHaveLength(1);
    expect(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    for (const entry of written) {
      expect(entry.name).not.toContain('escape');
      expect(path.resolve(entry.parentPath, entry.name).startsWith(fs.realpathSync(root))).toBe(true);
    }
  });

  it('stores an identifier containing a separator without losing the record', async () => {
    const record = makeRecord({ messageId: 'msg/with/slashes' });

    await takeResultCustody(root, record, CLOCK);

    expect(await readResultCustody(root, record.executionId, 'msg/with/slashes')).not.toBeNull();
  });

  it('names the file by digest, so the store leaks no identifier to anyone listing it', async () => {
    const record = makeRecord({ messageId: 'msg-a' });

    await takeResultCustody(root, record, CLOCK);

    const digest = createHash('sha256').update('msg-a', 'utf8').digest('hex');
    const files = fs.readdirSync(root, { recursive: true }).map(String);
    expect(files).toContain(path.join(createHash('sha256').update('exec-1', 'utf8').digest('hex'), `${digest}.json`));
  });

  it('leaves no temporary file behind', async () => {
    await takeResultCustody(root, makeRecord({ messageId: 'msg-a' }), CLOCK);

    const names = fs.readdirSync(root, { recursive: true }).map(String);
    expect(names.filter((n) => path.basename(n).startsWith('.tmp-'))).toEqual([]);
  });

  it('reports nothing held for a message it never saw', async () => {
    expect(await readResultCustody(root, 'exec-1', 'never-written')).toBeNull();
  });

  it('refuses to read back a record written by an unknown schema version', async () => {
    const record = makeRecord({ messageId: 'msg-a' });
    await takeResultCustody(root, record, CLOCK);
    const file = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name))[0] as string;
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, messageId: 'msg-a' }));

    expect(await readResultCustody(root, record.executionId, 'msg-a')).toBeNull();
  });
});

describe('the custodian reconciliation calls', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('has the envelope on disk before it says the record may be retired', async () => {
    const custodian = createFileResultCustodian({ root, now: CLOCK });
    const record = makeRecord({ messageId: 'msg-a' });

    const acceptance = await custodian.takeCustody(record);

    // Read after the answer, asserting the copy was there to be found. If the
    // implementation ever acknowledges first and writes later, this is what fails.
    expect(acceptance.kind).toBe('accepted');
    expect(await readResultCustody(root, record.executionId, 'msg-a')).not.toBeNull();
  });

  it('acknowledges the record it was given, since retirement checks the message id', async () => {
    const custodian = createFileResultCustodian({ root, now: CLOCK });

    const acceptance = await custodian.takeCustody(makeRecord({ messageId: 'msg-a' }));

    expect(acceptance).toEqual({
      kind: 'accepted',
      acknowledgment: { messageId: 'msg-a', acknowledgedAt: '2026-09-10T12:00:00.000Z' }
    });
  });

  it('acknowledges again on a replay, so a crash between custody and retirement resolves', async () => {
    const custodian = createFileResultCustodian({ root, now: CLOCK });
    const record = makeRecord({ messageId: 'msg-a' });

    await custodian.takeCustody(record);
    const second = await custodian.takeCustody(record);

    expect(second.kind).toBe('accepted');
    expect(countFiles(root)).toBe(1);
  });

  it('declines an intent that reached it by a routing mistake rather than storing it', async () => {
    const custodian = createFileResultCustodian({ root, now: CLOCK });
    const misrouted = { ...makeRecord({ messageId: 'msg-a' }), deliveryClass: 'durable-intent' as const };

    const acceptance = await custodian.takeCustody(misrouted);

    expect(acceptance.kind).toBe('authority-unavailable');
    expect(countFiles(root)).toBe(0);
  });

  it('reports unavailability rather than throwing when the store cannot be written', async () => {
    const custodian = createFileResultCustodian({ root: path.join(root, 'file-in-the-way'), now: CLOCK });
    fs.writeFileSync(path.join(root, 'file-in-the-way'), 'not a directory');

    const acceptance = await custodian.takeCustody(makeRecord({ messageId: 'msg-a' }));

    expect(acceptance.kind).toBe('authority-unavailable');
  });

  it('never says not-admitted, since judging legitimacy is not its job', async () => {
    const custodian = createFileResultCustodian({ root: path.join(root, 'file-in-the-way'), now: CLOCK });
    fs.writeFileSync(path.join(root, 'file-in-the-way'), 'not a directory');

    const acceptance = await custodian.takeCustody(makeRecord({ messageId: 'msg-a' }));

    expect(acceptance.kind).not.toBe('not-admitted');
  });
});

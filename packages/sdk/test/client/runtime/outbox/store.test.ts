/**
 * Acceptance checks for the outbox store: its layout, its atomic write path, and
 * the two things it must refuse to do.
 *
 * The checks that matter most here are the negative ones. A store that writes and
 * reads back correctly is table stakes; a store that silently accepts a second
 * write of the same message ID, or that lets a caller-supplied identifier steer a
 * path, or that deletes a record it could not read, would each be a quiet
 * correctness hole rather than a visible bug.
 *
 * @summary Checks for outbox record storage, idempotent enqueue, scoping, and refusals
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ClientOutbox,
  createFileClientOutbox,
  OUTBOX_SCHEMA_VERSION,
  resolveOutboxRoot
} from '../../../../src/client/runtime/outbox/index.js';
import { ackFor, countRecordFiles, listRecordFiles, makeOutboxRoot, makeRecordInput } from './index.js';

describe('outbox root resolution', () => {
  it('places the store beside runtime authority, not in any card repository', () => {
    const root = resolveOutboxRoot('/home/user/.cards');

    expect(root).toBe(path.join('/home/user/.cards', 'runtime', 'outbox'));
  });

  it('isolates an extension development host under its own id', () => {
    const root = resolveOutboxRoot('/home/user/.cards', 'edh-7');

    expect(root).toBe(path.join('/home/user/.cards', 'edh', 'edh-7', 'runtime', 'outbox'));
  });
});

describe('outbox store', () => {
  let root: string;
  let outbox: ClientOutbox;

  beforeEach(() => {
    root = makeOutboxRoot();
    outbox = createFileClientOutbox({ root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('enqueue', () => {
    it('stores a record the matching scope can read back', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records.map((r) => r.messageId)).toEqual(['msg-a']);
      expect(scan.corrupt).toEqual([]);
    });

    it('stamps the fields a producer does not supply', async () => {
      const clocked = createFileClientOutbox({ root, now: () => new Date('2026-01-01T00:00:00.000Z') });
      await clocked.enqueue(makeRecordInput());

      const [record] = (await clocked.scan({ executionId: 'exec-1', role: 'runtime-wrapper' })).records;

      expect(record?.schemaVersion).toBe(OUTBOX_SCHEMA_VERSION);
      expect(record?.enqueuedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('preserves the envelope byte for byte', async () => {
      const input = makeRecordInput();
      await outbox.enqueue(input);

      const [record] = (await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' })).records;

      expect(record?.envelope).toEqual(input.envelope);
    });

    it('reports exists rather than duplicating a replayed message id', async () => {
      const first = await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const second = await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));

      expect(first).toBe('created');
      expect(second).toBe('exists');
      expect(countRecordFiles(root)).toBe(1);
    });

    it('lets exactly one of many concurrent writers create the same message', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => outbox.enqueue(makeRecordInput({ messageId: 'msg-race' })))
      );

      expect(results.filter((r) => r === 'created')).toHaveLength(1);
      expect(countRecordFiles(root)).toBe(1);
    });

    it('keeps two producers on one execution from colliding', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-w', role: 'runtime-wrapper' }));
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-h', role: 'agent-hook' }));

      expect(countRecordFiles(root)).toBe(2);
    });

    it('never lets a caller-supplied identifier escape the root', async () => {
      await outbox.enqueue(
        makeRecordInput({ messageId: '../../escaped', executionId: '../../../etc', requestId: 'req-x' })
      );

      for (const file of listRecordFiles(root)) {
        expect(path.resolve(file).startsWith(path.resolve(root))).toBe(true);
      }
      expect(countRecordFiles(root)).toBe(1);
    });

    it('refuses a delivery class the outbox will not retain', async () => {
      const readiness = { ...makeRecordInput(), deliveryClass: 'revocable-readiness' as never };

      await expect(outbox.enqueue(readiness)).rejects.toThrow(/delivery class/);
      expect(countRecordFiles(root)).toBe(0);
    });

    it('reads back a record whose identifiers contain path separators', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'a/b/c', executionId: 'x/y' }));

      const scan = await outbox.scan({ executionId: 'x/y', role: 'runtime-wrapper' });

      expect(scan.records.map((r) => r.messageId)).toEqual(['a/b/c']);
    });
  });

  describe('scan', () => {
    it('shows a producer only its own role', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-w', role: 'runtime-wrapper' }));
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-h', role: 'agent-hook' }));

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records.map((r) => r.messageId)).toEqual(['msg-w']);
    });

    it('shows a producer only its own execution', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-1', executionId: 'exec-1' }));
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-2', executionId: 'exec-2' }));

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records.map((r) => r.messageId)).toEqual(['msg-1']);
    });

    it('returns empty for a scope that has never been written', async () => {
      const scan = await outbox.scan({ executionId: 'exec-unknown', role: 'cli' });

      expect(scan.records).toEqual([]);
      expect(scan.corrupt).toEqual([]);
    });

    it('ignores a temp file left behind by an interrupted write', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const dir = path.dirname(listRecordFiles(root)[0] as string);
      fs.writeFileSync(path.join(dir, '.tmp-abandoned'), '{"schemaVersion":1}');

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records.map((r) => r.messageId)).toEqual(['msg-a']);
      expect(scan.corrupt).toEqual([]);
    });

    it('sees every execution and role from the unscoped startup view', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-1', executionId: 'exec-1', role: 'runtime-wrapper' }));
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-2', executionId: 'exec-2', role: 'agent-hook' }));

      const scan = await outbox.scanAll();

      expect(scan.records.map((r) => r.messageId).sort()).toEqual(['msg-1', 'msg-2']);
    });
  });

  describe('corruption', () => {
    it('reports an unparseable record instead of returning it', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const [file] = listRecordFiles(root);
      fs.writeFileSync(file as string, '{ not json');

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records).toEqual([]);
      expect(scan.corrupt).toHaveLength(1);
    });

    it('leaves the unreadable file exactly where it was', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const [file] = listRecordFiles(root);
      fs.writeFileSync(file as string, '{ not json');

      await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(fs.readFileSync(file as string, 'utf-8')).toBe('{ not json');
    });

    it('refuses a record written by an unknown schema version', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const [file] = listRecordFiles(root);
      const parsed = JSON.parse(fs.readFileSync(file as string, 'utf-8'));
      fs.writeFileSync(file as string, JSON.stringify({ ...parsed, schemaVersion: 99 }));

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records).toEqual([]);
      expect(scan.corrupt).toHaveLength(1);
    });

    it('still returns the healthy records beside a corrupt one', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-good' }));
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-bad' }));
      const files = listRecordFiles(root);
      const bad = files.find((f) => fs.readFileSync(f, 'utf-8').includes('msg-bad'));
      fs.writeFileSync(bad as string, 'garbage');

      const scan = await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' });

      expect(scan.records.map((r) => r.messageId)).toEqual(['msg-good']);
      expect(scan.corrupt).toHaveLength(1);
    });
  });

  describe('retire', () => {
    it('deletes the record once the journal has acknowledged it', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const [record] = (await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' })).records;

      const result = await outbox.retire(
        {
          messageId: 'msg-a',
          executionId: 'exec-1',
          role: 'runtime-wrapper',
          path: listRecordFiles(root)[0] as string
        },
        ackFor('msg-a')
      );

      expect(record?.messageId).toBe('msg-a');
      expect(result).toEqual({ kind: 'retired' });
      expect(countRecordFiles(root)).toBe(0);
    });

    it('refuses an acknowledgment that names a different message', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const file = listRecordFiles(root)[0] as string;

      const result = await outbox.retire(
        { messageId: 'msg-a', executionId: 'exec-1', role: 'runtime-wrapper', path: file },
        ackFor('msg-other')
      );

      expect(result.kind).toBe('refused');
      expect(countRecordFiles(root)).toBe(1);
    });

    it('reports a replayed retirement as already retired rather than failing', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const ref = {
        messageId: 'msg-a',
        executionId: 'exec-1',
        role: 'runtime-wrapper' as const,
        path: listRecordFiles(root)[0] as string
      };

      await outbox.retire(ref, ackFor('msg-a'));
      const second = await outbox.retire(ref, ackFor('msg-a'));

      expect(second).toEqual({ kind: 'already-retired' });
    });

    it('ignores a fabricated path and deletes only what the identifiers name', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      const bystander = path.join(root, 'bystander.json');
      fs.writeFileSync(bystander, 'not part of the store');

      const result = await outbox.retire(
        { messageId: 'msg-a', executionId: 'exec-1', role: 'runtime-wrapper', path: bystander },
        ackFor('msg-a')
      );

      expect(result).toEqual({ kind: 'retired' });
      expect(fs.existsSync(bystander)).toBe(true);
      expect((await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' })).records).toEqual([]);
    });

    it('leaves a sibling record untouched', async () => {
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-a' }));
      await outbox.enqueue(makeRecordInput({ messageId: 'msg-b' }));
      const records = (await outbox.scan({ executionId: 'exec-1', role: 'runtime-wrapper' })).records;
      const target = listRecordFiles(root).find((f) => fs.readFileSync(f, 'utf-8').includes('"msg-a"')) as string;

      await outbox.retire(
        { messageId: 'msg-a', executionId: 'exec-1', role: 'runtime-wrapper', path: target },
        ackFor('msg-a')
      );

      expect(records).toHaveLength(2);
      expect(countRecordFiles(root)).toBe(1);
    });
  });
});

/**
 * Tests for the full-pass reconciler.
 *
 * @summary Covers nested dest paths, sidecar shape/once-only writing, the shrink guard, and copy mode.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGeneratedSubagentTitle, type StreamMetaFile } from '../../../src/protocol/types/stream.js';
import { Reconciler } from '../../../src/transcript-sync/engine/reconciler.js';
import type { SessionSyncManifest } from '../../../src/transcript-sync/manifest.js';

describe('Reconciler', () => {
  let watchRoot: string;
  let cardRepoPath: string;
  let manifest: SessionSyncManifest;
  const warnFn = () => {};
  const errorFn = () => {};

  beforeEach(() => {
    const base = join(tmpdir(), `reconciler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    watchRoot = join(base, 'watchRoot');
    cardRepoPath = join(base, 'card');
    mkdirSync(watchRoot, { recursive: true });
    mkdirSync(cardRepoPath, { recursive: true });

    manifest = {
      version: 1,
      sessionId: 'sess-1',
      cardId: 'card-1',
      runtime: 'claude-code',
      streamType: 'claude-code-session',
      watchRoot,
      sources: [
        { pattern: 'sess-1.jsonl', role: 'main', mode: 'jsonl-tail' },
        { pattern: 'sess-1/subagents/*.jsonl', role: 'subagent', mode: 'jsonl-tail' },
        { pattern: 'aux.txt', role: 'auxiliary', mode: 'copy' }
      ],
      monitorPid: process.pid,
      cardRepoPath
    };
  });

  afterEach(() => {
    rmSync(join(watchRoot, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function destRoot(): string {
    return join(cardRepoPath, 'streams', manifest.streamType);
  }

  it('tails a matched main file into a nested destination path', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\n');
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const destPath = join(destRoot(), 'sess-1.jsonl');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe('line1\n');
  });

  it('syncs a nested subagent file to the mirrored nested destination path', async () => {
    mkdirSync(join(watchRoot, 'sess-1', 'subagents'), { recursive: true });
    writeFileSync(join(watchRoot, 'sess-1', 'subagents', 'agent-a.jsonl'), 'sub-line\n');

    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const destPath = join(destRoot(), 'sess-1', 'subagents', 'agent-a.jsonl');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe('sub-line\n');
  });

  it('syncs an opencode-shaped main + subagent pair to streams/opencode-session with subagent sidecar metadata', async () => {
    const sid = 'oc-sess-9';
    const opencodeManifest: SessionSyncManifest = {
      version: 1,
      sessionId: sid,
      cardId: 'card-opencode',
      runtime: 'opencode',
      streamType: 'opencode-session',
      watchRoot,
      sources: [
        { pattern: `${sid}.jsonl`, role: 'main', mode: 'jsonl-tail' },
        { pattern: `${sid}/subagents/*.jsonl`, role: 'subagent', mode: 'jsonl-tail' }
      ],
      monitorPid: process.pid,
      cardRepoPath
    };
    mkdirSync(join(watchRoot, sid, 'subagents'), { recursive: true });
    writeFileSync(join(watchRoot, `${sid}.jsonl`), 'main-line\n');
    writeFileSync(join(watchRoot, sid, 'subagents', 'child-1.jsonl'), 'child-line\n');

    const reconciler = new Reconciler(opencodeManifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const opDestRoot = join(cardRepoPath, 'streams', 'opencode-session');
    expect(readFileSync(join(opDestRoot, `${sid}.jsonl`), 'utf-8')).toBe('main-line\n');
    const childDest = join(opDestRoot, sid, 'subagents', 'child-1.jsonl');
    expect(readFileSync(childDest, 'utf-8')).toBe('child-line\n');

    const meta = JSON.parse(readFileSync(`${childDest}.meta.json`, 'utf-8')) as StreamMetaFile;
    expect(meta.role).toBe('subagent');
    expect(meta.agentId).toBe('child-1');
    expect(meta.runtime).toBe('opencode');
    expect(meta.streamType).toBe('opencode-session');
    expect(meta.title).toBeUndefined();
  });

  it('writes the sidecar once, with the full StreamMetaFile shape, and never overwrites it', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\n');
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const sidecarPath = join(destRoot(), 'sess-1.jsonl.meta.json');
    const meta = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as StreamMetaFile;
    expect(meta).toMatchObject({
      version: 1,
      relPath: 'sess-1.jsonl',
      streamType: 'claude-code-session',
      runtime: 'claude-code',
      sessionId: 'sess-1',
      role: 'main',
      title: 'claude-code session for card-1',
      sourcePath: join(watchRoot, 'sess-1.jsonl'),
      lineCount: 0
    });
    expect(meta.agentId).toBeUndefined();
    expect(typeof meta.startedAt).toBe('string');

    // Second pass with more content must not rewrite the sidecar.
    const firstSidecarMtime = readFileSync(sidecarPath, 'utf-8');
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\nline2\n');
    await reconciler.reconcileOnce(warnFn, errorFn);
    expect(readFileSync(sidecarPath, 'utf-8')).toBe(firstSidecarMtime);
  });

  it('derives a subagent sidecar agentId from the relPath basename without extension', async () => {
    mkdirSync(join(watchRoot, 'sess-1', 'subagents'), { recursive: true });
    writeFileSync(join(watchRoot, 'sess-1', 'subagents', 'worker-7.jsonl'), 'x\n');

    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const sidecarPath = join(destRoot(), 'sess-1', 'subagents', 'worker-7.jsonl.meta.json');
    const meta = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as StreamMetaFile;
    expect(meta.agentId).toBe('worker-7');
    expect(meta.role).toBe('subagent');
  });

  it('writes no card-scoped title on subagent sidecars, so each keeps only its distinct native identity', async () => {
    mkdirSync(join(watchRoot, 'sess-1', 'subagents'), { recursive: true });
    for (const agent of ['agent-aconnection-fix-2-51fbfcd79224af0c', 'agent-a37e08eab6309e87f'])
      writeFileSync(join(watchRoot, 'sess-1', 'subagents', `${agent}.jsonl`), 'x\n');

    await new Reconciler(manifest).reconcileOnce(warnFn, errorFn);

    const metas = ['agent-aconnection-fix-2-51fbfcd79224af0c', 'agent-a37e08eab6309e87f'].map(
      (agent) =>
        JSON.parse(
          readFileSync(join(destRoot(), 'sess-1', 'subagents', `${agent}.jsonl.meta.json`), 'utf-8')
        ) as StreamMetaFile
    );
    for (const meta of metas) {
      expect(meta).not.toHaveProperty('title');
      expect(JSON.stringify(meta)).not.toContain('Subagent transcript for');
    }
    expect(metas.map((meta) => meta.agentId)).toEqual([
      'agent-aconnection-fix-2-51fbfcd79224af0c',
      'agent-a37e08eab6309e87f'
    ]);
    // The placeholder recogniser readers use for already-committed sidecars matches what was once generated.
    expect(isGeneratedSubagentTitle('Subagent transcript for card-1', 'card-1')).toBe(true);
    expect(isGeneratedSubagentTitle('Subagent transcript for card-1', 'card-2')).toBe(false);
    expect(isGeneratedSubagentTitle('Fix the connection snapshot', 'card-1')).toBe(false);
  });

  it('is a cheap no-op on a second pass with nothing new (offset-based)', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\n');
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const destPath = join(destRoot(), 'sess-1.jsonl');
    expect(readFileSync(destPath, 'utf-8')).toBe('line1\n');
  });

  it('copies a "copy"-mode file idempotently', async () => {
    writeFileSync(join(watchRoot, 'aux.txt'), 'binary-ish content');
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    const destPath = join(destRoot(), 'aux.txt');
    expect(readFileSync(destPath, 'utf-8')).toBe('binary-ish content');

    // Grow (not shrink) the source — a copy-mode file that shrinks trips the
    // same shrink guard as jsonl-tail mode, which is covered separately below.
    writeFileSync(join(watchRoot, 'aux.txt'), 'updated content, now longer');
    await reconciler.reconcileOnce(warnFn, errorFn);
    expect(readFileSync(destPath, 'utf-8')).toBe('updated content, now longer');
  });

  it('marks a file permanently failed when the source shrinks below its consumed offset, and excludes it from further syncing', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\nline2\n');
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);

    let errorMessages: string[] = [];
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'x'); // shrink below consumed offset
    await reconciler.reconcileOnce(warnFn, (msg) => errorMessages.push(msg));

    const state = reconciler.getFileState('sess-1.jsonl');
    expect(state?.failed).toBeDefined();
    expect(errorMessages.some((m) => m.includes('sess-1.jsonl'))).toBe(true);

    // Grow the source back — the file must remain excluded, not resurrected.
    errorMessages = [];
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\nline2\nline3\n');
    await reconciler.reconcileOnce(warnFn, (msg) => errorMessages.push(msg));
    expect(errorMessages).toHaveLength(0);
    expect(reconciler.getFileState('sess-1.jsonl')?.failed).toBeDefined();

    const destPath = join(destRoot(), 'sess-1.jsonl');
    expect(readFileSync(destPath, 'utf-8')).toBe('line1\nline2\n');
  });

  it('warns-and-continues past a per-file error without aborting the whole pass', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'main-line\n');
    mkdirSync(join(watchRoot, 'sess-1', 'subagents'), { recursive: true });
    // Make the subagent destination directory unwritable-as-a-file by pre-creating
    // a same-named file where the reconciler would need a directory, forcing a
    // per-file error while leaving the main file syncable.
    writeFileSync(join(watchRoot, 'sess-1', 'subagents', 'agent-a.jsonl'), 'sub\n');
    const badDestParent = join(destRoot(), 'sess-1', 'subagents');
    mkdirSync(join(destRoot(), 'sess-1'), { recursive: true });
    writeFileSync(badDestParent, 'not a directory'); // collides with the dir reconciler needs to mkdir

    const warnings: string[] = [];
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce((msg) => warnings.push(msg), errorFn);

    expect(warnings.length).toBeGreaterThan(0);
    const destPath = join(destRoot(), 'sess-1.jsonl');
    expect(readFileSync(destPath, 'utf-8')).toBe('main-line\n');
  });

  it('tolerates a matched source file that does not exist yet (ENOENT race)', async () => {
    // sess-1.jsonl matches but hasn't been created; aux.txt is present.
    writeFileSync(join(watchRoot, 'aux.txt'), 'present\n');
    const reconciler = new Reconciler(manifest);
    await expect(reconciler.reconcileOnce(warnFn, errorFn)).resolves.toBeUndefined();
    expect(existsSync(join(destRoot(), 'sess-1.jsonl'))).toBe(false);
    expect(existsSync(join(destRoot(), 'aux.txt'))).toBe(true);
  });

  it('ignores files under watchRoot that match no source', async () => {
    writeFileSync(join(watchRoot, 'unrelated.log'), 'noise\n');
    const reconciler = new Reconciler(manifest);
    await reconciler.reconcileOnce(warnFn, errorFn);
    expect(existsSync(join(destRoot(), 'unrelated.log'))).toBe(false);
  });
});

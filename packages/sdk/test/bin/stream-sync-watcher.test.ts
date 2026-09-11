/**
 * Stream-sync watcher composition tests independent of transport mechanics.
 * @summary Stream-sync watcher behavior tests
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMinimalIdentity, runSession } from '../../src/bin/stream-sync-watcher.js';
import type { ReconnectingWatcherHandle } from '../../src/config/watcher/reconnectingWatcher.js';
import type { SessionSyncManifest } from '../../src/transcript-sync/manifest.js';

describe('parseMinimalIdentity', () => {
  it('extracts valid identity and refuses malformed identity', () => {
    expect(parseMinimalIdentity(JSON.stringify({ sessionId: 's1', cardId: 'c1' }))).toEqual({
      sessionId: 's1',
      cardId: 'c1'
    });
    expect(parseMinimalIdentity('{bad')).toBeNull();
    expect(parseMinimalIdentity(JSON.stringify({ sessionId: 1, cardId: 'c1' }))).toBeNull();
    expect(parseMinimalIdentity(JSON.stringify({ sessionId: 's1', cardId: '' }))).toBeNull();
  });
});

describe('runSession', () => {
  let base: string;
  let watchRoot: string;
  let cardRepoPath: string;
  let manifest: SessionSyncManifest;
  let stop: (() => Promise<void> | void) | undefined;
  let events: { type: string; data: unknown }[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stream-watcher-'));
    watchRoot = join(base, 'source');
    cardRepoPath = join(base, 'card');
    mkdirSync(watchRoot);
    mkdirSync(cardRepoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: cardRepoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: cardRepoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: cardRepoPath });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: cardRepoPath });
    stop = undefined;
    events = [];
    manifest = {
      version: 1,
      sessionId: 'sess-1',
      cardId: 'card-1',
      runtime: 'claude-code',
      streamType: 'claude-code-session',
      watchRoot,
      sources: [{ pattern: 'sess-1.jsonl', role: 'main', mode: 'jsonl-tail' }],
      monitorPid: 2147483647,
      cardRepoPath
    };
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function handle(): ReconnectingWatcherHandle {
    return {
      ctx: {
        cwd: base,
        logger: { debug() {}, info() {}, warn() {}, error() {}, logError() {} },
        emit: (event) => events.push(event),
        onControl: (_type, handler) => {
          stop = handler;
        }
      },
      waitForStop: async () => undefined,
      shutdown() {}
    };
  }

  it('syncs, reports watching, and commits on process-death exit', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\n');
    await runSession(manifest, handle());
    const destination = join(cardRepoPath, 'streams', 'claude-code-session', 'sess-1.jsonl');
    expect(readFileSync(destination, 'utf8')).toBe('line1\n');
    expect(existsSync(`${destination}.meta.json`)).toBe(true);
    expect(events.some((event) => event.type === 'watching')).toBe(true);
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: cardRepoPath, encoding: 'utf8' })).toContain(
      'Close session sess-1.'
    );
  });

  it('closes promptly through its registered stop handler', async () => {
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\n');
    manifest = { ...manifest, monitorPid: process.pid };
    const running = runSession(manifest, handle());
    while (!stop) await new Promise((resolve) => setTimeout(resolve, 5));
    await stop();
    await running;
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: cardRepoPath, encoding: 'utf8' })).toContain(
      'Close session sess-1.'
    );
  });

  it('recovers an existing destination without duplicating it', async () => {
    const destination = join(cardRepoPath, 'streams', 'claude-code-session');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'sess-1.jsonl'), 'line1\n');
    writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\nline2\n');
    await runSession(manifest, handle());
    expect(readFileSync(join(destination, 'sess-1.jsonl'), 'utf8')).toBe('line1\nline2\n');
  });
});

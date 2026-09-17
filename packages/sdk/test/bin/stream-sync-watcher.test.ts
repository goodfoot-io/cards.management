/**
 * Stream-sync watcher composition tests independent of transport mechanics.
 * @summary Stream-sync watcher behavior tests
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFinalizationController, parseMinimalIdentity, runSession } from '../../src/bin/stream-sync-watcher.js';
import type { ReconnectingWatcherHandle } from '../../src/config/watcher/reconnectingWatcher.js';
import {
  readExecutionFinalization,
  registerExecutionFinalization,
  SESSION_FINALIZATION_FILE_ENV
} from '../../src/transcript-sync/engine/execution-finalization.js';
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

describe('createFinalizationController', () => {
  it('wakes a pending sleep at once instead of at the end of the tick', async () => {
    const controller = createFinalizationController(async () => undefined);
    try {
      const startedAt = Date.now();
      const sleeping = controller.sleep(5_000);
      await controller.requestFinalization('control-stop');
      await sleeping;
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(controller.signal.stopped).toBe(true);
    } finally {
      controller.dispose();
    }
  });

  it('resolves a sleep started after the request without waiting', async () => {
    const controller = createFinalizationController(async () => undefined);
    try {
      await controller.requestFinalization('local');
      const startedAt = Date.now();
      await controller.sleep(5_000);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      controller.dispose();
    }
  });

  it('runs the finalizer once however many paths ask, and records the first asker', async () => {
    let runs = 0;
    const controller = createFinalizationController(async () => {
      runs += 1;
    });
    try {
      await Promise.all([
        controller.requestFinalization('sigterm'),
        controller.requestFinalization('control-stop'),
        controller.requestFinalization('local')
      ]);
      await controller.requestFinalization('control-stop');
      expect(runs).toBe(1);
      expect(controller.trigger).toBe('sigterm');
    } finally {
      controller.dispose();
    }
  });

  it('finalizes on SIGTERM without any control socket, and stops doing so once disposed', async () => {
    let runs = 0;
    const controller = createFinalizationController(async () => {
      runs += 1;
    });
    process.emit('SIGTERM');
    await controller.requestFinalization('local');
    expect(runs).toBe(1);
    expect(controller.trigger).toBe('sigterm');

    const listenersBefore = process.listenerCount('SIGTERM');
    controller.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore - 1);
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

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

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

  it.each([
    'complete',
    'missing-main',
    'commit-failed'
  ])('publishes truthful finalization after a %s close', async (mode) => {
    const directory = join(base, 'execution');
    const file = registerExecutionFinalization(manifest, directory)!;
    vi.stubEnv(SESSION_FINALIZATION_FILE_ENV, file);
    if (mode !== 'missing-main') writeFileSync(join(watchRoot, 'sess-1.jsonl'), 'line1\n');
    if (mode === 'commit-failed') writeFileSync(join(cardRepoPath, '.git', 'index.lock'), 'locked');
    await runSession(manifest, handle());
    expect(await readExecutionFinalization(directory)).toBe(mode === 'complete' ? 'complete' : 'incomplete');
  });

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

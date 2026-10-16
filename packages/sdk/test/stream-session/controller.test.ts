/**
 * Deterministic injected-client acceptance checks for session synchronization.
 * @summary Controller bootstrap race and isolation contracts
 */
import { describe, expect, it } from 'vitest';
import type { StreamMeta, StreamSourceSnapshot } from '../../src/protocol/types/stream.js';
import {
  createSessionController,
  type SessionController,
  type SessionControllerEvent,
  type SessionDiagnostic,
  SessionSourceError,
  type SessionSourceEvent,
  streamSourceKey
} from '../../src/stream-session/index.js';

const source = { cardId: 'card', streamType: 'claude', relPath: 'main.jsonl' };
const session = { cardId: 'card', streamType: 'claude', sessionId: 'session' };
const version = { serverEpoch: 'server-1', sourceEpoch: 'source-1' };
const binding = { sessionId: 'session', role: 'main' as const };
const meta: StreamMeta = {
  version: 1,
  streamType: 'claude',
  relPath: 'main.jsonl',
  runtime: 'claude',
  sessionId: 'session',
  role: 'main',
  sourcePath: '/native/main',
  startedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  lineCount: 1,
  isActive: true
};

/**
 * Flushes chained asynchronous controller continuations deterministically.
 * @returns Completion after queued promise work.
 */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

/**
 * Builds a deferred real client/event adapter with explicit scheduling controls.
 * @returns Controller and controls for pending metadata, history, and events.
 */
function harness(): {
  controller: SessionController;
  lists: Array<(value: StreamMeta[]) => void>;
  reads: Array<{
    mode: string;
    signal: AbortSignal;
    resolve(value: StreamSourceSnapshot): void;
    reject(reason: Error): void;
  }>;
  order: string[];
  diagnostics: SessionDiagnostic[];
  emit(event: SessionControllerEvent): void;
  tick(): void;
  listeners(): number;
} {
  const lists: Array<(value: StreamMeta[]) => void> = [];
  const reads: Array<{
    mode: string;
    signal: AbortSignal;
    resolve(value: StreamSourceSnapshot): void;
    reject(reason: Error): void;
  }> = [];
  const order: string[] = [];
  const diagnostics: SessionDiagnostic[] = [];
  let listener: ((event: SessionControllerEvent) => void) | undefined;
  let timer: (() => void) | undefined;
  const controller = createSessionController({
    session,
    generation: 'view-1',
    client: {
      listStreams() {
        order.push('list');
        return new Promise((resolve) => lists.push(resolve));
      },
      getStream(_source, mode, signal) {
        return new Promise((resolve, reject) => reads.push({ mode, signal, resolve, reject }));
      }
    },
    events: {
      subscribe(next) {
        order.push('listen');
        listener = next;
        return () => {
          listener = undefined;
        };
      }
    },
    scheduler: {
      every(milliseconds, callback) {
        expect(milliseconds).toBe(30_000);
        timer = callback;
        return () => {
          timer = undefined;
        };
      }
    },
    publish() {},
    diagnostic(event) {
      diagnostics.push(event);
    }
  });
  return {
    controller,
    lists,
    reads,
    order,
    diagnostics,
    emit(event) {
      listener?.(event);
    },
    tick() {
      timer?.();
    },
    listeners() {
      return Number(listener !== undefined) + Number(timer !== undefined);
    }
  };
}

/**
 * Starts a controller with one accepted member and a pending initial source read.
 * @returns Harness with initialized membership.
 */
async function opened(): Promise<ReturnType<typeof harness>> {
  const test = harness();
  test.controller.start();
  test.lists.shift()?.([meta]);
  await flush();
  test.controller.subscribe({ source, mode: 'tail', requestId: 'r1', generation: 'view-1' });
  await flush();
  return test;
}

/**
 * Creates a coherent authority-bearing native snapshot.
 * @param lines - Native complete lines.
 * @param overrides - Snapshot variations for races.
 * @returns Snapshot consumed by the injected client.
 */
function snapshot(lines: string[], overrides: Partial<StreamSourceSnapshot> = {}): StreamSourceSnapshot {
  return {
    source,
    version,
    binding,
    meta: { ...meta, lineCount: overrides.totalLineCount ?? lines.length },
    lines,
    firstLineNumber: 1,
    totalLineCount: lines.length,
    ...overrides
  };
}

/**
 * Creates an exact authority-bearing native append.
 * @param lineNumber - Absolute coordinate.
 * @param line - Complete native line.
 * @returns Publication without provider normalization.
 */
function append(lineNumber: number, line: string): SessionSourceEvent {
  return { type: 'append', source, version, binding, lineNumber, line };
}

describe('session controller contract', () => {
  it('registers listeners before metadata and repeats dirty single-flight refreshes', async () => {
    const test = harness();
    test.controller.start();
    test.controller.refresh();
    test.tick();
    expect(test.order).toEqual(['listen', 'list']);
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.lists).toHaveLength(1);
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.controller.getState().revision).toBe(2);
  });

  it('buffers live history overlap and preserves a raced suffix after an older snapshot', async () => {
    const test = await opened();
    test.emit(append(2, 'two'));
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one', 'two']);
    test.emit(append(2, 'two'));
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one', 'two']);
  });

  it('fills a forward gap through one coalesced history request', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(3, 'three'));
    test.emit(append(4, 'four'));
    await flush();
    expect(test.reads).toHaveLength(1);
    test.reads.shift()?.resolve(snapshot(['one', 'two', 'three', 'four']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toHaveLength(4);
  });

  it('upgrades tail to full without allowing delayed tail to downgrade coverage', async () => {
    const test = await opened();
    const tail = test.reads.shift();
    test.controller.subscribe({ source, mode: 'full', requestId: 'full', generation: 'view-1' });
    await flush();
    expect(test.reads.at(-1)?.mode).toBe('full');
    test.reads.pop()?.resolve(snapshot(['one', 'two']));
    await flush();
    tail?.resolve(snapshot(['two'], { firstLineNumber: 2, totalLineCount: 2 }));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one', 'two']);
  });

  it.each([
    'replaced',
    'removed',
    'binding-changed',
    'server-restarted'
  ] as const)('fences old responses after %s and establishes new versions from full snapshots', async (reason) => {
    const test = await opened();
    const old = test.reads.shift();
    test.emit({ type: 'invalidated', source, version, binding, reason });
    test.emit({ ...append(2, 'old suffix') });
    old?.resolve(snapshot(['old']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).not.toContain('old');
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.available).toBe(false);
  });

  it('rejects immediate append under a new session binding before membership refresh', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit({
      ...append(2, 'secret'),
      binding: { ...binding, sessionId: 'other' },
      version: { ...version, sourceEpoch: 'new' }
    });
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.available).toBe(false);
  });

  it('retains removed member data as unavailable and rejects stale readdition completions', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.controller.refresh();
    test.lists.shift()?.([]);
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one'],
      available: false
    });
    test.emit(append(2, 'stale'));
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
  });

  it('refetches subscribed sources on reconnect in requested history modes and preserves content during resync', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit({ type: 'connection', connected: false });
    test.emit({ type: 'connection', connected: true });
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.reads[0]?.mode).toBe('tail');
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
  });

  it.each([
    'started',
    'resumed',
    'ended'
  ] as const)('refreshes membership on known or unknown %s lifecycle events', async (type) => {
    const test = await opened();
    test.emit({ type, source: { ...source, relPath: 'new' }, version, binding, totalLineCount: 0 });
    await flush();
    expect(test.lists).toHaveLength(1);
  });

  it.each([
    { ...source, cardId: 'other' },
    { ...source, streamType: 'codex' },
    { ...source, relPath: '../escape' }
  ])('rejects foreign or invalid source scope %j', async (foreign) => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit({ ...append(2, 'foreign'), source: foreign });
    test.controller.subscribe({ source: foreign, mode: 'full', requestId: 'foreign', generation: 'view-1' });
    await flush();
    expect(test.reads).toHaveLength(0);
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5
  ])('rejects invalid absolute coordinate %s', async (lineNumber) => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(lineNumber, 'invalid'));
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
  });

  it('bounds pending live events to 1000 and diagnoses overflow without exposing native contents', async () => {
    const test = await opened();
    for (let index = 1; index <= 1001; index++) test.emit(append(index, 'native secret'));
    expect(test.diagnostics.some((event) => event.code === 'resync-overflow')).toBe(true);
    expect(JSON.stringify(test.diagnostics)).not.toContain('native secret');
  });

  it('bounds pending native bytes to 1 MiB independently of event count', async () => {
    const test = await opened();
    test.emit(append(1, 'x'.repeat(1_048_577)));
    expect(test.diagnostics.some((event) => event.code === 'resync-overflow')).toBe(true);
  });

  it('limits historical reads to four while discovering empty late members', async () => {
    const test = harness();
    test.controller.start();
    test.lists.shift()?.(
      Array.from({ length: 6 }, (_, index) => ({
        ...meta,
        relPath: `${index}`,
        role: index === 0 ? 'main' : 'subagent',
        lineCount: 0
      }))
    );
    await flush();
    for (let index = 0; index < 6; index++)
      test.controller.subscribe({
        source: { ...source, relPath: `${index}` },
        mode: 'full',
        requestId: `${index}`,
        generation: 'view-1'
      });
    await flush();
    expect(test.reads).toHaveLength(4);
    expect(test.controller.getState().descriptor.members).toHaveLength(6);
  });

  it('suppresses stale-generation subscriptions and disposes pending reads/listeners/timers', async () => {
    const test = await opened();
    const read = test.reads.shift();
    test.controller.subscribe({ source, mode: 'full', requestId: 'stale', generation: 'view-0' });
    expect(test.reads).toHaveLength(0);
    test.controller.dispose();
    expect(test.listeners()).toBe(0);
    expect(read?.signal.aborted).toBe(true);
    read?.resolve(snapshot(['obsolete']));
    await flush();
    expect(test.controller.getState().sources.size).toBe(0);
  });

  it('defensively copies publications and state including native metadata and line arrays', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    const state = test.controller.getState();
    const file = state.sources.get(streamSourceKey(source));
    file?.lines.push('mutation');
    if (file?.meta) file.meta.title = 'mutation';
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.meta?.title).not.toBe('mutation');
  });
  it('keeps same-version conflicting bytes explicit after authoritative revalidation', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(1, 'different'));
    await flush();
    expect(test.reads).toHaveLength(1);
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one'],
      status: 'paused',
      available: false,
      error: 'inconsistent-source'
    });
  });

  it.each([
    [['new']],
    [['new', 'same-length']]
  ])('atomically replaces old content with authoritative new-version full history %j', async (lines) => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['old', 'old suffix']));
    await flush();
    test.emit({ type: 'invalidated', source, version, binding, reason: 'replaced' });
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.reads.at(-1)?.mode).toBe('full');
    test.reads.pop()?.resolve(snapshot(lines, { version: { ...version, sourceEpoch: 'replacement' } }));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines,
      available: true,
      status: 'ready'
    });
    test.emit(append(3, 'delayed old'));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({ lines, available: true });
  });

  it('does not establish an unknown event version before authoritative current metadata and full snapshot', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit({ ...append(2, 'unknown secret'), version: { serverEpoch: 'other-server', sourceEpoch: 'unknown' } });
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.reads.at(-1)?.mode).toBe('full');
    test.reads.pop()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one'],
      available: true,
      status: 'ready'
    });
  });

  it('pauses repeated overflow without unbounded historical retries and preserves acknowledged content', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(3, 'gap'));
    for (let round = 0; round < 2; round++)
      for (let index = 0; index < 1001; index++) test.emit(append(4 + index, 'pending'));
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one'],
      status: 'paused',
      error: 'resync-overflow'
    });
    expect(test.reads.length).toBeLessThanOrEqual(3);
    test.controller.refresh();
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.reads.at(-1)?.signal.aborted).toBe(false);
  });

  it('rejects an old full response after removal and same-path readdition', async () => {
    const test = await opened();
    const old = test.reads.shift();
    test.controller.refresh();
    test.lists.shift()?.([]);
    await flush();
    test.controller.refresh();
    test.lists.shift()?.([meta]);
    await flush();
    test.reads.pop()?.resolve(snapshot(['new'], { version: { ...version, sourceEpoch: 'readded' } }));
    await flush();
    old?.resolve(snapshot(['old']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['new'],
      available: true
    });
  });

  it('pauses a gap that authoritative snapshots repeatedly cannot fill', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(4, 'four'));
    for (let index = 0; index < 4; index++) {
      test.reads.shift()?.resolve(snapshot(['one']));
      await flush();
    }
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.status).toBe('paused');
    expect(test.reads).toHaveLength(0);
  });

  it('rejects snapshot source or binding mismatches without ever publishing foreign lines', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['foreign'], { binding: { ...binding, sessionId: 'other' } }));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: [],
      available: false
    });
  });

  it('refreshes inactive membership on timer and reconnect fences an old listing completion', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.tick();
    const oldList = test.lists.shift();
    test.emit({ type: 'connection', connected: false });
    test.emit({ type: 'connection', connected: true });
    oldList?.([]);
    await flush();
    expect(test.controller.getState().descriptor.members).toHaveLength(1);
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.controller.getState().descriptor.members).toHaveLength(1);
  });

  it('rejects extra fields and malformed native event authority/request shapes', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(Object.assign(append(2, 'extra'), { extra: true }));
    test.controller.subscribe({
      source,
      mode: 'full',
      requestId: 'extra',
      generation: 'view-1',
      extra: true
    } as Parameters<SessionController['subscribe']>[0]);
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
    expect(test.reads).toHaveLength(0);
  });
  it('starts correlation at null and publishes latest identical-mode subscription ID without another read', async () => {
    const test = harness();
    test.controller.start();
    test.lists.shift()?.([meta]);
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.requestId).toBeNull();
    test.controller.subscribe({ source, mode: 'tail', requestId: 'first', generation: 'view-1' });
    test.controller.subscribe({ source, mode: 'tail', requestId: 'latest', generation: 'view-1' });
    expect(test.reads).toHaveLength(1);
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.requestId).toBe('latest');
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      requestId: 'latest',
      status: 'ready'
    });
  });

  it('correlates full upgrade to new request and rejects obsolete tail completion', async () => {
    const test = await opened();
    const tail = test.reads.shift();
    test.controller.subscribe({ source, mode: 'full', requestId: 'full-id', generation: 'view-1' });
    tail?.resolve(snapshot(['obsolete']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      requestId: 'full-id',
      status: 'loading',
      lines: []
    });
    test.reads.pop()?.resolve(snapshot(['one', 'two']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      requestId: 'full-id',
      status: 'ready',
      lines: ['one', 'two']
    });
  });

  it('retains subscription request correlation across gap refetch and clears it on unsubscribe', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(3, 'three'));
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.requestId).toBe('r1');
    const read = test.reads.shift();
    test.controller.unsubscribe(source, 'view-1');
    read?.resolve(snapshot(['one', 'two', 'three']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      requestId: null,
      subscribed: false,
      lines: ['one']
    });
  });

  it('pauses load rejection and retries explicitly while retaining request identity', async () => {
    const test = await opened();
    test.reads.shift()?.reject(new Error('native content must not be logged'));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      status: 'paused',
      error: 'load-error',
      requestId: 'r1'
    });
    test.emit({ type: 'refresh', cardId: 'card', reason: 'retry' });
    test.lists.shift()?.([meta]);
    await flush();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      status: 'ready',
      requestId: 'r1'
    });
    expect(JSON.stringify(test.diagnostics)).not.toContain('native content');
  });
  it('pauses a classified read failure with its identifier-only code', async () => {
    const test = await opened();
    test.reads.shift()?.reject(new SessionSourceError('not-found'));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      status: 'paused',
      error: 'not-found'
    });
  });
  it.each([
    { firstLineNumber: 0 },
    { totalLineCount: Number.NaN },
    { firstLineNumber: 2 },
    { source: { ...source, cardId: 'other' } },
    { version: { serverEpoch: '', sourceEpoch: 'x' } },
    { meta: { ...meta, lineCount: 12 } },
    { lines: ['partial\nline'] },
    { lines: Array<string>(1) }
  ])('rejects malformed coherent snapshot coordinates/authority %j', async (overrides) => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one'], overrides));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: [],
      available: false,
      status: 'paused'
    });
  });

  it('loads history and live replay into equivalent native source state', async () => {
    const history = await opened();
    history.reads.shift()?.resolve(snapshot(['one', 'two', 'three']));
    await flush();
    const live = await opened();
    live.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    live.emit(append(2, 'two'));
    live.emit(append(3, 'three'));
    expect(live.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(
      history.controller.getState().sources.get(streamSourceKey(source))?.lines
    );
    expect(live.controller.getState().descriptor).toEqual(history.controller.getState().descriptor);
  });

  it('revalidates role and agent changes before forwarding any new native data', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    const nextBinding = { sessionId: 'session', role: 'subagent' as const, agentId: 'child' };
    const nextVersion = { ...version, sourceEpoch: 'rebound' };
    const nextMeta = { ...meta, ...nextBinding };
    test.emit({ ...append(2, 'new role'), binding: nextBinding, version: nextVersion });
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.available).toBe(false);
    test.lists.shift()?.([nextMeta]);
    await flush();
    test.reads.pop()?.resolve(
      snapshot(['one', 'new role'], {
        binding: nextBinding,
        version: nextVersion,
        meta: { ...nextMeta, lineCount: 2 }
      })
    );
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one', 'new role'],
      available: true
    });
    test.emit(append(3, 'old role'));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one', 'new role'],
      available: true
    });
  });

  it('retains same-version full prefix and live suffix across a shorter delayed tail snapshot', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one', 'two', 'three']));
    await flush();
    test.emit({ type: 'connection', connected: false });
    test.emit({ type: 'connection', connected: true });
    test.lists.shift()?.([meta]);
    await flush();
    test.emit(append(4, 'four'));
    test.reads.pop()?.resolve(snapshot(['two'], { firstLineNumber: 2, totalLineCount: 2 }));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual([
      'one',
      'two',
      'three',
      'four'
    ]);
  });

  it('replays unknown live coordinates buffered during initial membership before history settles', async () => {
    const test = harness();
    test.controller.start();
    test.emit(append(2, 'two'));
    test.lists.shift()?.([meta]);
    await flush();
    test.controller.subscribe({ source, mode: 'tail', requestId: 'initial', generation: 'view-1' });
    test.reads.shift()?.resolve(snapshot(['one', 'two']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one', 'two']);
  });
  it('marks changed tail snapshots unavailable until fresh full history establishes replacement', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['old', 'suffix']));
    await flush();
    test.emit({ type: 'connection', connected: false });
    test.emit({ type: 'connection', connected: true });
    test.lists.shift()?.([meta]);
    await flush();
    test.reads
      .pop()
      ?.resolve(
        snapshot(['new tail'], { version: { ...version, sourceEpoch: 'new' }, firstLineNumber: 2, totalLineCount: 2 })
      );
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      available: false,
      lines: ['old', 'suffix'],
      status: 'resynchronizing'
    });
    expect(test.reads.at(-1)?.mode).toBe('full');
    test.reads.pop()?.resolve(snapshot(['new prefix', 'new tail'], { version: { ...version, sourceEpoch: 'new' } }));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      available: true,
      lines: ['new prefix', 'new tail']
    });
  });

  it('preserves acknowledged suffix when unknown-version suspicion revalidates the same version with an older full snapshot', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit(append(2, 'two'));
    test.emit({ ...append(3, 'untrusted-version'), version: { ...version, sourceEpoch: 'unconfirmed' } });
    test.lists.shift()?.([meta]);
    await flush();
    test.reads.pop()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one', 'two'],
      totalLineCount: 2,
      available: true
    });
  });
  it('heals a reconnect tail beyond retained coverage with one full snapshot instead of dropping acknowledged history', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    test.emit({ type: 'connection', connected: false });
    test.emit({ type: 'connection', connected: true });
    test.lists.shift()?.([meta]);
    await flush();
    test.reads.pop()?.resolve(snapshot(['four'], { firstLineNumber: 4, totalLineCount: 4 }));
    await flush();
    expect(test.reads.at(-1)?.mode).toBe('full');
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one']);
    test.reads.pop()?.resolve(snapshot(['one', 'two', 'three', 'four']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      status: 'ready',
      lines: ['one', 'two', 'three', 'four']
    });
  });
  it('releases closed-view native history and ignores an unabortable late client completion', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['retained native history']));
    await flush();
    test.emit(append(3, 'gap'));
    const unabortable = test.reads.shift();
    test.controller.dispose();
    expect(unabortable?.signal.aborted).toBe(true);
    expect(test.listeners()).toBe(0);
    expect(test.controller.getState().sources.size).toBe(0);
    expect(test.controller.getState().descriptor.members).toEqual([]);
    expect(test.controller.getState().connected).toBe(false);
    unabortable?.resolve(snapshot(['retained native history', 'late', 'completion']));
    await flush();
    expect(test.controller.getState().sources.size).toBe(0);
    test.emit(append(4, 'after dispose'));
    test.tick();
    expect(test.lists).toHaveLength(0);
  });
  it('refreshes source presentation metadata on lifecycle events while preserving acknowledged native coordinates', async () => {
    const test = await opened();
    test.reads.shift()?.resolve(snapshot(['one', 'two']));
    await flush();
    test.emit({ type: 'ended', source, version, binding, totalLineCount: 2 });
    test.lists.shift()?.([{ ...meta, title: 'Updated title', isActive: false }]);
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.meta).toMatchObject({
      title: 'Updated title',
      isActive: false,
      lineCount: 2
    });
    expect(test.controller.getState().sources.get(streamSourceKey(source))).toMatchObject({
      lines: ['one', 'two'],
      available: true
    });
  });
});

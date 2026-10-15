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
  reads: Array<{ mode: string; signal: AbortSignal; resolve(value: StreamSourceSnapshot): void }>;
  order: string[];
  diagnostics: SessionDiagnostic[];
  emit(event: SessionControllerEvent): void;
  tick(): void;
  listeners(): number;
} {
  const lists: Array<(value: StreamMeta[]) => void> = [];
  const reads: Array<{ mode: string; signal: AbortSignal; resolve(value: StreamSourceSnapshot): void }> = [];
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
        return new Promise((resolve) => reads.push({ mode, signal, resolve }));
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
  return { source, version, binding, meta, lines, firstLineNumber: 1, totalLineCount: lines.length, ...overrides };
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
  it.skip('registers listeners before metadata and repeats dirty single-flight refreshes', async () => {
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

  it.skip('buffers live history overlap and preserves a raced suffix after an older snapshot', async () => {
    const test = await opened();
    test.emit(append(2, 'two'));
    test.reads.shift()?.resolve(snapshot(['one']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one', 'two']);
    test.emit(append(2, 'two'));
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).toEqual(['one', 'two']);
  });

  it.skip('fills a forward gap through one coalesced history request', async () => {
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

  it.skip('upgrades tail to full without allowing delayed tail to downgrade coverage', async () => {
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

  it.skip.each([
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

  it.skip('rejects immediate append under a new session binding before membership refresh', async () => {
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

  it.skip('retains removed member data as unavailable and rejects stale readdition completions', async () => {
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

  it.skip('refetches subscribed sources on reconnect in requested history modes and preserves content during resync', async () => {
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

  it.skip.each([
    'started',
    'resumed',
    'ended'
  ] as const)('refreshes membership on known or unknown %s lifecycle events', async (type) => {
    const test = await opened();
    test.emit({ type, source: { ...source, relPath: 'new' }, version, binding, totalLineCount: 0 });
    await flush();
    expect(test.lists).toHaveLength(1);
  });

  it.skip.each([
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

  it.skip.each([
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

  it.skip('bounds pending live events to 1000 and diagnoses overflow without exposing native contents', async () => {
    const test = await opened();
    for (let index = 1; index <= 1001; index++) test.emit(append(index, 'native secret'));
    expect(test.diagnostics.some((event) => event.code === 'resync-overflow')).toBe(true);
    expect(JSON.stringify(test.diagnostics)).not.toContain('native secret');
  });

  it.skip('bounds pending native bytes to 1 MiB independently of event count', async () => {
    const test = await opened();
    test.emit(append(1, 'x'.repeat(1_048_577)));
    expect(test.diagnostics.some((event) => event.code === 'resync-overflow')).toBe(true);
  });

  it.skip('limits historical reads to four while discovering empty late members', async () => {
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

  it.skip('suppresses stale-generation subscriptions and disposes pending reads/listeners/timers', async () => {
    const test = await opened();
    const read = test.reads.shift();
    test.controller.subscribe({ source, mode: 'full', requestId: 'stale', generation: 'view-0' });
    expect(test.reads).toHaveLength(0);
    test.controller.dispose();
    expect(test.listeners()).toBe(0);
    expect(read?.signal.aborted).toBe(true);
    read?.resolve(snapshot(['obsolete']));
    await flush();
    expect(test.controller.getState().sources.get(streamSourceKey(source))?.lines).not.toContain('obsolete');
  });

  it.skip('defensively copies publications and state including native metadata and line arrays', async () => {
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
});

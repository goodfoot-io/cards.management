/**
 * Live-buffer overflow recovery against a real, growing native transcript file.
 *
 * The client reads the actual file at request time (the server's snapshot
 * point) and completes when the test releases it, modelling a large source
 * whose transfer is slower than the appends being written behind it.
 * @summary Session controller overflow recovery convergence
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamMeta, StreamSourceSnapshot } from '../../src/protocol/types/stream.js';
import {
  createSessionController,
  SESSION_READ_RETRY_DELAYS_MS,
  type SessionControllerEvent,
  type SessionControllerState,
  type SessionSourceState,
  streamSourceKey
} from '../../src/stream-session/index.js';

const source = { cardId: 'card', streamType: 'claude', relPath: 'main.jsonl' };
const session = { cardId: 'card', streamType: 'claude', sessionId: 'session' };
const version = { serverEpoch: 'server-1', sourceEpoch: 'source-1' };
const binding = { sessionId: 'session', role: 'main' as const };
const TAIL = 50;

/**
 * Flushes chained asynchronous controller continuations.
 * @returns Completion after queued promise work.
 */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

/** One read whose snapshot was taken from disk and whose delivery the test controls. */
interface HeldRead {
  mode: string;
  snapshot: StreamSourceSnapshot;
  aborted(): boolean;
  release(): void;
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * Builds a controller over a real JSONL file that the test appends to.
 * @param initialLines - Lines written before the controller starts.
 * @returns Controller and controls over the file, held reads, live events, and backoffs.
 */
function transcript(initialLines: number) {
  const directory = mkdtempSync(path.join(tmpdir(), 'session-overflow-'));
  directories.push(directory);
  const file = path.join(directory, 'main.jsonl');
  const record = (index: number, size = 0): string =>
    JSON.stringify({ type: 'assistant', index, text: `line ${index}`.padEnd(size, '.') });
  writeFileSync(file, Array.from({ length: initialLines }, (_, index) => `${record(index + 1)}\n`).join(''));
  let written = initialLines;
  const fileLines = (): string[] => readFileSync(file, 'utf8').split('\n').slice(0, -1);
  const metaFor = (lineCount: number): StreamMeta => ({
    version: 1,
    streamType: 'claude',
    relPath: 'main.jsonl',
    runtime: 'claude',
    sessionId: 'session',
    role: 'main',
    sourcePath: file,
    startedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    lineCount,
    isActive: true
  });
  const reads: HeldRead[] = [];
  const backoffs: Array<{ milliseconds: number; run(): void; live: boolean }> = [];
  const scheduled: number[] = [];
  let listener: ((event: SessionControllerEvent) => void) | undefined;
  let latest: SessionControllerState | undefined;
  const controller = createSessionController({
    session,
    generation: 'view-1',
    client: {
      listStreams: async () => [metaFor(fileLines().length)],
      getStream(_source, mode, signal) {
        const all = fileLines();
        const first = mode === 'tail' ? Math.max(1, all.length - TAIL + 1) : 1;
        const snapshot: StreamSourceSnapshot = {
          source,
          version,
          binding,
          meta: metaFor(all.length),
          lines: all.slice(first - 1),
          firstLineNumber: first,
          totalLineCount: all.length
        };
        return new Promise((resolve) =>
          reads.push({ mode, snapshot, aborted: () => signal.aborted, release: () => resolve(snapshot) })
        );
      }
    },
    events: {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      }
    },
    scheduler: {
      every: () => () => {},
      after(milliseconds, run) {
        const backoff = { milliseconds, run, live: true };
        backoffs.push(backoff);
        scheduled.push(milliseconds);
        return () => {
          backoff.live = false;
        };
      }
    },
    publish(state) {
      latest = state;
    }
  });
  return {
    controller,
    reads,
    backoffs,
    scheduled,
    fileLines,
    /**
     * Appends real lines and publishes each as the server would.
     * @param count - Lines to append.
     * @param size - Minimum text length of each record.
     */
    write(count: number, size = 0): void {
      for (let index = 0; index < count; index++) {
        const lineNumber = ++written;
        const line = record(lineNumber, size);
        appendFileSync(file, `${line}\n`);
        listener?.({ type: 'append', source, version, binding, lineNumber, line });
      }
    },
    emit(event: SessionControllerEvent): void {
      listener?.(event);
    },
    /** Runs every live backoff that is due. */
    fire(): void {
      for (const backoff of backoffs.splice(0))
        if (backoff.live) {
          backoff.live = false;
          backoff.run();
        }
    },
    /**
     * Releases the oldest held read.
     * @returns The released read.
     */
    async deliver(): Promise<HeldRead> {
      const read = reads.shift();
      if (!read) throw new Error('No read in flight');
      read.release();
      await flush();
      return read;
    },
    state(): SessionSourceState {
      const current = controller.getState().sources.get(streamSourceKey(source));
      if (!current) throw new Error('Source not tracked');
      return current;
    },
    published(): SessionControllerState | undefined {
      return latest;
    }
  };
}

/**
 * Starts the controller and subscribes the main source with full coverage.
 * @param initialLines - Lines on disk before start.
 * @returns Harness with the first full read in flight.
 */
async function subscribed(initialLines: number): Promise<ReturnType<typeof transcript>> {
  const test = transcript(initialLines);
  test.controller.start();
  await flush();
  test.controller.subscribe({ source, mode: 'full', requestId: 'r1', generation: 'view-1' });
  await flush();
  return test;
}

describe('session controller live-buffer overflow recovery', () => {
  it('converges on the file after appends overflow the buffer during two consecutive reads', async () => {
    const test = await subscribed(3000);
    // Appends outrun the first large read: more than 1,000 live events wait behind it.
    test.write(1200);
    const first = await test.deliver();
    expect(first.mode).toBe('full');
    expect(first.aborted()).toBe(false);
    // The read's content is accepted but marked stale: it ends before the discarded live lines.
    expect(test.state()).toMatchObject({ status: 'resynchronizing', error: null, available: true });
    expect(test.state().lines).toEqual(first.snapshot.lines);
    expect(test.reads).toHaveLength(0);
    expect(test.backoffs.map((backoff) => backoff.milliseconds)).toEqual([SESSION_READ_RETRY_DELAYS_MS[0]]);
    test.fire();
    await flush();
    // The recovery read is outrun again: a second overflow in a row.
    test.write(1200);
    const second = await test.deliver();
    expect(second.mode).toBe('tail');
    // The tail window cannot bridge the discarded span, so the same recovery reads in full.
    expect(test.reads.map((read) => read.mode)).toEqual(['full']);
    expect(test.state()).toMatchObject({ status: 'resynchronizing', error: null });
    // Appends calm down; the remaining live events fit the buffer.
    test.write(100);
    await test.deliver();
    expect(test.state()).toMatchObject({ status: 'ready', error: null, available: true, firstLineNumber: 1 });
    expect(test.state().authority?.version).toEqual(version);
    expect(test.state().lines).toEqual(test.fileLines());
    expect(test.backoffs.filter((backoff) => backoff.live)).toHaveLength(0);
    // Converged sources apply later appends live again.
    test.write(3);
    expect(test.state().lines).toEqual(test.fileLines());
    expect(test.published()?.sources.get(streamSourceKey(source))?.lines).toEqual(test.fileLines());
  });

  it('catches up through a tail window when the discarded span is short', async () => {
    const test = await subscribed(200);
    // Three large records overflow the 1 MiB byte bound while only three lines are discarded.
    test.write(3, 400_000);
    await test.deliver();
    expect(test.state()).toMatchObject({ status: 'resynchronizing', error: null });
    test.fire();
    await flush();
    expect(test.reads.map((read) => read.mode)).toEqual(['tail']);
    await test.deliver();
    expect(test.reads).toHaveLength(0);
    expect(test.state()).toMatchObject({ status: 'ready', error: null, firstLineNumber: 1 });
    expect(test.state().lines).toEqual(test.fileLines());
  });

  it('retains shown content while resynchronizing and pauses retryably only after the bounded budget', async () => {
    const test = await subscribed(100);
    const shown = test.reads[0]?.snapshot.lines ?? [];
    // Every read is outrun by more than the buffer bound, indefinitely.
    for (let round = 0; round < 30 && test.state().status !== 'paused'; round++) {
      if (test.reads.length === 0) test.fire();
      await flush();
      if (test.reads.length === 0) continue;
      test.write(1100);
      await test.deliver();
      expect(test.state().lines.slice(0, shown.length)).toEqual(shown);
      expect(test.state().available).toBe(true);
    }
    expect(test.state()).toMatchObject({ status: 'paused', error: 'resync-overflow', available: true });
    expect(test.backoffs).toHaveLength(0);
    expect(test.scheduled).toEqual([...SESSION_READ_RETRY_DELAYS_MS]);
    expect(test.published()?.sources.get(streamSourceKey(source))?.status).toBe('paused');
    // A focus refresh lifts the overflow pause like a retryable read failure, with a fresh budget.
    test.emit({ type: 'refresh', cardId: 'card', reason: 'focus' });
    await flush();
    for (let round = 0; round < 10 && test.state().status !== 'ready'; round++) {
      if (test.reads.length > 0) await test.deliver();
      else test.fire();
      await flush();
    }
    expect(test.state()).toMatchObject({ status: 'ready', error: null });
    expect(test.state().lines).toEqual(test.fileLines());
  });
});

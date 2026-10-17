/**
 * End-to-end host bridge checks: the real session controller, the real Cards
 * client adapter over a deferred in-memory Cards client, and the real renderer
 * store, connected through an asynchronous message channel.
 * @summary Session host bridge protocol projection and scope checks
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/client/types/errors.js';
import type {
  StreamMeta,
  StreamSourceRef,
  StreamSourceSnapshot,
  StreamSourceVersion
} from '../../src/protocol/index.js';
import {
  type CardsStreamClient,
  createCardsSessionClient,
  createStreamHostBridge,
  type StreamBridgeDiagnostic,
  type StreamHostAction,
  type StreamHostBridge
} from '../../src/stream-bridge/index.js';
import { SESSION_READ_RETRY_DELAYS_MS, type SessionControllerEvent } from '../../src/stream-session/index.js';
import {
  createStreamStore,
  type HostToRendererMessage,
  type LayoutRendererMessage,
  MAX_VIEW_STATE_ENTRIES,
  type StreamDisplayMode,
  type StreamInitData,
  type StreamRendererStore,
  type StreamSourceView,
  type StreamViewState,
  TAIL_HISTORY_LINES
} from '../../src/stream-store/index.js';
import { child, childBinding, main, mainBinding, meta, session, v1, v2 } from '../stream-store/fixtures.js';

const generation = 'view-1';

/**
 * Settles chained promise continuations.
 * @returns Completion after queued microtasks.
 */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

/**
 * Builds a coherent server snapshot.
 * @param source - Exact source.
 * @param lines - Native lines ending at the source's last line.
 * @param options - Version, first coordinate, and metadata overrides.
 * @param options.version - Incarnation.
 * @param options.first - First coordinate.
 * @param options.extra - Additional server-only metadata keys.
 * @param options.isActive - Whether the native writer is still live.
 * @returns Snapshot whose coordinates end at the last supplied line.
 */
function serverSnapshot(
  source: StreamSourceRef,
  lines: string[],
  options: { version?: StreamSourceVersion; first?: number; extra?: Record<string, unknown>; isActive?: boolean } = {}
): StreamSourceSnapshot {
  const first = options.first ?? 1;
  const total = first + lines.length - 1;
  const binding = source === child ? childBinding : mainBinding;
  return {
    source,
    version: options.version ?? v1,
    binding,
    meta: { ...meta(source, binding, total), ...(options.extra ?? {}), isActive: options.isActive ?? true },
    lines,
    firstLineNumber: first,
    totalLineCount: total
  };
}

/** Pending deferred Cards read. */
interface PendingRead {
  source: StreamSourceRef;
  tail: number | undefined;
  resolve(value: StreamSourceSnapshot): void;
  reject(reason: unknown): void;
}

/** Bridge, renderer, and deferred server controls. */
interface Rig {
  bridge: StreamHostBridge;
  lists: Array<(records: StreamMeta[]) => void>;
  reads: PendingRead[];
  posted: HostToRendererMessage[];
  diagnostics: StreamBridgeDiagnostic[];
  actions: StreamHostAction[];
  layouts: LayoutRendererMessage[];
  inits: StreamInitData[];
  views: StreamViewState[];
  emit(event: SessionControllerEvent): void;
  /** Runs every pending read-retry backoff. */
  fire(): void;
  /** Runs the periodic membership refresh. */
  tick(): void;
  /** Fails the oldest pending listing like an unreachable server. */
  failList(): void;
  listeners(): number;
  /** Creates the renderer from the bridge's initialization and attaches it. */
  open(mode?: StreamDisplayMode): StreamRendererStore;
  /** Delivers queued messages in both directions until quiescent. */
  pump(): Promise<void>;
  /** Observes every host post as it is made and every renderer message as the host receives it. */
  observe(listener: (from: 'host' | 'renderer', message: unknown) => void): void;
  view(source?: StreamSourceRef): StreamSourceView | undefined;
  store(): StreamRendererStore;
}

/**
 * Starts a bridge over deferred Cards traffic.
 * @param mode - Display mode.
 * @param initialViewState - View state persisted from an earlier load.
 * @returns Rig with the controller started.
 */
function rig(mode: StreamDisplayMode = 'compact', initialViewState?: StreamViewState): Rig {
  const lists: Array<(records: StreamMeta[]) => void> = [];
  const reads: PendingRead[] = [];
  const posted: HostToRendererMessage[] = [];
  const diagnostics: StreamBridgeDiagnostic[] = [];
  const actions: StreamHostAction[] = [];
  const layouts: LayoutRendererMessage[] = [];
  const inits: StreamInitData[] = [];
  const views: StreamViewState[] = [];
  const toRenderer: HostToRendererMessage[] = [];
  const toHost: unknown[] = [];
  let listener: ((event: SessionControllerEvent) => void) | undefined;
  let timer: (() => void) | undefined;
  const backoffs: Array<{ run: () => void; live: boolean }> = [];
  let rendererListener: ((data: unknown) => void) | undefined;
  let renderer: StreamRendererStore | undefined;
  let requests = 0;
  const observers: Array<(from: 'host' | 'renderer', message: unknown) => void> = [];
  const listFailures = new Map<(records: StreamMeta[]) => void, (reason: unknown) => void>();
  const cards: CardsStreamClient = {
    listStreams: () =>
      new Promise((resolve, reject) => {
        lists.push(resolve);
        listFailures.set(resolve, reject);
      }),
    getStream: (cardId, streamType, relPath, tail) =>
      new Promise((resolve, reject) => reads.push({ source: { cardId, streamType, relPath }, tail, resolve, reject }))
  };
  const bridge = createStreamHostBridge({
    session,
    generation,
    mode,
    client: createCardsSessionClient(cards),
    events: {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      }
    },
    scheduler: {
      every(_milliseconds, callback) {
        timer = callback;
        return () => {
          timer = undefined;
        };
      },
      after(_milliseconds, callback) {
        const backoff = { run: callback, live: true };
        backoffs.push(backoff);
        return () => {
          backoff.live = false;
        };
      }
    },
    post(message) {
      posted.push(message);
      toRenderer.push(message);
      for (const observer of observers) observer('host', message);
    },
    ready: (init) => inits.push(init),
    action: (action) => actions.push(action),
    layout: (message) => layouts.push(message),
    diagnostic: (event) => diagnostics.push(event),
    viewState: (state) => views.push(state),
    ...(initialViewState ? { initialViewState } : {})
  });
  bridge.start();
  return {
    bridge,
    lists,
    reads,
    posted,
    diagnostics,
    actions,
    layouts,
    inits,
    views,
    emit: (event) => listener?.(event),
    fire() {
      for (const backoff of backoffs.splice(0))
        if (backoff.live) {
          backoff.live = false;
          backoff.run();
        }
    },
    tick: () => timer?.(),
    failList() {
      const resolve = lists.shift();
      if (resolve) listFailures.get(resolve)?.(new Error('unreachable'));
    },
    listeners: () =>
      Number(listener !== undefined) + Number(timer !== undefined) + backoffs.filter((backoff) => backoff.live).length,
    open(storeMode = mode) {
      const init = bridge.getInit();
      if (!init) throw new Error('no init');
      renderer = createStreamStore({
        init: { ...init, mode: storeMode },
        post: (message) => toHost.push(message),
        listen(next) {
          rendererListener = next;
          return () => {
            rendererListener = undefined;
          };
        },
        createRequestId: () => `req-${++requests}`,
        forwardDiagnostics: true
      });
      bridge.attach();
      return renderer;
    },
    async pump() {
      for (let round = 0; round < 50; round++) {
        await flush();
        if (toRenderer.length === 0 && toHost.length === 0) return;
        while (toHost.length > 0) {
          const message = toHost.shift();
          for (const observer of observers) observer('renderer', message);
          bridge.receive(message);
        }
        while (toRenderer.length > 0) rendererListener?.(toRenderer.shift());
      }
    },
    observe: (listener) => observers.push(listener),
    view(source = main) {
      return renderer?.getState().sources.get(JSON.stringify([source.cardId, source.streamType, source.relPath]));
    },
    store() {
      if (!renderer) throw new Error('no renderer');
      return renderer;
    }
  };
}

/**
 * Starts a rig whose renderer holds an answered main subscription.
 * @param lines - Initial main lines.
 * @param mode - Display mode.
 * @returns Opened rig.
 */
async function opened(lines = ['l1', 'l2', 'l3'], mode: StreamDisplayMode = 'compact'): Promise<Rig> {
  const r = rig(mode);
  r.lists.shift()?.([meta(main, mainBinding, lines.length)]);
  await flush();
  r.open();
  await r.pump();
  r.reads.shift()?.resolve(serverSnapshot(main, lines));
  await r.pump();
  return r;
}

describe('initialization and correlated snapshots', () => {
  it('offers initialization only after the first accepted membership and answers the auto-subscription', async () => {
    const r = rig();
    expect(r.bridge.getInit()).toBeNull();
    expect(r.posted).toEqual([]);
    r.lists.shift()?.([meta(main, mainBinding, 2)]);
    await flush();
    expect(r.inits).toHaveLength(1);
    expect(r.inits[0]).toMatchObject({ session, generation, revision: 1, mode: 'compact' });
    expect(r.bridge.getInit()?.descriptor.main).toEqual(main);
    r.open();
    await r.pump();
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]).toMatchObject({ source: main, tail: TAIL_HISTORY_LINES });
    r.reads.shift()?.resolve(serverSnapshot(main, ['a', 'b']));
    await r.pump();
    expect(r.posted.map((message) => message.type)).toEqual(['source:snapshot']);
    expect(r.posted[0]).toMatchObject({ requestId: 'req-1', generation, version: v1, firstLineNumber: 1 });
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['a', 'b'], authority: { version: v1 } });
  });

  it('reads full history without a tail in expanded mode', async () => {
    const r = rig('expanded');
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    expect(r.reads[0]).toMatchObject({ source: main, tail: undefined });
  });

  it('projects server metadata onto the exact renderer shape', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    r.reads.shift()?.resolve(serverSnapshot(main, ['a'], { extra: { serverOnly: 'x' } }));
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['a'] });
    expect(r.view()?.meta).not.toHaveProperty('serverOnly');
  });

  it('initializes from the latest membership and posts later membership as updates', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.emit({ type: 'refresh', cardId: session.cardId, reason: 'commit' });
    r.lists.shift()?.([meta(main, mainBinding, 1), meta(child, childBinding, 1)]);
    await flush();
    expect(r.posted).toEqual([]);
    r.open();
    expect(
      r
        .store()
        .getState()
        .descriptor.members.map((member) => member.source)
    ).toEqual([main, child]);
    await r.pump();
    r.posted.length = 0;
    r.emit({ type: 'refresh', cardId: session.cardId, reason: 'commit' });
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await r.pump();
    expect(r.posted.filter((message) => message.type === 'session:update')).toHaveLength(1);
    expect(
      r
        .store()
        .getState()
        .descriptor.members.map((member) => member.source)
    ).toEqual([main]);
  });
});

describe('live projection', () => {
  it('forwards same-version growth as appends', async () => {
    const r = await opened();
    r.posted.length = 0;
    r.emit({ type: 'append', source: main, version: v1, binding: mainBinding, lineNumber: 4, line: 'l4' });
    await r.pump();
    expect(r.posted).toEqual([
      {
        type: 'source:append',
        generation,
        source: main,
        version: v1,
        binding: mainBinding,
        firstLineNumber: 4,
        lines: ['l4']
      }
    ]);
    expect(r.view()?.lines).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('chunks a large repaired range into bounded appends', async () => {
    const r = await opened();
    r.posted.length = 0;
    r.emit({ type: 'append', source: main, version: v1, binding: mainBinding, lineNumber: 2501, line: 'x2501' });
    await r.pump();
    const full = Array.from({ length: 2501 }, (_, index) => (index < 3 ? `l${index + 1}` : `x${index + 1}`));
    expect(r.reads[0]).toMatchObject({ tail: undefined });
    r.reads.shift()?.resolve(serverSnapshot(main, full));
    await r.pump();
    const appends = r.posted.filter((message) => message.type === 'source:append');
    expect(appends.map((message) => [message.firstLineNumber, message.lines.length])).toEqual([
      [4, 1000],
      [1004, 1000],
      [2004, 498]
    ]);
    expect(r.view()).toMatchObject({ status: 'ready', totalLineCount: 2501 });
    expect(r.view()?.lines.at(-1)).toBe('x2501');
    expect(r.view()?.lines).toHaveLength(TAIL_HISTORY_LINES);
  });

  it('derives lifecycle from refreshed activity', async () => {
    const r = await opened();
    r.posted.length = 0;
    r.emit({ type: 'ended', source: main, version: v1, binding: mainBinding, totalLineCount: 3 });
    r.lists.shift()?.([{ ...meta(main, mainBinding, 3), isActive: false }]);
    await r.pump();
    expect(r.posted.filter((message) => message.type === 'source:lifecycle')).toEqual([
      {
        type: 'source:lifecycle',
        generation,
        source: main,
        version: v1,
        binding: mainBinding,
        state: 'ended',
        totalLineCount: 3
      }
    ]);
    expect(r.view()?.meta?.isActive).toBe(false);
  });

  it('invalidates the held incarnation before any successor content', async () => {
    const r = await opened();
    r.posted.length = 0;
    r.emit({ type: 'invalidated', source: main, version: v1, binding: mainBinding, reason: 'replaced' });
    await r.pump();
    expect(r.posted.map((message) => message.type)).toEqual(['source:invalidated']);
    expect(r.posted[0]).toMatchObject({ version: v1, reason: 'replaced' });
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await r.pump();
    expect(r.reads.at(-1)).toMatchObject({ tail: undefined });
    r.reads.shift()?.resolve(serverSnapshot(main, ['n1'], { version: v2 }));
    await r.pump();
    const types = r.posted.map((message) => message.type);
    expect(types.indexOf('source:invalidated')).toBeLessThan(types.indexOf('source:snapshot'));
    expect(r.posted.find((message) => message.type === 'source:snapshot')).toMatchObject({
      version: v2,
      requestId: 'req-2'
    });
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['n1'], authority: { version: v2 } });
  });

  it('reports a version established without an invalidation event as a replacement', async () => {
    const r = await opened();
    r.posted.length = 0;
    r.emit({ type: 'append', source: main, version: v2, binding: mainBinding, lineNumber: 1, line: 'n1' });
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await r.pump();
    r.reads.shift()?.resolve(serverSnapshot(main, ['n1'], { version: v2 }));
    await r.pump();
    // The held v1 content may first be marked stale; content for v2 still follows its retirement.
    expect(r.posted.filter((message) => message.type === 'source:status')).toEqual([
      expect.objectContaining({ version: v1, state: 'resynchronizing' })
    ]);
    const sourceMessages = r.posted.filter(
      (message) => message.type !== 'session:update' && message.type !== 'source:status'
    );
    expect(sourceMessages[0]).toMatchObject({ type: 'source:invalidated', version: v1, reason: 'replaced' });
    expect(sourceMessages.at(-1)).toMatchObject({ type: 'source:snapshot', version: v2 });
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['n1'] });
  });
});

describe('failures, retry, and connection', () => {
  it('maps classified read failures and recovers through session:resync', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    r.reads.shift()?.reject(new ApiError('missing', 'NOT_FOUND'));
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'paused', error: 'not-found' });
    const before = r.lists.length;
    r.store().retry();
    await r.pump();
    expect(r.lists.length).toBe(before + 1);
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await r.pump();
    r.reads.at(-1)?.resolve(serverSnapshot(main, ['a']));
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['a'], error: null });
  });

  it('reports host-side resynchronization of answered content as source:status and clears it on catch-up', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 2)]);
    await flush();
    r.open();
    await r.pump();
    r.reads.shift()?.resolve(serverSnapshot(main, ['l1', 'l2']));
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['l1', 'l2'] });
    const statuses = () => r.posted.filter((message) => message.type === 'source:status');
    expect(statuses()).toHaveLength(0);
    // A live append beyond the next coordinate makes the controller re-read authoritatively.
    r.emit({ type: 'append', source: main, version: v1, binding: mainBinding, lineNumber: 4, line: 'l4' });
    await r.pump();
    expect(statuses()).toEqual([
      { type: 'source:status', generation, source: main, version: v1, binding: mainBinding, state: 'resynchronizing' }
    ]);
    // Retained content stays visible while it is marked stale.
    expect(r.view()).toMatchObject({ status: 'resynchronizing', lines: ['l1', 'l2'] });
    for (let round = 0; round < 3 && r.reads.length > 0; round++) {
      r.reads.shift()?.resolve(serverSnapshot(main, ['l1', 'l2', 'l3', 'l4']));
      await r.pump();
    }
    expect(statuses().map((message) => message.state)).toEqual(['resynchronizing', 'ready']);
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['l1', 'l2', 'l3', 'l4'] });
  });

  it('surfaces exhausted overflow recovery as a retryable resync-overflow pause', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    const lines = ['l1'];
    /** Answers the oldest read from the server's current content in its requested window. */
    const answer = (): void => {
      const read = r.reads.shift();
      const first = read?.tail === undefined ? 1 : Math.max(1, lines.length - read.tail + 1);
      read?.resolve(serverSnapshot(main, lines.slice(first - 1), { first }));
    };
    // Every read is outrun by more live appends than the controller may buffer.
    for (let round = 0; round < 20 && r.view()?.status !== 'paused'; round++) {
      if (r.reads.length === 0) r.fire();
      await r.pump();
      if (r.reads.length === 0) continue;
      const pending = r.reads[0];
      const snapshotLines = [...lines];
      for (let index = 0; index < 1001; index++) {
        lines.push(`l${lines.length + 1}`);
        r.emit({
          type: 'append',
          source: main,
          version: v1,
          binding: mainBinding,
          lineNumber: lines.length,
          line: lines[lines.length - 1] ?? ''
        });
      }
      const first = pending?.tail === undefined ? 1 : Math.max(1, snapshotLines.length - pending.tail + 1);
      r.reads.shift()?.resolve(serverSnapshot(main, snapshotLines.slice(first - 1), { first }));
      await r.pump();
    }
    expect(r.view()).toMatchObject({ status: 'paused', error: 'resync-overflow' });
    expect(r.posted.filter((message) => message.type === 'source:error')).toHaveLength(1);
    r.store().retry();
    await r.pump();
    r.lists.shift()?.([meta(main, mainBinding, lines.length)]);
    await r.pump();
    for (let round = 0; round < 5 && r.reads.length > 0; round++) {
      answer();
      await r.pump();
    }
    expect(r.view()).toMatchObject({ status: 'ready', error: null, totalLineCount: lines.length });
    const shown = r.view()?.lines ?? [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(lines.slice(lines.length - shown.length));
  });

  it('retries transient server read failures without surfacing an error to the renderer', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    r.reads.shift()?.reject(new ApiError('changed during read', 'STREAM_SOURCE_INCOHERENT'));
    await r.pump();
    r.fire();
    await r.pump();
    r.reads.shift()?.reject(new ApiError('unavailable', 'STREAM_SOURCE_UNAVAILABLE'));
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'loading', error: null });
    r.fire();
    await r.pump();
    r.reads.shift()?.resolve(serverSnapshot(main, ['a']));
    await r.pump();
    expect(r.posted.map((message) => message.type)).toEqual(['source:snapshot']);
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['a'] });
  });

  it('pauses after the retry budget and an unbound source immediately', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new ApiError('changed during read', 'STREAM_SOURCE_INCOHERENT'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    expect(r.reads).toHaveLength(0);
    expect(r.view()).toMatchObject({ status: 'paused', error: 'inconsistent-source' });
    r.emit({ type: 'started', source: main, version: v1, binding: mainBinding, totalLineCount: 1 });
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await r.pump();
    r.reads.shift()?.reject(new ApiError('unbound', 'STREAM_SOURCE_UNBOUND'));
    await r.pump();
    r.fire();
    await r.pump();
    expect(r.reads).toHaveLength(0);
    expect(r.posted.filter((message) => message.type === 'source:error').map((message) => message.error)).toEqual([
      'inconsistent-source',
      'rejected-scope'
    ]);
  });

  it('maps unclassified failures to load-error without leaking the message', async () => {
    const r = rig();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new Error('native secret'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    expect(r.view()).toMatchObject({ status: 'paused', error: 'load-error' });
    expect(JSON.stringify([r.posted, r.diagnostics])).not.toContain('native secret');
  });

  it('forwards transport state and re-answers the renderer after reconnection', async () => {
    const r = await opened();
    r.posted.length = 0;
    r.emit({ type: 'connection', connected: false });
    await r.pump();
    expect(r.store().getState().connection).toBe('disconnected');
    r.emit({ type: 'connection', connected: true });
    await r.pump();
    expect(r.store().getState().connection).toBe('connected');
    r.lists.shift()?.([meta(main, mainBinding, 4)]);
    await r.pump();
    r.reads.at(-1)?.resolve(serverSnapshot(main, ['l1', 'l2', 'l3', 'l4']));
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['l1', 'l2', 'l3', 'l4'] });
  });
});

describe('renderer scope and correlation', () => {
  it('never trusts renderer-supplied card, provider, or path outside current membership', async () => {
    const r = await opened();
    const reads = r.reads.length;
    r.posted.length = 0;
    const forged = [
      { ...main, cardId: 'card-2' },
      { ...main, streamType: 'codex-session' },
      { ...main, relPath: 'other.jsonl' }
    ];
    for (const source of forged)
      r.bridge.receive({ type: 'source:subscribe', generation, requestId: 'forged', source, history: 'full' });
    await r.pump();
    expect(r.reads.length).toBe(reads);
    expect(r.diagnostics.filter((event) => event.code === 'rejected-scope')).toHaveLength(3);
    expect(r.posted).toEqual([
      {
        type: 'source:error',
        generation,
        requestId: 'forged',
        source: forged[2],
        error: 'rejected-scope'
      }
    ]);
  });

  it('drops malformed and stale-generation messages', async () => {
    const r = await opened();
    r.bridge.receive({ type: 'session:resync', generation: 'view-0' });
    r.bridge.receive({ type: 'session:resync', generation, extra: true });
    r.bridge.receive('not a message');
    expect(r.diagnostics.map((event) => event.code)).toEqual([
      'stale-generation',
      'rejected-message',
      'rejected-message'
    ]);
    expect(r.lists).toHaveLength(0);
  });

  it('routes validated actions and layout messages to the host', async () => {
    const r = await opened();
    r.store().openFile('src/a.ts', 3);
    r.store().close();
    r.bridge.receive({ type: 'layout:ready', generation, token: 't1' });
    await r.pump();
    expect(r.actions).toEqual([
      { type: 'openFile', generation, path: 'src/a.ts', line: 3 },
      { type: 'close', generation }
    ]);
    expect(r.layouts).toEqual([{ type: 'layout:ready', generation, token: 't1' }]);
  });

  it('stops delivery after unsubscribe', async () => {
    const r = await opened();
    r.store().unsubscribeSource(main);
    await r.pump();
    r.posted.length = 0;
    r.emit({ type: 'append', source: main, version: v1, binding: mainBinding, lineNumber: 4, line: 'l4' });
    await r.pump();
    expect(r.posted).toEqual([]);
  });

  it('posts signals only for the live generation', async () => {
    const r = rig();
    const theme = { type: 'theme:change' as const, generation, themeKind: 2 as const, cssVariables: { '--a': 'b' } };
    expect(r.bridge.signal(theme)).toBe(false);
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
    r.open();
    expect(r.bridge.signal({ ...theme, generation: 'view-0' })).toBe(false);
    expect(r.bridge.signal(theme)).toBe(true);
    expect(r.bridge.signal({ type: 'layout:handshake', generation, token: 'load-1' })).toBe(true);
  });

  it('dispose removes listeners and timers and suppresses all later traffic', async () => {
    const r = await opened();
    r.bridge.dispose();
    expect(r.listeners()).toBe(0);
    r.posted.length = 0;
    r.bridge.receive({ type: 'session:resync', generation });
    await r.pump();
    expect(r.posted).toEqual([]);
    expect(r.lists).toHaveLength(0);
  });
});

describe('view state persistence', () => {
  const saved: StreamViewState = { open: [['row-1', true]], ranges: [['tool-1', { first: 2, count: 10 }]] };

  /**
   * Accepts the first membership so initialization is available.
   * @param r - Rig.
   */
  async function accept(r: Rig): Promise<void> {
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await flush();
  }

  it('restores persisted state into initialization and the renderer store', async () => {
    const r = rig('compact', saved);
    await accept(r);
    expect(r.bridge.getInit()?.viewState).toEqual(saved);
    expect(r.inits[0]?.viewState).toEqual(saved);
    expect(r.open().getState().viewState).toEqual(saved);
  });

  it('omits view state from initialization when none was persisted', async () => {
    const r = rig();
    await accept(r);
    expect(r.bridge.getInit()).not.toHaveProperty('viewState');
    expect(r.open().getState().viewState).toBeNull();
  });

  it('hands each renderer state to the host and carries the latest into a rebuild', async () => {
    const r = rig();
    await accept(r);
    r.open();
    const next: StreamViewState = { open: [['row-2', false]], ranges: [] };
    r.store().postViewState(saved);
    r.store().postViewState(next);
    await r.pump();
    expect(r.views).toEqual([saved, next]);
    expect(r.bridge.getInit()?.viewState).toEqual(next);
    const rebuilt = rig('compact', r.views.at(-1));
    await accept(rebuilt);
    expect(rebuilt.open().getState().viewState).toEqual(next);
  });

  it('rejects over-bound and stale-generation state with diagnostics', async () => {
    const overBound: StreamViewState = {
      open: Array.from({ length: MAX_VIEW_STATE_ENTRIES + 1 }, (_, index): [string, boolean] => [`k${index}`, true]),
      ranges: []
    };
    const r = rig('compact', overBound);
    expect(r.diagnostics).toEqual([{ code: 'rejected-message', reason: 'invalid-view-state' }]);
    await accept(r);
    expect(r.bridge.getInit()).not.toHaveProperty('viewState');
    r.open();
    await r.pump();
    r.bridge.receive({ type: 'view:state', generation, state: overBound });
    r.bridge.receive({ type: 'view:state', generation: 'view-0', state: saved });
    expect(r.diagnostics.slice(1).map((event) => [event.code, event.reason])).toEqual([
      ['rejected-message', 'invalid-view-state'],
      ['stale-generation', undefined]
    ]);
    expect(r.views).toEqual([]);
    expect(r.bridge.getInit()).not.toHaveProperty('viewState');
  });
});

/** Server-side transcripts that answer the rig's deferred listings and reads. */
interface Server {
  /** Native lines per source, appended to in place by the test. */
  lines: Map<StreamSourceRef, string[]>;
  /** Appends lines to a source and publishes each as the server would; `silent` skips the event. */
  write(source: StreamSourceRef, count: number, silent?: boolean): void;
  /** Answers pending listings and reads from current content, firing backoffs, until quiescent. */
  settle(options?: { fire?: boolean }): Promise<void>;
  /** Number of reads answered so far. */
  served(): number;
  /** Replaces a source with a new incarnation holding `next`, publishing the old one's invalidation. */
  reset(source: StreamSourceRef, next: string[]): void;
}

/**
 * Models the server for a rig: listings and reads always reflect the current transcripts.
 * @param r - Rig whose deferred traffic the server answers.
 * @param sources - Sources the session lists, with their initial lines.
 * @returns Server controls.
 */
function serve(r: Rig, sources: Array<[StreamSourceRef, string[]]>): Server {
  const lines = new Map(sources);
  const bindingOf = (source: StreamSourceRef) => (source.relPath === child.relPath ? childBinding : mainBinding);
  const content = (relPath: string): [StreamSourceRef, string[]] => {
    const entry = [...lines].find(([source]) => source.relPath === relPath);
    if (!entry) throw new Error(`unknown source ${relPath}`);
    return entry;
  };
  const versions = new Map<string, StreamSourceVersion>();
  const versionOf = (relPath: string): StreamSourceVersion => versions.get(relPath) ?? v1;
  let served = 0;
  return {
    lines,
    write(source, count, silent = false) {
      const target = content(source.relPath)[1];
      for (let index = 0; index < count; index++) {
        target.push(`${source.relPath}:${target.length + 1}`);
        if (!silent)
          r.emit({
            type: 'append',
            source,
            version: versionOf(source.relPath),
            binding: bindingOf(source),
            lineNumber: target.length,
            line: target[target.length - 1] ?? ''
          });
      }
    },
    async settle(options = {}) {
      for (let round = 0; round < 40; round++) {
        await r.pump();
        const list = r.lists.shift();
        if (list) list([...lines].map(([source, all]) => meta(source, bindingOf(source), all.length)));
        else {
          const read = r.reads.shift();
          if (read) {
            const [source, all] = content(read.source.relPath);
            const first = read.tail === undefined ? 1 : Math.max(1, all.length - read.tail + 1);
            served++;
            read.resolve(
              serverSnapshot(source, all.slice(first - 1), { first, version: versionOf(read.source.relPath) })
            );
          } else if (options.fire && r.listeners() > 2) r.fire();
          else break;
        }
      }
    },
    served: () => served,
    reset(source, next) {
      const old = versionOf(source.relPath);
      versions.set(source.relPath, { serverEpoch: old.serverEpoch, sourceEpoch: `${old.sourceEpoch}-next` });
      const target = content(source.relPath)[1];
      target.splice(0, target.length, ...next);
      r.emit({ type: 'invalidated', source, version: old, binding: bindingOf(source), reason: 'replaced' });
    }
  };
}

/**
 * Opens a rig over a modelled server with the main source answered and ready.
 * @param sources - Listed sources and their initial lines.
 * @returns Opened rig and its server.
 */
async function served(
  sources: Array<[StreamSourceRef, string[]]> = [[main, ['l1', 'l2', 'l3']]]
): Promise<{ r: Rig; server: Server }> {
  const r = rig();
  const server = serve(r, sources);
  await server.settle();
  r.open();
  await r.pump();
  await server.settle();
  return { r, server };
}

/**
 * Drives the main source into an exhausted overflow pause: every recovery read is outrun
 * by more live appends than the controller may buffer.
 * @param r - Rig with an open renderer.
 * @param server - Its server.
 */
async function exhaustOverflow(r: Rig, server: Server): Promise<void> {
  const lines = server.lines.get(main) ?? [];
  // A forward gap makes the ready source re-read, so live appends outrun a read from the start.
  server.write(main, 1, true);
  server.write(main, 1);
  await r.pump();
  expect(r.reads).toHaveLength(1);
  for (let round = 0; round < 20 && r.view()?.status !== 'paused'; round++) {
    if (r.reads.length === 0) r.fire();
    await r.pump();
    const pending = r.reads.shift();
    if (!pending) continue;
    const snapshotLines = [...lines];
    server.write(main, 1001);
    const first = pending.tail === undefined ? 1 : Math.max(1, snapshotLines.length - pending.tail + 1);
    pending.resolve(serverSnapshot(main, snapshotLines.slice(first - 1), { first }));
    await r.pump();
  }
  expect(r.view()).toMatchObject({ status: 'paused', error: 'resync-overflow' });
}

/**
 * Asserts the renderer shows the server's newest content for a source as ready.
 * @param r - Rig.
 * @param server - Its server.
 * @param source - Source to check.
 */
function showsCurrent(r: Rig, server: Server, source: StreamSourceRef = main): void {
  const all = server.lines.get(source) ?? [];
  const view = r.view(source);
  expect(view).toMatchObject({ status: 'ready', error: null, totalLineCount: all.length });
  const shown = view?.lines ?? [];
  expect(shown.length).toBeGreaterThan(0);
  expect(shown).toEqual(all.slice(all.length - shown.length));
}

describe('membership refresh repairs a ready source behind the server', () => {
  it('re-reads a line the server lists but never published, marking the view stale meanwhile', async () => {
    const { r, server } = await served();
    // The agent's last reply reaches the file but its live event is lost.
    server.write(main, 1, true);
    r.posted.length = 0;
    r.tick();
    await r.pump();
    r.lists.shift()?.([meta(main, mainBinding, 4)]);
    await r.pump();
    expect(r.reads.map((read) => read.tail)).toEqual([TAIL_HISTORY_LINES]);
    expect(r.view()).toMatchObject({ status: 'resynchronizing', lines: ['l1', 'l2', 'l3'] });
    expect(r.diagnostics.map((event) => event.code)).toContain('source-behind');
    await server.settle();
    showsCurrent(r, server);
    expect(r.view()?.lines).toEqual(['l1', 'l2', 'l3', 's1.jsonl:4']);
    expect(r.posted.map((message) => message.type).filter((type) => type !== 'session:update')).toEqual([
      'source:status',
      'source:append',
      'source:status'
    ]);
  });

  it('does not re-read when the listing matches or trails the shown content', async () => {
    const { r, server } = await served();
    r.tick();
    await server.settle();
    expect(server.served()).toBe(1);
    // A live append outruns the listing: the server's count is behind what is shown.
    server.write(main, 1);
    await r.pump();
    r.tick();
    await r.pump();
    r.lists.shift()?.([meta(main, mainBinding, 3)]);
    await r.pump();
    expect(r.reads).toHaveLength(0);
    showsCurrent(r, server);
  });

  it('routes a listed binding change through invalidation and a full re-read, not a catch-up', async () => {
    const { r } = await served();
    r.tick();
    await r.pump();
    r.lists.shift()?.([meta(main, { sessionId: 's1', role: 'auxiliary' }, 4)]);
    await r.pump();
    expect(r.reads.map((read) => read.tail)).toEqual([undefined]);
    expect(r.diagnostics.map((event) => event.code)).not.toContain('source-behind');
    expect(r.view()).toMatchObject({ status: 'resynchronizing', lines: ['l1', 'l2', 'l3'] });
  });

  it('retries a failed catch-up read within the bounded budget, then pauses with Retry', async () => {
    const { r, server } = await served();
    server.write(main, 1, true);
    r.tick();
    await r.pump();
    r.lists.shift()?.([meta(main, mainBinding, 4)]);
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      expect(r.reads).toHaveLength(1);
      r.reads.shift()?.reject(new ApiError('unavailable', 'STREAM_SOURCE_UNAVAILABLE'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    expect(r.reads).toHaveLength(0);
    expect(r.view()).toMatchObject({ status: 'paused', error: 'load-error', lines: ['l1', 'l2', 'l3'] });
    r.posted.length = 0;
    r.store().retry();
    await server.settle();
    showsCurrent(r, server);
  });

  it('chases each listed count once, so a server whose reads trail its listing causes no read storm', async () => {
    const { r, server } = await served();
    r.tick();
    await r.pump();
    // The listing claims a fourth line that the server's read does not yet return.
    r.lists.shift()?.([meta(main, mainBinding, 4)]);
    await r.pump();
    await server.settle();
    expect(server.served()).toBe(2);
    expect(r.view()).toMatchObject({ status: 'ready', lines: ['l1', 'l2', 'l3'] });
    for (let tick = 0; tick < 3; tick++) {
      r.tick();
      await r.pump();
      r.lists.shift()?.([meta(main, mainBinding, 4)]);
      await r.pump();
      expect(r.reads).toHaveLength(0);
    }
    // A higher claim is chased again.
    server.write(main, 2, true);
    r.tick();
    await server.settle();
    expect(server.served()).toBe(3);
    showsCurrent(r, server);
  });
});

describe('host-lifted pauses resume the renderer without Retry', () => {
  it('resumes an overflow-exhausted source on its next live lifecycle event', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    await exhaustOverflow(r, server);
    expect(r.diagnostics.map((event) => event.code)).toContain('recovery-exhausted');
    r.emit({ type: 'resumed', source: main, version: v1, binding: mainBinding, totalLineCount: 1 });
    await server.settle({ fire: true });
    showsCurrent(r, server);
    // Live appends apply again.
    server.write(main, 2);
    await r.pump();
    showsCurrent(r, server);
  });

  it('resumes an overflow-exhausted source on the periodic refresh once the server lists more lines', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    await exhaustOverflow(r, server);
    r.tick();
    await server.settle({ fire: true });
    showsCurrent(r, server);
  });

  it('resumes an overflow-exhausted source on window focus', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    await exhaustOverflow(r, server);
    r.emit({ type: 'refresh', cardId: session.cardId, reason: 'focus' });
    await server.settle({ fire: true });
    showsCurrent(r, server);
  });

  it('resumes a read-failure pause once the server recovers and advances, without polling an idle failure', async () => {
    const r = rig();
    const server = serve(r, [[main, ['l1']]]);
    await server.settle();
    r.open();
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new Error('socket hang up'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    expect(r.view()).toMatchObject({ status: 'paused', error: 'load-error' });
    // An unchanged listing is no evidence of recovery: no re-read.
    r.tick();
    await r.pump();
    r.lists.shift()?.([meta(main, mainBinding, 1)]);
    await r.pump();
    expect(r.reads).toHaveLength(0);
    expect(r.view()).toMatchObject({ status: 'paused' });
    server.write(main, 1);
    r.tick();
    await server.settle();
    showsCurrent(r, server);
  });

  it('resumes an unavailable-source pause on the next live start', async () => {
    const r = rig();
    const server = serve(r, [[main, ['l1']]]);
    await server.settle();
    r.open();
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new ApiError('unavailable', 'STREAM_SOURCE_UNAVAILABLE'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    expect(r.view()).toMatchObject({ status: 'paused', error: 'load-error' });
    r.emit({ type: 'started', source: main, version: v1, binding: mainBinding, totalLineCount: 1 });
    await server.settle();
    showsCurrent(r, server);
  });

  it('resumes a membership-failure pause on the next successful listing', async () => {
    const { r, server } = await served();
    r.tick();
    await r.pump();
    r.failList();
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'paused', error: 'membership-error' });
    // Nothing changed on the server; the listing succeeding is the recovery.
    r.tick();
    await server.settle();
    showsCurrent(r, server);
  });

  it('resumes paused sources after the connection drops and returns', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    await exhaustOverflow(r, server);
    r.emit({ type: 'connection', connected: false });
    await r.pump();
    expect(r.view()).toMatchObject({ status: 'paused' });
    r.emit({ type: 'connection', connected: true });
    await server.settle({ fire: true });
    expect(r.store().getState().connection).toBe('connected');
    showsCurrent(r, server);
  });

  it('resumes a paused subagent section while the main section stays live', async () => {
    const { r, server } = await served([
      [main, ['l1', 'l2']],
      [child, ['c1']]
    ]);
    r.store().subscribeSource(child, 'tail');
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new ApiError('changed during read', 'STREAM_SOURCE_INCOHERENT'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    expect(r.view(child)).toMatchObject({ status: 'paused', error: 'inconsistent-source' });
    showsCurrent(r, server);
    server.write(child, 2, true);
    r.tick();
    await server.settle();
    showsCurrent(r, server, child);
    showsCurrent(r, server);
  });

  it('keeps Retry working when recovery cannot proceed on its own, and repeated Retry is idempotent', async () => {
    const r = rig();
    const server = serve(r, [[main, ['l1']]]);
    await server.settle();
    r.open();
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new ApiError('changed during read', 'STREAM_SOURCE_INCOHERENT'));
      await r.pump();
      r.fire();
      await r.pump();
    }
    for (let tick = 0; tick < 3; tick++) {
      r.tick();
      await server.settle();
    }
    expect(server.served()).toBe(0);
    expect(r.view()).toMatchObject({ status: 'paused', error: 'inconsistent-source' });
    r.store().retry();
    r.store().retry();
    await r.pump();
    expect(r.lists.length).toBeLessThanOrEqual(1);
    await server.settle();
    expect(server.served()).toBe(1);
    showsCurrent(r, server);
    r.store().retry();
    await server.settle();
    expect(server.served()).toBe(1);
    showsCurrent(r, server);
  });
});

/**
 * Records every status the renderer ever publishes for a source.
 * @param r - Rig with an open renderer.
 * @param source - Source to watch.
 * @returns Statuses seen so far, in publication order.
 */
function statusesOf(r: Rig, source: StreamSourceRef = main): string[] {
  const seen: string[] = [];
  r.store().subscribe(() => {
    const status = r.view(source)?.status;
    if (status && seen.at(-1) !== status) seen.push(status);
  });
  return seen;
}

/**
 * Encoded size of an append's lines, the axis the renderer once bounded.
 * @param message - Host message.
 * @returns UTF-8 bytes of its lines, or 0 for any other message.
 */
function appendBytes(message: HostToRendererMessage): number {
  if (message.type !== 'source:append') return 0;
  return message.lines.reduce((total, line) => total + new TextEncoder().encode(line).length, 0);
}

describe('the host alone owns overflow recovery; the renderer never pauses on a burst', () => {
  it('keeps main and subagent sections live through two 1000-event windows that cross re-requests', async () => {
    const { r, server } = await served([
      [main, ['l1', 'l2']],
      [child, ['c1']]
    ]);
    r.store().subscribeSource(child, 'tail');
    await server.settle();
    const mainSeen = statusesOf(r);
    const childSeen = statusesOf(r, child);
    // Both sections re-request while the host is still forwarding to their answered requests.
    r.store().subscribeSource(main, 'full');
    r.store().subscribeSource(child, 'full');
    for (let index = 0; index < 1100; index++) {
      server.write(main, 1);
      server.write(child, 1);
    }
    expect(r.posted.filter((message) => message.type === 'source:append').length).toBeGreaterThan(2000);
    await server.settle();
    expect(mainSeen).not.toContain('paused');
    expect(childSeen).not.toContain('paused');
    showsCurrent(r, server);
    showsCurrent(r, server, child);
    expect(r.view()?.lines).toEqual(server.lines.get(main));
    expect(r.view(child)?.lines).toEqual(server.lines.get(child));
    // Live delivery continues on the answered requests.
    server.write(main, 3);
    server.write(child, 3);
    await r.pump();
    showsCurrent(r, server);
    showsCurrent(r, server, child);
  });

  it('answers an awaiting renderer after a host catch-up of two appends over 1 MiB each, never pausing', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    const seen = statusesOf(r);
    const lines = server.lines.get(main) ?? [];
    const filler = 'x'.repeat(1100);
    // The server grows by 2,000 large lines whose live events are lost.
    for (let index = 0; index < 2000; index++) lines.push(`${lines.length + 1}:${filler}`);
    // The renderer re-requests; its request is still in flight when the host catches up.
    r.store().subscribeSource(main, 'full');
    r.posted.length = 0;
    r.tick();
    await flush();
    r.lists.shift()?.([meta(main, mainBinding, lines.length)]);
    await flush();
    expect(r.reads).toHaveLength(1);
    r.reads.shift()?.resolve(serverSnapshot(main, [...lines]));
    await flush();
    const chunks = r.posted.filter((message) => message.type === 'source:append');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) expect(appendBytes(chunk)).toBeGreaterThan(1_048_576);
    await server.settle();
    expect(seen).not.toContain('paused');
    showsCurrent(r, server);
    expect(r.view()?.lines).toEqual(lines);
  });

  it('carries a single line over 1 MiB to a live renderer and to one awaiting an answer', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    const seen = statusesOf(r);
    const lines = server.lines.get(main) ?? [];
    const huge = (): string => `${lines.length + 1}:${'y'.repeat(2 * 1_048_576)}`;
    const publish = (): void => {
      lines.push(huge());
      r.emit({
        type: 'append',
        source: main,
        version: v1,
        binding: mainBinding,
        lineNumber: lines.length,
        line: lines.at(-1) ?? ''
      });
    };
    publish();
    await r.pump();
    showsCurrent(r, server);
    const before = r.posted.length;
    r.store().subscribeSource(main, 'full');
    publish();
    publish();
    await server.settle();
    expect(seen).not.toContain('paused');
    showsCurrent(r, server);
    expect(r.view()?.lines).toEqual(lines);
    // One request, one answer: no refetch was spent on the oversized lines.
    expect(r.posted.slice(before).filter((message) => message.type === 'source:snapshot')).toHaveLength(1);
  });
});

describe('overflow diagnostics are coalesced per recovery episode', () => {
  it('logs one opening and one counted closing line per source for a 30,000-line burst across two sources', async () => {
    const { r, server } = await served([
      [main, ['l1']],
      [child, ['c1']]
    ]);
    r.store().subscribeSource(child, 'tail');
    await server.settle();
    r.diagnostics.length = 0;
    // A lost line opens a forward gap on each source, so both re-read while the burst arrives.
    for (const source of [main, child]) {
      server.write(source, 1, true);
      server.write(source, 1);
    }
    await r.pump();
    expect(r.reads).toHaveLength(2);
    for (let index = 0; index < 15_000; index++) {
      server.write(main, 1);
      server.write(child, 1);
    }
    await server.settle({ fire: true });
    showsCurrent(r, server);
    showsCurrent(r, server, child);
    for (const source of [main, child]) {
      const lines = r.diagnostics.filter((event) => event.source?.relPath === source.relPath);
      expect(lines.filter((event) => event.code === 'resync-overflow')).toHaveLength(1);
      const closing = lines.filter((event) => event.code === 'resync-recovered');
      expect(closing).toHaveLength(1);
      expect(closing[0]?.count).toBeGreaterThanOrEqual(29);
      expect(lines.filter((event) => event.code === 'recovery-exhausted')).toHaveLength(0);
    }
    expect(r.diagnostics.length).toBeLessThan(20);
    // Identifiers only: no native line reaches the log.
    expect(JSON.stringify(r.diagnostics)).not.toContain('jsonl:');
  });

  it('closes an exhausted episode with a counted line at the pause', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    r.diagnostics.length = 0;
    await exhaustOverflow(r, server);
    expect(r.diagnostics.filter((event) => event.code === 'resync-overflow')).toHaveLength(1);
    const exhausted = r.diagnostics.filter((event) => event.code === 'recovery-exhausted');
    expect(exhausted).toEqual([expect.objectContaining({ source: main })]);
    // Every overflow of the episode, including those absorbed by an in-flight read, is counted.
    expect(exhausted[0]?.count).toBeGreaterThan(SESSION_READ_RETRY_DELAYS_MS.length);
    expect(JSON.stringify(r.diagnostics)).not.toContain('jsonl:');
  });
});

/**
 * Watches the wire for the forwarding invariant the renderer relies on: the host sends a source
 * append, lifecycle, or status only once it has answered the renderer's latest request for that
 * source, as the host received it. A renderer request, an invalidation, a typed error, and a
 * reconnection each leave the source unanswered until a correlated snapshot follows.
 * @param r - Rig to observe from now on.
 * @param ready - Sources whose current request the renderer already holds answered.
 * @returns Live list of violations, plus how many content messages were checked.
 */
function guardForwarding(r: Rig, ready: StreamSourceRef[] = [main]): { violations: string[]; checked: () => number } {
  const violations: string[] = [];
  const state = new Map<string, { request: string | null; answered: boolean }>(
    ready.map((source) => {
      expect(r.view(source)).toMatchObject({ status: 'ready' });
      return [source.relPath, { request: r.view(source)?.requestId ?? null, answered: true }];
    })
  );
  let checked = 0;
  r.observe((from, raw) => {
    const message = raw as { type: string; source?: StreamSourceRef; requestId?: string; state?: string };
    const key = message.source?.relPath ?? '';
    const entry = state.get(key) ?? { request: null, answered: false };
    state.set(key, entry);
    if (from === 'renderer') {
      if (message.type === 'source:subscribe') entry.request = message.requestId ?? null;
      if (message.type === 'source:subscribe' || message.type === 'source:unsubscribe') entry.answered = false;
      if (message.type === 'source:unsubscribe') entry.request = null;
      return;
    }
    switch (message.type) {
      case 'source:snapshot':
        if (message.requestId === entry.request) entry.answered = true;
        return;
      case 'source:error':
        if (message.requestId === entry.request) entry.answered = false;
        return;
      case 'source:invalidated':
        entry.answered = false;
        return;
      case 'connection:state':
        if (message.state === 'connected') for (const each of state.values()) each.answered = false;
        return;
      case 'source:append':
      case 'source:lifecycle':
      case 'source:status':
        checked++;
        if (!entry.answered) violations.push(`${message.type} ${key} before answering ${entry.request ?? 'nothing'}`);
    }
  });
  return { violations, checked: () => checked };
}

/**
 * Asserts the renderer holds exactly the server's whole transcript: no duplicate, gap, or lost line.
 * @param r - Rig.
 * @param server - Its server.
 * @param source - Source to check.
 */
function holdsExactly(r: Rig, server: Server, source: StreamSourceRef = main): void {
  expect(r.view(source)).toMatchObject({ status: 'ready', error: null, firstLineNumber: 1 });
  expect(r.view(source)?.lines).toEqual(server.lines.get(source));
}

describe('the host never forwards source content for an unanswered request', () => {
  it('drops an append posted before a re-request and converges on the covering snapshot', async () => {
    const { r, server } = await served([[main, ['l1', 'l2']]]);
    const guard = guardForwarding(r);
    const seen = statusesOf(r);
    // The host posts an append to the answered request; before it arrives the renderer re-requests.
    server.write(main, 1);
    r.store().subscribeSource(main, 'full');
    await r.pump();
    expect(r.view()).toMatchObject({ lines: ['l1', 'l2'] });
    // More lines land while the re-request's read is in flight; none are forwarded.
    const before = r.posted.length;
    server.write(main, 2);
    await r.pump();
    expect(r.posted.slice(before).map((message) => message.type)).toEqual([]);
    await server.settle();
    holdsExactly(r, server);
    expect(seen).not.toContain('paused');
    server.write(main, 1);
    await r.pump();
    holdsExactly(r, server);
    expect(guard.violations).toEqual([]);
    expect(guard.checked()).toBeGreaterThan(0);
  });

  it('holds across a subagent subscription, reconnection, a source reset, and Retry while lines keep arriving', async () => {
    const { r, server } = await served([
      [main, ['l1']],
      [child, ['c1']]
    ]);
    const guard = guardForwarding(r);
    const writeBoth = (): void => {
      server.write(main, 2);
      server.write(child, 2);
    };
    // Subscribe: the child's first request is answered only after its read.
    r.store().subscribeSource(child, 'full');
    writeBoth();
    await server.settle();
    writeBoth();
    await r.pump();
    holdsExactly(r, server);
    holdsExactly(r, server, child);

    // Reconnection: every wanted source is re-requested and re-answered.
    r.emit({ type: 'connection', connected: false });
    writeBoth();
    await r.pump();
    r.emit({ type: 'connection', connected: true });
    writeBoth();
    await r.pump();
    writeBoth();
    await server.settle();
    holdsExactly(r, server);
    holdsExactly(r, server, child);

    // Source reset: the old incarnation is invalidated before any successor content.
    server.reset(main, ['n1', 'n2']);
    writeBoth();
    await r.pump();
    writeBoth();
    await server.settle();
    holdsExactly(r, server);
    holdsExactly(r, server, child);

    // Retry: a paused source is re-requested and answered before live delivery resumes.
    server.write(child, 1, true);
    r.tick();
    await r.pump();
    r.lists.shift()?.(
      [...server.lines].map(([source, all]) => meta(source, source === child ? childBinding : mainBinding, all.length))
    );
    await r.pump();
    for (let attempt = 0; attempt <= SESSION_READ_RETRY_DELAYS_MS.length; attempt++) {
      r.reads.shift()?.reject(new ApiError('changed during read', 'STREAM_SOURCE_INCOHERENT'));
      await r.pump();
      writeBoth();
      r.fire();
      await r.pump();
    }
    expect(r.view(child)).toMatchObject({ status: 'paused', error: 'inconsistent-source' });
    r.store().retry();
    writeBoth();
    await server.settle();
    writeBoth();
    await server.settle();
    holdsExactly(r, server);
    holdsExactly(r, server, child);

    expect(guard.violations).toEqual([]);
    expect(guard.checked()).toBeGreaterThan(20);
  });
});

describe('renderer diagnostics reach the host log', () => {
  it('logs a renderer pause as a renderer-diagnostic with its reason and source', async () => {
    const { r, server } = await served([[main, ['l1']]]);
    r.diagnostics.length = 0;
    await exhaustOverflow(r, server);
    await r.pump();
    expect(r.diagnostics.filter((event) => event.code === 'renderer-diagnostic')).toEqual([
      { code: 'renderer-diagnostic', reason: 'source-paused:resync-overflow', source: main }
    ]);
    expect(JSON.stringify(r.diagnostics)).not.toContain('jsonl:');
  });

  it('rate-limits renderer reports again on the host, summing their counts, and scopes their sources', async () => {
    const { r } = await served();
    r.diagnostics.length = 0;
    const report = { type: 'renderer:diagnostic', generation, code: 'rejected-message', reason: 'invalid-lines' };
    for (let index = 0; index < 9; index++) r.bridge.receive({ ...report, count: 3 });
    expect(r.diagnostics).toEqual([
      { code: 'renderer-diagnostic', reason: 'rejected-message:invalid-lines', count: 3 },
      { code: 'renderer-diagnostic', reason: 'rejected-message:invalid-lines', count: 3 },
      { code: 'renderer-diagnostic', reason: 'rejected-message:invalid-lines', count: 6 },
      { code: 'renderer-diagnostic', reason: 'rejected-message:invalid-lines', count: 12 }
    ]);
    r.diagnostics.length = 0;
    // A source outside current membership is never logged.
    r.bridge.receive({
      type: 'renderer:diagnostic',
      generation,
      code: 'source-reset',
      source: { ...main, relPath: 'other.jsonl' }
    });
    r.bridge.receive({ type: 'renderer:diagnostic', generation, code: 'source-reset', source: main });
    r.bridge.receive({ type: 'renderer:diagnostic', generation: 'view-0', code: 'source-reset' });
    r.bridge.receive({ ...report, reason: 'Native Line' });
    expect(r.diagnostics).toEqual([
      { code: 'renderer-diagnostic', reason: 'source-reset' },
      { code: 'renderer-diagnostic', reason: 'source-reset', source: main },
      { code: 'stale-generation' },
      { code: 'rejected-message', reason: 'invalid-diagnostic' }
    ]);
  });
});

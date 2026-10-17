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
  listeners(): number;
  /** Creates the renderer from the bridge's initialization and attaches it. */
  open(mode?: StreamDisplayMode): StreamRendererStore;
  /** Delivers queued messages in both directions until quiescent. */
  pump(): Promise<void>;
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
  const cards: CardsStreamClient = {
    listStreams: () => new Promise((resolve) => lists.push(resolve)),
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
        createRequestId: () => `req-${++requests}`
      });
      bridge.attach();
      return renderer;
    },
    async pump() {
      for (let round = 0; round < 50; round++) {
        await flush();
        if (toRenderer.length === 0 && toHost.length === 0) return;
        while (toHost.length > 0) bridge.receive(toHost.shift());
        while (toRenderer.length > 0) rendererListener?.(toRenderer.shift());
      }
    },
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
    const sourceMessages = r.posted.filter((message) => message.type !== 'session:update');
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

/**
 * Session renderer store: membership, version-fenced merging, and stale-traffic races.
 *
 * Every test drives a real store over a synchronous in-memory transport, so
 * message ordering is fully deterministic and each race is reproduced exactly.
 *
 * @summary Session stream store race and merge tests
 */

import { describe, expect, it } from 'vitest';
import { createStreamStore } from '../../src/stream-store/store.js';
import { MAX_PENDING_BYTES, MAX_PENDING_EVENTS, TAIL_HISTORY_LINES } from '../../src/stream-store/types.js';
import {
  append,
  child,
  childBinding,
  childMember,
  descriptor,
  generation,
  harness,
  key,
  main,
  mainBinding,
  mainMember,
  meta,
  session,
  snapshot,
  v1,
  v2
} from './fixtures.js';

/**
 * Reads one source view, failing loudly when absent.
 * @param h - Harness.
 * @param source - Source to read.
 * @returns Current source view.
 * @throws Error when the source is absent.
 */
function view(h: ReturnType<typeof harness>, source = main) {
  const found = h.store.getState().sources.get(key(source));
  if (!found) throw new Error(`missing source ${source.relPath}`);
  return found;
}

/**
 * Creates a harness whose main source is ready with lines 1..n in version v1.
 * @param n - Number of lines.
 * @param mode - Display mode.
 * @returns Ready harness.
 */
function ready(n: number, mode: 'compact' | 'expanded' = 'expanded') {
  const h = harness({ mode });
  h.deliver(
    snapshot({
      requestId: h.lastRequestId(),
      lines: Array.from({ length: n }, (_, index) => `l${index + 1}`)
    })
  );
  return h;
}

describe('stream store initialization', () => {
  it.skip('exposes the bound session, generation, revision, and descriptor members as sources', () => {
    const h = harness();
    const state = h.store.getState();
    expect(state.session).toEqual(session);
    expect(state.generation).toBe(generation);
    expect(state.revision).toBe(1);
    expect(state.connection).toBe('connected');
    expect([...state.sources.keys()]).toEqual([key(main), key(child)]);
    expect(view(h, child)).toMatchObject({ member: childMember, status: 'unsubscribed', requestId: null });
  });

  it.skip('auto-subscribes the main in tail mode for compact and full mode for expanded', () => {
    const compact = harness({ mode: 'compact' });
    expect(compact.subscribes()).toEqual([
      { type: 'source:subscribe', generation, requestId: 'req-1', source: main, history: 'tail' }
    ]);
    expect(view(compact)).toMatchObject({ status: 'loading', history: 'tail', requestId: 'req-1' });
    const expanded = harness({ mode: 'expanded' });
    expect(expanded.subscribes()[0]?.history).toBe('full');
  });

  it.skip('does not auto-subscribe any member when the session has no unique main', () => {
    const h = harness({ descriptor: descriptor(childMember) });
    expect(h.sent).toEqual([]);
  });

  it.skip('rejects initialization whose descriptor names another session or foreign members', () => {
    const create = (init: Parameters<typeof createStreamStore>[0]['init']) => () =>
      createStreamStore({ init, post: () => undefined, listen: () => () => undefined });
    const base = { session, generation, revision: 1, mode: 'compact' as const };
    expect(
      create({ ...base, descriptor: { ...descriptor(mainMember), session: { ...session, sessionId: 's2' } } })
    ).toThrow();
    expect(
      create({
        ...base,
        descriptor: descriptor({ source: { ...main, cardId: 'card-2' }, role: 'main' })
      })
    ).toThrow();
    expect(create({ ...base, generation: '', descriptor: descriptor(mainMember) })).toThrow();
    expect(create({ ...base, revision: 0, descriptor: descriptor(mainMember) })).toThrow();
  });
});

describe('snapshot correlation', () => {
  it.skip('establishes authority from the current request and reports unloaded earlier content for a tail', () => {
    const h = harness();
    h.deliver(snapshot({ requestId: h.lastRequestId(), first: 51, lines: ['l51', 'l52'] }));
    expect(view(h)).toMatchObject({
      status: 'ready',
      lines: ['l51', 'l52'],
      firstLineNumber: 51,
      totalLineCount: 52,
      earlierUnloaded: true,
      authority: { source: main, version: v1, binding: mainBinding },
      error: null
    });
  });

  it.skip('drops snapshots with a superseded request ID or another generation', () => {
    const h = harness();
    h.deliver(snapshot({ requestId: 'req-unknown', lines: ['x'] }));
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['x'], generation: 'gen-0' }));
    expect(view(h).status).toBe('loading');
    expect(view(h).lines).toEqual([]);
    expect(h.diagnostics.map((event) => event.code)).toContain('stale-response');
  });

  it.skip('rejects a snapshot whose binding disagrees with current membership', () => {
    const h = harness();
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['x'], binding: { sessionId: 's2', role: 'main' } }));
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['x'], binding: { sessionId: 's1', role: 'subagent' } }));
    expect(view(h).authority).toBeNull();
    expect(view(h).lines).toEqual([]);
  });

  it.skip('records a typed source error for the current request', () => {
    const h = harness();
    h.deliver({ type: 'source:error', generation, requestId: h.lastRequestId(), source: main, error: 'not-found' });
    expect(view(h)).toMatchObject({ status: 'paused', error: 'not-found' });
  });
});

describe('live merge within one source version', () => {
  it.skip('appends the expected next coordinates and drops identical duplicates', () => {
    const h = ready(3);
    h.deliver(append(4, ['l4', 'l5']));
    h.deliver(append(3, ['l3', 'l4']));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3', 'l4', 'l5'], totalLineCount: 5 });
  });

  it.skip('appends the unseen suffix of a partially overlapping batch', () => {
    const h = ready(3);
    h.deliver(append(2, ['l2', 'l3', 'l4']));
    expect(view(h).lines).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it.skip('treats a same-version snapshot ending at N after live N+1 as overlap, not truncation', () => {
    const h = ready(3);
    h.deliver(append(4, ['l4']));
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2', 'l3'] }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3', 'l4'], totalLineCount: 4, status: 'ready' });
  });

  it.skip('extends coverage from a same-version snapshot that reaches further than local content', () => {
    const h = ready(2);
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2', 'l3', 'l4'] }));
    expect(view(h).lines).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it.skip('never infers reset from a shorter delayed same-version snapshot', () => {
    const h = ready(5);
    h.deliver(snapshot({ requestId: h.lastRequestId(), first: 4, lines: ['l4', 'l5'] }));
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2'] }));
    expect(view(h).lines).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(view(h).authority?.version).toEqual(v1);
  });

  it.skip('fills a forward gap through exactly one in-flight refetch and applies the buffered suffix', () => {
    const h = ready(3);
    const before = h.subscribes().length;
    h.deliver(append(6, ['l6']));
    h.deliver(append(7, ['l7']));
    expect(h.subscribes()).toHaveLength(before + 1);
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3'], status: 'resynchronizing' });
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2', 'l3', 'l4', 'l5'] }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'], status: 'ready' });
  });

  it.skip('treats same-version conflicting bytes as an inconsistency and refetches', () => {
    const h = ready(3);
    const before = h.subscribes().length;
    h.deliver(append(3, ['other']));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3'], status: 'resynchronizing' });
    expect(h.subscribes()).toHaveLength(before + 1);
    expect(h.diagnostics.map((event) => event.code)).toContain('inconsistent-source');
  });

  it.skip('pauses with an explicit inconsistency when the refetched same version still conflicts', () => {
    const h = ready(3);
    h.deliver(append(3, ['other']));
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2', 'other'] }));
    expect(view(h)).toMatchObject({ status: 'paused', error: 'inconsistent-source', lines: ['l1', 'l2', 'l3'] });
  });

  it.skip('retains only the trailing window for tail-history sources while live lines arrive', () => {
    const h = harness({ mode: 'compact' });
    h.deliver(
      snapshot({
        requestId: h.lastRequestId(),
        first: 1,
        lines: Array.from({ length: TAIL_HISTORY_LINES }, (_, i) => `l${i + 1}`)
      })
    );
    h.deliver(append(TAIL_HISTORY_LINES + 1, ['next']));
    const current = view(h);
    expect(current.lines).toHaveLength(TAIL_HISTORY_LINES);
    expect(current.lines.at(-1)).toBe('next');
    expect(current.firstLineNumber).toBe(2);
    expect(current.earlierUnloaded).toBe(true);
  });
});

describe('source versions', () => {
  it.skip('pauses a source on an unseen version instead of accepting it from arrival order', () => {
    const h = ready(3);
    const before = h.subscribes().length;
    h.deliver(append(1, ['new1'], { version: v2 }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3'], status: 'resynchronizing' });
    expect(h.subscribes()).toHaveLength(before + 1);
  });

  it.skip('atomically replaces content with a fresh full snapshot of the new version and drops old-version traffic', () => {
    const h = ready(3);
    h.deliver(append(1, ['new1'], { version: v2 }));
    h.deliver(snapshot({ requestId: h.lastRequestId(), version: v2, lines: ['new1'] }));
    expect(view(h)).toMatchObject({ lines: ['new1'], totalLineCount: 1, authority: { version: v2 } });
    h.deliver(append(4, ['l4']));
    h.deliver(snapshot({ requestId: h.lastRequestId(), version: v1, lines: ['l1', 'l2', 'l3', 'l4'] }));
    expect(view(h)).toMatchObject({ lines: ['new1'], authority: { version: v2 } });
  });

  it.skip('rejects a partial snapshot of an unseen version when replacing an established one', () => {
    const h = ready(3);
    h.deliver(snapshot({ requestId: h.lastRequestId(), version: v2, first: 2, lines: ['b', 'c'] }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3'], authority: { version: v1 } });
    expect(view(h).status).not.toBe('ready');
  });

  it.skip('invalidation retires the version, re-requests with a fresh request ID, and rejects late old responses', () => {
    const h = ready(3);
    const old = h.lastRequestId();
    h.deliver({
      type: 'source:invalidated',
      generation,
      source: main,
      version: v1,
      binding: mainBinding,
      reason: 'replaced'
    });
    expect(view(h)).toMatchObject({ authority: null, status: 'resynchronizing', reconciliationEpoch: 1 });
    expect(h.lastRequestId()).not.toBe(old);
    h.deliver(snapshot({ requestId: old, version: v2, lines: ['n1'] }));
    h.deliver(snapshot({ requestId: h.lastRequestId(), version: v1, lines: ['l1', 'l2', 'l3', 'l4'] }));
    h.deliver(append(4, ['l4']));
    expect(view(h).authority).toBeNull();
    h.deliver(snapshot({ requestId: h.lastRequestId(), version: v2, first: 2, lines: ['n2'] }));
    expect(view(h)).toMatchObject({ lines: ['n2'], firstLineNumber: 2, authority: { version: v2 }, status: 'ready' });
  });

  it.skip('ignores invalidation of a version it never accepted when another is current', () => {
    const h = ready(2);
    h.deliver({
      type: 'source:invalidated',
      generation,
      source: main,
      version: v2,
      binding: mainBinding,
      reason: 'replaced'
    });
    expect(view(h)).toMatchObject({ status: 'ready', authority: { version: v1 } });
  });

  it.skip('refuses delayed old-epoch traffic after a server-restart invalidation and reconnect', () => {
    const h = ready(2);
    h.deliver({ type: 'connection:state', generation, state: 'disconnected' });
    h.deliver({
      type: 'source:invalidated',
      generation,
      source: main,
      version: v1,
      binding: mainBinding,
      reason: 'server-restarted'
    });
    h.deliver({ type: 'connection:state', generation, state: 'connected' });
    const restarted = { serverEpoch: 'server-2', sourceEpoch: 'source-1' };
    h.deliver(snapshot({ requestId: h.lastRequestId(), version: restarted, lines: ['l1', 'l2', 'l3'] }));
    h.deliver(append(4, ['old'], { version: v1 }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3'], authority: { version: restarted }, status: 'ready' });
  });
});

describe('routing binding', () => {
  it.skip('never applies content whose binding names another session or role and invalidates the source', () => {
    const h = ready(2);
    h.deliver(append(3, ['leak'], { binding: { sessionId: 's2', role: 'main' } }));
    expect(view(h).lines).toEqual(['l1', 'l2']);
    expect(view(h).status).toBe('resynchronizing');
    expect(h.diagnostics.map((event) => event.code)).toContain('rejected-message');
  });

  it.skip('drops content for identical paths outside the bound card or provider', () => {
    const h = ready(2);
    h.deliver(append(3, ['other-card'], { source: { ...main, cardId: 'card-2' } }));
    h.deliver(append(3, ['other-provider'], { source: { ...main, streamType: 'codex-session' } }));
    expect(view(h).lines).toEqual(['l1', 'l2']);
    expect(h.store.getState().sources.size).toBe(2);
  });

  it.skip('drops content for sources that are not current members', () => {
    const h = ready(2);
    const stranger = { ...main, relPath: 'stranger.jsonl' };
    h.deliver(append(1, ['x'], { source: stranger }));
    expect(h.store.getState().sources.has(key(stranger))).toBe(false);
  });
});

describe('membership updates', () => {
  it.skip('accepts only strictly increasing descriptor revisions', () => {
    const h = harness();
    h.deliver({ type: 'session:update', generation, revision: 3, descriptor: descriptor(mainMember) });
    h.deliver({ type: 'session:update', generation, revision: 2, descriptor: descriptor(mainMember, childMember) });
    expect(h.store.getState().revision).toBe(3);
    expect(h.store.getState().descriptor.members).toEqual([mainMember]);
  });

  it.skip('retains removed member content as unavailable history and rejects its late responses', () => {
    const h = ready(2);
    h.store.subscribeSource(child, 'tail');
    const childRequest = h.lastRequestId(child);
    h.deliver(snapshot({ source: child, requestId: childRequest, lines: ['c1'] }));
    h.deliver({ type: 'session:update', generation, revision: 2, descriptor: descriptor(mainMember) });
    expect(view(h, child)).toMatchObject({ member: null, status: 'unavailable', lines: ['c1'], requestId: null });
    h.deliver(append(2, ['c2'], { source: child }));
    h.deliver(snapshot({ source: child, requestId: childRequest, lines: ['c1', 'c2'] }));
    expect(view(h, child)).toMatchObject({ status: 'unavailable', lines: ['c1'] });
  });

  it.skip('starts new source work on readdition instead of reviving an old response', () => {
    const h = ready(2);
    h.store.subscribeSource(child, 'full');
    const oldRequest = h.lastRequestId(child);
    h.deliver({ type: 'session:update', generation, revision: 2, descriptor: descriptor(mainMember) });
    h.deliver({ type: 'session:update', generation, revision: 3, descriptor: descriptor(mainMember, childMember) });
    const readded = view(h, child);
    expect(readded.member).toEqual(childMember);
    expect(readded.reconciliationEpoch).toBeGreaterThan(0);
    expect(readded.requestId).not.toBe(oldRequest);
    h.deliver(snapshot({ source: child, requestId: oldRequest, lines: ['stale'] }));
    expect(view(h, child).lines).toEqual([]);
    h.deliver(snapshot({ source: child, requestId: h.lastRequestId(child), version: v2, lines: ['fresh'] }));
    expect(view(h, child)).toMatchObject({ lines: ['fresh'], status: 'ready' });
  });

  it.skip('invalidates a member whose role or agent identity changes in a newer descriptor', () => {
    const h = ready(2);
    const moved = { source: main, role: 'auxiliary' as const, agentId: 'aux' };
    h.deliver({ type: 'session:update', generation, revision: 2, descriptor: descriptor(moved, childMember) });
    expect(view(h)).toMatchObject({ member: moved, authority: null, status: 'resynchronizing' });
    h.deliver(append(3, ['l3']));
    expect(view(h).lines).toEqual(['l1', 'l2']);
  });

  it.skip('rejects a descriptor for another session or with foreign members', () => {
    const h = harness();
    h.deliver({
      type: 'session:update',
      generation,
      revision: 2,
      descriptor: { ...descriptor(mainMember), session: { ...session, sessionId: 's2' } }
    });
    h.deliver({
      type: 'session:update',
      generation,
      revision: 3,
      descriptor: descriptor({ source: { ...main, cardId: 'card-2' }, role: 'main' })
    });
    expect(h.store.getState().revision).toBe(1);
  });
});

describe('subscriptions', () => {
  it.skip('refuses to request sources outside current membership', () => {
    const h = harness();
    const before = h.sent.length;
    h.store.subscribeSource({ ...main, cardId: 'card-2' }, 'full');
    h.store.subscribeSource({ ...main, relPath: 'stranger.jsonl' }, 'full');
    expect(h.sent).toHaveLength(before);
    expect(h.diagnostics.map((event) => event.code)).toContain('rejected-message');
  });

  it.skip('coalesces duplicate requests per source and mode', () => {
    const h = harness({ mode: 'compact' });
    h.store.subscribeSource(main, 'tail');
    h.store.subscribeSource(main, 'tail');
    expect(h.subscribes()).toHaveLength(1);
  });

  it.skip('upgrades an in-flight tail to full whose eventual tail response cannot downgrade coverage', () => {
    const h = harness({ mode: 'compact' });
    const tailRequest = h.lastRequestId();
    h.store.subscribeSource(main, 'full');
    expect(h.subscribes().map((message) => message.history)).toEqual(['tail', 'full']);
    h.deliver(snapshot({ requestId: tailRequest, first: 9, lines: ['l9', 'l10'] }));
    expect(view(h)).toMatchObject({ history: 'full', status: 'loading', lines: [] });
    h.store.subscribeSource(main, 'tail');
    expect(h.subscribes()).toHaveLength(2);
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: Array.from({ length: 10 }, (_, i) => `l${i + 1}`) }));
    expect(view(h)).toMatchObject({ history: 'full', earlierUnloaded: false, firstLineNumber: 1 });
  });

  it.skip('requests full history for a ready tail source and merges earlier lines', () => {
    const h = harness({ mode: 'compact' });
    h.deliver(snapshot({ requestId: h.lastRequestId(), first: 3, lines: ['l3', 'l4'] }));
    h.store.subscribeSource(main, 'full');
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2', 'l3', 'l4'] }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3', 'l4'], earlierUnloaded: false, history: 'full' });
  });

  it.skip('unsubscribe cancels the pending request and stops live delivery', () => {
    const h = ready(2);
    const request = h.lastRequestId();
    h.store.unsubscribeSource(main);
    expect(h.sent.at(-1)).toEqual({ type: 'source:unsubscribe', generation, source: main });
    h.deliver(append(3, ['l3']));
    h.deliver(snapshot({ requestId: request, lines: ['l1', 'l2', 'l3'] }));
    expect(view(h)).toMatchObject({ status: 'unsubscribed', requestId: null, lines: ['l1', 'l2'] });
  });
});

describe('connection and resynchronization', () => {
  it.skip('marks subscribed sources resynchronizing while disconnected and refetches each on reconnect', () => {
    const h = ready(2);
    h.store.subscribeSource(child, 'tail');
    h.deliver({ type: 'connection:state', generation, state: 'disconnected' });
    expect(h.store.getState().connection).toBe('disconnected');
    expect(view(h)).toMatchObject({ status: 'resynchronizing', lines: ['l1', 'l2'] });
    const before = h.subscribes().length;
    const childBefore = h.subscribes(child).length;
    h.deliver({ type: 'connection:state', generation, state: 'connected' });
    expect(h.subscribes()).toHaveLength(before + 1);
    expect(h.subscribes().at(-1)?.history).toBe('full');
    expect(h.subscribes(child)).toHaveLength(childBefore + 1);
    expect(h.subscribes(child).at(-1)?.history).toBe('tail');
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2', 'l3'] }));
    expect(view(h)).toMatchObject({ status: 'ready', lines: ['l1', 'l2', 'l3'] });
  });

  it.skip('buffers live events during loading and applies those matching the established version', () => {
    const h = harness({ mode: 'expanded' });
    h.deliver(append(3, ['l3']));
    h.deliver(append(1, ['zz'], { version: v2 }));
    h.deliver(snapshot({ requestId: h.lastRequestId(), lines: ['l1', 'l2'] }));
    expect(view(h)).toMatchObject({ lines: ['l1', 'l2', 'l3'], status: 'ready' });
  });

  it.skip('discards only the transient buffer on event-count overflow and refetches', () => {
    const h = harness({ mode: 'expanded' });
    for (let index = 0; index <= MAX_PENDING_EVENTS; index++) h.deliver(append(index + 2, [`l${index + 2}`]));
    expect(h.diagnostics.map((event) => event.code)).toContain('resync-overflow');
    const request = h.lastRequestId();
    h.deliver(snapshot({ requestId: request, lines: ['l1'] }));
    expect(view(h).lines).toEqual(['l1']);
    expect(view(h).status).toBe('resynchronizing');
    expect(h.lastRequestId()).not.toBe(request);
  });

  it.skip('bounds buffered bytes per session', () => {
    const h = harness({ mode: 'expanded' });
    const large = 'x'.repeat(Math.ceil(MAX_PENDING_BYTES / 2));
    h.deliver(append(2, [large]));
    h.deliver(append(3, [large]));
    h.deliver(append(4, [large]));
    expect(h.diagnostics.map((event) => event.code)).toContain('resync-overflow');
  });

  it.skip('explicit retry resumes paused sources and asks the host to resynchronize membership', () => {
    const h = harness();
    h.deliver({ type: 'source:error', generation, requestId: h.lastRequestId(), source: main, error: 'load-error' });
    h.store.retry();
    expect(h.sent.at(-2)).toEqual({ type: 'session:resync', generation });
    expect(h.sent.at(-1)).toMatchObject({ type: 'source:subscribe', source: main });
    expect(view(h)).toMatchObject({ status: 'loading', error: null });
  });
});

describe('lifecycle', () => {
  it.skip('updates activity on ended without assuming deletion', () => {
    const h = ready(2);
    h.deliver({
      type: 'source:lifecycle',
      generation,
      source: main,
      version: v1,
      binding: mainBinding,
      state: 'ended',
      totalLineCount: 2
    });
    expect(view(h)).toMatchObject({ status: 'ready', lines: ['l1', 'l2'], meta: { isActive: false } });
    h.deliver({
      type: 'source:lifecycle',
      generation,
      source: main,
      version: v1,
      binding: mainBinding,
      state: 'resumed',
      totalLineCount: 2
    });
    expect(view(h).meta?.isActive).toBe(true);
  });

  it.skip('repairs a lifecycle-announced line count beyond local content', () => {
    const h = ready(2);
    const before = h.subscribes().length;
    h.deliver({
      type: 'source:lifecycle',
      generation,
      source: main,
      version: v1,
      binding: mainBinding,
      state: 'ended',
      totalLineCount: 4
    });
    expect(h.subscribes()).toHaveLength(before + 1);
    expect(view(h).status).toBe('resynchronizing');
  });
});

describe('theme, layout, actions, and disposal', () => {
  it.skip('applies validated theme changes', () => {
    const h = harness();
    h.deliver({ type: 'theme:change', generation, themeKind: 2, cssVariables: { '--vscode-foreground': '#fff' } });
    expect(h.themes).toEqual([{ themeKind: 2, cssVariables: { '--vscode-foreground': '#fff' } }]);
  });

  it.skip('stamps layout messages with the current handshake token and drops them before any handshake', () => {
    const h = harness();
    const before = h.sent.length;
    h.store.postLayout({ type: 'layout:ready' });
    expect(h.sent).toHaveLength(before);
    h.deliver({ type: 'layout:handshake', generation, token: 'load-1' });
    h.store.postLayout({ type: 'layout:ready' });
    h.store.postLayout({ type: 'layout:size', revision: 1, height: 240 });
    h.deliver({ type: 'layout:handshake', generation, token: 'load-2' });
    h.store.postLayout({ type: 'layout:scroll', command: { kind: 'delta', deltaY: 40 } });
    expect(h.sent.slice(before)).toEqual([
      { type: 'layout:ready', generation, token: 'load-1' },
      { type: 'layout:size', generation, token: 'load-1', revision: 1, height: 240 },
      { type: 'layout:scroll', generation, token: 'load-2', command: { kind: 'delta', deltaY: 40 } }
    ]);
  });

  it.skip('refuses to post invalid layout payloads', () => {
    const h = harness();
    h.deliver({ type: 'layout:handshake', generation, token: 'load-1' });
    const before = h.sent.length;
    h.store.postLayout({ type: 'layout:size', revision: 1, height: 100_001 });
    h.store.postLayout({ type: 'layout:scroll', command: { kind: 'delta', deltaY: Number.NaN } });
    expect(h.sent).toHaveLength(before);
  });

  it.skip('posts generation-correlated close, openFile, and showDiff actions', () => {
    const h = harness();
    h.store.close();
    h.store.openFile('src/a.ts', 3);
    h.store.showDiff('abc123');
    expect(h.sent.slice(-3)).toEqual([
      { type: 'close', generation },
      { type: 'openFile', generation, path: 'src/a.ts', line: 3 },
      { type: 'showDiff', generation, sha: 'abc123' }
    ]);
  });

  it.skip('ignores malformed host messages with an identifier-only diagnostic', () => {
    const h = ready(1);
    h.deliver({
      type: 'source:append',
      generation,
      source: main,
      version: v1,
      binding: mainBinding,
      firstLineNumber: 2,
      lines: ['x'],
      extra: 1
    });
    h.deliver('not an object');
    expect(view(h).lines).toEqual(['l1']);
    expect(h.diagnostics.filter((event) => event.code === 'rejected-message').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(h.diagnostics)).not.toContain('"x"');
  });

  it.skip('dispose removes the listener and suppresses all later traffic', () => {
    const h = ready(1);
    h.store.dispose();
    expect(h.listeners()).toBe(0);
    const before = h.sent.length;
    h.store.subscribeSource(child, 'full');
    h.store.close();
    expect(h.sent).toHaveLength(before);
  });

  it.skip('publishes immutable state snapshots per change', () => {
    const h = ready(1);
    const first = h.store.getState();
    h.deliver(append(2, ['l2']));
    expect(first.sources.get(key(main))?.lines).toEqual(['l1']);
    expect(h.store.getState()).not.toBe(first);
  });

  it.skip('keeps source metadata from the accepted snapshot', () => {
    const h = ready(2);
    expect(view(h).meta).toEqual(meta(main, mainBinding, 2));
    expect(childBinding.role).toBe('subagent');
  });
});

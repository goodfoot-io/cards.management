/**
 * Session source subscription checks against the real SDK store over an in-memory host.
 * @summary Coherent session snapshots, absolute coordinates and listener lifetime
 */
import { describe, expect, it } from 'vitest';
import {
  createSessionSourcesSubscription,
  nativeTranscriptSource,
  sourceGeneration
} from '../src/streams/lib/session/use-transcript-source';
import { createSessionHost } from './helpers/session-host';

const MAIN = 's1.jsonl';
const CHILD = 's1/subagents/agent-a.jsonl';

function host(mode: 'compact' | 'expanded' = 'expanded') {
  return createSessionHost({
    streamType: 'claude-code-session',
    runtime: 'claude-code',
    mode,
    members: [
      { relPath: CHILD, role: 'subagent', agentId: 'a' },
      { relPath: MAIN, role: 'main' }
    ]
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('session source subscription', () => {
  it('orders entries by descriptor membership and maps absolute coordinates', () => {
    const session = host();
    session.snapshot(MAIN, ['seven', 'eight'], { first: 7 });
    session.store.subscribeSource(session.ref(CHILD), 'tail');
    const adapter = createSessionSourcesSubscription(session.store);
    const snapshot = adapter.getSnapshot();
    expect(snapshot.entries.map((entry) => entry.key)).toEqual([session.key(CHILD), session.key(MAIN)]);
    const main = snapshot.byKey.get(session.key(MAIN))!;
    expect(main.source).toMatchObject({
      sourceKey: session.key(MAIN),
      lines: ['seven', 'eight'],
      headLineNumber: 7,
      filename: 's1.jsonl',
      isLoading: false,
      error: null
    });
    expect(main.source.meta?.lineCount).toBe(8);
    expect(main.view.earlierUnloaded).toBe(true);
    expect(snapshot.byKey.get(session.key(CHILD))!.source.isLoading).toBe(true);
    adapter.dispose();
  });

  it('scopes generation to the authoritative version, never to line count', () => {
    const session = host();
    const adapter = createSessionSourcesSubscription(session.store);
    const pending = adapter.getSnapshot().byKey.get(session.key(MAIN))!;
    expect(sourceGeneration(pending.view)).toBe('unversioned');
    session.snapshot(MAIN, ['one']);
    const loaded = adapter.getSnapshot().byKey.get(session.key(MAIN))!;
    session.append(MAIN, 2, ['two']);
    const appended = adapter.getSnapshot().byKey.get(session.key(MAIN))!;
    expect(appended.source.generation).toBe(loaded.source.generation);
    expect(appended.source.generation).toBe(JSON.stringify(['server-1', 'source-1']));
    expect(appended.source.lines).toEqual(['one', 'two']);
    adapter.dispose();
  });

  it('reuses unchanged entries and only re-reads sources whose view changed', () => {
    const session = host();
    session.snapshot(MAIN, ['one']);
    session.store.subscribeSource(session.ref(CHILD), 'tail');
    session.snapshot(CHILD, ['child']);
    const adapter = createSessionSourcesSubscription(session.store);
    const before = adapter.getSnapshot();
    expect(adapter.getSnapshot()).toBe(before);
    session.append(MAIN, 2, ['two']);
    const after = adapter.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.byKey.get(session.key(CHILD))).toBe(before.byKey.get(session.key(CHILD)));
    expect(after.byKey.get(session.key(MAIN))).not.toBe(before.byKey.get(session.key(MAIN)));
    adapter.dispose();
  });

  it('coalesces a burst of appends into one notification with the latest snapshot', async () => {
    const session = host();
    session.snapshot(MAIN, ['one']);
    const adapter = createSessionSourcesSubscription(session.store);
    let notifications = 0;
    adapter.subscribe(() => {
      notifications++;
    });
    session.append(MAIN, 2, ['two']);
    session.append(MAIN, 3, ['three']);
    session.append(MAIN, 4, ['four']);
    expect(notifications).toBe(0);
    await settle();
    expect(notifications).toBe(1);
    expect(adapter.getSnapshot().byKey.get(session.key(MAIN))!.source.lines).toEqual(['one', 'two', 'three', 'four']);
    adapter.dispose();
  });

  it('observes updates between the first read and subscription without a missed snapshot', () => {
    const session = host();
    const adapter = createSessionSourcesSubscription(session.store);
    const before = adapter.getSnapshot();
    session.snapshot(MAIN, ['one']);
    const cleanup = adapter.subscribe(() => undefined);
    expect(adapter.getSnapshot()).not.toBe(before);
    expect(adapter.getSnapshot().byKey.get(session.key(MAIN))!.source.lines).toEqual(['one']);
    cleanup();
    adapter.dispose();
  });

  it('reflects lifecycle activity in metadata without changing generation', () => {
    const session = host();
    session.snapshot(MAIN, ['one']);
    const adapter = createSessionSourcesSubscription(session.store);
    const live = adapter.getSnapshot().byKey.get(session.key(MAIN))!.source;
    session.lifecycle(MAIN, 'ended', 1);
    const ended = adapter.getSnapshot().byKey.get(session.key(MAIN))!.source;
    expect(live.meta?.isActive).toBe(true);
    expect(ended.meta?.isActive).toBe(false);
    expect(ended.generation).toBe(live.generation);
    adapter.dispose();
  });

  it('cancels pending notifications on cleanup, disposes idempotently and rejects late use', async () => {
    const session = host();
    const adapter = createSessionSourcesSubscription(session.store);
    let notifications = 0;
    const cleanup = adapter.subscribe(() => {
      notifications++;
    });
    adapter.subscribe(() => {
      notifications++;
    });
    session.snapshot(MAIN, ['one']);
    cleanup();
    adapter.dispose();
    adapter.dispose();
    await settle();
    expect(notifications).toBe(0);
    expect(() => adapter.subscribe(() => undefined)).toThrow(/disposed/i);
    expect(() => adapter.getSnapshot()).toThrow(/disposed/i);
  });

  it('names load failures by identifier text and never as content', () => {
    const session = host();
    const adapter = createSessionSourcesSubscription(session.store);
    const view = adapter.getSnapshot().byKey.get(session.key(MAIN))!.view;
    const source = nativeTranscriptSource(session.key(MAIN), { ...view, status: 'unavailable', error: 'not-found' });
    expect(source.error).toMatch(/not found/i);
    expect(source.lines).toEqual([]);
    adapter.dispose();
  });
});

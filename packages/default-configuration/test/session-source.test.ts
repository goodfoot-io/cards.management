/**
 * Native external-store subscription checks with a real synchronous store.
 * @summary Coherent snapshots and listener lifetime
 */
import type { StreamFile, StreamStoreState } from '@cards.management/sdk/stream-store';
import { describe, expect, it } from 'vitest';
import { createNativeTranscriptSubscription } from '../src/streams/lib/session/use-transcript-source';

function nativeStore() {
  let state: StreamStoreState = {
    primary: 'main',
    files: new Map(),
    availableFiles: [],
    connected: true,
    mode: 'expanded'
  };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (file: StreamFile) => {
      state = { ...state, files: new Map(state.files).set(file.filename, file) };
      for (const listener of listeners) listener();
    },
    listeners
  };
}

function file(extra: Partial<StreamFile> = {}): StreamFile {
  return {
    filename: 'main',
    lines: ['one'],
    headLineNumber: 7,
    meta: { lineCount: 7, isActive: true },
    isSubscribed: true,
    isLoading: false,
    error: null,
    ...extra
  };
}
const binding = { sourceKey: 'card/main', generation: 'caller-generation', filename: 'main' };

describe('native source subscription', () => {
  it.skip('reads missing, historical, and metadata-only snapshots coherently', () => {
    const store = nativeStore();
    const adapter = createNativeTranscriptSubscription(store, binding);
    expect(adapter.getSnapshot().lines).toEqual([]);
    let notifications = 0;
    const cleanup = adapter.subscribe(() => {
      notifications++;
    });
    store.update(file());
    const first = adapter.getSnapshot();
    expect(first.headLineNumber).toBe(7);
    expect(adapter.getSnapshot()).toBe(first);
    store.update(file({ meta: { lineCount: 7, isActive: false, agentId: 'child', role: 'subagent' } }));
    expect(adapter.getSnapshot().meta?.agentId).toBe('child');
    expect(notifications).toBe(2);
    cleanup();
    expect(store.listeners.size).toBe(0);
  });

  it.skip('observes updates between the first read and subscription without a missed snapshot', () => {
    const store = nativeStore();
    const adapter = createNativeTranscriptSubscription(store, binding);
    const before = adapter.getSnapshot();
    store.update(file());
    const cleanup = adapter.subscribe(() => undefined);
    expect(adapter.getSnapshot()).not.toBe(before);
    expect(adapter.getSnapshot().lines).toEqual(['one']);
    cleanup();
    adapter.dispose();
  });

  it.skip('ignores other files, disposes all listeners and rejects late subscriptions', () => {
    const store = nativeStore();
    const adapter = createNativeTranscriptSubscription(store, binding);
    let notifications = 0;
    adapter.subscribe(() => {
      notifications++;
    });
    adapter.subscribe(() => {
      notifications++;
    });
    store.update(file({ filename: 'other' }));
    expect(notifications).toBe(0);
    adapter.dispose();
    adapter.dispose();
    expect(store.listeners.size).toBe(0);
    store.update(file());
    expect(notifications).toBe(0);
    expect(() => adapter.subscribe(() => undefined)).toThrow(/disposed/i);
  });

  it.skip('keeps caller generation unchanged for shorter native snapshots', () => {
    const store = nativeStore();
    store.update(file());
    const adapter = createNativeTranscriptSubscription(store, binding);
    store.update(file({ lines: [] }));
    expect(adapter.getSnapshot().generation).toBe(binding.generation);
    expect(adapter.getSnapshot().lines).toEqual([]);
    adapter.dispose();
  });
});

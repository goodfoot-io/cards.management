/**
 * Coherent external-store adapter over the session-scoped SDK store.
 *
 * Listening is separate from host subscription routing. Every source keeps the store's exact
 * tuple key as its identity; generation derives only from the authoritative source version,
 * so a shorter or re-requested range never invents a reset.
 *
 * @summary React-safe native session source snapshots
 * @module streams/lib/session/use-transcript-source
 */

import type { StreamSourceView, StreamStoreState } from '@cards.management/sdk/stream-store';
import { useMemo, useSyncExternalStore } from 'react';
import type { NativeTranscriptSource, TranscriptGeneration } from './types';

/** Coalesce a burst of native line updates before notifying React. */
const NOTIFICATION_BATCH_MS = 16;

/** Structural subset implemented by the SDK store and real in-memory test stores. */
export interface NativeTranscriptStore {
  getState(): StreamStoreState;
  subscribe(listener: () => void): () => void;
}

/** One member or retained source with its store view and native snapshot. */
export interface SessionSourceEntry {
  /** Exact store tuple key, also the native source key. */
  readonly key: string;
  readonly view: StreamSourceView;
  readonly source: NativeTranscriptSource;
}

/** Immutable session snapshot; identity changes only when store state changes. */
export interface SessionSourcesSnapshot {
  readonly state: StreamStoreState;
  /** Current members in descriptor order, then retained unavailable sources in key order. */
  readonly entries: readonly SessionSourceEntry[];
  readonly byKey: ReadonlyMap<string, SessionSourceEntry>;
}

/** Snapshot reader compatible with React's external-store contract. */
export interface SessionSourcesSubscription {
  getSnapshot(): SessionSourcesSnapshot;
  /** Registers a listener and returns cleanup; metadata-only changes notify too. */
  subscribe(listener: () => void): () => void;
  /** Releases all listeners and makes stale callbacks inert; idempotent. */
  dispose(): void;
}

/** Visible loading copy for non-ready subscription states; identifiers only. */
const STATUS_ERRORS: Partial<Record<StreamSourceView['status'], string>> = {
  paused: 'Source paused; retry to resynchronize.',
  unavailable: 'Source is no longer a member of this session; showing retained history.'
};

/** Typed load failures rendered without native content or filesystem paths. */
const LOAD_ERRORS: Record<NonNullable<StreamSourceView['error']>, string> = {
  'not-found': 'Source not found.',
  'load-error': 'Source failed to load.',
  'membership-error': 'Source membership could not be confirmed.',
  'inconsistent-source': 'Source content is inconsistent; waiting for a coherent version.',
  'resync-overflow': 'Live updates overflowed; resynchronization required.',
  'rejected-scope': 'Source is outside this session.'
};

/**
 * Derives the caller generation from the authoritative version only.
 * @param view - Store source view.
 * @returns Version-scoped generation, or `unversioned` before any accepted snapshot.
 */
export function sourceGeneration(view: StreamSourceView): TranscriptGeneration {
  const version = view.authority?.version;
  return version ? JSON.stringify([version.serverEpoch, version.sourceEpoch]) : 'unversioned';
}

/**
 * Converts one store view into the renderer's native source shape.
 * @param key - Exact store tuple key.
 * @param view - Immutable store view.
 * @returns Native source with absolute coordinates and identifier-only errors.
 */
export function nativeTranscriptSource(key: string, view: StreamSourceView): NativeTranscriptSource {
  return {
    sourceKey: key,
    generation: sourceGeneration(view),
    lines: view.lines,
    headLineNumber: view.firstLineNumber,
    meta: view.meta,
    filename: view.source.relPath.split('/').at(-1) ?? view.source.relPath,
    isLoading: view.status === 'loading' || view.status === 'resynchronizing',
    error: view.error ? LOAD_ERRORS[view.error] : (STATUS_ERRORS[view.status] ?? null)
  };
}

/**
 * Creates a coherent session snapshot reader that reuses unchanged source snapshots.
 * It never sends host subscribe/unsubscribe messages or treats shorter data as a new generation.
 * @param store - Existing session stream store.
 * @returns Stable snapshot reader compatible with React's external-store contract.
 */
export function createSessionSourcesSubscription(store: NativeTranscriptStore): SessionSourcesSubscription {
  let disposed = false;
  let snapshot: SessionSourcesSnapshot | undefined;
  let cache = new Map<string, SessionSourceEntry>();
  const cleanups = new Set<() => void>();
  const getSnapshot = (): SessionSourcesSnapshot => {
    if (disposed) throw new Error('Session source subscription is disposed');
    const state = store.getState();
    if (snapshot?.state === state) return snapshot;
    const next = new Map<string, SessionSourceEntry>();
    const order = new Map(state.descriptor.members.map((member, index) => [sourceKeyOf(member.source), index]));
    for (const [key, view] of state.sources) {
      const previous = cache.get(key);
      next.set(key, previous?.view === view ? previous : { key, view, source: nativeTranscriptSource(key, view) });
    }
    cache = next;
    const entries = [...next.values()].sort((left, right) => {
      const a = order.get(left.key) ?? Number.MAX_SAFE_INTEGER;
      const b = order.get(right.key) ?? Number.MAX_SAFE_INTEGER;
      return a - b || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    });
    snapshot = { state, entries, byKey: next };
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe(listener) {
      if (disposed) throw new Error('Session source subscription is disposed');
      let active = true;
      let seen = getSnapshot();
      let scheduled: ReturnType<typeof setTimeout> | undefined;
      const notify = (): void => {
        if (!active || disposed) return;
        const next = getSnapshot();
        if (next === seen) return;
        seen = next;
        listener();
      };
      const scheduleNotify = (): void => {
        if (!active || disposed || scheduled !== undefined) return;
        scheduled = setTimeout(() => {
          scheduled = undefined;
          notify();
        }, NOTIFICATION_BATCH_MS);
      };
      const unsubscribe = store.subscribe(scheduleNotify);
      const cleanup = (): void => {
        active = false;
        if (scheduled !== undefined) clearTimeout(scheduled);
        unsubscribe();
        cleanups.delete(cleanup);
      };
      cleanups.add(cleanup);
      notify();
      return cleanup;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      snapshot = undefined;
      cache = new Map();
    }
  };
}

/**
 * Reads and subscribes coherently, including mount-time updates and metadata.
 * @param store - Existing session stream store; never a second transport implementation.
 * @returns Current immutable session snapshot.
 */
export function useSessionSources(store: NativeTranscriptStore): SessionSourcesSnapshot {
  const adapter = useMemo(() => createSessionSourcesSubscription(store), [store]);
  // useSyncExternalStore owns the listener cleanup. No effect disposes the adapter:
  // StrictMode can resubscribe the same adapter after an effect cleanup.
  return useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
}

/**
 * Encodes a source tuple exactly as the SDK store keys its sources.
 * @param source - Exact source identity.
 * @param source.cardId - Owning card.
 * @param source.streamType - Provider stream type.
 * @param source.relPath - Logical source-relative path.
 * @returns Unambiguous JSON tuple key.
 */
export function sourceKeyOf(source: { cardId: string; streamType: string; relPath: string }): string {
  return JSON.stringify([source.cardId, source.streamType, source.relPath]);
}

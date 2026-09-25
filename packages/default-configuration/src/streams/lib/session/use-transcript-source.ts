/**
 * Coherent external-store adapter over native SDK snapshots.
 *
 * Listening is separate from host subscription routing. The caller supplies source identity,
 * filename, and generation; this module has no reset detection or transport authority.
 *
 * @summary React-safe native transcript snapshot subscription
 * @module streams/lib/session/use-transcript-source
 */

import type { StreamStoreState } from '@cards.management/sdk/stream-store';
import { useMemo, useSyncExternalStore } from 'react';
import type { NativeTranscriptSource, TranscriptGeneration, TranscriptSourceKey } from './types';

/** Structural subset implemented by the SDK store and real in-memory test stores. */
export interface NativeTranscriptStore {
  getState(): StreamStoreState;
  subscribe(listener: () => void): () => void;
}

/** Immutable adapter binding; switching any field creates a new listener scope. */
export interface NativeTranscriptBinding {
  readonly sourceKey: TranscriptSourceKey;
  readonly generation: TranscriptGeneration;
  readonly filename: string;
}

/** Snapshot identity remains stable until the selected file or binding changes. */
export interface NativeTranscriptSubscription {
  getSnapshot(): NativeTranscriptSource;
  /** Registers a listener and returns cleanup; metadata-only changes notify too. */
  subscribe(listener: () => void): () => void;
  /** Releases all listeners and makes stale callbacks inert; idempotent. */
  dispose(): void;
}

/**
 * Creates a coherent snapshot reader with listener ownership isolated to one binding.
 * It never sends host subscribe/unsubscribe messages or treats shorter data as a new generation.
 * @param store - Existing native stream store.
 * @param binding - Caller-owned source, generation, and filename selection.
 * @returns Stable snapshot reader compatible with React's external-store contract.
 */
export function createNativeTranscriptSubscription(
  store: NativeTranscriptStore,
  binding: NativeTranscriptBinding
): NativeTranscriptSubscription {
  let disposed = false;
  let lastFile: StreamStoreState['files'] extends Map<string, infer File> ? File | undefined : never;
  let snapshot: NativeTranscriptSource | undefined;
  const cleanups = new Set<() => void>();
  const selection = { ...binding };
  const getSnapshot = (): NativeTranscriptSource => {
    if (disposed) throw new Error('Native transcript subscription is disposed');
    const file = store.getState().files.get(selection.filename);
    if (!snapshot || file !== lastFile) {
      lastFile = file;
      snapshot = {
        ...selection,
        lines: file?.lines ?? [],
        headLineNumber: file?.headLineNumber ?? 1,
        meta: file?.meta ?? null,
        isLoading: file?.isLoading ?? false,
        error: file?.error ?? null
      };
    }
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe(listener) {
      if (disposed) throw new Error('Native transcript subscription is disposed');
      let active = true;
      let seen = getSnapshot();
      const notify = (): void => {
        if (!active || disposed) return;
        const next = getSnapshot();
        if (next === seen) return;
        seen = next;
        listener();
      };
      const unsubscribe = store.subscribe(notify);
      const cleanup = (): void => {
        active = false;
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
      lastFile = undefined;
    }
  };
}

/**
 * Reads and subscribes coherently, including mount-time updates, source switches, and metadata.
 * @param store - Existing native stream store; never a second transport implementation.
 * @param binding - Caller-qualified selected source and explicit generation.
 * @returns Current immutable native source snapshot.
 */
export function useTranscriptSource(
  store: NativeTranscriptStore,
  binding: NativeTranscriptBinding
): NativeTranscriptSource {
  const { sourceKey, generation, filename } = binding;
  const adapter = useMemo(
    () => createNativeTranscriptSubscription(store, { sourceKey, generation, filename }),
    [store, sourceKey, generation, filename]
  );
  // useSyncExternalStore owns the listener cleanup. No effect disposes the adapter:
  // StrictMode can resubscribe the same adapter after an effect cleanup.
  return useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
}

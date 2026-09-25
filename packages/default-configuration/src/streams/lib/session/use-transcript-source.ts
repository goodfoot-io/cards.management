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
 * @throws Until the contract implementation is completed.
 * @returns Stable snapshot reader compatible with React's external-store contract.
 */
export function createNativeTranscriptSubscription(
  store: NativeTranscriptStore,
  binding: NativeTranscriptBinding
): NativeTranscriptSubscription {
  void store;
  void binding;
  throw new Error('Not Implemented');
}

/**
 * Reads and subscribes coherently, including mount-time updates, source switches, and metadata.
 * @param store - Existing native stream store; never a second transport implementation.
 * @param binding - Caller-qualified selected source and explicit generation.
 * @throws Until the contract implementation is completed.
 * @returns Current immutable native source snapshot.
 */
export function useTranscriptSource(
  store: NativeTranscriptStore,
  binding: NativeTranscriptBinding
): NativeTranscriptSource {
  void store;
  void binding;
  throw new Error('Not Implemented');
}

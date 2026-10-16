/**
 * Session-scoped renderer store with version-fenced native source merging.
 *
 * The store mirrors host-accepted membership and source content for exactly
 * one bound session. It merges snapshots and live appends only within the
 * authoritative source version and binding that established them, keeps
 * overlap/gap reconciliation on absolute line coordinates, and fences every
 * response by generation, request ID, and local reconciliation epoch.
 *
 * @summary Zustand vanilla store for session renderer state
 * @module stream-store/store
 */

import type { StreamInitData, StreamRendererStore, StreamStoreOptions } from './types.js';

declare global {
  interface Window {
    __STREAM_INIT__?: StreamInitData;
  }
}

/**
 * Creates a renderer store over injected transport, independent of DOM globals.
 * @param _options - Initialization, transport, and identity dependencies.
 * @returns A started store; the main source is auto-subscribed when present.
 * @throws Error when initialization is malformed.
 */
export function createStreamStore(_options: StreamStoreOptions): StreamRendererStore {
  throw new Error('Not Implemented');
}

/**
 * Returns the iframe's singleton store bound to `window.__STREAM_INIT__` and `window.parent`.
 * @returns The memoized window store.
 * @throws Error when the host did not provide valid initialization.
 */
export function getWindowStreamStore(): StreamRendererStore {
  throw new Error('Not Implemented');
}

/**
 * React access to the one session-scoped renderer store owned by the iframe entry point.
 *
 * Components never import a store singleton: the entry point binds the window store once and
 * tests supply a real in-process store, so both run the same SDK state machine.
 *
 * @summary Session stream store provider and selector hooks
 * @module streams/lib/session/store-context
 */

import type { StreamRendererStore, StreamStoreState } from '@cards.management/sdk/stream-store';
import { createContext, type ReactElement, type ReactNode, useCallback, useContext, useSyncExternalStore } from 'react';

const StreamStoreContext = createContext<StreamRendererStore | null>(null);

/**
 * Supplies the session store to every renderer component.
 * @param root0 - Provider props.
 * @param root0.store - Session-scoped SDK store.
 * @param root0.children - Renderer tree.
 * @returns The provided subtree.
 */
export function StreamStoreProvider({
  store,
  children
}: {
  store: StreamRendererStore;
  children?: ReactNode;
}): ReactElement {
  return <StreamStoreContext.Provider value={store}>{children}</StreamStoreContext.Provider>;
}

/**
 * Reads the provided store; rendering outside a provider is a wiring defect.
 * @returns The session-scoped store.
 * @throws {Error} When rendered outside a StreamStoreProvider.
 */
export function useRendererStore(): StreamRendererStore {
  const store = useContext(StreamStoreContext);
  if (!store) throw new Error('Session renderer requires a StreamStoreProvider');
  return store;
}

/**
 * Subscribes to one slice of the store; the selector must return stable references.
 * @param selector - Pure slice selector.
 * @returns The current slice.
 */
export function useStreamState<T>(selector: (state: StreamStoreState) => T): T {
  const store = useRendererStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const read = (): T => selector(store.getState());
  return useSyncExternalStore(subscribe, read, read);
}

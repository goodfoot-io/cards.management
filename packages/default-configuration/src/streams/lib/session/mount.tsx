/**
 * Iframe entry wiring shared by every session renderer.
 *
 * Binds the window's session-scoped store once, mirrors the host-selected mode onto
 * `body.mode-*` for mode-specific document styles, and mounts the consolidated renderer.
 *
 * @summary Session renderer iframe entry point
 * @module streams/lib/session/mount
 */

import { getWindowStreamStore } from '@cards.management/sdk/stream-store';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionProviderAdapter } from './adapter';
import { SessionRenderer } from './SessionRenderer';
import { StreamStoreProvider } from './store-context';

/**
 * Mounts one provider's session renderer into `#stream-root`.
 * @param adapter - Provider seam.
 * @throws {Error} When the document has no `#stream-root`.
 */
export function mountSessionRenderer<Payloads extends object>(adapter: SessionProviderAdapter<Payloads>): void {
  const store = getWindowStreamStore();
  const apply = (mode: string): void => {
    document.body.className = `mode-${mode}`;
  };
  apply(store.getState().mode);
  store.subscribe((state, previous) => {
    if (state.mode !== previous.mode) apply(state.mode);
  });
  const root = document.getElementById('stream-root');
  if (!root) throw new Error('Session renderer requires #stream-root');
  createRoot(root).render(
    <StrictMode>
      <StreamStoreProvider store={store}>
        <SessionRenderer adapter={adapter} />
      </StreamStoreProvider>
    </StrictMode>
  );
}

// @vitest-environment jsdom

/**
 * Window binding of the session store: init, parent posting, and source checks.
 * @summary Window stream store binding tests
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StreamInitData } from '../../src/stream-store/types.js';
import { descriptor, generation, main, mainMember, session, snapshot } from './fixtures.js';

const init: StreamInitData = { session, generation, descriptor: descriptor(mainMember), revision: 1, mode: 'compact' };
let post: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  window.__STREAM_INIT__ = init;
  post = vi.spyOn(window, 'postMessage');
});

afterAll(() => {
  post.mockRestore();
});

describe('getWindowStreamStore', () => {
  it.skip('memoizes one store bound to __STREAM_INIT__ and posts the main subscription to the parent', async () => {
    const { getWindowStreamStore } = await import('../../src/stream-store/store.js');
    const store = getWindowStreamStore();
    expect(getWindowStreamStore()).toBe(store);
    expect(store.getState().session).toEqual(session);
    expect(post).toHaveBeenCalledWith(
      { type: 'source:subscribe', generation, requestId: expect.any(String), source: main, history: 'tail' },
      '*'
    );
  });

  it.skip('applies messages only from the parent window', async () => {
    const { getWindowStreamStore } = await import('../../src/stream-store/store.js');
    const store = getWindowStreamStore();
    const requestId = store
      .getState()
      .sources.get(JSON.stringify([main.cardId, main.streamType, main.relPath]))?.requestId;
    if (!requestId) throw new Error('main not subscribed');
    const data = snapshot({ requestId, lines: ['a'] });
    window.dispatchEvent(new MessageEvent('message', { data, source: null }));
    expect(store.getState().sources.get(JSON.stringify([main.cardId, main.streamType, main.relPath]))?.lines).toEqual(
      []
    );
    window.dispatchEvent(new MessageEvent('message', { data, source: window.parent }));
    expect(store.getState().sources.get(JSON.stringify([main.cardId, main.streamType, main.relPath]))?.lines).toEqual([
      'a'
    ]);
  });

  it.skip('applies theme changes to the document root', async () => {
    const { getWindowStreamStore } = await import('../../src/stream-store/store.js');
    getWindowStreamStore();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'theme:change', generation, themeKind: 1, cssVariables: { '--vscode-foreground': 'red' } },
        source: window.parent
      })
    );
    expect(document.documentElement.getAttribute('data-vscode-theme-kind')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--vscode-foreground')).toBe('red');
  });
});

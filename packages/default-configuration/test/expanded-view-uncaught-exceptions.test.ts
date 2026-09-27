// @vitest-environment jsdom

/**
 * Reproduction for the uncaught exceptions that expanded-view-bootstrap-race.test.ts
 * intermittently leaks.
 *
 * Mounting ExpandedView starts viewport auto-follow, which schedules a
 * requestAnimationFrame callback that calls `div.scrollTo(...)` on the viewport
 * element. jsdom does not implement Element#scrollTo, so when the
 * frame fires the callback throws `TypeError: div.scrollTo is not a function` —
 * outside any test assertion, surfacing only as a vitest "Unhandled Error" while
 * the test itself still passes. Whether the frame fires before the worker tears
 * down is a timing race, which is why the existing test only leaks intermittently
 * (and why a second, narrower race — a React scheduler tick touching `window`
 * after jsdom teardown — has also been observed).
 *
 * This test forces the race deterministically: it mounts the view exactly like
 * the bootstrap-race test, then keeps the jsdom window alive long enough for the
 * animation-frame timer to fire, capturing every uncaught exception and window
 * error raised in that span. It MUST FAIL against the unfixed environment.
 *
 * @summary Reproduction: ExpandedView mount leaks uncaught exceptions from async callbacks
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// React requires this flag to flush effects synchronously under act() outside a
// browser test runner (jsdom).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; MessageScroller observes viewport content size,
// so a real DOM mount needs a stub or the mount throws before any assertion runs.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

// jsdom's Element does not implement scrollTo; viewport auto-follow calls
// viewport.scrollTo(...) from a requestAnimationFrame callback, which is exactly the uncaught TypeError this
// test guards against. jsdom performs no layout, so a no-op matches the
// environment's semantics.
Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;

// Own the animation-frame queue so the lifecycle under test does not depend on
// jsdom's timer-backed rAF shim or machine load.
let nextAnimationFrameId = 1;
const animationFrames = new Map<number, FrameRequestCallback>();
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
  const id = nextAnimationFrameId++;
  animationFrames.set(id, callback);
  return id;
});
vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
  animationFrames.delete(id);
});

/** Flushes the next animation frame scheduled by the mounted view. */
function flushNextAnimationFrame(): void {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  for (const callback of callbacks) callback(performance.now());
}

// Hoisted so the mock factory can reference these identifiers.
const { mockGetState, mockSubscribe } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockSubscribe: vi.fn()
}));

/** A valid assistant JSONL line that parseLines converts to a SessionMsg. */
const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Hello from assistant.' }] }
});

/**
 * Store state with a populated primary file so the transcript renders content
 * and the auto-scroll effect has a scroll target to act on.
 * @returns A store state whose primary file contains three assistant lines.
 */
function populatedStoreState() {
  return {
    primary: 'session.jsonl',
    files: new Map([
      [
        'session.jsonl',
        {
          filename: 'session.jsonl',
          meta: { lineCount: 3, isActive: false },
          lines: [ASSISTANT_LINE, ASSISTANT_LINE, ASSISTANT_LINE],
          isSubscribed: true,
          isLoading: false,
          error: null
        }
      ]
    ]),
    availableFiles: ['session.jsonl'],
    connected: true,
    mode: 'expanded' as const
  };
}

vi.mock('@cards.management/sdk/stream-store', () => ({
  streamStore: {
    getState: mockGetState,
    subscribe: mockSubscribe.mockImplementation(() => () => {})
  },
  close: vi.fn()
}));

describe('ExpandedView async callbacks', () => {
  it('raises no uncaught exceptions when animation frames fire after mount', async () => {
    const captured: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      captured.push(error);
    };
    const onWindowError = (event: ErrorEvent): void => {
      captured.push(event.error ?? event.message);
      event.preventDefault();
    };
    // The auto-scroll callback throws from inside a jsdom timer, so it reaches
    // Node as a process-level uncaught exception rather than a test failure —
    // capture it there, and on the window for errors jsdom reports itself.
    process.prependListener('uncaughtException', onUncaught);
    window.addEventListener('error', onWindowError);

    try {
      mockGetState.mockReturnValue(populatedStoreState());

      // Dynamic import so vi.mock is in place before the component module loads.
      const { ExpandedView } = await import(
        '../src/streams/claude-code-session/www/components/expanded/ExpandedView.js'
      );

      const container = document.createElement('div');
      const root = createRoot(container);

      await act(async () => {
        root.render(React.createElement(ExpandedView));
      });

      // Fire every frame requested during mount without waiting for wall-clock
      // timers. This exercises the callback while the environment is alive.
      await act(async () => {
        flushNextAnimationFrame();
      });

      await act(async () => {
        root.unmount();
      });
      expect(animationFrames.size).toBe(0);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      window.removeEventListener('error', onWindowError);
    }

    expect(captured).toEqual([]);
  }, 120_000);
});

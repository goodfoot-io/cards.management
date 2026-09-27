// @vitest-environment jsdom

/**
 * Regression test for ExpandedView bootstrap race that drops transcript lines.
 *
 * ExpandedView's useState initializer reads streamStore.getState() to build
 * its initial message array. The mount effect advances a watermark ref
 * (lastLineCountRef) to the current line count, but never re-parses lines
 * into messages. The subscribe effect only registers a listener — it does not
 * synchronously invoke it with the current state (unlike CompactView and
 * CodexExpandedView, which both call sync() before subscribing).
 *
 * When the store's subscribe:response lands between the initial render and
 * the mount effect, the watermark is advanced past lines that were never
 * parsed into messages. For an already-ended session with no further lines,
 * the subscribe listener never fires a delta, so the dropped lines never
 * reach the rendered transcript. The transcript incorrectly renders its
 * empty placeholder ("No output yet.") despite the store having lines.
 *
 * This test asserts the CORRECT behavior (transcript renders the lines),
 * so it MUST FAIL against the unfixed code.
 *
 * @summary Minimal reproduction: ExpandedView bootstrap race drops lines
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// React requires this flag to flush effects synchronously under act() outside a
// browser test runner (jsdom).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; MessageScroller observes viewport content size,
// so a real DOM mount needs a stub or it throws before any assertion runs.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

// jsdom's Element does not implement scrollTo; viewport auto-follow schedules
// it from a requestAnimationFrame callback. jsdom performs no layout, so a
// no-op matches the environment's semantics.
Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;

// Own the animation-frame queue so viewport auto-follow is driven explicitly
// instead of racing jsdom's timer-backed rAF shim.
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

// Hoisted so the mock factory can reference these identifiers.  Without
// vi.hoisted the references would be out of scope when vi.mock is hoisted.
const { mockGetState, mockSubscribe } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockSubscribe: vi.fn()
}));

// ---- Store state fixtures ----

/** A valid assistant JSONL line that parseLines converts to a SessionMsg. */
const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Hello from assistant.' }] }
});

/**
 * Builds a StreamFile-like entry for the files Map.
 * @param overrides - Optional overrides.
 * @param overrides.lineCount - Optional line count for the file metadata.
 * @param overrides.lines - Optional lines array for the file.
 * @param overrides.isSubscribed - Optional subscription flag.
 * @returns A file entry compatible with the store's files Map shape.
 */
function makeFileEntry(overrides: { lineCount?: number; lines?: string[]; isSubscribed?: boolean } = {}): {
  filename: string;
  meta: { lineCount: number; isActive: boolean };
  lines: string[];
  isSubscribed: boolean;
  isLoading: boolean;
  error: string | null;
} {
  return {
    filename: 'session.jsonl',
    meta: { lineCount: overrides.lineCount ?? 0, isActive: false },
    lines: overrides.lines ?? [],
    isSubscribed: overrides.isSubscribed ?? false,
    isLoading: false,
    error: null
  };
}

/**
 * Store state the useState initializer sees: primary file has zero lines.
 * @returns A store state with an empty primary file.
 */
function emptyStoreState() {
  return {
    primary: 'session.jsonl',
    files: new Map([['session.jsonl', makeFileEntry()]]),
    availableFiles: ['session.jsonl'],
    connected: true,
    mode: 'expanded' as const
  };
}

/**
 * Store state the mount effect sees: 3 lines arrived in the window.
 * @returns A store state with a populated primary file containing 3 assistant lines.
 */
function populatedStoreState() {
  return {
    primary: 'session.jsonl',
    files: new Map([
      [
        'session.jsonl',
        makeFileEntry({
          lineCount: 3,
          lines: [ASSISTANT_LINE, ASSISTANT_LINE, ASSISTANT_LINE],
          isSubscribed: true
        })
      ]
    ]),
    availableFiles: ['session.jsonl'],
    connected: true,
    mode: 'expanded' as const
  };
}

// ---- Mock stream-store ----

vi.mock('@cards.management/sdk/stream-store', () => ({
  streamStore: {
    getState: mockGetState,
    subscribe: mockSubscribe.mockImplementation(() => () => {})
  },
  close: vi.fn()
}));

// ---- Tests ----

describe('ExpandedView bootstrap race — subscribe:response window', () => {
  it('renders transcript lines when subscribe:response lands between useState init and mount effect', async () => {
    // Reproduce the race: the useState initializer reads an empty store (0
    // lines), but by the time the mount effect fires the store has been
    // populated with 3 lines from the subscribe:response.
    mockGetState.mockReturnValueOnce(emptyStoreState()).mockReturnValue(populatedStoreState());

    // Dynamic import so vi.mock is in place before the component module loads.
    const { ExpandedView } = await import('../src/streams/claude-code-session/www/components/expanded/ExpandedView.js');

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ExpandedView));
    });

    // Correct behavior (fails against unfixed code): the mount effect or
    // subscribe effect must synchronously reconcile against the current store
    // state, so lines that arrived between the useState init and the effect
    // are parsed into messages and rendered. The empty placeholder must not
    // appear when the store actually has lines.
    expect(container.textContent).not.toContain('No output yet.');
    expect(container.textContent).toContain('Hello from assistant.');

    // Drive auto-scroll deterministically while the view is mounted, then
    // unmount so effect cleanups cancel any subsequently scheduled frame.
    await act(async () => {
      flushNextAnimationFrame();
    });
    await act(async () => {
      root.unmount();
    });
    expect(animationFrames.size).toBe(0);
  }, 120_000);
});

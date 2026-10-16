/**
 * Renderer view state that survives iframe rebuilds: disclosure choices, sources the reader
 * asked to load in full, and card-detail windows. The host stores it opaquely per session and
 * replays it through initialization, so it is encoded within the SDK's validated bounds and in
 * absolute native coordinates that remain meaningful in a fresh document.
 *
 * @summary Encoding, decoding and reporting of persisted renderer view state
 * @module streams/lib/session/view-state
 */

import {
  MAX_VIEW_STATE_ENTRIES,
  MAX_VIEW_STATE_KEY_LENGTH,
  type StreamRendererStore,
  type StreamViewState,
  validateViewState
} from '@cards.management/sdk/stream-store';
import { useEffect, useRef } from 'react';

/** Card-detail window of one section in absolute native coordinates; null start previews the live end. */
export interface SectionWindow {
  /** First native line of the first mounted row, or null for a live-end preview. */
  readonly startLine: number | null;
  readonly count: number;
}

/** Decoded view state ready for rehydration. */
export interface RestoredViewState {
  readonly open: ReadonlyMap<string, boolean>;
  /** Source keys the reader asked to load with full history. */
  readonly full: ReadonlySet<string>;
  readonly windows: ReadonlyMap<string, SectionWindow>;
}

/** Live view state to report. */
export interface ViewStateInput {
  readonly open: ReadonlyMap<string, boolean>;
  readonly full: ReadonlySet<string>;
  readonly windows: ReadonlyMap<string, SectionWindow>;
}

/** Delay coalescing bursts of disclosure and paging changes into one report. */
const REPORT_DELAY_MS = 250;

const historyKey = (sourceKey: string): string => JSON.stringify(['history', sourceKey]);
const windowKey = (sourceKey: string): string => JSON.stringify(['window', sourceKey]);

/**
 * Whether a key fits the SDK's printable, bounded key contract.
 * @param key - Candidate key.
 * @returns True when the host would accept it.
 */
function acceptable(key: string): boolean {
  if (key.length === 0 || key.length > MAX_VIEW_STATE_KEY_LENGTH) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/**
 * Encodes live view state within the SDK bounds; the most recent disclosure choices win.
 * @param input - Live view state.
 * @returns Valid view state.
 */
export function encodeViewState(input: ViewStateInput): StreamViewState {
  const open = [...input.open].filter(([key]) => acceptable(key)).slice(-MAX_VIEW_STATE_ENTRIES);
  const ranges: StreamViewState['ranges'] = [];
  for (const key of input.full) {
    const encoded = historyKey(key);
    if (acceptable(encoded)) ranges.push([encoded, { first: 1, count: 1 }]);
  }
  for (const [key, window] of input.windows) {
    const encoded = windowKey(key);
    if (window.startLine === null || !acceptable(encoded)) continue;
    ranges.push([encoded, { first: window.startLine, count: window.count }]);
  }
  return { open, ranges: ranges.slice(0, MAX_VIEW_STATE_ENTRIES) };
}

/**
 * Decodes host-replayed view state, ignoring keys this renderer did not write.
 * @param state - Restored state from initialization, if any.
 * @returns Rehydration input.
 */
export function decodeViewState(state: StreamViewState | null): RestoredViewState {
  const open = new Map<string, boolean>(state?.open ?? []);
  const full = new Set<string>();
  const windows = new Map<string, SectionWindow>();
  for (const [key, range] of state?.ranges ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string') continue;
    if (parsed[0] === 'history') full.add(parsed[1]);
    if (parsed[0] === 'window') windows.set(parsed[1], { startLine: range.first, count: range.count });
  }
  return { open, full, windows };
}

/**
 * Reports view state to the host after it settles, skipping unchanged and invalid states.
 * @param store - Session store.
 * @param input - Live view state; reported whenever its encoding changes.
 */
export function useViewStateReporting(store: StreamRendererStore, input: ViewStateInput): void {
  const last = useRef<string | null>(null);
  const scheduled = useRef<{ signature: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const state = encodeViewState(input);
    const signature = JSON.stringify(state);
    // Unrelated rerenders (live appends) neither resend nor postpone an already scheduled report.
    if (signature === scheduled.current?.signature) return;
    if (scheduled.current) clearTimeout(scheduled.current.timer);
    scheduled.current = null;
    if (signature === last.current) return;
    const timer = setTimeout(() => {
      scheduled.current = null;
      // Fail closed: a state the host would reject is never sent.
      if (!validateViewState(state).ok) return;
      last.current = signature;
      store.postViewState(state);
    }, REPORT_DELAY_MS);
    scheduled.current = { signature, timer };
  }, [store, input]);
  useEffect(
    () => () => {
      if (scheduled.current) clearTimeout(scheduled.current.timer);
      scheduled.current = null;
    },
    []
  );
}

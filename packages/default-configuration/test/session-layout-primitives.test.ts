// @vitest-environment jsdom
/**
 * Pure session renderer primitives: bounded view-state encoding, absolute-coordinate folding,
 * and the outer-scroll command mapping of the card-detail layout bridge.
 * @summary Session view state, absolute fold and layout command contracts
 */
import { MAX_SCROLL_DELTA, MAX_VIEW_STATE_KEY_LENGTH, validateViewState } from '@cards.management/sdk/stream-store';
import { describe, expect, it } from 'vitest';
import { anchorKey, keyCommand, wheelCommand } from '../src/streams/lib/session/layout-bridge';
import type { NativeTranscriptSource } from '../src/streams/lib/session/types';
import { foldAbsolute } from '../src/streams/lib/session/use-absolute-fold';
import { decodeViewState, encodeViewState } from '../src/streams/lib/session/view-state';

describe('view state encoding', () => {
  const key = JSON.stringify(['card-1', 'claude-code-session', 'main.jsonl']);

  it('round-trips disclosures, full-history requests and paged windows', () => {
    const encoded = encodeViewState({
      open: new Map([['["tool","T1"]', true]]),
      full: new Set([key]),
      windows: new Map([
        [key, { startLine: 40, count: 100 }],
        ['preview', { startLine: null, count: 8 }]
      ])
    });
    expect(validateViewState(encoded).ok).toBe(true);
    const decoded = decodeViewState(encoded);
    expect([...decoded.open]).toEqual([['["tool","T1"]', true]]);
    expect([...decoded.full]).toEqual([key]);
    // A live-end preview is the default and is never persisted.
    expect([...decoded.windows]).toEqual([[key, { startLine: 40, count: 100 }]]);
  });

  it('drops keys the host would reject instead of sending invalid state', () => {
    const encoded = encodeViewState({
      open: new Map([
        ['x'.repeat(MAX_VIEW_STATE_KEY_LENGTH + 1), true],
        ['bad\nkey', true],
        ['kept', false]
      ]),
      full: new Set(['y'.repeat(MAX_VIEW_STATE_KEY_LENGTH)]),
      windows: new Map()
    });
    expect(encoded).toEqual({ open: [['kept', false]], ranges: [] });
    expect(validateViewState(encoded).ok).toBe(true);
  });

  it('ignores replayed ranges this renderer did not write', () => {
    const decoded = decodeViewState({
      open: [],
      ranges: [
        ['not json', { first: 1, count: 1 }],
        [JSON.stringify(['other', key]), { first: 1, count: 1 }]
      ]
    });
    expect(decoded.full.size + decoded.windows.size).toBe(0);
    expect(decodeViewState(null).open.size).toBe(0);
  });
});

describe('absolute fold', () => {
  interface Fold {
    readonly lineCount: number;
    readonly seen: readonly string[];
  }
  const build = (lines: string[]): Fold => ({ lineCount: lines.length, seen: [...lines] });
  const reconcile = (prev: Fold, lines: string[]): Fold => ({
    lineCount: lines.length,
    seen: [...prev.seen, ...lines.slice(prev.lineCount)]
  });
  const source = (head: number, lines: string[], generation = 'g1'): NativeTranscriptSource => ({
    sourceKey: 'k',
    generation,
    lines,
    headLineNumber: head,
    meta: null,
    filename: 'k.jsonl',
    isLoading: false,
    error: null
  });

  it('folds only new records while a trimmed tail slides forward', () => {
    let cache = foldAbsolute(null, source(10, ['a', 'b', 'c']), build, reconcile);
    cache = foldAbsolute(cache, source(11, ['b', 'c', 'd']), build, reconcile);
    cache = foldAbsolute(cache, source(12, ['c', 'd', 'e']), build, reconcile);
    expect(cache.folded.seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('rebuilds on a gap, earlier history or a new incarnation', () => {
    const base = foldAbsolute(null, source(10, ['a', 'b']), build, reconcile);
    expect(foldAbsolute(base, source(20, ['x']), build, reconcile).folded.seen).toEqual(['x']);
    expect(foldAbsolute(base, source(1, ['p', 'q']), build, reconcile).folded.seen).toEqual(['p', 'q']);
    expect(foldAbsolute(base, source(10, ['n']), build, reconcile).folded.seen).toEqual(['a', 'b']);
    expect(foldAbsolute(base, source(10, ['n'], 'g2'), build, reconcile).folded.seen).toEqual(['n']);
  });
});

describe('layout scroll commands', () => {
  const key = (name: string, extra: Partial<Parameters<typeof keyCommand>[0]> = {}) =>
    keyCommand({ key: name, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: null, ...extra });

  it('bounds wheel deltas and maps line and page modes', () => {
    expect(wheelCommand({ deltaY: 0, deltaMode: 0 })).toBeNull();
    expect(wheelCommand({ deltaY: 30, deltaMode: 0 })).toEqual({ kind: 'delta', deltaY: 30 });
    expect(wheelCommand({ deltaY: 3, deltaMode: 1 })).toEqual({ kind: 'delta', deltaY: 48 });
    expect(wheelCommand({ deltaY: -1, deltaMode: 2 })).toEqual({ kind: 'key', key: 'page-up' });
    expect(wheelCommand({ deltaY: 1e9, deltaMode: 0 })).toEqual({ kind: 'delta', deltaY: MAX_SCROLL_DELTA });
    expect(wheelCommand({ deltaY: Number.NaN, deltaMode: 0 })).toBeNull();
  });

  it('forwards scroll keys but leaves selection, modifiers and controls their native keys', () => {
    expect(key('PageDown')).toEqual({ kind: 'key', key: 'page-down' });
    expect(key(' ', { shiftKey: true })).toEqual({ kind: 'key', key: 'page-up' });
    expect(key('End')).toEqual({ kind: 'key', key: 'end' });
    expect(key('ArrowDown', { shiftKey: true })).toBeNull();
    expect(key('Home', { ctrlKey: true })).toBeNull();
    expect(key('a')).toBeNull();
    const button = document.createElement('button');
    expect(key('PageDown', { target: button })).toBeNull();
  });

  it('derives short, control-free, deterministic anchor keys', () => {
    const id = JSON.stringify(['session-member', 'x\n'.repeat(2000)]);
    expect(anchorKey(id)).toBe(anchorKey(id));
    expect(anchorKey(id)).toMatch(/^leaf-[0-9a-f]{8}-\d+$/);
    expect(anchorKey('a')).not.toBe(anchorKey('b'));
  });
});

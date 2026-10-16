/**
 * Exact-shape bridge validators in both directions, including numeric bounds.
 * @summary Session bridge validator tests
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_APPEND_LINES,
  MAX_LAYOUT_HEIGHT,
  MAX_SCROLL_DELTA,
  MAX_TOKEN_LENGTH
} from '../../src/stream-store/types.js';
import { validateHostMessage, validateRendererMessage } from '../../src/stream-store/validate.js';
import {
  append,
  childMember,
  descriptor,
  generation,
  main,
  mainBinding,
  mainMember,
  snapshot,
  v1
} from './fixtures.js';

const hostValid: unknown[] = [
  { type: 'session:update', generation, revision: 2, descriptor: descriptor(mainMember, childMember) },
  { type: 'session:update', generation, revision: 2, descriptor: descriptor() },
  snapshot({ requestId: 'r1', lines: ['a', 'b'] }),
  snapshot({ requestId: 'r1', first: 1, lines: [] }),
  snapshot({ requestId: 'r1', first: 40, lines: ['x'] }),
  { type: 'source:error', generation, requestId: 'r1', source: main, error: 'not-found' },
  append(3, ['c']),
  {
    type: 'source:lifecycle',
    generation,
    source: main,
    version: v1,
    binding: mainBinding,
    state: 'ended',
    totalLineCount: 0
  },
  { type: 'source:invalidated', generation, source: main, version: v1, binding: mainBinding, reason: 'removed' },
  { type: 'connection:state', generation, state: 'resynchronizing' },
  { type: 'theme:change', generation, themeKind: 3, cssVariables: { '--a': 'b' } },
  { type: 'layout:handshake', generation, token: 'load-1' }
];

const rendererValid: unknown[] = [
  { type: 'source:subscribe', generation, requestId: 'r1', source: main, history: 'tail' },
  { type: 'source:unsubscribe', generation, source: main },
  { type: 'session:resync', generation },
  { type: 'close', generation },
  { type: 'openFile', generation, path: 'src/a.ts' },
  { type: 'openFile', generation, path: 'src/a.ts', line: 1 },
  { type: 'showDiff', generation, sha: 'abc' },
  { type: 'showDiff', generation, sha: 'abc', filePath: 'a.ts' },
  { type: 'layout:ready', generation, token: 't' },
  { type: 'layout:size', generation, token: 't', revision: 1, height: 1 },
  { type: 'layout:size', generation, token: 't', revision: 9, height: MAX_LAYOUT_HEIGHT },
  { type: 'layout:scroll', generation, token: 't', command: { kind: 'delta', deltaY: -MAX_SCROLL_DELTA } },
  { type: 'layout:scroll', generation, token: 't', command: { kind: 'key', key: 'page-down' } }
];

describe('validateHostMessage', () => {
  it.skip('accepts every well-formed host message and returns an equal value', () => {
    for (const message of hostValid) expect(validateHostMessage(message)).toEqual({ ok: true, message });
  });

  it.skip('rejects unknown fields at every nesting level', () => {
    for (const message of hostValid) {
      expect(validateHostMessage({ ...(message as object), extra: true }).ok).toBe(false);
    }
    const snap = snapshot({ requestId: 'r1', lines: ['a'] });
    expect(validateHostMessage({ ...snap, source: { ...snap.source, extra: 1 } }).ok).toBe(false);
    expect(validateHostMessage({ ...snap, version: { ...snap.version, extra: 1 } }).ok).toBe(false);
    expect(validateHostMessage({ ...snap, binding: { ...snap.binding, extra: 1 } }).ok).toBe(false);
    expect(validateHostMessage({ ...snap, meta: { ...snap.meta, extra: 1 } }).ok).toBe(false);
  });

  it.skip('rejects non-objects, arrays, and unknown types including the removed claim message', () => {
    for (const value of [null, undefined, 1, 'x', [], { type: 'stream:line' }, { type: 'claim', filenames: [] }]) {
      expect(validateHostMessage(value).ok).toBe(false);
    }
  });

  it.skip('rejects incoherent snapshot coordinates and metadata', () => {
    const snap = snapshot({ requestId: 'r1', lines: ['a', 'b'] });
    const bad = [
      { ...snap, totalLineCount: 3 },
      { ...snap, firstLineNumber: 0 },
      { ...snap, firstLineNumber: 1.5 },
      { ...snap, lines: ['a\nb', 'c'] },
      { ...snap, lines: ['a', 2] },
      { ...snap, meta: { ...snap.meta, lineCount: 9 } },
      { ...snap, meta: { ...snap.meta, relPath: 'other.jsonl' } },
      { ...snap, meta: { ...snap.meta, sessionId: 's2' } },
      { ...snap, meta: { ...snap.meta, role: 'subagent' } }
    ];
    for (const message of bad) expect(validateHostMessage(message).ok).toBe(false);
  });

  it.skip('bounds append batches and coordinates', () => {
    expect(validateHostMessage(append(1, [])).ok).toBe(false);
    expect(
      validateHostMessage(
        append(
          1,
          Array.from({ length: MAX_APPEND_LINES + 1 }, () => 'x')
        )
      ).ok
    ).toBe(false);
    expect(
      validateHostMessage(
        append(
          1,
          Array.from({ length: MAX_APPEND_LINES }, () => 'x')
        )
      ).ok
    ).toBe(true);
    expect(validateHostMessage(append(0, ['x'])).ok).toBe(false);
    expect(validateHostMessage(append(Number.MAX_SAFE_INTEGER, ['x', 'y'])).ok).toBe(false);
    expect(validateHostMessage(append(Number.POSITIVE_INFINITY, ['x'])).ok).toBe(false);
  });

  it.skip('rejects malformed identities, versions, bindings, and tokens', () => {
    const base = append(1, ['x']);
    const bad = [
      { ...base, generation: '' },
      { ...base, generation: 'g'.repeat(MAX_TOKEN_LENGTH + 1) },
      { ...base, source: { ...main, relPath: '../escape.jsonl' } },
      { ...base, source: { ...main, relPath: 'a\\b.jsonl' } },
      { ...base, source: { ...main, cardId: 'a/b' } },
      { ...base, version: { serverEpoch: '', sourceEpoch: 's' } },
      { ...base, binding: { sessionId: 's1', role: 'owner' } },
      { ...base, binding: { sessionId: 's1', role: 'main', agentId: '' } },
      { type: 'layout:handshake', generation, token: '' }
    ];
    for (const message of bad) expect(validateHostMessage(message).ok).toBe(false);
  });

  it.skip('rejects malformed descriptors, revisions, enums, and theme payloads', () => {
    const bad = [
      { type: 'session:update', generation, revision: 0, descriptor: descriptor(mainMember) },
      { type: 'session:update', generation, revision: 1.5, descriptor: descriptor(mainMember) },
      {
        type: 'session:update',
        generation,
        revision: 2,
        descriptor: { ...descriptor(mainMember), validity: 'unknown' }
      },
      { type: 'session:update', generation, revision: 2, descriptor: { ...descriptor(mainMember), main: null } },
      {
        type: 'session:update',
        generation,
        revision: 2,
        descriptor: descriptor({ ...mainMember, role: 'owner' as 'main' })
      },
      { type: 'source:error', generation, requestId: 'r1', source: main, error: 'boom' },
      { type: 'source:invalidated', generation, source: main, version: v1, binding: mainBinding, reason: 'other' },
      { type: 'connection:state', generation, state: 'running' },
      { type: 'theme:change', generation, themeKind: 4, cssVariables: {} },
      { type: 'theme:change', generation, themeKind: 1, cssVariables: { '--a': 1 } }
    ];
    for (const message of bad) expect(validateHostMessage(message).ok).toBe(false);
  });

  it.skip('returns identifier-only rejection reasons without echoing content', () => {
    const result = validateHostMessage({ ...append(1, ['secret-native-line']), extra: 'secret-extra' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^[a-z-]+$/);
      expect(result.reason).not.toContain('secret');
    }
  });
});

describe('validateRendererMessage', () => {
  it.skip('accepts every well-formed renderer message and returns an equal value', () => {
    for (const message of rendererValid) expect(validateRendererMessage(message)).toEqual({ ok: true, message });
  });

  it.skip('rejects unknown fields, unknown types, and the removed claim message', () => {
    for (const message of rendererValid) {
      expect(validateRendererMessage({ ...(message as object), extra: true }).ok).toBe(false);
    }
    expect(validateRendererMessage({ type: 'claim', generation, filenames: ['a'] }).ok).toBe(false);
    expect(validateRendererMessage({ type: 'subscribe', filename: 'a' }).ok).toBe(false);
    expect(
      validateRendererMessage({
        type: 'source:subscribe',
        generation,
        requestId: 'r1',
        source: { ...main, extra: 1 },
        history: 'full'
      }).ok
    ).toBe(false);
  });

  it.skip('enforces layout numeric bounds', () => {
    const size = { type: 'layout:size', generation, token: 't', revision: 1, height: 10 };
    for (const height of [0, -1, 1.5, MAX_LAYOUT_HEIGHT + 1, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
      expect(validateRendererMessage({ ...size, height }).ok).toBe(false);
    }
    for (const revision of [0, -1, 2.5, Number.NaN]) {
      expect(validateRendererMessage({ ...size, revision }).ok).toBe(false);
    }
    const scroll = { type: 'layout:scroll', generation, token: 't' };
    for (const command of [
      { kind: 'delta', deltaY: MAX_SCROLL_DELTA + 1 },
      { kind: 'delta', deltaY: Number.NaN },
      { kind: 'delta', deltaY: Number.NEGATIVE_INFINITY },
      { kind: 'delta', deltaY: 1, deltaX: 1 },
      { kind: 'key', key: 'Tab' },
      { kind: 'element', selector: '#x' }
    ]) {
      expect(validateRendererMessage({ ...scroll, command }).ok).toBe(false);
    }
  });

  it.skip('rejects malformed subscription and action fields', () => {
    const bad = [
      { type: 'source:subscribe', generation, requestId: 'r1', source: main, history: 'range' },
      { type: 'source:subscribe', generation, requestId: '', source: main, history: 'full' },
      {
        type: 'source:subscribe',
        generation: 'g'.repeat(MAX_TOKEN_LENGTH + 1),
        requestId: 'r',
        source: main,
        history: 'full'
      },
      { type: 'openFile', generation, path: '' },
      { type: 'openFile', generation, path: 'a.ts', line: 0 },
      { type: 'openFile', generation, path: 'a.ts', line: 1.5 },
      { type: 'showDiff', generation, sha: '' },
      { type: 'close' }
    ];
    for (const message of bad) expect(validateRendererMessage(message).ok).toBe(false);
  });
});

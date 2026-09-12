/**
 * Tests for the conversation-scoped runtime marker store.
 *
 * @summary Tests for the Antigravity marker store
 */

import { describe, expect, it } from 'vitest';
import { defaultAntigravityIo } from '../../../src/antigravity/internal/io.js';
import {
  markerPath,
  type ReadyMarkerPayload,
  UNATTRIBUTED_SESSION,
  UNKNOWN_CONVERSATION,
  writeMarker
} from '../../../src/antigravity/internal/markers.js';
import { makeTempDir, removeTempDir } from '../helpers.js';

describe('markerPath', () => {
  it('scopes by session directory then conversation file name', () => {
    expect(markerPath('/cards-home', 'session-453', 'conv-453', 'ready')).toBe(
      '/cards-home/antigravity/runtime/markers/session-453/conv-453.ready'
    );
  });

  it('falls back to the unattributed session directory', () => {
    expect(markerPath('/cards-home', null, 'conv-453', 'failure')).toBe(
      `/cards-home/antigravity/runtime/markers/${UNATTRIBUTED_SESSION}/conv-453.failure`
    );
  });

  it('falls back to the unknown-conversation placeholder', () => {
    expect(markerPath('/cards-home', 'session-453', null, 'failure')).toBe(
      `/cards-home/antigravity/runtime/markers/session-453/${UNKNOWN_CONVERSATION}.failure`
    );
    expect(markerPath('/cards-home', null, null, 'failure')).toBe(
      `/cards-home/antigravity/runtime/markers/${UNATTRIBUTED_SESSION}/${UNKNOWN_CONVERSATION}.failure`
    );
  });

  it('uses the marker kind as the file extension', () => {
    for (const kind of ['ready', 'failure', 'route', 'idle', 'drain-ready'] as const) {
      expect(markerPath('/cards-home', 's', 'c', kind).endsWith(`.${kind}`)).toBe(true);
    }
  });
});

describe('marker store operations on the real filesystem', () => {
  it('writes, reads, and reports markers with their payload', () => {
    const root = makeTempDir('markers');
    try {
      const path = markerPath(root, 'session-453', 'conv-453', 'ready');
      const payload: ReadyMarkerPayload = {
        conversationId: 'conv-453',
        sessionId: 'session-453',
        transcriptPath: '/transcripts/conv-453.jsonl',
        modelName: 'gemini-3-pro'
      };
      writeMarker(defaultAntigravityIo, path, payload);
      expect(defaultAntigravityIo.existsSync(path)).toBe(true);
      expect(JSON.parse(defaultAntigravityIo.readTextFileSync(path))).toEqual(payload);
    } finally {
      removeTempDir(root);
    }
  });

  it('writes empty markers when no payload is given', () => {
    const root = makeTempDir('markers-empty');
    try {
      const path = markerPath(root, 'session-453', 'conv-453', 'drain-ready');
      writeMarker(defaultAntigravityIo, path);
      expect(defaultAntigravityIo.readTextFileSync(path)).toBe('');
    } finally {
      removeTempDir(root);
    }
  });

  it('creates the session directory on demand', () => {
    const root = makeTempDir('markers-mkdir');
    try {
      const path = markerPath(root, 'session-453', 'conv-453', 'idle');
      writeMarker(defaultAntigravityIo, path);
      expect(defaultAntigravityIo.existsSync(path)).toBe(true);
    } finally {
      removeTempDir(root);
    }
  });
});

/**
 * Acceptance contracts for exact source/session grouping and visible anomalies.
 * @summary Session grouping bootstrap acceptance checks
 */
import { describe, expect, it } from 'vitest';
import type { StreamMeta } from '../../src/protocol/types/stream.js';
import { groupStreamSessions, streamSessionKey, streamSourceKey } from '../../src/stream-session/index.js';

/**
 * Creates native metadata without filename-derived membership.
 * @param overrides - Fields varied by the acceptance case.
 * @returns Complete stream metadata.
 */
function metadata(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return {
    version: 1,
    streamType: 'claude',
    relPath: 'main.jsonl',
    runtime: 'claude',
    sessionId: 'session',
    role: 'main',
    sourcePath: '/native/main.jsonl',
    startedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    lineCount: 0,
    isActive: false,
    ...overrides
  };
}

describe('session grouping contract', () => {
  it('uses exact unambiguous JSON tuple source and session keys', () => {
    expect(streamSourceKey({ cardId: 'a:b', streamType: 'c', relPath: 'd' })).toBe('["a:b","c","d"]');
    expect(streamSessionKey({ cardId: 'a', streamType: 'b:c', sessionId: 'd' })).toBe('["a","b:c","d"]');
  });

  it('keeps independent provider/session tuples distinct despite identical paths', () => {
    const result = groupStreamSessions('card', [
      metadata(),
      metadata({ streamType: 'codex' }),
      metadata({ sessionId: 'other', relPath: 'other.jsonl' })
    ]);
    expect(result.groups).toHaveLength(3);
    expect(streamSourceKey({ cardId: 'other', streamType: 'claude', relPath: 'main.jsonl' })).not.toBe(
      streamSourceKey({ cardId: 'card', streamType: 'claude', relPath: 'main.jsonl' })
    );
  });

  it('orders members by role then source key and chooses exactly one main', () => {
    const result = groupStreamSessions('card', [
      metadata({ role: 'auxiliary', relPath: 'a' }),
      metadata({ role: 'subagent', relPath: 'z', agentId: 'z' }),
      metadata(),
      metadata({ role: 'subagent', relPath: 'b', agentId: 'b' })
    ]);
    expect(result.groups[0]?.descriptor.members.map((member) => member.source.relPath)).toEqual([
      'main.jsonl',
      'b',
      'z',
      'a'
    ]);
    expect(result.groups[0]?.descriptor.main?.relPath).toBe('main.jsonl');
    expect(result.groups[0]?.descriptor.validity).toBe('ready');
  });

  it('retains missing-main and conflicting-main groups without arbitrary main selection', () => {
    const missing = groupStreamSessions('card', [metadata({ role: 'subagent' })]);
    const conflict = groupStreamSessions('card', [metadata(), metadata({ relPath: 'other' })]);
    expect(missing.groups[0]?.descriptor).toMatchObject({ main: null, validity: 'missing-main' });
    expect(conflict.groups[0]?.descriptor).toMatchObject({ main: null, validity: 'conflicting-main' });
    expect(conflict.groups[0]?.descriptor.members).toHaveLength(2);
  });

  it('keeps group identity when the main appears late and chronology changes', () => {
    const child = metadata({ role: 'subagent', relPath: 'child', createdAt: '2026-01-02T00:00:00Z' });
    const before = groupStreamSessions('card', [child]).groups[0];
    const after = groupStreamSessions('card', [child, metadata()]).groups[0];
    expect(after?.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(before && streamSessionKey(before.descriptor.session)).toBe(
      after && streamSessionKey(after.descriptor.session)
    );
  });

  it.each(['.', '..', 'a/b', 'a\\b'])('rejects unsafe card/provider component %s', (component) => {
    expect(groupStreamSessions(component, [metadata()]).errors[0]?.reason).toBe('invalid-source');
    expect(groupStreamSessions('card', [metadata({ streamType: component })]).errors[0]?.reason).toBe('invalid-source');
  });

  it('sorts using trusted card scope even when metadata includes an extra cardId field', () => {
    const a = { ...metadata({ relPath: 'a' }), cardId: 'z' };
    const b = { ...metadata({ relPath: 'b', role: 'main' }), cardId: 'a' };
    expect(
      groupStreamSessions('card', [b, a]).groups[0]?.descriptor.members.map((member) => member.source.relPath)
    ).toEqual(['a', 'b']);
  });

  it('returns empty groups for an empty listing', () => {
    expect(groupStreamSessions('card', [])).toEqual({ groups: [], errors: [] });
  });

  it('retains malformed bindings as source-scoped inspectable errors', () => {
    const record = metadata({ sessionId: '' });
    const result = groupStreamSessions('card', [record]);
    expect(result.groups).toEqual([]);
    expect(result.errors).toEqual([
      {
        source: { cardId: 'card', streamType: 'claude', relPath: 'main.jsonl' },
        record,
        index: 0,
        reason: 'invalid-binding'
      }
    ]);
  });

  it.each([
    '',
    '../escape',
    '/absolute',
    'a//b',
    'a\\b',
    'a/./b',
    'a/../b'
  ])('rejects invalid logical source path %s', (relPath) => {
    const record = metadata({ relPath });
    expect(groupStreamSessions('card', [record]).errors[0]).toMatchObject({ record, reason: 'invalid-source' });
  });

  it('does not join duplicate source identities or infer cross-session topology', () => {
    const result = groupStreamSessions('card', [metadata(), metadata({ sessionId: 'other' })]);
    expect(result.errors.some((error) => error.reason === 'duplicate-source')).toBe(true);
  });
});

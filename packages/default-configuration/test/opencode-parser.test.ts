/**
 * OpenCode's native normalized JSONL envelope parser contract.
 * @summary Parser tests for OpenCode session records
 */

import { describe, expect, it } from 'vitest';
import { type OpencodeLine, parseOpencodeLine } from '../src/streams/opencode-session/www/lib/parser.js';

/** Wraps a native event body in the Cards OpenCode JSONL envelope.
 * @param type - OpenCode envelope discriminator.
 * @param data - Native provider payload.
 * @param seq - Event order stored in the envelope.
 * @returns Serialized native JSONL event.
 */
function envelope(type: string, data: unknown, seq = 1): string {
  return JSON.stringify({ v: 1, ts: '2026-06-04T12:00:00.000Z', seq, sessionId: 'ses-123', type, data });
}

describe('OpenCode native parser', () => {
  it('parses envelope identity and session metadata without changing the provider payload', () => {
    const line = parseOpencodeLine(envelope('meta', { runtime: 'opencode', opencodeVersion: '1.18.21' }));

    expect(line).toMatchObject({
      kind: 'meta',
      ts: '2026-06-04T12:00:00.000Z',
      seq: 1,
      sessionId: 'ses-123',
      data: { runtime: 'opencode', opencodeVersion: '1.18.21' }
    });
  });

  it('keeps OpenCode message and part records typed through their provider fields', () => {
    const message = parseOpencodeLine(
      envelope('message', {
        id: 'msg-1',
        role: 'assistant',
        modelID: 'claude-x',
        providerID: 'anthropic',
        path: { cwd: '/workspace' },
        time: { created: 100, completed: 200 },
        tokens: { input: 4, output: 2 }
      })
    );
    const part = parseOpencodeLine(
      envelope(
        'part',
        {
          id: 'part-1',
          messageID: 'msg-1',
          type: 'tool',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'ls' }, result: 'file.txt' }
        },
        2
      )
    );

    expect(message).toMatchObject({
      kind: 'message',
      data: { role: 'assistant', modelID: 'claude-x', path: { cwd: '/workspace' } }
    });
    expect(part).toMatchObject({
      kind: 'part',
      data: { id: 'part-1', messageID: 'msg-1', callID: 'call-1', state: { status: 'completed' } }
    });
  });

  it('parses idle envelopes and preserves unknown root event records', () => {
    expect(parseOpencodeLine(envelope('idle', {}, 9))).toMatchObject({ kind: 'idle', seq: 9, sessionId: 'ses-123' });
    const unknown = parseOpencodeLine(envelope('future-event', { nested: { retained: true } }));
    expect(unknown).toMatchObject({
      kind: 'unknown',
      raw: { type: 'future-event', data: { nested: { retained: true } } }
    });
  });

  it('fails closed for malformed JSON, scalar roots, and unusable envelopes', () => {
    expect(parseOpencodeLine('{"v":1,"ts":"torn')).toMatchObject({ kind: 'malformed' });
    expect(parseOpencodeLine('"just a string"')).toMatchObject({ kind: 'malformed' });
    expect(parseOpencodeLine('[]')).toMatchObject({ kind: 'malformed' });
  });

  it('exposes discriminated kinds for provider-owned switches', () => {
    const parsed: OpencodeLine = parseOpencodeLine(envelope('meta', {}));
    switch (parsed.kind) {
      case 'meta':
        expect(parsed.seq).toBe(1);
        break;
      default:
        throw new Error(`unexpected kind: ${parsed.kind}`);
    }
  });
});

/**
 * The quiet live-region policy speaks only for completed changes the reader has not been shown.
 * @summary Session completion announcement derivation
 */
import { describe, expect, it } from 'vitest';
import { createCompletionAnnouncer } from '../src/streams/lib/session/announcements';
import type { SessionHeaderFacts, SessionRow, SessionToolPart } from '../src/streams/lib/session/types';

const at = (lineNumber: number) => [{ sourceKey: 'source', generation: 'one', lineNumber, selector: 'record' }];
const reply = (id: string, line: number): SessionRow => ({
  id,
  kind: 'message',
  role: 'assistant',
  anchor: 'turn',
  provenance: at(line),
  parts: [{ id: `${id}/text`, kind: 'text', text: 'reply', provenance: at(line) }]
});
const tool = (id: string, line: number, status: SessionToolPart['status'], name = 'Bash'): SessionRow => ({
  id,
  kind: 'structural',
  label: 'Tool',
  tone: 'info',
  anchor: 'none',
  provenance: at(line),
  parts: [{ id: `${id}/tool`, kind: 'tool', callId: id, name, input: '', status, provenance: at(line) }]
});
const announce = (
  before: readonly SessionRow[],
  after: readonly SessionRow[],
  status: [SessionHeaderFacts['status'], SessionHeaderFacts['status']] = ['running', 'running']
) => {
  const announce = createCompletionAnnouncer('Codex');
  announce(before, status[0]);
  return announce(after, status[1]);
};

describe('session completion announcements', () => {
  const history = [reply('first', 1), tool('call', 2, 'pending')];

  it('announces a newly appended reply and a tool that finished', () => {
    expect(announce(history, [...history, reply('next', 3)])).toBe('New reply from Codex');
    expect(announce(history, [history[0]!, tool('call', 3, 'complete')])).toBe('Bash completed');
    expect(announce(history, [history[0]!, tool('call', 3, 'error')])).toBe('Bash failed');
  });

  it('stays silent for history loads, prepends, resets and unchanged pending tools', () => {
    expect(announce([], history)).toBeUndefined();
    expect(announce(history, [reply('earlier', 0), tool('older', 0, 'complete'), ...history])).toBeUndefined();
    expect(announce(history, [reply('other', 9), tool('other-call', 10, 'complete')])).toBeUndefined();
    expect(announce(history, [...history, tool('later', 3, 'running')])).toBeUndefined();
  });

  const streamed = (id: string, line: number, done: boolean | undefined): SessionRow => ({
    ...reply(id, line),
    parts: [
      ...(done === undefined
        ? []
        : [
            {
              id: `${id}/details`,
              kind: 'provider' as const,
              providerKind: 'details',
              data: { done },
              provenance: at(line)
            }
          ]),
      ...reply(id, line).parts
    ]
  });
  const streaming = () => {
    let calls = 0;
    const registry = {
      details: {
        render: () => null,
        disclosureKeys: () => [],
        finished: (data: { done: boolean }) => {
          calls++;
          return data.done;
        }
      }
    };
    return { announce: createCompletionAnnouncer('OpenCode', registry as never), calls: () => calls };
  };

  it('waits for a streamed reply until a part declares it finished', () => {
    const { announce } = streaming();
    announce(history, 'running');
    expect(announce([...history, streamed('streamed', 3, undefined)], 'running')).toBeUndefined();
    expect(announce([...history, streamed('streamed', 4, false)], 'running')).toBeUndefined();
    expect(announce([...history, streamed('streamed', 5, true)], 'running')).toBe('New reply from OpenCode');
    expect(announce([...history, streamed('streamed', 5, true)], 'running')).toBeUndefined();
  });

  it('derives facts only for rows whose object changed', () => {
    const { announce, calls } = streaming();
    const rows = Array.from({ length: 200 }, (_, index) => streamed(`row-${index}`, index + 1, true));
    announce(rows, 'running');
    expect(calls()).toBe(200);
    expect(announce([...rows, streamed('appended', 500, true)], 'running')).toBe('New reply from OpenCode');
    expect(calls()).toBe(201);
    announce([...rows, streamed('appended', 500, true)], 'running');
    expect(calls()).toBe(202);
  });

  it('announces a running session that ends, with or without an error', () => {
    expect(announce(history, history, ['running', 'done'])).toBe('Session ended');
    expect(announce(history, history, ['running', 'error'])).toBe('Session ended with an error');
    expect(announce(history, history, ['done', 'done'])).toBeUndefined();
  });

  it('coalesces every completion in one update into a single bounded message', () => {
    const batch = Array.from({ length: 50 }, (_, index) =>
      tool(`batch-${index}`, 10 + index, 'complete', `tool-${index % 5}`)
    );
    expect(announce(history, [...history, reply('next', 3), ...batch])).toBe(
      'New reply from Codex. tool-0 completed, and 4 more updates'
    );
  });
});

/**
 * Tests for the codex-session `toThreadMessages`/`deriveStatus` converter —
 * the pure transform from flat `TranscriptItem[]` (renderCodexTranscript's
 * output) to `ThreadMessageLike[]` for the shared `StreamThread`.
 *
 * Only `user_message` starts a new message; every other item kind — reasoning,
 * tool calls, and structural markers (turn boundaries, compaction, task
 * lifecycle, errors, unknown/malformed content) alike — joins one of two
 * alternating `role: 'assistant'` run kinds: a content run (text/reasoning/
 * tool-call, plus the passthrough `image-note`) or a service run (every other
 * `data` part), the latter marked `metadata: { custom: { service: true } }`.
 * Neither ever becomes a `role: 'system'` message — this is forced by a hard
 * assistant-ui runtime constraint: `fromThreadMessageLike` throws
 * `"System messages must have exactly one text message part."` for any
 * `role: 'system'` message carrying a `data` part, so structural/system-style
 * rows cannot live in their own `system`-role message (see the "runtime
 * constraint" describe block below for the reproduction) — they fold into an
 * assistant-role service run instead.
 *
 * The first half asserts structure directly against `toThreadMessages`'
 * return value (message roles, content-part shapes) for every
 * `TranscriptItem` kind, mirroring the pre-migration `TranscriptItemView`
 * test coverage. The second half renders a representative transcript through
 * the real `StreamThread` + Codex data-part registry via `react-dom/server`
 * (this package has no jsdom — see `attachment-render.test.ts`), asserting
 * on the resulting HTML string.
 *
 * @summary Unit + render tests for the codex-session thread converter
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CxSessionStartPart,
  EventActivityDataPart,
  ImageNoteDataPart
} from '../src/streams/codex-session/www/components/expanded/CodexDataParts.js';
import type { TranscriptItem } from '../src/streams/codex-session/www/lib/render-transcript.js';
import { deriveStatus, toThreadMessages } from '../src/streams/codex-session/www/lib/to-thread-messages.js';
import { StreamThread } from '../src/streams/lib/aui/StreamThread.js';

const CODEX_DATA_COMPONENTS = {
  'image-note': ImageNoteDataPart,
  'event-activity': EventActivityDataPart,
  'cx-session-start': CxSessionStartPart
};

/**
 * Narrows a thread message to its leading `tool-call` part and returns that
 * part's parsed args.
 *
 * @param message - Thread message expected to open with a `tool-call` part.
 * @returns The tool-call part's args.
 * @throws {Error} When the message does not open with a `tool-call` part.
 */
function firstToolCallArgs(message: ReturnType<typeof toThreadMessages>['messages'][number] | undefined): unknown {
  const content = message?.content;
  const part = typeof content === 'string' ? undefined : content?.[0];
  if (part?.type !== 'tool-call') throw new Error('expected a leading tool-call part');
  return part.args;
}

function toolCall(
  overrides: Partial<Extract<TranscriptItem, { kind: 'tool_call' }>> = {}
): Extract<TranscriptItem, { kind: 'tool_call' }> {
  return {
    kind: 'tool_call',
    name: 'shell',
    callId: 'call-1',
    argumentsText: '',
    prettyPrinted: false,
    hasOutput: false,
    ...overrides
  };
}

describe('toThreadMessages — runtime constraint driving the fold-into-assistant design', () => {
  it('confirms assistant-ui rejects a system-role message carrying a data part (not exactly one text part)', () => {
    // This is the reason `toThreadMessages` never emits `role: 'system'`: the
    // runtime's `fromThreadMessageLike` throws for any system message whose
    // content is not exactly one text part.
    expect(() =>
      renderToStaticMarkup(
        createElement(StreamThread, {
          messages: [
            {
              id: 's1',
              role: 'system',
              content: [{ type: 'data', name: 'boundary', data: { kind: 'turn', label: 'Turn' } }]
            }
          ],
          isRunning: false
        })
      )
    ).toThrow('System messages must have exactly one text message part.');
  });
});

describe('toThreadMessages — session_header', () => {
  it('produces no message (rendered separately as the sticky SessionHeader)', () => {
    const { messages } = toThreadMessages([{ kind: 'session_header', model: 'gpt-5-codex' }], false);
    expect(messages).toHaveLength(0);
  });
});

describe('toThreadMessages — user_message', () => {
  it('produces a user message with a text part', () => {
    const { messages } = toThreadMessages([{ kind: 'user_message', text: 'Fix the bug.' }], false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] });
  });

  it('appends an image-note data part when imageCount is present', () => {
    const { messages } = toThreadMessages([{ kind: 'user_message', text: 'look', imageCount: 1 }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'data', name: 'image-note', data: { text: 'Image' } }
    ]);
  });

  it('uses the plural image-note text for imageCount > 1', () => {
    const { messages } = toThreadMessages([{ kind: 'assistant_message', text: '', imageCount: 3 }], false);
    expect(messages[0]?.content).toContainEqual({ type: 'data', name: 'image-note', data: { text: '3 Images' } });
  });
});

describe('toThreadMessages — turn grouping', () => {
  it('splits a run of content/service items into alternating messages, each marked by category', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant_message', text: 'Starting.' }, // content
      { kind: 'reasoning', summaryText: 'thinking' }, // service (summary-only → status-line)
      toolCall({ callId: 'call-a' }), // content
      { kind: 'turn_boundary', turnId: 't1' }, // service (boundary)
      { kind: 'assistant_message', text: 'Done.' } // content
    ];
    const { messages } = toThreadMessages(items, false);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'assistant', 'assistant', 'assistant', 'assistant']);
    expect(messages.map((m) => Boolean(m.metadata?.custom?.['service']))).toEqual([false, true, false, true, false]);
    expect((messages[0]?.content as unknown as { type: string }[]).map((p) => p.type)).toEqual(['text']);
    expect((messages[2]?.content as unknown as { type: string }[]).map((p) => p.type)).toEqual(['tool-call']);
    expect((messages[4]?.content as unknown as { type: string }[]).map((p) => p.type)).toEqual(['text']);
  });

  it('flushes the open run at a user_message boundary, producing two messages in order', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant_message', text: 'First.' },
      { kind: 'user_message', text: 'Follow-up question.' }
    ];
    const { messages } = toThreadMessages(items, false);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('renders a leading turn_boundary as a service message ahead of the content message that follows it', () => {
    const items: TranscriptItem[] = [
      { kind: 'turn_boundary', turnId: 't1' },
      { kind: 'assistant_message', text: 'Hi.' }
    ];
    const { messages } = toThreadMessages(items, false);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.metadata?.custom?.['service']).toBe(true);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'boundary', data: { kind: 'turn', label: '', tooltip: 't1' } }
    ]);
    expect(messages[1]?.metadata?.custom?.['service']).toBeUndefined();
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'Hi.' }]);
  });

  it('renders turn_boundary with an empty visible label, carrying the full turn UUID as the tooltip', () => {
    const items: TranscriptItem[] = [
      { kind: 'turn_boundary', turnId: '019e467f-e069-7250-bd28-0cb46c0b5778' },
      { kind: 'assistant_message', text: 'Hi.' }
    ];
    const { messages } = toThreadMessages(items, false);
    expect(messages[0]?.content).toContainEqual({
      type: 'data',
      name: 'boundary',
      data: { kind: 'turn', label: '', tooltip: '019e467f-e069-7250-bd28-0cb46c0b5778' }
    });
  });

  it('produces no message for a reasoning item with no summary/content followed by nothing else', () => {
    // A reasoning item with empty summaryText and no contentText contributes
    // nothing — it must not produce a stray empty assistant message.
    const { messages } = toThreadMessages([{ kind: 'reasoning', summaryText: '' }], false);
    expect(messages).toHaveLength(0);
  });
});

describe('toThreadMessages — reasoning', () => {
  it('renders a reasoning part combining summary and content when both are present', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'reasoning', summaryText: 'Short summary.', contentText: 'Detailed chain of thought.' }],
      false
    );
    expect(messages[0]?.content).toEqual([{ type: 'reasoning', text: 'Short summary.\n\nDetailed chain of thought.' }]);
  });

  it('renders a reasoning part with only contentText when summaryText is empty', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'reasoning', summaryText: '', contentText: 'Just content.' }],
      false
    );
    expect(messages[0]?.content).toEqual([{ type: 'reasoning', text: 'Just content.' }]);
  });

  it('renders a status-line data part (not a reasoning part) when only summaryText is present', () => {
    const { messages } = toThreadMessages([{ kind: 'reasoning', summaryText: 'Step by step analysis.' }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'status-line', data: { text: 'Step by step analysis.' } }
    ]);
  });

  it('strips markdown syntax from a summary-only reasoning line before rendering (StatusLine has no markdown engine)', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'reasoning', summaryText: 'Card `main-377` is currently **active**. Key details: …' }],
      false
    );
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'status-line', data: { text: 'Card main-377 is currently active. Key details: …' } }
    ]);
  });

  it('produces no message when both summaryText and contentText are empty', () => {
    const { messages } = toThreadMessages([{ kind: 'reasoning', summaryText: '' }], false);
    expect(messages).toHaveLength(0);
  });
});

describe('toThreadMessages — tool_call', () => {
  it('parses pretty-printed JSON-object arguments into the tool-call part args', () => {
    const { messages } = toThreadMessages(
      [toolCall({ argumentsText: '{\n  "path": "/src/index.ts"\n}', prettyPrinted: true })],
      false
    );
    expect(firstToolCallArgs(messages[0])).toEqual({ path: '/src/index.ts' });
  });

  it('wraps non-object raw arguments text under the argsLabel key', () => {
    const { messages } = toThreadMessages(
      [toolCall({ argumentsText: 'ls -la', argsLabel: 'command', prettyPrinted: false })],
      false
    );
    expect(firstToolCallArgs(messages[0])).toEqual({ command: 'ls -la' });
  });

  it('produces an empty args object when argumentsText is empty', () => {
    const { messages } = toThreadMessages([toolCall({ argumentsText: '' })], false);
    expect(firstToolCallArgs(messages[0])).toEqual({});
  });

  it('sets result from outputText when hasOutput, and isError from severity', () => {
    const { messages } = toThreadMessages(
      [toolCall({ hasOutput: true, outputText: 'file contents', severity: 'normal' })],
      false
    );
    const part = messages[0]?.content[0] as { result: unknown; isError: boolean };
    expect(part.result).toBe('file contents');
    expect(part.isError).toBe(false);
  });

  it('prefixes the errorLabel onto the result text and sets isError when severity is error', () => {
    const { messages } = toThreadMessages(
      [toolCall({ hasOutput: true, outputText: 'boom', severity: 'error', errorLabel: '✗ exit 1' })],
      false
    );
    const part = messages[0]?.content[0] as { result: unknown; isError: boolean };
    expect(part.result).toBe('✗ exit 1\nboom');
    expect(part.isError).toBe(true);
  });

  it('leaves result undefined when there is no output yet', () => {
    const { messages } = toThreadMessages([toolCall({ hasOutput: false })], false);
    const part = messages[0]?.content[0] as { result: unknown };
    expect(part.result).toBeUndefined();
  });

  it('appends an image-note data part after the tool-call part when outputImageCount is present', () => {
    const { messages } = toThreadMessages(
      [toolCall({ hasOutput: true, outputText: 'shot', outputImageCount: 1 })],
      false
    );
    const content = messages[0]?.content as unknown as { type: string }[];
    expect(content.map((p) => p.type)).toEqual(['tool-call', 'data']);
  });
});

describe('toThreadMessages — orphan_output', () => {
  it('renders a raw data part labeled with the call id', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'orphan_output', callId: 'orphan-1', outputText: 'text here' }],
      false
    );
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'raw', data: { data: 'text here', label: 'output (call orphan-1)' } }
    ]);
  });

  it('appends an image-note data part when imageCount is present', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'orphan_output', callId: 'orphan-2', outputText: 'text', imageCount: 2 }],
      false
    );
    const content = messages[0]?.content as unknown as { type: string }[];
    expect(content.map((p) => p.type)).toEqual(['data', 'data']);
  });
});

describe('toThreadMessages — compaction', () => {
  it('renders a compaction boundary with no detail text part when message is empty', () => {
    const { messages } = toThreadMessages([{ kind: 'compaction', message: '' }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'boundary', data: { kind: 'compaction', label: 'Context compacted' } }
    ]);
  });

  it('splits the compaction boundary (service) and its detail text (content) into separate messages', () => {
    const { messages } = toThreadMessages([{ kind: 'compaction', message: 'Summarized 10 turns.' }], false);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.metadata?.custom?.['service']).toBe(true);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'boundary', data: { kind: 'compaction', label: 'Context compacted' } }
    ]);
    expect(messages[1]?.metadata?.custom?.['service']).toBeUndefined();
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'Summarized 10 turns.' }]);
  });
});

describe('toThreadMessages — error', () => {
  it('renders an error-line data part carrying the message', () => {
    const { messages } = toThreadMessages([{ kind: 'error', message: 'context window exceeded' }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'error-line', data: { message: 'context window exceeded' } }
    ]);
  });
});

describe('toThreadMessages — task_started / task_complete', () => {
  it('renders task_started as a quiet bare-hairline boundary, not a loud labeled divider', () => {
    const { messages } = toThreadMessages([{ kind: 'task_started' }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'boundary', data: { kind: 'turn', label: '', tooltip: 'Task started' } }
    ]);
  });

  it('includes the turn id in the task_started tooltip when present', () => {
    const { messages } = toThreadMessages([{ kind: 'task_started', turnId: 'turn-42' }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'boundary', data: { kind: 'turn', label: '', tooltip: 'Task started · turn-42' } }
    ]);
  });

  it('renders task_complete as a quiet turn-time line with a formatted duration, replacing the old result boundary', () => {
    const { messages } = toThreadMessages([{ kind: 'task_complete', durationMs: 65000 }], false);
    expect(messages[0]?.content).toEqual([{ type: 'data', name: 'turn-time', data: { text: '1m 5s' } }]);
  });

  it('renders task_complete with a bare "Turn complete" turn-time text when durationMs is absent', () => {
    const { messages } = toThreadMessages([{ kind: 'task_complete' }], false);
    expect(messages[0]?.content).toEqual([{ type: 'data', name: 'turn-time', data: { text: 'Turn complete' } }]);
  });

  it('appends a truncated last-agent-message status-line after the turn-time line when present', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'task_complete', durationMs: 1000, lastAgentMessage: 'All done, ran the tests.' }],
      false
    );
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'turn-time', data: { text: '1s' } },
      { type: 'data', name: 'status-line', data: { text: 'All done, ran the tests.' } }
    ]);
  });

  it('strips inline markdown from the last-agent-message status-line', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'task_complete', durationMs: 1000, lastAgentMessage: 'Card `main-377` is currently **active**.' }],
      false
    );
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'turn-time', data: { text: '1s' } },
      { type: 'data', name: 'status-line', data: { text: 'Card main-377 is currently active.' } }
    ]);
  });

  it('skips the last-agent-message status-line when it exactly echoes the preceding assistant text', () => {
    const { messages } = toThreadMessages(
      [
        { kind: 'assistant_message', text: 'All done, ran the tests.' },
        { kind: 'task_complete', durationMs: 1000, lastAgentMessage: 'All done, ran the tests.' }
      ],
      false
    );
    const parts = messages.flatMap((m) => (typeof m.content === 'string' ? [] : [...m.content]));
    expect(parts.filter((p) => p.type === 'data' && p.name === 'status-line')).toEqual([]);
    expect(parts.filter((p) => p.type === 'data' && p.name === 'turn-time')).toHaveLength(1);
  });
});

describe('toThreadMessages — event_activity, unknown_item, malformed', () => {
  it('renders event_activity as an event-activity data part carrying label and detailText', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'event_activity', label: 'mcp: github.list_prs', detailText: 'arguments: {}' }],
      false
    );
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'event-activity', data: { label: 'mcp: github.list_prs', detailText: 'arguments: {}' } }
    ]);
  });

  it('renders unknown_item as a raw data part with info severity', () => {
    const { messages } = toThreadMessages([{ kind: 'unknown_item', raw: { type: 'future_variant' } }], false);
    expect(messages[0]?.content).toEqual([
      {
        type: 'data',
        name: 'raw',
        data: { data: { type: 'future_variant' }, label: 'Unrecognized item', severity: 'info' }
      }
    ]);
  });

  it('renders malformed as a raw data part with warning severity', () => {
    const { messages } = toThreadMessages([{ kind: 'malformed', rawLine: '{"broken":' }], false);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'raw', data: { data: '{"broken":', label: 'Malformed line', severity: 'warning' } }
    ]);
  });
});

describe('toThreadMessages — session-preamble gathering (cx-session-start)', () => {
  it('gathers a developer-role assistant_message and an instructions/environment user_message into one disclosure ahead of the real first prompt', () => {
    const items: TranscriptItem[] = [
      { kind: 'session_header', model: 'gpt-5.5' },
      {
        kind: 'assistant_message',
        text: '<permissions instructions>\n...\n</permissions instructions>',
        role: 'developer'
      },
      {
        kind: 'user_message',
        text: '# AGENTS.md instructions for /repo\n\n<environment_context>\n...\n</environment_context>'
      },
      { kind: 'user_message', text: 'What is the status of this card?' },
      { kind: 'assistant_message', text: 'Checking now.' }
    ];
    const { messages } = toThreadMessages(items, false);

    // session_header produced no message; the gathered disclosure is message 0.
    expect(messages).toHaveLength(3);
    expect(messages[0]?.metadata?.custom?.['service']).toBe(true);
    expect(messages[0]?.content).toEqual([
      {
        type: 'data',
        name: 'cx-session-start',
        data: {
          summary: 'Session started · gpt-5.5 · instructions · environment · 1 developer note',
          entries: [
            {
              label: 'Developer instructions',
              text: '<permissions instructions>\n...\n</permissions instructions>'
            },
            {
              label: 'Instructions',
              text: '# AGENTS.md instructions for /repo\n\n<environment_context>\n...\n</environment_context>'
            }
          ]
        }
      }
    ]);
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'What is the status of this card?' }]
    });
    expect(messages[2]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Checking now.' }] });
  });

  it('does not gather a real user prompt that happens to arrive first (no cx-session-start emitted)', () => {
    const { messages } = toThreadMessages([{ kind: 'user_message', text: 'Fix the bug.' }], false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] });
  });

  it('renders a leading turn_boundary/task_started as-is, ungathered, even while gathering is still open', () => {
    const items: TranscriptItem[] = [
      { kind: 'turn_boundary', turnId: 't1' },
      { kind: 'task_started', turnId: 't1' },
      { kind: 'assistant_message', text: '<permissions instructions>', role: 'developer' },
      { kind: 'user_message', text: 'Fix the bug.' }
    ];
    const { messages } = toThreadMessages(items, false);
    // The boundary/task_started/cx-session-start data parts are every one a
    // "service" category, so — matching every other consecutive run of
    // service data parts — they fold into one message ahead of the real user turn.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toEqual([
      { type: 'data', name: 'boundary', data: { kind: 'turn', label: '', tooltip: 't1' } },
      { type: 'data', name: 'boundary', data: { kind: 'turn', label: '', tooltip: 'Task started · t1' } },
      {
        type: 'data',
        name: 'cx-session-start',
        data: {
          summary: 'Session started · 1 developer note',
          entries: [{ label: 'Developer instructions', text: '<permissions instructions>' }]
        }
      }
    ]);
    expect(messages[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] });
  });

  it('still flushes the gathered buffer when the entire transcript is preamble (no genuine content ever arrives)', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant_message', text: '<permissions instructions>', role: 'developer' }
    ];
    const { messages } = toThreadMessages(items, false);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual([
      {
        type: 'data',
        name: 'cx-session-start',
        data: {
          summary: 'Session started · 1 developer note',
          entries: [{ label: 'Developer instructions', text: '<permissions instructions>' }]
        }
      }
    ]);
  });

  it('renders the cx-session-start disclosure collapsed by default, with its summary visible and entry markdown hidden', () => {
    const { messages, isRunning } = toThreadMessages(
      [
        { kind: 'assistant_message', text: '<permissions instructions>', role: 'developer' },
        { kind: 'user_message', text: 'Fix the bug.' }
      ],
      false
    );
    const html = renderToStaticMarkup(
      createElement(StreamThread, { messages, isRunning, dataComponents: CODEX_DATA_COMPONENTS })
    );
    expect(html).toContain('Session started · 1 developer note');
    expect(html).toContain('style="display:none');
    expect(html).toContain('Developer instructions');
  });
});

describe('toThreadMessages — running status', () => {
  it('marks the last assistant message running and reports isRunning true while active', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant_message', text: 'a' },
      { kind: 'user_message', text: 'follow-up' },
      { kind: 'assistant_message', text: 'b' }
    ];
    const { messages, isRunning } = toThreadMessages(items, true);
    expect(isRunning).toBe(true);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.status).toEqual({ type: 'complete', reason: 'stop' });
    expect(assistants[1]?.status).toEqual({ type: 'running' });
  });

  it('marks every assistant message complete and reports isRunning false once inactive', () => {
    const { messages, isRunning } = toThreadMessages([{ kind: 'assistant_message', text: 'done' }], false);
    expect(isRunning).toBe(false);
    expect(messages[0]?.status).toEqual({ type: 'complete', reason: 'stop' });
  });
});

describe('toThreadMessages — createdAt', () => {
  it('stamps a user message with its item timestamp', () => {
    const { messages } = toThreadMessages(
      [{ kind: 'user_message', text: 'Fix the bug.', timestamp: '2026-07-10T09:05:00.000Z' }],
      false
    );
    expect(messages[0]?.createdAt).toEqual(new Date('2026-07-10T09:05:00.000Z'));
  });

  it('stamps an assistant run with the timestamp of the item that opened it', () => {
    const { messages } = toThreadMessages(
      [
        { kind: 'assistant_message', text: 'Starting.', timestamp: '2026-07-10T09:00:00.000Z' },
        { kind: 'assistant_message', text: 'Done.', timestamp: '2026-07-10T09:01:00.000Z' }
      ],
      false
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.createdAt).toEqual(new Date('2026-07-10T09:00:00.000Z'));
  });

  it('omits createdAt when the item carries no timestamp', () => {
    const { messages } = toThreadMessages([{ kind: 'assistant_message', text: 'done' }], false);
    expect(messages[0]?.createdAt).toBeUndefined();
  });
});

describe('deriveStatus', () => {
  it('is always "running" while the stream is active, regardless of errors present', () => {
    const items: TranscriptItem[] = [{ kind: 'error', message: 'boom' }];
    expect(deriveStatus(items, true)).toBe('running');
  });

  it('is "success" when inactive with no error signal', () => {
    const items: TranscriptItem[] = [{ kind: 'assistant_message', text: 'done' }];
    expect(deriveStatus(items, false)).toBe('success');
  });

  it('is "error" when inactive and a session-level error item is present', () => {
    const items: TranscriptItem[] = [{ kind: 'error', message: 'boom' }];
    expect(deriveStatus(items, false)).toBe('error');
  });

  it('is "error" when inactive and a tool_call escalated to error severity is present', () => {
    const items: TranscriptItem[] = [toolCall({ severity: 'error', errorLabel: '✗ exit 1' })];
    expect(deriveStatus(items, false)).toBe('error');
  });

  it('is "success" for an empty transcript when inactive', () => {
    expect(deriveStatus([], false)).toBe('success');
  });
});

describe('toThreadMessages + StreamThread — representative transcript render', () => {
  function render(items: TranscriptItem[], isActive = false): string {
    const { messages, isRunning } = toThreadMessages(items, isActive);
    return renderToStaticMarkup(
      createElement(StreamThread, { messages, isRunning, dataComponents: CODEX_DATA_COMPONENTS })
    );
  }

  it('renders a full turn: user message, reasoning, tool call, assistant reply, and a turn boundary', () => {
    const items: TranscriptItem[] = [
      { kind: 'user_message', text: 'Fix the bug.' },
      { kind: 'reasoning', summaryText: 'Investigating.' },
      toolCall({
        name: 'read_file',
        argumentsText: '{"path":"/src/index.ts"}',
        prettyPrinted: true,
        hasOutput: true,
        outputText: 'export function main() {}'
      }),
      { kind: 'assistant_message', text: 'Fixed it.' },
      { kind: 'turn_boundary', turnId: 'turn-1' }
    ];
    const html = render(items);
    expect(html).toContain('class="stream-turn stream-turn--user"');
    expect(html).toContain('Fix the bug.');
    expect(html).toContain('Investigating.');
    expect(html).toContain('read_file');
    expect(html).toContain('/src/index.ts');
    expect(html).toContain('export function main');
    expect(html).toContain('Fixed it.');
    expect(html).toContain('class="stream-boundary stream-boundary--bare" data-boundary-kind="turn"');
    expect(html).toContain('title="turn-1"');
  });

  it('renders a shell tool_call escalated to error with the errorLabel visible', () => {
    const items: TranscriptItem[] = [
      toolCall({
        name: 'shell',
        argsLabel: 'command',
        argumentsText: 'false',
        hasOutput: true,
        outputText: 'command failed\nExit code: 1',
        severity: 'error',
        errorLabel: '✗ exit 1'
      })
    ];
    const html = render(items);
    expect(html).toContain('shell');
    expect(html).toContain('✗ exit 1');
    expect(html).toContain('codicon-error');
  });

  it('renders the event-activity data part with plan_update markdown detail', () => {
    const items: TranscriptItem[] = [
      { kind: 'event_activity', label: 'plan_update', detailText: '- step one\n- step two' }
    ];
    const html = render(items);
    expect(html).toContain('class="cx-event"');
    expect(html).toContain('plan_update');
    expect(html).toContain('<li>step one</li>');
  });

  it('renders the image-note data part with the file-media codicon', () => {
    const html = render([{ kind: 'user_message', text: 'look', imageCount: 1 }]);
    expect(html).toContain('codicon-file-media');
    expect(html).toContain('>Image<');
  });

  it('renders an orphan_output as a labeled raw fallback block', () => {
    const html = render([{ kind: 'orphan_output', callId: 'call-9', outputText: 'stray output' }]);
    expect(html).toContain('output (call call-9)');
    expect(html).toContain('stray output');
  });

  it('renders a session-level error as the shared error-line', () => {
    const html = render([{ kind: 'error', message: 'context window exceeded' }]);
    expect(html).toContain('class="aui-error-line"');
    expect(html).toContain('context window exceeded');
  });

  it('renders unknown_item/malformed with the expected severities', () => {
    const html = render([
      { kind: 'unknown_item', raw: { type: 'x' } },
      { kind: 'malformed', rawLine: '{"broken"' }
    ]);
    expect(html).toContain('codicon-info');
    expect(html).toContain('Unrecognized item');
    expect(html).toContain('codicon-warning');
    expect(html).toContain('Malformed line');
  });
});

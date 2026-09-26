/**
 * Native Codex-to-Cards semantic behavior and visible expanded output.
 * These tests replace assistant-ui message-shape checks with the actual Codex projector and Cards renderer.
 * @summary Codex semantic rows and rendered transcript behavior
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CODEX_PARTS, CODEX_ROWS } from '../src/streams/codex-session/www/components/expanded/CodexPresentation';
import {
  type CodexPayloads,
  type CodexRow,
  codexSessionProjector
} from '../src/streams/codex-session/www/lib/project-session';
import { replayTranscript } from '../src/streams/lib/session/projection';
import { SessionContent } from '../src/streams/lib/session/SessionContent';
import type { NativeTranscriptSource, SessionRow } from '../src/streams/lib/session/types';

function nativeLine(type: string, payload: unknown, seconds = 0): string {
  return JSON.stringify({ timestamp: `2026-09-01T11:00:${String(seconds).padStart(2, '0')}.000Z`, type, payload });
}

function source(lines: readonly string[], isActive = false): NativeTranscriptSource {
  return {
    sourceKey: 'cards/codex/behavior',
    generation: 'native-one',
    lines,
    headLineNumber: 1,
    meta: { lineCount: lines.length, isActive },
    filename: 'rollout.jsonl',
    isLoading: false,
    error: null
  };
}

function project(lines: readonly string[], isActive = false): CodexRow[] {
  return replayTranscript(codexSessionProjector, source(lines, isActive)).rows as CodexRow[];
}

type ProviderRow = Extract<SessionRow<CodexPayloads>, { kind: 'provider' }>;

function providerRows<T extends ProviderRow['providerKind']>(
  rows: readonly CodexRow[],
  kind: T
): Extract<ProviderRow, { providerKind: T }>[] {
  return rows.filter(
    (row): row is Extract<ProviderRow, { providerKind: T }> => row.kind === 'provider' && row.providerKind === kind
  );
}

function tool(rows: readonly CodexRow[], callId: string): Extract<ProviderRow, { providerKind: 'tool' }> | undefined {
  return providerRows(rows, 'tool').find((row) => row.data.callId === callId);
}

function rendered(rows: readonly CodexRow[]): string {
  const open = new Map<string, boolean>();
  for (const row of rows) {
    open.set(row.id, true);
    for (const part of row.parts) open.set(part.id, true);
    if (row.kind === 'provider' && row.providerKind === 'tool') {
      for (const detail of row.data.details) open.set(detail.id, true);
    }
  }
  return renderToStaticMarkup(
    createElement(SessionContent<CodexPayloads>, {
      rows,
      providerParts: CODEX_PARTS,
      providerRows: CODEX_ROWS,
      disclosures: { open, onOpenChange: () => undefined }
    })
  );
}

describe('Codex native semantic projection', () => {
  it('groups leading user and developer instructions, then renders the real prompt and image note', () => {
    const rows = project([
      nativeLine('session_meta', { id: 'thread-x', cwd: '/repo', model_provider: 'openai' }),
      nativeLine('turn_context', { turn_id: 'turn-1', model: 'gpt-5.5', cwd: '/repo' }, 1),
      nativeLine(
        'event_msg',
        { type: 'user_message', message: '# AGENTS.md instructions for /repo\nStay focused.' },
        2
      ),
      nativeLine(
        'response_item',
        {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: '<permissions instructions>\nRead files.\n</permissions instructions>' }
          ]
        },
        3
      ),
      nativeLine(
        'response_item',
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect this image.' },
            { type: 'input_image', image_url: 'file:///tmp/private.png' }
          ]
        },
        4
      )
    ]);
    const start = providerRows(rows, 'sessionStart')[0];
    expect(start?.data).toMatchObject({
      summary: 'Session started · gpt-5.5 · instructions · 1 developer note',
      entries: [
        { label: 'Instructions', text: '# AGENTS.md instructions for /repo\nStay focused.' },
        {
          label: 'Developer instructions',
          text: '<permissions instructions>\nRead files.\n</permissions instructions>'
        }
      ]
    });
    const prompt = rows.find((row) => row.kind === 'message' && row.role === 'user');
    expect(prompt?.parts.some((part) => part.kind === 'text' && part.text === 'Inspect this image.')).toBe(true);
    expect(
      prompt?.parts.some(
        (part) => part.kind === 'provider' && part.providerKind === 'imageNote' && part.data.count === 1
      )
    ).toBe(true);

    const html = rendered(rows);
    expect(html).toContain('Session started · gpt-5.5 · instructions · 1 developer note');
    expect(html).toContain('Developer instructions');
    expect(html).toContain('Inspect this image.');
    expect(html).toContain('codicon-file-media');
  });

  it('keeps reasoning, turn and compaction boundaries, completion time, and non-echo status text', () => {
    const rows = project([
      nativeLine('turn_context', { turn_id: 'turn-2', model: 'gpt-5.5' }),
      nativeLine(
        'response_item',
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Plan.' }],
          content: [{ type: 'reasoning_text', text: 'Check the diff.' }]
        },
        1
      ),
      nativeLine('event_msg', { type: 'task_started', turn_id: 'turn-2' }, 2),
      nativeLine('compacted', { message: 'Earlier work summarized.' }, 3),
      nativeLine(
        'event_msg',
        { type: 'task_complete', duration_ms: 65000, last_agent_message: 'Final status differs.' },
        4
      )
    ]);
    expect(rows.find((row) => row.kind === 'structural' && row.label === 'Reasoning')?.parts).toContainEqual(
      expect.objectContaining({ kind: 'reasoning', text: 'Plan.\n\nCheck the diff.' })
    );
    expect(providerRows(rows, 'boundary').map((row) => row.data.kind)).toEqual(['turn', 'turn', 'compaction']);
    expect(
      rows.some((row) => row.parts.some((part) => part.kind === 'text' && part.text === 'Earlier work summarized.'))
    ).toBe(true);
    expect(providerRows(rows, 'turnTime')[0]?.data.text).toBe('1m 5s');
    expect(providerRows(rows, 'eventActivity')[0]?.data).toMatchObject({
      label: 'Last assistant message',
      detailText: 'Final status differs.'
    });

    const html = rendered(rows);
    expect(html).toContain('Plan.');
    expect(html).toContain('Check the diff.');
    expect(html).toContain('Context compacted');
    expect(html).toContain('1m 5s');
    expect(html).toContain('Final status differs.');
  });

  it('keeps summary-only reasoning visible as a concise line', () => {
    const rows = project([
      nativeLine('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Next** step.' }] })
    ]);
    expect(rows.some((row) => row.parts.some((part) => part.kind === 'text' && part.text === 'Next step.'))).toBe(true);
    expect(rows.some((row) => row.parts.some((part) => part.kind === 'reasoning'))).toBe(false);
    expect(rendered(rows)).toContain('Next step.');
  });

  it('associates native results with their Codex calls while retaining tool details, image notes, and patch failures', () => {
    const rows = project([
      nativeLine('response_item', {
        type: 'local_shell_call',
        call_id: 'shell-1',
        status: 'completed',
        action: { type: 'exec', command: ['cat', 'src/a.ts'] }
      }),
      nativeLine(
        'response_item',
        {
          type: 'function_call_output',
          call_id: 'shell-1',
          output: [
            { type: 'output_text', text: 'old source' },
            { type: 'input_image', image_url: 'file:///tmp/result.png' },
            { type: 'future_output', value: 7 }
          ]
        },
        1
      ),
      nativeLine(
        'response_item',
        {
          type: 'custom_tool_call',
          call_id: 'patch-1',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch'
        },
        2
      ),
      nativeLine(
        'event_msg',
        { type: 'patch_apply_end', call_id: 'patch-1', stdout: '', stderr: 'patch failed', success: false },
        3
      ),
      nativeLine('response_item', { type: 'function_call_output', call_id: 'orphan-1', output: 'detached output' }, 4)
    ]);
    expect(tool(rows, 'shell-1')?.data).toMatchObject({
      name: 'local_shell_call',
      argsLabel: 'command',
      argumentsText: 'cat src/a.ts',
      outputText: 'old source',
      outputImageCount: 1,
      status: 'complete'
    });
    expect(tool(rows, 'patch-1')?.data).toMatchObject({ status: 'error', errorLabel: 'patch failed' });
    expect(tool(rows, 'shell-1')?.data.details.some((detail) => detail.text.includes('future_output'))).toBe(true);
    expect(tool(rows, 'orphan-1')?.data).toMatchObject({ status: 'orphan', outputText: 'detached output' });

    const html = rendered(rows);
    expect(html).toContain('cat src/a.ts');
    expect(html).toContain('old source');
    expect(html).toContain('patch failed');
    expect(html).toContain('future_output');
    expect(html).toContain('detached output');
    expect(html).toContain('codicon-file-media');
  });

  it('preserves one-shot duplicate identity within turns and does not suppress an identical next-turn message', () => {
    const lines = [
      nativeLine('turn_context', { turn_id: 'turn-1' }),
      nativeLine('event_msg', { type: 'agent_message', message: 'Echo.' }, 1),
      nativeLine('event_msg', { type: 'agent_message', message: 'Echo.' }, 2),
      nativeLine(
        'response_item',
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Echo.' }] },
        3
      ),
      nativeLine('turn_context', { turn_id: 'turn-2' }, 4),
      nativeLine(
        'response_item',
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Echo.' }] },
        5
      )
    ];
    const echoes = project(lines).filter((row) => row.kind === 'message' && row.role === 'assistant');
    expect(echoes).toHaveLength(3);
    expect(echoes.map((row) => row.provenance.map((origin) => origin.lineNumber))).toEqual([[2, 4], [3], [6]]);
  });

  it('renders unknown native content and malformed lines as inspectable raw disclosures', () => {
    const rows = project([
      nativeLine('response_item', {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Prompt.' },
          { type: 'future_block', value: { safe: true } }
        ]
      }),
      nativeLine('event_msg', { type: 'future_event', detail: 'retained event' }, 1),
      nativeLine('future_root', { retained: true }, 2),
      '{"malformed":'
    ]);
    const raw = rows.flatMap((row) => row.parts).filter((part) => part.kind === 'raw');
    expect(raw.map((part) => part.text).join('\n')).toContain('future_block');
    expect(raw.map((part) => part.text).join('\n')).toContain('future_event');
    expect(raw.map((part) => part.text).join('\n')).toContain('future_root');
    expect(raw.map((part) => part.text).join('\n')).toContain('{"malformed":');

    const html = rendered(rows);
    expect(html).toContain('Unsupported content · future_block');
    expect(html).toContain('future_event');
    expect(html).toContain('Malformed line');
  });

  it('derives running, error, and completed status from store liveness and native failures', () => {
    const error = nativeLine('event_msg', { type: 'error', message: 'request failed' });
    expect(
      replayTranscript(
        codexSessionProjector,
        source([nativeLine('event_msg', { type: 'agent_message', message: 'Working' })], true)
      ).header.status
    ).toBe('running');
    expect(replayTranscript(codexSessionProjector, source([error], true)).header.status).toBe('running');
    expect(replayTranscript(codexSessionProjector, source([error], false)).header.status).toBe('error');
    expect(
      replayTranscript(codexSessionProjector, source([nativeLine('event_msg', { type: 'task_complete' })], false))
        .header.status
    ).toBe('done');
  });
});

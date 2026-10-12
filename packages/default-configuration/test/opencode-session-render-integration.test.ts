/**
 * Runs native OpenCode JSONL through its parser, incremental reducer, and real Cards expanded renderer.
 * @summary OpenCode projection, replay, lifecycle, and user-visible render integration
 */

import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionHeader } from '../src/streams/lib/SessionHeader';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { SessionViewport } from '../src/streams/lib/session/SessionViewport';
import type {
  NativeTranscriptSource,
  SessionHeaderFacts,
  SessionPart,
  SessionTextPart
} from '../src/streams/lib/session/types';
import {
  OPENCODE_PRESENTATION,
  OpenCodeTool,
  opencodeDisclosureIds,
  opencodeHeaderDisplay
} from '../src/streams/opencode-session/www/components/expanded/OpencodePresentation';
import { parseOpencodeLine } from '../src/streams/opencode-session/www/lib/parser';
import {
  type OpencodePayloads,
  type OpencodeRow,
  opencodeSessionProjector
} from '../src/streams/opencode-session/www/lib/project-session';

const FIXTURE_LINES = readFileSync(new URL('./fixtures/opencode/full-lifecycle.jsonl', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n');

/** Builds one complete native source snapshot with explicit absolute line coordinates.
 * @param lines - Current contiguous native JSONL range.
 * @param overrides - Optional source metadata overrides for focused cases.
 * @returns Caller-qualified native source snapshot.
 */
function source(lines: readonly string[], overrides: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource {
  return {
    sourceKey: 'cards/opencode/render-integration',
    generation: 'fixture-1',
    lines,
    headLineNumber: 1,
    meta: { lineCount: lines.length, isActive: true },
    filename: 'opencode-session.jsonl',
    isLoading: false,
    error: null,
    ...overrides
  };
}

/** Flattens Cards-owned shared and OpenCode typed leaves without position-based identity.
 * @param rows - Projected semantic rows.
 * @returns Shared and provider-typed leaves in row order.
 */
function parts(rows: readonly OpencodeRow[]): SessionPart<OpencodePayloads>[] {
  return rows.flatMap((row) => row.parts);
}

/** Opens each current semantic identity through the public controlled disclosure contract.
 * @param rows - Current semantic rows and leaves.
 * @param closed - Identities deliberately rendered with closed disclosures.
 * @returns Controlled disclosure state for the real renderer.
 */
function expandedDisclosures(rows: readonly OpencodeRow[], closed: ReadonlySet<string> = new Set()) {
  return {
    open: new Map([...opencodeDisclosureIds(rows)].map((id) => [id, !closed.has(id)])),
    onOpenChange: (_id: string, _open: boolean): void => {}
  };
}

/** Renders the real sticky header, Cards viewport, and Cards SessionContent against supplied projection rows.
 * @param rows - Semantic projection to display.
 * @param header - Provider-neutral facts for the shared sticky header.
 * @param closed - Disclosure identities whose native details stay hidden.
 * @returns Server-rendered visible and accessible session markup.
 */
function renderProjection(
  rows: readonly OpencodeRow[],
  header: SessionHeaderFacts,
  closed: ReadonlySet<string> = new Set()
): string {
  const identity = opencodeHeaderDisplay(rows);
  return renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(SessionHeader, {
        model: header.model ?? '',
        cwd: header.cwd ?? '',
        status: header.status === 'done' ? 'success' : (header.status ?? 'running'),
        provider: identity.provider,
        threadId: identity.sessionId
      }),
      createElement(SessionViewport<OpencodePayloads>, {
        rows,
        disclosures: expandedDisclosures(rows, closed),
        providerParts: OPENCODE_PRESENTATION,
        providerRows: OPENCODE_PRESENTATION,
        renderTool: (part, context) => createElement(OpenCodeTool, { part, leaf: part, context }),
        emptyContent: createElement('p', { className: 'session-muted' }, 'No output yet.')
      })
    )
  );
}

/** Serializes one provider envelope with an explicit source event order.
 * @param type - Native OpenCode envelope discriminator.
 * @param data - Native event payload.
 * @param seq - Monotonic event order.
 * @returns Serialized OpenCode JSONL line.
 */
function envelope(type: string, data: unknown, seq: number): string {
  return JSON.stringify({
    v: 1,
    ts: `2026-09-01T10:01:${String(seq).padStart(2, '0')}.000Z`,
    seq,
    sessionId: 'ses-render-test',
    type,
    data
  });
}

describe('OpenCode native projection and Cards rendering integration', () => {
  it('renders the historical native fixture through the real parser, reducer, SessionContent, and viewport', () => {
    const native = source(FIXTURE_LINES, { headLineNumber: 41 });
    const parsedKinds = new Set(FIXTURE_LINES.map((line) => parseOpencodeLine(line).kind));
    expect([...parsedKinds].sort()).toEqual(['idle', 'message', 'meta', 'part', 'unknown']);
    const nativePartTypes = FIXTURE_LINES.flatMap((line) => {
      const parsed = parseOpencodeLine(line);
      return parsed.kind === 'part' && typeof parsed.data.type === 'string' ? [parsed.data.type] : [];
    });
    expect(new Set(nativePartTypes)).toEqual(
      new Set(['file', 'text', 'reasoning', 'tool', 'step-start', 'patch', 'step-finish', 'future-part'])
    );

    const projection = replayTranscript(opencodeSessionProjector, native);
    const allParts = parts(projection.rows);
    expect(projection.header).toMatchObject({ model: 'gpt-5', cwd: '/workspace/opencode', status: 'error' });
    expect(
      projection.rows.filter((row) => row.kind === 'message').map((row) => row.kind === 'message' && row.role)
    ).toEqual(['user', 'assistant']);
    expect(new Set(allParts.filter((part) => part.kind === 'provider').map((part) => part.providerKind))).toEqual(
      new Set(['messageDetails', 'attachment', 'step', 'editedFiles', 'event', 'nativeDetails'])
    );
    expect(allParts.filter((part): part is SessionTextPart => part.kind === 'text').map((part) => part.text)).toEqual([
      'Please inspect this project.',
      '**The project is ready.**'
    ]);
    expect(allParts.filter((part): part is SessionTextPart => part.kind === 'reasoning')).toHaveLength(1);
    expect(allParts.filter((part) => part.kind === 'tool')).toMatchObject([
      { callId: 'call-read-1', status: 'complete', output: '# OpenCode project' },
      { callId: 'call-error-1', status: 'error', output: 'permission denied' }
    ]);
    expect(projection.rows.filter((row) => row.kind === 'structural').map((row) => row.label)).toEqual([
      'Unsupported OpenCode event (future-event)',
      'Turn ended'
    ]);

    const html = renderProjection(projection.rows, projection.header);
    expect(html).toContain('Transcript content');
    expect(html).toContain('gpt-5');
    expect(html).toContain('openai');
    expect(html).toContain('/workspace/opencode');
    expect(html).toContain('Please inspect this project.');
    expect(html).toContain('<strong>The project is ready.</strong>');
    expect(html).toContain('Reasoning');
    expect(html).toContain('Inspecting the project structure.');
    expect(html).toContain('OpenCode text part details');
    expect(html).toContain('OpenCode reasoning part details');
    expect(html).toContain('read · completed');
    expect(html).toContain('bash · failed');
    expect(html).toContain('README.md');
    expect(html).toContain('text/markdown');
    expect(html).toContain('Model step started');
    expect(html).toContain('Model step finished');
    expect(html).toContain('Agent: build');
    expect(html).toContain('Mode: code');
    expect(html).toContain('Started:');
    expect(html).toContain('Completed:');
    expect(html).toContain('Tokens: 42 input · 12 output');
    expect(html).toContain('Edited 2 files');
    expect(html).toContain('one.ts');
    expect(html).toContain('two.ts');
    expect(html).toContain('Change set patch-hash-1');
    expect(html).toContain('permission denied');
    expect(html).toContain('opaque-native-stack');
    expect(html).toContain('Unsupported OpenCode part (future-part)');
    expect(html).toContain('Unsupported OpenCode event (future-event)');
    expect(html).toContain('Turn ended');
    expect(html).not.toContain('href="data:text/markdown');
  });

  it('keeps replay and controlled append renders equivalent through pending, running, and late completed tool output', () => {
    const controller = createTranscriptProjection(opencodeSessionProjector, 'cards/opencode/render-integration');
    let priorToolId: string | undefined;
    for (const [end, label, output] of [
      [8, 'read · pending', undefined],
      [9, 'read · running', undefined],
      [10, 'read · completed', '# OpenCode project']
    ] as const) {
      const snapshot = source(FIXTURE_LINES.slice(0, end));
      const projection = controller.update(snapshot).projection;
      expect(projection).toEqual(replayTranscript(opencodeSessionProjector, snapshot));
      const tool = parts(projection.rows).find((part) => part.kind === 'tool' && part.callId === 'call-read-1');
      expect(tool).toBeDefined();
      if (tool?.kind === 'tool') {
        if (priorToolId) expect(tool.id).toBe(priorToolId);
        priorToolId = tool.id;
      }

      const html = renderProjection(projection.rows, projection.header);
      expect(html).toContain(label);
      if (output) expect(html).toContain(output);
      else expect(html).toContain('README.md');
    }
    controller.dispose();
  });

  it('renders file and patch replacements, safe basenames, malformed native shapes, unknown records, and neighboring text', () => {
    const lines = [
      envelope('message', { id: 'user-1', role: 'user', model: { providerID: 'openai', modelID: 'gpt-5' } }, 1),
      envelope(
        'part',
        { id: 'file-1', messageID: 'user-1', type: 'file', filename: 'notes.txt', mime: 'text/plain' },
        2
      ),
      envelope(
        'part',
        { id: 'file-1', messageID: 'user-1', type: 'file', filename: 'renamed.txt', mime: 'application/json' },
        3
      ),
      envelope(
        'part',
        {
          id: 'patch-1',
          messageID: 'user-1',
          type: 'patch',
          hash: 'sha-1',
          files: ['/work/tree/src/one.ts', 'C:\\Users\\dev\\repo\\two.ts'],
          patches: [{ file: '/work/tree/src/one.ts', diff: '@@ -1 +1 @@' }]
        },
        4
      ),
      envelope('part', { id: 'empty-patch', messageID: 'user-1', type: 'patch', hash: 'empty', files: [] }, 5),
      envelope('part', { id: 'malformed-patch', messageID: 'user-1', type: 'patch', files: '/work/tree/one.ts' }, 6),
      envelope('part', { id: 'bare-file', messageID: 'user-1', type: 'file', filename: 'bare.bin' }, 7),
      envelope('part', { id: 'bad-file', messageID: 'user-1', type: 'file', url: 'data:text/plain,aGk=' }, 8),
      envelope('part', { id: 'future-part', messageID: 'user-1', type: 'starlight', payload: { retained: true } }, 9),
      '{torn-json',
      envelope('telemetry-future', { retained: 'unknown root payload' }, 11),
      envelope(
        'part',
        { id: 'valid-text', messageID: 'user-1', type: 'text', text: 'The neighbor remains visible.' },
        12
      )
    ];
    const projection = replayTranscript(opencodeSessionProjector, source(lines));
    const allParts = parts(projection.rows);
    const attachments = allParts.filter((part) => part.kind === 'provider' && part.providerKind === 'attachment');
    expect(attachments).toHaveLength(2);
    expect(attachments.map((part) => part.kind === 'provider' && part.data.filename)).toEqual([
      'renamed.txt',
      'bare.bin'
    ]);
    const edited = allParts.find((part) => part.kind === 'provider' && part.providerKind === 'editedFiles');
    expect(edited).toMatchObject({
      kind: 'provider',
      data: { files: ['/work/tree/src/one.ts', 'C:\\Users\\dev\\repo\\two.ts'] }
    });
    expect(allParts.filter((part) => part.kind === 'provider' && part.providerKind === 'event')).toHaveLength(4);
    expect(allParts.some((part) => part.kind === 'text' && part.text === 'The neighbor remains visible.')).toBe(true);

    const closedEdited = edited ? new Set([edited.id]) : new Set<string>();
    const collapsed = renderProjection(projection.rows, projection.header, closedEdited);
    expect(collapsed).toContain('renamed.txt');
    expect(collapsed).toContain('bare.bin');
    expect(collapsed).toContain('Edited 2 files');
    expect(collapsed).toContain('one.ts');
    expect(collapsed).toContain('two.ts');
    expect(collapsed).not.toContain('/work/tree/src/one.ts');
    expect(collapsed).not.toContain('Users');
    expect(collapsed).not.toContain('href="data:text/plain');
    expect(collapsed).toContain('Malformed OpenCode patch part');
    expect(collapsed).toContain('Malformed OpenCode file part');
    expect(collapsed).toContain('Unsupported OpenCode part (starlight)');
    expect(collapsed).toContain('Malformed OpenCode record');
    expect(collapsed).toContain('Unsupported OpenCode event (telemetry-future)');
    expect(collapsed).toContain('The neighbor remains visible.');
    expect(collapsed).toContain('gpt-5');

    const expanded = renderProjection(projection.rows, projection.header);
    expect(expanded).toContain('/work/tree/src/one.ts');
    expect(expanded).toContain('unknown root payload');
    expect(expanded).toContain('&quot;retained&quot;');
  });

  it('surfaces idle, positional supersession, session metadata merge, and error precedence in the rendered header', () => {
    const base = [
      envelope('meta', { runtime: 'opencode', opencodeVersion: '1.18.21' }, 1),
      envelope('message', { id: 'assistant-1', role: 'assistant', modelID: 'claude-x', providerID: 'anthropic' }, 2),
      envelope('part', { id: 'text-1', messageID: 'assistant-1', type: 'text', text: 'Turn one.' }, 3),
      envelope('idle', {}, 4),
      envelope('meta', { runtime: 'opencode', opencodeVersion: '1.18.22' }, 5)
    ];
    const idleProjection = replayTranscript(opencodeSessionProjector, source(base));
    expect(idleProjection.header.status).toBe('done');
    expect(idleProjection.rows.filter((row) => row.kind === 'provider' && row.providerKind === 'session')).toHaveLength(
      1
    );
    const idleHtml = renderProjection(idleProjection.rows, idleProjection.header);
    expect(idleHtml).toContain('anthropic');
    expect(idleHtml).toContain('claude-x');
    expect(idleHtml).toContain('Turn ended');
    expect(idleHtml).toContain('1.18.22');
    expect(idleHtml).toContain('2026-09-01T10:01:04.000Z');

    const resumed = replayTranscript(
      opencodeSessionProjector,
      source([...base, envelope('message', { id: 'assistant-2', role: 'assistant' }, 6)])
    );
    expect(resumed.header.status).toBe('running');
    expect(renderProjection(resumed.rows, resumed.header)).toContain('Turn one.');

    const revisedAfterIdle = replayTranscript(
      opencodeSessionProjector,
      source([
        ...base,
        envelope(
          'part',
          { id: 'text-1', messageID: 'assistant-1', type: 'text', text: 'Turn one revised after idle.' },
          6
        )
      ])
    );
    expect(revisedAfterIdle.header.status).toBe('running');
    expect(parts(revisedAfterIdle.rows).filter((part): part is SessionTextPart => part.kind === 'text')).toHaveLength(
      1
    );
    const revisedHtml = renderProjection(revisedAfterIdle.rows, revisedAfterIdle.header);
    expect(revisedHtml).toContain('Turn one revised after idle.');
    expect(revisedHtml).toContain('Turn one.');
    expect(revisedHtml).not.toContain('Turn one.</p>');

    const errored = replayTranscript(
      opencodeSessionProjector,
      source([
        ...base,
        envelope(
          'part',
          {
            id: 'tool-1',
            messageID: 'assistant-2',
            type: 'tool',
            callID: 'call-err',
            tool: 'bash',
            state: { status: 'error', input: { command: 'false' }, error: { message: 'command failed' } }
          },
          7
        )
      ])
    );
    expect(errored.header.status).toBe('error');
    expect(renderProjection(errored.rows, errored.header)).toContain('bash · failed');
    expect(renderProjection(errored.rows, errored.header)).toContain('command failed');
  });
});

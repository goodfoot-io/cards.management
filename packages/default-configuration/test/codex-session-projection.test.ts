/**
 * Fixture-first contract for native Codex projection and Cards-owned rendering.
 * @summary Native Codex rows, replay equivalence, and visible output
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CODEX_PARTS, CODEX_ROWS } from '../src/streams/codex-session/www/components/expanded/CodexPresentation';
import {
  type CodexPayloads,
  type CodexRow,
  codexSessionProjector
} from '../src/streams/codex-session/www/lib/project-session';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { SessionContent } from '../src/streams/lib/session/SessionContent';
import type { NativeTranscriptSource, SessionRow } from '../src/streams/lib/session/types';

const fixture = readFileSync(new URL('./fixtures/codex-session/native-session.jsonl', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n');
const duplicateToolFixture = readFileSync(
  new URL('./fixtures/codex-session/duplicate-tool-results.jsonl', import.meta.url),
  'utf8'
)
  .trimEnd()
  .split('\n');

function source(lines: readonly string[], overrides: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource {
  return {
    sourceKey: 'cards/codex/session',
    generation: 'native-one',
    lines,
    headLineNumber: 1,
    meta: { lineCount: lines.length, isActive: false },
    filename: 'rollout.jsonl',
    isLoading: false,
    error: null,
    ...overrides
  };
}

function projected(rows: readonly SessionRow<CodexPayloads>[]): CodexRow[] {
  return rows as CodexRow[];
}

function provider<T extends keyof CodexPayloads>(
  rows: readonly SessionRow<CodexPayloads>[],
  kind: T
): { data: CodexPayloads[T] }[] {
  const matches: { data: CodexPayloads[T] }[] = [];
  for (const row of rows) {
    if (row.kind === 'provider' && row.providerKind === kind) matches.push({ data: row.data as CodexPayloads[T] });
    for (const part of row.parts) {
      if (part.kind === 'provider' && part.providerKind === kind) matches.push({ data: part.data as CodexPayloads[T] });
    }
  }
  return matches;
}

describe('Codex native session projection', () => {
  it('projects header, preamble, user content, reasoning, tool output, boundaries, and raw variants', () => {
    const projection = replayTranscript(codexSessionProjector, source(fixture));
    expect(projection.header).toMatchObject({ model: 'gpt-5.5', cwd: '/repo' });

    const rows = projected(projection.rows);
    const preamble = provider(rows, 'sessionStart')[0];
    expect(preamble?.data).toMatchObject({
      summary: 'Session started · gpt-5.5 · instructions · 1 developer note',
      entries: [
        { label: 'Instructions', text: '# AGENTS.md instructions for /repo\nKeep changes focused.' },
        {
          label: 'Developer instructions',
          text: '<permissions instructions>\nRead files first.\n</permissions instructions>'
        }
      ]
    });

    const prompt = rows.find(
      (row) =>
        row.kind === 'message' &&
        row.role === 'user' &&
        row.parts.some((part) => part.kind === 'text' && part.text === 'Inspect this image.')
    );
    expect(prompt?.parts.some((part) => part.kind === 'provider' && part.providerKind === 'imageNote')).toBe(true);
    expect(prompt?.parts.some((part) => part.kind === 'raw' && part.text.includes('future_block'))).toBe(true);

    const reason = rows.flatMap((row) => row.parts).find((part) => part.kind === 'reasoning');
    expect(reason).toMatchObject({ text: 'Reviewing patch.\n\nLonger reasoning.' });
    expect(provider(rows, 'tool').map((part) => part.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: 'shell-1',
          name: 'local_shell_call',
          argumentsText: 'cat src/a.ts',
          outputText: 'old source',
          outputImageCount: 1,
          status: 'complete'
        }),
        expect.objectContaining({ callId: 'patch-1', status: 'error', errorLabel: 'patch failed' })
      ])
    );
    expect(
      provider(rows, 'tool').some(
        (part) =>
          part.data.callId === 'orphan-1' && part.data.status === 'orphan' && part.data.outputText === 'detached output'
      )
    ).toBe(true);
    expect(
      rows.some((row) => row.parts.some((part) => part.kind === 'raw' && part.text.includes('future_response_item')))
    ).toBe(true);
    expect(rows.some((row) => row.parts.some((part) => part.kind === 'raw' && part.text === '{"malformed":'))).toBe(
      true
    );
  });

  it('retains first-seen mirror identity and every physical line in a one-shot duplicate pair', () => {
    const rows = projected(replayTranscript(codexSessionProjector, source(fixture)).rows);
    const echoes = rows.filter(
      (row) =>
        row.kind === 'message' &&
        row.role === 'assistant' &&
        row.parts.some((part) => part.kind === 'text' && part.text === 'Echo.')
    );
    expect(echoes).toHaveLength(2);
    expect(echoes[0]?.provenance.map((origin) => origin.lineNumber)).toEqual([6, 8]);
    expect(echoes[1]?.provenance.map((origin) => origin.lineNumber)).toEqual([7]);
  });

  it('keeps duplicate call IDs physically distinct and preserves every result while the latest result wins', () => {
    const rows = projected(replayTranscript(codexSessionProjector, source(duplicateToolFixture)).rows);
    const tools = rows.filter((row) => row.kind === 'provider' && row.providerKind === 'tool');
    expect(tools).toHaveLength(2);
    const first = tools[0]!;
    const second = tools[1]!;
    expect(first).toMatchObject({
      kind: 'provider',
      data: { callId: 'reused-call', name: 'first_tool', outputText: 'first result', status: 'complete' }
    });
    expect(second).toMatchObject({
      kind: 'provider',
      data: {
        callId: 'reused-call',
        name: 'second_tool',
        outputText: 'latest result',
        details: [
          expect.objectContaining({ label: 'Tool call' }),
          expect.objectContaining({ text: expect.stringContaining('second result') }),
          expect.objectContaining({ text: expect.stringContaining('latest result') })
        ]
      }
    });
    expect(first.provenance.map((origin) => origin.lineNumber)).toEqual([1, 2]);
    expect(second.provenance.map((origin) => origin.lineNumber)).toEqual([3, 4, 5]);
    expect(first.id).not.toBe(second.id);
  });

  it('keeps incremental append and full replay semantically equivalent', () => {
    const controller = createTranscriptProjection(codexSessionProjector, 'cards/codex/session');
    const prefix = source(fixture.slice(0, 10));
    controller.update(prefix);
    const appended = controller.update(source(fixture));
    expect(appended.kind).toBe('append');
    expect(appended.projection).toEqual(replayTranscript(codexSessionProjector, source(fixture)));
    controller.dispose();
  });

  it('renders native semantics and inspectable details through real Cards SessionContent', () => {
    const rows = projected(replayTranscript(codexSessionProjector, source(fixture)).rows);
    const open = new Map<string, boolean>();
    for (const row of rows) {
      open.set(row.id, true);
      for (const part of row.parts) open.set(part.id, true);
      if (row.kind === 'provider' && row.providerKind === 'tool') {
        for (const detail of row.data.details) open.set(detail.id, true);
      }
    }
    const html = renderToStaticMarkup(
      createElement(SessionContent<CodexPayloads>, {
        rows,
        providerParts: CODEX_PARTS,
        providerRows: CODEX_ROWS,
        disclosures: { open, onOpenChange: () => undefined }
      })
    );

    expect(html).toContain('Session started · gpt-5.5 · instructions · 1 developer note');
    expect(html).toContain('Developer instructions');
    expect(html).toContain('Inspect this image.');
    expect(html).toContain('codicon-file-media');
    expect(html).toContain('cat src/a.ts');
    expect(html).toContain('old source');
    expect(html).toContain('patch failed');
    expect(html).toContain('future_block');
    expect(html).toContain('future_output');
  });
});

/**
 * Fixture-first contract for native Codex projection and Cards-owned rendering.
 * @summary Native Codex rows, replay equivalence, and visible output
 */

import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CODEX_PARTS, CODEX_ROWS } from '../src/streams/codex-session/www/components/expanded/CodexPresentation';
import {
  type CodexPayloads,
  type CodexRow,
  codexSessionProjector
} from '../src/streams/codex-session/www/lib/project-session';
import { LeafViewState, useOwnedLeafViewState } from '../src/streams/lib/session/leaf-view-state';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { SessionContent } from '../src/streams/lib/session/SessionContent';
import type { NativeTranscriptSource, SessionRow } from '../src/streams/lib/session/types';
import { streamMeta } from './helpers/stream-meta';

const fixture = readFileSync(new URL('./fixtures/codex-session/native-session.jsonl', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n');
const duplicateToolFixture = readFileSync(
  new URL('./fixtures/codex-session/duplicate-tool-results.jsonl', import.meta.url),
  'utf8'
)
  .trimEnd()
  .split('\n');
const currentRolloutFixture = readFileSync(
  new URL('./fixtures/codex-session/current-rollout-records.jsonl', import.meta.url),
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
    meta: streamMeta({ lineCount: lines.length, isActive: false }),
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

function renderSession(rows: readonly CodexRow[], openIds: readonly string[] = []): string {
  return renderToStaticMarkup(
    createElement(SessionContent<CodexPayloads>, {
      rows,
      providerParts: CODEX_PARTS,
      providerRows: CODEX_ROWS,
      disclosures: { open: new Map(openIds.map((id) => [id, true])), onOpenChange: () => undefined }
    })
  );
}

/**
 * Seeds a real shared inspection owner at one page to verify retained tail content.
 * @param rows - Native Codex semantic rows.
 * @param openIds - Controlled disclosures to open during rendering.
 * @param detail - Inspection page to seed in the real shared owner.
 * @param detail.id - Stable leaf or tool row identity.
 * @param detail.slot - Independent inspection slot within that identity.
 * @param detail.page - Zero-based page to render.
 * @returns Static markup from the real shared renderer at the selected page.
 */
function renderSessionAtPage(
  rows: readonly CodexRow[],
  openIds: readonly string[],
  detail: { id: string; slot: string; page: number }
): string {
  const disclosures = { open: new Map(openIds.map((id) => [id, true])), onOpenChange: () => undefined };
  function SeededSession(): ReactElement {
    const state = useOwnedLeafViewState(rows, disclosures);
    state.pages.set(detail.id, new Map([[detail.slot, detail.page]]));
    return createElement(
      LeafViewState.Provider,
      { value: state },
      createElement(SessionContent<CodexPayloads>, {
        rows,
        providerParts: CODEX_PARTS,
        providerRows: CODEX_ROWS,
        disclosures
      })
    );
  }
  return renderToStaticMarkup(createElement(SeededSession));
}

describe('Codex native session projection', () => {
  it('projects header, preamble, user content, reasoning, tool output, boundaries, and raw variants', () => {
    const projection = replayTranscript(codexSessionProjector, source(fixture));
    expect(projection.header).toMatchObject({
      model: 'gpt-5.5',
      cwd: '/repo',
      provider: 'openai',
      threadId: 'thread-1'
    });

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

  it('keeps every appended prefix equivalent to replay without mutating earlier snapshots', () => {
    const taskUpdates = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Late answer' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Late answer' } })
    ];
    const associationUpdates = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'late-call', output: 'Orphan' }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'local_shell_call',
          call_id: 'late-call',
          status: 'completed',
          action: { type: 'exec', command: ['echo', 'late'] }
        }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'late-call', output: 'Associated' }
      })
    ];
    for (const lines of [fixture, duplicateToolFixture, taskUpdates, associationUpdates]) {
      const controller = createTranscriptProjection(codexSessionProjector, 'cards/codex/session');
      let previous = controller.update(source([])).projection;
      for (let length = 1; length <= lines.length; length++) {
        const frozen = JSON.stringify(previous);
        const nextSource = source(lines.slice(0, length));
        const next = controller.update(nextSource).projection;
        expect(next).toEqual(replayTranscript(codexSessionProjector, nextSource));
        expect(JSON.stringify(previous)).toBe(frozen);
        previous = next;
      }
      const metadata = controller.update(
        source(lines, { meta: streamMeta({ lineCount: lines.length, isActive: true }) })
      );
      expect(metadata.projection.rows).toEqual(previous.rows);
      for (let index = 0; index < previous.rows.length; index++) {
        expect(metadata.projection.rows[index]).toBe(previous.rows[index]);
      }
      controller.dispose();
    }
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

  it('retains historical provider identity through append and metadata, and resets it with the native source', () => {
    const controller = createTranscriptProjection(codexSessionProjector, 'cards/codex/session');
    const original = source(fixture);
    const header = controller.update(original).projection.header;
    expect(header).toMatchObject({ provider: 'openai', threadId: 'thread-1' });
    const appended = source([
      ...fixture,
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'appended' } })
    ]);
    expect(controller.update(appended).projection.header).toEqual(header);
    const metadata = controller.update({
      ...appended,
      meta: streamMeta({ lineCount: appended.lines.length, isActive: true })
    });
    expect(metadata.projection.header).toMatchObject({ provider: 'openai', threadId: 'thread-1', status: 'running' });
    const reset = controller.update({ ...source([]), generation: 'replacement' });
    expect(reset.projection.header.provider).toBeUndefined();
    expect(reset.projection.header.threadId).toBeUndefined();
    const history = controller.update(original).projection;
    expect(history.header).toEqual(header);
    expect(history).toEqual(replayTranscript(codexSessionProjector, original));
    controller.dispose();
  });

  it('keeps five-megabyte tool arguments raw until opened and exposes bounded paging', () => {
    const tail = 'tail-marker';
    const endPadding = 'y'.repeat(100);
    const largeValue = `${'x'.repeat(5 * 1024 * 1024 - tail.length - endPadding.length)}${tail}${endPadding}`;
    const argumentsText = `{"value":"${largeValue}"}`;
    const nativeLine = JSON.stringify({
      timestamp: '2026-09-26T12:00:00Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'large_tool',
        call_id: 'large-tool-call',
        arguments: argumentsText
      }
    });
    const rows = projected(replayTranscript(codexSessionProjector, source([nativeLine])).rows);
    const tool = rows.find((row) => row.kind === 'provider' && row.providerKind === 'tool');
    expect(tool?.kind).toBe('provider');
    if (!tool || tool.kind !== 'provider' || tool.providerKind !== 'tool') throw new Error('Expected Codex tool row');
    expect(tool.data.argumentsText).toBe(argumentsText);
    expect(tool.data.prettyPrinted).toBe(false);
    expect(tool.data.details[0]?.text).toBe(nativeLine);

    const closed = renderSession(rows);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed.length).toBeLessThan(2_000);
    const opened = renderSession(rows, [tool.id]);
    expect(opened).toContain(`of ${argumentsText.length}`);
    expect(opened).toContain('Next');
    expect(opened).toContain(largeValue.slice(0, 100));
    expect(opened.length).toBeLessThan(70_000);
    expect(tool.data.argumentsText.endsWith(`${tail}${endPadding}"}`)).toBe(true);
    const lastPageIndex = Math.ceil(argumentsText.length / 4096) - 1;
    const tailPage = renderSessionAtPage(rows, [tool.id], {
      id: tool.id,
      slot: 'input',
      page: lastPageIndex - 1
    });
    expect(tailPage).toContain('Next');
    expect(tailPage).toContain(tail);
    expect(tailPage.length).toBeLessThan(70_000);
    const lastPage = renderSessionAtPage(rows, [tool.id], { id: tool.id, slot: 'input', page: lastPageIndex });
    expect(lastPage).toContain('Previous');
    expect(lastPage).toContain(endPadding.slice(-8));
    expect(lastPage.length).toBeLessThan(70_000);
  });

  it('retains a five-megabyte unsupported payload as native JSONL and pages its opened detail', () => {
    const tail = 'tail-marker';
    const endPadding = 'y'.repeat(100);
    const largeValue = `${'u'.repeat(5 * 1024 * 1024 - tail.length - endPadding.length)}${tail}${endPadding}`;
    const nativeLine = JSON.stringify({
      timestamp: '2026-09-26T12:00:00Z',
      type: 'response_item',
      payload: { type: 'future_large_variant', content: { value: largeValue } }
    });
    const rows = projected(replayTranscript(codexSessionProjector, source([nativeLine])).rows);
    const raw = rows.flatMap((row) => row.parts).find((part) => part.kind === 'raw');
    expect(raw?.kind).toBe('raw');
    if (!raw || raw.kind !== 'raw') throw new Error('Expected unsupported raw detail');
    expect(raw.text).toBe(nativeLine);

    const closed = renderSession(rows);
    expect(closed.length).toBeLessThan(2_000);
    const opened = renderSession(rows, [raw.id]);
    expect(opened).toContain(`of ${nativeLine.length}`);
    expect(opened).toContain('Next');
    expect(opened).toContain(largeValue.slice(0, 100));
    expect(opened.length).toBeLessThan(70_000);
    expect(raw.text.endsWith(`${tail}${endPadding}"}}}`)).toBe(true);
    const lastPageIndex = Math.ceil(nativeLine.length / 4096) - 1;
    const lastPage = renderSessionAtPage(rows, [raw.id], { id: raw.id, slot: 'content', page: lastPageIndex });
    expect(lastPage).toContain('Previous');
    expect(lastPage).toContain(tail);
    expect(lastPage).toContain(endPadding.slice(-8));
    expect(lastPage.length).toBeLessThan(70_000);
  });

  it('defers oversized object-shaped search arguments until the tool disclosure opens', () => {
    const tail = 'search-tail';
    const endPadding = 'y'.repeat(100);
    const largeValue = `${'s'.repeat(5 * 1024 * 1024 - tail.length - endPadding.length)}${tail}${endPadding}`;
    const nativeLine = JSON.stringify({
      timestamp: '2026-09-26T12:00:00Z',
      type: 'response_item',
      payload: {
        type: 'tool_search_call',
        call_id: 'large-search',
        execution: 'search',
        arguments: { query: largeValue }
      }
    });
    const formattedInput = JSON.stringify({ query: largeValue }, null, 2) ?? '';
    const rows = projected(replayTranscript(codexSessionProjector, source([nativeLine])).rows);
    const tool = rows.find((row) => row.kind === 'provider' && row.providerKind === 'tool');
    if (!tool || tool.kind !== 'provider' || tool.providerKind !== 'tool') throw new Error('Expected Codex tool row');
    expect(tool.data.deferredArgumentsRecord).toBe(nativeLine);
    expect(tool.data.argumentsText).toBe('');

    const closed = renderSession(rows);
    expect(closed.length).toBeLessThan(2_000);
    const open = renderSession(rows, [tool.id]);
    expect(open).toContain(`of ${formattedInput.length}`);
    expect(open).toContain('Next');
    expect(open).not.toContain(largeValue);
    expect(open.length).toBeLessThan(70_000);
    const lastPage = Math.ceil(formattedInput.length / 4096) - 1;
    const tailPage = renderSessionAtPage(rows, [tool.id], {
      id: tool.id,
      slot: 'input',
      page: lastPage - 1
    });
    expect(tailPage).toContain('Next');
    expect(tailPage).toContain(tail);
    expect(tailPage.length).toBeLessThan(70_000);
  });

  it('retains oversized MCP event details as native JSONL and bounds their rendered page', () => {
    const largeValue = 'm'.repeat(5 * 1024 * 1024);
    const nativeLine = JSON.stringify({
      timestamp: '2026-09-26T12:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'large-mcp-result',
        invocation: { server: 'large-server', tool: 'large-tool', arguments: { query: largeValue } },
        result: { content: largeValue }
      }
    });
    const rows = projected(replayTranscript(codexSessionProjector, source([nativeLine])).rows);
    const activity = provider(rows, 'eventActivity')[0];
    expect(activity?.data.detailText).toBe(nativeLine);
    const html = renderSession(rows);
    expect(html).toContain(`of ${nativeLine.length}`);
    expect(html).toContain('Next');
    expect(html).toContain(largeValue.slice(0, 100));
    expect(html.length).toBeLessThan(70_000);
  });

  it('renders current rollout context records and omits token accounting instead of reporting them unrecognized', () => {
    const rows = projected(replayTranscript(codexSessionProjector, source(currentRolloutFixture)).rows);
    const contexts = provider(rows, 'sessionContext').map(({ data }) => data.label);
    expect(contexts).toEqual([
      'Session context · gpt-fixture · AGENTS.md · environment · skills · permissions',
      'Thread settings · gpt-fixture · openai · reasoning medium · approval never'
    ]);
    // Token usage records repeat the token_count accounting that the transcript already leaves to the compact card.
    const lineNumbers = new Set(rows.flatMap((row) => row.provenance.map((origin) => origin.lineNumber)));
    expect(lineNumbers.has(9)).toBe(false);
    expect(lineNumbers.has(14)).toBe(false);
    const contextIds = rows
      .filter((row) => row.kind === 'provider' && row.providerKind === 'sessionContext')
      .map((row) => row.id);
    const html = renderSession(rows, contextIds);
    expect(html).not.toContain('Unrecognized');
    expect(html).not.toContain('Unsupported event');
    expect(html).toContain('Fixture AGENTS.md');
    expect(html).toContain('pragmatic');
    expect(html).toContain('The host is still unreachable.');
    expect(renderSession(rows)).not.toContain('Fixture AGENTS.md');
  });
});

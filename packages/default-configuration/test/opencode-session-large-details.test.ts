/**
 * Pins large OpenCode tool input/result inspection and bounded compact extraction.
 * @summary Large native tool details stay source-backed and bounded
 */

import { readFileSync } from 'node:fs';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionHeader } from '../src/streams/lib/SessionHeader';
import { createTranscriptProjection } from '../src/streams/lib/session/projection';
import { SessionViewport } from '../src/streams/lib/session/SessionViewport';
import type {
  NativeTranscriptSource,
  SessionHeaderFacts,
  SessionPart,
  SessionToolPart
} from '../src/streams/lib/session/types';
import {
  OPENCODE_PRESENTATION,
  OpenCodeTool,
  opencodeDisclosureIds,
  opencodeHeaderDisplay
} from '../src/streams/opencode-session/www/components/expanded/OpencodePresentation';
import {
  opencodeNativeUpdateEntries,
  opencodeNativeUpdateLines
} from '../src/streams/opencode-session/www/lib/native-updates';
import { parseOpencodeLine } from '../src/streams/opencode-session/www/lib/parser';
import {
  type OpencodePayloads,
  type OpencodeRow,
  opencodeSessionProjector
} from '../src/streams/opencode-session/www/lib/project-session';
import { extractToolPart, toolOutputText } from '../src/streams/opencode-session/www/lib/tool-part';

const PAYLOAD_SIZE = 5 * 1024 * 1024;
const FIXTURE_TEMPLATE = readFileSync(
  new URL('./fixtures/opencode/large-tool-lifecycle.template.jsonl', import.meta.url),
  'utf8'
).trimEnd();

/** Expands fixture sentinels into valid native objects with distinct end markers.
 * @returns Native fixture lines containing five MiB input and result objects.
 */
function oversizedFixtureLines(): string[] {
  const input = `{"payload":"${'i'.repeat(PAYLOAD_SIZE)}","tail":"input-sentinel"}`;
  const result = `{"payload":"${'r'.repeat(PAYLOAD_SIZE)}","tail":"result-sentinel"}`;
  return FIXTURE_TEMPLATE.replaceAll('__LARGE_INPUT__', input).replace('__LARGE_RESULT__', result).split('\n');
}

/** Creates a complete OpenCode source snapshot for the native fixture range.
 * @param lines - Contiguous source lines supplied by the fixture.
 * @param overrides - Optional source metadata overrides for a focused case.
 * @returns Complete source snapshot with stable identity and provenance.
 */
function source(lines: readonly string[], overrides: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource {
  return {
    sourceKey: 'cards/opencode/large-tool',
    generation: 'fixture-large-1',
    lines,
    headLineNumber: 1,
    meta: { lineCount: lines.length, isActive: true },
    filename: 'opencode-session.jsonl',
    isLoading: false,
    error: null,
    ...overrides
  };
}

/** Flattens the projected OpenCode message parts without relying on row positions.
 * @param rows - Projected OpenCode message rows.
 * @returns Semantic parts in row order.
 */
function parts(rows: readonly OpencodeRow[]): SessionPart<OpencodePayloads>[] {
  return rows.flatMap((row) => row.parts);
}

/** Renders actual Cards SessionContent in its owning viewport with controlled disclosures.
 * @param rows - Semantic projection rows to display.
 * @param header - Provider-neutral header facts.
 * @param closed - Disclosure ids kept collapsed for this render.
 * @returns Server-rendered Cards session markup.
 */
function renderProjection(
  rows: readonly OpencodeRow[],
  header: SessionHeaderFacts,
  closed: ReadonlySet<string> = new Set()
): string {
  const identity = opencodeHeaderDisplay(rows);
  const disclosures = {
    open: new Map([...opencodeDisclosureIds(rows)].map((id) => [id, !closed.has(id)])),
    onOpenChange: (_id: string, _open: boolean): void => {}
  };
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
        disclosures,
        providerParts: OPENCODE_PRESENTATION,
        providerRows: OPENCODE_PRESENTATION,
        renderTool: (part, context) => createElement(OpenCodeTool, { part, leaf: part, context }),
        emptyContent: createElement('p', { className: 'session-muted' }, 'No output yet.')
      })
    )
  );
}

/** Identifies direct attempts to serialize the oversized decoded JSON object.
 * @param value - Value passed to JSON.stringify.
 * @returns Whether any own property contains the fixture-sized payload.
 */
function serializesOversizedObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value).some((child) => typeof child === 'string' && child.length === PAYLOAD_SIZE)
  );
}

describe('OpenCode oversized tool details', () => {
  it('keeps 5 MiB input and result bounded through pending, running, and completed projection updates', () => {
    const lines = oversizedFixtureLines();
    const controller = createTranscriptProjection(opencodeSessionProjector, 'cards/opencode/large-tool');
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      const pending = controller.update(source(lines.slice(0, 2))).projection;
      expect((parts(pending.rows).find((part) => part.kind === 'tool') as SessionToolPart).status).toBe('pending');

      const running = controller.update(source(lines.slice(0, 3))).projection;
      expect((parts(running.rows).find((part) => part.kind === 'tool') as SessionToolPart).status).toBe('running');

      const completed = controller.update(source(lines)).projection;
      const tool = parts(completed.rows).find((part) => part.kind === 'tool') as SessionToolPart;
      expect(tool.status).toBe('complete');
      expect(tool.input.length).toBeLessThan(4096);
      expect(tool.output?.length).toBeLessThan(4096);
      expect(stringify.mock.calls.some(([value]) => serializesOversizedObject(value))).toBe(false);

      const detail = parts(completed.rows).find(
        (part) => part.kind === 'provider' && part.providerKind === 'nativeDetails'
      );
      expect(detail?.kind).toBe('provider');
      if (detail?.kind !== 'provider' || detail.providerKind !== 'nativeDetails') {
        throw new Error('Projected tool is missing its native source details');
      }
      const rawLines = opencodeNativeUpdateLines(detail.data.nativeUpdates);
      expect(opencodeNativeUpdateEntries(detail.data.nativeUpdates).map(({ lineNumber }) => lineNumber)).toEqual([
        2, 3, 4
      ]);
      expect(rawLines).toHaveLength(3);
      expect(rawLines[0]).toBe(lines[1]);
      expect(rawLines[1]).toBe(lines[2]);
      expect(rawLines[2]).toBe(lines[3]);
      expect(rawLines[2]).toContain('input-sentinel');
      expect(rawLines[2]).toContain('result-sentinel');

      const collapsed = renderProjection(completed.rows, completed.header, opencodeDisclosureIds(completed.rows));
      expect(collapsed.length).toBeLessThan(20_000);
      expect(collapsed).not.toContain('input-sentinel');
      expect(collapsed).not.toContain('result-sentinel');

      const opened = renderProjection(completed.rows, completed.header);
      expect(opened.length).toBeLessThan(100_000);
      expect(opened).toContain(`Characters 1–16384 of ${rawLines[0]!.length}`);
      expect(opened).toContain(`Characters 1–16384 of ${rawLines[2]!.length}`);
      expect(opened).toContain('Next');
      expect(opened).not.toContain('input-sentinel');
      expect(opened).not.toContain('result-sentinel');
    } finally {
      stringify.mockRestore();
      controller.dispose();
    }
  });

  it('bounds compact argument extraction without stringifying the full 5 MiB object', () => {
    const lines = oversizedFixtureLines();
    const parsed = parseOpencodeLine(lines[3]!);
    expect(parsed.kind).toBe('part');
    if (parsed.kind !== 'part') throw new Error('Fixture tool line did not parse as a native part');
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      const extracted = extractToolPart(parsed.data);
      expect(extracted.argumentsText).toHaveLength(4001);
      expect(extracted.argumentsText.endsWith('…')).toBe(true);
      expect(extracted.outputText).toHaveLength(4001);
      expect(stringify.mock.calls.some(([value]) => serializesOversizedObject(value))).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('keeps compact pretty summaries identical for small structured values', () => {
    for (const value of [
      {},
      [{ nested: true }, null, 'escaped\ntext'],
      JSON.parse('{"toString":"own key","constructor":"another own key","value":"😀"}')
    ]) {
      expect(toolOutputText(value)).toBe(JSON.stringify(value, null, 2));
    }
  });
});

/**
 * Real OpenCode replay witnesses retained snapshots and delimiter-bearing native IDs.
 * @summary OpenCode immutable provenance and compound identity regressions
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { SessionContent } from '../src/streams/lib/session/SessionContent';
import type { NativeTranscriptSource } from '../src/streams/lib/session/types';
import { OPENCODE_PRESENTATION } from '../src/streams/opencode-session/www/components/expanded/OpencodePresentation';
import type { OpencodePayloads } from '../src/streams/opencode-session/www/lib/project-session';
import { opencodeSessionProjector } from '../src/streams/opencode-session/www/lib/project-session';

function source(lines: readonly string[]): NativeTranscriptSource {
  return {
    sourceKey: 'review/opencode',
    generation: 'one',
    lines,
    headLineNumber: 1,
    filename: 'review.jsonl',
    meta: null,
    isLoading: false,
    error: null
  };
}
function envelope(type: string, data: unknown): string {
  return JSON.stringify({ v: 1, type, data, sessionId: 'review', seq: 1 });
}
const cases = [
  ['session', envelope('meta', { runtime: 'opencode' })],
  ['message', envelope('message', { id: 'm', role: 'assistant' })],
  ...[
    { type: 'text', text: 'retained' },
    { type: 'reasoning', text: 'retained' },
    {
      type: 'tool',
      callID: 'call',
      tool: 'read',
      state: { status: 'completed', input: { path: 'FIRST.txt' }, output: 'retained' }
    },
    { type: 'patch', files: ['FIRST.txt'] },
    { type: 'file', filename: 'FIRST.txt' },
    { type: 'step-start' },
    { type: 'step-finish' },
    { type: 'future', payload: 'retained' },
    { type: 'text', text: 42 },
    { type: 'file' },
    { type: 'patch', files: null },
    { payload: 'malformed' }
  ].map((data, index) => [`part-${index}`, envelope('part', { id: 'p', messageID: 'm', ...data })] as const)
] as const;

describe('OpenCode review invariants', () => {
  it.each(cases)('keeps every published %s snapshot immutable while retaining replay equivalence', (_label, line) => {
    const controller = createTranscriptProjection(opencodeSessionProjector, 'review/opencode');
    const old = controller.update(source([line])).projection;
    const serialized = JSON.stringify(old);
    const appended = controller.update(source([line, line])).projection;
    expect(JSON.stringify(old)).toBe(serialized);
    expect(appended).toEqual(replayTranscript(opencodeSessionProjector, source([line, line])));
    expect(
      old.rows.flatMap((row) => [row, ...row.parts]).every((leaf) => leaf.provenance.every((p) => p.lineNumber === 1))
    ).toBe(true);
    controller.dispose();
  });

  it.each([
    'text',
    'tool'
  ])('qualifies %s native tuples without delimiter collisions across append and reset', (type) => {
    const lines = [
      ['a/b', 'c', 'FIRST.txt'],
      ['a', 'b/c', 'SECOND.txt']
    ].map(([messageID, identity, text], index) =>
      envelope(
        'part',
        type === 'text'
          ? { type, messageID, id: identity, text }
          : {
              type,
              messageID,
              id: `p${index + 1}`,
              callID: identity,
              tool: 'read',
              state: { status: 'completed', input: { path: text } }
            }
      )
    );
    const controller = createTranscriptProjection(opencodeSessionProjector, 'review/opencode');
    const initial = controller.update(source(lines)).projection;
    const leaves = initial.rows.flatMap((row) => row.parts);
    expect(new Set(leaves.map((leaf) => leaf.id)).size).toBe(leaves.length);
    expect(new Set(leaves.map((leaf) => leaf.semanticKey)).size).toBe(leaves.length);
    const updated = controller.update(source([...lines, lines[0]!])).projection;
    expect(updated.rows.flatMap((row) => row.parts).map((leaf) => leaf.id)).toEqual(leaves.map((leaf) => leaf.id));
    expect(updated).toEqual(replayTranscript(opencodeSessionProjector, source([...lines, lines[0]!])));
    const reset = controller.update({ ...source(lines), generation: 'two' }).projection;
    expect(reset.rows.flatMap((row) => row.parts).every((leaf) => !leaves.some((old) => old.id === leaf.id))).toBe(
      true
    );
    controller.dispose();
  });
});

const historyCases = [
  ['session', 'meta', { runtime: 'opencode' }],
  ['messageDetails', 'message', { id: 'm', role: 'assistant' }],
  ['attachment', 'part', { id: 'p', messageID: 'm', type: 'file', filename: 'FIRST.txt' }],
  ['editedFiles', 'part', { id: 'p', messageID: 'm', type: 'patch', files: ['FIRST.txt'] }],
  ['step', 'part', { id: 'p', messageID: 'm', type: 'step-start' }],
  ['event', 'part', { id: 'p', messageID: 'm', type: 'future' }],
  ['nativeDetails', 'part', { id: 'p', messageID: 'm', type: 'text', text: 'visible' }]
] as const;

describe('OpenCode retained owner reuse', () => {
  it('reuses an unrelated row and its provenance while updating a neighboring native entity', () => {
    const first = envelope('part', { id: 'first', messageID: 'm1', type: 'text', text: 'first' });
    const second = envelope('part', { id: 'second', messageID: 'm2', type: 'text', text: 'second' });
    const controller = createTranscriptProjection(opencodeSessionProjector, 'review/opencode');
    const old = controller.update(source([first, second])).projection;
    const neighbor = old.rows[1]!;
    const updated = controller.update(source([first, second, first])).projection;
    expect(updated.rows[1]).toBe(neighbor);
    expect(updated.rows[1]!.parts).toBe(neighbor.parts);
    expect(updated.rows[1]!.provenance).toBe(neighbor.provenance);
    controller.dispose();
  });

  it('keeps details, conflict and malformed identities distinct for delimiter and quote-bearing native tuples', () => {
    const tuples = [
      ['a/b', 'c'],
      ['a', 'b/c'],
      ['a"/', '[c]'],
      ['a', '"/[c]']
    ];
    const lines = tuples.flatMap(([messageID, id]) => [
      envelope('part', { id, messageID, type: 'text', text: 'first' }),
      envelope('part', { id, messageID, type: 'reasoning', text: 'conflict' }),
      envelope('part', { id, messageID, payload: 'malformed' })
    ]);
    const projection = replayTranscript(opencodeSessionProjector, source(lines));
    const leaves = projection.rows.flatMap((row) => row.parts);
    expect(new Set(leaves.map((leaf) => leaf.id)).size).toBe(leaves.length);
    expect(leaves.filter((leaf) => leaf.kind === 'text')).toHaveLength(tuples.length);
    expect(leaves.filter((leaf) => leaf.kind === 'provider' && leaf.providerKind === 'nativeDetails')).toHaveLength(
      tuples.length
    );
    expect(leaves.filter((leaf) => leaf.kind === 'provider' && leaf.providerKind === 'event')).toHaveLength(
      tuples.length * 2
    );
  });
});

describe('OpenCode revision inspection bounds', () => {
  it.each(
    historyCases
  )('mounts one bounded native revision for %s across 1000 retained updates', (kind, type, data) => {
    const lines = Array.from({ length: 1000 }, (_, index) =>
      envelope(type, { ...data, payload: 'x'.repeat(5000), revision: index })
    );
    const projection = replayTranscript(opencodeSessionProjector, source(lines));
    const leaf = [...projection.rows, ...projection.rows.flatMap((row) => row.parts)].find(
      (row) => row.kind === 'provider' && row.providerKind === kind
    )!;
    const html = renderToStaticMarkup(
      createElement(SessionContent<OpencodePayloads>, {
        rows: projection.rows,
        providerParts: OPENCODE_PRESENTATION,
        providerRows: OPENCODE_PRESENTATION,
        disclosures: { open: new Map([[leaf.id, true]]), onOpenChange: () => undefined }
      })
    );
    expect(html.match(/class="session-raw"/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(12000);
    expect(html).toContain('Update 1 of 1000');
    expect(html).toContain('Next update');
  });
});

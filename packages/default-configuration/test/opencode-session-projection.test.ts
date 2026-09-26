/**
 * OpenCode native fixtures define semantic and incremental projection behavior before renderer migration.
 * @summary OpenCode parser, replay, identity, lifecycle and raw-detail contracts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import type { NativeTranscriptSource, SessionPart, SessionToolPart } from '../src/streams/lib/session/types';
import { opencodeNativeUpdateLines } from '../src/streams/opencode-session/www/lib/native-updates';
import { parseOpencodeLine } from '../src/streams/opencode-session/www/lib/parser';
import type { OpencodePayloads } from '../src/streams/opencode-session/www/lib/project-session';
import { opencodeSessionProjector } from '../src/streams/opencode-session/www/lib/project-session';

const FIXTURE = readFileSync(new URL('./fixtures/opencode/full-lifecycle.jsonl', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n');

/** Builds a complete source snapshot using absolute native coordinates.
 * @param lines - Current contiguous native JSONL range.
 * @param overrides - Optional source metadata overrides for focused cases.
 * @returns Caller-qualified source snapshot.
 */
function source(lines: readonly string[], overrides: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource {
  return {
    sourceKey: 'card/opencode/session-1',
    generation: 'native-store',
    lines,
    headLineNumber: 1,
    meta: { lineCount: lines.length, isActive: true },
    filename: 'opencode-session.jsonl',
    isLoading: false,
    error: null,
    ...overrides
  };
}

/** Flattens stable shared/provider leaves from top-level semantic rows.
 * @param rows - Projected semantic rows.
 * @returns Shared and OpenCode-typed leaves in row order.
 */
function parts(rows: readonly { parts: readonly SessionPart<OpencodePayloads>[] }[]): SessionPart<OpencodePayloads>[] {
  return rows.flatMap((row) => row.parts);
}

/** Selects shared tool leaves without depending on filtered positions.
 * @param rows - Projected semantic rows.
 * @returns Tool lifecycle leaves in source order.
 */
function tools(rows: readonly { parts: readonly SessionPart<OpencodePayloads>[] }[]): SessionToolPart[] {
  return parts(rows).filter((part): part is SessionToolPart => part.kind === 'tool');
}

function envelope(type: string, data: unknown, seq: number, sessionId = 'ses-opencode-test'): string {
  return JSON.stringify({
    v: 1,
    ts: `2026-09-01T10:00:${String(seq).padStart(2, '0')}.000Z`,
    seq,
    sessionId,
    type,
    data
  });
}

describe('OpenCode native projection contract', () => {
  it('projects the full historical fixture into semantic rows with provenance and inspectable details', () => {
    const snapshot = source(FIXTURE, { headLineNumber: 41 });
    const projection = replayTranscript(opencodeSessionProjector, snapshot);

    expect(projection.header).toMatchObject({ model: 'gpt-5', cwd: '/workspace/opencode', status: 'error' });
    expect(projection.rows.some((row) => row.kind === 'message' && row.role === 'user')).toBe(true);
    expect(projection.rows.some((row) => row.kind === 'message' && row.role === 'assistant')).toBe(true);
    expect(
      parts(projection.rows)
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
    ).toContain('Please inspect this project.');
    expect(
      parts(projection.rows)
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
    ).toContain('**The project is ready.**');
    expect(
      parts(projection.rows)
        .filter((part) => part.kind === 'reasoning')
        .map((part) => part.text)
    ).toContain('Inspecting the project structure.');

    expect(tools(projection.rows).map(({ callId, status, output }) => [callId, status, output])).toEqual([
      ['call-read-1', 'complete', '# OpenCode project'],
      ['call-error-1', 'error', 'permission denied']
    ]);
    expect(tools(projection.rows)[0]!.provenance.map((entry) => entry.lineNumber)).toEqual([48, 49, 50]);
    expect(parts(projection.rows).some((part) => part.kind === 'provider' && part.providerKind === 'attachment')).toBe(
      true
    );
    expect(parts(projection.rows).some((part) => part.kind === 'provider' && part.providerKind === 'editedFiles')).toBe(
      true
    );
    expect(
      parts(projection.rows).filter((part) => part.kind === 'provider' && part.providerKind === 'step')
    ).toHaveLength(2);
    const nativeToolDetails = parts(projection.rows).find(
      (part) =>
        part.kind === 'provider' &&
        part.providerKind === 'nativeDetails' &&
        opencodeNativeUpdateLines(part.data.nativeUpdates).some((line) => line.includes('opaque-native-stack'))
    );
    expect(nativeToolDetails?.kind).toBe('provider');
    expect(parts(projection.rows).some((part) => part.kind === 'provider' && part.providerKind === 'event')).toBe(true);
  });

  it.each([1, 2, 3, 7])('uses identical parser and reducer semantics for replay and batches of %s', (size) => {
    const controller = createTranscriptProjection(opencodeSessionProjector, 'card/opencode/session-1');
    const empty = source([]);
    expect(controller.update(empty).projection).toEqual(replayTranscript(opencodeSessionProjector, empty));
    for (let end = size; end < FIXTURE.length; end += size) {
      const snapshot = source(FIXTURE.slice(0, end));
      expect(controller.update(snapshot).projection).toEqual(replayTranscript(opencodeSessionProjector, snapshot));
      expect(controller.update(snapshot).kind).toBe('unchanged');
    }
    const final = source(FIXTURE);
    expect(controller.update(final).projection).toEqual(replayTranscript(opencodeSessionProjector, final));
    expect(controller.update(final).kind).toBe('unchanged');
    controller.dispose();
  });

  it('updates one tool leaf through pending, running, and late completed output while preserving native occurrences', () => {
    const controller = createTranscriptProjection(opencodeSessionProjector, 'card/opencode/session-1');
    const pending = controller.update(source(FIXTURE.slice(0, 8))).projection;
    const pendingTool = tools(pending.rows).find((part) => part.callId === 'call-read-1')!;
    expect(pendingTool.status).toBe('pending');

    const running = controller.update(source(FIXTURE.slice(0, 9))).projection;
    const runningTool = tools(running.rows).find((part) => part.callId === 'call-read-1')!;
    expect(runningTool.id).toBe(pendingTool.id);
    expect(runningTool.status).toBe('running');

    const completed = controller.update(source(FIXTURE.slice(0, 10))).projection;
    const completedTool = tools(completed.rows).find((part) => part.callId === 'call-read-1')!;
    expect(completedTool.id).toBe(pendingTool.id);
    expect(completedTool.status).toBe('complete');
    expect(completedTool.output).toBe('# OpenCode project');
    expect(completedTool.provenance.map((entry) => entry.lineNumber)).toEqual([8, 9, 10]);
    expect(completed).toEqual(replayTranscript(opencodeSessionProjector, source(FIXTURE.slice(0, 10))));
    controller.dispose();
  });

  it('keeps equal text and repeated native ids from collapsing distinct physical content', () => {
    const lines = [
      envelope('message', { id: 'same-message-id', role: 'user' }, 1),
      envelope('part', { id: 'same-part-id', messageID: 'same-message-id', type: 'text', text: 'repeat' }, 2),
      envelope('part', { id: 'different-part-id', messageID: 'same-message-id', type: 'text', text: 'repeat' }, 3),
      envelope('part', { id: 'conflict-part-id', messageID: 'same-message-id', type: 'text', text: 'before' }, 4),
      envelope('part', { id: 'conflict-part-id', messageID: 'same-message-id', type: 'reasoning', text: 'after' }, 5)
    ];
    const projection = replayTranscript(opencodeSessionProjector, source(lines));
    const text = parts(projection.rows).filter((part) => part.kind === 'text');
    expect(text.filter((part) => part.text === 'repeat')).toHaveLength(2);
    expect(new Set(parts(projection.rows).map((part) => part.id)).size).toBe(parts(projection.rows).length);
    expect(parts(projection.rows).some((part) => part.kind === 'provider' && part.providerKind === 'event')).toBe(true);
  });

  it('retains malformed records, unknown envelope types, unsupported parts, and malformed known shapes', () => {
    const lines = [
      '{not-json',
      envelope('future-event', { nested: { preserved: true } }, 2),
      envelope('part', { id: 'future-part', messageID: 'future-message', type: 'future-part', details: [1, 2] }, 3),
      envelope('message', { role: 42 }, 4),
      envelope('part', { id: 'no-type', messageID: 'msg-1', text: 'not a valid part shape' }, 5)
    ];
    const projection = replayTranscript(opencodeSessionProjector, source(lines));
    const unknown = parts(projection.rows).filter((part) => part.kind === 'provider' && part.providerKind === 'event');
    const raw = parts(projection.rows).filter((part) => part.kind === 'raw');
    expect(unknown.length).toBeGreaterThanOrEqual(1);
    expect(raw.some((part) => part.kind === 'raw' && part.text.includes('preserved'))).toBe(true);
    expect(parts(projection.rows).some((part) => part.kind === 'raw' && part.reason === 'malformed')).toBe(true);
  });

  it('keeps idle positional and errors escalated while later meta merges preserve session metadata', () => {
    const lines = [
      envelope('meta', { runtime: 'opencode', opencodeVersion: '1.18.21' }, 1),
      envelope('message', { id: 'm1', role: 'assistant', modelID: 'gpt-5', providerID: 'openai' }, 2),
      envelope('part', { id: 'p1', messageID: 'm1', type: 'text', text: 'first' }, 3),
      envelope('idle', {}, 4),
      envelope('meta', { opencodeVersion: '1.18.22' }, 5)
    ];
    const idle = replayTranscript(opencodeSessionProjector, source(lines));
    expect(idle.header.status).toBe('done');
    expect(idle.rows.some((row) => row.kind === 'provider' && row.providerKind === 'session')).toBe(true);

    const resumed = replayTranscript(
      opencodeSessionProjector,
      source([...lines, envelope('message', { id: 'm2', role: 'assistant' }, 6)])
    );
    expect(resumed.header.status).toBe('running');
    expect(resumed.header.model).toBe('gpt-5');
  });

  it('parses every supported envelope kind used by the historical fixture through the OpenCode parser', () => {
    const kinds = new Set(FIXTURE.map((line) => parseOpencodeLine(line).kind));
    expect([...kinds].sort()).toEqual(['idle', 'message', 'meta', 'part', 'unknown']);
  });
});

/**
 * Provider-independent reconciliation checks using a native record reducer.
 * @summary Native source projection and replay conformance
 */
import { describe, expect, it } from 'vitest';
import {
  createTranscriptProjection,
  type NativeTranscriptProjector,
  replayTranscript,
  sessionIdentity
} from '../src/streams/lib/session/projection';
import type { NativeTranscriptSource, SessionRow } from '../src/streams/lib/session/types';

function source(lines: readonly string[], extra: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource {
  return {
    sourceKey: 'card/source',
    generation: 'one',
    lines,
    headLineNumber: 1,
    filename: 'native.jsonl',
    meta: { lineCount: lines.length, isActive: true },
    isLoading: false,
    error: null,
    ...extra
  };
}

function fixture(): {
  projector: NativeTranscriptProjector<SessionRow[], string>;
  counts: { parsed: number; disposed: number };
} {
  const counts = { parsed: 0, disposed: 0 };
  return {
    counts,
    projector: {
      providerId: 'fixture',
      createState: () => [],
      parseRecord: (record) => {
        counts.parsed++;
        return record.text;
      },
      reduce: (state, text, record) => {
        const id = sessionIdentity(record.provenance, 'record', String(record.provenance.lineNumber));
        state.push({
          id,
          kind: 'message',
          role: 'user',
          anchor: 'turn',
          provenance: [record.provenance],
          parts: [{ id: `${id}/text`, kind: 'text', text, provenance: [record.provenance] }]
        });
      },
      project: (state, snapshot) => ({
        sourceKey: snapshot.sourceKey,
        generation: snapshot.generation,
        rows: [...state],
        header: { title: snapshot.meta?.title }
      }),
      disposeState: () => {
        counts.disposed++;
      }
    }
  };
}

describe('native transcript projection', () => {
  it.skip('uses collision-free source and generation scoped identities', () => {
    expect(sessionIdentity(source([]), 'a/b', 'c')).not.toBe(sessionIdentity(source([]), 'a', 'b/c'));
    expect(sessionIdentity(source([]), 'message', '1')).not.toBe(
      sessionIdentity(source([], { sourceKey: 'other' }), 'message', '1')
    );
    expect(sessionIdentity(source([]), 'message', '1')).not.toBe(
      sessionIdentity(source([], { generation: 'two' }), 'message', '1')
    );
  });

  it.skip('matches full replay across append, replay, prepend, overlap, truncation and replacement', () => {
    const { projector, counts } = fixture();
    const controller = createTranscriptProjection(projector, 'card/source');
    const snapshots = [
      source(['c'], { headLineNumber: 3 }),
      source(['c', 'd'], { headLineNumber: 3 }),
      source(['c', 'd'], { headLineNumber: 3 }),
      source(['b', 'c', 'd'], { headLineNumber: 2 }),
      source(['a', 'b', 'c', 'd']),
      source(['b', 'c'], { headLineNumber: 2 }),
      source(['B', 'c'], { headLineNumber: 2 }),
      source([])
    ];
    for (const snapshot of snapshots) {
      expect(controller.update(snapshot).projection).toEqual(replayTranscript(fixture().projector, snapshot));
    }
    expect(counts.parsed).toBe(5);
    controller.dispose();
  });

  it.skip('parses each appended physical record once and preserves identical id-less lines', () => {
    const { projector, counts } = fixture();
    const controller = createTranscriptProjection(projector, 'card/source');
    controller.update(source(['same']));
    const result = controller.update(source(['same', 'same']));
    expect(result.kind).toBe('append');
    expect(result.projection.rows).toHaveLength(2);
    expect(result.projection.rows[0]?.id).not.toBe(result.projection.rows[1]?.id);
    expect(counts.parsed).toBe(2);
    controller.dispose();
  });

  it.skip('refreshes metadata without parsing and returns unchanged projection for identical input', () => {
    const { projector, counts } = fixture();
    const controller = createTranscriptProjection(projector, 'card/source');
    const initial = controller.update(source(['a']));
    expect(controller.update(source(['a'])).projection).toBe(initial.projection);
    const next = controller.update(source(['a'], { meta: { lineCount: 1, isActive: false, title: 'Completed' } }));
    expect(next.kind).toBe('metadata');
    expect(next.projection.header.title).toBe('Completed');
    expect(counts.parsed).toBe(1);
    controller.dispose();
  });

  it.skip('discards generation state and reports only invalidated row and leaf IDs', () => {
    const { projector, counts } = fixture();
    const controller = createTranscriptProjection(projector, 'card/source');
    const first = controller.update(source(['a', 'b']));
    const shorter = controller.update(source(['a']));
    expect(shorter.invalidatedIds).toContain(first.projection.rows[1]?.id);
    expect(shorter.invalidatedIds).not.toContain(first.projection.rows[0]?.id);
    const reset = controller.update(source(['new'], { generation: 'two' }));
    expect(reset.kind).toBe('reset');
    expect(reset.invalidatedIds).toContain(first.projection.rows[0]?.id);
    expect(reset.projection.rows).toHaveLength(1);
    controller.dispose();
    controller.dispose();
    expect(counts.disposed).toBe(3);
    expect(() => controller.update(source([]))).toThrow(/disposed/i);
  });

  it.skip('rejects another source or invalid absolute coordinates before processing', () => {
    const { projector, counts } = fixture();
    const controller = createTranscriptProjection(projector, 'card/source');
    expect(() => controller.update(source(['a'], { sourceKey: 'other' }))).toThrow(/source/i);
    expect(() => controller.update(source(['a'], { headLineNumber: 0 }))).toThrow(/line/i);
    expect(counts.parsed).toBe(0);
  });
});

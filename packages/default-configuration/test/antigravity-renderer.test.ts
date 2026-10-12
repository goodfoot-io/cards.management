/**
 * Tests for Antigravity's pinned native parser, transcript ordering, and compact fold.
 * Expanded semantic rows and Cards-owned rendering are covered by
 * `antigravity-session-projection.test.ts`.
 *
 * Locks in the orchestrator-pinned destination-record contract duties:
 * ordering by source `idx` (out-of-order arrival renders idx-ordered),
 * consumer-side idempotence keyed on `(idx, hash)` (identical-hash duplicates
 * collapse), deterministic anomaly collation (a host-drift record for an
 * already-rendered idx lands right after the original; flush-partial renders
 * as named-partial evidence; format-unknown renders named-unreadable with the
 * payload withheld), named fail-closed treatment of malformed records, and
 * the compact card's fold/adaptation of the same rules.
 *
 * @summary Tests for the Antigravity parser and compact transcript fold
 */

import { describe, expect, it } from 'vitest';
import { antigravityToCompactCardModel } from '../src/streams/antigravity-session/www/lib/adapt-compact-model.js';
import { buildFoldedState, reconcileFolded } from '../src/streams/antigravity-session/www/lib/compact-state.js';
import type { AntigravityRecord } from '../src/streams/antigravity-session/www/lib/parser.js';
import { parseAntigravityLine, SCHEMA_DRIFT_SENTINEL_IDX } from '../src/streams/antigravity-session/www/lib/parser.js';
import { renderAntigravityTranscript } from '../src/streams/antigravity-session/www/lib/render-transcript.js';

/**
 * Builds a valid destination record with a deterministic hash for its content.
 *
 * @param overrides - Field overrides merged over the base record.
 * @returns The record fixture.
 */
function makeRecord(overrides: Partial<AntigravityRecord> = {}): AntigravityRecord {
  const record: AntigravityRecord = {
    v: 1,
    idx: 0,
    stepType: 15,
    status: 3,
    content: 'step content',
    hash: '',
    anomaly: null,
    ...overrides
  };
  if (overrides.hash === undefined) {
    record.hash = sha256(record.content);
  }
  return record;
}

/**
 * Computes the lowercase hex SHA-256 digest the engine would attach to a
 * content string.
 *
 * @param content - The content to hash.
 * @returns The 64-character lowercase hex digest.
 */
function sha256(content: string): string {
  return Buffer.from(content, 'utf-8').toString('hex').padEnd(64, '0').slice(0, 64);
}

/**
 * Serializes a record fixture into one JSONL line, the engine's wire shape.
 *
 * @param record - The record to serialize.
 * @returns The JSONL line.
 */
function line(record: AntigravityRecord): string {
  return JSON.stringify(record);
}

describe('parseAntigravityLine — pinned record shape, fail-closed', () => {
  it('accepts the pinned record shape, including a null anomaly', () => {
    const parsed = parseAntigravityLine(line(makeRecord({ idx: 7, content: 'hello' })));
    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record).toMatchObject({ v: 1, idx: 7, stepType: 15, status: 3, content: 'hello', anomaly: null });
    expect(parsed.record.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a blank line as nothing to render, not as corruption', () => {
    expect(parseAntigravityLine('')).toEqual({ kind: 'blank' });
    expect(parseAntigravityLine('   \t')).toEqual({ kind: 'blank' });
  });

  it.each([
    ['non-JSON line', 'not json at all'],
    ['JSON array instead of object', '[1,2,3]'],
    ['JSON scalar instead of object', '42'],
    ['wrong record version', JSON.stringify({ ...JSON.parse(line(makeRecord())), v: 2 })],
    [
      'missing version',
      JSON.stringify({ idx: 0, stepType: 1, status: 3, content: 'x', hash: sha256('x'), anomaly: null })
    ],
    ['negative idx', line({ ...makeRecord(), idx: -1 })],
    ['non-integer idx', line({ ...makeRecord(), idx: 1.5 })],
    ['non-integer stepType', line({ ...makeRecord(), stepType: Number.NaN })],
    ['non-integer status', line({ ...makeRecord(), status: 'done' as unknown as number })],
    ['non-string content', line({ ...makeRecord(), content: 42 as unknown as string })],
    ['non-hex hash', line({ ...makeRecord(), hash: 'not-a-digest' })],
    ['short hash', line({ ...makeRecord(), hash: 'abcd' })],
    ['uppercase hash', line({ ...makeRecord(), hash: `abcdef${'0'.repeat(58)}`.toUpperCase() })],
    [
      'unknown anomaly kind',
      line({ ...makeRecord(), anomaly: { kind: 'mystery' as unknown as 'host-drift', detail: 'd' } })
    ],
    [
      'anomaly missing detail',
      line({
        ...makeRecord(),
        anomaly: { kind: 'host-drift', detail: '' } as unknown as { kind: 'host-drift'; detail: string }
      })
    ],
    ['anomaly not an object', line({ ...makeRecord(), anomaly: 'drift' as unknown as null })]
  ])('refuses %s with a named malformed reason', (_label, raw) => {
    const parsed = parseAntigravityLine(raw);
    expect(parsed.kind).toBe('malformed');
    if (parsed.kind !== 'malformed') return;
    expect(parsed.rawLine).toBe(raw);
    expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it('accepts an explicit null anomaly and each pinned anomaly kind', () => {
    for (const kind of ['host-drift', 'flush-partial', 'format-unknown'] as const) {
      const parsed = parseAntigravityLine(line({ ...makeRecord(), anomaly: { kind, detail: 'engine detail' } }));
      expect(parsed.kind).toBe('record');
      if (parsed.kind === 'record') {
        expect(parsed.record.anomaly).toEqual({ kind, detail: 'engine detail' });
      }
    }
  });
});

describe('parseAntigravityLine — schema-fingerprint drift sentinel (idx -1)', () => {
  /**
   * Builds the engine's exact sentinel emission shape: content is the
   * human-readable drift detail, hash is the SHA-256 of that detail, and the
   * anomaly is host-drift class.
   *
   * @param detail - The drift detail (also the content).
   * @param overrides - Field overrides merged over the sentinel shape.
   * @returns The sentinel record fixture.
   */
  function makeSentinel(
    detail = 'schema fingerprint changed mid-stream for "x.db" (was abcdef012345…, now 123456abcdef…) — host drift',
    overrides: Partial<AntigravityRecord> = {}
  ): AntigravityRecord {
    return {
      v: 1,
      idx: SCHEMA_DRIFT_SENTINEL_IDX,
      stepType: -1,
      status: -1,
      content: detail,
      hash: sha256(detail),
      anomaly: { kind: 'host-drift', detail },
      ...overrides
    };
  }

  it('accepts the engine sentinel shape as an anomaly-class record', () => {
    const parsed = parseAntigravityLine(line(makeSentinel()));
    expect(parsed.kind).toBe('record');
    if (parsed.kind !== 'record') return;
    expect(parsed.record.idx).toBe(-1);
    expect(parsed.record.anomaly).toEqual({ kind: 'host-drift', detail: parsed.record.content });
  });

  it('refuses a sentinel with empty content', () => {
    const parsed = parseAntigravityLine(line({ ...makeSentinel('real drift detail'), content: '', hash: sha256('') }));
    expect(parsed.kind).toBe('malformed');
    if (parsed.kind === 'malformed') {
      expect(parsed.reason).toContain('non-empty content');
    }
  });

  it('refuses a sentinel with a null anomaly or a non-host-drift anomaly kind', () => {
    const noAnomaly = parseAntigravityLine(line({ ...makeSentinel(), anomaly: null }));
    expect(noAnomaly.kind).toBe('malformed');

    const wrongKind = parseAntigravityLine(
      line({ ...makeSentinel(), anomaly: { kind: 'flush-partial', detail: 'd' } })
    );
    expect(wrongKind.kind).toBe('malformed');
    if (wrongKind.kind === 'malformed') {
      expect(wrongKind.reason).toContain('host-drift');
    }
  });

  it('refuses negative idx values other than the -1 sentinel', () => {
    const parsed = parseAntigravityLine(line(makeRecord({ idx: -2 })));
    expect(parsed.kind).toBe('malformed');
    if (parsed.kind === 'malformed') {
      expect(parsed.reason).toContain('sentinel');
    }
  });

  it('refuses a sentinel with an empty anomaly detail (generic detail rule)', () => {
    const parsed = parseAntigravityLine(line({ ...makeSentinel(), anomaly: { kind: 'host-drift', detail: '' } }));
    expect(parsed.kind).toBe('malformed');
    if (parsed.kind === 'malformed') {
      expect(parsed.reason).toContain('anomaly.detail');
    }
  });
});

describe('renderAntigravityTranscript — ordering by source idx', () => {
  it('renders out-of-order arrival idx-ordered', () => {
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 2, content: 'third' })),
      line(makeRecord({ idx: 0, content: 'first' })),
      line(makeRecord({ idx: 1, content: 'second' }))
    ]);

    expect(items.map((item) => (item.kind === 'step' ? item.content : ''))).toEqual(['first', 'second', 'third']);
    expect(items.map((item) => (item.kind === 'step' ? item.idx : -1))).toEqual([0, 1, 2]);
  });

  it('preserves arrival order for same-idx records (stable sort)', () => {
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 5, content: 'original' })),
      line(makeRecord({ idx: 5, content: 'revised', anomaly: { kind: 'host-drift', detail: 'row revised' } }))
    ]);

    expect(items[0]).toMatchObject({ kind: 'step', content: 'original' });
    expect(items[1]).toMatchObject({ kind: 'drift', content: 'revised', detail: 'row revised' });
  });
});

describe('renderAntigravityTranscript — (idx, hash) idempotence and collation matrix', () => {
  it('collapses an identical (idx, hash) duplicate regardless of position', () => {
    const record = makeRecord({ idx: 3, content: 'same' });
    const items = renderAntigravityTranscript([line(record), line(makeRecord({ idx: 4 })), line(record)]);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === 'step')).toBe(true);
  });

  it('collates a host-drift record for an already-rendered idx deterministically after the original', () => {
    const original = makeRecord({ idx: 1, content: 'original text' });
    const drift = makeRecord({
      idx: 1,
      content: 'revised text',
      anomaly: { kind: 'host-drift', detail: 'row revised post-terminal' }
    });
    const later = makeRecord({ idx: 2, content: 'next step' });

    // The drift re-emission arrives interleaved after other rows — collation
    // must not depend on where it lands in the arrival batch.
    const items = renderAntigravityTranscript([line(original), line(later), line(drift)]);

    expect(items.map((item) => item.kind)).toEqual(['step', 'drift', 'step']);
    expect(items[0]).toMatchObject({ idx: 1, content: 'original text' });
    expect(items[1]).toMatchObject({ idx: 1, content: 'revised text' });
    expect(items[2]).toMatchObject({ idx: 2 });
  });

  it('collapses a duplicate drift re-emission carrying the same (idx, hash)', () => {
    const drift = makeRecord({ idx: 1, content: 'revised', anomaly: { kind: 'host-drift', detail: 'd' } });
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 1, content: 'original' })),
      line(drift),
      line(drift)
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(['step', 'drift']);
  });

  it('renders flush-partial then terminal as named-partial evidence followed by the final step', () => {
    const partial = makeRecord({
      idx: 4,
      content: 'partial text',
      status: 1,
      anomaly: { kind: 'flush-partial', detail: 'flushed mid-turn' }
    });
    const terminal = makeRecord({ idx: 4, content: 'final text', status: 3 });

    const items = renderAntigravityTranscript([line(partial), line(terminal)]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'partial', idx: 4, content: 'partial text', detail: 'flushed mid-turn' });
    expect(items[1]).toMatchObject({ kind: 'step', idx: 4, content: 'final text' });
  });

  it('renders a host-drift record for an unseen idx as a named anomaly at its idx position', () => {
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 0 })),
      line(
        makeRecord({ idx: 1, content: 'orphan drift', anomaly: { kind: 'host-drift', detail: 'no original arrived' } })
      )
    ]);

    expect(items.map((item) => item.kind)).toEqual(['step', 'drift']);
    expect(items[1]).toMatchObject({ idx: 1, content: 'orphan drift' });
  });

  it('renders format-unknown as named-unreadable with the payload withheld', () => {
    const items = renderAntigravityTranscript([
      line(
        makeRecord({
          idx: 2,
          content: '\x00\x01binary-garbage',
          anomaly: { kind: 'format-unknown', detail: 'step_format 9 has no decoder in this build' }
        })
      )
    ]);

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({
      kind: 'unreadable',
      idx: 2,
      detail: 'step_format 9 has no decoder in this build'
    });
    if (item?.kind !== 'unreadable') throw new Error('expected an unreadable item');
    expect(item.withheldBytes).toBe('\x00\x01binary-garbage'.length);
    expect(JSON.stringify(item)).not.toContain('binary-garbage');
  });
});

describe('renderAntigravityTranscript — schema-fingerprint drift sentinel', () => {
  /**
   * Builds the engine's exact sentinel line for a drift detail.
   *
   * @param detail - The drift detail (also the content and hash input).
   * @returns The sentinel JSONL line.
   */
  function sentinelLine(detail: string): string {
    return line({
      v: 1,
      idx: SCHEMA_DRIFT_SENTINEL_IDX,
      stepType: -1,
      status: -1,
      content: detail,
      hash: sha256(detail),
      anomaly: { kind: 'host-drift', detail }
    });
  }

  it('excludes the sentinel from the idx-ordered sequence — never sorts against real step indices', () => {
    const driftDetail = 'schema fingerprint changed mid-stream (was a…, now b…) — host drift';
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 0, content: 'first' })),
      sentinelLine(driftDetail),
      line(makeRecord({ idx: 1, content: 'second' }))
    ]);

    // The sentinel arrived between the two steps but renders in the dedicated
    // trailing drift section — the idx-ordered sequence stays pure steps.
    expect(items.map((item) => item.kind)).toEqual(['step', 'step', 'schema_drift']);
    expect(items[0]).toMatchObject({ kind: 'step', idx: 0, content: 'first' });
    expect(items[1]).toMatchObject({ kind: 'step', idx: 1, content: 'second' });
    expect(items[2]).toMatchObject({ kind: 'schema_drift', content: driftDetail, detail: driftDetail });
  });

  it('renders distinct sentinel changes in arrival order (distinct hashes never collapse)', () => {
    const items = renderAntigravityTranscript([
      sentinelLine('first schema change — host drift'),
      sentinelLine('second schema change — host drift'),
      sentinelLine('third schema change — host drift')
    ]);

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.kind === 'schema_drift')).toBe(true);
    expect(items.map((item) => (item.kind === 'schema_drift' ? item.detail : ''))).toEqual([
      'first schema change — host drift',
      'second schema change — host drift',
      'third schema change — host drift'
    ]);
  });

  it('collapses an identical sentinel re-emission but never against real idx values', () => {
    const detail = 'schema fingerprint changed mid-stream (was a…, now b…) — host drift';
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 5, content: detail })), // real step, same content → same hash as the sentinel's
      sentinelLine(detail),
      sentinelLine(detail) // identical re-emission → collapses
    ]);

    // The real step and the sentinel share a hash but differ in idx: the
    // (idx, hash) key keeps both; only the duplicate sentinel collapses.
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'step', idx: 5 });
    expect(items[1]).toMatchObject({ kind: 'schema_drift' });
  });

  it('coexists with a per-step host-drift collation and renders ahead of the malformed section', () => {
    const items = renderAntigravityTranscript([
      line(makeRecord({ idx: 0, content: 'original' })),
      sentinelLine('schema change — host drift'),
      line(makeRecord({ idx: 0, content: 'revised', anomaly: { kind: 'host-drift', detail: 'row revised' } })),
      'not json'
    ]);

    expect(items.map((item) => item.kind)).toEqual(['step', 'drift', 'schema_drift', 'malformed']);
  });
});

describe('renderAntigravityTranscript — malformed records fail closed, never silently dropped', () => {
  it('renders malformed lines after the ordered steps with named reasons, in arrival order', () => {
    const items = renderAntigravityTranscript([
      'not json',
      line(makeRecord({ idx: 1, content: 'b' })),
      line(makeRecord({ idx: 0, content: 'a' })),
      JSON.stringify({ v: 2, idx: 9 })
    ]);

    expect(items.map((item) => item.kind)).toEqual(['step', 'step', 'malformed', 'malformed']);
    expect(items[0]).toMatchObject({ kind: 'step', idx: 0 });
    expect(items[2]).toMatchObject({ kind: 'malformed', reason: expect.stringContaining('not valid JSON') });
    expect(items[3]).toMatchObject({ kind: 'malformed', reason: expect.stringContaining('version') });
  });

  it('never throws and never emits records from malformed lines', () => {
    const items = renderAntigravityTranscript(['{', 'null', '[]', '']);
    expect(items.filter((item) => item.kind === 'malformed')).toHaveLength(3);
    expect(items.every((item) => item.kind !== 'step')).toBe(true);
  });
});

describe('compact fold + adapter', () => {
  it('tallies unique steps, anomalies, and malformed lines; applies (idx, hash) idempotence', () => {
    const record = makeRecord({ idx: 0, content: 'a' });
    const driftDetail = 'schema fingerprint changed mid-stream — host drift';
    const folded = buildFoldedState(
      [
        line(record),
        line(record),
        line(makeRecord({ idx: 1, content: 'b' })),
        line({
          v: 1,
          idx: SCHEMA_DRIFT_SENTINEL_IDX,
          stepType: -1,
          status: -1,
          content: driftDetail,
          hash: sha256(driftDetail),
          anomaly: { kind: 'host-drift', detail: driftDetail }
        }),
        'oops'
      ],
      false
    );

    expect(folded.state.stepCount).toBe(2);
    expect(folded.state.anomalyCount).toBe(1);
    expect(folded.state.malformedCount).toBe(1);
    expect(folded.state.hasErrors).toBe(true);
    expect(folded.state.headlineText).toBe('b');
    expect(folded.state.tail.map((entry) => entry.kind)).toEqual(['step', 'step', 'anomaly', 'malformed']);
  });

  it('reconciles incremental appends equivalently to a full rebuild and rebuilds on shrink', () => {
    const first = makeRecord({ idx: 0, content: 'a' });
    const second = makeRecord({ idx: 1, content: 'b' });
    const rebuilt = buildFoldedState([line(first), line(second)], true);

    const boot = buildFoldedState([line(first)], false);
    const reconciled = reconcileFolded(boot, [line(first), line(second)], true);

    expect(reconciled.state.stepCount).toBe(rebuilt.state.stepCount);
    expect(reconciled.state.headlineText).toBe(rebuilt.state.headlineText);
    expect(reconciled.state.isActive).toBe(true);
    expect(reconciled.lineCount).toBe(2);

    // Shrink: a truncated replacement array rebuilds fully with no stale tally.
    const shrunk = reconcileFolded(reconciled, [line(first)], false);
    expect(shrunk.state.stepCount).toBe(1);
    expect(shrunk.state.headlineText).toBe('a');

    // No change: previous state returned by reference (React bail-out).
    expect(reconcileFolded(shrunk, [line(first)], false)).toBe(shrunk);
  });

  it('adapts the compact state into the shared CompactCardModel with anomaly-driven severity', () => {
    const record = makeRecord({ idx: 0, content: 'only step' });
    const folded = buildFoldedState(
      [line(record), line(makeRecord({ idx: 1, content: 'r', anomaly: { kind: 'host-drift', detail: 'd' } }))],
      true
    );
    const model = antigravityToCompactCardModel(folded.state, true);

    expect(model.dotClass).toBe('running');
    expect(model.statusWord).toBe('Running');
    expect(model.headline).toBe('only step');
    expect(model.stackedFacts).toEqual([
      { key: 'steps', kind: 'value', bold: '1', label: 'steps' },
      { key: 'anomalies', kind: 'value', bold: '1', label: 'anomalies' }
    ]);
    expect(model.tail.map((entry) => entry.severity)).toEqual(['neutral', 'error']);

    const settled = antigravityToCompactCardModel(
      { ...folded.state, isActive: false, malformedCount: 1, hasErrors: true },
      false
    );
    expect(settled.dotClass).toBe('error');
    expect(settled.statusWord).toBe('Ended');
  });
});

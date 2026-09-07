/**
 * Tests for {@link reconcileFolded}, the pure line-folding reconciler the
 * compact session view uses to keep its folded `CompactState` in step with the
 * authoritative store lines.
 *
 * These pin the regression that left a populated transcript rendering as a blank
 * "ENDED" card: the host always boots the iframe with `lines: []`, the store
 * then requests the history and applies a `subscribe:response` asynchronously,
 * and that response can land between the renderer's initial (empty) render and
 * the effect that subscribes for updates. The old view snapshotted a line-count
 * watermark independently of the lines its state was built from, so when the
 * history arrived in that window the watermark advanced past lines that were
 * never folded in — and, for an already-ended session with no further lines,
 * the card stayed empty forever.
 *
 * `reconcileFolded` carries the watermark *inside* the folded value so it can
 * never drift from the state it describes: folding from the empty boot state
 * against the full transcript must surface the headline and honest tallies.
 *
 * @summary Unit tests for the compact view's line-fold reconciler
 */

import { describe, expect, it } from 'vitest';
import {
  buildState,
  type FoldedState,
  headline,
  reconcileFolded
} from '../src/streams/claude-code-session/www/components/compact/compact-state';

let uuidCounter = 0;
/**
 * Generates a stable, unique uuid string for fixtures.
 * @returns A unique `uuid-N` string.
 */
function nextUuid(): string {
  uuidCounter += 1;
  return `recon-uuid-${uuidCounter}`;
}

/**
 * Builds an assistant JSONL line with optional text, a tool_use, and usage.
 * @param opts - Fixture options.
 * @param opts.uuid - Top-level line uuid (defaults to a fresh unique value).
 * @param opts.text - Assistant text block content.
 * @param opts.tool - Optional tool_use name to embed.
 * @param opts.outputTokens - `message.usage.output_tokens` value.
 * @returns The serialized JSONL line.
 */
function assistantLine(opts: { uuid?: string; text?: string; tool?: string; outputTokens?: number }): string {
  const content: unknown[] = [];
  if (opts.text != null) content.push({ type: 'text', text: opts.text });
  if (opts.tool != null) content.push({ type: 'tool_use', id: nextUuid(), name: opts.tool, input: {} });
  const message: Record<string, unknown> = { content };
  if (opts.outputTokens != null) message.usage = { output_tokens: opts.outputTokens };
  return JSON.stringify({ type: 'assistant', uuid: opts.uuid ?? nextUuid(), message });
}

function awaySummaryLine(content: string): string {
  return JSON.stringify({ type: 'system', subtype: 'away_summary', uuid: nextUuid(), content });
}

/**
 * The empty folded state the view starts from when the iframe boots with no lines.
 * @returns A folded state wrapping an empty `CompactState` with a zero watermark.
 */
function emptyFolded(): FoldedState {
  return { state: buildState([], 'session.jsonl'), lineCount: 0 };
}

describe('reconcileFolded — empty-on-boot history fold (blank-card regression)', () => {
  it('folds the whole transcript that arrives after an empty boot render', () => {
    // The exact production sequence: initial state built from zero lines, then
    // the subscribe:response delivers the full, already-ended transcript.
    const lines = [
      assistantLine({ text: 'First the assistant explained the change.', outputTokens: 100 }),
      awaySummaryLine('Rebuilt the compact card and verified it in the EDH.'),
      assistantLine({ text: 'Then it summarized the work.', outputTokens: 120 })
    ];

    const folded = reconcileFolded(emptyFolded(), lines, 'session.jsonl');

    // The headline must surface — not the blank box the regression produced.
    expect(headline(folded.state)).toBe('Rebuilt the compact card and verified it in the EDH.');
    expect(folded.lineCount).toBe(lines.length);
    expect(folded.state.outputTokensTotal).toBe(220);
  });

  it('matches a from-scratch buildState when folding the full history at once', () => {
    const lines = [
      assistantLine({ uuid: 'a1', text: 'hello', tool: 'Read', outputTokens: 10 }),
      assistantLine({ uuid: 'a2', text: 'world', tool: 'Agent', outputTokens: 20 })
    ];
    const folded = reconcileFolded(emptyFolded(), lines, 'session.jsonl');
    const direct = buildState(lines, 'session.jsonl');

    expect(headline(folded.state)).toBe(headline(direct));
    expect(folded.state.toolCallCount).toBe(direct.toolCallCount);
    expect(folded.state.subagentCount).toBe(direct.subagentCount);
    expect(folded.state.outputTokensTotal).toBe(direct.outputTokensTotal);
  });
});

describe('reconcileFolded — incremental growth and de-duplication', () => {
  it('folds only the newly appended lines without re-folding the prefix', () => {
    const first = assistantLine({ uuid: 'g1', tool: 'Read', outputTokens: 10 });
    const second = assistantLine({ uuid: 'g2', tool: 'Agent', outputTokens: 30 });

    const afterFirst = reconcileFolded(emptyFolded(), [first], 'session.jsonl');
    expect(afterFirst.lineCount).toBe(1);
    expect(afterFirst.state.toolCallCount).toBe(1);

    const afterSecond = reconcileFolded(afterFirst, [first, second], 'session.jsonl');
    expect(afterSecond.lineCount).toBe(2);
    expect(afterSecond.state.toolCallCount).toBe(2); // Read + Agent
    expect(afterSecond.state.subagentCount).toBe(1);
    expect(afterSecond.state.outputTokensTotal).toBe(40);
  });

  it('does not double-count a uuid already folded when it reappears in the new tail', () => {
    // The transcript double-writes lines; a uuid folded in one reconcile must
    // not be counted again when the next authoritative slice repeats it.
    const dup = assistantLine({ uuid: 'dup-1', tool: 'Read', outputTokens: 50 });
    const fresh = assistantLine({ uuid: 'fresh-1', tool: 'Write', outputTokens: 5 });

    const afterFirst = reconcileFolded(emptyFolded(), [dup], 'session.jsonl');
    // Next slice repeats `dup` (the double-write) and appends `fresh`.
    const afterSecond = reconcileFolded(afterFirst, [dup, dup, fresh], 'session.jsonl');

    expect(afterSecond.lineCount).toBe(3);
    expect(afterSecond.state.toolCallCount).toBe(2); // dup's Read counted once, plus Write
    expect(afterSecond.state.outputTokensTotal).toBe(55);
  });
});

describe('reconcileFolded — no-op and shrink', () => {
  it('returns the previous folded value by reference when the line count is unchanged', () => {
    const lines = [assistantLine({ uuid: 'n1', text: 'steady' })];
    const folded = reconcileFolded(emptyFolded(), lines, 'session.jsonl');
    const again = reconcileFolded(folded, lines, 'session.jsonl');
    expect(again).toBe(folded); // identical reference → React bails out of re-render
  });

  it('rebuilds from scratch when the authoritative lines shrink below the watermark', () => {
    const wide = [
      assistantLine({ uuid: 's1', tool: 'Read' }),
      assistantLine({ uuid: 's2', tool: 'Agent' }),
      assistantLine({ uuid: 's3', tool: 'Write' })
    ];
    const folded = reconcileFolded(emptyFolded(), wide, 'session.jsonl');
    expect(folded.state.toolCallCount).toBe(3);

    const narrower = [assistantLine({ uuid: 's1', tool: 'Read' })];
    const rebuilt = reconcileFolded(folded, narrower, 'session.jsonl');
    expect(rebuilt.lineCount).toBe(1);
    expect(rebuilt.state.toolCallCount).toBe(1); // not 3 — full rebuild, no stale tally
  });
});

/**
 * Tests for incremental folding of the Codex compact state.
 *
 * {@link reconcileFolded} carries a line watermark inside the folded value so
 * steady-state appends parse and fold only the new lines, while a shrink
 * (truncation or stream replacement) rebuilds fully from the replacement
 * lines. These tests pin that behavior with a `JSON.parse` spy — every fold
 * of a rollout line costs exactly one parse, so parse counts are a direct
 * proxy for work done.
 *
 * @summary Unit tests for the Codex compact state's watermark reconciliation
 */

import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  buildFoldedState,
  type FoldedState,
  reconcileFolded
} from '../src/streams/codex-session/www/lib/compact-state.js';

// ============================================================================
// Fixture helpers — real rollout envelope shapes (mirrors codex-compact-state)
// ============================================================================

/**
 * Wraps a payload in the flat `{ timestamp, type, payload }` rollout envelope.
 * @param type - The rollout item type discriminator.
 * @param payload - The item payload object.
 * @param timestamp - ISO 8601 UTC timestamp for the envelope.
 * @returns Serialized JSONL line.
 */
function envelope(type: string, payload: unknown, timestamp = '2026-06-04T12:00:00.000Z'): string {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMetaLine(timestamp = '2026-06-04T10:00:00.000Z'): string {
  return envelope(
    'session_meta',
    { id: 'thread-001', model_provider: 'openai', cwd: '/home/user/project', originator: 'user' },
    timestamp
  );
}

function turnContextLine(timestamp = '2026-06-04T10:01:00.000Z'): string {
  return envelope('turn_context', { turn_id: 'turn-001', cwd: '/home/user/project', model: 'gpt-4o' }, timestamp);
}

function responseMsgLine(role: string, text: string, timestamp = '2026-06-04T10:02:00.000Z'): string {
  return envelope(
    'response_item',
    { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
    timestamp
  );
}

function functionCallLine(name: string, callId: string, timestamp = '2026-06-04T10:03:00.000Z'): string {
  return envelope('response_item', { type: 'function_call', name, arguments: '{}', call_id: callId }, timestamp);
}

function agentMsgLine(message: string, timestamp = '2026-06-04T10:06:00.000Z'): string {
  return envelope('event_msg', { type: 'agent_message', message }, timestamp);
}

function patchApplyEndLine(callId: string, success: boolean, timestamp = '2026-06-04T10:06:00.000Z'): string {
  return envelope('event_msg', { type: 'patch_apply_end', call_id: callId, success }, timestamp);
}

function functionCallOutputLine(callId: string, output: string, timestamp = '2026-06-04T10:05:00.000Z'): string {
  return envelope('response_item', { type: 'function_call_output', call_id: callId, output }, timestamp);
}

function shellFunctionCallLine(callId: string, timestamp = '2026-06-04T10:04:00.000Z'): string {
  return envelope(
    'response_item',
    { type: 'function_call', name: 'shell', arguments: '{}', call_id: callId },
    timestamp
  );
}

/**
 * Spies on `JSON.parse`, returning a spy whose call count measures fold work.
 * @returns A fresh `JSON.parse` spy.
 */
function makeParseSpy(): MockInstance<typeof JSON.parse> {
  return vi.spyOn(JSON, 'parse');
}

let parseSpy: ReturnType<typeof makeParseSpy> | undefined;

afterEach(() => {
  parseSpy?.mockRestore();
  parseSpy = undefined;
});

/**
 * Measures the number of `JSON.parse` calls made while running `fn`.
 * @param fn - The function to measure.
 * @returns The number of `JSON.parse` calls during `fn`.
 */
function countParses(fn: () => void): number {
  parseSpy ??= makeParseSpy();
  parseSpy.mockClear();
  fn();
  return parseSpy.mock.calls.length;
}

describe('buildFoldedState / reconcileFolded — incremental append cost', () => {
  it('parses each source line exactly once on the initial fold', () => {
    const lines = [sessionMetaLine(), turnContextLine(), responseMsgLine('assistant', 'hello')];
    expect(countParses(() => buildFoldedState(lines, true))).toBe(lines.length);
  });

  it('parses only the newly appended lines on a steady-state append', () => {
    const base = [sessionMetaLine(), turnContextLine(), responseMsgLine('assistant', 'first')];
    const appended = [functionCallLine('read_file', 'call-001'), agentMsgLine('done')];

    const folded = buildFoldedState(base, true);
    expect(countParses(() => reconcileFolded(folded, [...base, ...appended], true))).toBe(appended.length);
  });

  it('parses nothing across many consecutive appends beyond the watermark', () => {
    const base = [sessionMetaLine()];
    let folded = buildFoldedState(base, true);
    let all = [...base];
    for (let i = 0; i < 10; i++) {
      all = [...all, responseMsgLine('assistant', `message ${i}`, `2026-06-04T10:0${i}:00.000Z`)];
      const n = all.length;
      expect(
        countParses(() => {
          folded = reconcileFolded(folded, all, true);
        })
      ).toBe(1);
      expect(folded.lineCount).toBe(n);
    }
    expect(folded.state.headlineText).toBe('message 9');
  });

  it('returns the previous folded value by reference and parses nothing when lines and liveness are unchanged', () => {
    const lines = [sessionMetaLine(), responseMsgLine('assistant', 'steady')];
    const folded = buildFoldedState(lines, false);
    let again: FoldedState | undefined;
    expect(
      countParses(() => {
        again = reconcileFolded(folded, lines, false);
      })
    ).toBe(0);
    expect(again).toBe(folded);
  });
});

describe('reconcileFolded — liveness flip without new lines', () => {
  it('refreshes isActive on the snapshot when only liveness changes', () => {
    const lines = [sessionMetaLine(), responseMsgLine('assistant', 'running')];
    const folded = buildFoldedState(lines, true);
    const ended = reconcileFolded(folded, lines, false);

    expect(ended).not.toBe(folded);
    expect(ended.lineCount).toBe(folded.lineCount);
    expect(ended.state.isActive).toBe(false);
    expect(ended.state.headlineText).toBe(folded.state.headlineText);
    expect(ended.fold).toBe(folded.fold);
  });
});

describe('reconcileFolded — shrink triggers full rebuild', () => {
  it('drops stale tallies and reparses every replacement line', () => {
    const wide = [
      sessionMetaLine(),
      functionCallLine('tool_a', 'call-001'),
      functionCallLine('tool_b', 'call-002'),
      functionCallLine('tool_c', 'call-003')
    ];
    const folded = buildFoldedState(wide, false);
    expect(folded.state.toolCallCount).toBe(3);

    const narrower = [sessionMetaLine('2026-06-04T11:00:00.000Z')];
    let rebuilt: FoldedState | undefined;
    expect(
      countParses(() => {
        rebuilt = reconcileFolded(folded, narrower, false);
      })
    ).toBe(narrower.length);
    expect(rebuilt!.lineCount).toBe(1);
    expect(rebuilt!.state.toolCallCount).toBe(0);
    expect(rebuilt!.state.model).toBeUndefined();
    expect(rebuilt!.fold).not.toBe(folded.fold);
  });
});

describe('reconcileFolded — incremental equivalence', () => {
  it('matches a one-shot rebuild when the transcript arrives in batches', () => {
    const batch1 = [sessionMetaLine(), turnContextLine()];
    const batch2 = [
      responseMsgLine('user', 'please look', '2026-06-04T10:02:00.000Z'),
      responseMsgLine('assistant', 'looking now', '2026-06-04T10:03:00.000Z'),
      agentMsgLine('looking now', '2026-06-04T10:04:00.000Z')
    ];
    const batch3 = [functionCallLine('apply_patch', 'patch-001'), patchApplyEndLine('patch-001', false)];

    const all = [...batch1, ...batch2, ...batch3];
    let folded = buildFoldedState(batch1, true);
    folded = reconcileFolded(folded, [...batch1, ...batch2], true);
    folded = reconcileFolded(folded, all, true);

    expect(folded.state).toEqual(buildFoldedState(all, true).state);
    expect(folded.lineCount).toBe(all.length);
  });
});

describe('reconcileFolded — cross-batch state carried forward', () => {
  it('back-patches tail severity when an error event lands in a later batch', () => {
    const base = [sessionMetaLine(), functionCallLine('apply_patch', 'patch-010')];
    const folded = buildFoldedState(base, false);
    expect(folded.state.tail.find((e) => e.callId === 'patch-010')?.severity).toBeUndefined();

    const patched = reconcileFolded(folded, [...base, patchApplyEndLine('patch-010', false)], false);
    expect(patched.state.hasErrors).toBe(true);
    expect(patched.state.tail.find((e) => e.callId === 'patch-010')?.severity).toBe('error');
  });

  it('resolves a deferred reverse-path shell error when the call arrives in a later batch', () => {
    const base = [sessionMetaLine(), functionCallOutputLine('shell-010', 'Exit code: 1')];
    const folded = buildFoldedState(base, false);
    expect(folded.state.hasErrors).toBe(false);

    const all = [...base, shellFunctionCallLine('shell-010')];
    const resolved = reconcileFolded(folded, all, false);
    expect(resolved.state.hasErrors).toBe(true);
    expect(resolved.state.tail.find((e) => e.callId === 'shell-010')?.severity).toBe('error');
    expect(resolved.state).toEqual(buildFoldedState(all, false).state);
  });

  it('escalates tail severity when an errored patch_apply_end arrives before its tool call', () => {
    const base = [sessionMetaLine(), patchApplyEndLine('patch-011', false)];
    const folded = buildFoldedState(base, false);

    const all = [...base, functionCallLine('apply_patch', 'patch-011')];
    const reconciled = reconcileFolded(folded, all, false);
    expect(reconciled.state.hasErrors).toBe(true);
    expect(reconciled.state.tail.find((e) => e.callId === 'patch-011')?.severity).toBe('error');
    expect(reconciled.state).toEqual(buildFoldedState(all, false).state);
  });

  it('suppresses an event_msg mirror that arrives in a later batch than its response_item', () => {
    const base = [sessionMetaLine(), turnContextLine(), responseMsgLine('assistant', 'Task complete.')];
    const folded = buildFoldedState(base, false);
    expect(folded.state.tail.filter((e) => e.kind === 'message')).toHaveLength(1);

    const deduped = reconcileFolded(folded, [...base, agentMsgLine('Task complete.')], false);
    const messageTail = deduped.state.tail.filter((e) => e.kind === 'message');
    expect(messageTail).toHaveLength(1);
    expect(deduped.state.headlineText).toBe('Task complete.');
  });
});

/**
 * Tests for away_summary handling in the compact session view.
 *
 * Verifies that processLine correctly sets state.awaySummary when an
 * away_summary system message is encountered, and that buildState propagates
 * the value from any line in the lines array.
 *
 * @summary Unit tests for away_summary support in CompactView
 */

import { describe, expect, it } from 'vitest';
import { buildState, processLine } from '../src/streams/claude-code-session/www/components/compact/compact-state';

// Helper to create a minimal CompactState-like object for processLine tests.
// We use buildState with an empty lines array as a factory to ensure the
// shape stays in sync with the real interface.
function makeState() {
  return buildState([], 'session.jsonl');
}

function awaySummaryLine(content: unknown): string {
  return JSON.stringify({ type: 'system', subtype: 'away_summary', content });
}

describe('processLine — away_summary handling', () => {
  it('sets state.awaySummary to trimmed content for a valid away_summary line', () => {
    const state = makeState();
    processLine(state, awaySummaryLine('  Work is in progress on the refactor.  '));
    expect(state.awaySummary).toBe('Work is in progress on the refactor.');
  });

  it('does not set state.awaySummary when content is an empty string', () => {
    const state = makeState();
    processLine(state, awaySummaryLine(''));
    expect(state.awaySummary).toBe('');
  });

  it('does not set state.awaySummary when content is whitespace-only', () => {
    const state = makeState();
    processLine(state, awaySummaryLine('   '));
    expect(state.awaySummary).toBe('');
  });

  it('does not set state.awaySummary when content is not a string', () => {
    const state = makeState();
    processLine(state, awaySummaryLine(42));
    expect(state.awaySummary).toBe('');
  });
});

describe('buildState — away_summary propagation', () => {
  it('propagates awaySummary when the away_summary line appears anywhere in lines', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude', cwd: '/', tools: [] }),
      awaySummaryLine('Paused mid-refactor, resume from step 3.'),
      JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, duration_ms: 1000 })
    ];
    const state = buildState(lines, 'session.jsonl');
    expect(state.awaySummary).toBe('Paused mid-refactor, resume from step 3.');
  });

  it('overwrites an earlier away_summary with a later one', () => {
    const lines = [awaySummaryLine('First summary.'), awaySummaryLine('Second summary, supersedes the first.')];
    const state = buildState(lines, 'session.jsonl');
    expect(state.awaySummary).toBe('Second summary, supersedes the first.');
  });
});

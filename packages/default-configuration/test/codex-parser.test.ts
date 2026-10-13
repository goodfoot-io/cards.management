/**
 * Tests for the Codex rollout JSONL parser.
 *
 * Fixtures are derived from the Codex reference at `rust-v0.137.0`
 * (`codex-rs/protocol/src/protocol.rs`, `models.rs`) — real envelope shapes
 * and nested variant structures, not invented ones.
 *
 * @summary Unit tests for the Codex rollout JSONL parser
 */

import { describe, expect, it } from 'vitest';
import { parseCodexLine } from '../src/streams/codex-session/www/lib/parser.js';

// ============================================================================
// Fixture helpers — real tag-137 rollout envelope shapes
// ============================================================================

/**
 * Wraps a payload in the flat `{ timestamp, type, payload }` rollout envelope.
 * @param type - The rollout item type discriminator (e.g. `'session_meta'`).
 * @param payload - The item payload object.
 * @param timestamp - ISO 8601 UTC timestamp for the envelope.
 * @returns Serialized JSONL line.
 */
function envelope(type: string, payload: unknown, timestamp = '2026-06-04T12:00:00.000Z'): string {
  return JSON.stringify({ timestamp, type, payload });
}

// ============================================================================
// Root envelope shapes
// ============================================================================

describe('parseCodexLine — root envelope shapes', () => {
  it('parses a session_meta line', () => {
    const raw = envelope('session_meta', {
      id: 'thread-abc123',
      model_provider: 'openai',
      cwd: '/home/user/project',
      originator: 'user',
      cli_version: '0.137.0',
      source: 'cli'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('session_meta');
    if (result.kind === 'session_meta') {
      expect(result.timestamp).toBe('2026-06-04T12:00:00.000Z');
      // SessionMeta carries no model; the provider id and thread id are present.
      expect(result.payload.model_provider).toBe('openai');
      expect(result.payload.id).toBe('thread-abc123');
    }
  });

  it('parses a response_item line', () => {
    const raw = envelope('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello!' }]
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item') {
      expect(result.timestamp).toBe('2026-06-04T12:00:00.000Z');
      expect(result.payload.type).toBe('message');
    }
  });

  it('parses a compacted line', () => {
    const raw = envelope('compacted', {
      message: 'Context compacted after 10 turns.',
      replacement_history: []
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('compacted');
    if (result.kind === 'compacted') {
      expect(result.payload.message).toBe('Context compacted after 10 turns.');
    }
  });

  it('parses a turn_context line', () => {
    const raw = envelope('turn_context', {
      turn_id: 'turn-001',
      cwd: '/home/user/project',
      current_date: '2026-06-04',
      model: 'gpt-4o'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('turn_context');
    if (result.kind === 'turn_context') {
      expect(result.payload.turn_id).toBe('turn-001');
    }
  });

  it('parses an event_msg line', () => {
    const raw = envelope('event_msg', {
      type: 'agent_message',
      message: 'I have completed the task.'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg') {
      expect(result.payload.type).toBe('agent_message');
    }
  });

  // Root records written by Codex CLI 0.161 rollouts, which postdate the rust-v0.137.0 reference.
  it('parses a world_state line', () => {
    const raw = envelope('world_state', { full: true, state: { model: 'gpt-fixture', agents_md: '# Fixture' } });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('world_state');
    if (result.kind === 'world_state') {
      expect(result.payload.full).toBe(true);
      expect(result.payload.state).toEqual({ model: 'gpt-fixture', agents_md: '# Fixture' });
    }
  });

  it('parses a token_usage_record line', () => {
    const raw = envelope('token_usage_record', {
      turn_id: 'turn',
      response_id: 'response',
      usage: { total_tokens: 42 }
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('token_usage_record');
    if (result.kind === 'token_usage_record') {
      expect(result.payload.usage?.total_tokens).toBe(42);
    }
  });
});

// ============================================================================
// Nested response_item variants
// ============================================================================

describe('parseCodexLine — response_item payload variants', () => {
  it('parses a message variant with role and content', () => {
    const raw = envelope('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Fix the bug in parser.ts' }]
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item' && result.payload.type === 'message') {
      expect(result.payload.role).toBe('user');
      expect(result.payload.content).toHaveLength(1);
    }
  });

  it('parses a message variant with phase field', () => {
    const raw = envelope('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Here is the answer.' }],
      phase: 'final_answer'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item' && result.payload.type === 'message') {
      expect(result.payload.phase).toBe('final_answer');
    }
  });

  it('parses a reasoning variant', () => {
    const raw = envelope('response_item', {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Thinking step by step...' }]
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item') {
      expect(result.payload.type).toBe('reasoning');
    }
  });

  it('parses a local_shell_call variant', () => {
    const raw = envelope('response_item', {
      type: 'local_shell_call',
      call_id: 'shell-001',
      status: 'completed',
      action: { type: 'exec', command: 'ls -la' }
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item') {
      expect(result.payload.type).toBe('local_shell_call');
    }
  });

  it('parses a function_call variant with raw string arguments', () => {
    // models.rs L790-793: arguments is a raw JSON string, not pre-parsed
    const raw = envelope('response_item', {
      type: 'function_call',
      name: 'read_file',
      namespace: 'files',
      arguments: '{"path": "/home/user/project/src/index.ts"}',
      call_id: 'call-abc-001'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item' && result.payload.type === 'function_call') {
      expect(result.payload.name).toBe('read_file');
      expect(result.payload.call_id).toBe('call-abc-001');
      // arguments is a string, not an object
      expect(typeof result.payload.arguments).toBe('string');
    }
  });

  it('parses a function_call_output variant with string output', () => {
    // models.rs L808-817: output can be a plain string
    const raw = envelope('response_item', {
      type: 'function_call_output',
      call_id: 'call-abc-001',
      output: 'export function parseCodexLine(raw: string): CodexRolloutLine { ... }'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item' && result.payload.type === 'function_call_output') {
      expect(result.payload.call_id).toBe('call-abc-001');
      expect(typeof result.payload.output).toBe('string');
    }
  });

  it('parses a function_call_output variant with ContentItem[] output', () => {
    // models.rs L808-817: output can also be an array of content items
    const raw = envelope('response_item', {
      type: 'function_call_output',
      call_id: 'call-abc-002',
      output: [
        { type: 'output_text', text: 'File contents: line 1' },
        { type: 'output_text', text: 'File contents: line 2' }
      ]
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item' && result.payload.type === 'function_call_output') {
      expect(Array.isArray(result.payload.output)).toBe(true);
    }
  });

  it('parses an unknown response_item variant as a readable raw fallback', () => {
    const raw = envelope('response_item', {
      type: 'future_unknown_variant_xyz',
      some_field: 'some_value'
    });
    const result = parseCodexLine(raw);
    // Should not be malformed — it is a valid envelope with an unknown nested type
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item') {
      expect(result.payload.type).toBe('future_unknown_variant_xyz');
    }
  });
});

// ============================================================================
// event_msg variants
// ============================================================================

describe('parseCodexLine — event_msg payload variants', () => {
  it('parses a user_message event', () => {
    const raw = envelope('event_msg', {
      type: 'user_message',
      message: 'Please fix the TypeScript error in parser.ts',
      client_id: 'client-001'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg' && result.payload.type === 'user_message') {
      expect(result.payload.message).toBe('Please fix the TypeScript error in parser.ts');
    }
  });

  it('parses an agent_message event', () => {
    const raw = envelope('event_msg', {
      type: 'agent_message',
      message: 'I have analyzed the code and found the issue.'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg' && result.payload.type === 'agent_message') {
      expect(result.payload.message).toBe('I have analyzed the code and found the issue.');
    }
  });

  it('parses a token_count event with usage totals', () => {
    const raw = envelope('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1024,
          cached_input_tokens: 256,
          output_tokens: 512,
          reasoning_output_tokens: 128,
          total_tokens: 1920
        }
      }
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    expect(result).toMatchObject({
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1024 } } }
    });
  });

  it('parses a task_started lifecycle event', () => {
    const raw = envelope('event_msg', { type: 'task_started' });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg') {
      expect(result.payload.type).toBe('task_started');
    }
  });

  it('parses a task_complete lifecycle event', () => {
    const raw = envelope('event_msg', { type: 'task_complete', exit_code: 0 });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg') {
      expect(result.payload.type).toBe('task_complete');
    }
  });

  it('parses an error event', () => {
    const raw = envelope('event_msg', { type: 'error', message: 'Connection timeout' });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg' && result.payload.type === 'error') {
      expect(result.payload.message).toBe('Connection timeout');
    }
  });
});

// ============================================================================
// Tier 3 contract corrections (protocol fidelity at rust-v0.137.0)
// ============================================================================

describe('parseCodexLine — session_meta contract corrections', () => {
  it('parses model_provider on session_meta (renamed from model_provider_id)', () => {
    const raw = envelope('session_meta', {
      id: 'thread-abc123',
      model_provider: 'openai',
      cwd: '/home/user/project'
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('session_meta');
    if (result.kind === 'session_meta') {
      expect(result.payload.model_provider).toBe('openai');
      // `model` is no longer a declared field on SessionMetaPayload — it lives on
      // turn_context. Reading it via the index signature yields undefined here.
      expect(result.payload['model']).toBeUndefined();
    }
  });
});

describe('parseCodexLine — task_complete carries duration_ms and turn_id', () => {
  it('exposes duration_ms and turn_id on a task_complete event', () => {
    const raw = envelope('event_msg', {
      type: 'task_complete',
      turn_id: 'turn-9',
      last_agent_message: 'All done.',
      duration_ms: 4200
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    if (result.kind === 'event_msg' && result.payload.type === 'task_complete') {
      expect(result.payload.duration_ms).toBe(4200);
      expect(result.payload.turn_id).toBe('turn-9');
    }
  });
});

describe('parseCodexLine — persisted tool-activity end events', () => {
  it('parses an mcp_tool_call_end event with invocation and result', () => {
    const raw = envelope('event_msg', {
      type: 'mcp_tool_call_end',
      call_id: 'mcp-1',
      invocation: { server: 'github', tool: 'list_prs', arguments: { state: 'open' } },
      result: { ok: true }
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('event_msg');
    expect(result).toMatchObject({
      payload: { type: 'mcp_tool_call_end', invocation: { server: 'github', tool: 'list_prs' } }
    });
  });
});

// ============================================================================
// Malformed and unknown lines
// ============================================================================

describe('parseCodexLine — malformed and unknown lines', () => {
  it('returns malformed for truncated JSON', () => {
    const raw = '{"timestamp":"2026-06-04T12:00:00.000Z","type":"session_meta","payload":{';
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.raw).toBe(raw);
    }
  });

  it('returns malformed for completely invalid JSON', () => {
    const raw = 'not json at all !!!';
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.raw).toBe(raw);
    }
  });

  it('returns malformed for a line missing the type field', () => {
    const raw = JSON.stringify({ timestamp: '2026-06-04T12:00:00.000Z', payload: { foo: 'bar' } });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('malformed');
  });

  it('returns malformed for an empty string', () => {
    const result = parseCodexLine('');
    expect(result.kind).toBe('malformed');
  });

  it('returns unknown for an unrecognized root type (future extension)', () => {
    const raw = envelope('future_root_type_xyz', { some_payload: true });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      // timestamp is preserved when present
      expect(result.timestamp).toBe('2026-06-04T12:00:00.000Z');
    }
  });

  it('returns unknown without crashing for a future type with no timestamp', () => {
    const raw = JSON.stringify({ type: 'future_type', payload: {} });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.timestamp).toBeUndefined();
    }
  });
});

// ============================================================================
// Optional fields — no-throw guarantee
// ============================================================================

describe('parseCodexLine — optional fields absent do not throw', () => {
  it('parses session_meta with minimal fields present', () => {
    // All session_meta fields are optional (protocol.rs L2835-L2841)
    const raw = envelope('session_meta', {});
    expect(() => parseCodexLine(raw)).not.toThrow();
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('session_meta');
  });

  it('parses turn_context with only required structure', () => {
    const raw = envelope('turn_context', {});
    expect(() => parseCodexLine(raw)).not.toThrow();
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('turn_context');
  });

  it('parses function_call_output with optional name absent', () => {
    const raw = envelope('response_item', {
      type: 'function_call_output',
      call_id: 'call-003',
      output: 'OK'
    });
    expect(() => parseCodexLine(raw)).not.toThrow();
  });

  it('parses a message response_item with no phase field', () => {
    const raw = envelope('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Done.' }]
    });
    const result = parseCodexLine(raw);
    expect(result.kind).toBe('response_item');
    if (result.kind === 'response_item' && result.payload.type === 'message') {
      expect(result.payload.phase).toBeUndefined();
    }
  });
});

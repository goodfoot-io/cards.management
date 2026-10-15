/**
 * Native linkage acceptance checks use authentic record shapes and synthetic identities.
 * Claude relationship fields follow the captured 2.1.280 foreground/background projections;
 * these reconstructed envelopes are replay fixtures, never claimed captured transcripts.
 * @summary Provider linkage evidence acceptance contracts
 * @module test/provider-linkage
 */

import { describe, expect, it } from 'vitest';
import { extractAntigravityLinkage } from '../src/streams/antigravity-session/www/lib/extract-linkage';
import { extractClaudeLinkage } from '../src/streams/claude-code-session/www/lib/extract-linkage';
import { extractCodexLinkage } from '../src/streams/codex-session/www/lib/extract-linkage';
import type { NativeTranscriptSource } from '../src/streams/lib/session/types';
import { extractOpencodeLinkage } from '../src/streams/opencode-session/www/lib/extract-linkage';

/**
 * Construct an authorized native snapshot without deriving identity from filenames.
 * @param records - Reconstructed native objects or malformed raw lines.
 * @param headLineNumber - Absolute coordinate of the first available record.
 * @returns Native source with inert transport metadata.
 */
function source(records: readonly unknown[], headLineNumber = 1): NativeTranscriptSource {
  return {
    sourceKey: 'authorized:parent',
    generation: 'epoch-1',
    filename: 'misleading-label.jsonl',
    lines: records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))),
    headLineNumber,
    meta: null,
    isLoading: false,
    error: null
  };
}

const call = {
  type: 'assistant',
  uuid: 'call-event',
  sessionId: 'SESSION',
  message: {
    content: [{ type: 'tool_use', name: 'Agent', id: 'TOOL' }]
  }
};
const result = {
  type: 'user',
  uuid: 'result-event',
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'TOOL' }]
  },
  toolUseResult: { status: 'completed', agentId: 'CHILD' }
};
const child = {
  type: 'assistant',
  sessionId: 'SESSION',
  agentId: 'CHILD',
  isSidechain: true,
  message: { content: [{ type: 'text', text: 'Observed child activity' }] }
};

/**
 * Build a native OpenCode task-part exporter envelope.
 * @param childSessionId - Native metadata target, absent before a later update.
 * @param caller - Native caller identity carried by task metadata.
 * @returns Reconstructed exporter envelope preserving native part fields.
 */
function task(childSessionId: string | undefined, caller = 'PARENT'): unknown {
  return {
    v: 1,
    ts: '2026-09-22T00:00:00Z',
    seq: 1,
    sessionId: 'PARENT',
    type: 'part',
    data: {
      type: 'tool',
      id: 'PART',
      messageID: 'MESSAGE',
      sessionID: 'PARENT',
      callID: 'CALL',
      tool: 'task',
      state: { status: 'completed', metadata: { parentSessionId: caller, sessionId: childSessionId } }
    }
  };
}

describe('Claude witnessed structured linkage', () => {
  it.skip.each([
    'completed',
    'async_launched'
  ])('joins %s result without inventing its absent session identity', (status) => {
    const evidence = extractClaudeLinkage(
      source([call, { ...result, toolUseResult: { status, agentId: 'CHILD' } }], 41)
    );
    expect(evidence.capability).toBe('witnessed-delegation');
    expect(evidence.delegations).toHaveLength(1);
    expect(evidence.delegations[0]).toMatchObject({
      callId: 'TOOL',
      relation: 'delegation',
      parent: { sourceKey: 'authorized:parent', generation: 'epoch-1', lineNumber: 41 },
      caller: { provider: 'claude-code', sessionId: 'SESSION', isSidechain: false },
      target: { provider: 'claude-code', sessionId: 'SESSION', agentId: 'CHILD', isSidechain: true }
    });
    expect(evidence.delegations[0]?.evidence.map((item) => item.lineNumber)).toEqual([41, 42]);
  });
  it.skip('exposes child native identity independently of its filename', () => {
    expect(extractClaudeLinkage(source([child])).identities[0]?.identity).toEqual({
      provider: 'claude-code',
      sessionId: 'SESSION',
      agentId: 'CHILD',
      isSidechain: true
    });
  });
  it.skip('resolves a late result equivalently after every available incremental prefix', () => {
    const records = [call, { type: 'system', sessionId: 'SESSION' }, result];
    for (let count = 0; count < records.length; count++)
      expect(extractClaudeLinkage(source(records.slice(0, count))).delegations).toEqual([]);
    expect(extractClaudeLinkage(source(records)).delegations).toHaveLength(1);
    expect(extractClaudeLinkage(source(records)).delegations).toEqual(
      extractClaudeLinkage(source([...records])).delegations
    );
  });
  it.skip.each([
    [result],
    [call],
    [call, { ...result, toolUseResult: undefined }],
    [call, { ...result, sessionId: 'OTHER' }],
    [call, { ...result, toolUseResult: { agentId: '' } }],
    [call, { ...call, uuid: 'duplicate-call' }, result],
    [call, result, { ...result, uuid: 'conflict', toolUseResult: { agentId: 'OTHER' } }],
    [{ ...call, message: { content: [{ type: 'tool_use', name: 'Bash', id: 'TOOL' }] } }, result]
  ])('keeps missing, malformed, conflicting or ambiguous chains unresolved %#', (...records) => {
    expect(extractClaudeLinkage(source(records)).delegations).toEqual([]);
  });
  it.skip('preserves physical absolute occurrence through malformed and blank records', () => {
    const evidence = extractClaudeLinkage(source(['{', '', call, result], 100));
    expect(evidence.delegations[0]?.parent.lineNumber).toBe(102);
    expect(evidence.diagnostics.some((item) => item.code === 'malformed')).toBe(true);
  });
});

describe('OpenCode source-level references', () => {
  it.skip('retains exact caller task and child identity without enabling nesting', () => {
    const evidence = extractOpencodeLinkage(source([task('CHILD')], 20));
    expect(evidence.capability).toBe('references-only');
    expect(evidence.delegations[0]).toMatchObject({
      relation: 'reference',
      callId: 'CALL',
      parent: { lineNumber: 20 },
      caller: { provider: 'opencode', sessionId: 'PARENT' },
      target: { provider: 'opencode', sessionId: 'CHILD' }
    });
  });
  it.skip('folds late metadata and repeated part updates into one current reference', () => {
    expect(extractOpencodeLinkage(source([task(undefined)])).delegations).toEqual([]);
    expect(extractOpencodeLinkage(source([task(undefined), task('CHILD'), task('CHILD')])).delegations).toHaveLength(1);
    expect(extractOpencodeLinkage(source([task('CHILD'), task(undefined)])).delegations).toEqual([]);
  });
  it.skip('rejects caller disagreement and does not turn root metadata into parent edges', () => {
    expect(extractOpencodeLinkage(source([task('CHILD', 'OTHER')])).delegations).toEqual([]);
    const evidence = extractOpencodeLinkage(
      source([{ v: 1, type: 'meta', sessionId: 'GRANDCHILD', data: { parentSessionId: 'ROOT' } }])
    );
    expect(evidence.delegations).toEqual([]);
  });
});

describe('bounded Codex and Antigravity topology', () => {
  it.skip('preserves explicit Codex sender/new-thread links only as references', () => {
    const evidence = extractCodexLinkage(
      source([
        { type: 'session_meta', payload: { id: 'PARENT' } },
        {
          type: 'event_msg',
          payload: {
            type: 'collab_agent_spawn_end',
            call_id: 'CALL',
            sender_thread_id: 'PARENT',
            new_thread_id: 'CHILD'
          }
        }
      ])
    );
    expect(evidence.capability).toBe('references-only');
    expect(evidence.delegations[0]).toMatchObject({
      relation: 'reference',
      callId: 'CALL',
      target: { provider: 'codex', threadId: 'CHILD' }
    });
  });
  it.skip('rejects foreign sender, failed spawn and arbitrary textual agent identifiers', () => {
    const evidence = extractCodexLinkage(
      source([
        { type: 'session_meta', payload: { id: 'PARENT' } },
        {
          type: 'event_msg',
          payload: {
            type: 'collab_agent_spawn_end',
            call_id: 'CALL',
            sender_thread_id: 'OTHER',
            new_thread_id: 'CHILD'
          }
        },
        {
          type: 'event_msg',
          payload: { type: 'collab_agent_spawn_end', call_id: 'FAILED', sender_thread_id: 'PARENT' }
        },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'TEXT', output: 'agent_id: CHILD' } }
      ])
    );
    expect(evidence.delegations).toEqual([]);
  });
  it.skip('keeps Antigravity main-only despite trajectory or tool hints', () => {
    const evidence = extractAntigravityLinkage(
      source([{ idx: 1, has_subtrajectory: true, trajectory_id: 'CHILD', tool: { name: 'task' } }])
    );
    expect(evidence.capability).toBe('main-only');
    expect(evidence.identities).toEqual([]);
    expect(evidence.delegations).toEqual([]);
  });
});

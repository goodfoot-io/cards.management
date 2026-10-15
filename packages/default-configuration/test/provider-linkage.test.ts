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
  it.each([
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
  it('exposes child native identity independently of its filename', () => {
    expect(extractClaudeLinkage(source([child])).identities[0]?.identity).toEqual({
      provider: 'claude-code',
      sessionId: 'SESSION',
      agentId: 'CHILD',
      isSidechain: true
    });
  });
  it('resolves a late result equivalently after every available incremental prefix', () => {
    const records = [call, { type: 'system', sessionId: 'SESSION' }, result];
    for (let count = 0; count < records.length; count++)
      expect(extractClaudeLinkage(source(records.slice(0, count))).delegations).toEqual([]);
    expect(extractClaudeLinkage(source(records)).delegations).toHaveLength(1);
    expect(extractClaudeLinkage(source(records)).delegations).toEqual(
      extractClaudeLinkage(source([...records])).delegations
    );
  });
  it.each([
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
  it('preserves physical absolute occurrence through malformed and blank records', () => {
    const evidence = extractClaudeLinkage(source(['{', '', call, result], 100));
    expect(evidence.delegations[0]?.parent.lineNumber).toBe(102);
    expect(evidence.diagnostics.some((item) => item.code === 'malformed')).toBe(true);
  });
});

describe('OpenCode source-level references', () => {
  it('retains exact caller task and child identity without enabling nesting', () => {
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
  it('folds late metadata and repeated part updates into one current reference', () => {
    expect(extractOpencodeLinkage(source([task(undefined)])).delegations).toEqual([]);
    expect(extractOpencodeLinkage(source([task(undefined), task('CHILD'), task('CHILD')])).delegations).toHaveLength(1);
    expect(extractOpencodeLinkage(source([task('CHILD'), task(undefined)])).delegations).toEqual([]);
  });
  it('rejects caller disagreement and does not turn root metadata into parent edges', () => {
    expect(extractOpencodeLinkage(source([task('CHILD', 'OTHER')])).delegations).toEqual([]);
    const evidence = extractOpencodeLinkage(
      source([{ v: 1, type: 'meta', sessionId: 'GRANDCHILD', data: { parentSessionId: 'ROOT' } }])
    );
    expect(evidence.delegations).toEqual([]);
  });
});

describe('bounded Codex and Antigravity topology', () => {
  it('preserves explicit Codex sender/new-thread links only as references', () => {
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
  it('rejects foreign sender, failed spawn and arbitrary textual agent identifiers', () => {
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
  it('keeps Antigravity main-only despite trajectory or tool hints', () => {
    const evidence = extractAntigravityLinkage(
      source([{ idx: 1, has_subtrajectory: true, trajectory_id: 'CHILD', tool: { name: 'task' } }])
    );
    expect(evidence.capability).toBe('main-only');
    expect(evidence.identities).toEqual([]);
    expect(evidence.delegations).toEqual([]);
  });
});

// Further checks exercise the same accepted contract, including physical replay provenance.
describe('source identity, ambiguity and snapshot replay', () => {
  it('retains all duplicate physical occurrences while folding native Claude event identity', () => {
    const evidence = extractClaudeLinkage(source([call, call, result, result], 70));
    expect(evidence.delegations).toHaveLength(1);
    expect(evidence.delegations[0]?.evidence.map((item) => item.lineNumber)).toEqual([70, 71, 72, 73]);
    expect(evidence.delegations[0]?.evidence.every((item) => item.selector !== 'record')).toBe(true);
  });
  it('uses the nested caller identity without promoting sibling labels into identities', () => {
    const evidence = extractClaudeLinkage(source([{ ...call, agentId: 'NESTED', isSidechain: true }, result]));
    expect(evidence.delegations[0]?.caller).toEqual({
      provider: 'claude-code',
      sessionId: 'SESSION',
      agentId: 'NESTED',
      isSidechain: true
    });
    expect(extractClaudeLinkage(source([{ ...call, sessionId: undefined }, result])).delegations).toEqual([]);
    expect(extractClaudeLinkage(source([{ ...call, isSidechain: true }, result])).delegations).toEqual([]);
    expect(
      extractClaudeLinkage(source([call, { ...call, sessionId: 'OTHER', uuid: 'OTHER' }, result])).delegations
    ).toEqual([]);
  });
  it('rejects multiple result blocks and conflicting native event IDs', () => {
    expect(
      extractClaudeLinkage(
        source([
          call,
          {
            ...result,
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'TOOL' },
                { type: 'tool_result', tool_use_id: 'OTHER' }
              ]
            }
          }
        ])
      ).delegations
    ).toEqual([]);
    expect(extractClaudeLinkage(source([call, { ...call, message: { content: [] } }, result])).delegations).toEqual([]);
  });
  it('keeps resumed OpenCode references distinct while refusing a mutated call identity', () => {
    const first = task('CHILD') as { data: Record<string, unknown> };
    const resumed = { ...first, data: { ...first.data, id: 'PART-2', callID: 'CALL-2' } };
    const evidence = extractOpencodeLinkage(source([first, resumed]));
    expect(evidence.delegations).toHaveLength(2);
    expect(evidence.delegations.every((item) => item.relation === 'reference')).toBe(true);
    expect(
      extractOpencodeLinkage(source([first, { ...first, data: { ...first.data, callID: 'CHANGED' } }])).delegations
    ).toEqual([]);
  });
  it('refuses missing/conflicting Codex source identity and competing call targets', () => {
    const spawn = {
      type: 'event_msg',
      payload: { type: 'collab_agent_spawn_end', sender_thread_id: 'PARENT', new_thread_id: 'CHILD', call_id: 'CALL' }
    };
    expect(extractCodexLinkage(source([spawn])).delegations).toEqual([]);
    expect(
      extractCodexLinkage(
        source([
          { type: 'session_meta', payload: { id: 'PARENT' } },
          spawn,
          { type: 'session_meta', payload: { id: 'OTHER' } }
        ])
      ).delegations
    ).toEqual([]);
    expect(
      extractCodexLinkage(
        source([
          { type: 'session_meta', payload: { id: 'PARENT' } },
          spawn,
          { ...spawn, payload: { ...spawn.payload, new_thread_id: 'OTHER' } }
        ])
      ).delegations
    ).toEqual([]);
  });
  it.each([
    ['claude-code', extractClaudeLinkage, [call, { type: 'system', sessionId: 'SESSION' }, result]],
    ['opencode', extractOpencodeLinkage, [task(undefined), task('CHILD'), task('CHILD'), task(undefined)]],
    [
      'codex',
      extractCodexLinkage,
      [
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
      ]
    ],
    ['antigravity', extractAntigravityLinkage, [{ idx: 0 }, '{', { idx: 1 }]]
  ] as const)('replays every %s split without retaining previous snapshots or mutating input', (_provider, extract, records) => {
    const native = source(records, 300);
    const before = JSON.stringify(native);
    const full = extract(native);
    for (let split = 0; split <= native.lines.length; split++) {
      extract({ ...native, lines: native.lines.slice(0, split) });
      expect(extract(native)).toEqual(full);
      const tail = { ...native, headLineNumber: native.headLineNumber + split, lines: native.lines.slice(split) };
      extract(tail);
      expect(extract(native)).toEqual(full);
    }
    expect(JSON.stringify(native)).toBe(before);
    for (const evidence of full.delegations) {
      for (const occurrence of [evidence.parent, ...evidence.evidence]) {
        expect(occurrence.sourceKey).toBe(native.sourceKey);
        expect(occurrence.generation).toBe(native.generation);
        expect(occurrence.lineNumber).toBeGreaterThanOrEqual(300);
        expect(occurrence.selector.length).toBeGreaterThan(0);
      }
    }
    const replacement = extract({ ...native, sourceKey: 'different', generation: 'epoch-2' });
    expect(replacement.sourceKey).toBe('different');
    expect(replacement.generation).toBe('epoch-2');
    expect(
      replacement.delegations.every(
        (item) => item.parent.sourceKey === 'different' && item.parent.generation === 'epoch-2'
      )
    ).toBe(true);
  });
});

describe('structured Claude ambiguity remains fail-closed', () => {
  it('rejects an error result despite a conflicting completed top-level payload', () => {
    const failure = { ...result, message: { content: [{ type: 'tool_result', tool_use_id: 'TOOL', is_error: true }] } };
    expect(extractClaudeLinkage(source([call, failure])).delegations).toEqual([]);
  });
  it('rejects a reused tool ID even when its competing call has another tool name', () => {
    const competing = {
      ...call,
      uuid: 'OTHER',
      message: { content: [{ type: 'tool_use', name: 'Bash', id: 'TOOL' }] }
    };
    expect(extractClaudeLinkage(source([call, competing, result])).delegations).toEqual([]);
  });
  it('does not ignore an ambiguous competing result record', () => {
    const ambiguous = {
      ...result,
      uuid: 'AMBIGUOUS',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'TOOL' },
          { type: 'tool_result', tool_use_id: 'OTHER' }
        ]
      }
    };
    expect(extractClaudeLinkage(source([call, result, ambiguous])).delegations).toEqual([]);
  });
});

describe('native identifiers are bounded inert evidence', () => {
  it.each([
    'X'.repeat(4097),
    'BAD\u0000ID',
    'BAD\u007fID',
    'BAD\u0085ID'
  ])('rejects unsafe native identifiers %# without copying payload bodies', (invalid) => {
    expect(extractClaudeLinkage(source([{ ...call, sessionId: invalid }, result])).delegations).toEqual([]);
    expect(extractClaudeLinkage(source([{ ...call, agentId: invalid }, result])).delegations).toEqual([]);
    const badCall = { ...call, message: { content: [{ type: 'tool_use', name: 'Agent', id: invalid }] } };
    const matchingResult = { ...result, message: { content: [{ type: 'tool_result', tool_use_id: invalid }] } };
    expect(extractClaudeLinkage(source([badCall, matchingResult])).delegations).toEqual([]);
    const badTarget = { ...result, toolUseResult: { status: 'completed', agentId: invalid, body: 'PRIVATE BODY' } };
    const unresolved = extractClaudeLinkage(source([call, badTarget]));
    expect(unresolved.delegations).toEqual([]);
    expect(JSON.stringify(unresolved.diagnostics)).not.toContain('PRIVATE BODY');
    const uuidEvidence = extractClaudeLinkage(
      source([
        { ...call, uuid: invalid },
        { ...result, uuid: invalid }
      ])
    );
    expect(uuidEvidence.delegations).toHaveLength(1);
    expect(
      uuidEvidence.delegations.flatMap((item) => item.evidence).every((item) => item.nativeEventId === undefined)
    ).toBe(true);
    expect(
      uuidEvidence.identities.flatMap((item) => item.occurrences).every((item) => item.nativeEventId === undefined)
    ).toBe(true);
    const nativeTask = task('CHILD') as { data: Record<string, unknown> };
    expect(
      extractOpencodeLinkage(source([{ ...nativeTask, data: { ...nativeTask.data, callID: invalid } }])).delegations
    ).toEqual([]);
    expect(extractCodexLinkage(source([{ type: 'session_meta', payload: { id: invalid } }])).identities).toEqual([]);
  });
  it('preserves exact identifier bytes at the accepted size boundary', () => {
    const sessionId = 'X'.repeat(4096);
    const evidence = extractClaudeLinkage(source([{ ...call, sessionId }, result]));
    expect(evidence.delegations[0]?.caller).toMatchObject({ sessionId });
  });
});

it('does not confuse an absent UUID with a literal native identifier', () => {
  const evidence = extractClaudeLinkage(
    source([
      { ...call, uuid: undefined },
      { ...result, uuid: 'undefined' }
    ])
  );
  expect(evidence.delegations[0]?.evidence.map((item) => item.lineNumber)).toEqual([1, 2]);
});

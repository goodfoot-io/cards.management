/**
 * Session composition over real provider projections and linkage extraction.
 *
 * Provider fixture capability table (what each provider's native records can prove):
 *
 * | Provider    | Capability            | Fixture evidence                                         |
 * |-------------|-----------------------|----------------------------------------------------------|
 * | Claude Code | witnessed-delegation  | Agent tool_use joined to toolUseResult.agentId + sidechain |
 * | Codex       | references-only       | captured rollout records; no witnessed chain             |
 * | Antigravity | main-only             | captured stream-json; no sub-trajectories                |
 *
 * @summary Witnessed placement, member sections, diagnostics and replay equivalence
 */

import { readFileSync } from 'node:fs';
import type { SessionDescriptor, SessionMember } from '@cards.management/sdk/protocol';
import { describe, expect, it } from 'vitest';
import { extractAntigravityLinkage } from '../src/streams/antigravity-session/www/lib/extract-linkage';
import { antigravitySessionProjector } from '../src/streams/antigravity-session/www/lib/project-session';
import { extractClaudeLinkage } from '../src/streams/claude-code-session/www/lib/extract-linkage';
import { type ClaudeRow, claudeSessionProjector } from '../src/streams/claude-code-session/www/lib/project-session';
import { extractCodexLinkage } from '../src/streams/codex-session/www/lib/extract-linkage';
import { codexSessionProjector } from '../src/streams/codex-session/www/lib/project-session';
import { composeSession, placementIdentity } from '../src/streams/lib/session/compose';
import type { SourceLinkageEvidence } from '../src/streams/lib/session/linkage';
import {
  createTranscriptProjection,
  type NativeTranscriptProjector,
  replayTranscript
} from '../src/streams/lib/session/projection';
import type { NativeTranscriptSource } from '../src/streams/lib/session/types';
import { delegate, delegated, lines, prompt, reply, sidechain } from './fixtures/claude-session-members';

const CARD = 'card-1';

interface Member {
  readonly relPath: string;
  readonly role: SessionMember['role'];
  readonly agentId?: string;
  readonly lines: readonly string[];
}

const keyOf = (streamType: string, relPath: string) => JSON.stringify([CARD, streamType, relPath]);

function descriptorOf(streamType: string, members: readonly Member[]): SessionDescriptor {
  const declared: SessionMember[] = members.map(({ relPath, role, agentId }) => ({
    source: { cardId: CARD, streamType, relPath },
    role,
    ...(agentId ? { agentId } : {})
  }));
  const mains = declared.filter((member) => member.role === 'main');
  return {
    session: { cardId: CARD, streamType, sessionId: 'SESSION' },
    members: declared,
    main: mains.length === 1 ? mains[0]!.source : null,
    validity: mains.length === 1 ? 'ready' : mains.length === 0 ? 'missing-main' : 'conflicting-main'
  };
}

function nativeSource(streamType: string, member: Member, count = member.lines.length): NativeTranscriptSource {
  return {
    sourceKey: keyOf(streamType, member.relPath),
    generation: 'epoch-1',
    filename: member.relPath,
    lines: member.lines.slice(0, count),
    headLineNumber: 1,
    meta: null,
    isLoading: false,
    error: null
  };
}

interface Provider {
  readonly streamType: string;
  // biome-ignore lint/suspicious/noExplicitAny: provider projection state is opaque here.
  readonly projector: NativeTranscriptProjector<any, any, any>;
  readonly extract: (source: NativeTranscriptSource) => SourceLinkageEvidence;
  readonly nestedRows?: (row: ClaudeRow) => readonly ClaudeRow[] | undefined;
}

const CLAUDE: Provider = {
  streamType: 'claude-code-session',
  projector: claudeSessionProjector,
  extract: extractClaudeLinkage,
  nestedRows: (row) => (row.kind === 'provider' && row.providerKind === 'group' ? row.data.rows : undefined)
};

/**
 * Full replay of every member's complete content.
 * @param provider - Provider projection and linkage.
 * @param members - Session members with their native lines.
 * @returns Composition of the complete content.
 */
function replay(provider: Provider, members: readonly Member[]) {
  const sources = members.map((member, index) => {
    const source = nativeSource(provider.streamType, member);
    return {
      key: source.sourceKey,
      member: descriptorOf(provider.streamType, members).members[index]!,
      rows: replayTranscript(provider.projector, source).rows,
      linkage: source.lines.length > 0 ? provider.extract(source) : null
    };
  });
  return composeSession({
    descriptor: descriptorOf(provider.streamType, members),
    sources,
    nestedRows: provider.nestedRows as never
  });
}

/**
 * Incremental arrival: members grow one line at a time in an interleaved order.
 * @param provider - Provider projection and linkage.
 * @param members - Session members with their native lines.
 * @yields Composition after each arrival.
 */
function* incremental(provider: Provider, members: readonly Member[]) {
  const descriptor = descriptorOf(provider.streamType, members);
  const controllers = members.map((member) =>
    createTranscriptProjection(provider.projector, keyOf(provider.streamType, member.relPath))
  );
  const counts = members.map(() => 0);
  const total = members.reduce((sum, member) => sum + member.lines.length, 0);
  for (let step = 0; step < total; step++) {
    const index = members.findIndex((member, at) => counts[at]! < member.lines.length && (step + at) % 2 === 0);
    const chosen = index >= 0 ? index : members.findIndex((member, at) => counts[at]! < member.lines.length);
    counts[chosen]!++;
    const sources = members.map((member, at) => {
      const source = nativeSource(provider.streamType, member, counts[at]);
      return {
        key: source.sourceKey,
        member: descriptor.members[at]!,
        rows: controllers[at]!.update(source).projection.rows,
        linkage: source.lines.length > 0 ? provider.extract(source) : null
      };
    });
    yield composeSession({ descriptor, sources, nestedRows: provider.nestedRows as never });
  }
}

const MAIN: Member = {
  relPath: 'SESSION.jsonl',
  role: 'main',
  lines: lines([
    prompt('Investigate the failure', 'p1'),
    delegate('TOOL-A', 'call-a'),
    delegated('TOOL-A', 'A', 'result-a'),
    reply('Done', 'r1')
  ])
};
const CHILD_A: Member = {
  relPath: 'SESSION/subagents/agent-A.jsonl',
  role: 'subagent',
  agentId: 'A',
  lines: lines([sidechain('A', 'Child A working', 'a1')])
};

describe('Claude Code — witnessed-delegation (Agent call joined to toolUseResult.agentId)', () => {
  it('attaches the subagent after its delegation row with a stable placement identity', () => {
    const composition = replay(CLAUDE, [MAIN, CHILD_A]);
    const childKey = keyOf(CLAUDE.streamType, CHILD_A.relPath);
    expect(composition.mainKey).toBe(keyOf(CLAUDE.streamType, MAIN.relPath));
    expect(composition.children.get(childKey)).toEqual({
      key: childKey,
      placementId: placementIdentity(childKey),
      status: 'witnessed',
      parentKey: composition.mainKey
    });
    const [insertion] = composition.witnessed.get(composition.mainKey!) ?? [];
    expect(insertion?.placement).toMatchObject({ kind: 'witnessed', position: 'after' });
    expect(composition.sections).toEqual([]);
    expect(composition.diagnostics).toEqual([]);
  });

  it('keeps a member section until the late result arrives, then moves it without duplication', () => {
    const steps = [...incremental(CLAUDE, [MAIN, CHILD_A])];
    const childKey = keyOf(CLAUDE.streamType, CHILD_A.relPath);
    const statuses = steps.map((composition) => composition.children.get(childKey)?.status);
    const witnessedAt = statuses.indexOf('witnessed');
    expect(witnessedAt).toBeGreaterThan(0);
    expect(statuses.slice(witnessedAt).every((status) => status === 'witnessed')).toBe(true);
    for (const composition of steps) {
      const placements = [
        ...composition.sections,
        ...composition.anomalous,
        ...[...composition.witnessed.values()].flat().map((insertion) => insertion.childSourceKey)
      ].filter((key) => key === childKey);
      expect(placements.length).toBeLessThanOrEqual(1);
      expect(composition.children.get(childKey)?.placementId ?? placementIdentity(childKey)).toBe(
        placementIdentity(childKey)
      );
    }
  });

  it('reaches the full-replay composition through incremental arrival', () => {
    const steps = [...incremental(CLAUDE, [MAIN, CHILD_A])];
    expect(steps.at(-1)).toEqual(replay(CLAUDE, [MAIN, CHILD_A]));
  });

  it('reports a delegation to an absent member as unresolved and renders nothing nested', () => {
    const main: Member = {
      ...MAIN,
      lines: lines([delegate('TOOL-Z', 'call-z'), delegated('TOOL-Z', 'ZED', 'result-z')])
    };
    const composition = replay(CLAUDE, [main, CHILD_A]);
    expect(composition.diagnostics.map((item) => item.issue)).toEqual(['unresolved-target']);
    expect(composition.diagnostics[0]).toMatchObject({ callId: 'TOOL-Z', lines: [1, 2] });
    expect(composition.sections).toEqual([keyOf(CLAUDE.streamType, CHILD_A.relPath)]);
  });

  it('marks a child claimed by two delegations anomalous with both claims diagnosed', () => {
    const main: Member = {
      ...MAIN,
      lines: lines([
        delegate('TOOL-1', 'c1'),
        delegated('TOOL-1', 'A', 'r1'),
        delegate('TOOL-2', 'c2'),
        delegated('TOOL-2', 'A', 'r2')
      ])
    };
    const composition = replay(CLAUDE, [main, CHILD_A]);
    const childKey = keyOf(CLAUDE.streamType, CHILD_A.relPath);
    expect(composition.anomalous).toEqual([childKey]);
    expect(composition.children.get(childKey)?.status).toBe('anomalous');
    expect(composition.witnessed.size).toBe(0);
    expect(composition.diagnostics.map((item) => [item.issue, item.callId])).toEqual(
      expect.arrayContaining([
        ['duplicate-delegation', 'TOOL-1'],
        ['duplicate-delegation', 'TOOL-2']
      ])
    );
  });

  it('breaks a delegation cycle between subagents instead of nesting either', () => {
    const childA: Member = {
      ...CHILD_A,
      lines: lines([sidechain('A', 'A', 'a1'), delegate('TOOL-B', 'ab', 'A'), delegated('TOOL-B', 'B', 'abr', 'A')])
    };
    const childB: Member = {
      relPath: 'SESSION/subagents/agent-B.jsonl',
      role: 'subagent',
      agentId: 'B',
      lines: lines([sidechain('B', 'B', 'b1'), delegate('TOOL-A', 'ba', 'B'), delegated('TOOL-A', 'A', 'bar', 'B')])
    };
    const main: Member = { ...MAIN, lines: lines([prompt('Go', 'p1')]) };
    const composition = replay(CLAUDE, [main, childA, childB]);
    expect([...composition.anomalous].sort()).toEqual(
      [keyOf(CLAUDE.streamType, childA.relPath), keyOf(CLAUDE.streamType, childB.relPath)].sort()
    );
    expect(composition.witnessed.size).toBe(0);
    expect(composition.diagnostics.filter((item) => item.issue === 'cyclic-delegation')).toHaveLength(2);
  });

  it('keeps witnessed nesting under a member section when the group has no main', () => {
    const orphan: Member = { ...MAIN, role: 'subagent', agentId: 'ROOT' };
    const composition = replay(CLAUDE, [orphan, CHILD_A]);
    const orphanKey = keyOf(CLAUDE.streamType, orphan.relPath);
    expect(composition.mainKey).toBeNull();
    expect(composition.sections).toEqual([orphanKey]);
    expect(composition.children.get(keyOf(CLAUDE.streamType, CHILD_A.relPath))).toMatchObject({
      status: 'witnessed',
      parentKey: orphanKey
    });
  });
});

describe('Codex — references-only (captured rollout records; no witnessed chain)', () => {
  it('never nests members and keeps every other member as a labeled section', () => {
    const native = readFileSync(new URL('./fixtures/codex-session/native-session.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean);
    const codex: Provider = {
      streamType: 'codex-session',
      projector: codexSessionProjector,
      extract: extractCodexLinkage
    };
    const members: Member[] = [
      { relPath: 'rollout-main.jsonl', role: 'main', lines: native },
      { relPath: 'rollout-other.jsonl', role: 'auxiliary', lines: [] }
    ];
    const composition = replay(codex, members);
    expect(composition.witnessed.size).toBe(0);
    expect(composition.sections).toEqual([keyOf('codex-session', 'rollout-other.jsonl')]);
    expect(composition.diagnostics.every((item) => item.issue !== 'cyclic-delegation')).toBe(true);
  });
});

describe('Antigravity — main-only (captured stream-json; no sub-trajectories)', () => {
  it('composes the main alone with no relationships or diagnostics', () => {
    const native = readFileSync(
      new URL('./fixtures/antigravity/captured-stream-json-success.jsonl', import.meta.url),
      'utf8'
    )
      .split('\n')
      .filter(Boolean);
    const antigravity: Provider = {
      streamType: 'antigravity-session',
      projector: antigravitySessionProjector,
      extract: extractAntigravityLinkage
    };
    const composition = replay(antigravity, [{ relPath: 'trajectory.jsonl', role: 'main', lines: native }]);
    expect(composition.children.size).toBe(0);
    expect(composition.witnessed.size).toBe(0);
    expect(composition.diagnostics).toEqual([]);
  });
});

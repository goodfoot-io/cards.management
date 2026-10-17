// @vitest-environment jsdom

/**
 * The consolidated session renderer mounted against the real SDK store and in-memory host.
 *
 * Provider fixture capability table:
 *
 * | Provider    | Capability            | Fixture evidence                                   |
 * |-------------|-----------------------|----------------------------------------------------|
 * | Claude Code | witnessed-delegation  | reconstructed Agent call + toolUseResult.agentId   |
 * | Codex       | references-only       | captured rollout records                           |
 * | Antigravity | main-only             | captured stream-json success transcript            |
 *
 * jsdom performs no layout, so these tests cover composition, subscription, controls and
 * lifecycle; measured sizing and anchoring run in the browser suite.
 *
 * @summary Consolidated renderer over a real session store
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamViewState, ViewStateMessage } from '@cards.management/sdk/stream-store';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { antigravitySessionAdapter } from '../src/streams/antigravity-session/www/session-adapter';
import { claudeSessionAdapter } from '../src/streams/claude-code-session/www/session-adapter';
import { codexSessionAdapter } from '../src/streams/codex-session/www/session-adapter';
import type { SessionProviderAdapter } from '../src/streams/lib/session/adapter';
import { SessionRenderer } from '../src/streams/lib/session/SessionRenderer';
import { StreamStoreProvider } from '../src/streams/lib/session/store-context';
import { delegate, delegated, lines, prompt, reply, sidechain } from './fixtures/claude-session-members';
import { createSessionHost, type HostMember, type SessionHost } from './helpers/session-host';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements neither observer nor scrolling; these stand in for absent browser APIs.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
  frames.set(nextFrame, callback);
  return nextFrame++;
});
vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
  frames.delete(id);
});

const MAIN = 'SESSION.jsonl';
const PLACEMENT = '[data-session-disclosure^=\'["session-member"\']';
const CHILD = 'SESSION/subagents/agent-A.jsonl';

const mounted: Root[] = [];
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
  frames.clear();
});

async function mount(
  adapter: SessionProviderAdapter<object>,
  members: readonly HostMember[],
  options: {
    mode?: 'compact' | 'expanded';
    streamType?: string;
    runtime?: string;
    viewState?: StreamViewState;
  } = {}
): Promise<{ host: SessionHost; container: HTMLDivElement; settle: () => Promise<void> }> {
  const host = createSessionHost({
    streamType: options.streamType ?? 'claude-code-session',
    runtime: options.runtime ?? 'claude-code',
    mode: options.mode ?? 'expanded',
    members,
    viewState: options.viewState
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      React.createElement(StreamStoreProvider, { store: host.store }, React.createElement(SessionRenderer, { adapter }))
    );
  });
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  return { host, container, settle };
}

const claude = claudeSessionAdapter as SessionProviderAdapter<object>;
const MEMBERS: HostMember[] = [
  { relPath: MAIN, role: 'main' },
  { relPath: CHILD, role: 'subagent', agentId: 'A' }
];
const MAIN_LINES = lines([
  prompt('Investigate the failure', 'p1'),
  delegate('TOOL-A', 'call-a'),
  delegated('TOOL-A', 'A', 'result-a'),
  reply('All done here.', 'r1')
]);

describe('Claude Code — witnessed-delegation — expanded', () => {
  it('renders main content that arrives after mount without the empty placeholder', async () => {
    const { host, container, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }]);
    expect(host.subscribes(MAIN).at(-1)?.history).toBe('full');
    await act(async () => host.snapshot(MAIN, MAIN_LINES.slice(3), { isActive: false }));
    await settle();
    expect(container.textContent).toContain('All done here.');
    expect(container.textContent).not.toContain('No output yet.');
  });

  it('subscribes the subagent and nests it at the delegation row with a stable disclosure', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    expect(host.subscribes(CHILD).at(-1)?.history).toBe('tail');
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    const placements = container.querySelectorAll(PLACEMENT);
    expect(placements).toHaveLength(1);
    expect(placements[0]!.textContent).toContain('Subagent');
    const text = container.textContent ?? '';
    expect(text.indexOf('Investigate the failure')).toBeLessThan(text.indexOf('Subagent'));
    expect(text.indexOf('Subagent')).toBeLessThan(text.indexOf('All done here.'));
  });

  it('moves a member section under its delegation when the late result arrives', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () => host.snapshot(MAIN, MAIN_LINES.slice(0, 2)));
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    const before = [...container.querySelectorAll(PLACEMENT)];
    expect(before).toHaveLength(1);
    expect(before[0]!.textContent).toContain('no witnessed delegation');
    await act(async () => host.append(MAIN, 3, MAIN_LINES.slice(2)));
    await settle();
    const after = [...container.querySelectorAll(PLACEMENT)];
    expect(after.map((node) => node.getAttribute('data-session-disclosure'))).toEqual(
      before.map((node) => node.getAttribute('data-session-disclosure'))
    );
    expect(after[0]!.textContent).not.toContain('no witnessed delegation');
  });

  it('opens a subagent with full history when its disclosure is opened', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')]), { first: 60 }));
    await settle();
    expect(container.textContent).toMatch(/earlier/i);
    const button = container.querySelector<HTMLButtonElement>(`${PLACEMENT} > .session-disclosure-button`);
    await act(async () => button!.click());
    await settle();
    expect(host.subscribes(CHILD).at(-1)?.history).toBe('full');
  });

  it('labels unresolved delegations in a session-level relationships section', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () =>
      host.snapshot(MAIN, lines([delegate('TOOL-Z', 'call-z'), delegated('TOOL-Z', 'ZED', 'result-z')]))
    );
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    const section = container.querySelector<HTMLElement>(`[data-session-disclosure='["session-relationships"]']`);
    expect(section?.textContent).toContain('Session relationships: 1 diagnostic');
    await act(async () => section!.querySelector<HTMLButtonElement>('.session-disclosure-button')!.click());
    expect(container.textContent).toContain('Delegation target is not a member of this session');
    expect(container.textContent).toContain('call TOOL-Z');
  });

  it('cancels every scheduled frame on unmount', async () => {
    const { host, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }]);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    for (const root of mounted.splice(0)) await act(async () => root.unmount());
    expect(frames.size).toBe(0);
  });
});

/** The card-scoped title transcript sync stamped on every subagent sidecar of `card-1`. */
const GENERATED = 'Subagent transcript for card-1';
/** Task text real teammate sidecars share: every teammate prompt opens with the same header. */
const SHARED_TASK = '## Card Repository\n/home/node/.cards/car';
/** Native agent ids of the 22 subagent sections the main-728 lead session rendered identically. */
const TEAMMATES = [
  'agent-aconnection-fix-2-51fbfcd79224af0c',
  'agent-aconnection-fix-cb4e91e6a511f81e',
  'agent-aexperience-evaluator-6405ff07412837e4',
  'agent-aextension-fix-4-28c31dcaa73e857b',
  'agent-aextension-host-788bdc7e11790cf4',
  'agent-afailure-mode-5c8564b0e49fe37c',
  'agent-afinal-smoke-9a6cb0eea5798ea9',
  'agent-alabels-fix-4-3058680e66b44d5e',
  'agent-arenderer-4b61184b7c832f61',
  'agent-asdk-fix-4-99cc2492e25e3542',
  'agent-asdk-log-fix-b4ffbc9b059c5ae8',
  'agent-asdk-resync-fix-7f1514a0de5d3bdb',
  'agent-asdk-store-3886e8df97f131d4',
  'agent-aserver-events-528e7f29db06f9b4',
  'agent-aserver-live-fix-3-29b5a64f68059444',
  'agent-aserver-watch-fix-2-b53d1b123e383c7d',
  'agent-aserver-watch-fix-89dcad8abd5502d2',
  'agent-aweb-host-55d10eb83eb600b4',
  'agent-a37e08eab6309e87f',
  'agent-a801df048e8e72024',
  'agent-abd8c3b90eb3d0468',
  'agent-ad1eeabfd152ea2a3'
];

/**
 * Accessible names of the session-member disclosures, in document order.
 * @param container - Rendered root.
 * @returns Button names (the chevron is aria-hidden and textless).
 */
function memberLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>(`${PLACEMENT} > .session-disclosure-button`)].map(
    (button) => button.textContent ?? ''
  );
}

describe('Subagent section identity', () => {
  it('labels 22 teammates that share the generated title and boilerplate task text by agent id alone', async () => {
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      ...TEAMMATES.map((agentId) => ({
        relPath: `SESSION/subagents/${agentId}.jsonl`,
        role: 'subagent' as const,
        agentId,
        title: GENERATED,
        taskContent: SHARED_TASK
      }))
    ];
    const { host, container, settle } = await mount(claude, members);
    await act(async () => host.snapshot(MAIN, lines([prompt('Coordinate the team', 'p1')]), { isActive: false }));
    for (const agentId of TEAMMATES)
      await act(async () =>
        host.snapshot(`SESSION/subagents/${agentId}.jsonl`, lines([sidechain(agentId, 'Working', `${agentId}-1`)]), {
          isActive: false
        })
      );
    await settle();
    const labels = memberLabels(container);
    expect(labels).toEqual(
      TEAMMATES.map((agentId) => `Subagent: ${agentId} · ended · session member, no witnessed delegation`)
    );
    expect(new Set(labels).size).toBe(TEAMMATES.length);
    expect(container.textContent).not.toContain(GENERATED);
  });

  it('keeps differing task text on witnessed Agent-tool delegations at their delegation rows', async () => {
    const tasks: Record<string, string> = {
      A1: 'Installed-extension smoke for card main-',
      A2: 'You are running the installed-extension '
    };
    const agents = Object.keys(tasks);
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      ...agents.map((agentId) => ({
        relPath: `SESSION/subagents/agent-${agentId}.jsonl`,
        role: 'subagent' as const,
        agentId,
        title: GENERATED,
        taskContent: tasks[agentId]
      }))
    ];
    const { host, container, settle } = await mount(claude, members);
    await act(async () =>
      host.snapshot(
        MAIN,
        lines([
          delegate('TOOL-1', 'call-1'),
          delegated('TOOL-1', 'A1', 'result-1'),
          delegate('TOOL-2', 'call-2'),
          delegated('TOOL-2', 'A2', 'result-2')
        ])
      )
    );
    for (const agentId of agents)
      await act(async () =>
        host.snapshot(
          `SESSION/subagents/agent-${agentId}.jsonl`,
          lines([sidechain(agentId, 'Working', `${agentId}-1`)])
        )
      );
    await settle();
    // Witnessed placements carry no placement suffix; the activity suffix is unchanged.
    expect(memberLabels(container)).toEqual([
      'Subagent: A1 — Installed-extension smoke for card main- · running',
      'Subagent: A2 — You are running the installed-extension · running'
    ]);
  });

  it('drops only the task text siblings share, keeping it where it still distinguishes', async () => {
    const tasks: Record<string, string> = {
      'agent-D1': 'In /var/lib/coaxial/cards-worktrees/work',
      'agent-D2': 'In /var/lib/coaxial/cards-worktrees/work',
      'agent-D3': 'Final installed-extension smoke for card'
    };
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      ...Object.entries(tasks).map(([agentId, taskContent]) => ({
        relPath: `SESSION/subagents/${agentId}.jsonl`,
        role: 'subagent' as const,
        agentId,
        title: GENERATED,
        taskContent
      }))
    ];
    const { host, container, settle } = await mount(claude, members);
    await act(async () => host.snapshot(MAIN, lines([prompt('Start', 'p1')])));
    for (const agentId of Object.keys(tasks))
      await act(async () => host.snapshot(`SESSION/subagents/${agentId}.jsonl`, [], { isActive: true }));
    await settle();
    expect(memberLabels(container)).toEqual([
      'Subagent: agent-D1 · running · session member, no witnessed delegation',
      'Subagent: agent-D2 · running · session member, no witnessed delegation',
      'Subagent: agent-D3 — Final installed-extension smoke for card · running · session member, no witnessed delegation'
    ]);
  });

  it('falls back to the bare agent id when a subagent has no task text', async () => {
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      { relPath: 'SESSION/subagents/agent-B1.jsonl', role: 'subagent', agentId: 'agent-B1', title: GENERATED },
      { relPath: 'SESSION/subagents/agent-B2.jsonl', role: 'subagent', agentId: 'agent-B2', title: GENERATED }
    ];
    const { host, container, settle } = await mount(claude, members);
    await act(async () => host.snapshot(MAIN, lines([prompt('Start', 'p1')])));
    await act(async () => host.snapshot('SESSION/subagents/agent-B1.jsonl', [], { isActive: true }));
    await act(async () => host.snapshot('SESSION/subagents/agent-B2.jsonl', [], { isActive: true }));
    await settle();
    expect(memberLabels(container)).toEqual([
      'Subagent: agent-B1 · running · session member, no witnessed delegation',
      'Subagent: agent-B2 · running · session member, no witnessed delegation'
    ]);
  });

  it('keeps a genuinely custom title and disambiguates custom titles two subagents share', async () => {
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      { relPath: 'SESSION/subagents/agent-C1.jsonl', role: 'subagent', agentId: 'agent-C1', title: 'Fix the snapshot' },
      { relPath: 'SESSION/subagents/agent-C2.jsonl', role: 'subagent', agentId: 'agent-C2', title: 'Review' },
      { relPath: 'SESSION/subagents/agent-C3.jsonl', role: 'subagent', agentId: 'agent-C3', title: 'Review' }
    ];
    const { host, container, settle } = await mount(claude, members);
    await act(async () => host.snapshot(MAIN, lines([prompt('Start', 'p1')])));
    for (const id of ['C1', 'C2', 'C3'])
      await act(async () => host.snapshot(`SESSION/subagents/agent-${id}.jsonl`, [], { isActive: true }));
    await settle();
    expect(memberLabels(container)).toEqual([
      'Subagent: Fix the snapshot · running · session member, no witnessed delegation',
      'Subagent: Review (agent-C2) · running · session member, no witnessed delegation',
      'Subagent: Review (agent-C3) · running · session member, no witnessed delegation'
    ]);
  });

  it('keeps the task text of a lone subagent, flattened and bounded', async () => {
    const task = `Line one\n\tline two ${'x'.repeat(80)}`;
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      { relPath: CHILD, role: 'subagent', agentId: 'A', title: GENERATED, taskContent: task }
    ];
    const { host, container, settle } = await mount(claude, members);
    await act(async () => host.snapshot(MAIN, lines([prompt('Start', 'p1')])));
    await act(async () => host.snapshot(CHILD, [], { isActive: true }));
    await settle();
    const [label] = memberLabels(container);
    expect(label).toBe(
      `Subagent: A — Line one line two ${'x'.repeat(48 - 'Line one line two '.length)}… · running · session member, no witnessed delegation`
    );
  });

  it('labels Codex subagent sidecars with the generated title by their native identity', async () => {
    const members: HostMember[] = [
      { relPath: 'rollout.jsonl', role: 'main' },
      { relPath: 'rollout/subagents/thread-1.jsonl', role: 'subagent', agentId: 'thread-1', title: GENERATED },
      { relPath: 'rollout/subagents/thread-2.jsonl', role: 'subagent', agentId: 'thread-2', title: GENERATED }
    ];
    const { host, container, settle } = await mount(codexSessionAdapter as SessionProviderAdapter<object>, members, {
      streamType: 'codex-session',
      runtime: 'codex'
    });
    await act(async () => host.snapshot('rollout.jsonl', [], { isActive: true }));
    for (const relPath of ['rollout/subagents/thread-1.jsonl', 'rollout/subagents/thread-2.jsonl'])
      await act(async () => host.snapshot(relPath, [], { isActive: true }));
    await settle();
    expect(memberLabels(container)).toEqual([
      'Subagent: thread-1 · running · session member, no witnessed delegation',
      'Subagent: thread-2 · running · session member, no witnessed delegation'
    ]);
  });

  it('gives card-detail (compact) sections the same distinct labels', async () => {
    const members: HostMember[] = [
      { relPath: MAIN, role: 'main' },
      ...TEAMMATES.map((agentId) => ({
        relPath: `SESSION/subagents/${agentId}.jsonl`,
        role: 'subagent' as const,
        agentId,
        title: GENERATED,
        taskContent: SHARED_TASK
      }))
    ];
    const { host, container, settle } = await mount(claude, members, { mode: 'compact' });
    await act(async () => host.snapshot(MAIN, lines([prompt('Coordinate the team', 'p1')])));
    for (const agentId of TEAMMATES)
      await act(async () => host.snapshot(`SESSION/subagents/${agentId}.jsonl`, [], { isActive: true }));
    await settle();
    const labels = memberLabels(container);
    expect(labels).toHaveLength(TEAMMATES.length);
    expect(new Set(labels).size).toBe(TEAMMATES.length);
    for (const [index, agentId] of TEAMMATES.entries())
      expect(labels[index]).toBe(`Subagent: ${agentId} · running · session member, no witnessed delegation`);
    expect(container.textContent).not.toContain(GENERATED);
  });
});

describe('Paused sources — Retry', () => {
  it('offers Retry on a paused main that asks the host to resynchronize and re-requests it', async () => {
    const { host, container, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }]);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    expect(container.querySelector('.session-retry')).toBeNull();
    await act(async () => host.store.subscribeSource(host.ref(MAIN), 'full'));
    await act(async () => host.error(MAIN, 'resync-overflow'));
    await settle();
    expect(container.textContent).toContain('Live updates overflowed; resynchronization required.');
    // Content shown before the pause is retained.
    expect(container.textContent).toContain('All done here.');
    const retry = container.querySelector<HTMLButtonElement>('.session-retry');
    expect(retry?.tagName).toBe('BUTTON');
    expect(retry?.getAttribute('aria-label')).toMatch(/^Retry .+/);
    const requests = host.subscribes(MAIN).length;
    await act(async () => retry!.click());
    await settle();
    expect(host.sent.some((message) => message.type === 'session:resync')).toBe(true);
    expect(host.subscribes(MAIN)).toHaveLength(requests + 1);
    expect(container.querySelector('.session-retry')).toBeNull();
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    expect(container.textContent).not.toContain('Live updates overflowed');
  });

  it('offers Retry on a paused subagent, labelled with its source title', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    const button = container.querySelector<HTMLButtonElement>(`${PLACEMENT} > .session-disclosure-button`);
    await act(async () => button!.click());
    await settle();
    await act(async () => host.error(CHILD, 'load-error'));
    await settle();
    const child = container.querySelector('.session-child');
    expect(child?.textContent).toContain('Source failed to load.');
    const retry = child?.querySelector<HTMLButtonElement>('.session-retry');
    const label = retry?.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^Retry \S/);
    // The action names the same source title its disclosure announces.
    expect(button!.textContent).toContain(`Subagent: ${label.slice('Retry '.length)}`);
    await act(async () => retry!.click());
    await settle();
    expect(host.sent.at(-1)?.type).toBe('source:subscribe');
    expect(host.sent.some((message) => message.type === 'session:resync')).toBe(true);
  });

  it('shows no Retry for a source that is merely unavailable', async () => {
    const { host, container, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }]);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    expect(container.querySelector('.session-source-error')).toBeNull();
  });
});

describe('Stale content while the host resynchronizes', () => {
  it('dims retained main content in place and clears it on ready', async () => {
    const { host, container, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }]);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    const content = container.querySelector('.session-source-content');
    expect(content?.hasAttribute('data-stale')).toBe(false);
    await act(async () => host.status(MAIN, 'resynchronizing'));
    await settle();
    expect(container.querySelector('.session-source-content')).toBe(content);
    expect(content?.hasAttribute('data-stale')).toBe(true);
    expect(content?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('All done here.');
    expect(container.textContent).not.toContain('Loading transcript');
    await act(async () => host.status(MAIN, 'ready'));
    await settle();
    expect(content?.hasAttribute('data-stale')).toBe(false);
    expect(content?.hasAttribute('aria-busy')).toBe(false);
  });

  it('marks only the resynchronizing subagent stale', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await settle();
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`${PLACEMENT} > .session-disclosure-button`)!.click()
    );
    await settle();
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    await act(async () => host.status(CHILD, 'resynchronizing'));
    await settle();
    expect(container.querySelector('.session-child')?.hasAttribute('data-stale')).toBe(true);
    expect(container.querySelector('.session-child')?.textContent).toContain('Child A working');
    expect(container.querySelectorAll('[data-stale]')).toHaveLength(1);
  });
});

describe('View state across renderer rebuilds', () => {
  const childPlacement = JSON.stringify(['session-member', JSON.stringify(['card-1', 'claude-code-session', CHILD])]);
  const reported = (host: SessionHost): StreamViewState | undefined =>
    host.sent.filter((message): message is ViewStateMessage => message.type === 'view:state').at(-1)?.state;

  it('reports disclosure choices and full-history requests once they settle', async () => {
    const { host, container, settle } = await mount(claude, MEMBERS);
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')]), { first: 60 }));
    await settle();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`${PLACEMENT} > .session-disclosure-button`)!.click()
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const state = reported(host);
    expect(state?.open).toContainEqual([childPlacement, true]);
    expect(state?.ranges.map(([key]) => key)).toContain(
      JSON.stringify(['history', JSON.stringify(['card-1', 'claude-code-session', CHILD])])
    );
  });

  it('rehydrates an open member with full history and a paged card-detail window', async () => {
    const childKey = JSON.stringify(['card-1', 'claude-code-session', CHILD]);
    const mainKey = JSON.stringify(['card-1', 'claude-code-session', MAIN]);
    const { host, container, settle } = await mount(claude, MEMBERS, {
      mode: 'compact',
      viewState: {
        open: [[childPlacement, true]],
        ranges: [
          [JSON.stringify(['history', childKey]), { first: 1, count: 1 }],
          [JSON.stringify(['window', mainKey]), { first: 2, count: 100 }]
        ]
      }
    });
    expect(host.subscribes(CHILD).at(-1)?.history).toBe('full');
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    const placement = container.querySelector(`${PLACEMENT} > .session-disclosure-button`);
    expect(placement?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.session-window')?.textContent).not.toContain('Investigate the failure');
    expect(container.textContent).toContain('Child A working');
  });
  it('prunes restored ids once their source is fully loaded and keeps them while it is incomplete', async () => {
    const generation = JSON.stringify(['server-1', 'source-1']);
    const mainKey = JSON.stringify(['card-1', 'claude-code-session', MAIN]);
    const childKey = JSON.stringify(['card-1', 'claude-code-session', CHILD]);
    const goneKey = JSON.stringify(['card-1', 'claude-code-session', 'SESSION/subagents/agent-GONE.jsonl']);
    const deadMain = JSON.stringify([mainKey, generation, 'tool', 'VANISHED']);
    const pendingChild = JSON.stringify([childKey, generation, 'tool', 'EARLIER']);
    const deadPlacement = JSON.stringify(['session-member', goneKey]);
    const { host, container, settle } = await mount(claude, MEMBERS, {
      viewState: {
        open: [
          [deadMain, true],
          [pendingChild, true],
          [deadPlacement, true]
        ],
        ranges: [
          [JSON.stringify(['history', goneKey]), { first: 1, count: 1 }],
          [JSON.stringify(['window', goneKey]), { first: 5, count: 20 }]
        ]
      }
    });
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    const child = lines(
      Array.from({ length: 60 }, (_, index) => sidechain('A', `Child step ${index + 1}`, `a${index}`))
    );
    await act(async () => host.snapshot(CHILD, child.slice(59), { first: 60 }));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const partial = reported(host)!;
    // The complete main cannot produce its vanished id and the departed member cannot return;
    // the child's id may still be in its unloaded earlier history.
    expect(host.subscribes(CHILD).at(-1)?.history).toBe('tail');
    expect(partial.open.map(([id]) => id)).toEqual([pendingChild]);
    // Ranges for the departed member are never reported back.
    expect(partial.ranges).toEqual([]);

    // Opening the member loads its full history, which settles the child's pending id.
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`${PLACEMENT} > .session-disclosure-button`)!.click()
    );
    expect(host.subscribes(CHILD).at(-1)?.history).toBe('full');
    await act(async () => host.snapshot(CHILD, child));
    await settle();
    expect(host.store.getState().sources.get(childKey)?.earlierUnloaded).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(reported(host)!.open).toEqual([[childPlacement, true]]);
  });
});

describe('Session validity — rendered inspectably', () => {
  it('explains a missing main and lists every member', async () => {
    const { host, container, settle } = await mount(claude, [{ relPath: CHILD, role: 'subagent', agentId: 'A' }]);
    expect(host.subscribes(CHILD)).toHaveLength(1);
    await act(async () => host.snapshot(CHILD, lines([sidechain('A', 'Child A working', 'a1')])));
    await settle();
    expect(container.textContent).toContain('No main transcript is available');
    expect(container.querySelectorAll(PLACEMENT)).toHaveLength(1);
  });

  it('explains conflicting mains without choosing one', async () => {
    const { container } = await mount(claude, [
      { relPath: MAIN, role: 'main' },
      { relPath: 'OTHER.jsonl', role: 'main' }
    ]);
    expect(container.textContent).toContain('More than one source claims to be this session’s main transcript');
    expect(container.querySelectorAll(PLACEMENT)).toHaveLength(2);
  });
});

describe('Card detail (compact)', () => {
  it('keeps a live empty session open and closes a settled empty one', async () => {
    const live = await mount(claude, [{ relPath: MAIN, role: 'main' }], { mode: 'compact' });
    expect(live.host.subscribes(MAIN).at(-1)?.history).toBe('tail');
    await act(async () => live.host.snapshot(MAIN, [], { isActive: true }));
    await live.settle();
    expect(live.host.sent.some((message) => message.type === 'close')).toBe(false);
    expect(live.container.textContent).toContain('Running');

    const ended = await mount(claude, [{ relPath: MAIN, role: 'main' }], { mode: 'compact' });
    await act(async () => ended.host.snapshot(MAIN, [], { isActive: false }));
    await ended.settle();
    expect(ended.host.sent.filter((message) => message.type === 'close')).toHaveLength(1);
  });

  it('keeps a live empty Codex session open', async () => {
    const { host, settle } = await mount(
      codexSessionAdapter as SessionProviderAdapter<object>,
      [{ relPath: 'rollout.jsonl', role: 'main' }],
      {
        mode: 'compact',
        streamType: 'codex-session',
        runtime: 'codex'
      }
    );
    await act(async () => host.snapshot('rollout.jsonl', [], { isActive: true }));
    await settle();
    expect(host.sent.some((message) => message.type === 'close')).toBe(false);
  });

  it('previews the live end, labels the range and pages through Show conversation', async () => {
    const records = Array.from({ length: 12 }, (_, index) => [
      prompt(`Question ${index + 1}?`, `p${index}`),
      reply(`Reply number ${index + 1}.`, `r${index}`)
    ]).flat();
    const { host, container, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }], { mode: 'compact' });
    await act(async () => host.snapshot(MAIN, lines(records), { first: 40 }));
    await settle();
    const window = container.querySelector('.session-window')!;
    const text = window.textContent ?? '';
    expect(text).toContain('Reply number 12.');
    expect(text).not.toContain('Reply number 1.');
    expect(text).toMatch(/Showing entries \d+–(\d+) of \1 loaded; earlier content not loaded/);
    expect(container.textContent).toContain('Summary of lines 40–63 of 63; earlier content not loaded.');
    const show = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Show conversation');
    await act(async () => show!.click());
    expect(window.textContent).toContain('Showing entries 5–24 of 24 loaded');
    expect(window.textContent).not.toContain('Reply number 1.');
    const earlier = () =>
      [...window.querySelectorAll('button')].find((button) => button.textContent === 'Show earlier')!;
    await act(async () => earlier().click());
    expect(window.textContent).toContain('Showing entries 1–24 of 24 loaded');
    expect(window.textContent).toContain('Reply number 1.');
    expect(host.subscribes(MAIN).at(-1)?.history).toBe('tail');
    await act(async () => earlier().click());
    expect(host.subscribes(MAIN).at(-1)?.history).toBe('full');
  });

  it('answers a layout handshake with ready and a size report', async () => {
    const { host, settle } = await mount(claude, [{ relPath: MAIN, role: 'main' }], { mode: 'compact' });
    await act(async () => host.snapshot(MAIN, MAIN_LINES));
    await act(async () => host.deliver({ type: 'layout:handshake', generation: 'gen-1', token: 'tok-1' }));
    await settle();
    const layout = host.sent.filter((message) => message.type.startsWith('layout:')).map((message) => message.type);
    expect(layout[0]).toBe('layout:ready');
    expect(layout).toContain('layout:size');
  });
});

describe('Antigravity — main-only', () => {
  it('renders the captured trajectory alone without relationship sections', async () => {
    const native = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures/antigravity/captured-stream-json-success.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter(Boolean);
    const { host, container, settle } = await mount(
      antigravitySessionAdapter as SessionProviderAdapter<object>,
      [{ relPath: 'trajectory.jsonl', role: 'main' }],
      { streamType: 'antigravity-session', runtime: 'antigravity' }
    );
    await act(async () => host.snapshot('trajectory.jsonl', native, { isActive: false }));
    await settle();
    expect(container.querySelector('.session-relationships')).toBeNull();
    expect(container.querySelector('[data-session-child]')).toBeNull();
    expect(container.textContent).not.toContain('No Antigravity session activity yet.');
  });
});

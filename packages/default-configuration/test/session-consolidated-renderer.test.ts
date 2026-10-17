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

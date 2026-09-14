/**
 * Tests for the OpenCode runtime session-start plugin: root-session
 * registration, transcript materialization (CONTRACT-C), manifest + watcher
 * wiring, identity injection via the stateless `shell.env`, and every-turn
 * card context through the system transform.
 *
 * @summary Tests for the OpenCode runtime session-start handler
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionInput } from '@cards.management/sdk/config';
import { addActiveSubagent } from '@cards.management/sessions/card-repo';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpencodeSessionHistoryEntry } from '../../../src/opencode/internal/deps.js';
import { createSessionStartPlugin } from '../../../src/opencode/internal/runtime-handlers.js';
import {
  type LogEntry,
  makeCardRepo,
  makeClient,
  makeDeps,
  makePluginInput,
  makeTempDir,
  messageUpdatedEvent,
  partUpdatedEvent,
  removeTempDir,
  sessionCreatedEvent,
  sessionDeletedEvent,
  sessionIdleEvent
} from '../helpers.js';

let tempDir: string;
let logEntries: LogEntry[];
const stderrWrites: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = makeTempDir('session-start');
  makeCardRepo(tempDir);
  logEntries = [];
  stderrWrites.length = 0;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  stderrSpy.mockRestore();
  removeTempDir(tempDir);
});

/**
 * Builds a Cards action input pointing at a readable card repo in `tempDir`.
 *
 * @param overrides - Field overrides merged last.
 * @returns The action input returned by injected `loadActionInput`.
 */
function actionInput(overrides: Partial<ActionInput> = {}): ActionInput {
  return {
    cardId: 'main-453',
    actionName: 'Launch Cards',
    executionId: 'execution-453',
    worktreeDirective: { kind: 'reuse' },
    environment: 'default',
    executionMode: 'interactive',
    exitWhenDone: false,
    codingAgent: 'opencode-cli',
    switchToInteractiveData: undefined,
    repoRoot: join(tempDir, 'repo-root'),
    cardRepoPath: join(tempDir, 'main-453'),
    configPath: '/tmp/config',
    extensionPath: '/tmp/extension',
    marketplacePath: '/tmp/extension/dist/marketplace',
    ...overrides
  };
}

/**
 * Reads the materialized transcript lines for a session.
 *
 * @param sessionId - Session whose transcript file is parsed.
 * @returns Parsed JSON objects, one per NDJSON line.
 */
function readLines(sessionId: string): Array<Record<string, unknown>> {
  const path = join(tempDir, 'transcripts', `${sessionId}.jsonl`);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Reads a child session's materialized transcript under its root's
 * subagents directory.
 *
 * @param rootId - Top-level root session id owning the directory.
 * @param childId - Child (or grandchild) session whose file is parsed.
 * @returns Parsed JSON objects, one per NDJSON line; empty when absent.
 */
function readChildLines(rootId: string, childId: string): Array<Record<string, unknown>> {
  const path = join(tempDir, 'transcripts', rootId, 'subagents', `${childId}.jsonl`);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Builds one history entry shaped like the session messages API payload.
 *
 * @param id - Message identifier (`data.id` of the exported message line).
 * @param created - `info.time.created` epoch-ms.
 * @param text - Text carried by the entry's single synthetic part.
 * @returns One `{info, parts}` payload as the backfill loader would return it.
 */
function historyEntry(id: string, created: number, text: string): OpencodeSessionHistoryEntry {
  return {
    info: { id, sessionID: 'ses-resumed', role: 'user', time: { created } },
    parts: [{ id: `prt-${id}`, sessionID: 'ses-resumed', messageID: id, type: 'text', text }]
  };
}

/**
 * Seeds the resumed session's transcript file with prior-run envelope lines.
 *
 * @param lines - Envelope objects written one per NDJSON line.
 */
function seedTranscript(lines: Array<Record<string, unknown>>): void {
  mkdirSync(join(tempDir, 'transcripts'), { recursive: true });
  writeFileSync(
    join(tempDir, 'transcripts', 'ses-resumed.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
}

function metaSeed(): Record<string, unknown> {
  return { v: 1, ts: 'seeded', seq: 0, sessionId: 'ses-resumed', type: 'meta', data: {} };
}

function messageSeed(id: string): Record<string, unknown> {
  return { v: 1, ts: 'seeded', seq: 0, sessionId: 'ses-resumed', type: 'message', data: { id } };
}

function partSeed(id: string): Record<string, unknown> {
  return { v: 1, ts: 'seeded', seq: 0, sessionId: 'ses-resumed', type: 'part', data: { id, messageID: id } };
}

describe('runtime session-start plugin', () => {
  it('registers event, shell.env, and system.transform hooks', async () => {
    const plugin = createSessionStartPlugin(makeDeps(tempDir).deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    expect(typeof hooks.event).toBe('function');
    expect(typeof (hooks as Record<string, unknown>)['shell.env']).toBe('function');
    expect(typeof (hooks as Record<string, unknown>)['experimental.chat.system.transform']).toBe('function');
  });

  it('keeps user sessions inert when no Cards action env is present', async () => {
    const { deps, recorders } = makeDeps(tempDir);
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

    await hooks.event?.(sessionCreatedEvent('ses-user'));

    expect(existsSync(join(tempDir, 'transcripts'))).toBe(false);
    expect(recorders.manifests).toHaveLength(0);
    expect(recorders.watcherSpawns).toHaveLength(0);
    expect(logEntries.some((e) => e.message.includes('not a Cards action'))).toBe(true);
  });

  it('entry exports an inert plugin (no hooks at all) outside Cards-action sessions', async () => {
    const previous = process.env['CARD_ID'];
    delete process.env['CARD_ID'];
    try {
      vi.resetModules();
      const entry = await import('../../../src/opencode/runtime/session-start.js');
      const plugin = entry.CardsRuntimeSessionStart;
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      // No hook surface whatsoever: accidental global registration is silent.
      expect(hooks).toEqual({});
      expect(hooks.event).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['CARD_ID'];
      else process.env['CARD_ID'] = previous;
      vi.resetModules();
    }
  });

  it('entry exports the live factory when spawned by a Cards action', async () => {
    const previous = process.env['CARD_ID'];
    const previousExecutionId = process.env['CARDS_EXECUTION_ID'];
    const previousDirective = process.env['CARDS_WORKTREE_DIRECTIVE'];
    process.env['CARD_ID'] = 'ope-age-sup-1';
    process.env['CARDS_EXECUTION_ID'] = 'execution-453';
    process.env['CARDS_WORKTREE_DIRECTIVE'] = '{"kind":"reuse"}';
    try {
      vi.resetModules();
      const entry = await import('../../../src/opencode/runtime/session-start.js');
      const hooks = await entry.CardsRuntimeSessionStart(makePluginInput(tempDir, makeClient(logEntries)));
      expect(typeof hooks.event).toBe('function');
    } finally {
      if (previous === undefined) delete process.env['CARD_ID'];
      else process.env['CARD_ID'] = previous;
      if (previousExecutionId === undefined) delete process.env['CARDS_EXECUTION_ID'];
      else process.env['CARDS_EXECUTION_ID'] = previousExecutionId;
      if (previousDirective === undefined) delete process.env['CARDS_WORKTREE_DIRECTIVE'];
      else process.env['CARDS_WORKTREE_DIRECTIVE'] = previousDirective;
      vi.resetModules();
    }
  });

  it('materializes the transcript with a meta line and spawns the watcher for an action session', async () => {
    const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

    await hooks.event?.(sessionCreatedEvent('ses-card', { version: '1.18.21' }));

    const lines = readLines('ses-card');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      v: 1,
      seq: 1,
      sessionId: 'ses-card',
      type: 'meta',
      data: { runtime: 'opencode', opencodeVersion: '1.18.21' }
    });

    expect(recorders.manifests).toHaveLength(1);
    expect(recorders.manifests[0]).toMatchObject({
      version: 1,
      sessionId: 'ses-card',
      cardId: 'main-453',
      runtime: 'opencode',
      streamType: 'opencode-session',
      monitorPid: 4242,
      cardRepoPath: join(tempDir, 'main-453')
    });
    expect(recorders.manifests[0]?.sources).toEqual([{ pattern: 'ses-card.jsonl', role: 'main', mode: 'jsonl-tail' }]);
    expect(recorders.watcherSpawns[0]?.extensionPath).toBe('/tmp/extension');

    // The manifest contract requires filename↔sessionId agreement; assert the
    // transcript path handed to the adapter satisfies it.
    const transcriptPath = recorders.manifests[0]?.sources?.[0]?.pattern;
    expect(transcriptPath).toBe('ses-card.jsonl');
  });

  it('keeps skipping children whose parent never classifies in this bundle (retained pin)', async () => {
    const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

    // Parent is never classified in this bundle: the child stays unexported
    // (fail-closed until a known root resolves above it).
    await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-never-seen' }));
    await hooks.event?.(partUpdatedEvent('ses-child', 'subagent work'));

    expect(readChildLines('ses-never-seen', 'ses-child')).toHaveLength(0);
    expect(existsSync(join(tempDir, 'transcripts', 'ses-never-seen'))).toBe(false);
    expect(recorders.watcherSpawns).toHaveLength(0);
  });

  describe('child session transcript export', () => {
    it('streams child activity under <rootId>/subagents/ once the root is classified', async () => {
      const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-card'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-card', version: '1.18.22' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'subagent work'));

      const childPath = join(tempDir, 'transcripts', 'ses-card', 'subagents', 'ses-child.jsonl');
      expect(existsSync(childPath)).toBe(true);
      const lines = readChildLines('ses-card', 'ses-child');
      expect(lines.map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(lines[0]).toMatchObject({
        v: 1,
        seq: 1,
        sessionId: 'ses-child',
        type: 'meta',
        data: { runtime: 'opencode', opencodeVersion: '1.18.22', parentSessionId: 'ses-card' }
      });
      expect((lines[1]?.['data'] as Record<string, unknown>)['text']).toBe('subagent work');

      // Child transcripts ride the SAME manifest/watcher as their root —
      // the adapter's subagents glob picks the files up; nothing re-spawns.
      expect(recorders.manifests).toHaveLength(1);
      expect(recorders.manifests[0]?.sessionId).toBe('ses-card');
      expect(recorders.watcherSpawns).toHaveLength(1);
    });

    it('writes exactly one child meta line and logs the start once despite repeated activity', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-card'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-card' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'one'));
      await hooks.event?.(messageUpdatedEvent('ses-child'));
      await hooks.event?.(partUpdatedEvent('ses-child', 'two'));

      const types = readChildLines('ses-card', 'ses-child').map((line) => line['type']);
      expect(types).toEqual(['meta', 'part', 'message', 'part']);
      expect(logEntries.filter((e) => e.message.includes('Streaming child session'))).toHaveLength(1);
    });

    it('heals a child announced before its parent classified: next activity exports', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      // Child announces created while ses-root is unclassified: dropped.
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'early subagent work'));
      expect(readChildLines('ses-root', 'ses-child')).toHaveLength(0);

      // Parent's first activity classifies it (rule b) and starts startup…
      await hooks.event?.(partUpdatedEvent('ses-root', 'parent begins'));

      // …and the child's NEXT activity flows into the child exporter.
      await hooks.event?.(partUpdatedEvent('ses-child', 'late subagent work'));
      const lines = readChildLines('ses-root', 'ses-child');
      expect(lines.map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(lines[0]).toMatchObject({ data: { parentSessionId: 'ses-root' } });
    });

    it('exports grandchildren into the top-level root directory', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
      await hooks.event?.(sessionCreatedEvent('ses-grandchild', { parentID: 'ses-child' }));
      await hooks.event?.(partUpdatedEvent('ses-grandchild', 'nested agent work'));

      const lines = readChildLines('ses-root', 'ses-grandchild');
      expect(lines.map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(lines[0]).toMatchObject({ data: { parentSessionId: 'ses-root' } });
      // The middle session opened an exporter at its created but streamed no
      // content of its own.
      expect(readChildLines('ses-root', 'ses-child').map((line) => line['type'])).toEqual(['meta']);
    });

    it('closes a deleted child exporter and drops subsequent child writes', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'before delete'));
      await hooks.event?.(sessionDeletedEvent('ses-child'));
      await hooks.event?.(partUpdatedEvent('ses-child', 'after delete'));

      expect(readChildLines('ses-root', 'ses-child').map((line) => line['type'])).toEqual(['meta', 'part']);
    });

    it('closes all child exporters when their root is deleted', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionCreatedEvent('ses-child-a', { parentID: 'ses-root' }));
      await hooks.event?.(sessionCreatedEvent('ses-grandchild', { parentID: 'ses-child-a' }));
      await hooks.event?.(partUpdatedEvent('ses-child-a', 'work'));
      await hooks.event?.(partUpdatedEvent('ses-grandchild', 'nested work'));
      await hooks.event?.(sessionDeletedEvent('ses-root'));
      await hooks.event?.(partUpdatedEvent('ses-child-a', 'after root delete'));
      await hooks.event?.(partUpdatedEvent('ses-grandchild', 'after root delete'));

      expect(readChildLines('ses-root', 'ses-child-a').map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(readChildLines('ses-root', 'ses-grandchild').map((line) => line['type'])).toEqual(['meta', 'part']);
    });

    it('stays fully inert outside Cards actions, including children of classified roots', async () => {
      const { deps } = makeDeps(tempDir);
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-user'));
      await hooks.event?.(sessionCreatedEvent('ses-user-child', { parentID: 'ses-user' }));
      await hooks.event?.(partUpdatedEvent('ses-user-child', 'user subagent work'));

      expect(existsSync(join(tempDir, 'transcripts'))).toBe(false);
      expect(logEntries.some((e) => e.message.includes('streaming child session'))).toBe(false);
    });
  });

  describe('resume replay (backfill reconciliation)', () => {
    const twoMessageHistory = (): Array<OpencodeSessionHistoryEntry> => [
      historyEntry('msg-h1', 100, 'old question'),
      historyEntry('msg-h2', 200, 'old answer')
    ];

    function lineTypes(): Array<string> {
      return readLines('ses-resumed').map((line) => line['type'] as string);
    }

    it('replays [meta][history][live] into a fresh file in exactly that order', async () => {
      let loaderCalls = 0;
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async (sessionId) => {
          expect(sessionId).toBe('ses-resumed');
          loaderCalls += 1;
          return twoMessageHistory();
        }
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      // The triggering event itself is a live write: it must land after history.
      await hooks.event?.(partUpdatedEvent('ses-resumed', 'live now'));

      await vi.waitFor(() => expect(readLines('ses-resumed')).toHaveLength(6));

      expect(loaderCalls).toBe(1);
      const lines = readLines('ses-resumed');
      expect(lineTypes()).toEqual(['meta', 'message', 'part', 'message', 'part', 'part']);
      expect((lines[1]?.['data'] as Record<string, unknown>)['id']).toBe('msg-h1');
      expect((lines[3]?.['data'] as Record<string, unknown>)['id']).toBe('msg-h2');
      expect((lines[5]?.['data'] as Record<string, unknown>)['text']).toBe('live now');
      expect(logEntries.some((e) => e.message.includes('reconciled 2 historical messages (2 parts)'))).toBe(true);
    });

    it('writes zero new lines when the file already holds the full history', async () => {
      seedTranscript([
        metaSeed(),
        messageSeed('msg-h1'),
        partSeed('prt-msg-h1'),
        messageSeed('msg-h2'),
        partSeed('prt-msg-h2')
      ]);
      let loaderCalls = 0;
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async () => {
          loaderCalls += 1;
          return twoMessageHistory();
        }
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'fresh turn'));

      // Suppression covers history only — this run still appends its own
      // meta header first, then the live tail. Seeded history stays intact.
      await vi.waitFor(() => expect(readLines('ses-resumed')).toHaveLength(7));

      expect(loaderCalls).toBe(1);
      const lines = readLines('ses-resumed');
      expect(lineTypes()).toEqual(['meta', 'message', 'part', 'message', 'part', 'meta', 'part']);
      // Seeded history intact and untouched; only this run's header + live tail appended.
      expect((lines[1]?.['data'] as Record<string, unknown>)['id']).toBe('msg-h1');
      expect(lines[5]?.['type']).toBe('meta');
      expect((lines[6]?.['data'] as Record<string, unknown>)['text']).toBe('fresh turn');
      expect(logEntries.some((e) => e.message.includes('reconciled'))).toBe(false);
    });

    it('heals only the missing tail of a partially-populated file', async () => {
      seedTranscript([metaSeed(), messageSeed('msg-h1'), partSeed('prt-msg-h1')]);
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async () => twoMessageHistory()
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'live tail'));

      await vi.waitFor(() => expect(readLines('ses-resumed')).toHaveLength(7));

      const lines = readLines('ses-resumed');
      // [seeded meta+history][this run's meta][missing history tail][live]
      expect(lineTypes()).toEqual(['meta', 'message', 'part', 'meta', 'message', 'part', 'part']);
      expect((lines[4]?.['data'] as Record<string, unknown>)['id']).toBe('msg-h2');
      expect((lines[6]?.['data'] as Record<string, unknown>)['text']).toBe('live tail');
      expect(logEntries.some((e) => e.message.includes('reconciled 1 historical messages (1 parts)'))).toBe(true);
    });

    it('keeps every live line strictly after all reconciled lines when the loader is deferred', async () => {
      let resolveHistory!: (value: Array<OpencodeSessionHistoryEntry>) => void;
      const gated = new Promise<Array<OpencodeSessionHistoryEntry>>((resolve) => {
        resolveHistory = resolve;
      });
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: () => gated
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'early live'));
      await hooks.event?.(messageUpdatedEvent('ses-resumed'));
      // Fetch still in flight: nothing but the header exists yet.
      expect(lineTypes()).toEqual(['meta']);

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'late live'));
      expect(lineTypes()).toEqual(['meta']);

      resolveHistory([historyEntry('msg-h9', 5, 'backfilled turn')]);
      await vi.waitFor(() => expect(readLines('ses-resumed')).toHaveLength(6));

      const lines = readLines('ses-resumed');
      expect(lineTypes()).toEqual(['meta', 'message', 'part', 'part', 'message', 'part']);
      expect((lines[2]?.['data'] as Record<string, unknown>)['text']).toBe('backfilled turn');
      expect((lines[3]?.['data'] as Record<string, unknown>)['text']).toBe('early live');
      // The buffered message line keeps its arrival slot between the two parts.
      expect(lines[4]?.['type']).toBe('message');
      expect((lines[5]?.['data'] as Record<string, unknown>)['text']).toBe('late live');
    });

    it('warns and keeps streaming when the loader throws', async () => {
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: () => Promise.reject(new Error('db locked'))
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'during failure'));

      await vi.waitFor(() => {
        expect(lineTypes()).toEqual(['meta', 'part']);
        expect(
          logEntries.some((e) => e.level === 'warn' && e.message.includes('Failed to reconcile historical messages'))
        ).toBe(true);
      });
      expect(stderrWrites.join('')).not.toContain('failed (fail-open)');
      // The loader's error detail rides the warn entry's structured extra.
      expect(logEntries.some((e) => e.level === 'warn' && JSON.stringify(e.extra ?? {}).includes('db locked'))).toBe(
        true
      );

      // Live streaming continues unaffected.
      await hooks.event?.(partUpdatedEvent('ses-resumed', 'still streaming'));
      expect(lineTypes()).toEqual(['meta', 'part', 'part']);
      expect(logEntries.some((e) => e.message.includes('reconciled'))).toBe(false);
    });

    it('buffers an idle arriving during the fetch behind replayed history', async () => {
      let resolveHistory!: (value: Array<OpencodeSessionHistoryEntry>) => void;
      const gated = new Promise<Array<OpencodeSessionHistoryEntry>>((resolve) => {
        resolveHistory = resolve;
      });
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: () => gated
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'live during fetch'));
      await hooks.event?.(sessionIdleEvent('ses-resumed'));
      // Both live lines are held while the fetch is in flight.
      expect(lineTypes()).toEqual(['meta']);

      resolveHistory([historyEntry('msg-h1', 100, 'replayed turn')]);
      await vi.waitFor(() => expect(readLines('ses-resumed')).toHaveLength(5));

      expect(lineTypes()).toEqual(['meta', 'message', 'part', 'part', 'idle']);
      const lines = readLines('ses-resumed');
      expect((lines[2]?.['data'] as Record<string, unknown>)['text']).toBe('replayed turn');
      expect((lines[3]?.['data'] as Record<string, unknown>)['text']).toBe('live during fetch');
    });

    it('still flushes the buffered idle when the loader throws', async () => {
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: () => Promise.reject(new Error('db locked again'))
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'during failure'));
      await hooks.event?.(sessionIdleEvent('ses-resumed'));

      await vi.waitFor(() => {
        expect(lineTypes()).toEqual(['meta', 'part', 'idle']);
        expect(
          logEntries.some((e) => e.level === 'warn' && e.message.includes('Failed to reconcile historical messages'))
        ).toBe(true);
      });

      // Live streaming continues after the degraded settle.
      await hooks.event?.(partUpdatedEvent('ses-resumed', 'still streaming'));
      expect(lineTypes()).toEqual(['meta', 'part', 'idle', 'part']);
    });

    it('writes meta only for an empty history result', async () => {
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async () => []
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'first live'));

      await vi.waitFor(() => expect(readLines('ses-resumed')).toHaveLength(2));
      expect(lineTypes()).toEqual(['meta', 'part']);
      expect(logEntries.some((e) => e.message.includes('reconciled'))).toBe(false);
    });

    it('never reconciles child sessions', async () => {
      const requested: string[] = [];
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async (sessionId) => {
          requested.push(sessionId);
          return [];
        }
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-card'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-card' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'child work'));
      await hooks.event?.(partUpdatedEvent('ses-child', 'more child work'));

      await vi.waitFor(() => expect(readChildLines('ses-card', 'ses-child').length).toBeGreaterThanOrEqual(2));

      expect(requested).toEqual(['ses-card']);
    });
  });

  describe('deleted-session tombstones', () => {
    it('never resurrects a deleted child: no ghost transcript, no second watcher', async () => {
      let loaderCalls = 0;
      const { deps, recorders } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async () => {
          loaderCalls += 1;
          return [];
        }
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'before delete'));
      await hooks.event?.(sessionDeletedEvent('ses-child'));
      await hooks.event?.(partUpdatedEvent('ses-child', 'trailing activity'));

      // No phantom top-level transcript for the dead id…
      expect(existsSync(join(tempDir, 'transcripts', 'ses-child.jsonl'))).toBe(false);
      // …its nested file stays frozen at the pre-delete content,
      expect(readChildLines('ses-root', 'ses-child').map((line) => line['type'])).toEqual(['meta', 'part']);
      // …no reconciliation refetch fired, and watcher/manifest state stays the root's.
      expect(loaderCalls).toBe(1);
      expect(recorders.watcherSpawns).toHaveLength(1);
      expect(recorders.manifests.map((manifest) => manifest.sessionId)).toEqual(['ses-root']);

      // Identity injection stays closed for the dead id too.
      const output = { env: {} as Record<string, string> };
      await (hooks as { 'shell.env'?: (i: unknown, o: unknown) => Promise<void> })['shell.env']?.(
        { cwd: tempDir, sessionID: 'ses-child' },
        output
      );
      expect(Object.keys(output.env)).toHaveLength(0);
    });

    it('never resurrects a deleted root on trailing activity', async () => {
      let loaderCalls = 0;
      const { deps, recorders } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(),
        loadSessionHistory: async () => {
          loaderCalls += 1;
          return [];
        }
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(partUpdatedEvent('ses-root', 'before delete'));
      await hooks.event?.(sessionDeletedEvent('ses-root'));
      await hooks.event?.(partUpdatedEvent('ses-root', 'trailing activity'));

      expect(readLines('ses-root').map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(loaderCalls).toBe(1);
      expect(recorders.watcherSpawns).toHaveLength(1);
      expect(recorders.manifests.map((manifest) => manifest.sessionId)).toEqual(['ses-root']);
    });

    it('does not leak tombstones across unrelated sessions', async () => {
      const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-gone'));
      await hooks.event?.(sessionDeletedEvent('ses-gone'));

      // A different session classifies and exports completely normally.
      await hooks.event?.(partUpdatedEvent('ses-other', 'fresh work'));

      // ses-gone keeps exactly what it exported before deletion (append-only
      // history) and gains nothing; the unrelated session is unaffected.
      expect(readLines('ses-gone').map((line) => line['type'])).toEqual(['meta']);
      expect(readLines('ses-other').map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(recorders.manifests.map((manifest) => manifest.sessionId)).toEqual(['ses-gone', 'ses-other']);
    });
  });

  describe('resumed sessions (I5 correction): never re-emit session.created', () => {
    it('starts the Cards integration from the first message.part.updated event', async () => {
      const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      // No session.created ever arrives for a resumed session.
      await hooks.event?.(partUpdatedEvent('ses-resumed', 'continuing work'));

      // Startup ran once: meta line first, then the triggering part.
      const lines = readLines('ses-resumed');
      expect(lines.map((line) => line['type'])).toEqual(['meta', 'part']);
      expect(lines[0]).toMatchObject({ data: { runtime: 'opencode', opencodeVersion: 'unknown' } });

      expect(recorders.manifests).toHaveLength(1);
      expect(recorders.manifests[0]).toMatchObject({
        sessionId: 'ses-resumed',
        cardId: 'main-453',
        monitorPid: 4242
      });
      expect(recorders.watcherSpawns).toHaveLength(1);
    });

    it('starts at most once despite repeated activity events', async () => {
      const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-resumed', 'first'));
      await hooks.event?.(messageUpdatedEvent('ses-resumed'));
      await hooks.event?.(partUpdatedEvent('ses-resumed', 'third'));

      const types = readLines('ses-resumed').map((line) => line['type']);
      expect(types).toEqual(['meta', 'part', 'message', 'part']);
      expect(recorders.manifests).toHaveLength(1);
      expect(recorders.watcherSpawns).toHaveLength(1);
    });

    it('injects identity when shell.env is the first observation of a resumed session', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      const output = { env: {} as Record<string, string> };
      await (hooks as { 'shell.env'?: (i: unknown, o: unknown) => Promise<void> })['shell.env']?.(
        { cwd: tempDir, sessionID: 'ses-resumed' },
        output
      );

      expect(output.env['CARDS_SESSION_ID']).toBe('ses-resumed');
      expect(output.env['CARDS_TRANSCRIPT_PATH']).toBe(join(tempDir, 'transcripts', 'ses-resumed.jsonl'));
      // The startup sequence ran, so the injected transcript file exists.
      expect(readLines('ses-resumed')).toHaveLength(1);
    });

    it('injects context when system.transform is the first observation', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      const output = { system: [] as string[] };
      await (hooks as { 'experimental.chat.system.transform'?: (i: unknown, o: unknown) => Promise<void> })[
        'experimental.chat.system.transform'
      ]?.({ sessionID: 'ses-resumed' }, output);

      expect(output.system).toHaveLength(1);
      expect(output.system[0]).toContain('CARD_ID=main-453');
    });

    it('exports a child whose resumed parent classifies first; shell.env stays root-only', async () => {
      // Converted child-skip pin: the resumed parent heals via rule (b) from
      // its own activity, after which the child exports under its directory.
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-root', 'resumed parent begins'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
      await hooks.event?.(partUpdatedEvent('ses-child', 'subagent work'));

      const lines = readChildLines('ses-root', 'ses-child');
      expect(lines.map((line) => line['type'])).toEqual(['meta', 'part']);

      // Identity injection remains strictly root-gated.
      const output = { env: {} as Record<string, string> };
      await (hooks as { 'shell.env'?: (i: unknown, o: unknown) => Promise<void> })['shell.env']?.(
        { cwd: tempDir, sessionID: 'ses-child' },
        output
      );
      expect(Object.keys(output.env)).toHaveLength(0);
    });

    it('stays inert for a non-action session first observed via activity', async () => {
      const { deps, recorders } = makeDeps(tempDir);
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(partUpdatedEvent('ses-user-resumed', 'hello'));
      await hooks.event?.(partUpdatedEvent('ses-user-resumed', 'again'));

      expect(readLines('ses-user-resumed')).toHaveLength(0);
      expect(recorders.manifests).toHaveLength(0);
      // The decline is logged once, not per event.
      const declines = logEntries.filter((e) => e.message.includes('not a Cards action'));
      expect(declines).toHaveLength(1);
    });
  });

  it('appends part and message lines only for tracked sessions', async () => {
    const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionCreatedEvent('ses-card'));
    await hooks.event?.(partUpdatedEvent('ses-card', 'hello'));
    await hooks.event?.(messageUpdatedEvent('ses-card'));
    await hooks.event?.(partUpdatedEvent('ses-unknown', 'ignored'));

    const lines = readLines('ses-card');
    expect(lines.map((line) => line['type'])).toEqual(['meta', 'part', 'message']);
    expect((lines[1]?.['data'] as Record<string, unknown>)['text']).toBe('hello');
  });

  it('closes the exporter on session.deleted and stops appending', async () => {
    const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionCreatedEvent('ses-card'));
    await hooks.event?.(partUpdatedEvent('ses-card', 'before delete'));
    await hooks.event?.(sessionDeletedEvent('ses-card'));
    await hooks.event?.(partUpdatedEvent('ses-card', 'after delete'));

    const types = readLines('ses-card').map((line) => line['type']);
    expect(types).toEqual(['meta', 'part']);
  });

  describe('session.idle export', () => {
    it('writes an idle line for a tracked root session', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-card'));
      await hooks.event?.(partUpdatedEvent('ses-card', 'working'));
      await hooks.event?.(sessionIdleEvent('ses-card'));

      const lines = readLines('ses-card');
      expect(lines.map((line) => line['type'])).toEqual(['meta', 'part', 'idle']);
      expect(lines[2]).toMatchObject({
        v: 1,
        seq: 3,
        sessionId: 'ses-card',
        type: 'idle',
        data: {}
      });
    });

    it('drops idle events for sessions never classified in this bundle', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      // Idle is deliberately NOT a classifying observation (no noteObserved):
      // an untracked session's idles drop benignly without starting startup.
      await hooks.event?.(sessionIdleEvent('ses-unknown'));

      expect(existsSync(join(tempDir, 'transcripts'))).toBe(false);
    });

    it('drops idle events for child sessions of a tracked root', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
      await hooks.event?.(sessionIdleEvent('ses-child'));

      expect(readLines('ses-child')).toHaveLength(0);
      expect(readLines('ses-root').map((line) => line['type'])).toEqual(['meta']);
    });

    it('still writes the idle line while subagents are active (no marker-file coupling)', async () => {
      const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      // Seed the deps marker seam as createSubagentStartPlugin would.
      recorders.markers.addSubagent('ses-card', 'ses-child');
      // Seed the REAL active-subagent state isSessionIdle() reads, so a
      // regression that adds that gate here would suppress the line and fail
      // this pin. HOME redirected → real leaf files land under tempDir.
      const originalHome = process.env['HOME'];
      process.env['HOME'] = tempDir;
      try {
        await addActiveSubagent('ses-card', 'ses-child');

        const plugin = createSessionStartPlugin(deps);
        const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
        await hooks.event?.(sessionCreatedEvent('ses-card'));
        await hooks.event?.(sessionIdleEvent('ses-card'));
      } finally {
        if (originalHome === undefined) {
          delete process.env['HOME'];
        } else {
          process.env['HOME'] = originalHome;
        }
      }

      expect(recorders.markers.count('ses-card')).toBe(1);
      expect(readLines('ses-card').map((line) => line['type'])).toEqual(['meta', 'idle']);
    });

    it('tolerates repeated idle events by appending one line each', async () => {
      const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput() });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

      await hooks.event?.(sessionCreatedEvent('ses-card'));
      await hooks.event?.(sessionIdleEvent('ses-card'));
      await hooks.event?.(partUpdatedEvent('ses-card', 'second turn'));
      await hooks.event?.(sessionIdleEvent('ses-card'));

      expect(readLines('ses-card').map((line) => line['type'])).toEqual(['meta', 'idle', 'part', 'idle']);
    });
  });

  describe('shell.env identity injection', () => {
    async function shellEnvFor(
      sessionId?: string,
      options: { roots?: string[]; children?: string[]; noAction?: boolean } = {}
    ) {
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => (options.noAction ? null : actionInput())
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      for (const id of options.roots ?? ['ses-card']) {
        await hooks.event?.(sessionCreatedEvent(id));
      }
      for (const [index, id] of (options.children ?? []).entries()) {
        await hooks.event?.(sessionCreatedEvent(id, { parentID: `ses-parent-${index}` }));
      }
      const output = { env: {} as Record<string, string> };
      await (hooks as { 'shell.env'?: (i: unknown, o: unknown) => Promise<void> })['shell.env']?.(
        sessionId === undefined ? { cwd: tempDir } : { cwd: tempDir, sessionID: sessionId },
        output
      );
      return output.env;
    }

    it('injects CARDS_SESSION_ID, OPENCODE_RUN_ID, and CARDS_TRANSCRIPT_PATH for the root', async () => {
      const env = await shellEnvFor('ses-card');
      expect(env['CARDS_SESSION_ID']).toBe('ses-card');
      expect(env['OPENCODE_RUN_ID']).toBe('ses-card');
      expect(env['CARDS_TRANSCRIPT_PATH']).toBe(join(tempDir, 'transcripts', 'ses-card.jsonl'));
    });

    it('skips child sessions', async () => {
      const env = await shellEnvFor('ses-child', { roots: [], children: ['ses-child'] });
      expect(Object.keys(env)).toHaveLength(0);
    });

    it('attributes absent-sessionID calls to the sole live root session', async () => {
      const env = await shellEnvFor(undefined, { roots: ['ses-card'] });
      expect(env['CARDS_SESSION_ID']).toBe('ses-card');
    });

    it('declines to guess when several root sessions are live', async () => {
      const env = await shellEnvFor(undefined, { roots: ['ses-a', 'ses-b'] });
      expect(Object.keys(env)).toHaveLength(0);
    });

    it('stays empty for sessions without Cards state', async () => {
      // Not spawned by a Cards action — classification happens but startup
      // declines, so there is no transcript path to inject.
      const env = await shellEnvFor('ses-user', { roots: [], noAction: true });
      expect(Object.keys(env)).toHaveLength(0);
    });
  });

  describe('system transform context injection', () => {
    async function transformFor(
      input: { sessionID?: string },
      options: { action?: Partial<ActionInput>; noAction?: boolean } = {}
    ) {
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => (options.noAction ? null : actionInput(options.action))
      });
      const plugin = createSessionStartPlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      await hooks.event?.(sessionCreatedEvent('ses-card'));
      const output = { system: [] as string[] };
      await (hooks as { 'experimental.chat.system.transform'?: (i: unknown, o: unknown) => Promise<void> })[
        'experimental.chat.system.transform'
      ]?.(input, output);
      return output.system;
    }

    it('appends the cached context fragment on every turn', async () => {
      const system = await transformFor({ sessionID: 'ses-card' });
      expect(system).toHaveLength(1);
      expect(system[0]).toContain('CARD_ID=main-453');
      expect(system[0]).toContain(`CARD_REPO_PATH=${join(tempDir, 'main-453')}`);

      const again = await transformFor({ sessionID: 'ses-card' });
      expect(again).toHaveLength(1);
    });

    it('injects nothing before the Cards action is confirmed', async () => {
      const system = await transformFor({ sessionID: 'ses-card' }, { noAction: true });
      expect(system).toHaveLength(0);
    });

    it('warns by name when the transform fires without a sessionID', async () => {
      await transformFor({});
      expect(stderrWrites.join('')).toContain('without a sessionID');
    });

    it('degrades with a named error when the card repo is inaccessible', async () => {
      const missing = join(tempDir, 'does-not-exist');
      const system = await transformFor({ sessionID: 'ses-card' }, { action: { cardRepoPath: missing } });
      expect(system).toHaveLength(0);
      expect(stderrWrites.join('')).not.toContain('failed (fail-open)');
      expect(logEntries.some((e) => e.level === 'error' && e.message.includes(missing))).toBe(true);
      // The session still streams despite the degraded context.
      expect(readLines('ses-card')).toHaveLength(1);
    });
  });

  it('warns instead of throwing when the manifest builder fails', async () => {
    const { deps, recorders } = makeDeps(tempDir, {
      loadActionInput: () => actionInput(),
      buildManifest: () => {
        throw new Error('transcript path disagrees with sessionId');
      }
    });
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

    await expect(hooks.event?.(sessionCreatedEvent('ses-card'))).resolves.toBeUndefined();

    expect(recorders.watcherSpawns).toHaveLength(0);
    expect(stderrWrites.join('')).toContain('stream-sync-watcher spawn failed');
  });

  it('warns and keeps streaming when no monitor PID resolves', async () => {
    const { deps, recorders } = makeDeps(tempDir, {
      loadActionInput: () => actionInput(),
      findMonitorPid: () => null
    });
    const plugin = createSessionStartPlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));

    await hooks.event?.(sessionCreatedEvent('ses-card'));

    expect(recorders.watcherSpawns).toHaveLength(0);
    expect(logEntries.some((e) => e.level === 'warn' && e.message.includes('transcript watcher disabled'))).toBe(true);
    expect(readLines('ses-card')).toHaveLength(1);
  });
});

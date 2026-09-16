/**
 * Tests for the OpenCode exit-when-done nudge plugin.
 *
 * @summary Tests for the OpenCode stop-exit-when-done handler
 */

import { join } from 'node:path';
import type { ActionInput } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStopExitWhenDonePlugin } from '../../../src/opencode/internal/runtime-handlers.js';
import {
  type LogEntry,
  makeCardRepo,
  makeClient,
  makeDeps,
  makePluginInput,
  makeTempDir,
  removeTempDir,
  sessionCreatedEvent,
  sessionIdleEvent
} from '../helpers.js';

let tempDir: string;
let logEntries: LogEntry[];
const stderrWrites: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = makeTempDir('exit-done');
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
 * Builds an action input with the given EXIT_WHEN_DONE flag.
 *
 * @param exitWhenDone - Whether the simulated action launched with exit-when-done.
 * @returns A complete typed action input.
 */
function actionInput(exitWhenDone: boolean): ActionInput {
  return {
    cardId: 'main-453',
    executionId: 'execution-453',
    worktreeDirective: { kind: 'reuse' },
    actionName: 'Launch Cards',
    environment: 'default',
    executionMode: 'interactive',
    exitWhenDone,
    codingAgent: 'opencode-cli',
    repoRoot: tempDir,
    cardRepoPath: join(tempDir, 'main-453'),
    configPath: '/tmp/config',
    extensionPath: '/tmp/extension',
    marketplacePath: '/tmp/extension/dist/marketplace'
  };
}

describe('CardsStopExitWhenDone (runtime)', () => {
  it('never fires outside an action subprocess', async () => {
    const { deps } = makeDeps(tempDir);
    const plugin = createStopExitWhenDonePlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionCreatedEvent('ses-root'));
    await hooks.event?.(sessionIdleEvent('ses-root'));

    expect(deps.markers.hasExitWhenDoneFired('ses-root')).toBe(false);
    expect(logEntries.some((e) => e.message.includes('exit-when-done'))).toBe(false);
  });

  it('announces the shutdown runbook exactly once for EXIT_WHEN_DONE actions', async () => {
    const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput(true) });
    const plugin = createStopExitWhenDonePlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionCreatedEvent('ses-root'));
    await hooks.event?.(sessionIdleEvent('ses-root'));

    expect(recorders.markers.exitNudged.has('ses-root')).toBe(true);
    const warnings = logEntries.filter((e) => e.level === 'warn' && e.message.includes('exit-when-done'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('cards "$CARD_ID" shutdown');
    expect(warnings[0]?.message).toContain(join(tempDir, 'skills', 'card', 'references', 'shutdown.md'));
    expect(warnings[0]?.message).toContain('terminates the launcher gracefully');
    // Nudge mirrors to stderr.
    expect(stderrWrites.join('')).toContain('exit-when-done');

    // A repeated idle event consumes no additional notification budget.
    await hooks.event?.(sessionIdleEvent('ses-root'));
    expect(logEntries.filter((e) => e.message.includes('exit-when-done'))).toHaveLength(1);
  });

  it('stays silent when EXIT_WHEN_DONE is false', async () => {
    const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput(false) });
    const plugin = createStopExitWhenDonePlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionCreatedEvent('ses-root'));
    await hooks.event?.(sessionIdleEvent('ses-root'));

    expect(recorders.markers.exitNudged.size).toBe(0);
  });

  it('skips child sessions', async () => {
    const { deps, recorders } = makeDeps(tempDir, { loadActionInput: () => actionInput(true) });
    const plugin = createStopExitWhenDonePlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionCreatedEvent('ses-root'));
    await hooks.event?.(sessionCreatedEvent('ses-child', { parentID: 'ses-root' }));
    await hooks.event?.(sessionIdleEvent('ses-child'));

    expect(recorders.markers.exitNudged.size).toBe(0);
  });

  it('notifies a resumed root whose first observation is its own idle event (I5 correction)', async () => {
    // Resumed sessions never re-emit session.created — rule (b) classifies
    // the root from the idle event itself.
    const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput(true) });
    const plugin = createStopExitWhenDonePlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionIdleEvent('ses-untracked'));

    expect(deps.markers.hasExitWhenDoneFired('ses-untracked')).toBe(true);
  });

  it('stays silent for an unseen idle event outside a Cards action', async () => {
    const { deps } = makeDeps(tempDir);
    const plugin = createStopExitWhenDonePlugin(deps);
    const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
    await hooks.event?.(sessionIdleEvent('ses-untracked'));

    expect(deps.markers.hasExitWhenDoneFired('ses-untracked')).toBe(false);
  });

  it('waits while active subagents keep the session busy', async () => {
    const { addActiveSubagent } = await import('@cards.management/sessions/card-repo');
    const { deps } = makeDeps(tempDir, { loadActionInput: () => actionInput(true) });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = tempDir;
    try {
      // Real shared leaf against real files under the redirected HOME.
      await addActiveSubagent('ses-root', 'ses-child-1');
      const plugin = createStopExitWhenDonePlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionIdleEvent('ses-root'));

      expect(deps.markers.hasExitWhenDoneFired('ses-root')).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});

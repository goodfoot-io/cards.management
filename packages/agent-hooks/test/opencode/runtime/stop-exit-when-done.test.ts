/**
 * Tests for the OpenCode exit-when-done nudge plugin.
 *
 * @summary Tests for the OpenCode stop-exit-when-done handler
 */

import { join } from 'node:path';
import type { ActionInput } from '@cards.management/sdk/config';
import { readPendingShutdownRequest, writePendingShutdownRequest } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStopExitWhenDonePlugin } from '../../../src/opencode/internal/runtime-handlers.js';
import { deliverShutdownReadiness } from '../../../src/shared/shutdown-drain.js';
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
vi.mock('../../../src/shared/shutdown-drain.js', () => ({ deliverShutdownReadiness: vi.fn(async () => undefined) }));
const mockDeliverShutdownReadiness = vi.mocked(deliverShutdownReadiness);

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

  describe('pending shutdown drain acknowledgement', () => {
    // The durable pending-request marker uses the redirected Cards home. Runtime
    // readiness delivery is observed at the authenticated transport boundary.
    let originalHome: string | undefined;
    beforeEach(() => {
      originalHome = process.env['HOME'];
      process.env['HOME'] = tempDir;
    });

    afterEach(() => {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    });

    it('submits durable runtime readiness once the idle session has no pending work', async () => {
      // Bug reproduction: the OpenCode exit-when-done plugin only ever logs a
      // nudge telling the model to run `cards shutdown` — it never reads the
      // durable pending-request marker that verb writes, and never submits the
      // current-revision readiness evidence the runtime authority
      // (packages/extension/src/runtime/ActionDispatcher.ts) waits on before
      // forwarding `agentShutdown`. Without this, OpenCode shutdowns can never
      // clear the 30s readiness timeout, so the owned process tree is left
      // running instead of being terminated.
      writePendingShutdownRequest('ses-root', {
        version: 1,
        requestId: 'req-1',
        messageId: 'msg-1',
        outcome: 'success'
      });

      // Real `isAgentProcessTreeDrained` probe against the real `ps -e` table:
      // point the owned-tree root at this actual test process (matching how
      // OpenCode's in-process plugin roots the strict check at its own PID,
      // not a subprocess-hook ancestor) so the probe can find it.
      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(true),
        findMonitorPid: () => process.pid
      });
      const plugin = createStopExitWhenDonePlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionIdleEvent('ses-root'));

      // The plugin's event handler awaits durable runtime acceptance before it
      // clears the correlated request marker.
      expect(mockDeliverShutdownReadiness).toHaveBeenCalledWith(
        'ses-root',
        expect.objectContaining({ requestId: 'req-1' })
      );
      expect(readPendingShutdownRequest('ses-root')).toBeUndefined();
    });

    it('submits runtime readiness even when EXIT_WHEN_DONE is false or absent (regression)', async () => {
      // Bug: the drain-ack was gated behind `actionInput?.exitWhenDone`, so a
      // plain `Chat`-launched session (which never sets EXIT_WHEN_DONE=true)
      // could never acknowledge a pending `cards shutdown` request, no matter
      // how long it sat idle. The drain-ack must be unconditional; only the
      // separate exit-when-done nudge should depend on that flag.
      writePendingShutdownRequest('ses-root', {
        version: 1,
        requestId: 'req-2',
        messageId: 'msg-2',
        outcome: 'success'
      });

      const { deps } = makeDeps(tempDir, {
        // No loadActionInput override: defaults to `() => null`, matching a
        // real Chat-launched session with no action input at all.
        findMonitorPid: () => process.pid
      });
      const plugin = createStopExitWhenDonePlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionIdleEvent('ses-root'));

      expect(mockDeliverShutdownReadiness).toHaveBeenCalledWith(
        'ses-root',
        expect.objectContaining({ requestId: 'req-2' })
      );
      expect(readPendingShutdownRequest('ses-root')).toBeUndefined();
      // No exit-when-done nudge should have fired for this non-exit-when-done session.
      expect(deps.markers.hasExitWhenDoneFired('ses-root')).toBe(false);
    });

    it('drains a pending request and still returns before the nudge when EXIT_WHEN_DONE is true', async () => {
      // When both a pending request exists and exitWhenDone is true, the
      // drain-ack still runs, and the function must not also fire the nudge
      // on the same idle event (matches the existing early-return-after-
      // pendingRequest-handling behavior).
      writePendingShutdownRequest('ses-root', {
        version: 1,
        requestId: 'req-3',
        messageId: 'msg-3',
        outcome: 'success'
      });

      const { deps } = makeDeps(tempDir, {
        loadActionInput: () => actionInput(true),
        findMonitorPid: () => process.pid
      });
      const plugin = createStopExitWhenDonePlugin(deps);
      const hooks = await plugin(makePluginInput(tempDir, makeClient(logEntries)));
      await hooks.event?.(sessionCreatedEvent('ses-root'));
      await hooks.event?.(sessionIdleEvent('ses-root'));

      expect(mockDeliverShutdownReadiness).toHaveBeenCalledWith(
        'ses-root',
        expect.objectContaining({ requestId: 'req-3' })
      );
      expect(readPendingShutdownRequest('ses-root')).toBeUndefined();
      expect(deps.markers.hasExitWhenDoneFired('ses-root')).toBe(false);
    });
  });
});

/**
 * Real-process coverage for the branch-cleanup worker's 60s deadline over
 * {@link cleanupMergedBranches} and its git descendants.
 *
 * `cleanupMergedBranches` itself is mocked (it would otherwise perform real
 * network/git operations), but everything downstream of the deadline —
 * process identification, signal delivery, and liveness checks — runs
 * against real spawned Node child processes and real OS signals, the same
 * discipline `claude-shutdown.test.ts`/`codex-shutdown.test.ts` use for
 * action-tree termination. The authority here is deliberately scoped to a
 * fixed, known membership set (this test's own pid plus its spawned
 * descendants) rather than a live system-wide `ps` scan, so the test cannot
 * observe or signal unrelated processes on a shared machine.
 *
 * @summary Real-process coverage for the branch-cleanup worker's deadline enforcement
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { ActionContext } from '@cards.management/sdk/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedProcessIdentity, ProcessTreeAuthority } from '../src/lib/process-tree-termination.js';

vi.mock('../src/lib/claude-session.js', () => ({
  cleanupMergedBranches: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

function createSpyLogger(): ActionContext['logger'] {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn()
  };
}

const children = new Set<ChildProcess>();

function launch(source: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore'] });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  children.clear();
  vi.restoreAllMocks();
});

/**
 * Builds a {@link ProcessTreeAuthority} backed by real `process.kill`
 * signaling and liveness checks, but scoped to exactly `ownPid` plus
 * `descendantPids` — never a real system-wide process-table scan — so
 * `runCleanupWithDeadline`'s own-pid exclusion and identity-checked
 * TERM/KILL discipline can be exercised against genuine OS processes without
 * risk to unrelated processes on a shared machine.
 *
 * @param ownPid - The pid `runCleanupWithDeadline` will see as its own
 *   (`process.pid` in the real implementation).
 * @param descendantPids - Real child process pids considered part of the
 *   same "group".
 * @returns A real-signaling, fixed-membership authority.
 */
function fixedMembershipAuthority(ownPid: number, descendantPids: readonly number[]): ProcessTreeAuthority {
  const identity = (processId: number): OwnedProcessIdentity => ({
    processId,
    bootId: 'test-boot',
    startedAtToken: 'test-start',
    groupId: ownPid
  });
  return {
    async identify(processId) {
      return isAlive(processId) ? identity(processId) : null;
    },
    async members() {
      return [ownPid, ...descendantPids].filter(isAlive).map((pid) => identity(pid));
    },
    async signal(target, signal) {
      if (!isAlive(target.processId)) return 'exited';
      try {
        process.kill(target.processId, signal);
        return 'sent';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'refused';
      }
    }
  };
}

describe('runCleanupWithDeadline', () => {
  it('returns "completed" without touching any descendant when cleanup settles before the deadline', async () => {
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    vi.mocked(cleanupMergedBranches).mockResolvedValue(undefined);
    const { runCleanupWithDeadline } = await import('../src/lib/branch-cleanup-watcher.js');
    const authority = fixedMembershipAuthority(process.pid, []);
    const logger = createSpyLogger();

    const outcome = await runCleanupWithDeadline(
      { cardId: 'main-1', repoRoot: '/repo' },
      '/repo/.cards',
      logger,
      'session-1',
      { authority, deadlineMs: 5_000 }
    );

    expect(outcome).toBe('completed');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it(
    'force-kills a TERM-ignoring git descendant that survives the deadline, ' + 'without signalling the worker itself',
    async () => {
      const descendant = launch("process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9)");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const descendantPid = descendant.pid as number;
      expect(isAlive(descendantPid)).toBe(true);

      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
      vi.mocked(cleanupMergedBranches).mockImplementation(() => new Promise(() => {}));
      const { runCleanupWithDeadline } = await import('../src/lib/branch-cleanup-watcher.js');
      const authority = fixedMembershipAuthority(process.pid, [descendantPid]);
      const logger = createSpyLogger();

      const outcome = await runCleanupWithDeadline(
        { cardId: 'main-2', repoRoot: '/repo' },
        '/repo/.cards',
        logger,
        'session-2',
        { authority, deadlineMs: 20, descendantGracefulTimeoutMs: 50, descendantForceTimeoutMs: 500 }
      );

      expect(outcome).toBe('timed-out');
      await waitForExit(descendantPid);
      expect(isAlive(descendantPid)).toBe(false);
      // The worker's own pid (this test process) must never be signalled.
      expect(isAlive(process.pid)).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        'Branch-cleanup worker exceeded its deadline; terminating surviving git descendants',
        expect.objectContaining({ cardId: 'main-2', sessionId: 'session-2' })
      );
    }
  );

  it('reaps a git descendant that exits gracefully on TERM once the deadline is exceeded', async () => {
    const descendant = launch("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1e9)");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const descendantPid = descendant.pid as number;
    expect(isAlive(descendantPid)).toBe(true);

    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    vi.mocked(cleanupMergedBranches).mockImplementation(() => new Promise(() => {}));
    const { runCleanupWithDeadline } = await import('../src/lib/branch-cleanup-watcher.js');
    const authority = fixedMembershipAuthority(process.pid, [descendantPid]);
    const logger = createSpyLogger();

    const outcome = await runCleanupWithDeadline(
      { cardId: 'main-3', repoRoot: '/repo' },
      '/repo/.cards',
      logger,
      'session-3',
      { authority, deadlineMs: 20, descendantGracefulTimeoutMs: 500, descendantForceTimeoutMs: 500 }
    );

    expect(outcome).toBe('timed-out');
    await waitForExit(descendantPid);
    expect(isAlive(descendantPid)).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
  });
});

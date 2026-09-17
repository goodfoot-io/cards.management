import type { ActionContext } from '@cards.management/sdk/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the standalone branch-cleanup worker (`runBranchCleanupWorker`),
 * the sole surviving cleanup mechanism now that the detached-spawn path
 * (`spawnBranchCleanupWatcher`/`runDetachedCleanup`) has been retired in favor
 * of a durable `execution.branchCleanupRegistration` producer plus the
 * extension's own env-var-based worker launcher.
 *
 * @summary Tests for `runBranchCleanupWorker`
 */

vi.mock('@cards.management/sdk/client/discovery', () => ({
  createCardsClient: vi.fn()
}));

vi.mock('../src/lib/claude-session.js', () => ({
  cleanupMergedBranches: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

const { createCardsClient } = await import('@cards.management/sdk/client/discovery');
const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
const { runBranchCleanupWorker } = await import('../src/lib/branch-cleanup-watcher.js');

/**
 * Builds a fake logger conforming to `ActionContext['logger']` with spy-able
 * methods.
 * @returns A logger whose methods are `vi.fn()` spies.
 */
function createSpyLogger(): ActionContext['logger'] {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn()
  };
}

const baseParams = {
  cardId: 'card-123',
  repoRoot: '/repo',
  cardRepoPath: '/repo/card-123',
  sessionId: 'session-abc'
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runBranchCleanupWorker', () => {
  it('returns 0 and logs completion when cleanup settles before the deadline', async () => {
    vi.mocked(createCardsClient).mockResolvedValue({} as never);
    vi.mocked(cleanupMergedBranches).mockResolvedValue(undefined);
    const logger = createSpyLogger();

    const exitCode = await runBranchCleanupWorker(baseParams, logger);

    expect(exitCode).toBe(0);
    expect(cleanupMergedBranches).toHaveBeenCalledWith(
      { cardId: baseParams.cardId, repoRoot: baseParams.repoRoot },
      baseParams.cardRepoPath,
      logger,
      baseParams.sessionId
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Branch-cleanup watcher completed',
      expect.objectContaining({ outcome: 'completed' })
    );
  });

  it('returns 1 and logs a failure when Cards API discovery fails', async () => {
    vi.mocked(createCardsClient).mockResolvedValue(null as never);
    const logger = createSpyLogger();

    const exitCode = await runBranchCleanupWorker(baseParams, logger);

    expect(exitCode).toBe(1);
    expect(cleanupMergedBranches).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Branch-cleanup watcher failed',
      expect.objectContaining({ error: expect.stringContaining('Cards API discovery failed') })
    );
  });

  it('returns 1 and logs a failure when cleanup rejects', async () => {
    vi.mocked(createCardsClient).mockResolvedValue({} as never);
    vi.mocked(cleanupMergedBranches).mockRejectedValue(new Error('git fetch failed'));
    const logger = createSpyLogger();

    const exitCode = await runBranchCleanupWorker(baseParams, logger, { deadlineMs: 50 });

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Branch-cleanup watcher failed',
      expect.objectContaining({ error: 'git fetch failed' })
    );
  });

  it('returns 1 and logs a timed-out outcome when cleanup exceeds the deadline', async () => {
    vi.mocked(createCardsClient).mockResolvedValue({} as never);
    vi.mocked(cleanupMergedBranches).mockImplementation(() => new Promise(() => {}));
    const logger = createSpyLogger();
    const authority = {
      identify: vi.fn().mockResolvedValue(null),
      members: vi.fn(),
      signal: vi.fn()
    };

    const exitCode = await runBranchCleanupWorker(baseParams, logger, { deadlineMs: 10, authority });

    expect(exitCode).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Branch-cleanup watcher completed',
      expect.objectContaining({ outcome: 'timed-out' })
    );
  });

  it('omits sessionId from the cleanupMergedBranches call when not provided', async () => {
    vi.mocked(createCardsClient).mockResolvedValue({} as never);
    vi.mocked(cleanupMergedBranches).mockResolvedValue(undefined);
    const logger = createSpyLogger();
    const { sessionId: _sessionId, ...paramsWithoutSession } = baseParams;

    const exitCode = await runBranchCleanupWorker(paramsWithoutSession, logger);

    expect(exitCode).toBe(0);
    expect(cleanupMergedBranches).toHaveBeenCalledWith(
      { cardId: baseParams.cardId, repoRoot: baseParams.repoRoot },
      baseParams.cardRepoPath,
      logger,
      undefined
    );
  });
});

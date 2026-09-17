/**
 * Tests for the WorktreeRemove hook handler.
 *
 * Mocks removeWorktree to avoid real git operations. Verifies that the hook
 * invokes removeWorktree with the input path, logs success/failure, and never
 * throws on removeWorktree failure (harness ignores the output).
 *
 * @summary WorktreeRemove hook handler tests
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CardsClient } from '@cards.management/sdk/client';
import type { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cards.management/sdk/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/worktree')>();
  return {
    ...actual,
    removeWorktree: vi.fn()
  };
});

vi.mock('@cards.management/sdk/worktree-for-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/worktree-for-card')>();
  return {
    // Keep the real BranchUnregisterError so the hook's instanceof phase
    // classification works against the same class the tests construct.
    BranchUnregisterError: actual.BranchUnregisterError,
    removeWorktreeForCard: vi.fn()
  };
});

vi.mock('@cards.management/sdk/client/discovery', () => ({
  createCardsClient: vi.fn()
}));

vi.mock('../../../src/shared/default-log-file.js', () => ({
  applyDefaultLogFile: vi.fn()
}));

import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { removeWorktree, WorktreeScopeError } from '@cards.management/sdk/worktree';
import { BranchUnregisterError, removeWorktreeForCard } from '@cards.management/sdk/worktree-for-card';
import hookFn from '../../../src/claude/core/worktree-remove.js';

/** A non-null fake client; the hook only checks for null. */
const fakeClient = {} as unknown as CardsClient;

describe('WorktreeRemove hook', () => {
  const mockRemoveWorktree = vi.mocked(removeWorktree);
  const mockRemoveWorktreeForCard = vi.mocked(removeWorktreeForCard);
  const mockCreateCardsClient = vi.mocked(createCardsClient);
  const mockLogger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn()
  };

  const baseInput = {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/workspace',
    hook_event_name: 'WorktreeRemove' as const,
    // A path with no `.cards/CARD_ID` marker on disk → treated as unbound.
    worktree_path: '/worktrees/test/feature/test-branch'
  };

  let tmpBase = '';

  /**
   * Creates a temp directory that looks like a card-bound worktree: a git repo
   * (so rev-parse resolves a branch) plus a `.cards/CARD_ID` marker.
   *
   * @param cardId - Card ID to write into the marker.
   * @param branch - Branch name the repo's HEAD points at.
   * @returns Absolute path to the worktree-like directory.
   */
  async function makeCardBoundWorktree(cardId: string, branch: string): Promise<string> {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wtr-hook-'));
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: tmpBase });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpBase });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpBase });
    await fs.writeFile(path.join(tmpBase, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: tmpBase });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpBase });
    await fs.mkdir(path.join(tmpBase, '.cards'), { recursive: true });
    await fs.writeFile(path.join(tmpBase, '.cards', 'CARD_ID'), `${cardId}\n`);
    return tmpBase;
  }

  afterEach(async () => {
    if (tmpBase) {
      // maxRetries: git worktree children can briefly hold a handle on the temp
      // tree on Windows, racing the rmdir into EBUSY; Node retries on that class.
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  function resetMocks() {
    mockRemoveWorktree.mockReset();
    mockRemoveWorktreeForCard.mockReset();
    mockCreateCardsClient.mockReset();
    mockCreateCardsClient.mockResolvedValue(fakeClient);
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
  }

  it('has correct hookEventName', () => {
    expect(hookFn.eventName).toBe('WorktreeRemove');
  });

  it('invokes removeWorktree with input.worktree_path', async () => {
    resetMocks();
    mockRemoveWorktree.mockResolvedValue(undefined);

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockRemoveWorktree).toHaveBeenCalledWith('/worktrees/test/feature/test-branch');
  });

  it('logs success and elapsed time on completion', async () => {
    resetMocks();
    mockRemoveWorktree.mockResolvedValue(undefined);

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockLogger.info).toHaveBeenCalledWith(
      'WorktreeRemove complete',
      expect.objectContaining({
        worktree_path: '/worktrees/test/feature/test-branch',
        elapsedMs: expect.any(Number)
      })
    );
  });

  it('logs but does not throw when removeWorktree fails with an operational error', async () => {
    resetMocks();
    mockRemoveWorktree.mockRejectedValue(new Error('git failure'));

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).resolves.not.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'WorktreeRemove failed',
      expect.objectContaining({
        worktree_path: '/worktrees/test/feature/test-branch',
        error: expect.stringContaining('git failure')
      })
    );
  });

  it('rethrows WorktreeScopeError without logging warn', async () => {
    resetMocks();
    const scopeError = new WorktreeScopeError('path is outside the Cards worktrees root: /etc');
    mockRemoveWorktree.mockRejectedValue(scopeError);

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toBeInstanceOf(
      WorktreeScopeError
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('routes a card-bound worktree through removeWorktreeForCard with the derived cardId', async () => {
    resetMocks();
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    mockRemoveWorktreeForCard.mockResolvedValue(undefined);

    await hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger });

    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    // The hook no longer resolves the branch name itself — releaseWorktreeForCard
    // derives it from HEAD — so it forwards only the cardId.
    expect(mockRemoveWorktreeForCard).toHaveBeenCalledWith(fakeClient, worktree_path, {
      cardId: 'main-77'
    });
  });

  it('preserves a bound worktree when its cleanup authority is unavailable', async () => {
    resetMocks();
    mockCreateCardsClient.mockResolvedValue(null);
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    mockRemoveWorktree.mockResolvedValue(undefined);

    await hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger });

    expect(mockRemoveWorktreeForCard).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(worktree_path, '.cards', 'CARD_ID'), 'utf8')).toBe('main-77\n');
    expect(mockLogger.info).not.toHaveBeenCalledWith('WorktreeRemove complete', expect.anything());
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cards API unavailable'),
      expect.objectContaining({ cardId: 'main-77' })
    );
  });

  it('acquires the client with retryOnNetworkError disabled (fail-fast) for a bound worktree', async () => {
    resetMocks();
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    mockRemoveWorktreeForCard.mockResolvedValue(undefined);

    await hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger });

    expect(mockCreateCardsClient).toHaveBeenCalledWith(mockLogger, { retryOnNetworkError: false });
  });

  it('fails open (logs, does not throw) when the unregister phase fails (BranchUnregisterError)', async () => {
    resetMocks();
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    // The unregister phase failed: the worktree was already torn down, only the
    // branch record is orphaned. Classified by error type, not path existence.
    mockRemoveWorktreeForCard.mockRejectedValue(new BranchUnregisterError(new Error('removeBranch failed')));

    await expect(
      hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger })
    ).resolves.not.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('branch unregister failed'),
      expect.objectContaining({ cardId: 'main-77' })
    );
  });

  it('treats a non-BranchUnregisterError as a teardown failure (logged under WorktreeRemove failed)', async () => {
    resetMocks();
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    // A teardown-phase failure (e.g. git worktree prune failing AFTER the dir
    // was deleted) is NOT wrapped in BranchUnregisterError. The old heuristic
    // would have downgraded it to fail-open because the path is gone; type
    // classification correctly keeps it a teardown failure.
    mockRemoveWorktreeForCard.mockImplementation(async () => {
      await fs.rm(worktree_path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      throw new Error('git worktree prune failed');
    });

    await hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'WorktreeRemove failed',
      expect.objectContaining({ error: expect.stringContaining('git worktree prune failed') })
    );
    // It must NOT have been downgraded to the fail-open branch-unregister log.
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('branch unregister failed'),
      expect.anything()
    );
  });

  it('rethrows WorktreeScopeError from the unregister-routing path (still a teardown failure)', async () => {
    resetMocks();
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    mockRemoveWorktreeForCard.mockRejectedValue(new WorktreeScopeError('path outside worktrees root'));

    await expect(
      hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger })
    ).rejects.toBeInstanceOf(WorktreeScopeError);
  });

  it('still routes a detached-HEAD bound worktree through removeWorktreeForCard', async () => {
    resetMocks();
    const worktree_path = await makeCardBoundWorktree('main-77', 'cards/main-77/3');
    // Detach HEAD so rev-parse --abbrev-ref yields the literal "HEAD".
    const sha = execFileSync('git', ['-C', worktree_path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', worktree_path, 'checkout', '-q', '--detach', sha]);
    mockRemoveWorktreeForCard.mockResolvedValue(undefined);

    await hookFn({ ...baseInput, worktree_path }, { logger: mockLogger as unknown as Logger });

    // The hook no longer special-cases detached HEAD: it forwards to
    // removeWorktreeForCard, whose ownership check refuses an unregistered HEAD
    // (covered by the SDK-level tests). No bare-removal path bypasses it.
    expect(mockRemoveWorktreeForCard).toHaveBeenCalledWith(fakeClient, worktree_path, {
      cardId: 'main-77'
    });
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});

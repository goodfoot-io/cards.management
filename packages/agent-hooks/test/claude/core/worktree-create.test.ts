/**
 * Tests for the WorktreeCreate hook handler.
 *
 * Mocks createWorktree (unbound path) and createWorktreeForCard (card-bound
 * path) to avoid real git operations, plus createCardsClient for client
 * acquisition and child_process for parent-branch derivation. Verifies
 * CARD_ID forwarding, fail-closed client acquisition, settle-awaiting,
 * error propagation, and output shape.
 *
 * @summary WorktreeCreate hook handler tests
 */

import * as path from 'node:path';
import type { CardsClient } from '@cards.management/sdk/client';
import type { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Compiled git-hook .mjs paths the hook builds from the mocked extension path
 * (`/ext/install`). Built with the same `path.join` the production code uses so
 * the separator matches the host platform (`/` on POSIX, `\` on Windows).
 */
const EXPECTED_COMPILED_SCRIPT_PATHS = {
  'pre-commit': path.join('/ext/install', 'dist', 'git-hooks', 'pre-commit.mjs'),
  'post-commit': path.join('/ext/install', 'dist', 'git-hooks', 'post-commit.mjs'),
  'post-rewrite': path.join('/ext/install', 'dist', 'git-hooks', 'post-rewrite.mjs')
};

// execFile is consumed via promisify(execFile), which uses the [util.promisify.custom]
// symbol on the real execFile to resolve with { stdout, stderr }. The mock carries an
// equivalent custom impl so promisify(mock) returns that shape; mockExecFileStdout
// controls the resolved stdout of the HEAD-branch lookup. The worktree-detection
// probe (`rev-parse --git-dir --git-common-dir`) is answered separately: equal
// paths, modeling the main working tree, so the hook derives the parent from HEAD.
let mockExecFileStdout = 'main\n';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFileMock = vi.fn() as unknown as {
    (...a: unknown[]): unknown;
    [k: symbol]: unknown;
  };
  execFileMock[promisify.custom] = async (_cmd: string, args: string[]) => {
    if (Array.isArray(args) && args.includes('--git-common-dir')) {
      return { stdout: '/test/workspace/.git\n/test/workspace/.git\n', stderr: '' };
    }
    return { stdout: mockExecFileStdout, stderr: '' };
  };
  return {
    ...actual,
    execFile: execFileMock
  };
});

vi.mock('@cards.management/sdk/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/worktree')>();
  return {
    ...actual,
    createWorktree: vi.fn()
  };
});

vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

vi.mock('@cards.management/sdk/client/discovery', () => ({
  createCardsClient: vi.fn()
}));

vi.mock('@cards.management/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk')>();
  return {
    ...actual,
    resolveExtensionPath: vi.fn()
  };
});

vi.mock('@cards.management/sdk/cards-parent-branch', () => ({
  writeCardsParentConfig: vi.fn()
}));

vi.mock('@cards.management/sdk/unbound-worktree-candidates', () => ({
  addUnboundCandidate: vi.fn()
}));

vi.mock('../../../src/shared/default-log-file.js', () => ({
  applyDefaultLogFile: vi.fn()
}));

vi.mock('@cards.management/sdk/adhoc-attribution', () => ({
  resolveWorktreeCardId: vi.fn()
}));

import { resolveExtensionPath } from '@cards.management/sdk';
import { resolveWorktreeCardId } from '@cards.management/sdk/adhoc-attribution';
import { writeCardsParentConfig } from '@cards.management/sdk/cards-parent-branch';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { addUnboundCandidate } from '@cards.management/sdk/unbound-worktree-candidates';
import { createWorktree } from '@cards.management/sdk/worktree';
import { createWorktreeForCard } from '@cards.management/sdk/worktree-for-card';
import hookFn from '../../../src/claude/core/worktree-create.js';

/** A non-null fake client; the hook only checks for null, never calls methods on it. */
const fakeClient = {} as unknown as CardsClient;

/**
 * Standard early worktree result returned by both create mocks.
 *
 * @param worktreePath - The worktree path to report as `path` and in `settle`.
 * @param reroutedSymlinks - Count to report in the settled result.
 * @returns An EarlyWorktreeResult-shaped object.
 */
function settledResult(worktreePath: string, reroutedSymlinks = 0) {
  return {
    path: worktreePath,
    settle: Promise.resolve({
      branch: 'feature/test-branch',
      worktree: worktreePath,
      baseSha: 'abc123',
      copiedFromInclude: 0,
      reroutedSymlinks
    })
  };
}

describe('WorktreeCreate hook', () => {
  const originalEnv = process.env;
  const mockCreateWorktree = vi.mocked(createWorktree);
  const mockCreateWorktreeForCard = vi.mocked(createWorktreeForCard);
  const mockCreateCardsClient = vi.mocked(createCardsClient);
  const mockWriteCardsParentConfig = vi.mocked(writeCardsParentConfig);
  const mockAddUnboundCandidate = vi.mocked(addUnboundCandidate);
  const mockResolveWorktreeCardId = vi.mocked(resolveWorktreeCardId);
  const mockLogger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn()
  };

  const baseInput = {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/test/workspace',
    hook_event_name: 'WorktreeCreate' as const,
    name: 'feature/test-branch'
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockCreateWorktree.mockReset();
    mockCreateWorktreeForCard.mockReset();
    mockCreateCardsClient.mockReset();
    mockWriteCardsParentConfig.mockReset();
    mockAddUnboundCandidate.mockReset();
    mockResolveWorktreeCardId.mockReset();
    // Default: no `.cards/CARD_ID` marker up the tree, so an unset/empty env
    // CARD_ID falls through to the unbound path unless a test says otherwise.
    mockResolveWorktreeCardId.mockResolvedValue(null);
    // Default: client discovery succeeds for card-bound tests.
    mockCreateCardsClient.mockResolvedValue(fakeClient);
    // Default: the unbound-path side effects resolve successfully.
    mockWriteCardsParentConfig.mockResolvedValue(undefined);
    mockAddUnboundCandidate.mockResolvedValue(undefined);
    // Default current branch resolved for parentBranch derivation.
    mockExecFileStdout = 'main\n';
    vi.mocked(resolveExtensionPath).mockReset();
    // Default: extension path resolves so card-bound tests that don't override
    // it still produce valid compiledScriptPaths.
    vi.mocked(resolveExtensionPath).mockResolvedValue('/ext/install');
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('has correct hookEventName', () => {
    expect(hookFn.eventName).toBe('WorktreeCreate');
  });

  it('returns worktreePath in output after settle resolves (unbound path)', async () => {
    delete process.env['CARD_ID'];
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath, 5));

    const result = await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(result).not.toBeNull();
    // WorktreeCreate is a command hook: the path is written to stdout as plain
    // text via rawStdout so Claude Code can chdir into it; the JSON stdout is empty.
    expect((result as { rawStdout: string }).rawStdout).toBe(worktreePath);
  });

  it('routes card-bound creation through createWorktreeForCard with cardId from CARD_ID env', async () => {
    process.env['CARD_ID'] = 'main-42';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({
        cardId: 'main-42',
        cwd: '/test/workspace',
        parentBranch: 'main',
        registrationIntent: 'create'
      })
    );
  });

  it('calls bare createWorktree (unbound) when CARD_ID is unset and no .cards/CARD_ID marker resolves up the tree', async () => {
    delete process.env['CARD_ID'];
    mockResolveWorktreeCardId.mockResolvedValue(null);
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    // The walk-up is the second source: it must be consulted from input.cwd when
    // the env var is absent.
    expect(mockResolveWorktreeCardId).toHaveBeenCalledWith('/test/workspace');
    expect(mockCreateWorktreeForCard).not.toHaveBeenCalled();
    expect(mockCreateCardsClient).not.toHaveBeenCalled();
    expect(mockCreateWorktree).toHaveBeenCalledWith('feature/test-branch', { cwd: '/test/workspace' });
  });

  it('calls bare createWorktree (unbound) when CARD_ID is empty string and no marker resolves up the tree', async () => {
    process.env['CARD_ID'] = '';
    mockResolveWorktreeCardId.mockResolvedValue(null);
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    // An empty/whitespace env var is falsy after trim, so the walk-up still runs.
    expect(mockResolveWorktreeCardId).toHaveBeenCalledWith('/test/workspace');
    expect(mockCreateWorktreeForCard).not.toHaveBeenCalled();
    expect(mockCreateWorktree).toHaveBeenCalledWith('feature/test-branch', { cwd: '/test/workspace' });
  });

  it('inherits the parent binding: routes through createWorktreeForCard with the cardId resolved from .cards/CARD_ID when CARD_ID env is unset', async () => {
    delete process.env['CARD_ID'];
    mockResolveWorktreeCardId.mockResolvedValue('main-77');
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockResolveWorktreeCardId).toHaveBeenCalledWith('/test/workspace');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({ cardId: 'main-77', cwd: '/test/workspace', parentBranch: 'main' })
    );
  });

  it('inherits the parent binding even when CARD_ID env is an empty string (walk-up still wins)', async () => {
    process.env['CARD_ID'] = '';
    mockResolveWorktreeCardId.mockResolvedValue('main-88');
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({ cardId: 'main-88' })
    );
  });

  it('env CARD_ID wins over the on-disk marker and short-circuits the walk-up', async () => {
    process.env['CARD_ID'] = 'main-42';
    // Even if a different card id sits on disk, the env var takes precedence and
    // the walk-up is never consulted (|| short-circuits).
    mockResolveWorktreeCardId.mockResolvedValue('main-999');
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockResolveWorktreeCardId).not.toHaveBeenCalled();
    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({ cardId: 'main-42' })
    );
  });

  it('writes cardsParent config and feeds the candidate set with resolved parentBranch on unbound path', async () => {
    delete process.env['CARD_ID'];
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockWriteCardsParentConfig).toHaveBeenCalledWith(worktreePath, 'feature/test-branch', 'main');
    expect(mockAddUnboundCandidate).toHaveBeenCalledWith('test-session', worktreePath, '/tmp/transcript.jsonl');
  });

  it('records the cardsParent config branch resolved from source repo HEAD', async () => {
    delete process.env['CARD_ID'];
    mockExecFileStdout = 'develop\n';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockWriteCardsParentConfig).toHaveBeenCalledWith(worktreePath, 'feature/test-branch', 'develop');
  });

  it('does not feed the candidate set when CARD_ID is set (card-bound path)', async () => {
    process.env['CARD_ID'] = 'main-42';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockAddUnboundCandidate).not.toHaveBeenCalled();
    expect(mockWriteCardsParentConfig).not.toHaveBeenCalled();
  });

  it('does not feed the candidate set when the card id is inherited from the on-disk marker', async () => {
    delete process.env['CARD_ID'];
    mockResolveWorktreeCardId.mockResolvedValue('main-77');
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockAddUnboundCandidate).not.toHaveBeenCalled();
  });

  it('uses input.cwd as cwd for createWorktreeForCard (card-bound)', async () => {
    process.env['CARD_ID'] = 'main-42';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn({ ...baseInput, cwd: '/custom/cwd' }, { logger: mockLogger as unknown as Logger });

    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({ cwd: '/custom/cwd' })
    );
  });

  it('derives parentBranch from the source repo HEAD (card-bound path)', async () => {
    process.env['CARD_ID'] = 'main-42';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));
    mockExecFileStdout = 'develop\n';

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({ parentBranch: 'develop' })
    );
  });

  it('throws (fail-closed) on detached-HEAD source, recording no bogus "HEAD" parentBranch', async () => {
    process.env['CARD_ID'] = 'main-42';
    // Detached HEAD: `git rev-parse --abbrev-ref HEAD` yields the literal "HEAD".
    mockExecFileStdout = 'HEAD\n';

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow('detached-HEAD');
    expect(mockCreateWorktreeForCard).not.toHaveBeenCalled();
  });

  it('throws (fail-closed) on detached-HEAD source for unbound path too', async () => {
    delete process.env['CARD_ID'];
    mockExecFileStdout = 'HEAD\n';

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow('detached-HEAD');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockAddUnboundCandidate).not.toHaveBeenCalled();
  });

  it('acquires the client with retryOnNetworkError disabled (fail-fast on unreachable server)', async () => {
    process.env['CARD_ID'] = 'main-42';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockCreateCardsClient).toHaveBeenCalledWith(mockLogger, { retryOnNetworkError: false });
  });

  it('throws (fail-closed) when the Cards client cannot be discovered for a card-bound worktree', async () => {
    process.env['CARD_ID'] = 'main-42';
    mockCreateCardsClient.mockResolvedValue(null);

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow(
      'Cards API unavailable'
    );
    expect(mockCreateWorktreeForCard).not.toHaveBeenCalled();
  });

  it('throws (fail-closed) when the Cards client is unavailable for an inherited (on-disk) card id', async () => {
    delete process.env['CARD_ID'];
    mockResolveWorktreeCardId.mockResolvedValue('main-77');
    mockCreateCardsClient.mockResolvedValue(null);

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow(
      'Cards API unavailable'
    );
    // No card-bound worktree is created and no unbound fallback is written —
    // the inherited binding is not silently degraded to unbound.
    expect(mockCreateWorktreeForCard).not.toHaveBeenCalled();
    expect(mockAddUnboundCandidate).not.toHaveBeenCalled();
  });

  it('logs completion with cardId when CARD_ID env is set', async () => {
    process.env['CARD_ID'] = 'main-99';
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockLogger.info).toHaveBeenCalledWith(
      'WorktreeCreate complete',
      expect.objectContaining({ cardId: 'main-99', elapsedMs: expect.any(Number) })
    );
  });

  it('logs null cardId in completion when CARD_ID is not set', async () => {
    delete process.env['CARD_ID'];
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(mockLogger.info).toHaveBeenCalledWith(
      'WorktreeCreate complete',
      expect.objectContaining({ cardId: null, elapsedMs: expect.any(Number) })
    );
  });

  it('throws when settle rejects (does not swallow, unbound path)', async () => {
    delete process.env['CARD_ID'];
    mockCreateWorktree.mockResolvedValue({
      path: '/some/path',
      settle: Promise.reject(new Error('settle failed'))
    });

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow('settle failed');
  });

  it('passes compiledScriptPaths resolved from extension path when CARD_ID is set', async () => {
    process.env['CARD_ID'] = 'main-42';
    vi.mocked(resolveExtensionPath).mockResolvedValue('/ext/install');
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktreeForCard.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(resolveExtensionPath).toHaveBeenCalledOnce();
    expect(mockCreateWorktreeForCard).toHaveBeenCalledWith(
      fakeClient,
      'feature/test-branch',
      expect.objectContaining({
        cardId: 'main-42',
        compiledScriptPaths: EXPECTED_COMPILED_SCRIPT_PATHS
      })
    );
  });

  it('does not resolve extension path or acquire a client when CARD_ID is unset and no marker resolves up the tree', async () => {
    delete process.env['CARD_ID'];
    mockResolveWorktreeCardId.mockResolvedValue(null);
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));

    await hookFn(baseInput, { logger: mockLogger as unknown as Logger });

    expect(resolveExtensionPath).not.toHaveBeenCalled();
    expect(mockCreateCardsClient).not.toHaveBeenCalled();
  });

  it('propagates resolveExtensionPath failure (fail-closed) when CARD_ID is set', async () => {
    process.env['CARD_ID'] = 'main-42';
    vi.mocked(resolveExtensionPath).mockRejectedValue(
      new Error('Cannot resolve extension path: EXTENSION_PATH env var is not set')
    );

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow(
      'Cannot resolve extension path'
    );
    expect(mockCreateWorktreeForCard).not.toHaveBeenCalled();
  });

  it('throws (fail-closed) when the candidate-set write fails on unbound path', async () => {
    delete process.env['CARD_ID'];
    const worktreePath = '/worktrees/test/feature/test-branch';
    mockCreateWorktree.mockResolvedValue(settledResult(worktreePath));
    mockAddUnboundCandidate.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(hookFn(baseInput, { logger: mockLogger as unknown as Logger })).rejects.toThrow('EACCES');
  });
});

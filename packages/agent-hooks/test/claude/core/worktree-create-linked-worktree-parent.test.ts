/**
 * Reproduction test: card-bound WorktreeCreate invoked from inside a *linked*
 * git worktree must not record the worktree's own throwaway branch as the
 * card's parentBranch.
 *
 * Unlike worktree-create.test.ts, this test does NOT mock node:child_process —
 * it builds a real temp git repo on `main`, adds a linked worktree on branch
 * `subagent-start-hook` (forked from main), and invokes the real hook with
 * `input.cwd` pointing at the linked worktree. The API/extension boundaries
 * (client discovery, createWorktreeForCard, resolveExtensionPath) are mocked so
 * the only real git interaction is the hook's own parent-branch derivation.
 *
 * Expected behavior: parentBranch === 'main' (the branch the worktree was
 * forked from, per the resolveCardsParentBranch discipline). Current behavior:
 * resolveCurrentBranch returns `git rev-parse --abbrev-ref HEAD` verbatim, so
 * parentBranch === 'subagent-start-hook' and this test fails.
 *
 * @summary Linked-worktree parentBranch derivation reproduction
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { CardsClient } from '@cards.management/sdk/client';
import type { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

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

vi.mock('@cards.management/sdk/adhoc-attribution', () => ({
  resolveWorktreeCardId: vi.fn()
}));

import { resolveExtensionPath } from '@cards.management/sdk';
import { resolveWorktreeCardId } from '@cards.management/sdk/adhoc-attribution';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { createWorktreeForCard } from '@cards.management/sdk/worktree-for-card';
import hookFn from '../../../src/claude/core/worktree-create.js';

/** A non-null fake client; the hook only checks for null. */
const fakeClient = {} as unknown as CardsClient;

/**
 * Runs git with the given args in `cwd`.
 *
 * @param cwd - Directory to run git in.
 * @param args - Git arguments.
 * @returns Trimmed stdout.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
  return stdout.trim();
}

describe('WorktreeCreate parentBranch derivation from a linked worktree (card-bound)', () => {
  const originalEnv = process.env;
  let tempRoot: string;
  let mainRepo: string;
  let linkedWorktree: string;
  const mockLogger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };

  beforeEach(async () => {
    process.env = { ...originalEnv };
    vi.mocked(createWorktreeForCard).mockReset();
    vi.mocked(createCardsClient).mockReset();
    vi.mocked(resolveWorktreeCardId).mockReset();
    vi.mocked(resolveExtensionPath).mockReset();
    vi.mocked(createCardsClient).mockResolvedValue(fakeClient);
    vi.mocked(resolveWorktreeCardId).mockResolvedValue(null);
    vi.mocked(resolveExtensionPath).mockResolvedValue('/ext/install');

    tempRoot = await mkdtemp(path.join(tmpdir(), 'wtc-parent-branch-'));
    mainRepo = path.join(tempRoot, 'repo');
    linkedWorktree = path.join(tempRoot, 'linked');

    // Main working tree on `main` with one commit.
    await execFileAsync('git', ['init', '-b', 'main', mainRepo]);
    await writeFile(path.join(mainRepo, 'README.md'), 'hello\n');
    await git(mainRepo, 'add', '.');
    await git(mainRepo, 'commit', '-m', 'initial');

    // Linked worktree forked from main onto its own throwaway branch.
    await git(mainRepo, 'worktree', 'add', '-b', 'subagent-start-hook', linkedWorktree, 'main');
  });

  afterEach(async () => {
    process.env = originalEnv;
    // maxRetries: git worktree children can hold a transient handle on the temp
    // tree on Windows, racing the recursive rmdir into EBUSY; Node retries on the
    // EBUSY/EPERM/ENOTEMPTY class until released.
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('records the branch the linked worktree was forked from (main), not the worktree’s own branch', async () => {
    process.env['CARD_ID'] = 'main-188';
    const worktreePath = path.join(tempRoot, 'new-card-worktree');
    vi.mocked(createWorktreeForCard).mockResolvedValue({
      registrationRevision: 'test-registration',
      path: worktreePath,
      settle: Promise.resolve({
        branch: 'cards/main-188/1',
        worktree: worktreePath,
        baseSha: 'abc123',
        copiedFromInclude: 0,
        reroutedSymlinks: 0
      })
    });

    await hookFn(
      {
        session_id: 'test-session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: linkedWorktree,
        hook_event_name: 'WorktreeCreate' as const,
        name: 'cards/main-188/1'
      },
      { logger: mockLogger as unknown as Logger }
    );

    expect(vi.mocked(createWorktreeForCard)).toHaveBeenCalledOnce();
    const options = vi.mocked(createWorktreeForCard).mock.calls[0]?.[2] as { parentBranch: string };
    // The linked worktree's HEAD is `subagent-start-hook`, but the card's
    // lineage parent is the branch it was forked from.
    expect(options.parentBranch).toBe('main');
  });
});

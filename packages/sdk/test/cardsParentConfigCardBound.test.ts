/**
 * Reproduction test for the missing durable parent-branch record on the
 * card-bound worktree-creation path.
 *
 * The unbound WorktreeCreate path writes `branch.<name>.cardsParent` git
 * config via writeCardsParentConfig so resolveCardsParentBranch can recover
 * the parent later. The card-bound path (createWorktreeForCard) is expected
 * to leave the same durable record, but currently never writes it — so a
 * card created from inside such a worktree falls back to the fragile reflog
 * decoration and can record the worktree's own branch as its base branch.
 *
 * No mocks of git or the filesystem — real repo, real worktree — only the
 * CardsClient is a plain in-memory fake.
 *
 * @summary card-bound worktree must carry a branch.<name>.cardsParent record
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardsClient } from '../src/client/cardsClient.js';
import { createWorktreeForCard } from '../src/worktreeForCard.js';

const CARDS_WORKTREES_DIR_KEY = 'CARDS_WORKTREES_DIR';

/**
 * Initialises a minimal git repo at `dir` on branch `main` with one commit.
 *
 * @param dir - Absolute path to the directory to initialise.
 */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('createWorktreeForCard parent-branch durability', () => {
  let tmpBase = '';
  let repoDir = '';
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cpb-test-')));
    repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    const homeDir = path.join(tmpBase, 'home');
    const cardsHome = path.join(tmpBase, 'cards-home');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    await fs.mkdir(homeDir);
    await fs.mkdir(cardsHome);
    initGitRepo(repoDir);
    // Redirect every global side-channel (shared hooks dir, bind locks,
    // worktrees root) into the temp sandbox.
    process.env = {
      ...originalEnv,
      [CARDS_WORKTREES_DIR_KEY]: worktreesDir,
      HOME: homeDir,
      CARDS_HOME: cardsHome
    };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tmpBase) {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it('writes branch.<name>.cardsParent in the new worktree so resolution never depends on the reflog', async () => {
    // Dummy compiled hook payloads — provisionSharedHooksDir reads them.
    const hooksSrcDir = path.join(tmpBase, 'compiled-hooks');
    await fs.mkdir(hooksSrcDir);
    const compiledScriptPaths: Record<string, string> = {};
    for (const hook of ['pre-commit', 'post-commit', 'post-rewrite']) {
      const p = path.join(hooksSrcDir, `${hook}.mjs`);
      await fs.writeFile(p, '// noop\n');
      compiledScriptPaths[hook] = p;
    }

    // In-memory CardsClient fake — only addBranch is exercised.
    const addBranchCalls: unknown[] = [];
    const client = {
      addBranch: async (...args: unknown[]) => {
        addBranchCalls.push(args);
        return { outcome: 'created', revision: 'test-revision' };
      }
    } as unknown as CardsClient;

    const newBranch = 'cards/test-1/1';
    const result = await createWorktreeForCard(client, newBranch, {
      cwd: repoDir,
      cardId: 'test-1',
      compiledScriptPaths,
      parentBranch: 'main',
      registrationIntent: 'create'
    });
    await result.settle;

    // The card-bound path knows the parent branch ('main', passed above) at
    // creation time, and the durable record resolveCardsParentBranch consults
    // first is `branch.<newBranch>.cardsParent`. It must be present in the
    // new worktree, exactly as the unbound path leaves it.
    const cardsParent = execFileSync('git', ['config', `branch.${newBranch}.cardsParent`], {
      cwd: result.path,
      encoding: 'utf8'
    }).trim();
    expect(cardsParent).toBe('main');
    expect(addBranchCalls.length).toBe(1);
  });
});

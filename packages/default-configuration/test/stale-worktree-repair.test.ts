/**
 * Reproduces a bug where `createWorktree` fails when a stale directory
 * already exists at the expected worktree path on disk, even though
 * git does not track it as a worktree.
 *
 * A previous session may crash and leave behind a directory (e.g.
 * containing only a `.keep` file) at `.worktrees/cards/<id>/<slot>`.
 * Because git's `worktree add` cannot create into a non-empty directory,
 * the call fails with an error rather than cleaning up the stale remnant
 * and retrying.
 *
 * @summary Regression test for stale worktree directory blocking createWorktree
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateRepoId } from '@cards.management/sdk';
import { createWorktree } from '@cards.management/sdk/worktree';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('stale worktree directory repair', () => {
  let workspace: TestGitWorkspace;

  beforeAll(async () => {
    workspace = new TestGitWorkspace();
    await workspace.create();
    process.env['CARDS_WORKTREES_DIR'] = path.join(workspace.getPath(), '.worktrees');
  });

  afterAll(() => {
    delete process.env['CARDS_WORKTREES_DIR'];
    if (workspace) {
      workspace.destroy();
    }
  });

  it('succeeds when a stale directory with a .keep file exists at the worktree path', async () => {
    const repoRoot = workspace.getPath();
    const branchName = 'feature/test-card';
    const staleDir = path.join(repoRoot, '.worktrees', generateRepoId(repoRoot), branchName);

    // Simulate a crashed previous session that left a stale directory
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(path.join(staleDir, '.keep'), '');

    // createWorktree should handle the stale directory and succeed.
    // Currently this fails because `git worktree add` cannot create
    // into a non-empty directory.
    const result = await createWorktree(branchName, { cwd: repoRoot });

    expect(result.path).toBe(staleDir);
    const settled = await result.settle;
    expect(settled.branch).toBe(branchName);
    expect(settled.worktree).toBe(staleDir);

    // Verify the worktree was properly created
    const stat = await fs.stat(settled.worktree);
    expect(stat.isDirectory()).toBe(true);

    // Verify a .git file exists (marker for a valid worktree checkout)
    const gitMarker = path.join(settled.worktree, '.git');
    const gitStat = await fs.stat(gitMarker);
    expect(gitStat.isFile() || gitStat.isDirectory()).toBe(true);
  });
});

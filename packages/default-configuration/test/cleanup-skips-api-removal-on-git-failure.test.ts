/**
 * Tests for cleanupMergedBranches cleanup step ordering.
 *
 * After the "Branch deleted fix" (cbc496fd2), branch record removal only runs
 * when `git branch -d` succeeds. If the local branch still exists, the record
 * is preserved to keep local and card repo state in sync. Worktree removal
 * and branch deletion failures are logged but do not abort the sweep for
 * other branches.
 *
 * @summary Tests for cleanupMergedBranches cleanup step ordering
 */

import * as fsSyncNs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cross-spawn', async () => {
  // spawnAgentCli routes the agent launch through cross-spawn; forward it to the
  // mocked node:child_process.spawn so existing spawn('claude'/'codex', ...)
  // assertions hold on every platform (cross-spawn would otherwise rewrite the
  // call into a cmd.exe invocation on win32 and bypass the node:child_process mock).
  const cp = await import('node:child_process');
  return { default: cp.spawn };
});
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn()
}));

vi.mock('@cards.management/sdk/worktree', () => ({
  createWorktree: vi.fn(),
  checkWorktreeExists: vi.fn(),
  findGitRoots: vi.fn()
}));

vi.mock('@cards.management/sdk/client/discovery', () => ({
  createCardsClient: async () => ({
    getBranches: async () => ({ branches: [{ name: 'cards/card-123/1', revision: 'free' }] }),
    updateBranchOwner: async () => ({ outcome: 'applied', revision: 'claimed' }),
    removeBranch: async (_card: string, name: string) => {
      fsSyncNs.unlinkSync(path.join(tempCardRepo, 'branches', `${encodeURIComponent(name)}.json`));
      return { outcome: 'removed' };
    }
  })
}));

let tempCardRepo: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempCardRepo = fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-order-test-'));

  // A readable, non-active status lets the sweep past the fail-closed status guard.
  fsSyncNs.writeFileSync(path.join(tempCardRepo, 'CARD.meta.json'), JSON.stringify({ status: 'needs_review' }));

  // Enable discovery test mode so createCardsClient() returns a client without
  // a real cards-api.json file on disk.
  process.env['API_TEST_MODE'] = '1';
});

afterEach(() => {
  fsSyncNs.rmSync(tempCardRepo, { recursive: true, force: true });
  delete process.env['API_TEST_MODE'];
});

function createMockLogger(): ActionContext['logger'] {
  return new Logger();
}

function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    executionId: 'execution-test',
    worktreeDirective: { kind: 'reuse' },
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    repoRoot: '/test/workspace',
    cardRepoPath: tempCardRepo,
    configPath: '/test/config',
    extensionPath: '/test/extension',
    ...overrides
  };
}

function writeBranchesJson(
  branches: Record<string, { worktree?: string; parentBranch: string; addedAt: string }>
): void {
  const branchesDir = path.join(tempCardRepo, 'branches');
  fsSyncNs.mkdirSync(branchesDir, { recursive: true });
  for (const [name, data] of Object.entries(branches)) {
    fsSyncNs.writeFileSync(
      path.join(branchesDir, `${encodeURIComponent(name)}.json`),
      `${JSON.stringify({ name, ...data }, null, 2)}\n`
    );
  }
}

function branchEntryExists(name: string): boolean {
  return fsSyncNs.existsSync(path.join(tempCardRepo, 'branches', `${encodeURIComponent(name)}.json`));
}

describe('cleanupMergedBranches — cleanup steps run independently', () => {
  it('skips branch record removal when git branch -d fails', async () => {
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { execFile } = await import('node:child_process');

    writeBranchesJson({
      'cards/card-123/1': {
        worktree: '/test/workspace/.worktrees/cards/card-123/1',
        parentBranch: 'main',
        addedAt: '2025-01-01T00:00:00Z'
      }
    });

    // merge-base succeeds (branch is merged), worktree remove succeeds,
    // but git branch -d FAILS
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      const key = `${cmd} ${cmdArgs.join(' ')}`;

      if (typeof cb === 'function') {
        if (key.includes('branch --list')) {
          cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
        } else if (key.includes('merge-base --is-ancestor')) {
          cb(null, { stdout: '', stderr: '' }); // merged
        } else if (key.includes('worktree remove')) {
          cb(null, { stdout: '', stderr: '' }); // worktree removal succeeds
        } else if (key.includes('branch') && key.includes('-d')) {
          cb(new Error('error: branch is not fully merged')); // git branch -d FAILS
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    await cleanupMergedBranches(baseInput(), tempCardRepo, createMockLogger());

    // The branch entry file should still be present
    expect(branchEntryExists('cards/card-123/1')).toBe(true);
  });

  it('skips branch record removal when both worktree remove and branch -d fail', async () => {
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { execFile } = await import('node:child_process');

    writeBranchesJson({
      'cards/card-123/1': {
        worktree: '/test/workspace/.worktrees/cards/card-123/1',
        parentBranch: 'main',
        addedAt: '2025-01-01T00:00:00Z'
      }
    });

    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      const key = `${cmd} ${cmdArgs.join(' ')}`;

      if (typeof cb === 'function') {
        if (key.includes('branch --list')) {
          cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
        } else if (key.includes('merge-base --is-ancestor')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (key.includes('worktree remove')) {
          cb(new Error('cannot remove worktree: still checked out'));
        } else if (key.includes('branch') && key.includes('-d')) {
          cb(new Error('error: branch is not fully merged'));
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    await cleanupMergedBranches(baseInput(), tempCardRepo, createMockLogger());

    // The branch entry file should still be present
    expect(branchEntryExists('cards/card-123/1')).toBe(true);
  });

  it('removes branch record when git branch -d succeeds', async () => {
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { execFile } = await import('node:child_process');

    writeBranchesJson({
      'cards/card-123/1': {
        worktree: '/test/workspace/.worktrees/cards/card-123/1',
        parentBranch: 'main',
        addedAt: '2025-01-01T00:00:00Z'
      }
    });

    // Everything succeeds
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      const key = `${cmd} ${cmdArgs.join(' ')}`;

      if (typeof cb === 'function') {
        if (key.includes('branch --list')) {
          cb(null, { stdout: '  cards/card-123/1\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    await cleanupMergedBranches(baseInput(), tempCardRepo, createMockLogger());

    // The branch entry file should have been removed
    expect(branchEntryExists('cards/card-123/1')).toBe(false);
  });
});

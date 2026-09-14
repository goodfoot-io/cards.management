import * as fsSyncNs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reproduction tests for the self-referential parentBranch bug.
 *
 * When `parentBranch` equals the branch name itself (e.g., `cards/main-25/1`
 * with parentBranch `cards/main-25/1`), `cleanupMergedBranches` incorrectly
 * treats the branch as merged because `git merge-base --is-ancestor X X`
 * always succeeds — a branch is trivially an ancestor of itself.
 *
 * This causes worktrees and branch records to be removed for branches with
 * unmerged work.
 *
 * @summary Reproduction tests for self-referential parentBranch bug
 */

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
    removeBranch: async () => ({ outcome: 'removed' })
  })
}));

let tempCardRepo: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempCardRepo = fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'self-ref-test-'));

  // A readable, non-active status lets the sweep proceed past the fail-closed
  // status guard so these tests exercise the per-branch loop.
  fsSyncNs.writeFileSync(path.join(tempCardRepo, 'CARD.meta.json'), JSON.stringify({ status: 'needs_review' }));

  // Enable discovery test mode so createCardsClient() returns a client without
  // a real cards-api.json file on disk.
  process.env['API_TEST_MODE'] = '1';

  const { execFile } = await import('node:child_process');
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      cb(new Error('mock: unhandled command'));
    }
    return {} as ReturnType<typeof execFile>;
  });
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
      JSON.stringify({ name, ...data }, null, 2)
    );
  }
}

describe('cleanupMergedBranches — self-referential parentBranch bug', () => {
  it('records an error outcome for a self-referential parentBranch instead of throwing', async () => {
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { execFile } = await import('node:child_process');

    writeBranchesJson({
      'cards/main-25/1': {
        worktree: '/test/workspace/.worktrees/cards/main-25/1',
        parentBranch: 'cards/main-25/1',
        addedAt: '2025-01-01T00:00:00Z'
      }
    });

    // git branch --list returns the branch (it exists)
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      const cmdArgs = args[1] as string[];

      if (typeof cb === 'function') {
        if (cmdArgs?.includes('--list')) {
          cb(null, { stdout: '  cards/main-25/1\n', stderr: '' });
        } else {
          cb(new Error('mock: unhandled command'));
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const outcomes = await cleanupMergedBranches(baseInput(), tempCardRepo, createMockLogger());

    // The corrupt branch is refused (error) but the call never throws — a single
    // bad branch must not abort the sweep or discard sibling outcomes.
    expect(outcomes).toEqual([
      { cardId: 'card-123', branch: 'cards/main-25/1', action: 'error', reason: 'self-referential-parent' }
    ]);
    // merge-base is never attempted against the self-referential branch.
    const mergeBaseCalled = vi.mocked(execFile).mock.calls.some((c) => (c[1] as string[])?.includes('merge-base'));
    expect(mergeBaseCalled).toBe(false);
  });

  it('cleans a valid merged sibling while recording the corrupt branch as an error (both outcomes preserved)', async () => {
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { execFile } = await import('node:child_process');

    writeBranchesJson({
      'cards/card-123/1': {
        worktree: '/test/workspace/.worktrees/cards/card-123/1',
        parentBranch: 'main',
        addedAt: '2025-01-01T00:00:00Z'
      },
      'cards/card-456/1': {
        worktree: '/test/workspace/.worktrees/cards/card-456/1',
        parentBranch: 'cards/card-456/1',
        addedAt: '2025-01-01T00:00:00Z'
      }
    });

    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      const cmdArgs = args[1] as string[];

      if (typeof cb === 'function') {
        if (cmdArgs?.includes('--list')) {
          // Both branches exist
          const branchName = cmdArgs[cmdArgs.length - 1];
          cb(null, { stdout: `  ${branchName}\n`, stderr: '' });
        } else {
          // Valid branch: merged into main (merge-base succeeds), plus all
          // downstream removal steps succeed so it is fully cleaned.
          cb(null, { stdout: '', stderr: '' });
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const outcomes = await cleanupMergedBranches(baseInput(), tempCardRepo, createMockLogger());

    expect(outcomes).toContainEqual(
      expect.objectContaining({ branch: 'cards/card-123/1', action: 'cleaned', reason: 'merged' })
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({ branch: 'cards/card-456/1', action: 'error', reason: 'self-referential-parent' })
    );
    // The cleaned outcome is not lost behind the corrupt branch's error.
    expect(outcomes.filter((o) => o.action === 'cleaned')).toHaveLength(1);
  });
});

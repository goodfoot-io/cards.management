import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as fsSyncNs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Faithful reproduction of the sibling-action cleanup coupling bug.
 *
 * `cleanupMergedBranches` runs per-card, not per-action: when any interactive
 * action exits it loops over *every* branch record in the card repo. A sibling
 * action's branch with zero commits beyond its parent is trivially an ancestor
 * (`git merge-base --is-ancestor` succeeds), so it is classed "merged". The
 * function then calls `killProcessesInDirectory(worktree)` — scanning `/proc`
 * for any pid whose cwd is inside the worktree and SIGTERM/SIGKILLing it — and
 * `git worktree remove --force`, destroying the still-running sibling.
 *
 * This test uses a real temp git repo, real worktrees, a real long-lived child
 * process, and the real `/proc` scan (Linux). No mocking of `node:child_process`
 * or `node:fs`. The desired post-fix assertions (sibling survives) FAIL against
 * current code; the genuinely-finished-branch assertion documents behavior to
 * preserve.
 *
 * Linux-only: the liveness gate that protects the sibling relies on
 * `findProcessesInDirectory`, which scans `/proc` and returns empty on any
 * non-Linux platform (see `claude-session.ts`). On macOS/Windows the protection
 * cannot engage and the test's `/proc/<pid>/cwd` setup probe does not exist, so
 * the case is skipped off Linux rather than failing spuriously.
 *
 * @summary Reproduction: closing one action's terminal must not end a sibling.
 */

vi.mock('@cards.management/sdk/client/discovery', () => ({
  createCardsClient: async () => ({
    getBranches: async () => ({
      branches: fsSyncNs
        .readdirSync(path.join(cardRepo, 'branches'))
        .map((file) => JSON.parse(fsSyncNs.readFileSync(path.join(cardRepo, 'branches', file), 'utf8')))
    }),
    updateBranchOwner: async (
      _card: string,
      name: string,
      request: { expectedRevision: string; replacementOwner: string }
    ) => {
      const file = path.join(cardRepo, 'branches', `${encodeURIComponent(name)}.json`);
      const record = JSON.parse(fsSyncNs.readFileSync(file, 'utf8'));
      if (record.revision !== request.expectedRevision || record.activeExecutionOwner)
        return { outcome: 'owner_conflict' };
      record.activeExecutionOwner = request.replacementOwner;
      record.revision += '-claimed';
      fsSyncNs.writeFileSync(file, JSON.stringify(record));
      return { outcome: 'applied', revision: record.revision };
    },
    removeBranch: async (
      _card: string,
      name: string,
      request: { expectedRevision: string; expectedCleanupOwner: string }
    ) => {
      const file = path.join(cardRepo, 'branches', `${encodeURIComponent(name)}.json`);
      const record = JSON.parse(fsSyncNs.readFileSync(file, 'utf8'));
      if (record.revision !== request.expectedRevision || record.activeExecutionOwner !== request.expectedCleanupOwner)
        return { outcome: 'preserved' };
      fsSyncNs.unlinkSync(file);
      return { outcome: 'removed' };
    }
  })
}));

let wsRepo: string;
let cardRepo: string;
let sibling: ChildProcess | undefined;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function configUser(cwd: string): void {
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
}

function createMockLogger(): ActionContext['logger'] {
  return new Logger();
}

function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    executionId: 'test-execution',
    worktreeDirective: { kind: 'reuse' },
    cardId: 'test',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    repoRoot: wsRepo,
    cardRepoPath: cardRepo,
    configPath: '/test/config',
    extensionPath: '/test/extension',
    ...overrides
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  // Resolve realpath so the /proc cwd comparison matches (on some systems
  // /tmp is a symlink to /private/tmp etc).
  wsRepo = fsSyncNs.realpathSync(fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'sibling-ws-')));
  cardRepo = fsSyncNs.realpathSync(fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'sibling-card-')));

  // Workspace repo with an initial commit on main.
  git(wsRepo, ['init', '-b', 'main']);
  configUser(wsRepo);
  fsSyncNs.writeFileSync(path.join(wsRepo, 'README.md'), '# workspace\n');
  git(wsRepo, ['add', 'README.md']);
  git(wsRepo, ['commit', '-m', 'initial commit']);

  // Two action worktrees branched from main at zero commits beyond main.
  const wt1 = path.join(wsRepo, '.worktrees', '1');
  const wt2 = path.join(wsRepo, '.worktrees', '2');
  git(wsRepo, ['worktree', 'add', wt1, '-b', 'cards/test/1', 'main']);
  git(wsRepo, ['worktree', 'add', wt2, '-b', 'cards/test/2', 'main']);

  // Card repo holding the per-branch records the cleanup function reads.
  git(cardRepo, ['init', '-b', 'main']);
  configUser(cardRepo);
  // A readable, non-active status lets the sweep past the fail-closed status guard.
  fsSyncNs.writeFileSync(path.join(cardRepo, 'CARD.meta.json'), JSON.stringify({ status: 'needs_review' }));
  const branchesDir = path.join(cardRepo, 'branches');
  fsSyncNs.mkdirSync(branchesDir, { recursive: true });

  const writeRecord = (name: string, worktree: string): void => {
    fsSyncNs.writeFileSync(
      path.join(branchesDir, `${encodeURIComponent(name)}.json`),
      JSON.stringify(
        {
          name,
          revision: 'initial',
          worktree: fsSyncNs.realpathSync(worktree),
          parentBranch: 'main',
          addedAt: '2026-01-01T00:00:00Z'
        },
        null,
        2
      )
    );
  };
  writeRecord('cards/test/1', wt1);
  writeRecord('cards/test/2', wt2);
  git(cardRepo, ['add', 'branches']);
  git(cardRepo, ['commit', '-m', 'track branches']);
});

afterEach(() => {
  if (sibling?.pid) {
    try {
      process.kill(sibling.pid, 'SIGKILL');
    } catch (error) {
      // ESRCH means the process already exited (the bug under test kills it) — anything else is unexpected.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  sibling = undefined;
  fsSyncNs.rmSync(wsRepo, { recursive: true, force: true });
  fsSyncNs.rmSync(cardRepo, { recursive: true, force: true });
});

describe('cleanupMergedBranches — sibling-action isolation', () => {
  it.skipIf(process.platform !== 'linux')(
    'must not kill or reclaim a sibling action whose worktree hosts a live process',
    async () => {
      const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');

      const wt1 = fsSyncNs.realpathSync(path.join(wsRepo, '.worktrees', '1'));
      const wt2Path = path.join(wsRepo, '.worktrees', '2');

      // The "sibling agent": a long-lived process rooted inside worktree 1.
      sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], {
        cwd: wt1,
        stdio: 'ignore'
      });
      const pid = sibling.pid;
      if (pid === undefined) throw new Error('failed to spawn sibling process');

      // Give /proc/<pid>/cwd a moment to settle, then verify it points into wt1.
      await delay(100);
      const procCwd = fsSyncNs.readlinkSync(`/proc/${pid}/cwd`);
      if (procCwd !== wt1 && !procCwd.startsWith(`${wt1}/`)) {
        throw new Error(`setup failure: /proc/${pid}/cwd is ${procCwd}, expected inside ${wt1}`);
      }

      // Worktree 2 has no live process — it is the genuinely-finished branch.

      await cleanupMergedBranches(baseInput(), cardRepo, createMockLogger(), undefined, { backoffMaxMs: 2000 });

      // DESIRED post-fix behavior — these assertions FAIL on current code.
      // Sibling process must still be alive (kill(pid, 0) probes existence).
      expect(() => process.kill(pid, 0)).not.toThrow();
      // Sibling worktree directory must still exist.
      expect(fsSyncNs.existsSync(wt1)).toBe(true);
      // Sibling branch must still exist.
      expect(execFileSync('git', ['branch', '--list', 'cards/test/1'], { cwd: wsRepo }).toString().trim()).not.toBe('');

      // Behavior to PRESERVE — the genuinely-finished branch IS cleaned up
      // (this should currently PASS; it guards against over-correction).
      expect(fsSyncNs.existsSync(wt2Path)).toBe(false);
      expect(execFileSync('git', ['branch', '--list', 'cards/test/2'], { cwd: wsRepo }).toString().trim()).toBe('');
    }
  );
});

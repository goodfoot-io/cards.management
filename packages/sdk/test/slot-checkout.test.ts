/**
 * Slot checkout provisioning against a real `git worktree add` checkout:
 * card binding (marker, shared hooks path, excludes, parent branch) and the
 * fence checkpoint that stops provisioning between writes.
 * @summary Fresh-slot materialization, card binding and fence checkpoints
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShutdownError } from '../src/config/runtime-shutdown.js';
import { type ProvisionSlotCheckoutOptions, provisionSlotCheckout } from '../src/slot-checkout.js';
import type { WorktreeGitRunner } from '../src/worktree.js';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };

/**
 * Runs git synchronously for fixture setup and inspection.
 * @param cwd - Working directory.
 * @param args - Git arguments.
 * @returns Trimmed standard output.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/**
 * Git runner the provisioning steps use, as the bounded runner would.
 * @param cwd - Working directory for git.
 * @param args - Git arguments.
 * @param input - Optional standard input.
 * @returns Git's standard output.
 */
const runGit: WorktreeGitRunner = (cwd, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

describe('slot checkout provisioning', () => {
  let base: string;
  let repo: string;
  let worktreePath: string;
  let extensionPath: string;
  let sharedHooksDir: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'cards-slot-checkout-')));
    repo = join(base, 'repo');
    worktreePath = join(base, 'slots', '1');
    extensionPath = join(base, 'extension');
    sharedHooksDir = join(base, 'config', 'workspace-hooks');
    await mkdir(repo);
    await mkdir(join(extensionPath, 'dist', 'git-hooks'), { recursive: true });
    for (const hook of ['pre-commit', 'post-commit', 'post-rewrite'])
      await writeFile(join(extensionPath, 'dist', 'git-hooks', `${hook}.mjs`), 'export {};\n');
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'tracked.txt'), 'tracked\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial');
    git(repo, 'worktree', 'add', '-q', '-b', 'slot-1', worktreePath);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /**
   * Provisioning inputs for the fixture slot.
   * @param overrides - Fields to replace.
   * @returns Options binding slot 1 to card main-1 with an open fence.
   */
  function options(overrides: Partial<ProvisionSlotCheckoutOptions> = {}): ProvisionSlotCheckoutOptions {
    return {
      repoRoot: repo,
      sourceRoot: repo,
      cardId: 'main-1',
      parentBranch: 'main',
      branch: 'slot-1',
      worktreePath,
      extensionPath,
      sharedHooksDir,
      runGit,
      checkpoint: () => undefined,
      ...overrides
    };
  }

  it.skip('binds a fresh slot to its card with shared hooks, excludes and the parent branch', async () => {
    const provisioned = await provisionSlotCheckout(options());
    expect(provisioned.branchName).toBe('slot-1');
    expect(provisioned.checkout).toMatchObject({ branch: 'slot-1', worktree: worktreePath });
    expect((await readFile(join(worktreePath, '.cards', 'CARD_ID'), 'utf8')).trim()).toBe('main-1');
    expect(git(worktreePath, 'config', '--worktree', 'core.hooksPath')).toBe(sharedHooksDir);
    expect(git(worktreePath, 'config', 'branch.slot-1.cardsParent')).toBe('main');
    expect(existsSync(join(sharedHooksDir, 'pre-commit'))).toBe(true);
    expect(git(worktreePath, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it.skip('points the shared dispatchers at the extension’s compiled hook scripts', async () => {
    await provisionSlotCheckout(options());
    expect(await readFile(join(sharedHooksDir, 'pre-commit'), 'utf8')).toContain(
      join(extensionPath, 'dist', 'git-hooks', 'pre-commit.mjs')
    );
  });

  it.skip('writes nothing once the fence is already closed', async () => {
    let gitCalls = 0;
    await expect(
      provisionSlotCheckout(
        options({
          runGit: (cwd, args, input) => {
            gitCalls++;
            return runGit(cwd, args, input);
          },
          checkpoint: () => {
            throw new ShutdownError('fence closed');
          }
        })
      )
    ).rejects.toThrow(ShutdownError);
    expect(gitCalls).toBe(0);
    expect(existsSync(join(worktreePath, '.cards', 'CARD_ID'))).toBe(false);
    expect(() => git(worktreePath, 'config', 'branch.slot-1.cardsParent')).toThrow();
  });

  it.skip('stops before card binding once the fence closes during materialization, running no further git', async () => {
    let closed = false;
    let gitAfterClose = 0;
    const provisioning = provisionSlotCheckout(
      options({
        runGit: (cwd, args, input) => {
          if (closed) gitAfterClose++;
          closed = true;
          return runGit(cwd, args, input);
        },
        checkpoint: () => {
          if (closed) throw new ShutdownError('fence closed');
        }
      })
    );
    await expect(provisioning).rejects.toThrow(ShutdownError);
    expect(gitAfterClose).toBe(0);
    expect(existsSync(join(worktreePath, '.cards', 'CARD_ID'))).toBe(false);
    expect(() => git(worktreePath, 'config', 'branch.slot-1.cardsParent')).toThrow();
  });
});

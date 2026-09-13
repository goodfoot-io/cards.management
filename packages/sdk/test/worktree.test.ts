/**
 * Integration tests for the removeWorktree SDK helper, the per-entry symlink
 * provisioning of `.cards/bin` and `.cards/www`, and the end-to-end
 * `.worktreeignore`/`.worktreeinclude` path policy through createWorktree.
 *
 * Each test creates a real git worktree via createWorktree, then exercises
 * removeWorktree, the static-subtree provisioning, or the path-policy
 * isolation outcomes against it. Real git operations, real filesystem. The one
 * exception is the symlink-privilege propagation test, which routes
 * `fs.symlink` through a controllable override so the Windows EPERM/EINVAL
 * denial — unreproducible on Linux — can be simulated at the OS boundary; the
 * override delegates to the real implementation for every other test.
 *
 * @summary removeWorktree, static-subtree provisioning, and path-policy integration tests
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorktreesRoot } from '../src/cards-config.js';
import { Logger } from '../src/config/logger.js';
import {
  cleanupFailedWorktree,
  createWorktree,
  provisionStaticCardsSubtree,
  removeWorktree,
  SymlinkPrivilegeError,
  WorktreeScopeError
} from '../src/worktree.js';
import { WorktreeIncludeError } from '../src/worktreeInclude.js';

// `fs.symlink` on the node:fs/promises namespace is non-configurable in ESM, so
// it cannot be spied via vi.spyOn (same limitation as execFileSync). To simulate
// the Windows symlink-privilege denial that drives SymlinkPrivilegeError, route
// symlink through a controllable override that delegates to the real
// implementation by default and only fails when a test sets symlinkOverride.
let symlinkOverride: ((target: string, linkPath: string) => Promise<void>) | undefined;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    symlink: (target: string, linkPath: string, type?: string | null) =>
      symlinkOverride ? symlinkOverride(target, linkPath) : actual.symlink(target, linkPath, type)
  };
});

const CARDS_WORKTREES_DIR_KEY = 'CARDS_WORKTREES_DIR';

/**
 * Initialises a minimal git repo at `dir` with a commit so worktree operations work.
 *
 * @param dir - Absolute path to the directory to initialise.
 */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

/**
 * Writes a `.gitignore` and commits it, so the ignore rules are part of the
 * repo state before worktree creation discovers ignored paths.
 *
 * @param repoDir - Repository root to write into.
 * @param contents - `.gitignore` file contents.
 */
function commitGitignore(repoDir: string, contents: string): void {
  writeFileSync(path.join(repoDir, '.gitignore'), contents);
  execFileSync('git', ['add', '.gitignore'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'add gitignore'], { cwd: repoDir });
}

/**
 * Returns the list of worktree paths from `git worktree list --porcelain`.
 *
 * @param repoDir - Repository root to query.
 * @returns Array of absolute worktree paths.
 */
function listWorktrees(repoDir: string): string[] {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoDir,
    encoding: 'utf8'
  });
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

describe('removeWorktree', () => {
  let tmpBase = '';
  let repoDir = '';
  let worktreesDir = '';
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-test-')));
    repoDir = path.join(tmpBase, 'repo');
    worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);
    process.env = { ...originalEnv, [CARDS_WORKTREES_DIR_KEY]: worktreesDir };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tmpBase) {
      // maxRetries/retryDelay: on Windows a git subprocess can briefly hold a
      // handle into tmpBase (.git admin files), so rmdir races EBUSY/EPERM —
      // retry past the transient lock, mirroring removeWorktree() in worktree.ts.
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it('removes a worktree created by createWorktree end-to-end; directory is gone afterwards', async () => {
    const { path: wPath, settle } = await createWorktree('feature/remove-test', { cwd: repoDir });
    await settle;

    await removeWorktree(wPath);

    await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const worktrees = listWorktrees(repoDir);
    expect(worktrees.every((w) => w !== wPath)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'waits for git worktree remove when removal takes longer than 30 seconds',
    async () => {
      const { path: wPath, settle } = await createWorktree('feature/slow-remove-test', { cwd: repoDir });
      await settle;

      const shimDir = path.join(tmpBase, 'git-shim');
      const shimPath = path.join(shimDir, 'git');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      await fs.mkdir(shimDir);
      await fs.writeFile(
        shimPath,
        `#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then sleep 31; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );

      process.env['PATH'] = `${shimDir}${path.delimiter}${originalEnv['PATH'] ?? ''}`;
      try {
        await removeWorktree(wPath);
      } finally {
        process.env['PATH'] = originalEnv['PATH'];
      }

      await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(listWorktrees(repoDir)).not.toContain(wPath);
    },
    40_000
  );

  it('is idempotent when worktree directory is already gone', async () => {
    const { path: wPath, settle } = await createWorktree('feature/idempotent-test', { cwd: repoDir });
    await settle;

    await removeWorktree(wPath);
    await expect(removeWorktree(wPath)).resolves.toBeUndefined();
  });

  it('refuses paths outside resolveWorktreesRoot()', async () => {
    const outsidePath = path.join(tmpBase, 'outside');
    await fs.mkdir(outsidePath);

    await expect(removeWorktree(outsidePath)).rejects.toThrow();
  });

  it('force-removes a worktree containing a .cards copy', async () => {
    const { path: wPath, settle } = await createWorktree('feature/force-test', { cwd: repoDir });
    await settle;

    await fs.mkdir(path.join(wPath, '.cards'), { recursive: true });
    await fs.writeFile(path.join(wPath, '.cards', 'CARD_ID'), 'test-card\n');

    await expect(removeWorktree(wPath)).resolves.toBeUndefined();
    await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies .cards into a new worktree but prunes the entire .cards/logs subtree', async () => {
    // Seed the source repo's .cards with a normal file plus a logs subtree
    // holding a stale log and a non-.log file. The whole subtree is pruned, so
    // neither the directory nor any of its contents reach the worktree.
    await fs.mkdir(path.join(repoDir, '.cards', 'logs'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.cards', 'config.json'), '{"seed":true}\n');
    await fs.writeFile(path.join(repoDir, '.cards', 'logs', 'git-workspace-repo-hooks.log'), '{"stale":true}\n');
    await fs.writeFile(path.join(repoDir, '.cards', 'logs', 'not-a-log.json'), '{"stale":true}\n');

    const { path: wPath, settle } = await createWorktree('feature/log-exclusion', { cwd: repoDir });
    await settle;

    // Non-log, non-marker .cards content is copied.
    await expect(fs.readFile(path.join(wPath, '.cards', 'config.json'), 'utf8')).resolves.toBe('{"seed":true}\n');

    // The logs directory is pruned entirely — neither the directory nor any
    // file under it (stale log or otherwise) is copied.
    await expect(fs.access(path.join(wPath, '.cards', 'logs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('excludes the source .cards/CARD_ID and CARD_ORIGINAL_HOOK_PATH markers from the copy', async () => {
    // A card-bound source checkout carries CARD_ID and CARD_ORIGINAL_HOOK_PATH.
    // Copying them into a child worktree would bleed the source's card identity
    // and original-hooks snapshot in, causing wrong-card attribution and broken
    // hook chaining. Both markers must be excluded; the child's are written
    // authoritatively by outfitWorktreeForCard, never inherited here.
    await fs.mkdir(path.join(repoDir, '.cards'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.cards', 'CARD_ID'), 'source-card\n');
    await fs.writeFile(path.join(repoDir, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), '/source/hooks\n');
    await fs.writeFile(path.join(repoDir, '.cards', 'config.json'), '{"seed":true}\n');

    const { path: wPath, settle } = await createWorktree('feature/marker-exclusion', { cwd: repoDir });
    await settle;

    // Markers are NOT copied.
    await expect(fs.access(path.join(wPath, '.cards', 'CARD_ID'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(wPath, '.cards', 'CARD_ORIGINAL_HOOK_PATH'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // Other .cards content is still copied.
    await expect(fs.readFile(path.join(wPath, '.cards', 'config.json'), 'utf8')).resolves.toBe('{"seed":true}\n');
  });

  it('throws WorktreeScopeError when path equals the worktrees root (not a child)', async () => {
    const root = path.resolve(resolveWorktreesRoot());
    await expect(removeWorktree(root)).rejects.toBeInstanceOf(WorktreeScopeError);
  });

  it('throws WorktreeScopeError when path is a symlink pointing outside the worktrees root', async () => {
    const outsideTarget = path.join(tmpBase, 'outside-target');
    await fs.mkdir(outsideTarget);
    const symlinkPath = path.join(worktreesDir, 'escape');
    await fs.symlink(outsideTarget, symlinkPath);

    await expect(removeWorktree(symlinkPath)).rejects.toBeInstanceOf(WorktreeScopeError);
    // The symlink itself must not have been deleted
    await expect(fs.lstat(symlinkPath)).resolves.toBeDefined();
  });

  it('throws WorktreeScopeError for empty worktreePath', async () => {
    await expect(removeWorktree('')).rejects.toBeInstanceOf(WorktreeScopeError);
  });

  it('Logger constructed from inside a linked worktree resolves log path to main repo root, not the worktree', async () => {
    // Create a linked worktree from the main repo.
    const { path: wPath, settle } = await createWorktree('feature/logger-collapse-test', { cwd: repoDir });
    await settle;

    // Unset all env vars that would short-circuit git resolution.
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of ['REPO_ROOT', 'CARDS_LOG_DIR', 'CARDS_HOOKS_LOG_FILE']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const savedCwd = process.cwd();

    try {
      // Run from inside the linked worktree.
      process.chdir(wPath);

      const logger = new Logger({ subsystem: 'git-workspace-repo-hooks' });
      // hasDestinations() is true only when the path resolved successfully.
      expect(logger.hasDestinations()).toBe(true);

      // Write a message so we can verify the destination file path.
      logger.info('collapse-test');
      logger.close();

      // The log file must be under the MAIN repo root, not the worktree path.
      const expectedLog = path.join(repoDir, '.cards', 'logs', 'git-workspace-repo-hooks.log');
      const content = await fs.readFile(expectedLog, 'utf8');
      expect(content).toContain('collapse-test');

      // Nothing written under the worktree path.
      const worktreeLog = path.join(wPath, '.cards', 'logs', 'git-workspace-repo-hooks.log');
      await expect(fs.access(worktreeLog)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.chdir(savedCwd);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('runs git worktree prune afterwards so the registry stays clean', async () => {
    const { path: wPath, settle } = await createWorktree('feature/prune-test', { cwd: repoDir });
    await settle;

    await removeWorktree(wPath);

    const worktrees = listWorktrees(repoDir);
    expect(worktrees.every((w) => w !== wPath)).toBe(true);
  });

  it('sweeps a residual worktree directory left behind after git worktree remove', async () => {
    const { path: wPath, settle } = await createWorktree('feature/sweep-residual', { cwd: repoDir });
    await settle;

    // Drop an untracked file so a directory remains for the post-git sweep
    // (line 415) to actually delete, proving the sweep path executes.
    await fs.writeFile(path.join(wPath, 'residual.txt'), 'leftover\n');

    await removeWorktree(wPath);

    await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'win32')(
    'retries past a transient lock on a worktree child file (Windows)',
    async () => {
      const { path: wPath, settle } = await createWorktree('feature/transient-lock', { cwd: repoDir });
      await settle;

      const lockedFile = path.join(wPath, 'locked.txt');
      await fs.writeFile(lockedFile, 'held\n');

      // Hold an open handle into the worktree so the sweep's first rm attempts
      // hit a transient EPERM/EBUSY, then release it mid-retry. With
      // maxRetries:10/retryDelay:100 (line 415) the sweep should retry past the
      // lock and resolve; without the retry it rejects on the first attempt.
      const handle = await fs.open(lockedFile, 'r');
      const release = setTimeout(() => {
        void handle.close();
      }, 150);

      // Capture the test outcome so cleanup always runs, then re-throw after —
      // re-throwing inside `finally` would clobber the original control flow.
      let testError: unknown;
      try {
        await removeWorktree(wPath);
        await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } catch (error: unknown) {
        testError = error;
      }

      clearTimeout(release);
      try {
        await handle.close();
      } catch (error: unknown) {
        // The handle is normally already closed by the timer; ignore the
        // resulting "file already closed" rejection so cleanup never masks a
        // real test failure.
        if (!(error instanceof Error) || !/closed/i.test(error.message)) {
          throw error;
        }
      }

      if (testError) {
        throw testError;
      }
    }
  );
});

describe('createWorktree static .cards subtree provisioning', () => {
  let tmpBase = '';
  let repoDir = '';
  let worktreesDir = '';
  const originalEnv = process.env;

  /**
   * Seeds the source repo's `.cards/bin` and `.cards/www` with the static layout
   * the worktree provisioning mirrors: a flat `bin/` of files, and a nested
   * `www/{session}/index.html` two-level tree.
   */
  async function seedStaticSubtrees(): Promise<void> {
    const cardsDir = path.join(repoDir, '.cards');
    await fs.mkdir(path.join(cardsDir, 'bin'), { recursive: true });
    await fs.writeFile(path.join(cardsDir, 'bin', 'cli.mjs'), 'console.log("cli");\n');
    await fs.writeFile(path.join(cardsDir, 'bin', 'helper.mjs'), 'export const x = 1;\n');

    await fs.mkdir(path.join(cardsDir, 'www', 'claude-code-session'), { recursive: true });
    await fs.mkdir(path.join(cardsDir, 'www', 'codex-session'), { recursive: true });
    await fs.writeFile(path.join(cardsDir, 'www', 'claude-code-session', 'index.html'), '<html>claude</html>\n');
    await fs.writeFile(path.join(cardsDir, 'www', 'codex-session', 'index.html'), '<html>codex</html>\n');

    // A mutable, non-static .cards file that must remain a real copied file.
    await fs.writeFile(path.join(cardsDir, 'settings.json'), '{"seed":true}\n');
  }

  beforeEach(async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wt-static-')));
    repoDir = path.join(tmpBase, 'repo');
    worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);
    process.env = { ...originalEnv, [CARDS_WORKTREES_DIR_KEY]: worktreesDir };
  });

  afterEach(async () => {
    symlinkOverride = undefined;
    process.env = originalEnv;
    if (tmpBase) {
      // maxRetries/retryDelay: on Windows a git subprocess can briefly hold a
      // handle into tmpBase (.git admin files), so rmdir races EBUSY/EPERM —
      // retry past the transient lock, mirroring removeWorktree() in worktree.ts.
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it('provisions .cards/bin and .cards/www as real directories, not directory symlinks', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-real-dirs', { cwd: repoDir });
    await settle;

    for (const sub of ['bin', 'www']) {
      const stat = await fs.lstat(path.join(wPath, '.cards', sub));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
    }
  });

  it('makes each file inside .cards/bin a symlink to the source file, readable through the link', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-bin-links', { cwd: repoDir });
    await settle;

    const linkPath = path.join(wPath, '.cards', 'bin', 'cli.mjs');
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = await fs.readlink(linkPath);
    expect(path.resolve(target)).toBe(path.join(repoDir, '.cards', 'bin', 'cli.mjs'));

    // Content is readable through the symlink.
    await expect(fs.readFile(linkPath, 'utf8')).resolves.toBe('console.log("cli");\n');
  });

  it('isolates writes into worktree .cards/bin from the source .cards/bin', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-bin-isolation', { cwd: repoDir });
    await settle;

    // Write a brand-new file into the worktree's real bin directory.
    await fs.writeFile(path.join(wPath, '.cards', 'bin', 'stray.mjs'), 'console.log("stray");\n');

    // It must NOT appear in the source subtree.
    await expect(fs.access(path.join(repoDir, '.cards', 'bin', 'stray.mjs'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // It lives in the worktree's own directory.
    await expect(fs.readFile(path.join(wPath, '.cards', 'bin', 'stray.mjs'), 'utf8')).resolves.toBe(
      'console.log("stray");\n'
    );
  });

  it('keeps mutable .cards state (settings.json) a real file, not a symlink', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-mutable-file', { cwd: repoDir });
    await settle;

    const settingsPath = path.join(wPath, '.cards', 'settings.json');
    const stat = await fs.lstat(settingsPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe('{"seed":true}\n');
  });

  it('is idempotent: re-running provisioning replaces symlinks and leaves real files untouched', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-idempotent', { cwd: repoDir });
    await settle;

    const sourceBin = path.join(repoDir, '.cards', 'bin');
    const destBin = path.join(wPath, '.cards', 'bin');

    // A real file the worktree added whose name does NOT match any source entry
    // must survive a second pass (replaceSymlink is never called for it).
    const realFile = path.join(destBin, 'real.mjs');
    await fs.writeFile(realFile, 'console.log("real");\n');

    // Remove the cli.mjs symlink and create a real file at the same path, so the
    // destination has a real file whose name DOES match a source entry. This
    // exercises the replaceSymlink non-symlink early-return path: lstat finds a
    // real file, and the function must return without error, leaving it untouched.
    await fs.unlink(path.join(destBin, 'cli.mjs'));
    await fs.writeFile(path.join(destBin, 'cli.mjs'), 'console.log("shadow");\n');

    // Drive a second provisioning pass against the SAME destination directory —
    // exactly what a re-fired WorktreeCreate hook or retried settle does. It must
    // not throw: existing per-entry symlinks are unlinked and recreated by
    // replaceSymlink, and the destination directory mkdir is idempotent.
    await expect(provisionStaticCardsSubtree(sourceBin, destBin)).resolves.toBeUndefined();

    // The pre-existing symlink that was never replaced (helper.mjs) is still a
    // valid symlink to the source.
    const linkStat = await fs.lstat(path.join(destBin, 'helper.mjs'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    await expect(fs.readFile(path.join(destBin, 'helper.mjs'), 'utf8')).resolves.toBe('export const x = 1;\n');

    // The real file at cli.mjs was left untouched — replaceSymlink returned early
    // when lstat showed a non-symlink, rather than throwing EEXIST.
    const shadowStat = await fs.lstat(path.join(destBin, 'cli.mjs'));
    expect(shadowStat.isFile()).toBe(true);
    expect(shadowStat.isSymbolicLink()).toBe(false);
    await expect(fs.readFile(path.join(destBin, 'cli.mjs'), 'utf8')).resolves.toBe('console.log("shadow");\n');

    // The unrelated real file is still untouched.
    const realStat = await fs.lstat(realFile);
    expect(realStat.isFile()).toBe(true);
    expect(realStat.isSymbolicLink()).toBe(false);
    await expect(fs.readFile(realFile, 'utf8')).resolves.toBe('console.log("real");\n');
  });

  it('skips provisioning gracefully when a source subtree is absent (ENOENT tolerance)', async () => {
    // Seed only www; leave .cards/bin absent entirely.
    const cardsDir = path.join(repoDir, '.cards');
    await fs.mkdir(path.join(cardsDir, 'www', 'claude-code-session'), { recursive: true });
    await fs.writeFile(path.join(cardsDir, 'www', 'claude-code-session', 'index.html'), '<html>claude</html>\n');

    const { path: wPath, settle } = await createWorktree('feature/static-source-absent', { cwd: repoDir });
    // Must not throw despite the missing bin subtree.
    await expect(settle).resolves.toBeDefined();

    // bin was absent in the source, so no bin directory is created in the worktree.
    await expect(fs.access(path.join(wPath, '.cards', 'bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    // www was present and is provisioned.
    const wwwStat = await fs.lstat(path.join(wPath, '.cards', 'www'));
    expect(wwwStat.isDirectory()).toBe(true);
    expect(wwwStat.isSymbolicLink()).toBe(false);
  });

  it('propagates SymlinkPrivilegeError from provisioning rather than swallowing it', async () => {
    await seedStaticSubtrees();

    // Simulate the Windows symlink-privilege denial: fs.symlink rejects with
    // EPERM, which createSymlink translates into SymlinkPrivilegeError. The
    // settle phase must reject with that error, not silently degrade to a copy.
    symlinkOverride = async () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };

    const { settle } = await createWorktree('feature/static-symlink-privilege', { cwd: repoDir });
    await expect(settle).rejects.toBeInstanceOf(SymlinkPrivilegeError);
  });

  it('removeWorktree leaves source .cards/bin files intact (fs.rm removes symlinks, not targets)', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-remove-safety', { cwd: repoDir });
    await settle;

    // A sentinel file in the SOURCE bin that the worktree's symlinks point near.
    const sentinel = path.join(repoDir, '.cards', 'bin', 'sentinel.mjs');
    await fs.writeFile(sentinel, 'console.log("sentinel");\n');

    await removeWorktree(wPath);

    // fs.rm({recursive:true}) on the worktree removes the worktree's real dir and
    // its symlinks; the source files (including the sentinel) must survive.
    await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('console.log("sentinel");\n');
    await expect(fs.readFile(path.join(repoDir, '.cards', 'bin', 'cli.mjs'), 'utf8')).resolves.toBe(
      'console.log("cli");\n'
    );
  });

  it('recurses into www subdirectories as real dirs, isolating writes from the source', async () => {
    await seedStaticSubtrees();
    const { path: wPath, settle } = await createWorktree('feature/static-www-recursion', { cwd: repoDir });
    await settle;

    // The session subdirectory is a real directory, NOT a directory symlink.
    const subdir = path.join(wPath, '.cards', 'www', 'claude-code-session');
    const subdirStat = await fs.lstat(subdir);
    expect(subdirStat.isDirectory()).toBe(true);
    expect(subdirStat.isSymbolicLink()).toBe(false);

    // The index.html inside it is a per-file symlink to the source file.
    const indexStat = await fs.lstat(path.join(subdir, 'index.html'));
    expect(indexStat.isSymbolicLink()).toBe(true);

    // Writing a new file into the worktree's session subdir does NOT reach the source.
    await fs.writeFile(path.join(subdir, 'stray.html'), '<html>stray</html>\n');
    await expect(
      fs.access(path.join(repoDir, '.cards', 'www', 'claude-code-session', 'stray.html'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createWorktree worktree path policy integration', () => {
  let tmpBase = '';
  let repoDir = '';
  let worktreesDir = '';
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wt-policy-')));
    repoDir = path.join(tmpBase, 'repo');
    worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);
    process.env = { ...originalEnv, [CARDS_WORKTREES_DIR_KEY]: worktreesDir };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tmpBase) {
      // maxRetries/retryDelay: on Windows a git subprocess can briefly hold a
      // handle into tmpBase (.git admin files), so rmdir races EBUSY/EPERM —
      // retry past the transient lock, mirroring removeWorktree() in worktree.ts.
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it('copies a .worktreeinclude-selected ignored file into a real directory that isolates worktree writes from the source', async () => {
    // dist/ is gitignored, .worktreeinclude selects dist/bundle.js, and
    // stats.json is an unmatched sibling under the same ignored parent.
    commitGitignore(repoDir, 'dist/\n');
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log(1);\n');
    await fs.writeFile(path.join(repoDir, 'dist', 'stats.json'), '{"hits":0}\n');
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'dist/bundle.js\n');

    const { path: wPath, settle } = await createWorktree('feature/policy-copy-isolation', { cwd: repoDir });
    const result = await settle;
    expect(result.copiedFromInclude).toBe(1);

    // The included directory is real, not a symlink — inspect the parent with
    // lstat() before reading any child so an ancestor directory symlink cannot
    // masquerade as a copy (the plan's risk section).
    const distStat = await fs.lstat(path.join(wPath, 'dist'));
    expect(distStat.isDirectory()).toBe(true);
    expect(distStat.isSymbolicLink()).toBe(false);

    // The selected file is a real copied file, not a symlink into the source.
    const bundleStat = await fs.lstat(path.join(wPath, 'dist', 'bundle.js'));
    expect(bundleStat.isFile()).toBe(true);
    expect(bundleStat.isSymbolicLink()).toBe(false);
    await expect(fs.readFile(path.join(wPath, 'dist', 'bundle.js'), 'utf8')).resolves.toBe('console.log(1);\n');

    // Source and worktree files have distinct inodes and realpaths — the
    // worktree file is a separate filesystem object from the source file.
    const srcBundleStat = await fs.stat(path.join(repoDir, 'dist', 'bundle.js'));
    const wtBundleStat = await fs.stat(path.join(wPath, 'dist', 'bundle.js'));
    expect(wtBundleStat.ino).not.toBe(srcBundleStat.ino);
    expect(await fs.realpath(path.join(wPath, 'dist', 'bundle.js'))).not.toBe(
      await fs.realpath(path.join(repoDir, 'dist', 'bundle.js'))
    );

    // Mutate the worktree copy — the source file must stay unchanged.
    await fs.writeFile(path.join(wPath, 'dist', 'bundle.js'), 'console.log(2);\n');
    await expect(fs.readFile(path.join(wPath, 'dist', 'bundle.js'), 'utf8')).resolves.toBe('console.log(2);\n');
    await expect(fs.readFile(path.join(repoDir, 'dist', 'bundle.js'), 'utf8')).resolves.toBe('console.log(1);\n');

    // Unmatched ignored siblings under the copied parent remain absent.
    await expect(fs.lstat(path.join(wPath, 'dist', 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('omits .worktreeignore-matched generated directories entirely while sharing unmatched ignored directories', async () => {
    commitGitignore(repoDir, 'build/\ncache/\n');
    await fs.mkdir(path.join(repoDir, 'build'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'build', 'out.txt'), 'generated\n');
    await fs.mkdir(path.join(repoDir, 'cache'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'cache', 'entry.bin'), 'cached\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'build/\n');

    const { path: wPath, settle } = await createWorktree('feature/policy-omit-dir', { cwd: repoDir });
    await settle;

    // build is omitted: neither symlinked nor copied — absent from the worktree.
    await expect(fs.lstat(path.join(wPath, 'build'))).rejects.toMatchObject({ code: 'ENOENT' });
    // cache is unmatched by .worktreeignore → the default share: a symlink.
    const cacheStat = await fs.lstat(path.join(wPath, 'cache'));
    expect(cacheStat.isSymbolicLink()).toBe(true);
    // The omitted directory still exists in the source.
    await expect(fs.readFile(path.join(repoDir, 'build', 'out.txt'), 'utf8')).resolves.toBe('generated\n');
  });

  it('resolves nested and conflicting patterns with omit winning over copy inside a copied parent', async () => {
    commitGitignore(repoDir, 'gen/\n');
    await fs.mkdir(path.join(repoDir, 'gen'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'gen', 'out.txt'), 'out\n');
    await fs.writeFile(path.join(repoDir, 'gen', 'tmp.txt'), 'tmp\n');
    // gen/ selects the whole ignored directory for copy; gen/tmp.txt is also
    // listed in .worktreeignore — omit wins over copy for the nested file.
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'gen/\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'gen/tmp.txt\n');

    const { path: wPath, settle } = await createWorktree('feature/policy-nested-conflict', { cwd: repoDir });
    await settle;

    // gen is a real directory — the copied parent is never symlinked.
    const genStat = await fs.lstat(path.join(wPath, 'gen'));
    expect(genStat.isDirectory()).toBe(true);
    expect(genStat.isSymbolicLink()).toBe(false);

    // out.txt is a real copied file.
    const outStat = await fs.lstat(path.join(wPath, 'gen', 'out.txt'));
    expect(outStat.isFile()).toBe(true);
    expect(outStat.isSymbolicLink()).toBe(false);
    await expect(fs.readFile(path.join(wPath, 'gen', 'out.txt'), 'utf8')).resolves.toBe('out\n');

    // tmp.txt matches both config files; omit wins — it is absent.
    await expect(fs.lstat(path.join(wPath, 'gen', 'tmp.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed with WorktreeIncludeError when .worktreeinclude is unreadable, before any ignored path is symlinked', async () => {
    commitGitignore(repoDir, 'dist/\ncache/\n');
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log(1);\n');
    await fs.mkdir(path.join(repoDir, 'cache'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'cache', 'entry.bin'), 'cached\n');
    // A directory at the config path is unreadable as a file — the policy must
    // fail closed before a matching source path can be linked into the worktree.
    await fs.mkdir(path.join(repoDir, '.worktreeinclude'));

    const { path: wPath, settle } = await createWorktree('feature/policy-config-failure', { cwd: repoDir });

    await expect(settle).rejects.toBeInstanceOf(WorktreeIncludeError);

    // Fail-closed recovery: the failed settle removed the worktree, its git
    // registration, and the branch this call created — a half-provisioned
    // worktree must not be left behind for a re-run to trip over. Neither
    // ignored path was ever symlinked or copied.
    await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(listWorktrees(repoDir)).not.toContain(wPath);
    const branches = execFileSync('git', ['branch', '--list', 'feature/policy-config-failure'], {
      cwd: repoDir,
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('');
    await expect(fs.lstat(path.join(wPath, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(wPath, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-runs against the same ref after a settle failure once the config is fixed', async () => {
    // A failed settle must leave no trace — no worktree directory, no git
    // registration, no branch — or the natural recovery (fix the config, run
    // the action again) dies with "Worktree already exists" before the fix is
    // even evaluated.
    commitGitignore(repoDir, 'dist/\n');
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log(1);\n');
    // A directory at the config path is unreadable as a file → fail closed.
    await fs.mkdir(path.join(repoDir, '.worktreeinclude'));

    const first = await createWorktree('feature/policy-rerun', { cwd: repoDir });
    await expect(first.settle).rejects.toBeInstanceOf(WorktreeIncludeError);
    await expect(fs.access(first.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(listWorktrees(repoDir)).not.toContain(first.path);

    // Fix the config and re-run the exact same ref — must succeed now.
    await fs.rmdir(path.join(repoDir, '.worktreeinclude'));
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'dist/bundle.js\n');

    const { path: wPath, settle } = await createWorktree('feature/policy-rerun', { cwd: repoDir });
    const result = await settle;
    expect(result.copiedFromInclude).toBe(1);
    await expect(fs.readFile(path.join(wPath, 'dist', 'bundle.js'), 'utf8')).resolves.toBe('console.log(1);\n');

    await removeWorktree(wPath);
  });

  it('leaves settlement rollback to an explicit outer owner', async () => {
    commitGitignore(repoDir, 'dist/\n');
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log(1);\n');
    await fs.mkdir(path.join(repoDir, '.worktreeinclude'));

    const created = await createWorktree('feature/outer-cleanup-owner', {
      cwd: repoDir,
      cleanupOnSettleFailure: false
    });
    await expect(created.settle).rejects.toBeInstanceOf(WorktreeIncludeError);

    // The primitive reports the failure without tearing down a path that a
    // concurrent outer operation may still be using.
    await expect(fs.access(created.path)).resolves.toBeUndefined();
    expect(listWorktrees(repoDir)).toContain(created.path);
    expect(
      execFileSync('git', ['branch', '--list', 'feature/outer-cleanup-owner'], {
        cwd: repoDir,
        encoding: 'utf8'
      }).trim()
    ).toMatch(/feature\/outer-cleanup-owner$/);

    const failures = await cleanupFailedWorktree(repoDir, created.path, created.createdBranch);
    expect(failures).toEqual([]);
    await expect(fs.access(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(listWorktrees(repoDir)).not.toContain(created.path);
    expect(
      execFileSync('git', ['branch', '--list', 'feature/outer-cleanup-owner'], {
        cwd: repoDir,
        encoding: 'utf8'
      }).trim()
    ).toBe('');
  });

  it.skipIf(process.platform === 'win32')(
    'surfaces the initiating settle error and residual created branch when branch cleanup fails',
    async () => {
      commitGitignore(repoDir, 'dist/\n');
      await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
      await fs.mkdir(path.join(repoDir, '.worktreeinclude'));

      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const fakeBin = path.join(tmpBase, 'fault-bin');
      await fs.mkdir(fakeBin);
      const wrapper = path.join(fakeBin, 'git');
      await fs.writeFile(
        wrapper,
        `#!/bin/sh\nif [ "$1" = "branch" ] && [ "$2" = "-D" ] && [ "$3" = "feature/cleanup-residue" ]; then\n  echo "injected branch delete failure" >&2\n  exit 73\nfi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );

      const priorPath = process.env['PATH'];
      process.env['PATH'] = `${fakeBin}${path.delimiter}${priorPath ?? ''}`;
      try {
        const { path: wPath, settle } = await createWorktree('feature/cleanup-residue', { cwd: repoDir });
        await expect(settle).rejects.toThrow(
          /settlement failed and cleanup left residual resources: settle=.*worktreeinclude.*branch=feature\/cleanup-residue remains.*injected branch delete failure/s
        );

        await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
        const branches = execFileSync('git', ['branch', '--list', 'feature/cleanup-residue'], {
          cwd: repoDir,
          encoding: 'utf8'
        });
        expect(branches.trim()).toBe('feature/cleanup-residue');
      } finally {
        if (priorPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = priorPath;
        execFileSync(realGit, ['branch', '-D', 'feature/cleanup-residue'], { cwd: repoDir });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'attempts worktree and created-branch cleanup and reports both residuals',
    async () => {
      const created = await createWorktree('feature/both-cleanup-residues', { cwd: repoDir });
      await created.settle;
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const fakeBin = path.join(tmpBase, 'both-fault-bin');
      await fs.mkdir(fakeBin);
      const wrapper = path.join(fakeBin, 'git');
      await fs.writeFile(
        wrapper,
        `#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then\n  echo "injected worktree removal failure" >&2\n  exit 72\nfi\nif [ "$1" = "branch" ] && [ "$2" = "-D" ]; then\n  echo "injected branch removal failure" >&2\n  exit 73\nfi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );
      const priorPath = process.env['PATH'];
      process.env['PATH'] = `${fakeBin}${path.delimiter}${priorPath ?? ''}`;
      try {
        const failures = await cleanupFailedWorktree(repoDir, created.path, 'feature/both-cleanup-residues');
        expect(failures).toHaveLength(2);
        expect(failures[0]).toContain(`worktree=${created.path} may remain`);
        expect(failures[0]).toContain('injected worktree removal failure');
        expect(failures[1]).toContain('branch=feature/both-cleanup-residues remains');
        expect(failures[1]).toContain('injected branch removal failure');
      } finally {
        if (priorPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = priorPath;
        await removeWorktree(created.path);
        execFileSync(realGit, ['branch', '-D', 'feature/both-cleanup-residues'], { cwd: repoDir });
      }
    }
  );

  it('leaves a pre-existing branch alive when settle fails against it', async () => {
    // The settle-failure cleanup deletes only the branch this call created
    // (`git worktree add -b`). A branch that existed before must survive the
    // failed creation — it is the user's work, not a leftover.
    execFileSync('git', ['branch', 'feature/pre-existing'], { cwd: repoDir });
    commitGitignore(repoDir, 'dist/\n');
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log(1);\n');
    await fs.mkdir(path.join(repoDir, '.worktreeinclude'));

    const { path: wPath, settle } = await createWorktree('feature/pre-existing', { cwd: repoDir });
    await expect(settle).rejects.toBeInstanceOf(WorktreeIncludeError);

    // The worktree is gone, but the pre-existing branch survives.
    await expect(fs.access(wPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const branches = execFileSync('git', ['branch', '--list', 'feature/pre-existing'], {
      cwd: repoDir,
      encoding: 'utf8'
    });
    expect(branches.trim()).toBe('feature/pre-existing');
  });

  it('omits a git-ignored root symlink the policy omits: absent from the worktree', async () => {
    commitGitignore(repoDir, 'rootlink\n');
    await fs.symlink('/absolute/target', path.join(repoDir, 'rootlink'));
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'rootlink\n');

    const { path: wPath, settle } = await createWorktree('feature/e3-omit', { cwd: repoDir });
    await settle;

    await expect(fs.lstat(path.join(wPath, 'rootlink'))).rejects.toMatchObject({ code: 'ENOENT' });

    await removeWorktree(wPath);
  });

  it('copies a git-ignored root symlink the policy copies: recreated as a symlink by the include executor', async () => {
    commitGitignore(repoDir, 'rootlink\n');
    await fs.symlink('/absolute/target', path.join(repoDir, 'rootlink'));
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'rootlink\n');

    const { path: wPath, settle } = await createWorktree('feature/e3-copy', { cwd: repoDir });
    await settle;

    // applyWorktreeInclude recreates the symlink with its original target
    // (readlink + fs.symlink) — not a copy of the link, not the source path.
    await expect(fs.readlink(path.join(wPath, 'rootlink'))).resolves.toBe('/absolute/target');

    await removeWorktree(wPath);
  });

  it('mirrors an unclassified git-ignored root symlink as a symlink to the source entry', async () => {
    commitGitignore(repoDir, 'rootlink\n');
    await fs.symlink('/absolute/target', path.join(repoDir, 'rootlink'));

    const { path: wPath, settle } = await createWorktree('feature/e3-share', { cwd: repoDir });
    await settle;

    // Unmatched ignored root symlinks keep the share default: a symlink
    // pointing at the source entry.
    await expect(fs.readlink(path.join(wPath, 'rootlink'))).resolves.toBe(path.join(repoDir, 'rootlink'));

    await removeWorktree(wPath);
  });

  it('lists only actual symlinks in the worktree exclude file, keeping copied directories out', async () => {
    commitGitignore(repoDir, 'dist/\ncache/\n');
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log(1);\n');
    await fs.mkdir(path.join(repoDir, 'cache'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'cache', 'entry.bin'), 'cached\n');
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'dist/bundle.js\n');

    const { path: wPath, settle } = await createWorktree('feature/policy-exclude-file', { cwd: repoDir });
    await settle;

    // The exclude file lives in the worktree's git dir, exactly where
    // prepareWorktreeExcludes pointed core.excludesFile.
    const gitDir = execFileSync('git', ['-C', wPath, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    const excludeContent = await fs.readFile(path.join(gitDir, 'info', 'exclude'), 'utf8');

    // cache is a shared symlink → listed as an injected symlink exclusion.
    expect(excludeContent).toContain('cache');
    // dist is a real copied directory, not a symlink → must not be listed.
    expect(excludeContent).not.toContain('dist');
  });
});

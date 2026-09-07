/**
 * Test utility for creating real git workspace repositories.
 *
 * Why: repository identity resolution logic depends on actual git metadata,
 * so tests need a realistic workspace on disk.
 *
 * Behavior: creates a git repo with a minimal file set and an initial commit.
 *
 * Constraint: performs filesystem and git operations; call `destroy()` to
 * clean up any created directories.
 *
 *
 * @summary Test utility for creating real git workspace repositories
 * @module test-utils/git/TestGitWorkspace
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { type SimpleGit, simpleGit } from 'simple-git';
import { v4 as uuidv4 } from 'uuid';
import { abortWithRejectionGuard } from './abortGuard.js';

/**
 * Removes a directory tree, retrying transient Windows EPERM/EBUSY errors.
 *
 * Why: on Windows a git subprocess may briefly retain handles into the
 * workspace after it exits, so an immediate `fs.removeSync` can fail with
 * EPERM/EBUSY even though the directory is about to become free. POSIX is
 * unaffected (the first attempt succeeds), so behavior there is unchanged.
 *
 * @param target Absolute path of the directory tree to remove.
 * @throws The underlying filesystem error if removal fails for a
 *   non-transient reason or after exhausting retries.
 */
function removeSyncWithRetry(target: string): void {
  const maxRetries = 10;
  const retryDelayMs = 100;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.removeSync(target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY';
      if (!transient || attempt >= maxRetries) {
        throw error;
      }
      const deadline = Date.now() + retryDelayMs;
      while (Date.now() < deadline) {
        // Busy-wait: destroy() is synchronous, so we cannot await a timer.
      }
    }
  }
}

/**
 * Creates real Git repositories that simulate a user's project workspace.
 *
 * Why: identity resolution tests need a workspace path that behaves like a
 * real git repo, complete with commits and (optionally) a remote.
 *
 * This is different from TestCardRepository:
 * - TestCardRepository: Creates the card repos directory where cards are stored
 * - TestGitWorkspace: Creates a git repo that simulates the user's project
 *
 * Behavior: writes a README and .gitignore, makes an initial commit, and can
 * optionally configure a remote.
 *
 * @example
 * ```typescript
 * const workspace = new TestGitWorkspace();
 * await workspace.create();
 *
 * // Use workspace.getPath() as the workspacePath parameter
 * await store.listCards({ workspacePath: workspace.getPath() });
 *
 * workspace.destroy();
 * ```
 */
export class TestGitWorkspace {
  private workspacePath: string | null = null;
  private git: SimpleGit | null = null;
  private abortController: AbortController | null = null;
  private worktreePaths: string[] = [];

  /**
   * Gets the path to the workspace directory.
   *
   * @returns Absolute path to the created workspace directory
   * @throws If workspace not created
   */
  getPath(): string {
    if (!this.workspacePath) {
      throw new Error('Workspace not created');
    }
    return this.workspacePath;
  }

  /**
   * Gets the SimpleGit instance for this workspace.
   *
   * @returns SimpleGit client bound to this workspace repository
   * @throws If workspace not created
   */
  getGit(): SimpleGit {
    if (!this.git) {
      throw new Error('Workspace not created');
    }
    return this.git;
  }

  /**
   * Creates a new test git workspace.
   *
   * Behavior: uses `TEST_WORKSPACE` if provided, otherwise the OS temp folder.
   *
   * Why identity config: the `addConfig user.name` / `addConfig user.email`
   * calls configure a per-repo identity before any commit is made. This
   * prevents `Author identity unknown` failures in CI containers and developer
   * machines that lack a global `~/.gitconfig`. Do not remove them — without
   * these calls every `git commit` in the helper will fail in those
   * environments regardless of what the test itself does.
   *
   * @param options Optional configuration
   * @param options.remoteUrl Optional remote URL to set as origin
   * @param options.initialCommit When `false`, skip writing README/.gitignore
   *   and the initial commit. `git init` and identity config still run.
   *   Defaults to `true`.
   * @param options.identity Override the default git author identity used for
   *   commits. Applied before the initial commit (when one is made).
   * @param options.identity.name Git author name
   * @param options.identity.email Git author email
   * @returns The path to the workspace directory
   */
  async create(options?: {
    /** Optional remote URL to set as origin */
    remoteUrl?: string;
    /**
     * When false, skip writing README/.gitignore and the initial commit.
     * git init and identity config still run. Defaults to true.
     */
    initialCommit?: boolean;
    /** Override the default git author identity. */
    identity?: { name: string; email: string };
  }): Promise<string> {
    const workspaceId = uuidv4();
    const testWorkspace = process.env['TEST_WORKSPACE'] || path.join(os.tmpdir(), 'test-utils-workspace');
    await fs.ensureDir(testWorkspace);
    this.workspacePath = path.join(testWorkspace, `test-workspace-${workspaceId}`);
    await fs.ensureDir(this.workspacePath);
    // Canonicalize the path so it matches what git and the production code report.
    // os.tmpdir() can return a symlinked or non-canonical path (macOS /var ->
    // /private/var, Windows 8.3 short names, a symlinked $TMPDIR on Linux). Git
    // resolves these to their real path, and worktree identity is derived by hashing
    // the repository path, so the fixture must hand tests the same canonical path or
    // those comparisons diverge cross-platform.
    this.workspacePath = await fs.realpath(this.workspacePath);

    // Initialize git repository
    this.abortController = new AbortController();
    this.git = simpleGit(this.workspacePath, {
      unsafe: { allowUnsafeHooksPath: true, allowUnsafeEditor: true, allowUnsafeAskPass: true, allowUnsafePager: true },
      abort: this.abortController.signal
    });
    await this.git.raw(['init', '--initial-branch=main']);
    const name = options?.identity?.name ?? 'Test User';
    const email = options?.identity?.email ?? 'test@example.com';
    await this.git.addConfig('user.name', name);
    await this.git.addConfig('user.email', email);

    const makeInitialCommit = options?.initialCommit !== false;

    if (makeInitialCommit) {
      // Create initial files
      await fs.writeFile(path.join(this.workspacePath, 'README.md'), '# Test Workspace\n');
      await fs.writeFile(path.join(this.workspacePath, '.gitignore'), 'node_modules/\n');

      // Create initial commit
      await this.git.add('.');
      await this.git.commit('Repository initializes.');
    }

    // Set remote if provided
    if (options?.remoteUrl) {
      await this.git.addRemote('origin', options.remoteUrl);
    }

    return this.workspacePath;
  }

  /**
   * Creates a git worktree of this repository at a sibling temp directory.
   *
   * Behavior: checks whether `branch` already exists in the repo; if it does,
   * runs `git worktree add <path> <branch>`; if it does not, passes `-b` to
   * create the branch from HEAD. The worktree path is tracked internally and
   * removed by `destroy()` before the parent workspace is removed.
   *
   * @param branch Branch name to check out in the new worktree. Created from
   *   HEAD if it does not already exist.
   * @returns Absolute path to the new worktree directory
   * @throws If workspace not created
   */
  async createWorktree(branch: string): Promise<string> {
    if (!this.workspacePath || !this.git) {
      throw new Error('Workspace not created');
    }

    const worktreeId = uuidv4();
    const parentDir = path.dirname(this.workspacePath);
    const worktreePath = path.join(parentDir, `test-worktree-${worktreeId}`);

    // Determine whether the branch already exists
    const branchList = await this.git.branch(['--list', branch]);
    const branchExists = branchList.all.includes(branch);

    if (branchExists) {
      await this.git.raw(['worktree', 'add', worktreePath, branch]);
    } else {
      await this.git.raw(['worktree', 'add', '-b', branch, worktreePath]);
    }

    this.worktreePaths.push(worktreePath);
    return worktreePath;
  }

  /**
   * Creates and commits a file in the workspace.
   *
   * Behavior: ensures intermediate directories exist, stages the file, and
   * creates a commit with a default message if none is supplied.
   *
   * @param filename Workspace-relative path to create or overwrite
   * @param content Raw text written to the target file
   * @param message Optional commit message (defaults to `Add <filename>`)
   */
  async createAndCommitFile(filename: string, content: string, message?: string): Promise<void> {
    if (!this.workspacePath || !this.git) {
      throw new Error('Workspace not created');
    }

    const filePath = path.join(this.workspacePath, filename);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content);
    await this.git.add(filename);
    await this.git.commit(message ?? `Repository adds ${filename}.`);
  }

  /**
   * Sets a remote URL for this workspace.
   *
   * Behavior: updates the remote if it exists, otherwise adds it.
   *
   * @param url The remote URL to set
   * @param name Optional remote name (defaults to 'origin')
   */
  async setRemote(url: string, name = 'origin'): Promise<void> {
    if (!this.git) {
      throw new Error('Workspace not created');
    }

    // Check if remote exists
    const remotes = await this.git.getRemotes();
    const exists = remotes.some((r) => r.name === name);

    if (exists) {
      await this.git.remote(['set-url', name, url]);
    } else {
      await this.git.addRemote(name, url);
    }
  }

  /**
   * Destroys the test workspace, cleaning up all files.
   *
   * Behavior: removes any registered worktree directories first, then clears
   * the git queue and removes the parent workspace folder; safe to call
   * multiple times.
   */
  destroy(): void {
    // Remove worktrees before the parent workspace
    for (const worktreePath of this.worktreePaths) {
      try {
        removeSyncWithRetry(worktreePath);
      } catch (error) {
        // Log but continue — partial cleanup is better than none
        console.warn(`TestGitWorkspace: failed to remove worktree ${worktreePath}:`, error);
      }
    }
    this.worktreePaths = [];

    if (this.git) {
      try {
        // Guarded abort: the abort plugin rejects any still-spawned git task
        // promise, which — for an abandoned (timed-out) or fire-and-forget call —
        // would otherwise surface as a fatal unhandled rejection.
        abortWithRejectionGuard(this.abortController);
      } catch (error) {
        console.warn('TestGitWorkspace: failed to abort git operations:', error);
      }
      this.git = null;
      this.abortController = null;
    }

    if (this.workspacePath) {
      try {
        removeSyncWithRetry(this.workspacePath);
      } catch (error) {
        console.warn(`TestGitWorkspace: failed to remove workspace ${this.workspacePath}:`, error);
      }
      this.workspacePath = null;
    }
  }
}

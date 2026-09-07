/**
 * Test utility for creating real card repositories.
 *
 * Why: integration tests often need a real on-disk card repo with git history,
 * not a mocked filesystem, to validate behavior around commits and conflicts.
 *
 * Behavior: uses real `simple-git` and `fs-extra` operations to build card
 * repositories that match the Cards layout (CARD.meta.json, CARD.md, plans/, etc.).
 *
 * Constraint: this utility performs actual filesystem and git operations.
 * Always call `destroy()` to clean up temporary directories.
 *
 * Merges capabilities from:
 * - hybrid-store: Cards layout, metadata, attribution
 * - claude-code-cli-hooks: Branching, conflicts, commit history
 * - server: Basic git operations
 *
 *
 * @summary Test utility for creating real card repositories
 * @module test-utils/git/TestCardRepository
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveScaffoldDirFromSource } from '@cards.management/sdk';
import { COMMENTS_DIR } from '@cards.management/sdk/card-repo-layout';
import type { CardGates, CardStatus } from '@cards.management/sdk/protocol';
import { COMMITS_DIR, DEFAULT_CARD_GATES } from '@cards.management/sdk/protocol';
import * as fs from 'fs-extra';
import { type SimpleGit, simpleGit } from 'simple-git';
import { v4 as uuidv4 } from 'uuid';
import { abortWithRejectionGuard } from './abortGuard.js';

// --- Card Creation Options ---

/**
 * Options for creating a card repository and initial CARD.md content.
 *
 * Behavior: `gates` is merged with `DEFAULT_CARD_GATES`, so you can override
 * only the gates you care about.
 */
export interface CreateCardOptions {
  /** Optional explicit card id; useful when asserting on path names. */
  id?: string;
  /** Title written into CARD.meta.json. */
  title: string;
  /** Markdown body written to CARD.md. */
  description?: string;
  /** Initial status written into CARD.meta.json. */
  status?: CardStatus;
  /** Initial tags written into CARD.meta.json. */
  tags?: string[];
  /** Gate overrides merged with `DEFAULT_CARD_GATES`. */
  gates?: Partial<CardGates>;
  /** Parent branch written into CARD.meta.json. Defaults to `'main'`. */
  parentBranch?: string;
}

// --- Card Update Options ---

/**
 * Options for updating card metadata and description.
 *
 * Constraint: updates are written to CARD.meta.json and CARD.md separately.
 */
export interface UpdateCardOptions {
  /** New title for the CARD.meta.json. */
  title?: string;
  /** New description body (metadata preserved). */
  description?: string;
  /** New status for the CARD.meta.json. */
  status?: CardStatus;
  /** New tags array for the CARD.meta.json. */
  tags?: string[];
  /** Gate overrides merged into the existing gate set. */
  gates?: Partial<CardGates>;
}

// --- Test Card Repository Class ---

/**
 * Creates real Git repositories with proper card layout for integration testing.
 *
 * Why: many card flows depend on git history and real files on disk, so this
 * class provides a consistent way to create those artifacts in tests.
 *
 * Behavior:
 * - Creates a "repos" directory, then a git repo per card ID under it.
 * - Writes CARD.meta.json/CARD.md, common subdirectories, and attribution data.
 * - Commits each mutation so git-dependent code can inspect history.
 *
 * Constraint: the repo format is intentionally minimal and matches the layout
 * produced by this helper.
 *
 * This class consolidates test repository functionality from multiple packages:
 * - Cards layout (CARD.meta.json, CARD.md, tasks/, cards/, attachments/) from hybrid-store
 * - Metadata generation with gates from hybrid-store
 * - Attribution system from hybrid-store
 * - Branch management from claude-code-cli-hooks
 * - Conflict creation from claude-code-cli-hooks
 * - Commit history from claude-code-cli-hooks
 * - Nested structures from claude-code-cli-hooks
 *
 * @example
 * ```typescript
 * const repo = new TestCardRepository();
 * await repo.create();
 * const cardId = await repo.createCard({ title: 'Test Card' });
 * await repo.addComment(cardId, 'Initial note');
 * // ... test code ...
 * repo.destroy();
 * ```
 */
export class TestCardRepository {
  private reposPath: string | null = null;
  private git: SimpleGit | null = null;
  private abortController: AbortController | null = null;
  private readonly cardGitClients = new Map<string, SimpleGit>();
  private readonly descriptionFile = 'CARD.md';

  /**
   * Gets the SimpleGit instance for the first created card repo.
   *
   * Constraint: this is a convenience for legacy tests; prefer `getCardGit`
   * when you need a specific card repository.
   *
   * @returns SimpleGit client bound to the first created card repository
   * @throws If repository not created
   */
  getGit(): SimpleGit {
    if (!this.git) {
      throw new Error('Repository not created');
    }
    return this.git;
  }

  /**
   * Gets the path to the repos directory.
   *
   * @returns Absolute path to the temporary repos root directory
   * @throws If repository not created
   */
  getPath(): string {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    return this.reposPath;
  }

  /**
   * Creates the test repository directory structure.
   *
   * Behavior: uses `TEST_WORKSPACE` if provided, otherwise the OS temp folder.
   *
   * @returns The path to the repos directory
   */
  async create(): Promise<string> {
    const repoId = uuidv4();
    const testWorkspace = process.env['TEST_WORKSPACE'] || path.join(os.tmpdir(), 'test-utils-workspace');
    await fs.ensureDir(testWorkspace);
    this.reposPath = path.join(testWorkspace, `test-repos-${repoId}`);
    await fs.ensureDir(this.reposPath);
    this.abortController = new AbortController();
    return this.reposPath;
  }

  /**
   * Creates a card repository with proper layout.
   *
   * Behavior: initializes a git repo under `<reposPath>/<cardId>` and writes
   * the standard card scaffolding (CARD.meta.json, CARD.md, subfolders, attribution).
   *
   * @param options Card creation options
   * @returns The card ID
   */
  async createCard(options: CreateCardOptions): Promise<string> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }

    const cardId = options.id ?? uuidv4();
    const cardPath = path.join(this.reposPath, cardId);
    await fs.ensureDir(cardPath);

    // Initialize git repo for this card
    this.abortController ??= new AbortController();
    const git = simpleGit(cardPath, {
      unsafe: { allowUnsafeHooksPath: true, allowUnsafeEditor: true, allowUnsafeAskPass: true, allowUnsafePager: true },
      abort: this.abortController.signal
    });
    await git.raw(['init', '--initial-branch=main']);
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create .gitignore for common build artifacts across languages, read from
    // the SDK scaffold fixture (resolved from TS source under vitest).
    await fs.writeFile(
      path.join(cardPath, '.gitignore'),
      fs.readFileSync(path.join(resolveScaffoldDirFromSource(), '.gitignore'), 'utf-8')
    );

    // Create CARD.meta.json
    const gates: CardGates = { ...DEFAULT_CARD_GATES, ...options.gates };
    const metadata = {
      id: cardId,
      title: options.title,
      status: options.status ?? 'todo',
      tags: options.tags ?? [],
      gates,
      isPinned: false,
      order: 0,
      repositoryId: 'test-repo',
      parentBranch: options.parentBranch ?? 'main'
    };
    await fs.writeFile(path.join(cardPath, 'CARD.meta.json'), JSON.stringify(metadata, null, 2));

    // Create description markdown content
    await fs.writeFile(path.join(cardPath, this.descriptionFile), options.description ?? '');

    // Initial commit
    await git.add('.');
    await git.commit('Initialized.');

    // Store git instance if this is the first card (for convenience)
    if (!this.git) {
      this.git = git;
    }
    this.cardGitClients.set(cardId, git);

    return cardId;
  }

  /**
   * Updates an existing card's metadata.
   *
   * Constraint: updates are written to CARD.meta.json and CARD.md separately.
   *
   * @param cardId Identifier of the card repository directory to mutate
   * @param options Partial metadata and content fields to overwrite
   */
  async updateCard(cardId: string, options: UpdateCardOptions): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }

    const cardPath = path.join(this.reposPath, cardId);

    // Read current CARD.meta.json
    const metaPath = path.join(cardPath, 'CARD.meta.json');
    const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

    // Apply updates
    if (options.title !== undefined) metadata.title = options.title;
    if (options.status !== undefined) metadata.status = options.status;
    if (options.tags !== undefined) metadata.tags = options.tags;
    if (options.gates !== undefined) metadata.gates = { ...metadata.gates, ...options.gates };

    // Write back CARD.meta.json
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));

    // Update description if provided
    if (options.description !== undefined) {
      await fs.writeFile(path.join(cardPath, this.descriptionFile), options.description);
    }

    // Commit
    const git = this.getCardGit(cardId);
    await git.add('.');
    await git.commit('Card updates.');
  }

  /**
   * Adds a comment to a card.
   *
   * Behavior: stores the raw content in `comments/{slug}.md` and
   * creates a commit for the new file.
   *
   * @param cardId Identifier of the card repository that will receive the comment
   * @param slug Descriptive filename stem for the comment (e.g., 'plan-approved', 'blocked-status')
   * @param content Markdown body written to the generated comment file
   * @param author Optional commit author (default: 'Test User')
   * @returns The comment filename
   */
  async addComment(cardId: string, slug: string, content: string, author?: string): Promise<string> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }

    const cardPath = path.join(this.reposPath, cardId);
    const commentsPath = path.join(cardPath, COMMENTS_DIR);
    const filename = `${slug}.md`;

    // Ensure comment directory exists (lazy creation)
    await fs.ensureDir(commentsPath);

    await fs.writeFile(path.join(commentsPath, filename), content);

    const git = this.getCardGit(cardId);
    await git.add('.');
    const commitAuthor = author ?? 'Test User';
    await git.commit('Added a comment.', undefined, {
      '--author': `${commitAuthor} <${commitAuthor}@cards.local>`
    });

    return filename;
  }

  /**
   * Adds an attribution commit SHA to a card.
   *
   * Behavior: writes a `commits/<sha>` entry file and commits it.
   *
   * @param cardId Identifier of the card repository receiving attribution data
   * @param sha The commit SHA to attribute
   */
  async addAttribution(cardId: string, sha: string): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }

    const cardPath = path.join(this.reposPath, cardId);
    const commitsDir = path.join(cardPath, COMMITS_DIR);
    await fs.mkdir(commitsDir, { recursive: true });
    await fs.writeFile(path.join(commitsDir, sha), `${sha}\n`);

    const git = this.getCardGit(cardId);
    await git.add('.');
    await git.commit(`Added attribution for ${sha.slice(0, 7)}.`);
  }

  // --- Branch Management (from claude-code-cli-hooks) ---

  /**
   * Creates a new branch and returns to main.
   *
   * Behavior: leaves the repo on `main` after creating the branch.
   *
   * @param cardId Identifier of the card repository where the branch is created
   * @param branchName Name of the branch to create
   */
  async createBranch(cardId: string, branchName: string): Promise<void> {
    const git = this.getCardGit(cardId);
    await git.checkoutLocalBranch(branchName);
    await git.checkout('main');
  }

  /**
   * Checks out and stays on the specified branch.
   *
   * @param cardId Identifier of the card repository whose branch is checked out
   * @param branchName Name of the branch to checkout
   */
  async checkoutBranch(cardId: string, branchName: string): Promise<void> {
    const git = this.getCardGit(cardId);
    await git.checkout(branchName);
  }

  /**
   * Gets the current branch name.
   *
   * Behavior: falls back to `main` if git does not return a branch name.
   *
   * @param cardId Identifier of the card repository to query
   * @returns Currently checked out branch name, defaulting to `main`
   */
  async getCurrentBranch(cardId: string): Promise<string> {
    const git = this.getCardGit(cardId);
    const status = await git.status();
    return status.current ?? 'main';
  }

  // --- File Operations ---

  /**
   * Adds a file to the working directory (without committing).
   *
   * Behavior: creates intermediate directories and writes raw content.
   *
   * @param cardId Identifier of the card repository where the file is written
   * @param filePath Relative file path
   * @param content Raw file contents to write at `filePath`
   */
  async addFileToWorkingDir(cardId: string, filePath: string, content: string): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    const cardPath = path.join(this.reposPath, cardId);
    const fullPath = path.join(cardPath, filePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
  }

  /**
   * Modifies a file and commits the change.
   *
   * Behavior: writes the file, stages it, and creates a commit with a default
   * message when none is supplied.
   *
   * @param cardId Identifier of the card repository containing the file
   * @param filePath Relative file path
   * @param content Replacement file contents written before committing
   * @param message Optional commit message
   */
  async modifyFile(cardId: string, filePath: string, content: string, message?: string): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    const cardPath = path.join(this.reposPath, cardId);
    const fullPath = path.join(cardPath, filePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
    const git = this.getCardGit(cardId);
    await git.add(filePath);
    await git.commit(message ?? `Updated ${filePath}.`);
  }

  /**
   * Deletes a file from the working directory (without committing).
   *
   * Constraint: does not stage or commit the deletion; call `stageFile` or
   * `modifyFile` if you want a commit.
   *
   * @param cardId Identifier of the card repository containing the target file
   * @param filePath Relative file path
   */
  async deleteFile(cardId: string, filePath: string): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    const cardPath = path.join(this.reposPath, cardId);
    const fullPath = path.join(cardPath, filePath);
    await fs.unlink(fullPath);
  }

  /**
   * Reads a file from the card repository.
   *
   * @param cardId Identifier of the card repository containing the file
   * @param filePath Relative file path
   * @returns File content as string
   */
  async readFile(cardId: string, filePath: string): Promise<string> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    const cardPath = path.join(this.reposPath, cardId);
    const fullPath = path.join(cardPath, filePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  /**
   * Stages a file for commit.
   *
   * @param cardId Identifier of the card repository containing the file
   * @param filePath Relative file path
   */
  async stageFile(cardId: string, filePath: string): Promise<void> {
    const git = this.getCardGit(cardId);
    await git.add(filePath);
  }

  /**
   * Renames a file using git mv.
   *
   * Behavior: uses `git mv`, so the rename is staged but not committed.
   *
   * @param cardId Identifier of the card repository containing the file
   * @param oldPath Existing repository-relative path to rename
   * @param newPath Destination repository-relative path
   */
  async renameFile(cardId: string, oldPath: string, newPath: string): Promise<void> {
    const git = this.getCardGit(cardId);
    await git.mv(oldPath, newPath);
  }

  // --- Advanced Git Operations (from claude-code-cli-hooks) ---

  /**
   * Creates a merge conflict for testing conflict resolution.
   *
   * Behavior: writes conflicting versions of `conflict.ts` on `main` and
   * `feature-branch`, then attempts a merge that is expected to fail.
   *
   * Constraint: leaves the repository in a conflicted state.
   *
   * @param cardId Identifier of the card repository where conflicts are created
   */
  async createConflict(cardId: string): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }

    const git = this.getCardGit(cardId);
    const cardPath = path.join(this.reposPath, cardId);

    // Check if feature-branch exists, use it or create it
    const branches = await git.branchLocal();
    if (branches.all.includes('feature-branch')) {
      await git.checkout('feature-branch');
    } else {
      await git.checkoutLocalBranch('feature-branch');
    }

    await fs.writeFile(path.join(cardPath, 'conflict.ts'), 'feature version\n');
    await git.add('conflict.ts');
    await git.commit('Feature branch adds conflict file.');

    await git.checkout('main');
    await fs.writeFile(path.join(cardPath, 'conflict.ts'), 'main version\n');
    await git.add('conflict.ts');
    await git.commit('Main branch adds conflict file.');

    try {
      await git.merge(['feature-branch']);
    } catch (error) {
      // Merge conflict is expected during test setup — swallow intentionally
      void error;
    }
  }

  /**
   * Creates a nested directory structure for testing file operations.
   *
   * Behavior: writes a minimal TypeScript/TSX tree and commits it in one change.
   *
   * @param cardId Identifier of the card repository that receives the fixture tree
   */
  async createNestedStructure(cardId: string): Promise<void> {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }

    const cardPath = path.join(this.reposPath, cardId);
    const dirs = ['src', 'src/components', 'src/services', 'test'];

    for (const dir of dirs) {
      await fs.mkdir(path.join(cardPath, dir), { recursive: true });
    }

    await fs.writeFile(path.join(cardPath, 'src/index.ts'), 'export {}');
    await fs.writeFile(path.join(cardPath, 'src/components/Button.tsx'), 'export const Button = () => {}');
    await fs.writeFile(path.join(cardPath, 'src/services/api.ts'), 'export const api = {}');
    await fs.writeFile(path.join(cardPath, 'test/app.test.ts'), 'test()');

    const git = this.getCardGit(cardId);
    await git.add('.');
    await git.commit('Added files across directory structure.');
  }

  /**
   * Gets the current HEAD commit SHA.
   *
   * @param cardId Identifier of the card repository to inspect
   * @returns The full 40-character SHA of HEAD
   */
  async getHeadSha(cardId: string): Promise<string> {
    const git = this.getCardGit(cardId);
    const log = await git.log({ maxCount: 1 });
    if (!log.latest) {
      throw new Error('No commits in repository');
    }
    return log.latest.hash;
  }

  /**
   * Gets all commit SHAs between a baseline and HEAD.
   *
   * Behavior: delegates to `git rev-list baseline..HEAD`, so the list is in
   * reverse chronological order (newest first) and excludes the baseline.
   *
   * @param cardId Identifier of the card repository whose history is queried
   * @param baseline The baseline commit SHA to start from (exclusive)
   * @returns Array of commit SHAs from baseline to HEAD (newest first)
   */
  async getCommitsSince(cardId: string, baseline: string): Promise<string[]> {
    const git = this.getCardGit(cardId);
    const result = await git.raw(['rev-list', `${baseline}..HEAD`]);
    return result
      .trim()
      .split('\n')
      .filter((sha) => sha.length > 0);
  }

  // --- Accessors ---

  /**
   * Gets the Git instance for a specific card.
   *
   * Behavior: reuses a stable `SimpleGit` instance per card repository.
   *
   * @param cardId Identifier of the card repository whose Git client is needed
   * @returns SimpleGit instance rooted at the requested card directory
   * @throws If the repository root has not been created yet
   */
  getCardGit(cardId: string): SimpleGit {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    const existing = this.cardGitClients.get(cardId);
    if (existing) {
      return existing;
    }
    this.abortController ??= new AbortController();
    const git = simpleGit(path.join(this.reposPath, cardId), {
      unsafe: { allowUnsafeHooksPath: true, allowUnsafeEditor: true, allowUnsafeAskPass: true, allowUnsafePager: true },
      abort: this.abortController.signal
    });
    this.cardGitClients.set(cardId, git);
    return git;
  }

  /**
   * Gets the path to a specific card repo.
   *
   * @param cardId Identifier of the card repository to resolve
   * @returns Absolute path to the requested card directory
   * @throws If the repository root has not been created yet
   */
  getCardPath(cardId: string): string {
    if (!this.reposPath) {
      throw new Error('Repository not created');
    }
    return path.join(this.reposPath, cardId);
  }

  /**
   * Destroys the test repository, cleaning up all files.
   *
   * Behavior: clears the git queue (if any) and removes the entire repos
   * directory; safe to call multiple times.
   */
  destroy(): void {
    this.cardGitClients.clear();

    // Cancel any in-flight git work. Gate on the controller (the thing being
    // cancelled), not on `this.git`: this helper creates the controller in
    // `create()` and threads it into per-card clients via `getCardGit()`, but
    // only assigns `this.git` once a card is created with `createCard()`. A
    // `create()` -> `getCardGit(id)` lifecycle binds the signal to clients while
    // leaving `this.git` null, so gating abort on `this.git` would skip
    // cancellation and leak the controller entirely.
    if (this.abortController) {
      try {
        // Guarded abort: the abort plugin rejects any still-spawned git task
        // promise, which — for an abandoned (timed-out) or fire-and-forget call —
        // would otherwise surface as a fatal unhandled rejection.
        abortWithRejectionGuard(this.abortController);
      } catch (error) {
        // Cleanup errors are expected — swallow intentionally
        void error;
      }
      this.abortController = null;
    }
    this.git = null;

    if (this.reposPath) {
      try {
        fs.removeSync(this.reposPath);
      } catch (error) {
        // Cleanup errors are expected — swallow intentionally
        void error;
      }
      this.reposPath = null;
    }
  }
}

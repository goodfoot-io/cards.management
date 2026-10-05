/**
 * Shared Cards configuration directory helpers.
 *
 * Keeps global Cards path resolution consistent across packages that need to
 * read or stage user-scoped Cards-managed assets.
 *
 * @summary Shared Cards configuration directory helpers
 * @module
 */

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Name of the Cards configuration directory. */
export const CARDS_DIR_NAME = '.cards';

/**
 * Resolves the Cards global configuration directory using the standard fallback chain.
 *
 * Resolution order:
 * 1. `$CARDS_HOME`
 * 2. `$XDG_DATA_HOME/.cards`
 * 3. `$XDG_CONFIG_HOME/.cards`
 * 4. `~/.cards`
 *
 * @returns Absolute path to the Cards global configuration directory.
 */
export function resolveGlobalCardsConfigDir(): string {
  const cardsHome = process.env['CARDS_HOME'];
  if (cardsHome) {
    return cardsHome;
  }

  const xdgDataHome = process.env['XDG_DATA_HOME'];
  if (xdgDataHome) {
    return path.join(xdgDataHome, CARDS_DIR_NAME);
  }

  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, CARDS_DIR_NAME);
  }

  return path.join(homedir(), CARDS_DIR_NAME);
}

/**
 * Generates a stable, unique identifier for a repository root path.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns A short stable hash (8 chars) prefixed with the directory name.
 */
export function generateRepoId(repoRoot: string): string {
  const dirName = path.basename(repoRoot);
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return `${dirName}-${hash}`;
}

/**
 * Resolves the shared root that stores Cards-managed worktrees.
 *
 * @returns Absolute path to the worktree root directory.
 */
export function resolveWorktreesRoot(): string {
  const overrideRoot = process.env['CARDS_WORKTREES_DIR'];
  if (overrideRoot) {
    return overrideRoot;
  }

  return path.join(resolveGlobalCardsConfigDir(), 'worktrees');
}

/**
 * Resolves the centralized worktree directory for a given repository and ref.
 *
 * Path pattern: `$CARDS_HOME/worktrees/<repo-id>/<ref>`
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param ref - Git reference (branch, tag, or SHA).
 * @returns Absolute path to the worktree directory.
 */
export function resolveWorktreeDir(repoRoot: string, ref: string): string {
  const repoId = generateRepoId(repoRoot);
  return path.join(resolveWorktreesRoot(), repoId, ref);
}

/**
 * Resolves the main Git repository root from a workspace path.
 *
 * A workspace may be a linked worktree, marked by a `.git` *file* holding a
 * `gitdir:` pointer rather than a `.git` *directory*. This follows that pointer
 * to the primary checkout, so every caller derives per-repository paths, such
 * as worktree slot roots, from the same root whichever window it runs in.
 *
 * @param workspacePath - Absolute path to the workspace folder.
 * @returns The main repository root (the input itself for a primary checkout).
 * @throws {Error} When no `.git` marker is found at the workspace path.
 */
export async function resolveMainRepoRoot(workspacePath: string): Promise<string> {
  const gitPath = path.join(workspacePath, '.git');
  const stats = await lstat(gitPath);

  if (stats.isDirectory()) {
    return workspacePath;
  }

  if (stats.isFile()) {
    // Format: "gitdir: /path/to/main-repo/.git/worktrees/<name>"
    const gitFileContent = await readFile(gitPath, 'utf-8');
    const gitdirPath = gitFileContent.trim().replace(/^gitdir:\s*/, '');
    const resolvedGitdir = path.isAbsolute(gitdirPath) ? gitdirPath : path.resolve(workspacePath, gitdirPath);
    // Git writes POSIX separators into the `.git` file even on Windows, but
    // path.resolve() of a relative pointer yields native separators, so
    // accept either separator when stripping `worktrees/<name>` and `.git`.
    const mainGitDir = resolvedGitdir.replace(/[/\\]worktrees[/\\][^/\\]+$/, '');
    return mainGitDir.replace(/[/\\]\.git$/, '');
  }

  throw new Error(`Unexpected .git type at ${gitPath}`);
}

/**
 * Resolves a card's worktree slot root: the directory holding its slot
 * checkouts and their `.locks/` directory.
 *
 * Always derived from the main repository root, never from the workspace path
 * itself, which can be a linked worktree.
 *
 * @param workspacePath - Absolute path to the workspace folder; may be a linked worktree.
 * @param cardId - Card whose slots live under the root.
 * @returns Absolute path of `resolveWorktreeDir(mainRepoRoot, 'cards/<cardId>')`.
 */
export async function resolveSlotRoot(workspacePath: string, cardId: string): Promise<string> {
  return resolveWorktreeDir(await resolveMainRepoRoot(workspacePath), `cards/${cardId}`);
}

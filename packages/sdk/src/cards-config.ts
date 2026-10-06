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
import { lstat, readFile, realpath } from 'node:fs/promises';
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
 * Resolves a path through symlinks even when its leaf does not exist.
 *
 * `realpath` cannot canonicalize a missing directory, so this walks to the
 * deepest existing ancestor, canonicalizes that, and appends the missing
 * suffix unchanged.
 *
 * @param input - Existing or partially missing filesystem path.
 * @returns Canonical absolute path with any missing suffix restored.
 * @throws {Error} When an ancestor fails with anything but `ENOENT`, or no ancestor exists.
 */
export async function canonicalizePath(input: string): Promise<string> {
  let existingAncestor = path.resolve(input);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existingAncestor), ...missingSegments.reverse());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

/**
 * Spelling of a canonical path for comparison: case-folded where the filesystem ignores case.
 * @param canonical - A canonical absolute path.
 * @returns The path as compared on this platform.
 */
const comparable = (canonical: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? canonical.toLowerCase() : canonical;

/**
 * Whether `inner` is `outer` or lies beneath it; both are comparable canonical paths.
 * @param outer - The containing path.
 * @param inner - The path tested.
 * @returns True when `inner` equals or descends from `outer`.
 */
const within = (outer: string, inner: string): boolean => {
  const relative = path.relative(outer, inner);
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
};

/**
 * The directory holding a repository's dedicated worktree slots:
 * `<worktrees root>/<repo-id>/cards`, with slots at `<card>/<ordinal>` beneath it.
 * @param mainRoot - The repository's main checkout.
 * @returns The slot namespace root.
 */
export function resolveSlotNamespace(mainRoot: string): string {
  return resolveWorktreeDir(mainRoot, 'cards');
}

/** A worktree operation targeted the dedicated slot namespace, which only worktree maintenance may change. */
export class SlotNamespaceError extends Error {
  readonly target: string;
  readonly namespace: string;
  /**
   * Names the refused target and the namespace it touches.
   * @param target - The path the operation would have created or removed.
   * @param namespace - The repository's slot namespace.
   */
  constructor(target: string, namespace: string) {
    super(
      `${target} is or contains dedicated worktree slots (${namespace}). Slots are created by card launches and ` +
        'removed only by Clean Up Worktrees (the worktreeMaintenance command), which checks each slot for ' +
        'unmerged work, live locks and running processes first. If the card was deleted, see "Worktrees left by a ' +
        'deleted card" (wiki/guides/troubleshooting/failures/public-default-configuration.md#worktrees-left-by-a-deleted-card).'
    );
    this.name = 'SlotNamespaceError';
    this.target = target;
    this.namespace = namespace;
  }
}

/**
 * Whether a filesystem path is a repository's slot namespace, an ancestor of it, or inside it.
 * Paths are compared after resolving `.`/`..`, repeated separators and symlinks, and
 * case-folded on Windows and macOS, so no spelling of a slot reaches it. Because a
 * repository id hashes one spelling of its root, the `cards` namespace of every
 * repository id under the worktrees root counts too, as do the worktrees root and
 * each repository directory, which contain namespaces.
 * @param mainRoot - The repository's main checkout.
 * @param target - The path an operation would create or remove.
 * @returns True when the operation could touch a slot or its locks.
 */
export async function isInSlotNamespace(mainRoot: string, target: string): Promise<boolean> {
  const [namespace, root, candidate] = (
    await Promise.all([
      canonicalizePath(resolveSlotNamespace(mainRoot)),
      canonicalizePath(resolveWorktreesRoot()),
      canonicalizePath(target)
    ])
  ).map(comparable) as [string, string, string];
  if (within(namespace, candidate) || within(candidate, namespace) || within(candidate, root)) return true;
  if (!within(root, candidate)) return false;
  const [, second] = path.relative(root, candidate).split(path.sep);
  return second === undefined || second === 'cards';
}

/**
 * Refuses a worktree create or remove whose target touches the slot namespace.
 * @param mainRoot - The repository's main checkout.
 * @param target - The path the operation would create or remove.
 * @throws {SlotNamespaceError} When {@link isInSlotNamespace} holds.
 */
export async function assertOutsideSlotNamespace(mainRoot: string, target: string): Promise<void> {
  if (await isInSlotNamespace(mainRoot, target)) throw new SlotNamespaceError(target, resolveSlotNamespace(mainRoot));
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

/**
 * Read-only inspection of slot checkouts, refs and git's worktree list: the
 * usability rule every reuse and every cleanup check applies.
 *
 * @summary Slot checkout usability, ref and worktree-list reads
 * @module
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SlotGit } from './slot-git.js';

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  readonly path: string;
  /** Full ref the entry has checked out, or null when detached or bare. */
  readonly branchRef: string | null;
  /** Lock reason when the entry carries a `locked` line ('' for no reason), else null. */
  readonly locked: string | null;
}

/** Why a present checkout cannot be used. */
export type Usability =
  | { readonly status: 'usable' }
  | { readonly status: 'absent' }
  | { readonly status: 'head_off_branch'; readonly detail: string }
  | { readonly status: 'unusable_checkout'; readonly detail: string };

/**
 * Whether a path exists, without following a final symlink.
 * @param path - Path to test.
 * @returns True when an entry exists at the path.
 * @throws When the path cannot be inspected for a reason other than absence.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Parses `git worktree list --porcelain`.
 * @param git - Slot git.
 * @param repoRoot - Main repository root.
 * @returns Every entry, main checkout included.
 */
export async function listWorktreeEntries(git: SlotGit, repoRoot: string): Promise<readonly WorktreeEntry[]> {
  const output = await git.text(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split('\n').filter((line) => line !== '');
    const head = lines.find((line) => line.startsWith('worktree '));
    if (head === undefined) continue;
    const branch = lines.find((line) => line.startsWith('branch '));
    const locked = lines.find((line) => line === 'locked' || line.startsWith('locked '));
    entries.push({
      path: resolve(head.slice('worktree '.length)),
      branchRef: branch === undefined ? null : branch.slice('branch '.length),
      locked: locked === undefined ? null : locked.slice('locked'.length).trim()
    });
  }
  return entries;
}

/**
 * Reads a branch's oid.
 * @param git - Slot git.
 * @param repoRoot - Main repository root.
 * @param branch - Short branch name.
 * @returns The oid, or null when the ref does not exist.
 */
export async function refOid(git: SlotGit, repoRoot: string, branch: string): Promise<string | null> {
  const result = await git.run(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (result.exitCode === 0 && !result.timedOut && !result.aborted) return result.stdout.trim();
  if (result.exitCode === 1 && !result.timedOut && !result.aborted) return null;
  throw new Error(`Cannot read refs/heads/${branch}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

/**
 * Compares two paths after resolving symlinks on the longest existing prefix.
 * @param left - First path.
 * @param right - Second path.
 * @returns True when both name the same location.
 */
export async function samePath(left: string, right: string): Promise<boolean> {
  return (await canonicalPath(left)) === (await canonicalPath(right));
}

/**
 * Resolves symlinks in a path that may not exist yet.
 * @param path - Path to resolve.
 * @returns The real path of its longest existing prefix joined with the rest.
 */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

/**
 * Judges whether a slot checkout may be used: it exists, `.git` is a `gitdir:`
 * file, git sees a work tree of the main repository, HEAD is the slot branch,
 * and git's entry for it is not `locked`.
 * @param git - Slot git.
 * @param repoRoot - Main repository root.
 * @param path - Slot checkout path.
 * @param branch - Slot branch the checkout must have checked out.
 * @param entries - The current worktree list, when already read.
 * @returns The judgement.
 */
export async function judgeUsability(
  git: SlotGit,
  repoRoot: string,
  path: string,
  branch: string,
  entries?: readonly WorktreeEntry[]
): Promise<Usability> {
  if (!(await pathExists(path))) return { status: 'absent' };
  const repair = 'run `git worktree repair` from the main repository';
  const dotGit = join(path, '.git');
  if (!(await pathExists(dotGit)) || !(await lstat(dotGit)).isFile())
    return { status: 'unusable_checkout', detail: `${dotGit} is not a gitdir file; ${repair}` };
  if (!/^gitdir: .+\s*$/.test(await readFile(dotGit, 'utf8')))
    return { status: 'unusable_checkout', detail: `${dotGit} has no gitdir pointer; ${repair}` };
  const inside = await git.run(path, ['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true')
    return { status: 'unusable_checkout', detail: `git does not see a work tree at ${path}; ${repair}` };
  const [actualCommon, expectedCommon] = await Promise.all([
    git.text(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git.text(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ]);
  if (!(await samePath(actualCommon.trim(), expectedCommon.trim())))
    return { status: 'unusable_checkout', detail: `${path} belongs to another repository (${actualCommon.trim()})` };
  const head = await git.run(path, ['symbolic-ref', '--quiet', 'HEAD']);
  if (head.exitCode !== 0 || head.stdout.trim() !== `refs/heads/${branch}`) {
    const current = head.exitCode === 0 ? head.stdout.trim() : 'a detached HEAD';
    return { status: 'head_off_branch', detail: `${path} has ${current} checked out instead of ${branch}` };
  }
  const list = entries ?? (await listWorktreeEntries(git, repoRoot));
  let entry: WorktreeEntry | undefined;
  for (const candidate of list) {
    if (await samePath(candidate.path, path)) entry = candidate;
  }
  if (entry === undefined)
    return { status: 'unusable_checkout', detail: `git has no worktree entry for ${path}; ${repair}` };
  if (entry.locked !== null)
    return {
      status: 'unusable_checkout',
      detail: `git's entry for ${path} is locked${entry.locked === '' ? '' : ` (${entry.locked})`}; run \`git worktree unlock ${path}\` once nothing is populating it`
    };
  return { status: 'usable' };
}

/**
 * Paths at which git has a branch checked out.
 * @param entries - The worktree list.
 * @param branch - Short branch name.
 * @returns Every checkout path of the branch.
 */
export function checkedOutPaths(entries: readonly WorktreeEntry[], branch: string): readonly string[] {
  return entries.filter((entry) => entry.branchRef === `refs/heads/${branch}`).map((entry) => entry.path);
}

/**
 * The submodule rule of slot cleanup. A linked worktree keeps each initialized
 * submodule's repository under its own git directory (`<gitdir>/modules/<name>`),
 * so removing the slot deletes those repositories. A slot is removable only when
 * nothing would be lost with them: every gitlink is either uninitialized with an
 * empty directory, or initialized, clean, at its recorded commit and fully
 * reachable from remote-tracking refs, recursively; and every module repository
 * no checkout claims passes the same ref checks.
 *
 * @summary Whether a slot's submodules can be removed with it
 * @module
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SlotGit } from './slot-git.js';

/** Mode of a gitlink in `git ls-files --stage`. */
const GITLINK_MODE = '160000';

/** What the submodule rule found in one slot checkout. */
export type SubmoduleJudgement =
  /**
   * Nothing a removal would lose. `repositories` lists the module
   * repositories under the slot's git directory, which git will not move or
   * remove a worktree past; empty when there are none.
   */
  | { readonly status: 'clean'; readonly repositories: readonly string[] }
  /** Something a removal would lose, what it is, and how to resolve it. */
  | { readonly status: 'kept'; readonly detail: string; readonly step: string };

/** A failed check: what was found and the user's step. */
type Finding = { readonly detail: string; readonly step: string };

/**
 * Judges the submodules of a slot checkout.
 * @param git - Slot git.
 * @param checkout - The slot's checkout, which exists.
 * @returns `clean` with the module repositories to set aside, or `kept` with the first finding.
 */
export async function judgeSubmodules(git: SlotGit, checkout: string): Promise<SubmoduleJudgement> {
  const gitDir = (await git.text(checkout, ['rev-parse', '--absolute-git-dir'])).trim();
  const repositories: string[] = [];
  const finding = await judgeTree(git, checkout, checkout, gitDir, repositories);
  return finding === null ? { status: 'clean', repositories } : { status: 'kept', ...finding };
}

/**
 * Judges one checkout's gitlinks and its module repositories, recursing into initialized submodules.
 * @param git - Slot git.
 * @param slot - The slot checkout, for naming paths relative to it.
 * @param checkout - The checkout whose gitlinks are judged.
 * @param gitDir - That checkout's absolute git directory.
 * @param repositories - Collects every module repository found.
 * @returns The first failing check, or null.
 */
async function judgeTree(
  git: SlotGit,
  slot: string,
  checkout: string,
  gitDir: string,
  repositories: string[]
): Promise<Finding | null> {
  const modules = join(gitDir, 'modules');
  const claimed = new Set<string>();
  for (const { path, oid } of await gitlinks(git, checkout)) {
    const dir = join(checkout, path);
    const name = relative(slot, dir);
    if (!(await exists(join(dir, '.git')))) {
      // git status never reports files inside an uninitialized gitlink, so they are checked here.
      if ((await entries(dir)).length > 0)
        return {
          detail: `${name} is an uninitialized submodule directory holding files git does not track`,
          step: `move the files in ${dir} out of the slot`
        };
      continue;
    }
    const repository = await git.run(dir, ['rev-parse', '--absolute-git-dir', '--show-toplevel']);
    const [moduleDir = '', top = ''] = repository.stdout.trim().split('\n');
    if (repository.exitCode !== 0 || (await canonical(top)) !== (await canonical(dir)))
      return {
        detail: `${name} has a .git that does not open its own repository`,
        step: `copy anything wanted from ${dir}, then empty that directory`
      };
    if (!within(await canonical(modules), await canonical(moduleDir)))
      return within(await canonical(dir), await canonical(moduleDir))
        ? {
            detail: `${name} keeps its repository inside its checkout, where removing the slot deletes it unchecked`,
            // Absorbing moves the repository to modules/<name>, which an earlier initialization may still hold.
            step: (await exists(join(modules, await moduleName(git, checkout, path))))
              ? `copy anything wanted from ${dir}, then empty that directory`
              : `run \`git -C ${checkout} submodule absorbgitdirs -- ${path}\``
          }
        : {
            detail: `${name} uses the repository at ${moduleDir}, which this slot does not own`,
            step: `copy anything wanted from ${dir}, then empty that directory`
          };
    claimed.add(await canonical(moduleDir));
    const status = await git.text(dir, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all']);
    if (status.trim() !== '')
      return {
        detail: `${name} has uncommitted or untracked changes`,
        step: `commit and push them, or discard them with \`git -C ${dir} reset --hard ${oid}\` and \`git -C ${dir} clean -ffd\``
      };
    const head = (await git.text(dir, ['rev-parse', 'HEAD'])).trim();
    if (head !== oid)
      return {
        detail: `${name} is at ${head.slice(0, 12)}, not the ${oid.slice(0, 12)} the slot records`,
        step: `push any of its commits you want to keep, then run \`git -C ${dir} checkout --detach ${oid}\``
      };
    const refs = await judgeRefs(git, dir, ['-C', dir], name);
    if (refs !== null) return refs;
    const nested = await judgeTree(git, slot, dir, moduleDir, repositories);
    if (nested !== null) return nested;
  }
  for (const repository of await moduleRepositories(modules)) {
    if (claimed.has(await canonical(repository))) {
      repositories.push(repository);
      continue;
    }
    // A deinitialized or removed submodule's repository stays behind, with its own modules, and goes with the slot.
    const found = await judgeUnclaimed(git, repository, repositories);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Runs the ref checks on a module repository no checkout claims and on every repository under its `modules`.
 * @param git - Slot git.
 * @param repository - The unclaimed repository's git directory.
 * @param repositories - Collects every module repository found.
 * @returns The first failing check, or null.
 */
async function judgeUnclaimed(git: SlotGit, repository: string, repositories: string[]): Promise<Finding | null> {
  repositories.push(repository);
  // Its core.worktree names a checkout that may be gone, so git is given the repository itself as the work tree.
  const target = ['--git-dir', repository, '--work-tree', repository];
  const found = await judgeRefs(git, repository, target, `the submodule repository ${repository}`);
  if (found !== null) return found;
  for (const inner of await moduleRepositories(join(repository, 'modules'))) {
    const innerFound = await judgeUnclaimed(git, inner, repositories);
    if (innerFound !== null) return innerFound;
  }
  return null;
}

/**
 * Reads the name `.gitmodules` gives the submodule at a path, which names its directory under `modules`.
 * @param git - Slot git.
 * @param checkout - The checkout recording the submodule.
 * @param path - The submodule's path in it.
 * @returns The name; the path when `.gitmodules` names none.
 */
async function moduleName(git: SlotGit, checkout: string, path: string): Promise<string> {
  const listed = await git.run(checkout, [
    'config',
    '-f',
    '.gitmodules',
    '-z',
    '--get-regexp',
    '^submodule\\..*\\.path$'
  ]);
  for (const entry of listed.stdout.split('\0')) {
    const [key = '', value] = entry.split('\n');
    if (value === path) return key.slice('submodule.'.length, -'.path'.length);
  }
  return path;
}

/**
 * The ref checks every module repository passes: no stash, nothing that no
 * remote-tracking ref reaches, and no linked worktrees.
 * @param git - Slot git.
 * @param cwd - Where git runs.
 * @param target - How the commands in a step address the repository.
 * @param name - The repository as a detail names it.
 * @returns The first failing check, or null.
 */
async function judgeRefs(git: SlotGit, cwd: string, target: readonly string[], name: string): Promise<Finding | null> {
  const command = `git ${target.join(' ')}`;
  const stash = await git.run(cwd, [...target, 'rev-parse', '--quiet', '--verify', 'refs/stash']);
  if (stash.exitCode === 0)
    return {
      detail: `${name} has stashed changes`,
      // git stash needs a checkout; a repository no checkout claims is read and cleared through its reflog.
      step:
        target[0] === '-C'
          ? `apply or drop each entry \`${command} stash list\` shows; \`${command} stash clear\` drops them all`
          : `copy what is wanted from the entries \`${command} log -g -p refs/stash\` shows, then drop them with \`${command} update-ref -d refs/stash\``
    };
  // A remote-tracking ref is the proof a commit exists elsewhere, the same standard "pushed" uses.
  const local = (await git.text(cwd, [...target, 'rev-list', '-n1', '--all', '--not', '--remotes'])).trim();
  if (local !== '') {
    const holders = (
      await git.text(cwd, [
        ...target,
        'for-each-ref',
        '--contains',
        local,
        '--format=%(refname)',
        '--exclude=refs/remotes/**',
        'refs'
      ])
    )
      .split('\n')
      .filter((line) => line !== '');
    const branches = holders
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length));
    const [remote] = (await git.text(cwd, [...target, 'remote'])).split('\n').filter((line) => line !== '');
    const push =
      remote === undefined || branches.length === 0
        ? `push ${local.slice(0, 12)} to a remote`
        : `push it with ${branches.map((branch) => `\`${command} push ${remote} ${branch}\``).join(' and ')}`;
    return {
      detail: `${name} has commit ${local.slice(0, 12)} that no remote-tracking ref reaches${holders.length === 0 ? '' : ` (held by ${holders.join(', ')})`}`,
      step: `${push}, or delete the refs that hold it`
    };
  }
  const worktrees = (await git.text(cwd, [...target, 'worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  if (worktrees.length > 1)
    return {
      detail: `${name} has linked worktrees`,
      step: `remove the extra worktrees \`${command} worktree list\` shows`
    };
  return null;
}

/**
 * Reads a checkout's gitlinks.
 * @param git - Slot git.
 * @param checkout - The checkout whose index is read.
 * @returns Each gitlink's path and recorded commit.
 */
async function gitlinks(git: SlotGit, checkout: string): Promise<{ path: string; oid: string }[]> {
  return (await git.text(checkout, ['ls-files', '--stage', '-z']))
    .split('\0')
    .filter((entry) => entry.startsWith(`${GITLINK_MODE} `))
    .map((entry) => {
      const [meta = '', path = ''] = entry.split('\t');
      return { path, oid: meta.split(' ')[1] ?? '' };
    });
}

/**
 * Lists the module repositories directly under a `modules` directory. Module
 * names may contain slashes, so a directory that is not a repository is searched.
 * @param modules - A git directory's `modules` directory.
 * @returns The repositories' paths; none when the directory is absent.
 */
async function moduleRepositories(modules: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if ((await exists(join(dir, 'HEAD'))) && (await exists(join(dir, 'objects')))) {
      found.push(dir);
      return;
    }
    for (const entry of await entries(dir)) {
      if (entry.isDirectory()) await visit(join(dir, entry.name));
    }
  };
  if (await exists(modules)) await visit(modules);
  return found;
}

/**
 * Reads a directory's entries.
 * @param dir - The directory.
 * @returns Its entries; none when it is absent.
 */
async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Whether a path exists, without following a final symlink.
 * @param path - The path tested.
 * @returns True when it exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Resolves symlinks in a path.
 * @param path - The path, which may be absent.
 * @returns Its real path, or the path itself when absent.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Whether a path is a directory or inside it.
 * @param outer - The directory.
 * @param inner - The path tested.
 * @returns True when `inner` equals or descends from `outer`.
 */
function within(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}${sep}`);
}

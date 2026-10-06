/**
 * The submodule rule of slot cleanup. A linked worktree keeps each initialized
 * submodule's repository under its own git directory (`<gitdir>/modules/<name>`),
 * so removing the slot deletes those repositories. A slot is removable only when
 * nothing would be lost with them: every gitlink is either uninitialized with an
 * empty directory, or initialized, clean, at its recorded commit and fully
 * reachable from remote-tracking refs, recursively; and every module repository
 * no checkout claims passes the same ref checks. The rule is applied twice: to
 * the slot before its removal, and to its submodules again once the SDK's
 * quarantine has set them aside and recorded them, so nothing that changed in
 * between is deleted unjudged.
 *
 * @summary Whether a slot's submodules can be removed with it
 * @module
 */

import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SetAsideSubmodules } from '@cards.management/sdk/worktree-removal';
import type { SlotGit } from './slot-git.js';

/** Mode of a gitlink in `git ls-files --stage`. */
const GITLINK_MODE = '160000';

/** What the submodule rule found in one slot checkout. */
export type SubmoduleJudgement =
  /**
   * Nothing a removal would lose. `repositories` lists the module
   * repositories under the slot's git directory, which the SDK's quarantine
   * sets aside and deletes with the checkout; empty when there are none.
   */
  | { readonly status: 'clean'; readonly repositories: readonly string[] }
  /** Something a removal would lose, what it is, and how to resolve it. */
  | { readonly status: 'kept'; readonly detail: string; readonly step: string };

/** A failed check: what was found and the user's step. */
type Finding = { readonly detail: string; readonly step: string };

/**
 * One checkout the walk visits. While a slot is set aside its submodules'
 * `.git` files point where the repositories used to be, so git is pointed at
 * each one explicitly; details and steps name the paths a refused removal
 * restores, which are the ones the user can act on.
 */
interface Site {
  /** Where its files are now. */
  readonly dir: string;
  /** Arguments pointing git at it from `dir`; empty when its own `.git` resolves. */
  readonly target: readonly string[];
  /** Where its submodule repositories are now. */
  readonly modules: string;
  /** `dir` as details and steps name it. */
  readonly shown: string;
  /** `modules` as details and steps name it. */
  readonly shownModules: string;
  /** Where the set-aside checkout of each top-level submodule path is held; empty outside a set-aside slot. */
  readonly held: ReadonlyMap<string, string>;
}

/** How the walk opens initialized submodules, and the slot paths are named relative to. */
interface Walk {
  readonly setAside: boolean;
  readonly slot: string;
}

/**
 * Judges the submodules of a slot checkout.
 * @param git - Slot git.
 * @param checkout - The slot's checkout, which exists.
 * @returns `clean` with the module repositories the removal sets aside, or `kept` with the first finding.
 */
export async function judgeSubmodules(git: SlotGit, checkout: string): Promise<SubmoduleJudgement> {
  const gitDir = (await git.text(checkout, ['rev-parse', '--absolute-git-dir'])).trim();
  const modules = join(gitDir, 'modules');
  const site: Site = { dir: checkout, target: [], modules, shown: checkout, shownModules: modules, held: new Map() };
  return judgement(await walkTree(git, { setAside: false, slot: checkout }, site));
}

/**
 * Judges a quarantined slot's set-aside submodules by the same rule, once the
 * SDK has recorded them and before it commits the removal.
 * @param git - Slot git.
 * @param setAside - Where the quarantine holds the slot and its submodules.
 * @returns `clean`, or `kept` with the first finding, named at the slot path.
 */
export async function judgeSetAsideSubmodules(git: SlotGit, setAside: SetAsideSubmodules): Promise<SubmoduleJudgement> {
  const site: Site = {
    dir: setAside.quarantine,
    target: [],
    modules: join(setAside.area, 'modules'),
    shown: setAside.slotPath,
    shownModules: join(setAside.gitDir, 'modules'),
    held: new Map(setAside.paths.map((path, index) => [path, join(setAside.area, String(index))]))
  };
  return judgement(await walkTree(git, { setAside: true, slot: setAside.slotPath }, site));
}

/**
 * Shapes a walk's result.
 * @param walked - The first finding, or the repositories found.
 * @returns `kept` with the finding, or `clean` with the repositories.
 */
const judgement = (walked: Finding | readonly string[]): SubmoduleJudgement =>
  'detail' in walked ? { status: 'kept', ...walked } : { status: 'clean', repositories: walked };

/**
 * Judges the whole tree under a slot checkout.
 * @param git - Slot git.
 * @param walk - How submodules are opened.
 * @param site - The slot checkout.
 * @returns The first failing check, or every module repository found.
 */
async function walkTree(git: SlotGit, walk: Walk, site: Site): Promise<Finding | readonly string[]> {
  const repositories: string[] = [];
  return (await judgeTree(git, walk, site, repositories)) ?? repositories;
}

/**
 * Judges one checkout's gitlinks and its module repositories, recursing into initialized submodules.
 * @param git - Slot git.
 * @param walk - How submodules are opened.
 * @param site - The checkout whose gitlinks are judged.
 * @param repositories - Collects every module repository found.
 * @returns The first failing check, or null.
 */
async function judgeTree(git: SlotGit, walk: Walk, site: Site, repositories: string[]): Promise<Finding | null> {
  const claimed = new Set<string>();
  for (const { path, oid } of await gitlinks(git, site)) {
    const dir = site.held.get(path) ?? join(site.dir, path);
    const shown = join(site.shown, path);
    const name = relative(walk.slot, shown);
    if (!(await exists(join(dir, '.git')))) {
      // git status never reports files inside an uninitialized gitlink, so they are checked here.
      if ((await entries(dir)).length > 0)
        return {
          detail: `${name} is an uninitialized submodule directory holding files git does not track`,
          step: `move the files in ${shown} out of the slot`
        };
      continue;
    }
    const opened = walk.setAside
      ? await openSetAside(git, site, path, dir, name)
      : await openLive(git, site, path, dir, name);
    if ('detail' in opened) return opened;
    claimed.add(await canonical(opened.repository));
    const sub = opened.site;
    const status = await git.text(sub.dir, [
      ...sub.target,
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignore-submodules=all'
    ]);
    if (status.trim() !== '')
      return {
        detail: `${name} has uncommitted or untracked changes`,
        step: `commit and push them, or discard them with \`git -C ${shown} reset --hard ${oid}\` and \`git -C ${shown} clean -ffd\``
      };
    const head = (await git.text(sub.dir, [...sub.target, 'rev-parse', 'HEAD'])).trim();
    if (head !== oid)
      return {
        detail: `${name} is at ${head.slice(0, 12)}, not the ${oid.slice(0, 12)} the slot records`,
        step: `push any of its commits you want to keep, then run \`git -C ${shown} checkout --detach ${oid}\``
      };
    const refs = await judgeRefs(git, sub.dir, sub.target, ['-C', shown], name);
    if (refs !== null) return refs;
    const nested = await judgeTree(git, walk, sub, repositories);
    if (nested !== null) return nested;
  }
  for (const repository of await moduleRepositories(site.modules)) {
    if (claimed.has(await canonical(repository))) {
      repositories.push(repository);
      continue;
    }
    // A deinitialized or removed submodule's repository stays behind, with its own modules, and goes with the slot.
    const shown = join(site.shownModules, relative(site.modules, repository));
    const found = await judgeUnclaimed(git, repository, shown, repositories);
    if (found !== null) return found;
  }
  return null;
}

/** An initialized submodule opened for judging: its repository and the site of its checkout. */
type Opened = { readonly repository: string; readonly site: Site };

/**
 * Opens an initialized submodule of a live checkout through its `.git`, which
 * must open a repository of its own under the checkout's `modules`.
 * @param git - Slot git.
 * @param site - The checkout recording the submodule.
 * @param path - The submodule's path in it.
 * @param dir - The submodule's checkout.
 * @param name - The submodule as details name it.
 * @returns The opened submodule, or the finding that refuses it.
 */
async function openLive(git: SlotGit, site: Site, path: string, dir: string, name: string): Promise<Opened | Finding> {
  const repository = await git.run(dir, ['rev-parse', '--absolute-git-dir', '--show-toplevel']);
  const [moduleDir = '', top = ''] = repository.stdout.trim().split('\n');
  if (repository.exitCode !== 0 || (await canonical(top)) !== (await canonical(dir)))
    return {
      detail: `${name} has a .git that does not open its own repository`,
      step: `copy anything wanted from ${dir}, then empty that directory`
    };
  if (!within(await canonical(site.modules), await canonical(moduleDir)))
    return within(await canonical(dir), await canonical(moduleDir))
      ? await embedded(git, site, path, name)
      : {
          detail: `${name} uses the repository at ${moduleDir}, which this slot does not own`,
          step: `copy anything wanted from ${dir}, then empty that directory`
        };
  const modules = join(moduleDir, 'modules');
  return {
    repository: moduleDir,
    site: { dir, target: [], modules, shown: dir, shownModules: modules, held: new Map() }
  };
}

/**
 * Opens an initialized submodule of a set-aside slot. Its `.git` file still
 * points where the repository was before the set-aside, so the repository is
 * found by the submodule's name under the set-aside `modules` instead. A `.git`
 * directory is a repository inside the checkout, judged as in a live slot; a
 * `.git` file pointing anywhere else loses nothing, because only the
 * repository found here is deleted with the slot.
 * @param git - Slot git.
 * @param site - The checkout recording the submodule.
 * @param path - The submodule's path in it.
 * @param dir - The submodule's checkout, where it is held now.
 * @param name - The submodule as details name it.
 * @returns The opened submodule, or the finding that refuses it.
 */
async function openSetAside(
  git: SlotGit,
  site: Site,
  path: string,
  dir: string,
  name: string
): Promise<Opened | Finding> {
  if ((await lstat(join(dir, '.git'))).isDirectory()) return await embedded(git, site, path, name);
  const named = await moduleName(git, site, path);
  const moduleDir = join(site.modules, named);
  const shown = join(site.shown, path);
  if (!(await isRepository(moduleDir)))
    return {
      detail: `${name} has a .git that does not open its own repository`,
      step: `copy anything wanted from ${shown}, then empty that directory`
    };
  const shownRepository = join(site.shownModules, named);
  return {
    repository: moduleDir,
    site: {
      dir,
      target: ['--git-dir', moduleDir, '--work-tree', dir],
      modules: join(moduleDir, 'modules'),
      shown,
      shownModules: join(shownRepository, 'modules'),
      held: new Map()
    }
  };
}

/**
 * The finding for a submodule whose repository is inside its own checkout.
 * @param git - Slot git.
 * @param site - The checkout recording the submodule.
 * @param path - The submodule's path in it.
 * @param name - The submodule as details name it.
 * @returns The finding.
 */
async function embedded(git: SlotGit, site: Site, path: string, name: string): Promise<Finding> {
  const shown = join(site.shown, path);
  return {
    detail: `${name} keeps its repository inside its checkout, where removing the slot deletes it unchecked`,
    // Absorbing moves the repository to modules/<name>, which an earlier initialization may still hold.
    step: (await exists(join(site.modules, await moduleName(git, site, path))))
      ? `copy anything wanted from ${shown}, then empty that directory`
      : `run \`git -C ${site.shown} submodule absorbgitdirs -- ${path}\``
  };
}

/**
 * Runs the ref checks on a module repository no checkout claims and on every repository under its `modules`.
 * @param git - Slot git.
 * @param repository - The unclaimed repository's git directory.
 * @param shown - That directory as details and steps name it.
 * @param repositories - Collects every module repository found.
 * @returns The first failing check, or null.
 */
async function judgeUnclaimed(
  git: SlotGit,
  repository: string,
  shown: string,
  repositories: string[]
): Promise<Finding | null> {
  repositories.push(repository);
  // Its core.worktree names a checkout that may be gone, so git is given the repository itself as the work tree.
  const found = await judgeRefs(
    git,
    repository,
    ['--git-dir', repository, '--work-tree', repository],
    ['--git-dir', shown, '--work-tree', shown],
    `the submodule repository ${shown}`
  );
  if (found !== null) return found;
  const modules = join(repository, 'modules');
  for (const inner of await moduleRepositories(modules)) {
    const innerFound = await judgeUnclaimed(git, inner, join(shown, 'modules', relative(modules, inner)), repositories);
    if (innerFound !== null) return innerFound;
  }
  return null;
}

/**
 * Reads the name `.gitmodules` gives the submodule at a path, which names its directory under `modules`.
 * @param git - Slot git.
 * @param site - The checkout recording the submodule.
 * @param path - The submodule's path in it.
 * @returns The name; the path when `.gitmodules` names none.
 */
async function moduleName(git: SlotGit, site: Site, path: string): Promise<string> {
  const listed = await git.run(site.dir, [
    ...site.target,
    'config',
    '-f',
    join(site.dir, '.gitmodules'),
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
 * @param target - Arguments pointing git at the repository from `cwd`.
 * @param shown - How the commands in a step address the repository.
 * @param name - The repository as a detail names it.
 * @returns The first failing check, or null.
 */
async function judgeRefs(
  git: SlotGit,
  cwd: string,
  target: readonly string[],
  shown: readonly string[],
  name: string
): Promise<Finding | null> {
  const command = `git ${shown.join(' ')}`;
  const stash = await git.run(cwd, [...target, 'rev-parse', '--quiet', '--verify', 'refs/stash']);
  if (stash.exitCode === 0)
    return {
      detail: `${name} has stashed changes`,
      // git stash needs a checkout; a repository no checkout claims is read and cleared through its reflog.
      step:
        shown[0] === '-C'
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
 * @param site - The checkout whose index is read.
 * @returns Each gitlink's path and recorded commit.
 */
async function gitlinks(git: SlotGit, site: Site): Promise<{ path: string; oid: string }[]> {
  return (await git.text(site.dir, [...site.target, 'ls-files', '--stage', '-z']))
    .split('\0')
    .filter((entry) => entry.startsWith(`${GITLINK_MODE} `))
    .map((entry) => {
      const [meta = '', path = ''] = entry.split('\t');
      return { path, oid: meta.split(' ')[1] ?? '' };
    });
}

/**
 * Whether a directory is a git repository.
 * @param dir - The directory.
 * @returns True when it holds `HEAD` and `objects`.
 */
async function isRepository(dir: string): Promise<boolean> {
  return (await exists(join(dir, 'HEAD'))) && (await exists(join(dir, 'objects')));
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
    if (await isRepository(dir)) {
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

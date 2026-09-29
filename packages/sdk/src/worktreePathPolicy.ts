/**
 * Loads the authoritative worktree path policy for one worktree creation.
 *
 * Reads `.worktreeignore` and `.worktreeinclude` from the source root — both
 * gitignore syntax, parsed with the `ignore` library — and classifies every
 * git-ignored path into one of three decisions made before any ignored path is
 * provisioned into the worktree:
 *
 * - `omit` — matched by `.worktreeignore`; never provisioned.
 * - `copy` — matched by `.worktreeinclude`; copied as a real file into the
 *   worktree, and any ignored ancestor directory is prevented from being
 *   symlinked.
 * - `share` — the default for unmatched ignored paths; symlinked into the
 *   worktree.
 *
 * Omit wins over copy. Matching sees through symlinked directories: the
 * descendants of git-ignored symlink entries (the workspaces node_modules
 * shape) AND of TRACKED symlink entries under node_modules subtrees (links
 * committed with `git add -f`, which the git-ignored enumeration never
 * reports) are synthesized so rules addressing a package's interior match
 * and the rerouter materializes the package instead of recreating the link.
 * The TRACKED phase is scoped to exactly the node_modules trees the rerouter
 * owns — root `node_modules` plus each glob-matched workspace package's
 * `node_modules`, both derived from `package.json` `workspaces` — and a
 * TRACKED node_modules-segment symlink outside those trees fails closed
 * naming the path: no pass can enforce a rule on it, and the checkout's link
 * left in place would let worktree-side writes reach the source.
 * The policy fails closed: a readable-but-invalid, unreadable, or otherwise
 * unprocessable config file — or an enumeration phase that outlives its
 * shared fail-closed deadline — surfaces as a {@link WorktreeIncludeError}
 * before any matching source path can be linked into the destination. The
 * deadline budget defaults to 30000ms and is configurable via the
 * `CARDS_WORKTREE_POLICY_TIMEOUT_MS` environment variable (milliseconds;
 * the timeout message names it when a budget is exceeded).
 * Repository-relative paths stay normalized to POSIX form (forward slashes)
 * at the boundary.
 *
 * @summary `.worktreeignore`/`.worktreeinclude` path policy for worktree creation
 * @module worktreePathPolicy
 */

import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
import { WorktreeIncludeError } from './worktreeInclude.js';

/**
 * The three-way decision every git-ignored path receives before worktree
 * provisioning:
 *
 * - `omit` — never provisioned (matched by `.worktreeignore`).
 * - `copy` — copied as a real file into the worktree (matched by
 *   `.worktreeinclude`).
 * - `share` — symlinked into the worktree (the default for unmatched ignored
 *   paths).
 */
export type WorktreePathDecision = 'omit' | 'copy' | 'share';

/**
 * Pattern lines configured in `.worktreeignore` (gitignore syntax).
 *
 * Omitted paths are never provisioned into the worktree. Directory patterns
 * cover their descendants, and negation (`!` lines) re-includes paths exactly
 * as the `ignore` library applies gitignore precedence.
 */
export type WorktreeIgnorePatterns = string[];

/**
 * Pattern lines configured in `.worktreeinclude` (gitignore syntax).
 *
 * Matching git-ignored paths are copied into the worktree as real files rather
 * than shared via symlink.
 */
export type WorktreeIncludePatterns = string[];

/**
 * Repository-relative ignored paths normalized to POSIX form, split by
 * collapsed directory versus standalone file entries.
 *
 * Mirrors the output shape of `discoverIgnoredPaths`: fully-ignored
 * directories appear once as `directories` entries (no trailing slash) with
 * their descendants elided, and `files` holds the ignored files not nested
 * under a collapsed directory entry.
 */
export interface WorktreeIgnoredPaths {
  /** Fully-ignored directory entries (no trailing slash). */
  readonly directories: string[];
  /** Ignored files not nested under a collapsed directory entry. */
  readonly files: string[];
}

/**
 * The narrow per-path decision query that provisioning steps consume instead
 * of re-implementing pattern matching.
 *
 * The node_modules rerouter accepts this query object — or the full
 * {@link WorktreePathPolicy}, which satisfies it — so specialized provisioning
 * cannot bypass the repository policy.
 */
export interface WorktreePathQuery {
  /**
   * Classifies any repository-relative POSIX path as omit, copy, or share.
   *
   * The decision is pattern-based: a path is `omit` when it (or any ancestor)
   * matches `.worktreeignore`, `copy` when it is a copied path or an ancestor
   * of one, and `share` otherwise. Rerouting and symlink producers consult
   * this query instead of re-implementing pattern matching, so a descendant
   * such as `node_modules/.vite` that the policy omits or copies is never
   * symlinked. Backslashes are normalized to forward slashes.
   */
  readonly classify: (relativePath: string) => WorktreePathDecision;
  /**
   * Whether `relativePath` is a strict ancestor directory of a
   * matcher-matched omitted path.
   *
   * `classify`'s omit branch is matcher-direct: a file-level pattern such as
   * `node_modules/pkgA/.cache/x.js` matches only the path itself, so its
   * ancestor directories classify `share`. Steps that must never expose an
   * omitted path to worktree-side writes — the node_modules rerouter —
   * consult this to materialize such ancestors as real directories with
   * per-entry decisions instead of symlinking them wholesale. The ancestor
   * set covers omitted interiors of TRACKED symlink entries too (committed
   * node_modules links), so the rerouter materializes those packages as well
   * instead of recreating the checkout's link. Backslashes are normalized to
   * forward slashes.
   */
  readonly isOmitAncestor: (relativePath: string) => boolean;
}

/**
 * The immutable path policy for one worktree creation.
 *
 * Built once from the authoritative collapsed ignored-path input and handed to
 * every downstream provisioning step — symlink creation, include copying,
 * exclude-file writing, and node_modules rerouting — so all of them make the
 * same path decision. Matching is deterministic with omit before copy before
 * share.
 */
export interface WorktreePathPolicy extends WorktreePathQuery {
  /** Pattern lines configured in `.worktreeignore`. */
  readonly ignorePatterns: WorktreeIgnorePatterns;
  /** Pattern lines configured in `.worktreeinclude`. */
  readonly includePatterns: WorktreeIncludePatterns;
  /**
   * Ignored paths omitted from the worktree (matched by `.worktreeignore`).
   * A collapsed ignored directory appears here wholesale when any of its
   * descendants match — a symlink cannot expose part of a directory — unless
   * a descendant is selected for copy, which materializes the directory as a
   * real tree where per-file omission applies. Omit wins over copy for paths
   * matching both config files.
   */
  readonly omit: string[];
  /**
   * Ignored paths copied into the worktree as real files (matched by
   * `.worktreeinclude` and not omitted), including interior paths of
   * symlinked node_modules packages — both git-ignored links and TRACKED
   * links (committed with `git add -f`), whose interiors the git-ignored
   * enumeration never reports. Any ignored ancestor directory of a copied
   * path is prevented from being symlinked.
   */
  readonly copy: string[];
  /**
   * Ignored paths shared into the worktree as symlinks: the collapsed
   * ignored-path input minus omitted paths, copied paths, and every collapsed
   * directory that contains a copied descendant. Unmatched ignored siblings
   * under a copied-parent directory remain absent.
   */
  readonly share: WorktreeIgnoredPaths;
}

/**
 * Default upper bound for one `git ls-files` call and the shared fail-closed
 * budget for the policy's whole enumeration phase.
 *
 * Each individual `git ls-files` call gets this much time before it is killed
 * (a hung git — network filesystem, stuck index — must fail closed rather
 * than hang worktree settle forever, matching the 30s timeout
 * `discoverIgnoredPaths` uses for the same full-tree scan). The same window,
 * measured from the start of the enumeration phase, is the single deadline
 * that bounds every phase of that phase — candidate discovery, Git eligibility
 * checking, the tracked-symlink scan, the owned-workspace walk, and the
 * see-through synthesis walks all share it, so "30s bounds the overall enumeration" is
 * actually true. Expiry throws {@link WorktreeIncludeError}; the policy fails
 * closed and never truncates, which would silently drop omit entries.
 */
const DEFAULT_ENUMERATION_TIMEOUT_MS = 30_000;

/**
 * Environment variable that overrides the enumeration budget in
 * milliseconds. An invalid (non-positive) value fails the policy load closed
 * with the variable named, so a mistyped override can never silently shrink
 * or disable the deadline.
 */
const ENUMERATION_TIMEOUT_ENV = 'CARDS_WORKTREE_POLICY_TIMEOUT_MS';

/**
 * Resolves the enumeration budget from the environment at policy-load time.
 *
 * Reads {@link ENUMERATION_TIMEOUT_ENV} (default
 * {@link DEFAULT_ENUMERATION_TIMEOUT_MS}) so an operator with a slow
 * enumeration — a huge tree, a network filesystem — can raise the budget
 * without touching code. A set-but-invalid value rejects with
 * {@link WorktreeIncludeError} naming the variable instead of silently using
 * the default.
 *
 * @returns The budget in milliseconds.
 * @throws {WorktreeIncludeError} When the variable is set to a non-positive
 *   or non-numeric value.
 */
function resolveEnumerationTimeoutMs(): number {
  const raw = process.env[ENUMERATION_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_ENUMERATION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new WorktreeIncludeError(
      `Invalid ${ENUMERATION_TIMEOUT_ENV} value "${raw}": expected a positive number of milliseconds (default ${DEFAULT_ENUMERATION_TIMEOUT_MS})`
    );
  }
  return parsed;
}

/**
 * Fails closed when the shared enumeration deadline has passed.
 *
 * The deadline is one epoch-ms budget created at the start of the
 * enumeration phase and threaded through every git call and every synthesis
 * walk. Any phase that outlives it rejects with {@link WorktreeIncludeError}
 * — consistent with the per-call `git ls-files` timeout's fail-closed
 * contract — instead of truncating, which would silently drop omit entries
 * for large trees. The message names the remedy: raising
 * {@link ENUMERATION_TIMEOUT_ENV} (default
 * {@link DEFAULT_ENUMERATION_TIMEOUT_MS}) gives the enumeration more budget.
 *
 * @param deadline - Epoch-ms deadline from the start of the enumeration phase.
 * @throws {WorktreeIncludeError} When `Date.now()` exceeds `deadline`.
 */
function assertBeforeDeadline(deadline: number): void {
  if (Date.now() > deadline) {
    throw new WorktreeIncludeError(
      `Worktree path policy enumeration timed out; raise the ${ENUMERATION_TIMEOUT_ENV} environment variable (default ${DEFAULT_ENUMERATION_TIMEOUT_MS} ms) to allow a larger budget`
    );
  }
}

/**
 * Runs `git ls-files` and returns null-delimited stdout entries.
 *
 * `--literal-pathspecs` precedes the subcommand so pathspec arguments such as
 * a `:`-prefixed directory name are taken literally instead of being parsed as
 * pathspec magic (which makes the enumeration silently return nothing).
 *
 * The call shares the enumeration phase's fail-closed deadline: a call that
 * would start after the deadline expired is rejected immediately instead of
 * running, so the git phases and the synthesis walks draw from the same
 * budget.
 *
 * @param cwd - Directory to run the command from.
 * @param args - Arguments passed after `ls-files`.
 * @param deadline - Shared enumeration deadline (epoch ms).
 * @param timeoutMs - Per-call kill budget in milliseconds (the configured
 *   enumeration budget).
 * @returns Array of relative paths (no trailing NUL).
 * @throws {WorktreeIncludeError} When git fails, cannot be spawned, does not
 *   finish within `timeoutMs`, or starts after the shared enumeration
 *   `deadline`.
 */
function gitLsFiles(cwd: string, args: string[], deadline: number, timeoutMs: number): Promise<string[]> {
  assertBeforeDeadline(deadline);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--literal-pathspecs', 'ls-files', ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const remainingMs = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new WorktreeIncludeError(
          `git ls-files timed out during worktree policy enumeration; raise the ${ENUMERATION_TIMEOUT_ENV} environment variable (default ${DEFAULT_ENUMERATION_TIMEOUT_MS} ms) to allow a larger budget`
        )
      );
    }, remainingMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (code === 0) {
        try {
          assertBeforeDeadline(deadline);
          resolve(stdout ? stdout.split('\0').filter(Boolean) : []);
        } catch (error) {
          reject(error);
        }
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        reject(new WorktreeIncludeError(`git ls-files failed (exit ${String(code)}): ${stderr}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new WorktreeIncludeError(`git ls-files spawn failed: ${err.message}`, { cause: err }));
    });
  });
}

/** A policy candidate found beneath one collapsed ignored directory. */
interface PolicyCandidate {
  readonly path: string;
  readonly directoryIndex: number;
}

/**
 * Walks collapsed ignored directories once, retaining only paths that the
 * policy could select and symlinks whose interiors may contain selected paths.
 * `Dirent` supplies the file type without an `lstat` for every installed file.
 * Git eligibility is checked in one batch after the walk, so untracked files
 * re-included by a nested `.gitignore` cannot enter the copy or omit sets.
 *
 * The bounded breadth-first walk avoids one Git process per ignored directory
 * and avoids an unbounded wave of filesystem calls in a large node_modules.
 *
 * @param sourceRoot - Source checkout root.
 * @param directories - Collapsed ignored directories from the initial scan.
 * @param omitMatcher - Selects paths whose presence would expose source writes.
 * @param includeMatcher - Selects paths that need worktree-local copies.
 * @param deadline - Shared policy enumeration deadline.
 * @returns Matching path candidates and symlink entries, with owning directory indexes.
 */
async function collectPolicyCandidates(
  sourceRoot: string,
  directories: readonly string[],
  omitMatcher: ReturnType<typeof ignore>,
  includeMatcher: ReturnType<typeof ignore>,
  deadline: number
): Promise<{ matches: PolicyCandidate[]; symlinks: PolicyCandidate[] }> {
  const matches: PolicyCandidate[] = [];
  const symlinks: PolicyCandidate[] = [];
  let frontier = directories.map((dir, directoryIndex) => ({ path: dir, directoryIndex }));

  while (frontier.length > 0) {
    const next: PolicyCandidate[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < frontier.length) {
        const parent = frontier[cursor++];
        if (parent === undefined) break;
        assertBeforeDeadline(deadline);
        let children: Dirent[];
        try {
          children = await fs.readdir(path.join(sourceRoot, parent.path), { withFileTypes: true });
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') continue;
          throw error;
        }
        // Git reports a nested repository as one directory entry, even when
        // its containing directory is ignored. Entering it would select files
        // that `git ls-files --ignored --others` never reports.
        if (children.some((child) => child.name === '.git')) {
          const boundary = { path: `${parent.path}/`, directoryIndex: parent.directoryIndex };
          if (omitMatcher.ignores(boundary.path) || includeMatcher.ignores(boundary.path)) {
            matches.push(boundary);
          }
          continue;
        }
        for (const child of children) {
          assertBeforeDeadline(deadline);
          const candidate = { path: `${parent.path}/${child.name}`, directoryIndex: parent.directoryIndex };
          if (child.isDirectory()) {
            next.push(candidate);
          } else {
            if (child.isSymbolicLink()) symlinks.push(candidate);
            if (omitMatcher.ignores(candidate.path) || includeMatcher.ignores(candidate.path)) {
              matches.push(candidate);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(32, frontier.length) }, () => worker()));
    frontier = next;
  }
  return { matches, symlinks };
}

/**
 * Confirms candidate paths against Git's standard ignore rules and index in
 * one process. `git check-ignore` excludes tracked paths by default and
 * understands nested .gitignore, info/exclude, and global excludes. Exit 1
 * means none of the candidates is ignored; other failures fail closed.
 *
 * @param sourceRoot - Source checkout root.
 * @param candidates - Repository-relative paths to query.
 * @param deadline - Shared policy enumeration deadline.
 * @returns Candidate paths Git confirms are ignored and untracked.
 */
async function checkIgnoredCandidates(
  sourceRoot: string,
  candidates: readonly string[],
  deadline: number
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  assertBeforeDeadline(deadline);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '--stdin', '-z'], {
      cwd: sourceRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdin.on('error', (error) =>
      reject(new WorktreeIncludeError(`git check-ignore input failed: ${error.message}`, { cause: error }))
    );
    const remainingMs = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new WorktreeIncludeError(
          `git check-ignore timed out; raise ${ENUMERATION_TIMEOUT_ENV} to allow a larger budget`
        )
      );
    }, remainingMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) {
        try {
          assertBeforeDeadline(deadline);
          resolve(
            new Set(
              Buffer.concat(stdoutChunks)
                .toString('utf8')
                .split('\0')
                .filter(Boolean)
                .map((entry) => entry.slice(2))
            )
          );
        } catch (error) {
          reject(error);
        }
      } else {
        reject(
          new WorktreeIncludeError(
            `git check-ignore failed (exit ${String(code)}): ${Buffer.concat(stderrChunks).toString('utf8')}`
          )
        );
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new WorktreeIncludeError(`git check-ignore spawn failed: ${error.message}`, { cause: error }));
    });
    // A leading "./" keeps a filename such as ":foo" out of Git's pathspec
    // magic parser. check-ignore does not support --literal-pathspecs.
    child.stdin.end(Buffer.from(`${candidates.map((candidate) => `./${candidate}`).join('\0')}\0`));
  });
}

/**
 * Visits the repo-relative descendants of a directory, seeing through
 * symlinked children whose target resolves to a directory.
 *
 * Every child path is reported in checkout form (`<prefix>/<name>`), whether
 * or not it is descended into, because the path exists in the checkout either
 * way. Directories are never revisited: each entered directory's realpath is
 * recorded before its children are walked, so a symlink cycle (a link that
 * resolves back to an ancestor) terminates on the second encounter and a
 * diamond-shaped link topology synthesizes each subtree once.
 *
 * The walk is bounded by the shared enumeration deadline: the deadline is
 * checked before each directory is entered and before each child is appended,
 * so a walk that outlives the budget rejects fail-closed instead of running
 * unbounded. The per-call `git ls-files` timeout cannot interrupt this
 * recursion — it already resolved before the walk starts — so the deadline
 * is the walk's only bound.
 *
 * @param absDir - Absolute directory whose children are visited.
 * @param prefix - Repo-relative POSIX path of `absDir` in the checkout.
 * @param visited - Realpaths of directories already entered on this walk.
 * @param onEntry - Receives each discovered descendant path.
 * @param deadline - Shared enumeration deadline (fail-closed).
 */
async function walkSymlinkedDirectory(
  absDir: string,
  prefix: string,
  visited: Set<string>,
  onEntry: (relativePath: string) => void,
  deadline: number
): Promise<void> {
  assertBeforeDeadline(deadline);
  let realDir: string;
  try {
    realDir = await fs.realpath(absDir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // A dangling link or vanished directory contributes nothing, matching
    // git's own tolerance for unreadable ignored content.
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let children: Dirent[];
  try {
    children = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }

  await Promise.all(
    children.map(async (child): Promise<void> => {
      assertBeforeDeadline(deadline);
      const childRel = `${prefix}/${child.name}`;
      onEntry(childRel);
      if (child.isSymbolicLink()) {
        const childAbs = path.join(absDir, child.name);
        let childTarget: string;
        try {
          childTarget = await fs.readlink(childAbs);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        await walkSymlinkedDirectory(path.resolve(absDir, childTarget), childRel, visited, onEntry, deadline);
      } else if (child.isDirectory()) {
        await walkSymlinkedDirectory(path.join(absDir, child.name), childRel, visited, onEntry, deadline);
      }
    })
  );
}

/**
 * Finds policy matches inside symlinked directories without retaining their
 * unmatched descendants.
 *
 * Git cannot report paths inside a symlinked directory: for the workspaces
 * shape — node_modules entries are links into packages/ — it reports
 * `node_modules/pkgA` but nothing under it, so a policy rule
 * addressing `node_modules/pkgA/.cache/x.js` would otherwise match nothing and
 * the omit/copy decisions for the package's interior would silently no-op. For
 * each entry that is a symlink (decided by lstat, which does not follow links)
 * whose resolved target is a directory, the target is walked recursively with
 * `walkSymlinkedDirectory`, matching descendants as `<entry>/<child>` paths —
 * exactly the paths as seen in the checkout. The cycle guard bounds
 * the walk on pathological link topologies, and the shared enumeration
 * deadline — one fail-closed budget of `CARDS_WORKTREE_POLICY_TIMEOUT_MS`
 * (default 30000) measured from the start of the enumeration phase, covering
 * candidate discovery, Git checks, and synthesis walks — bounds the overall
 * enumeration.
 * The `git ls-files` timeout itself cannot bound this walk: it only guards
 * the git subprocess, which resolves before the walk begins. Expiry throws
 * {@link WorktreeIncludeError} (fail closed, never truncating — truncation
 * would silently drop omit entries for large trees).
 *
 * @param sourceRoot - Source checkout root.
 * @param entries - Eligible ignored or tracked symlink paths.
 * @param omitMatcher - Selects descendants that must remain absent.
 * @param includeMatcher - Selects descendants that must be copied.
 * @param deadline - Shared enumeration deadline (fail-closed).
 * @returns Matched descendants only.
 */
async function matchSymlinkedDescendants(
  sourceRoot: string,
  entries: string[],
  omitMatcher: ReturnType<typeof ignore>,
  includeMatcher: ReturnType<typeof ignore>,
  deadline: number
): Promise<{ omitMatches: string[]; copyMatches: string[] }> {
  const omitMatches: string[] = [];
  const copyMatches: string[] = [];
  await Promise.all(
    entries.map(async (entry): Promise<void> => {
      assertBeforeDeadline(deadline);
      const linkAbs = path.join(sourceRoot, entry);
      let linkStats: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        linkStats = await fs.lstat(linkAbs);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (!linkStats.isSymbolicLink()) return;

      let target: string;
      try {
        target = await fs.readlink(linkAbs);
      } catch (error: unknown) {
        // Deleted between lstat and readlink.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }

      const resolvedTarget = path.resolve(path.dirname(linkAbs), target);
      let targetStats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        targetStats = await fs.stat(resolvedTarget);
      } catch (error: unknown) {
        // Dangling link or vanished target: nothing to synthesize.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          return;
        }
        throw error;
      }
      if (!targetStats.isDirectory()) return;

      // One walk per entry: two links to the same realpath are two distinct
      // checkout paths, each of which the user's patterns may address.
      const visited = new Set<string>();
      await walkSymlinkedDirectory(
        resolvedTarget,
        entry,
        visited,
        (candidate) => {
          if (omitMatcher.ignores(candidate)) {
            omitMatches.push(candidate);
          } else if (includeMatcher.ignores(candidate)) {
            copyMatches.push(candidate);
          }
        },
        deadline
      );
    })
  );
  assertBeforeDeadline(deadline);
  return { omitMatches, copyMatches };
}

/**
 * Builds only the matches needed by the policy's consumers beneath collapsed
 * ignored directories. Git validates real-file and symlink candidates before
 * any symlink interior is synthesized; interiors inherit the eligibility of
 * their ignored symlink, as in the original Git enumeration.
 *
 * @param sourceRoot - Source checkout root.
 * @param directories - Collapsed ignored directories.
 * @param omitMatcher - Selects descendants that prevent sharing their ancestor.
 * @param includeMatcher - Selects descendants for the copy executor.
 * @param deadline - Shared enumeration deadline.
 * @returns Match lists aligned with the collapsed directory input.
 */
async function enumerateIgnoredPolicyMatches(
  sourceRoot: string,
  directories: readonly string[],
  omitMatcher: ReturnType<typeof ignore>,
  includeMatcher: ReturnType<typeof ignore>,
  deadline: number
): Promise<Array<{ dir: string; omitMatches: string[]; copyMatches: string[] }>> {
  const matchesByDir = directories.map((dir) => ({ dir, omitMatches: [] as string[], copyMatches: [] as string[] }));
  const candidates = await collectPolicyCandidates(sourceRoot, directories, omitMatcher, includeMatcher, deadline);
  const eligibility = await checkIgnoredCandidates(
    sourceRoot,
    [...new Set([...candidates.matches, ...candidates.symlinks].map((entry) => entry.path))],
    deadline
  );

  for (const candidate of candidates.matches) {
    if (!eligibility.has(candidate.path)) continue;
    const owner = matchesByDir[candidate.directoryIndex];
    if (owner === undefined) continue;
    if (omitMatcher.ignores(candidate.path)) {
      owner.omitMatches.push(candidate.path);
    } else if (includeMatcher.ignores(candidate.path)) {
      owner.copyMatches.push(candidate.path);
    }
  }

  for (const symlink of candidates.symlinks) {
    if (!eligibility.has(symlink.path)) continue;
    const owner = matchesByDir[symlink.directoryIndex];
    if (owner === undefined) continue;
    const interior = await matchSymlinkedDescendants(sourceRoot, [symlink.path], omitMatcher, includeMatcher, deadline);
    owner.omitMatches.push(...interior.omitMatches);
    owner.copyMatches.push(...interior.copyMatches);
  }

  for (const owner of matchesByDir) {
    owner.omitMatches.sort();
    owner.copyMatches.sort();
  }
  assertBeforeDeadline(deadline);
  return matchesByDir;
}

/**
 * Whether a repository-relative path lies inside an owned node_modules tree.
 *
 * A path is covered when it equals the owned tree itself (a tracked link AT
 * `node_modules`, the workspace shape force-added) or sits below it. The
 * prefix check is segment-exact (`node_modulesX/...` is not under
 * `node_modules`), so ownership never bleeds into lookalike directories.
 *
 * @param rel - Repository-relative POSIX path of a tracked entry.
 * @param ownedNodeModules - Repo-relative node_modules trees the rerouter owns.
 * @returns True when `rel` is at or below an owned tree.
 */
function isUnderOwnedNodeModules(rel: string, ownedNodeModules: string[]): boolean {
  return ownedNodeModules.some((owned) => rel === owned || rel.startsWith(`${owned}/`));
}

/**
 * Reads the package.json `workspaces` globs and walks the filesystem to find
 * the node_modules trees the node_modules rerouter owns — root `node_modules`
 * plus one `<glob-matched package dir>/node_modules` per existing package
 * directory — so the policy's TRACKED phase covers exactly what the reroute
 * walk can act on.
 *
 * The mirror (`enumerateReroutedNodeModules` in `worktree.ts`) derives its
 * ownership from this same function, so policy coverage and mirror reach agree
 * by construction instead of each maintaining their own idea of a workspace
 * (the historical hardcoded `packages/*` one-level shape silently excluded
 * globs like `apps/*` or `libs/*`). Supports both array-form declarations and
 * Yarn's object form with a `packages` array. Returns `[]` when `package.json`
 * is absent or has no `workspaces` field, mirroring the rerouter's early-return
 * behavior.
 *
 * The walk is bounded by the shared enumeration deadline when one is supplied
 * (the policy phase), so an out-of-control glob walk fails closed instead of
 * eating the whole budget; the mirror calls without a deadline.
 *
 * @param sourceRoot - Source checkout root holding `package.json`.
 * @param deadline - Optional shared enumeration deadline (fail-closed).
 * @returns Repo-relative node_modules trees the rerouter will own.
 * @throws {Error} When `package.json` exists but is unparsable.
 */
export async function enumerateOwnedNodeModules(sourceRoot: string, deadline?: number): Promise<string[]> {
  let packageJson: { workspaces?: unknown };
  try {
    const packageJsonContent = await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf-8');
    packageJson = JSON.parse(packageJsonContent);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const workspaces = packageJson.workspaces;
  if (workspaces === undefined) return [];
  const globs = workspaceGlobs(workspaces);

  const owned = ['node_modules'];
  for (const packageDir of await expandWorkspacePackageDirs(sourceRoot, globs, deadline)) {
    const nm = `${packageDir}/node_modules`;
    try {
      await fs.lstat(path.join(sourceRoot, nm));
      owned.push(nm);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return owned;
}

/**
 * Expands the workspace package directories declared by a checkout's root
 * package manifest.
 *
 * Both Yarn forms are accepted: `workspaces: ['packages/*']` and
 * `workspaces: { packages: ['packages/*'] }`. Directories are returned in
 * repository-relative POSIX form and are resolved against this checkout, so
 * callers can map package names to the matching destination paths.
 *
 * @param sourceRoot - Checkout root holding `package.json`.
 * @param deadline - Optional shared enumeration deadline (fail-closed).
 * @returns Existing package directories from the declared workspace globs.
 * @throws {Error} When `package.json` exists but is unreadable or unparsable.
 */
export async function enumerateWorkspacePackageDirs(sourceRoot: string, deadline?: number): Promise<string[]> {
  let packageJson: { workspaces?: unknown };
  try {
    packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf-8'));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  if (packageJson.workspaces === undefined) return [];
  return expandWorkspacePackageDirs(sourceRoot, workspaceGlobs(packageJson.workspaces), deadline);
}

/**
 * Extracts workspace glob strings from either supported Yarn manifest shape.
 *
 * @param workspaces - The root package.json `workspaces` value.
 * @returns Valid string globs; malformed entries do not become filesystem paths.
 */
function workspaceGlobs(workspaces: unknown): string[] {
  const entries = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === 'object' &&
        workspaces !== null &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
      ? (workspaces as { packages: unknown[] }).packages
      : [];
  return entries.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Expands a `workspaces` glob list to the existing package directories it
 * matches.
 *
 * Positive globs contribute matches; `!`-prefixed globs subtract them (yarn
 * negation semantics). Each glob is walked segment by segment under
 * `sourceRoot`: literal segments descend directly, glob segments (anything
 * with `*`, `?`, or `[...]` — including a bare `*` for one directory level)
 * read the directory and keep the entries the segment pattern matches, and a
 * full `**` segment matches zero or more levels recursively. The walk never
 * descends into `node_modules` unless a glob explicitly names it, so a huge
 * installed tree cannot be walked by accident.
 *
 * @param sourceRoot - Source checkout root to walk.
 * @param globs - Workspaces glob patterns from `package.json`.
 * @param deadline - Optional shared enumeration deadline (fail-closed).
 * @returns Repo-relative package directories matching the globs (deduplicated).
 */
async function expandWorkspacePackageDirs(sourceRoot: string, globs: string[], deadline?: number): Promise<string[]> {
  const positive: string[] = [];
  const negative: string[] = [];
  for (const glob of globs) {
    if (glob.startsWith('!')) {
      negative.push(glob.slice(1));
    } else {
      positive.push(glob);
    }
  }

  const matched = new Set<string>();
  for (const glob of positive) {
    for (const dir of await walkWorkspaceGlob(sourceRoot, glob, deadline)) {
      matched.add(dir);
    }
  }
  for (const glob of negative) {
    for (const dir of await walkWorkspaceGlob(sourceRoot, glob, deadline)) {
      matched.delete(dir);
    }
  }
  return [...matched];
}

/**
 * Lists the existing child directories of `absDir`, treating a missing or
 * non-directory parent as an empty listing.
 *
 * @param absDir - Absolute directory whose children are listed.
 * @returns The directory children as `Dirent` entries.
 */
async function readDirDirs(absDir: string): Promise<Dirent[]> {
  let children: Dirent[];
  try {
    children = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // A vanished or non-directory segment contributes nothing, mirroring the
    // tolerated-missing behavior of the per-package lstat in
    // enumerateOwnedNodeModules. Anything else (EACCES, I/O) propagates so a
    // real failure cannot silently shrink the owned set.
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  return children.filter((child) => child.isDirectory());
}

/**
 * Walks one `workspaces` glob against the filesystem, returning the existing
 * directories it matches.
 *
 * See {@link expandWorkspacePackageDirs} for the segment semantics. The walk
 * is bounded by the optional shared enumeration deadline, checked before
 * every segment expansion and every match is recorded.
 *
 * @param sourceRoot - Source checkout root to walk.
 * @param glob - One workspaces glob pattern.
 * @param deadline - Optional shared enumeration deadline (fail-closed).
 * @returns Repo-relative directories matching `glob`.
 */
async function walkWorkspaceGlob(sourceRoot: string, glob: string, deadline?: number): Promise<string[]> {
  const segments = glob.split('/').filter((segment) => segment.length > 0);
  const matches: string[] = [];

  const walk = async (absDir: string, relPrefix: string, index: number): Promise<void> => {
    if (deadline !== undefined) assertBeforeDeadline(deadline);
    if (index === segments.length) {
      if (relPrefix.length > 0) matches.push(relPrefix);
      return;
    }

    const segment = segments[index];
    if (segment === undefined) return;
    if (segment === '**') {
      // Zero or more directory levels: finish the pattern at this depth, then
      // descend into every child directory and try again.
      await walk(absDir, relPrefix, index + 1);
      for (const child of await readDirDirs(absDir)) {
        await walk(path.join(absDir, child.name), relPrefix ? `${relPrefix}/${child.name}` : child.name, index);
      }
      return;
    }

    if (!/[*?[]/.test(segment)) {
      // A literal segment: descend directly when it is an existing directory.
      let stats: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stats = await fs.lstat(path.join(absDir, segment));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          return;
        }
        throw error;
      }
      if (!stats.isDirectory()) return;
      await walk(path.join(absDir, segment), relPrefix ? `${relPrefix}/${segment}` : segment, index + 1);
      return;
    }

    for (const child of await readDirDirs(absDir)) {
      if (minimatch(child.name, segment)) {
        await walk(path.join(absDir, child.name), relPrefix ? `${relPrefix}/${child.name}` : child.name, index + 1);
      }
    }
  };

  await walk(sourceRoot, '', 0);
  return matches;
}

/**
 * Matches the policy patterns against the interiors of TRACKED symlinked
 * node_modules entries inside the node_modules trees the rerouter owns.
 *
 * The ignored-only enumeration never reports tracked files, so a committed
 * node_modules link — the workspaces shape force-added, or any committed
 * symlinked directory under a node_modules path — is invisible to it and
 * rules addressing the package's interior silently no-op. Worse, when the
 * package interior is gitignored, a worktree-side write at the ruled path
 * resolves through the recreated link into the source checkout. This phase
 * lists every tracked file's index mode (`git ls-files -s`), keeps the
 * symlink entries (mode 120000) under owned node_modules trees — exactly the
 * tracked links the rerouter's materialization walk can act on, derived from
 * the same {@link enumerateOwnedNodeModules} list the mirror uses — and feeds
 * them through the same see-through synthesis the ignored enumeration uses,
 * so matcher matches and the omit-ancestor materialization cover tracked
 * package interiors too. The entry paths themselves are matched as well
 * (mirroring the ignored enumeration, where git reports the link), so a
 * directly matched tracked entry is handled as a directly copied path instead
 * of being materialized.
 *
 * A TRACKED node_modules-segment symlink OUTSIDE the owned trees fails closed
 * naming the path: no pass ever reaches that tree, so a rule on it would
 * silently no-op and the checkout's link would stay in place — a worktree-side
 * write at the ruled path escaping the worktree. The invariant: a tracked
 * node_modules-segment symlink is either inside owned trees where the policy
 * fully applies, or creation fails loudly.
 *
 * @param sourceRoot - Source checkout root.
 * @param omitMatcher - `.worktreeignore` matcher.
 * @param includeMatcher - `.worktreeinclude` matcher.
 * @param deadline - Shared enumeration deadline (fail-closed).
 * @param timeoutMs - Per-call `git ls-files` kill budget in milliseconds.
 * @param ownedNodeModules - Node_modules trees the rerouter owns (repo-relative).
 * @returns The matched omit and copy paths among tracked symlink entries and
 *   their synthesized descendants.
 * @throws {WorktreeIncludeError} When a TRACKED node_modules-segment symlink
 *   lies outside the owned trees, naming each offending path.
 */
async function enumerateTrackedSymlinkInteriors(
  sourceRoot: string,
  omitMatcher: ReturnType<typeof ignore>,
  includeMatcher: ReturnType<typeof ignore>,
  deadline: number,
  timeoutMs: number,
  ownedNodeModules: string[]
): Promise<{ omitMatches: string[]; copyMatches: string[] }> {
  const tracked = await gitLsFiles(sourceRoot, ['-s', '-z'], deadline, timeoutMs);
  const trackedSymlinkEntries = tracked
    .map((line): string | undefined => {
      const tab = line.indexOf('\t');
      if (tab === -1) return undefined;
      // `git ls-files -s` emits `<mode> <object> <stage>\t<path>` per entry;
      // mode 120000 is the symlink mode.
      const mode = line.slice(0, tab).split(' ')[0];
      if (mode !== '120000') return undefined;
      const rel = line.slice(tab + 1);
      return rel.split('/').includes('node_modules') ? rel : undefined;
    })
    .filter((rel): rel is string => rel !== undefined);

  // Split the tracked node_modules-segment symlinks into the trees the walk
  // will reach (owned) and the rest, which no pass can enforce: fail closed
  // naming each out-of-reach path instead of silently leaving rules
  // unenforced on a link the checkout materialized.
  const inReach = trackedSymlinkEntries.filter((rel) => isUnderOwnedNodeModules(rel, ownedNodeModules));
  const outOfReach = trackedSymlinkEntries.filter((rel) => !inReach.includes(rel));
  if (outOfReach.length > 0) {
    throw new WorktreeIncludeError(
      `Tracked symlink(s) under node_modules outside the rerouted workspace trees cannot be covered by the path policy: ${outOfReach.join(', ')}. Add the containing directory to the package.json "workspaces" globs or remove the tracked link(s).`
    );
  }

  const interiors = await matchSymlinkedDescendants(sourceRoot, inReach, omitMatcher, includeMatcher, deadline);
  return {
    omitMatches: [...inReach.filter((p) => omitMatcher.ignores(p)), ...interiors.omitMatches],
    copyMatches: [
      ...inReach.filter((p) => !omitMatcher.ignores(p) && includeMatcher.ignores(p)),
      ...interiors.copyMatches
    ]
  };
}

/**
 * Reads one policy config file, treating absence as no patterns.
 *
 * Presence is decided with `lstat`, which does not follow symlinks, so a
 * dangling symlink at the config path still counts as present: its missing
 * target surfaces as a {@link WorktreeIncludeError} naming the config file
 * rather than being silently treated as no patterns. Every other read
 * failure (unreadable file, a directory at the path, an I/O error) fails
 * closed the same way, so worktree creation stops before a matching source
 * path can be linked.
 *
 * @param sourceRoot - Source checkout root.
 * @param name - Which policy config file to read.
 * @returns File contents, or an empty string when the file is absent.
 */
async function readConfigFile(sourceRoot: string, name: '.worktreeignore' | '.worktreeinclude'): Promise<string> {
  const configPath = path.join(sourceRoot, name);
  try {
    await fs.lstat(configPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return '';
    throw new WorktreeIncludeError(`Failed to stat ${name}: ${err.message}`, { cause: error });
  }
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error) {
    throw new WorktreeIncludeError(`Failed to read ${name}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Splits config contents into pattern lines, dropping blank lines and
 * comments (the same lines the `ignore` matcher skips).
 *
 * @param content - Raw config file contents.
 * @returns The configured pattern lines as written.
 */
function parsePatterns(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

/**
 * Normalizes a repository-relative path to POSIX form.
 *
 * @param relativePath - Repository-relative path, possibly Windows-form.
 * @returns The path with forward-slash separators.
 */
function posixNormalize(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/**
 * Loads and matches the worktree path policy for one worktree creation.
 *
 * Reads `.worktreeignore` and `.worktreeinclude` from `sourceRoot` (absent
 * files contribute no patterns), intersects `.worktreeignore` matches and
 * `.worktreeinclude` copy selections with the authoritative collapsed
 * ignored-path input, walks collapsed directories for policy candidates and
 * confirms their Git eligibility in one batch. It also examines the
 * synthesized interiors of TRACKED symlink entries under
 * the node_modules trees the rerouter owns, derived from the `workspaces`
 * globs (see {@link enumerateTrackedSymlinkInteriors}) — and computes the
 * final omit/copy/share classification. A collapsed ignored directory is
 * omitted wholesale when any of its descendants matches `.worktreeignore`
 * (unless a descendant is selected for copy), because a symlinked directory
 * cannot expose only part of its contents. The query also exposes
 * {@link WorktreePathQuery.isOmitAncestor}, which the node_modules rerouter
 * uses to materialize a matcher-matched omitted path's ancestor directories
 * as real trees instead of symlinking them wholesale.
 *
 * When either config file has patterns, the whole enumeration phase —
 * filesystem candidate discovery, the batched Git eligibility check, the
 * tracked-symlink scan, the owned-workspace walk, and every see-through
 * synthesis walk — shares one
 * fail-closed deadline of `CARDS_WORKTREE_POLICY_TIMEOUT_MS` (default
 * 30000); expiry rejects with {@link WorktreeIncludeError} naming the
 * variable, never truncating.
 *
 * @param opts - Options for the policy load.
 * @param opts.sourceRoot - Source checkout root containing the config files.
 * @param opts.ignored - Collapsed ignored paths from `discoverIgnoredPaths`.
 * @returns The immutable policy for this worktree creation.
 * @throws {WorktreeIncludeError} When a config file is unreadable or otherwise
 *   unprocessable, or the enumeration phase (including its deadline) fails —
 *   before any matching source path can be provisioned.
 */
export async function loadWorktreePathPolicy(opts: {
  sourceRoot: string;
  ignored: WorktreeIgnoredPaths;
}): Promise<WorktreePathPolicy> {
  const { sourceRoot, ignored } = opts;

  const ignorePatterns = parsePatterns(await readConfigFile(sourceRoot, '.worktreeignore'));
  const includePatterns = parsePatterns(await readConfigFile(sourceRoot, '.worktreeinclude'));

  const omitMatcher = ignore().add(ignorePatterns);
  const includeMatcher = ignore().add(includePatterns);

  // Omit: collapsed ignored paths matched by .worktreeignore. Collapsed
  // directory entries are tested bare and with a trailing slash so both `dist`
  // and `dist/` patterns match a collapsed `dist` entry. Patterns that address
  // paths INSIDE a collapsed directory (`dist/**`, `dist/*`, `dist/bundle.js`)
  // cannot match the collapsed entry itself; the descendant enumeration below
  // surfaces those and omits the whole directory.
  const omitDirectories = ignored.directories.filter((d) => omitMatcher.ignores(d) || omitMatcher.ignores(`${d}/`));
  const omitFiles = ignored.files.filter((f) => omitMatcher.ignores(f));

  // Copy: ignored files matched by .worktreeinclude, minus anything omitted
  // (omit wins over copy).
  const matchedFiles = ignored.files.filter((f) => includeMatcher.ignores(f) && !omitMatcher.ignores(f));

  // Walk collapsed ignored directories for policy candidates. Include rules
  // need exact copy paths; omit rules need matching descendants to prevent an
  // ancestor directory from being shared. Git checks only those candidates
  // for ignored/untracked eligibility. The no-config path skips this work.
  const needsEnumeration = ignorePatterns.length > 0 || includePatterns.length > 0;
  // One shared fail-closed budget for the whole enumeration phase: candidate
  // discovery, Git eligibility and tracked-symlink checks, workspace discovery,
  // and every see-through synthesis walk must finish within
  // the budget of enumeration start (the configured
  // CARDS_WORKTREE_POLICY_TIMEOUT_MS, default 30000). Expiry throws — the
  // policy fails closed (never truncates, which would silently drop omit
  // entries), matching the per-call git timeout's fail-closed contract.
  const enumerationTimeoutMs = resolveEnumerationTimeoutMs();
  const enumerationDeadline = Date.now() + enumerationTimeoutMs;
  // The TRACKED phase is scoped to the node_modules trees the rerouter owns
  // (root plus glob-matched workspace packages, derived from package.json
  // `workspaces`), so policy coverage equals mirror reach; a tracked
  // node_modules-segment symlink outside those trees fails closed naming the
  // path. Failures here (an unparsable package.json) are policy-load
  // failures, so they surface as WorktreeIncludeError like every other
  // unprocessable config.
  let ownedNodeModules: string[] = [];
  if (needsEnumeration) {
    try {
      ownedNodeModules = await enumerateOwnedNodeModules(sourceRoot, enumerationDeadline);
    } catch (error: unknown) {
      if (error instanceof WorktreeIncludeError) {
        throw error;
      }
      throw new WorktreeIncludeError(
        `Failed to enumerate rerouted workspace node_modules: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }
  const [nestedByDir, trackedSymlinkMatches] = needsEnumeration
    ? await Promise.all([
        enumerateIgnoredPolicyMatches(
          sourceRoot,
          ignored.directories,
          omitMatcher,
          includeMatcher,
          enumerationDeadline
        ),
        enumerateTrackedSymlinkInteriors(
          sourceRoot,
          omitMatcher,
          includeMatcher,
          enumerationDeadline,
          enumerationTimeoutMs,
          ownedNodeModules
        )
      ])
    : [[], { omitMatches: [], copyMatches: [] }];

  // A collapsed directory with an omitted descendant cannot be shared: the
  // symlink would expose the omitted path to worktree-side writes that mutate
  // the source. Omit the whole directory — unless a descendant is selected for
  // copy, which materializes the directory as a real tree where per-file
  // omission applies (the omitted sibling simply stays absent).
  const copyParentDirs = new Set(nestedByDir.filter((e) => e.copyMatches.length > 0).map((e) => e.dir));
  for (const e of nestedByDir) {
    if (
      e.omitMatches.length > 0 &&
      !copyParentDirs.has(e.dir) &&
      // Already omitted by a direct match on the collapsed entry itself.
      !omitDirectories.includes(e.dir)
    ) {
      omitDirectories.push(e.dir);
    }
  }

  const omit = [...omitDirectories, ...omitFiles];
  const omitSet = new Set(omit);
  // Tracked symlink interiors join the copy set like enumerated ignored
  // descendants: the include executor reads the source through the tracked
  // link, and the copy ancestors materialize the package in the reroute walk.
  const copy = [...matchedFiles, ...nestedByDir.flatMap((e) => e.copyMatches), ...trackedSymlinkMatches.copyMatches];
  const copySet = new Set(copy);

  // Share: collapsed ignored paths minus omitted paths, copied paths, and
  // every collapsed directory containing a copied descendant. Copy prevents
  // any ancestor ignored directory from being linked, and unmatched ignored
  // siblings under a copied-parent directory remain absent.
  const share: WorktreeIgnoredPaths = {
    directories: ignored.directories.filter((d) => !omitSet.has(d) && !copyParentDirs.has(d)),
    files: ignored.files.filter((f) => !omitSet.has(f) && !copySet.has(f))
  };

  // classify: pattern-based three-way decision. Omit covers ancestors via the
  // gitignore matcher; copy covers the copied paths and their ancestor
  // directories (no symlink may stand above a copied descendant).
  const copyAncestors = new Set<string>();
  for (const copied of copy) {
    const parts = copied.split('/');
    for (let i = 1; i < parts.length; i++) {
      copyAncestors.add(parts.slice(0, i).join('/'));
    }
  }

  // omitAncestors: strict ancestor directories of matcher-matched omitted
  // paths — the direct file matches plus every enumerated omitted descendant,
  // including the synthesized interiors of tracked symlinked node_modules
  // entries, which the ignored enumeration never reports. classify's omit
  // branch is matcher-direct (a file-level pattern matches only the path
  // itself), so these ancestors classify 'share'; the node_modules rerouter
  // consults this set to materialize them as real trees with per-entry
  // decisions instead of symlinking them wholesale and exposing the omitted
  // path to worktree-side writes.
  const omitAncestors = new Set<string>();
  for (const omitted of [
    ...omitFiles,
    ...nestedByDir.flatMap((e) => e.omitMatches),
    ...trackedSymlinkMatches.omitMatches
  ]) {
    const parts = omitted.split('/');
    for (let i = 1; i < parts.length; i++) {
      omitAncestors.add(parts.slice(0, i).join('/'));
    }
  }

  const classify = (relativePath: string): WorktreePathDecision => {
    const normalized = posixNormalize(relativePath);
    if (omitMatcher.ignores(normalized) || omitMatcher.ignores(`${normalized}/`)) {
      return 'omit';
    }
    if (copySet.has(normalized) || copyAncestors.has(normalized)) {
      return 'copy';
    }
    return 'share';
  };

  const isOmitAncestor = (relativePath: string): boolean => omitAncestors.has(posixNormalize(relativePath));

  return { ignorePatterns, includePatterns, omit, copy, share, classify, isOmitAncestor };
}

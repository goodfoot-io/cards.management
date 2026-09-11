/**
 * Private Git configuration domains for test runners.
 *
 * Card creation registers every new card repository as a Git `safe.directory`
 * in the *global* configuration, so any suite that builds real cards writes
 * trust entries into whichever global configuration its workers resolve. A
 * runner that inherits the developer's home therefore edits the developer's
 * real Git configuration — and the entries outlive the run, because destroying
 * a temporary repository does not withdraw a grant recorded in a different
 * file.
 *
 * A runner redirects those lookups with {@link createIsolatedGitHome} and
 * spreads {@link IsolatedGitHome.env} into its worker environment. Git keeps
 * its normal protected-config lookup semantics inside the private home, so a
 * suite still exercises real trust provisioning; only the location changes.
 *
 * @summary Give a test runner a disposable home for Git's global configuration
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Name prefix for every private home, so a directory left behind by a killed
 * process is attributable to this mechanism rather than to an unknown test.
 */
export const GIT_HOME_PREFIX = 'cards-vitest-git-home-';

/**
 * Environment variables that decide where Git and Node resolve user
 * configuration.
 *
 * - `HOME` — Git's primary global-config location, `$HOME/.gitconfig`.
 * - `USERPROFILE` — that same location on Windows.
 * - `XDG_CONFIG_HOME` — Git falls back to `$XDG_CONFIG_HOME/git/config` when
 *   `$HOME/.gitconfig` is absent, which is the initial state of every private
 *   home. Without this redirection the first write of a run escapes to the
 *   developer's real XDG directory.
 */
const HOME_ENV_VARS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'] as const;

/** A private home for one test runner process. */
export interface IsolatedGitHome {
  /** Absolute path to the private home directory. */
  readonly path: string;
  /** Worker environment overrides that keep configuration lookups inside {@link IsolatedGitHome.path}. */
  readonly env: Record<(typeof HOME_ENV_VARS)[number], string>;
  /** Removes the private home. Safe to call after the home is already gone. */
  dispose(): void;
}

/**
 * Creates a private home and arranges for its removal when the process exits.
 *
 * Each call takes its own directory, so concurrent runners — separate
 * packages, separate worktrees — never share a configuration file. Removal is
 * registered on `exit`, which fires for a passing run and a failing one alike;
 * a process killed outright leaves the directory behind, which is the same
 * bound any temporary directory has.
 *
 * @returns The private home and the environment overrides that select it.
 */
export function createIsolatedGitHome(): IsolatedGitHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), GIT_HOME_PREFIX));
  // Git only writes to the XDG location when `$HOME/.gitconfig` is missing,
  // so create the directory it would need rather than discovering it at write
  // time with the developer's real `XDG_CONFIG_HOME` still in play.
  const xdgConfigHome = path.join(home, 'xdg');
  fs.mkdirSync(path.join(xdgConfigHome, 'git'), { recursive: true });

  const dispose = (): void => {
    fs.rmSync(home, { recursive: true, force: true });
  };
  process.on('exit', dispose);

  return {
    path: home,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdgConfigHome },
    dispose
  };
}

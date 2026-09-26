/**
 * Regression tests for the WorktreeCreate EEXIST failure on node_modules reroute,
 * plus policy-aware rerouting.
 *
 * Mirrors the real scenario: a repo whose `node_modules/` is git-ignored and
 * contains a `.experimental-vitest-cache` directory. createWorktree's settle
 * must complete without throwing EEXIST while symlinking node_modules entries,
 * and rerouteNodeModules must be safe to run more than once against the same
 * worktree (a re-fired hook, re-entry, or retried launch) without EEXIST.
 *
 * The policy-aware tests drive `.worktreeignore` and `.worktreeinclude` rules
 * under `node_modules` (including a `.vite`-style cache path) through
 * createWorktree and assert the rerouter leaves non-shareable descendants to
 * the policy: omitted paths stay absent, copied files are materialized real
 * by the include step, share files inside a copied package keep their
 * symlinks, and a package whose interior holds a matcher-matched omitted path
 * is materialized as a real tree (never symlinked wholesale) so worktree-side
 * writes cannot reach the source.
 *
 * @summary rerouteNodeModules idempotency regression and policy awareness
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree, rerouteNodeModules } from '../src/worktree.js';
import type { WorktreePathPolicy, WorktreePathQuery } from '../src/worktreePathPolicy.js';

const CARDS_WORKTREES_DIR_KEY = 'CARDS_WORKTREES_DIR';

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

let tmpBase = '';
let repoDir = '';
let worktreesDir = '';
const originalEnv = process.env;

beforeEach(async () => {
  tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-repro-')));
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
    await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmpBase = '';
  }
});

describe('rerouteNodeModules idempotency', () => {
  it('settles without EEXIST when node_modules is git-ignored and holds a cache dir', async () => {
    // Source node_modules (git-ignored as a whole) with a real cache directory.
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, '.experimental-vitest-cache'), { recursive: true });
    await fs.writeFile(path.join(nm, '.experimental-vitest-cache', 'deadbeef'), 'x');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');

    const { path: wPath, settle } = await createWorktree('feature/reroute-repro', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The cache dir is mirrored into the worktree node_modules.
    const linked = path.join(wPath, 'node_modules', '.experimental-vitest-cache');
    await expect(fs.stat(linked)).resolves.toBeDefined();

    await removeWorktree(wPath);
  });

  it('rerouteNodeModules is idempotent: a second run does not throw EEXIST', async () => {
    const sourceNodeModules = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(sourceNodeModules, '.experimental-vitest-cache'), { recursive: true });
    await fs.writeFile(path.join(sourceNodeModules, '.experimental-vitest-cache', 'deadbeef'), 'x');
    await fs.mkdir(path.join(sourceNodeModules, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(sourceNodeModules, 'left-pad', 'index.js'), 'module.exports = 0;');
    await fs.mkdir(path.join(sourceNodeModules, '@scope', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(sourceNodeModules, '@scope', 'pkg', 'index.js'), 'module.exports = 1;');

    const destNodeModules = path.join(tmpBase, 'dest', 'node_modules');

    // First run mirrors the tree (leaving dest as a real dir full of symlinks).
    await rerouteNodeModules({ sourceNodeModules, destNodeModules });

    // Second run (retried/re-fired hook, or re-entry) must not throw EEXIST.
    await expect(rerouteNodeModules({ sourceNodeModules, destNodeModules })).resolves.toBeGreaterThanOrEqual(0);

    // The entries still resolve to the source.
    const resolved = await fs.readlink(path.join(destNodeModules, '.experimental-vitest-cache'));
    expect(resolved).toBe(path.join(sourceNodeModules, '.experimental-vitest-cache'));
    const scoped = await fs.readlink(path.join(destNodeModules, '@scope', 'pkg'));
    expect(scoped).toBe(path.join(sourceNodeModules, '@scope', 'pkg'));
  });
});

describe('policy-aware node_modules rerouting', () => {
  /**
   * Makes the fixture a yarn-workspaces repo so enumerateReroutedNodeModules
   * owns the root node_modules and the rerouter rebuilds it as a real directory
   * of per-entry symlinks. Without this, the fixture's git-ignored node_modules
   * is symlinked wholesale by symlinkIgnoredPaths instead — which would mask
   * the per-descendant policy decisions this suite asserts.
   */
  async function makeNodeModulesRerouted(): Promise<void> {
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  }

  it('omits a .worktreeignore-matched node_modules descendant: no symlink is created for it', async () => {
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, '.vite', 'cache'), { recursive: true });
    await fs.writeFile(path.join(nm, '.vite', 'cache', 'deadbeef'), 'x');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/.vite\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The omitted descendant is absent — no symlink, no directory.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '.vite'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Share siblings still resolve to the source.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'left-pad'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'left-pad')
    );

    await removeWorktree(wPath);
  });

  it('copies a .worktreeinclude-matched node_modules descendant instead of symlinking it', async () => {
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, '.vite', 'deps'), { recursive: true });
    await fs.writeFile(path.join(nm, '.vite', 'deps', 'x.js'), 'export {};\n');
    await fs.mkdir(path.join(nm, '.vite', 'cache'), { recursive: true });
    await fs.writeFile(path.join(nm, '.vite', 'cache', 'y.js'), 'y');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/.vite/deps/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-copy', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The copied descendant is a real file in the worktree, not a symlink.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', '.vite', 'deps', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    expect(await fs.readFile(path.join(wPath, 'node_modules', '.vite', 'deps', 'x.js'), 'utf8')).toBe('export {};\n');
    // The copied parent is a real directory, never a symlink.
    const viteLstat = await fs.lstat(path.join(wPath, 'node_modules', '.vite'));
    expect(viteLstat.isSymbolicLink()).toBe(false);
    expect(viteLstat.isDirectory()).toBe(true);
    // The unmatched sibling directory under the copied parent is share-
    // classified, so the rerouter symlinks it wholesale and y.js resolves
    // through it — node_modules entries default to share even under a
    // copied parent.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '.vite', 'cache'))).resolves.toBe(
      path.join(repoDir, 'node_modules', '.vite', 'cache')
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', '.vite', 'cache', 'y.js'), 'utf8')).resolves.toBe('y');
    // Share siblings still resolve to the source.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'left-pad'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'left-pad')
    );

    await removeWorktree(wPath);
  });

  it('keeps a copied @scoped package usable: share files and scope sibling symlinked', async () => {
    // A copy rule under @scope/pkgA classifies the whole @scope directory as
    // 'copy' via the policy's copyAncestors set, and pkgA itself as 'copy'
    // too. The rerouter must descend into the scope AND into the copied
    // package: the package's real share files (index.js, package.json) keep
    // their symlinks, the copied cache file is real, and the share sibling
    // @scope/pkgB stays symlinked — otherwise the package could not be
    // resolved when building in the worktree.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, '@scope', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, '@scope', 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(nm, '@scope', 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(nm, '@scope', 'pkgA', 'package.json'), JSON.stringify({ name: 'pkgA' }));
    await fs.mkdir(path.join(nm, '@scope', 'pkgB'), { recursive: true });
    await fs.writeFile(path.join(nm, '@scope', 'pkgB', 'index.js'), 'module.exports = 2;');
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/@scope/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-scope-copy', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The @scope directory is real, never a symlink, so both members coexist.
    const scopeLstat = await fs.lstat(path.join(wPath, 'node_modules', '@scope'));
    expect(scopeLstat.isDirectory()).toBe(true);
    expect(scopeLstat.isSymbolicLink()).toBe(false);
    // The copied package directory is real too — the copy rule prevents it
    // from being symlinked wholesale.
    const pkgALstat = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'pkgA'));
    expect(pkgALstat.isDirectory()).toBe(true);
    expect(pkgALstat.isSymbolicLink()).toBe(false);
    // The copied descendant is a real file with the source content.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'pkgA', '.cache', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(
      fs.readFile(path.join(wPath, 'node_modules', '@scope', 'pkgA', '.cache', 'x.js'), 'utf8')
    ).resolves.toBe('export {};\n');
    // The package's share files are symlinked to the source and readable.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'pkgA', 'index.js'))).resolves.toBe(
      path.join(repoDir, 'node_modules', '@scope', 'pkgA', 'index.js')
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', '@scope', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'pkgA', 'package.json'))).resolves.toBe(
      path.join(repoDir, 'node_modules', '@scope', 'pkgA', 'package.json')
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'node_modules', '@scope', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The share sibling inside the same scope is still symlinked to the source.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'pkgB'))).resolves.toBe(
      path.join(repoDir, 'node_modules', '@scope', 'pkgB')
    );

    await removeWorktree(wPath);
  });

  it('keeps a copied top-level package usable: share files symlinked alongside the copied cache file', async () => {
    // A copy rule inside a top-level package (node_modules/pkgA/.cache/x.js)
    // classifies pkgA 'copy' via the policy's copyAncestors set. The rerouter
    // must materialize pkgA as a real directory and descend into it: the
    // copied cache file is real (owned by the include copy executor) while
    // the package's share files (index.js, package.json) keep their symlinks
    // — otherwise the package could not be resolved when building in the
    // worktree.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(nm, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(nm, 'pkgA', 'package.json'), JSON.stringify({ name: 'pkgA' }));
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-pkg-copy', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package directory is real, never a symlink — the copy rule prevents
    // it from being linked wholesale.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The copied cache file is a real file, independent of the source copy.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    const srcCopiedStat = await fs.stat(path.join(repoDir, 'node_modules', 'pkgA', '.cache', 'x.js'));
    expect(copied.ino).not.toBe(srcCopiedStat.ino);
    // The package's share files are symlinked to the source and readable.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'pkgA', 'index.js')
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'package.json'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'pkgA', 'package.json')
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('omits an entire node_modules entry matched by .worktreeignore', async () => {
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-omit-all', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The omitted node_modules dir is not rebuilt at all.
    await expect(fs.lstat(path.join(wPath, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });

    await removeWorktree(wPath);
  });

  it('materializes a package with an interior omit rule: ruled path absent, share files symlinked, writes cannot reach the source', async () => {
    // A file-level .worktreeignore rule inside a top-level package
    // (node_modules/pkgA/.cache/x.js) matches neither node_modules nor pkgA
    // itself, so classify leaves both 'share'. The rerouter must detect that
    // pkgA is an ANCESTOR of the matcher-matched omitted path and materialize
    // it as a real tree: the ruled file stays absent, the package's share
    // files keep their symlinks, and a worktree-side write at the ruled path
    // cannot reach the source checkout.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(nm, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(nm, 'pkgA', 'package.json'), JSON.stringify({ name: 'pkgA' }));
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-pkg-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale symlink to the source.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The .cache directory is real too, so the ruled path stays absent.
    const cacheLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache'));
    expect(cacheLstat.isDirectory()).toBe(true);
    expect(cacheLstat.isSymbolicLink()).toBe(false);
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's share files are symlinked to the source and readable.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'pkgA', 'index.js')
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The source copy of the ruled file is untouched by the settle.
    await expect(fs.readFile(path.join(repoDir, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    // A worktree-side write at the ruled path lands in the worktree's own
    // directory — the real .cache tree — and never reaches the source.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(repoDir, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );

    await removeWorktree(wPath);
  });

  it('materializes an @scoped package with an interior omit rule and keeps its scope sibling symlinked', async () => {
    // Same ancestor trigger as the top-level case, inside an @scope: the rule
    // targets node_modules/@scope/a/.cache/tmp, so the rerouter must descend
    // through the always-real @scope into a — materialized as a real tree
    // with tmp absent and the package's share files symlinked — while the
    // sibling @scope/b stays symlinked wholesale.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, '@scope', 'a', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, '@scope', 'a', '.cache', 'tmp'), 'x');
    await fs.writeFile(path.join(nm, '@scope', 'a', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(nm, '@scope', 'b'), { recursive: true });
    await fs.writeFile(path.join(nm, '@scope', 'b', 'index.js'), 'module.exports = 2;');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/@scope/a/.cache/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-scope-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The scoped package is a real directory, never a wholesale symlink.
    const pkgALstat = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a'));
    expect(pkgALstat.isDirectory()).toBe(true);
    expect(pkgALstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a', '.cache', 'tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's share files are symlinked to the source and readable.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'))).resolves.toBe(
      path.join(repoDir, 'node_modules', '@scope', 'a', 'index.js')
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The sibling package inside the same scope is still symlinked wholesale.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join(repoDir, 'node_modules', '@scope', 'b')
    );

    await removeWorktree(wPath);
  });

  it('applies an interior omit rule inside the copy descent: copied file real, omitted sibling absent', async () => {
    // A copy rule (.worktreeinclude: node_modules/pkgA/.cache/x.js) already
    // materializes pkgA via the copy descent. An omit rule for a DIFFERENT
    // interior path (node_modules/pkgA/logs/tmp) must trigger inside that
    // descent: `logs` classifies share — it is not an ancestor of any copied
    // path — but it hides a matcher-matched omitted path, so it must be
    // materialized real instead of symlinked wholesale, or tmp would be
    // exposed to worktree-side writes that mutate the source.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.mkdir(path.join(nm, 'pkgA', 'logs'), { recursive: true });
    await fs.writeFile(path.join(nm, 'pkgA', 'logs', 'tmp'), 'x');
    await fs.writeFile(path.join(nm, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/logs/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-pkg-mixed', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale symlink.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The copied cache file is a real file with the source content.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    // The omit-triggered sibling directory is real and the ruled path absent.
    const logsLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', 'logs'));
    expect(logsLstat.isDirectory()).toBe(true);
    expect(logsLstat.isSymbolicLink()).toBe(false);
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', 'logs', 'tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's share files are symlinked to the source and readable.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'pkgA', 'index.js')
    );
    // The source copy of the ruled file is untouched.
    await expect(fs.readFile(path.join(repoDir, 'node_modules', 'pkgA', 'logs', 'tmp'), 'utf8')).resolves.toBe('x');

    await removeWorktree(wPath);
  });

  it('omits an entire package entry matched by a direct directory .worktreeignore pattern', async () => {
    // A directory-level pattern (`node_modules/pkgA/`) matches the package
    // itself, so classify returns 'omit' for the entry and the rerouter skips
    // it wholesale — the omit-ancestor trigger must not change this.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(nm, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-pkg-omit-all', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The omitted package is entirely absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Share siblings still resolve to the source.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'left-pad'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'left-pad')
    );

    await removeWorktree(wPath);
  });

  it('materializes a .vite-style cache dir matched by a deep .worktreeignore pattern', async () => {
    // A directory-level pattern INSIDE node_modules (`node_modules/.vite/cache/`)
    // matches only paths under the cache dir — neither node_modules nor .vite
    // itself. The rerouter must materialize .vite as a real tree so the ruled
    // cache content stays absent instead of being exposed through a wholesale
    // .vite symlink, while sibling packages keep their symlinks. The cache dir
    // itself matches the pattern directly and is omitted wholesale, exactly
    // like a direct directory pattern.
    await makeNodeModulesRerouted();
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, '.vite', 'cache'), { recursive: true });
    await fs.writeFile(path.join(nm, '.vite', 'cache', 'deadbeef'), 'x');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/.vite/cache/\n');

    const { path: wPath, settle } = await createWorktree('feature/reroute-vite-deep-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // .vite is a real directory, never a wholesale symlink to the source.
    const viteLstat = await fs.lstat(path.join(wPath, 'node_modules', '.vite'));
    expect(viteLstat.isDirectory()).toBe(true);
    expect(viteLstat.isSymbolicLink()).toBe(false);
    // The cache dir matches the pattern directly and is omitted wholesale.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '.vite', 'cache'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // Share siblings still resolve to the source.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'left-pad'))).resolves.toBe(
      path.join(repoDir, 'node_modules', 'left-pad')
    );

    await removeWorktree(wPath);
  });
});

describe('policy-aware rerouting of symlinked workspace packages', () => {
  /**
   * Makes the fixture a yarn-workspaces repo whose node_modules entries are
   * SYMLINKS into packages/ — the actual Yarn/npm workspaces shape — instead
   * of the real directories the suites above use. The workspace packages are
   * committed as real directories (so the worktree checkout carries them):
   * packages/pkgA with .cache/x.js, packages/a with .cache/tmp, packages/b;
   * node_modules/pkgA -> ../packages/pkgA, node_modules/@scope/a ->
   * ../../packages/a, node_modules/@scope/b -> ../../packages/b. Pass
   * `pkgATarget` to link pkgA to an absolute path outside the repo instead.
   *
   * @param pkgATarget Absolute external target for the node_modules/pkgA
   * link; omitted links pkgA into the repo's own packages/ checkout.
   */
  async function makeSymlinkedWorkspace(pkgATarget?: string): Promise<void> {
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const pkgs = path.join(repoDir, 'packages');
    await fs.mkdir(path.join(pkgs, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(pkgs, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(pkgs, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(pkgs, 'pkgA', 'package.json'), JSON.stringify({ name: 'pkgA' }));
    await fs.mkdir(path.join(pkgs, 'a', '.cache'), { recursive: true });
    await fs.writeFile(path.join(pkgs, 'a', '.cache', 'tmp'), 'x');
    await fs.writeFile(path.join(pkgs, 'a', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(pkgs, 'b'));
    await fs.writeFile(path.join(pkgs, 'b', 'index.js'), 'module.exports = 2;');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'add workspace packages'], { cwd: repoDir });
    await fs.mkdir(path.join(repoDir, 'node_modules', '@scope'), { recursive: true });
    if (pkgATarget === undefined) {
      await fs.symlink('../packages/pkgA', path.join(repoDir, 'node_modules', 'pkgA'));
    } else {
      await fs.symlink(pkgATarget, path.join(repoDir, 'node_modules', 'pkgA'));
    }
    await fs.symlink('../../packages/a', path.join(repoDir, 'node_modules', '@scope', 'a'));
    await fs.symlink('../../packages/b', path.join(repoDir, 'node_modules', '@scope', 'b'));
  }

  it('keeps a workspace package bound to the new checkout when its source link was materialized in a prior worktree', async () => {
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const first = await createWorktree('feature/chained-package-source', { cwd: repoDir });
    await expect(first.settle).resolves.toBeDefined();

    // The omit rule forces the first worktree to materialize this node_modules
    // package as a real directory containing links into that checkout.
    const firstPackage = path.join(first.path, 'node_modules', 'pkgA');
    const firstPackageStats = await fs.lstat(firstPackage);
    expect(firstPackageStats.isDirectory()).toBe(true);
    expect(firstPackageStats.isSymbolicLink()).toBe(false);

    const second = await createWorktree('feature/chained-package-destination', { cwd: first.path });
    await expect(second.settle).resolves.toBeDefined();

    // Every chained worktree must resolve the workspace link through its own
    // packages checkout instead of inheriting the source worktree's link.
    await expect(fs.realpath(path.join(second.path, 'node_modules', 'pkgA', 'index.js'))).resolves.toBe(
      path.join(second.path, 'packages', 'pkgA', 'index.js')
    );

    await removeWorktree(second.path);
    await removeWorktree(first.path);
  });

  it('keeps a same-directory relative symlink inside a materialized workspace package local to the new checkout', async () => {
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, 'packages', 'pkgA', 'CLAUDE.md'), 'package instructions\n');
    await fs.symlink('CLAUDE.md', path.join(repoDir, 'packages', 'pkgA', 'AGENTS.md'));
    execFileSync('git', ['add', 'packages/pkgA/CLAUDE.md', 'packages/pkgA/AGENTS.md'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'add workspace package instruction links'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const worktree = await createWorktree('feature/materialized-package-relative-link', { cwd: repoDir });
    await expect(worktree.settle).resolves.toBeDefined();

    // The package is materialized to enforce the omit rule; its relative child
    // link must still resolve to this checkout's copy of the target file.
    await expect(fs.realpath(path.join(worktree.path, 'node_modules', 'pkgA', 'AGENTS.md'))).resolves.toBe(
      path.join(worktree.path, 'packages', 'pkgA', 'CLAUDE.md')
    );

    await removeWorktree(worktree.path);
  });

  it('materializes a symlinked top-level package with an interior omit rule: ruled path absent, share files resolve into the worktree packages', async () => {
    // The workspaces shape: node_modules/pkgA is a LINK to ../packages/pkgA,
    // and git never reports the interior of a symlinked directory — the
    // descendant enumeration must synthesize node_modules/pkgA/.cache/x.js for
    // the file-level rule to match at all. The rerouter must then materialize
    // the package as a real tree whose share files link into the WORKTREE's
    // own packages checkout (the isolation the workspace shape provides), so a
    // worktree-side write at the ruled path cannot reach the source.
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-pkg-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale link to the source.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The .cache directory is real too, so the ruled path stays absent.
    const cacheLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache'));
    expect(cacheLstat.isDirectory()).toBe(true);
    expect(cacheLstat.isSymbolicLink()).toBe(false);
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's share files are symlinks that resolve into the WORKTREE's
    // own packages checkout, never the source.
    const indexLink = await fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'));
    expect(indexLink).toBe(path.join('..', '..', 'packages', 'pkgA', 'index.js'));
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // A write through the worktree's node_modules/pkgA/index.js lands in the
    // worktree's own packages checkout, never the source.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(wPath, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'worktree-write\n'
    );
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The source copy of the ruled file is untouched.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );

    await removeWorktree(wPath);
  });

  it('materializes a symlinked @scope package with an interior omit rule and keeps its scope sibling linked', async () => {
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/@scope/a/.cache/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-scope-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The scoped package is a real directory, never a wholesale link.
    const pkgALstat = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a'));
    expect(pkgALstat.isDirectory()).toBe(true);
    expect(pkgALstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a', '.cache', 'tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's share file resolves into the worktree's own packages.
    const indexLink = await fs.readlink(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'));
    expect(indexLink).toBe(path.join('..', '..', '..', 'packages', 'a', 'index.js'));
    await expect(fs.readFile(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The sibling package inside the same scope is still a link to the
    // worktree's packages checkout.
    const siblingLink = await fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'));
    expect(siblingLink).toBe(path.join('..', '..', 'packages', 'b'));
    await expect(fs.readFile(path.join(wPath, 'node_modules', '@scope', 'b', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 2;'
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'a', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('copies a file inside a symlinked package: real copy in the worktree, share files symlinked, source untouched', async () => {
    // The copy rule addresses the package's interior through the link; the
    // package must be materialized as a real tree so the copied cache file is
    // an independent real copy while the package's share files keep their
    // symlinks into the worktree's own packages.
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-pkg-copy', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale link.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The copied cache file is a real file, independent of the checkout copy.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    const srcCopiedStat = await fs.stat(path.join(repoDir, 'packages', 'pkgA', '.cache', 'x.js'));
    expect(copied.ino).not.toBe(srcCopiedStat.ino);
    // The package's share files are symlinks into the worktree's own packages.
    const indexLink = await fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'));
    expect(indexLink).toBe(path.join('..', '..', 'packages', 'pkgA', 'index.js'));
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'package.json'))).resolves.toBe(
      path.join('..', '..', 'packages', 'pkgA', 'package.json')
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('materializes a symlinked package with an absolute target outside the repo: ruled path absent, writes cannot reach the target', async () => {
    // An external (absolute) link target has no counterpart inside the
    // worktree: the package is materialized as a real tree with share children
    // linking absolutely to the resolved target, and a write at the ruled path
    // can never reach the external target's file.
    const externalPkg = path.join(tmpBase, 'external-pkgA');
    await fs.mkdir(path.join(externalPkg, '.cache'), { recursive: true });
    await fs.writeFile(path.join(externalPkg, '.cache', 'x.js'), 'external-cache\n');
    await fs.writeFile(path.join(externalPkg, 'index.js'), 'external-index\n');
    await makeSymlinkedWorkspace(externalPkg);
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-abs-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale link to the source.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // A worktree-side write at the ruled path creates the file in the
    // worktree's real tree and never reaches the external target's file.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(externalPkg, '.cache', 'x.js'), 'utf8')).resolves.toBe('external-cache\n');
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'worktree-write\n'
    );

    await removeWorktree(wPath);
  });

  it('reconciles a whole-package copy rule with an interior omit rule on a symlinked package: real dir, ruled path absent, package files copied', async () => {
    // A legitimate, documented combination: .worktreeinclude: node_modules/pkgA
    // (whole-package copy rule on a symlinked workspace package) combined with
    // .worktreeignore: node_modules/pkgA/.cache/x.js (interior omit rule). The
    // directory pattern puts the package's whole interior in the copy set, so
    // omit wins over copy: the reroute walk must materialize pkgA as a real
    // directory, the ruled path stays absent, the package's files become real
    // copies (written by the include executor into the materialized tree), and
    // the executor must skip the walk-provisioned package path instead of
    // trying to recreate the source link over it (which failed creation with
    // EEXIST, or raced the walk's unlink).
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-pkg-copy-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale link to the source.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The whole-package copy rule makes the package's files real copies.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', 'index.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    const srcCopiedStat = await fs.stat(path.join(repoDir, 'packages', 'pkgA', 'index.js'));
    expect(copied.ino).not.toBe(srcCopiedStat.ino);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'package.json'), 'utf8')).resolves.toBe(
      JSON.stringify({ name: 'pkgA' })
    );
    // The share sibling in the same node_modules stays a link into the
    // worktree's own packages checkout.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join('..', '..', 'packages', 'b')
    );
    // A worktree-side write at the ruled path lands in the worktree's own real
    // tree and never reaches the source checkout.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('reconciles a whole-package copy rule with an interior omit rule on a symlinked @scope package and keeps its scope sibling linked', async () => {
    // Same copy+omit combination at @-scope depth: the rule targets
    // node_modules/@scope/a (whole-package copy) plus an interior omit
    // (node_modules/@scope/a/.cache/tmp). The walk descends through the
    // always-real @scope and materializes a as a real tree with tmp absent
    // and its files copied into it; the executor must skip the materialized
    // destination there too.
    await makeSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/@scope/a\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/@scope/a/.cache/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-scope-copy-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The scoped package is a real directory, never a wholesale link.
    const pkgALstat = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a'));
    expect(pkgALstat.isDirectory()).toBe(true);
    expect(pkgALstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a', '.cache', 'tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's index.js is a real copy, independent of the checkout copy.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The sibling package inside the same scope is still a link to the
    // worktree's packages checkout.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join('..', '..', 'packages', 'b')
    );
    // A worktree-side write at the ruled path never reaches the source.
    await fs.writeFile(path.join(wPath, 'node_modules', '@scope', 'a', '.cache', 'tmp'), 'worktree-write\n');
    await expect(fs.readFile(path.join(repoDir, 'packages', 'a', '.cache', 'tmp'), 'utf8')).resolves.toBe('x');

    await removeWorktree(wPath);
  });

  it('copies a complete package tree deterministically when the copy set holds node_modules paths alongside omit rules', async () => {
    // The copy set contains node_modules paths (the whole package link plus a
    // file inside it) and an omit rule rules a sibling interior path. The
    // reroute walk and the include executor both write node_modules
    // destinations here, so creation must join the walk before copying: every
    // copied file is present in the final tree (no partial outcomes where the
    // walk's unlink destroys an in-flight copy), the walk-materialized package
    // entry is skipped by the executor, and the copy count reports exactly the
    // files the executor actually wrote.
    await makeSymlinkedWorkspace();
    // The omit rule addresses a path the base fixture does not contain, so the
    // ruled file must exist in the source package for the rule to match at all.
    await fs.mkdir(path.join(repoDir, 'packages', 'pkgA', 'logs'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'packages', 'pkgA', 'logs', 'tmp'), 'x');
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA\nnode_modules/pkgA/.cache/x.js\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/logs/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-pkg-copy-race', { cwd: repoDir });
    const result = await settle;

    // The executor copied the package's files (index.js, package.json, and
    // the interior x.js): the whole-package entry itself was provisioned by
    // the walk and skipped, and the .cache directory entry is skipped as a
    // directory.
    expect(result.copiedFromInclude).toBe(3);
    // The package is a real directory, never a wholesale link to the source.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // Every copied file is present as a real file — the complete tree, not a
    // partial one.
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'package.json'), 'utf8')).resolves.toBe(
      JSON.stringify({ name: 'pkgA' })
    );
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    // The omit-triggered sibling directory is real and the ruled path absent.
    const logsLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', 'logs'));
    expect(logsLstat.isDirectory()).toBe(true);
    expect(logsLstat.isSymbolicLink()).toBe(false);
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', 'logs', 'tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });

    await removeWorktree(wPath);
  });

  it('reconciles copy with an interior omit rule on a symlinked package with an absolute target outside the repo: writes at the ruled path cannot reach the target', async () => {
    // Same copy+omit combination for an EXTERNAL (absolute) link target: the
    // package is materialized as a real tree, the executor skips the
    // materialized destination and copies the package's files into it, and a
    // worktree-side write at the ruled path can never reach the external
    // target's file.
    const externalPkg = path.join(tmpBase, 'external-pkgA-copy-omit');
    await fs.mkdir(path.join(externalPkg, '.cache'), { recursive: true });
    await fs.writeFile(path.join(externalPkg, '.cache', 'x.js'), 'external-cache\n');
    await fs.writeFile(path.join(externalPkg, 'index.js'), 'external-index\n');
    await makeSymlinkedWorkspace(externalPkg);
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/symlink-abs-copy-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The package is a real directory, never a wholesale link to the target.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // A worktree-side write at the ruled path creates the file in the
    // worktree's real tree and never reaches the external target's file.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(externalPkg, '.cache', 'x.js'), 'utf8')).resolves.toBe('external-cache\n');
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'worktree-write\n'
    );

    await removeWorktree(wPath);
  });

  it('recreates every symlinked workspace entry as before when no policy config exists', async () => {
    // No config files: no enumeration, no rules — every entry stays a link
    // with its original relative target, exactly as before the policy waves.
    await makeSymlinkedWorkspace();

    const { path: wPath, settle } = await createWorktree('feature/symlink-noconfig', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA'))).resolves.toBe(
      path.join('..', 'packages', 'pkgA')
    );
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'a'))).resolves.toBe(
      path.join('..', '..', 'packages', 'a')
    );
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join('..', '..', 'packages', 'b')
    );
    // The recreated links resolve into the worktree's own packages checkout.
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', '@scope', 'b', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 2;'
    );

    await removeWorktree(wPath);
  });
});

describe('policy-aware rerouting of TRACKED symlinked workspace packages', () => {
  /**
   * Makes the fixture a workspaces repo whose node_modules symlinks are
   * TRACKED — force-added despite the initGitRepo `node_modules/` ignore line
   * and committed — instead of git-ignored, the shape the policy's ignored
   * enumeration never reports. Same packages as `makeSymlinkedWorkspace`;
   * the node_modules entries are committed with `git add -f`. When
   * `ignorePkgACache` is set, `packages/pkgA/.cache` is gitignored after the
   * symlinks are committed — the S7b shape, where the worktree provisions the
   * package's cache dir as a shared symlink from the source unless the policy
   * materializes the tracked package.
   *
   * @param ignorePkgACache Whether to gitignore `packages/pkgA/.cache`.
   */
  async function makeTrackedSymlinkedWorkspace(ignorePkgACache = false): Promise<void> {
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const pkgs = path.join(repoDir, 'packages');
    await fs.mkdir(path.join(pkgs, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(pkgs, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(pkgs, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.writeFile(path.join(pkgs, 'pkgA', 'package.json'), JSON.stringify({ name: 'pkgA' }));
    await fs.mkdir(path.join(pkgs, 'a', '.cache'), { recursive: true });
    await fs.writeFile(path.join(pkgs, 'a', '.cache', 'tmp'), 'x');
    await fs.writeFile(path.join(pkgs, 'a', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(pkgs, 'b'));
    await fs.writeFile(path.join(pkgs, 'b', 'index.js'), 'module.exports = 2;');
    await fs.mkdir(path.join(repoDir, 'node_modules', '@scope'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(repoDir, 'node_modules', 'pkgA'));
    await fs.symlink('../../packages/a', path.join(repoDir, 'node_modules', '@scope', 'a'));
    await fs.symlink('../../packages/b', path.join(repoDir, 'node_modules', '@scope', 'b'));
    // The ignore line must precede the first add: a file committed once stays
    // tracked even after a later .gitignore line, and the S7b shape requires
    // packages/pkgA/.cache to be genuinely untracked so the worktree shares
    // it as a symlink from the source.
    if (ignorePkgACache) {
      await fs.appendFile(path.join(repoDir, '.gitignore'), 'packages/pkgA/.cache\n');
    }
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['add', '-f', 'node_modules'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'add workspace packages with tracked node_modules'], { cwd: repoDir });
  }

  it('materializes a TRACKED symlinked package with an interior omit rule: ruled path absent, writes cannot reach the source', async () => {
    // S7b shape: the tracked link's target interior (packages/pkgA/.cache) is
    // gitignored, so the worktree shares it as a symlink from the source —
    // but the policy's tracked phase must make the rerouter replace the
    // checkout's node_modules/pkgA link with a real tree whose own .cache is
    // real, or a worktree-side write at the ruled path resolves through both
    // links into the source file.
    await makeTrackedSymlinkedWorkspace(true);
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-pkg-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The tracked package is a real directory, never the checkout's link.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The .cache directory is real too, so the ruled path stays absent.
    const cacheLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache'));
    expect(cacheLstat.isDirectory()).toBe(true);
    expect(cacheLstat.isSymbolicLink()).toBe(false);
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The worktree's own packages side still shares the unmatched ignored
    // cache from the source...
    await expect(fs.readlink(path.join(wPath, 'packages', 'pkgA', '.cache'))).resolves.toBe(
      path.join(repoDir, 'packages', 'pkgA', '.cache')
    );
    // ...but a write through the materialized node_modules path lands in the
    // worktree's real tree and never reaches the source file.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'worktree-write\n'
    );
    // The package's share files link into the worktree's own packages.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'))).resolves.toBe(
      path.join('..', '..', 'packages', 'pkgA', 'index.js')
    );

    await removeWorktree(wPath);
  });

  it('copies a file inside a TRACKED symlinked package: real copy in the worktree, share files symlinked, source untouched', async () => {
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-pkg-copy', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The tracked package is materialized as a real tree (its interior is
    // copy-classified), never the checkout's link.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The copied cache file is a real file, independent of the checkout copy.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    const srcCopiedStat = await fs.stat(path.join(repoDir, 'packages', 'pkgA', '.cache', 'x.js'));
    expect(copied.ino).not.toBe(srcCopiedStat.ino);
    // The package's share files link into the worktree's own packages.
    await expect(fs.readlink(path.join(wPath, 'node_modules', 'pkgA', 'index.js'))).resolves.toBe(
      path.join('..', '..', 'packages', 'pkgA', 'index.js')
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('reconciles a whole-package copy rule with an interior omit rule on a TRACKED symlinked package', async () => {
    // Same copy+omit combination as the git-ignored shape, on a tracked link:
    // omit wins over copy, so the reroute walk materializes the package as a
    // real tree (the include executor must skip that walk-provisioned
    // destination) and the whole-package copy rule makes the package's files
    // real copies inside it.
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeinclude'), 'node_modules/pkgA\n');
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-pkg-copy-omit', { cwd: repoDir });
    const result = await settle;

    // The package is a real directory, never a wholesale link to the source.
    const pkgLstat = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The whole-package copy rule makes the package's share files real copies.
    const copied = await fs.lstat(path.join(wPath, 'node_modules', 'pkgA', 'index.js'));
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.isFile()).toBe(true);
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', 'package.json'), 'utf8')).resolves.toBe(
      JSON.stringify({ name: 'pkgA' })
    );
    // The executor copied the package's two share files into the
    // walk-materialized tree and skipped the walk-provisioned entry itself.
    expect(result.copiedFromInclude).toBe(2);
    // A worktree-side write at the ruled path lands in the worktree's real
    // tree and never reaches the source checkout.
    await fs.writeFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'worktree-write\n');
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'export {};\n'
    );
    await expect(fs.readFile(path.join(wPath, 'node_modules', 'pkgA', '.cache', 'x.js'), 'utf8')).resolves.toBe(
      'worktree-write\n'
    );

    await removeWorktree(wPath);
  });

  it('materializes a TRACKED symlinked @scope package with an interior omit rule and keeps its scope sibling linked', async () => {
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/@scope/a/.cache/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-scope-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The scoped package is a real directory, never the checkout's link.
    const pkgALstat = await fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a'));
    expect(pkgALstat.isDirectory()).toBe(true);
    expect(pkgALstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a', '.cache', 'tmp'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    // The package's share file resolves into the worktree's own packages.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'a', 'index.js'))).resolves.toBe(
      path.join('..', '..', '..', 'packages', 'a', 'index.js')
    );
    // The sibling package inside the same scope is still a link to the
    // worktree's packages checkout.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join('..', '..', 'packages', 'b')
    );
    // The source checkout is unchanged.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'a', '.cache', 'tmp'), 'utf8')).resolves.toBe('x');

    await removeWorktree(wPath);
  });

  it('omits a whole TRACKED node_modules tree matched by .worktreeignore: the checkout-materialized tree is removed', async () => {
    // A whole-tree rule (node_modules/) omits every owned node_modules dir:
    // on the committed shape the checkout has already materialized the
    // tracked links, so the omit branch must remove the tree instead of
    // merely skipping the rebuild.
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-nm-omit-all', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The whole node_modules tree is absent, not present-and-ruled.
    await expect(fs.lstat(path.join(wPath, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The source checkout is untouched.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('omits a whole TRACKED symlinked package matched by .worktreeignore: package absent, sibling links intact', async () => {
    // A whole-package rule (node_modules/pkgA) matches the tracked symlink
    // ENTRY itself, so the entry classifies 'omit' and the rerouter skips it —
    // but the git checkout has already materialized the tracked link in the
    // worktree, so the skip alone leaves the package fully present. The omit
    // branch must actively remove the checkout-materialized entry, or the
    // rule silently no-ops on the committed shape while omitting wholesale on
    // the gitignored shape.
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-pkg-omit-all', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The omitted package is entirely absent — the checkout's link is gone.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Unruled tracked entries stay recreated as links into the worktree's
    // own packages checkout.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join('..', '..', 'packages', 'b')
    );
    // The source checkout is untouched.
    await expect(fs.readFile(path.join(repoDir, 'packages', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('omits a whole TRACKED symlinked package matched by a trailing-slash .worktreeignore pattern', async () => {
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA/\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-pkg-omit-all-trailing', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A scope sibling of the omitted package keeps its link.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'a'))).resolves.toBe(
      path.join('..', '..', 'packages', 'a')
    );

    await removeWorktree(wPath);
  });

  it('omits a whole TRACKED @scope package member matched by .worktreeignore and keeps its scope sibling linked', async () => {
    await makeTrackedSymlinkedWorkspace();
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/@scope/a\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-scope-member-omit-all', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The omitted scope member is absent — the checkout's link is removed.
    await expect(fs.lstat(path.join(wPath, 'node_modules', '@scope', 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The sibling inside the same scope is still a link to the worktree's
    // packages checkout.
    await expect(fs.readlink(path.join(wPath, 'node_modules', '@scope', 'b'))).resolves.toBe(
      path.join('..', '..', 'packages', 'b')
    );

    await removeWorktree(wPath);
  });

  it('omits a whole TRACKED real-directory package matched by .worktreeignore: the checkout-materialized tree is removed', async () => {
    // A package committed as a real directory under node_modules (files
    // force-added, no symlink): the checkout materializes the real tree, and
    // the whole-package rule must remove it — absent, not present-but-ruled.
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const nm = path.join(repoDir, 'node_modules');
    await fs.mkdir(path.join(nm, 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(nm, 'pkgA', '.cache', 'x.js'), 'export {};\n');
    await fs.writeFile(path.join(nm, 'pkgA', 'index.js'), 'module.exports = 1;');
    await fs.mkdir(path.join(nm, 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(nm, 'left-pad', 'index.js'), 'module.exports = 0;');
    execFileSync('git', ['add', '-f', 'node_modules'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'track real-dir node_modules'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/pkgA\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-real-dir-omit-all', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The omitted real-directory package is entirely absent.
    await expect(fs.lstat(path.join(wPath, 'node_modules', 'pkgA'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The unruled sibling stays present.
    await expect(fs.stat(path.join(wPath, 'node_modules', 'left-pad', 'index.js'))).resolves.toBeDefined();
    // The source checkout is untouched.
    await expect(fs.readFile(path.join(repoDir, 'node_modules', 'pkgA', 'index.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;'
    );

    await removeWorktree(wPath);
  });

  it('honors an interior omit rule under a non-packages workspaces glob (apps/*) with a TRACKED symlinked package', async () => {
    // The mirror owns only what the package.json workspaces globs declare.
    // With a glob-derived ownership (apps/*), apps/bar/node_modules is a
    // rerouted tree and the interior rule is enforced; without it, the rule
    // would no-op and the checkout's tracked link would expose the ruled path
    // to worktree-side writes.
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }));
    const apps = path.join(repoDir, 'apps');
    await fs.mkdir(path.join(apps, 'bar', '.cache'), { recursive: true });
    await fs.writeFile(path.join(apps, 'bar', '.cache', 'tmp'), 'x');
    await fs.writeFile(path.join(apps, 'bar', 'index.js'), 'module.exports = 3;');
    await fs.mkdir(path.join(apps, 'bar', 'node_modules'), { recursive: true });
    await fs.symlink('../../bar', path.join(apps, 'bar', 'node_modules', 'bar'));
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['add', '-f', 'apps/bar/node_modules'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'track apps workspace link'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'apps/bar/node_modules/bar/.cache/tmp\n');

    const { path: wPath, settle } = await createWorktree('feature/tracked-apps-glob-omit', { cwd: repoDir });
    await expect(settle).resolves.toBeDefined();

    // The tracked package is a real directory, never the checkout's link.
    const pkgLstat = await fs.lstat(path.join(wPath, 'apps', 'bar', 'node_modules', 'bar'));
    expect(pkgLstat.isDirectory()).toBe(true);
    expect(pkgLstat.isSymbolicLink()).toBe(false);
    // The ruled path is absent.
    await expect(
      fs.lstat(path.join(wPath, 'apps', 'bar', 'node_modules', 'bar', '.cache', 'tmp'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // A worktree-side write at the ruled path lands in the worktree's real
    // tree and never reaches the source file.
    await fs.writeFile(path.join(wPath, 'apps', 'bar', 'node_modules', 'bar', '.cache', 'tmp'), 'worktree-write\n');
    await expect(fs.readFile(path.join(repoDir, 'apps', 'bar', '.cache', 'tmp'), 'utf8')).resolves.toBe('x');

    await removeWorktree(wPath);
  });

  it('fails closed naming the path when a TRACKED node_modules symlink sits outside the rerouted workspace trees', async () => {
    // A tracked node_modules-segment symlink OUTSIDE the trees the mirror
    // owns (root node_modules plus glob-matched workspace packages) can never
    // be reached by the reroute walk, so a policy rule on it would silently
    // no-op and the checkout's link would stay writable. Worktree creation
    // must fail closed naming the path — even when no rule addresses it.
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const vendor = path.join(repoDir, 'vendor', 'x');
    await fs.mkdir(path.join(vendor, 'node_modules'), { recursive: true });
    await fs.symlink('../../../packages/pkgA', path.join(vendor, 'node_modules', 'link'));
    execFileSync('git', ['add', '-f', 'vendor/x/node_modules'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'track out-of-reach node_modules link'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, '.worktreeignore'), 'node_modules/.vite\n');

    const { settle } = await createWorktree('feature/tracked-out-of-reach', { cwd: repoDir });
    await expect(settle).rejects.toThrow(/vendor\/x\/node_modules\/link/);
    // The failed settle removes the worktree itself (fail-closed cleanup), so
    // no removeWorktree call is needed here.
  });
});

/**
 * Table-driven pinning of the per-entry provisioning decisions the decomposed
 * reroute walk applies identically at every tree level (top-level entries,
 * `@`-scope members, materialized children via rerouteCopiedDir).
 *
 * Each row runs rerouteNodeModules directly against a fixture holding one
 * entry per source shape and asserts that entry's outcome kind: linked to its
 * source, left absent for the policy or the include copy executor, or
 * materialized as a real directory. Child-level nuances of the materialized
 * trees — share-child link shapes, including the worktree-side relative links
 * of an internal-target symlink — get focused assertions alongside the table.
 */
describe('rerouteNodeModules entry-shape provisioning', () => {
  type StubPolicy = WorktreePathQuery & Pick<WorktreePathPolicy, 'copy'>;

  interface PolicyRules {
    /** Paths classified omit outright. */
    omitted: string[];
    /** Leaf paths written by the include copy executor; the paths themselves
     * and their ancestor directories classify copy (mirrors the real
     * policy's matcher-derived copy set). */
    copied: string[];
  }

  function stubPolicy(rules: PolicyRules): StubPolicy {
    const copyAncestors = new Set<string>();
    for (const copied of rules.copied) {
      const parts = copied.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        copyAncestors.add(parts.slice(0, i).join('/'));
      }
    }
    return {
      copy: rules.copied,
      isOmitAncestor: (rel: string): boolean => rules.omitted.some((o) => o.startsWith(`${rel}/`)),
      classify: (rel: string): 'omit' | 'copy' | 'share' => {
        if (rules.omitted.includes(rel)) {
          return 'omit';
        }
        if (rules.copied.includes(rel) || copyAncestors.has(rel)) {
          return 'copy';
        }
        return 'share';
      }
    };
  }

  let seq = 0;

  interface RerouteFixture {
    sourceNm: string;
    destNm: string;
    extVendor: string;
  }

  /**
   * Builds a source node_modules tree holding every entry shape, a matching
   * destination pre-materialized with the entries the policy must remove,
   * internal workspace targets under `packages/`, and external targets under
   * `ext-vendor/`; runs one reroute pass and returns the relevant roots.
   *
   * @param policy - Path policy query driving classification, or undefined
   *   when the row exercises the no-policy behavior.
   * @returns The source and destination node_modules roots and the external
   *   vendor root used by the symlink fixtures.
   */
  async function runReroute(policy?: WorktreePathQuery): Promise<RerouteFixture> {
    seq += 1;
    const root = path.join(tmpBase, `shape-${seq}`);
    const sourceNm = path.join(root, 'node_modules');
    const destNm = path.join(root, 'dest', 'node_modules');
    const packagesRoot = path.join(root, 'packages');
    const extVendor = path.join(tmpBase, `ext-${seq}`);

    await fs.mkdir(path.join(sourceNm, '@scope'), { recursive: true });
    await fs.mkdir(path.join(packagesRoot, 'a'), { recursive: true });
    await fs.writeFile(path.join(packagesRoot, 'a', 'index.js'), 'a\n');
    await fs.mkdir(path.join(packagesRoot, 'b', '.cache'), { recursive: true });
    await fs.writeFile(path.join(packagesRoot, 'b', 's.js'), 'b\n');
    await fs.writeFile(path.join(packagesRoot, 'b', '.cache', 'x.js'), 'ruled\n');
    await fs.mkdir(path.join(extVendor, 'ext-pkg'), { recursive: true });
    await fs.writeFile(path.join(extVendor, 'ext-pkg', 'share.js'), 'ext\n');

    // Top-level shapes.
    await fs.mkdir(path.join(sourceNm, 'plain-dir'));
    await fs.writeFile(path.join(sourceNm, 'plain-dir', 'index.js'), 'dir\n');
    await fs.writeFile(path.join(sourceNm, 'plain-file.js'), 'file\n');
    await fs.writeFile(path.join(sourceNm, 'copied-cache.js'), 'cache\n');
    await fs.mkdir(path.join(sourceNm, 'copied-pkg', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceNm, 'copied-pkg', 'index.js'), 'copied\n');
    await fs.writeFile(path.join(sourceNm, 'copied-pkg', '.cache', 'blob'), 'cache\n');
    await fs.mkdir(path.join(sourceNm, 'pkg-with-ruled-interior', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceNm, 'pkg-with-ruled-interior', 'share.js'), 'share\n');
    await fs.writeFile(path.join(sourceNm, 'pkg-with-ruled-interior', '.cache', 'x.js'), 'ruled\n');

    // Scope-member shapes.
    await fs.mkdir(path.join(sourceNm, '@scope', 'scope-share'));
    await fs.writeFile(path.join(sourceNm, '@scope', 'scope-share', 'index.js'), 'scope\n');
    await fs.writeFile(path.join(sourceNm, '@scope', 'scope-file.js'), 'scope-file\n');
    await fs.writeFile(path.join(sourceNm, '@scope', 'scope-copy-file.js'), 'scope-copy-file\n');
    await fs.mkdir(path.join(sourceNm, '@scope', 'scope-copied', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceNm, '@scope', 'scope-copied', 'index.js'), 'scope-copied\n');
    await fs.writeFile(path.join(sourceNm, '@scope', 'scope-copied', '.cache', 'blob'), 'cache\n');
    await fs.mkdir(path.join(sourceNm, '@scope', 'scope-omitted'));
    await fs.writeFile(path.join(sourceNm, '@scope', 'scope-omitted', 'index.js'), 'omitted\n');
    await fs.mkdir(path.join(sourceNm, 'omitted-entry'));
    await fs.writeFile(path.join(sourceNm, 'omitted-entry', 'tracked.txt'), 'omitted\n');

    // Symlink shapes: internal workspace targets, external targets, a directly
    // copied link, and dangling links whose interiors are ruled — the
    // materialize guard requires a directory target, so these fall through.
    await fs.symlink('../packages/a', path.join(sourceNm, 'internal-link'));
    await fs.symlink('../packages/b', path.join(sourceNm, 'internal-link-ruled'));
    await fs.symlink(path.join(extVendor, 'ext-pkg'), path.join(sourceNm, 'external-link'));
    await fs.symlink(path.join(extVendor, 'ext-pkg'), path.join(sourceNm, 'external-link-ruled'));
    await fs.symlink(path.join(extVendor, 'ext-pkg', 'share.js'), path.join(sourceNm, 'copied-link'));
    await fs.symlink('../missing/pkg', path.join(sourceNm, 'dangling-internal-ruled'));
    await fs.symlink(path.join(extVendor, 'gone'), path.join(sourceNm, 'dangling-external-ruled'));

    // Entries the checkout has already materialized on the committed shape:
    // the omit branches must actively remove exactly these.
    await fs.mkdir(path.join(destNm, 'omitted-entry'), { recursive: true });
    await fs.writeFile(path.join(destNm, 'omitted-entry', 'tracked.txt'), 'tracked\n');
    await fs.mkdir(path.join(destNm, '@scope', 'scope-omitted'), { recursive: true });
    await fs.writeFile(path.join(destNm, '@scope', 'scope-omitted', 'index.js'), 'tracked\n');

    await rerouteNodeModules({
      sourceNodeModules: sourceNm,
      destNodeModules: destNm,
      relativePath: 'node_modules',
      policy
    });
    return { sourceNm, destNm, extVendor };
  }

  const ruledPolicy = stubPolicy({
    omitted: [
      'node_modules/omitted-entry',
      'node_modules/pkg-with-ruled-interior/.cache/x.js',
      'node_modules/@scope/scope-omitted',
      'node_modules/internal-link-ruled/.cache/x.js',
      'node_modules/dangling-internal-ruled/deep/x.js',
      'node_modules/dangling-external-ruled/gone-deep/x.js',
      'node_modules/external-link-ruled/ruled/x.js'
    ],
    copied: [
      'node_modules/copied-cache.js',
      'node_modules/copied-pkg/.cache/blob',
      'node_modules/@scope/scope-copied/.cache/blob',
      'node_modules/@scope/scope-copy-file.js',
      'node_modules/copied-link'
    ]
  });

  type LinkRow = {
    expect: 'link';
    rel: string;
    name: string;
    linkTarget: (fixture: RerouteFixture) => string;
  };
  type AbsentRow = { expect: 'absent'; rel: string; name: string };
  type RealDirRow = { expect: 'realDir'; rel: string; name: string };
  type OutcomeRow = LinkRow | AbsentRow | RealDirRow;

  it.each<OutcomeRow>([
    {
      expect: 'link',
      rel: 'plain-dir',
      name: 'share top-level directory links absolutely to its source',
      linkTarget: (f) => path.join(f.sourceNm, 'plain-dir')
    },
    {
      expect: 'link',
      rel: 'plain-file.js',
      name: 'share top-level file links absolutely to its source',
      linkTarget: (f) => path.join(f.sourceNm, 'plain-file.js')
    },
    {
      expect: 'link',
      rel: 'internal-link',
      name: 'unruled internal workspace link keeps its relative target',
      linkTarget: () => '../packages/a'
    },
    {
      expect: 'link',
      rel: 'external-link',
      name: 'unruled external link points at the source entry',
      linkTarget: (f) => path.join(f.sourceNm, 'external-link')
    },
    {
      expect: 'link',
      rel: 'dangling-internal-ruled',
      name: 'dangling internal link with a ruled interior falls through to target recreation',
      linkTarget: () => '../missing/pkg'
    },
    {
      expect: 'link',
      rel: 'dangling-external-ruled',
      name: 'dangling external link with a ruled interior falls through to a source link',
      linkTarget: (f) => path.join(f.sourceNm, 'dangling-external-ruled')
    },
    {
      expect: 'absent',
      rel: 'copied-cache.js',
      name: 'directly copied cache file stays absent for the include copy executor'
    },
    {
      expect: 'absent',
      rel: 'copied-link',
      name: 'directly copied symlink stays absent for the include copy executor'
    },
    {
      expect: 'absent',
      rel: '@scope/scope-copy-file.js',
      name: 'directly copied scope-member file stays absent for the include copy executor'
    },
    { expect: 'absent', rel: 'omitted-entry', name: 'checkout-materialized omitted entry is removed' },
    { expect: 'absent', rel: '@scope/scope-omitted', name: 'omitted scope member is removed on the committed shape' },
    { expect: 'realDir', rel: 'copied-pkg', name: 'copy-classified package materializes as a real tree' },
    { expect: 'realDir', rel: 'pkg-with-ruled-interior', name: 'interior-omit package materializes as a real tree' },
    { expect: 'realDir', rel: '@scope/scope-copied', name: 'copy-classified scope member materializes as a real tree' },
    {
      expect: 'realDir',
      rel: 'external-link-ruled',
      name: 'external-target symlink with a ruled interior materializes as a real tree'
    },
    {
      expect: 'realDir',
      rel: 'internal-link-ruled',
      name: 'internal-target symlink with a ruled interior materializes as a real tree'
    }
  ])('$name', async (row) => {
    const fixture = await runReroute(ruledPolicy);
    const entryPath = path.join(fixture.destNm, row.rel);
    if (row.expect === 'absent') {
      await expect(fs.lstat(entryPath)).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    if (row.expect === 'realDir') {
      const stats = await fs.lstat(entryPath);
      expect(stats.isDirectory()).toBe(true);
      return;
    }
    await expect(fs.readlink(entryPath)).resolves.toBe(row.linkTarget(fixture));
  });

  it('without a policy share directories and files link absolutely to their sources', async () => {
    const fixture = await runReroute();
    for (const rel of ['plain-dir', 'plain-file.js', '@scope/scope-share', '@scope/scope-file.js']) {
      await expect(fs.readlink(path.join(fixture.destNm, rel))).resolves.toBe(path.join(fixture.sourceNm, rel));
    }
  });

  it('materialized copy and scope-copy trees keep share children linked to their source paths', async () => {
    const fixture = await runReroute(ruledPolicy);
    await expect(fs.readlink(path.join(fixture.destNm, 'copied-pkg', 'index.js'))).resolves.toBe(
      path.join(fixture.sourceNm, 'copied-pkg', 'index.js')
    );
    await expect(fs.readlink(path.join(fixture.destNm, '@scope', 'scope-copied', 'index.js'))).resolves.toBe(
      path.join(fixture.sourceNm, '@scope', 'scope-copied', 'index.js')
    );
  });

  it('interior omit keeps the share sibling linked and the ruled path absent inside the materialized tree', async () => {
    const fixture = await runReroute(ruledPolicy);
    await expect(fs.readlink(path.join(fixture.destNm, 'pkg-with-ruled-interior', 'share.js'))).resolves.toBe(
      path.join(fixture.sourceNm, 'pkg-with-ruled-interior', 'share.js')
    );
    await expect(
      fs.lstat(path.join(fixture.destNm, 'pkg-with-ruled-interior', '.cache', 'x.js'))
    ).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('external materialization reproduces the target shape per file', async () => {
    const fixture = await runReroute(ruledPolicy);
    await expect(fs.readlink(path.join(fixture.destNm, 'external-link-ruled', 'share.js'))).resolves.toBe(
      path.join(fixture.extVendor, 'ext-pkg', 'share.js')
    );
  });

  it('internal materialization links share children relatively into the worktree-side counterpart', async () => {
    const fixture = await runReroute(ruledPolicy);
    const linkPath = path.join(fixture.destNm, 'internal-link-ruled', 's.js');
    const counterpart = path.resolve(path.dirname(path.join(fixture.destNm, 'internal-link-ruled')), '../packages/b');
    await expect(fs.readlink(linkPath)).resolves.toBe(
      path.relative(path.dirname(linkPath), path.join(counterpart, 's.js'))
    );
    await expect(fs.lstat(path.join(fixture.destNm, 'internal-link-ruled', '.cache', 'x.js'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });
});

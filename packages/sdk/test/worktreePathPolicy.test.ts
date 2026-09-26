/**
 * Unit specs for `loadWorktreePathPolicy`.
 *
 * These tests document the full contract of the policy surface — configured
 * patterns, omitted paths, matched copy files, shareable ignored paths, and
 * the path-state query used by rerouting. They were bootstrapped as skipped
 * specs (Phase 2) and unskipped in groups as the implementation was built out
 * (Phase 3).
 *
 * @summary unit specs for loadWorktreePathPolicy
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverIgnoredPaths } from '../src/worktree.js';
import { WorktreeIncludeError } from '../src/worktreeInclude.js';
import {
  enumerateOwnedNodeModules,
  loadWorktreePathPolicy,
  type WorktreePathPolicy
} from '../src/worktreePathPolicy.js';

// Some specs depend on POSIX permission enforcement (chmod 0o000 must actually
// deny access). Two environments cannot provide that: Windows does not
// implement POSIX file modes, and the superuser (uid 0) bypasses POSIX DAC
// permission checks entirely — root can read a 0o000 file, so the expected
// rejection never occurs. Skip honestly in both; the POSIX path itself is
// unchanged.
const cannotEnforcePosixPermissions = process.platform === 'win32' || process.getuid?.() === 0;

/**
 * Creates an isolated tmp directory to use as a source checkout root.
 *
 * @param prefix - Short label appended to the tmp dir name for diagnostics.
 * @returns Absolute path to the empty source root.
 */
async function makeSourceRoot(prefix: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `wpp-${prefix}-`));
  const sourceRoot = path.join(base, 'source');
  await fs.mkdir(sourceRoot, { recursive: true });
  return sourceRoot;
}

/**
 * Initialises a minimal git repo in `dir`. Writes a `.gitignore` with the given
 * patterns, creates any tracked files listed in `trackedFiles`, then makes an
 * initial commit so `git ls-files --ignored` reports the collapsed listing.
 *
 * @param dir - Absolute path to the directory to initialise as a git repo.
 * @param gitignorePatterns - Lines to write into `.gitignore`.
 * @param trackedFiles - Files to create and commit (relative path + content).
 */
async function initGitRepo(
  dir: string,
  gitignorePatterns: string[],
  trackedFiles: Array<{ rel: string; content: string }>
): Promise<void> {
  const { execFileSync } = await import('node:child_process');

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  if (gitignorePatterns.length > 0) {
    await fs.writeFile(path.join(dir, '.gitignore'), `${gitignorePatterns.join('\n')}\n`);
  }

  for (const { rel, content } of trackedFiles) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

/**
 * Loads the policy for a source root using the authoritative collapsed
 * ignored-path input from `discoverIgnoredPaths`.
 *
 * @param sourceRoot - Source checkout root.
 * @returns The loaded worktree path policy.
 */
async function loadPolicy(sourceRoot: string): Promise<WorktreePathPolicy> {
  const ignored = await discoverIgnoredPaths(sourceRoot);
  return loadWorktreePathPolicy({ sourceRoot, ignored });
}

/**
 * Commits the source root's `node_modules` symlinks (force-added despite any
 * `.gitignore` `node_modules/` line) so they are TRACKED — the shape the
 * git-ignored enumeration never reports.
 *
 * @param sourceRoot - Source checkout root holding the links.
 */
async function commitTrackedNodeModules(sourceRoot: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['add', '-f', 'node_modules'], { cwd: sourceRoot });
  execFileSync('git', ['commit', '-q', '-m', 'track node_modules symlinks'], { cwd: sourceRoot });
}

describe('loadWorktreePathPolicy', () => {
  let sourceRoot = '';

  afterEach(async () => {
    // Best-effort cleanup: restore permissions before removal so rm can succeed.
    try {
      await fs.chmod(path.join(sourceRoot, '.worktreeignore'), 0o644);
    } catch (err) {
      console.warn('afterEach: could not restore .worktreeignore mode:', err);
    }
    try {
      await fs.chmod(path.join(sourceRoot, '.worktreeinclude'), 0o644);
    } catch (err) {
      console.warn('afterEach: could not restore .worktreeinclude mode:', err);
    }
    const base = path.dirname(sourceRoot);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('enumerates package-level node_modules from Yarn workspaces object declarations', async () => {
    sourceRoot = await makeSourceRoot('workspaces-object');
    await fs.writeFile(
      path.join(sourceRoot, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['packages/*'] } })
    );
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', 'node_modules'), { recursive: true });

    await expect(enumerateOwnedNodeModules(sourceRoot)).resolves.toEqual([
      'node_modules',
      'packages/pkgA/node_modules'
    ]);
  });

  it('shares every ignored path when neither config file exists', async () => {
    sourceRoot = await makeSourceRoot('no-config');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=hunter2');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.ignorePatterns).toEqual([]);
    expect(policy.includePatterns).toEqual([]);
    expect(policy.omit).toEqual([]);
    expect(policy.copy).toEqual([]);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
    expect(policy.classify('.env')).toBe('share');
  });

  it('shares a collapsed ignored directory without enumerating its descendants when neither config file exists', async () => {
    sourceRoot = await makeSourceRoot('no-config-dir');
    await initGitRepo(sourceRoot, ['dist/', '.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');

    const policy = await loadPolicy(sourceRoot);

    // Both pattern lists are empty, so the per-directory `git ls-files`
    // enumeration is skipped entirely — the collapsed directory shares
    // untouched, with no descendant-level copy or omit decisions.
    expect(policy.ignorePatterns).toEqual([]);
    expect(policy.includePatterns).toEqual([]);
    expect(policy.omit).toEqual([]);
    expect(policy.copy).toEqual([]);
    expect(policy.share).toEqual({ directories: ['dist'], files: ['.env'] });
    expect(policy.classify('dist/bundle.js')).toBe('share');
  });

  it('omits an ignored directory matched by .worktreeignore and keeps other ignored paths shareable', async () => {
    sourceRoot = await makeSourceRoot('ignore-dir');
    await initGitRepo(sourceRoot, ['dist/', '.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.ignorePatterns).toEqual(['dist/']);
    expect(policy.omit).toEqual(['dist']);
    expect(policy.copy).toEqual([]);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
    expect(policy.classify('dist')).toBe('omit');
    // Directory patterns must cover descendants.
    expect(policy.classify('dist/bundle.js')).toBe('omit');
  });

  it('omits a collapsed ignored directory when a `dist/**`-style .worktreeignore glob matches its contents', async () => {
    sourceRoot = await makeSourceRoot('omit-glob-double-star');
    await initGitRepo(sourceRoot, ['dist/**', '.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist', 'sub'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, 'dist', 'sub', 'chunk.js'), 'c');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/**\n');

    const policy = await loadPolicy(sourceRoot);

    // `dist/**` never matches the collapsed `dist` entry itself — only the
    // descendant enumeration surfaces the match, and it must omit the whole
    // collapsed directory or the dist symlink would expose every file. Git
    // reports `dist/bundle.js` as a collapsed-level file for this pattern, so
    // it is matched directly as well. Directory ordering follows git's
    // working-tree readdir order, so compare sorted.
    expect([...policy.omit].sort()).toEqual(['dist', 'dist/sub', 'dist/bundle.js'].sort());
    expect(policy.copy).toEqual([]);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
    expect(policy.classify('dist/bundle.js')).toBe('omit');
    expect(policy.classify('dist/sub/chunk.js')).toBe('omit');
  });

  it('omits a collapsed ignored directory when a `dist/*`-style .worktreeignore glob matches its contents', async () => {
    sourceRoot = await makeSourceRoot('omit-glob-star');
    await initGitRepo(sourceRoot, ['dist/', '.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/*\n');

    const policy = await loadPolicy(sourceRoot);

    // Same root cause as `dist/**`: the glob matches only descendants, and the
    // enumeration must omit the whole collapsed directory.
    expect(policy.omit).toEqual(['dist']);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
    expect(policy.classify('dist/bundle.js')).toBe('omit');
  });

  it('omits a collapsed ignored directory when a file-level .worktreeignore pattern matches one of its files', async () => {
    sourceRoot = await makeSourceRoot('omit-nested-file');
    await initGitRepo(sourceRoot, ['dist/', '.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, 'dist', 'other.js'), 'o');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/bundle.js\n');

    const policy = await loadPolicy(sourceRoot);

    // The pattern matches only a descendant, never the collapsed `dist` entry.
    // Without whole-directory omission the dist symlink would expose bundle.js
    // to worktree-side writes that mutate the source file.
    expect(policy.omit).toEqual(['dist']);
    expect(policy.copy).toEqual([]);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
    expect(policy.classify('dist/bundle.js')).toBe('omit');
  });

  it('keeps a negated .worktreeignore descendant excluded when its parent directory is excluded', async () => {
    sourceRoot = await makeSourceRoot('omit-negation-parent-excluded');
    await initGitRepo(sourceRoot, ['dist/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, 'dist', 'keep.js'), 'k');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/\n!dist/keep.js\n');

    const policy = await loadPolicy(sourceRoot);

    // Git parent-exclusion: a file under an excluded parent cannot be
    // re-included, so `!dist/keep.js` leaves keep.js omitted and the collapsed
    // dir stays omitted wholesale.
    expect(policy.omit).toEqual(['dist']);
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('dist/keep.js')).toBe('omit');
  });

  it('lets a negated .worktreeignore descendant re-include under a non-excluded parent while the dir is still omitted wholesale', async () => {
    sourceRoot = await makeSourceRoot('omit-negation-reinclude');
    await initGitRepo(sourceRoot, ['dist/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, 'dist', 'keep.js'), 'k');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/**\n!dist/keep.js\n');

    const policy = await loadPolicy(sourceRoot);

    // `dist/**` does not exclude `dist` itself, so `!dist/keep.js` re-includes
    // keep.js — matching git semantics — while the still-matching bundle.js
    // keeps the collapsed dir omitted wholesale (a symlink cannot omit part of
    // a directory).
    expect(policy.omit).toEqual(['dist']);
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('dist/bundle.js')).toBe('omit');
    expect(policy.classify('dist/keep.js')).toBe('share');
  });

  it('omits an ignored file matched by .worktreeignore and shares the rest', async () => {
    sourceRoot = await makeSourceRoot('ignore-file');
    await initGitRepo(sourceRoot, ['.env', '.env.local'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'A=1');
    await fs.writeFile(path.join(sourceRoot, '.env.local'), 'B=2');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), '.env\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.omit).toEqual(['.env']);
    expect(policy.share).toEqual({ directories: [], files: ['.env.local'] });
    expect(policy.classify('.env')).toBe('omit');
    expect(policy.classify('.env.local')).toBe('share');
  });

  it('copies an ignored file matched by .worktreeinclude', async () => {
    sourceRoot = await makeSourceRoot('copy-file');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=hunter2');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), '.env\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.includePatterns).toEqual(['.env']);
    expect(policy.copy).toEqual(['.env']);
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('.env')).toBe('copy');
  });

  it('copies ignored files matched by a directory include pattern', async () => {
    sourceRoot = await makeSourceRoot('include-dir-pattern');
    await initGitRepo(sourceRoot, ['config/secrets.json'], [{ rel: 'config/default.json', content: '{"x":1}' }]);
    await fs.writeFile(path.join(sourceRoot, 'config', 'secrets.json'), '{"pw":"s3cr3t"}');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'config/\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual(['config/secrets.json']);
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('config/secrets.json')).toBe('copy');
  });

  it('never selects tracked files for copy', async () => {
    sourceRoot = await makeSourceRoot('tracked-file');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'package.json', content: '{}' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'package.json\n.env\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual(['.env']);
    expect(policy.classify('package.json')).toBe('share');
  });

  it('copies selected files from a fully ignored directory and prevents the directory symlink', async () => {
    sourceRoot = await makeSourceRoot('copy-nested');
    await initGitRepo(sourceRoot, ['dist/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, 'dist', 'other.js'), 'o');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'dist/bundle.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual(['dist/bundle.js']);
    // The copied descendant removes the collapsed directory from share so it
    // is never symlinked; unmatched siblings remain absent.
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('dist')).toBe('copy');
    expect(policy.classify('dist/bundle.js')).toBe('copy');
    expect(policy.classify('dist/other.js')).toBe('share');
  });

  it('copies ignored files from a colon-prefixed ignored directory (literal pathspec)', async () => {
    sourceRoot = await makeSourceRoot('colon-prefixed');
    await initGitRepo(sourceRoot, [':foo/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, ':foo'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, ':foo', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), ':foo/bundle.js\n');

    const policy = await loadPolicy(sourceRoot);

    // `git ls-files ... -- :foo` would parse the leading colon as pathspec
    // magic and silently return nothing; --literal-pathspecs must keep the
    // enumeration working so the selected file is copied and the directory is
    // never symlinked whole.
    expect(policy.copy).toEqual([':foo/bundle.js']);
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify(':foo/bundle.js')).toBe('copy');
  });

  it('applies .worktreeinclude negation like the existing .worktreeinclude tests', async () => {
    sourceRoot = await makeSourceRoot('include-negation');
    await initGitRepo(sourceRoot, ['.env', '.env.local', '.env.public'], [{ rel: 'README.md', content: 'hi' }]);
    for (const file of ['.env', '.env.local', '.env.public']) {
      await fs.writeFile(path.join(sourceRoot, file), 'x');
    }
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), '.env*\n!.env.public\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual(['.env', '.env.local']);
    expect(policy.classify('.env')).toBe('copy');
    expect(policy.classify('.env.public')).toBe('share');
  });

  it('omit wins over copy when a path matches both config files', async () => {
    sourceRoot = await makeSourceRoot('omit-wins');
    await initGitRepo(sourceRoot, ['dist/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/\n');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'dist/bundle.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.omit).toEqual(['dist']);
    expect(policy.copy).toEqual([]);
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('dist/bundle.js')).toBe('omit');
  });

  it('subtracts copied descendants from share candidates at the collapsed directory boundary', async () => {
    sourceRoot = await makeSourceRoot('nested-subtract');
    await initGitRepo(sourceRoot, ['out/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'out', 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'out', 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, 'out', 'dist', 'other.js'), 'o');
    await fs.mkdir(path.join(sourceRoot, 'out', 'cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'out', 'cache', 'c.js'), 'c');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'out/dist/bundle.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual(['out/dist/bundle.js']);
    // The whole collapsed `out/` subtree leaves share: no symlink may stand
    // above a copied descendant, and unmatched ignored siblings stay absent.
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('out')).toBe('copy');
    expect(policy.classify('out/dist')).toBe('copy');
    expect(policy.classify('out/dist/bundle.js')).toBe('copy');
    expect(policy.classify('out/dist/other.js')).toBe('share');
    expect(policy.classify('out/cache/c.js')).toBe('share');
  });

  it('throws WorktreeIncludeError when .worktreeignore is a directory', async () => {
    sourceRoot = await makeSourceRoot('ignore-is-dir');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, '.worktreeignore'));

    await expect(loadPolicy(sourceRoot)).rejects.toThrow(WorktreeIncludeError);
  });

  it('throws WorktreeIncludeError when .worktreeinclude is a directory', async () => {
    sourceRoot = await makeSourceRoot('include-is-dir');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, '.worktreeinclude'));

    await expect(loadPolicy(sourceRoot)).rejects.toThrow(WorktreeIncludeError);
  });

  it.skipIf(cannotEnforcePosixPermissions)(
    'throws WorktreeIncludeError when .worktreeignore is unreadable',
    async () => {
      sourceRoot = await makeSourceRoot('ignore-unreadable');
      await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);

      const ignorePath = path.join(sourceRoot, '.worktreeignore');
      await fs.writeFile(ignorePath, 'dist/\n');
      await fs.chmod(ignorePath, 0o000);

      await expect(loadPolicy(sourceRoot)).rejects.toThrow(WorktreeIncludeError);
    }
  );

  it.skipIf(cannotEnforcePosixPermissions)(
    'throws WorktreeIncludeError when .worktreeinclude is unreadable',
    async () => {
      sourceRoot = await makeSourceRoot('include-unreadable');
      await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);

      const includePath = path.join(sourceRoot, '.worktreeinclude');
      await fs.writeFile(includePath, '.env\n');
      await fs.chmod(includePath, 0o000);

      await expect(loadPolicy(sourceRoot)).rejects.toThrow(WorktreeIncludeError);
    }
  );

  // E5 regression: config presence is decided by lstat, which does not follow
  // symlinks. A dangling symlink at the config path is present-but-unreadable
  // and must fail closed; only a genuinely absent config means no patterns.
  it('throws WorktreeIncludeError naming the config when .worktreeignore is a dangling symlink', async () => {
    sourceRoot = await makeSourceRoot('ignore-dangling-symlink');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.symlink(path.join(sourceRoot, 'missing-ignore-target'), path.join(sourceRoot, '.worktreeignore'));

    await expect(loadPolicy(sourceRoot)).rejects.toThrow(/\.worktreeignore/);
  });

  it('throws WorktreeIncludeError naming the config when .worktreeinclude is a dangling symlink', async () => {
    sourceRoot = await makeSourceRoot('include-dangling-symlink');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    await fs.symlink(path.join(sourceRoot, 'missing-include-target'), path.join(sourceRoot, '.worktreeinclude'));

    await expect(loadPolicy(sourceRoot)).rejects.toThrow(/\.worktreeinclude/);
  });

  it('treats a genuinely absent config as no patterns and still succeeds', async () => {
    sourceRoot = await makeSourceRoot('absent-config');
    await initGitRepo(sourceRoot, ['.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.ignorePatterns).toEqual([]);
    expect(policy.includePatterns).toEqual([]);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
  });

  it('loads patterns from a symlinked config whose target exists', async () => {
    sourceRoot = await makeSourceRoot('ignore-symlinked-target');
    await initGitRepo(sourceRoot, ['dist/', '.env'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.env'), 'SECRET=1');
    const configTarget = path.join(sourceRoot, 'ignore-target');
    await fs.writeFile(configTarget, 'dist/\n');
    await fs.symlink(configTarget, path.join(sourceRoot, '.worktreeignore'));

    const policy = await loadPolicy(sourceRoot);

    expect(policy.ignorePatterns).toEqual(['dist/']);
    expect(policy.omit).toEqual(['dist']);
    expect(policy.share).toEqual({ directories: [], files: ['.env'] });
    expect(policy.classify('dist/bundle.js')).toBe('omit');
  });

  it('classifies node_modules descendants as omit when .worktreeignore matches them', async () => {
    sourceRoot = await makeSourceRoot('reroute-omit');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'node_modules', '.vite', 'deps'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'node_modules', '.vite', 'deps', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/.vite\n');

    const policy = await loadPolicy(sourceRoot);

    // The `.vite` pattern matches only a descendant, never the collapsed
    // node_modules entry — but any omitted descendant omits the whole
    // collapsed directory (a symlink cannot expose part of a directory). The
    // rerouter still rebuilds node_modules because classify stays pattern-based.
    expect(policy.omit).toEqual(['node_modules']);
    expect(policy.share.directories).toEqual([]);
    expect(policy.classify('node_modules')).toBe('share');
    expect(policy.classify('node_modules/.vite')).toBe('omit');
    expect(policy.classify('node_modules/.vite/deps/x.js')).toBe('omit');
  });

  it('exposes the ancestor directories of matcher-matched omitted node_modules paths without widening classify', async () => {
    sourceRoot = await makeSourceRoot('reroute-omit-ancestors');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'node_modules', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'node_modules', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'node_modules', 'pkgA', 'index.js'), 'i');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    // classify stays matcher-direct: the file-level pattern matches only the
    // path itself, so its ancestor directories still classify 'share'...
    expect(policy.classify('node_modules/pkgA')).toBe('share');
    expect(policy.classify('node_modules/pkgA/.cache')).toBe('share');
    expect(policy.classify('node_modules/pkgA/.cache/x.js')).toBe('omit');
    // ...while the ancestor query lets the rerouter materialize them as real
    // trees instead of symlinking them wholesale.
    expect(policy.isOmitAncestor('node_modules')).toBe(true);
    expect(policy.isOmitAncestor('node_modules/pkgA')).toBe(true);
    expect(policy.isOmitAncestor('node_modules/pkgA/.cache')).toBe(true);
    // The matched path itself is not an ancestor; unrelated paths are not.
    expect(policy.isOmitAncestor('node_modules/pkgA/.cache/x.js')).toBe(false);
    expect(policy.isOmitAncestor('node_modules/pkgA/index.js')).toBe(false);
    expect(policy.isOmitAncestor('node_modules/other')).toBe(false);
  });

  it('classifies a copied node_modules descendant as copy and its ancestors as copy', async () => {
    sourceRoot = await makeSourceRoot('reroute-copy');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'node_modules', '.vite', 'deps'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'node_modules', '.vite', 'deps', 'x.js'), 'x');
    await fs.mkdir(path.join(sourceRoot, 'node_modules', '.vite', 'cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'node_modules', '.vite', 'cache', 'y.js'), 'y');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'node_modules/.vite/deps/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual(['node_modules/.vite/deps/x.js']);
    // The copied descendant removes the collapsed node_modules directory from
    // share so no ancestor symlink can stand above it.
    expect(policy.share).toEqual({ directories: [], files: [] });
    expect(policy.classify('node_modules/.vite')).toBe('copy');
    expect(policy.classify('node_modules/.vite/deps')).toBe('copy');
    expect(policy.classify('node_modules/.vite/deps/x.js')).toBe('copy');
    expect(policy.classify('node_modules/.vite/cache/y.js')).toBe('share');
  });

  it('keeps omit winning over copy for rerouted node_modules descendants', async () => {
    sourceRoot = await makeSourceRoot('reroute-omit-wins');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'node_modules', '.vite', 'deps'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'node_modules', '.vite', 'deps', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/.vite\n');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'node_modules/.vite/deps/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual([]);
    expect(policy.omit).toEqual(['node_modules']);
    expect(policy.share.directories).toEqual([]);
    expect(policy.classify('node_modules/.vite')).toBe('omit');
    expect(policy.classify('node_modules/.vite/deps/x.js')).toBe('omit');
  });

  it('normalizes backslashes to POSIX form in classify queries', async () => {
    sourceRoot = await makeSourceRoot('posix');
    await initGitRepo(sourceRoot, ['dist/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'dist', 'bundle.js'), 'b');
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'dist/\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.classify('dist\\bundle.js')).toBe('omit');
  });

  it('sees through a symlinked node_modules package when a .worktreeignore rule addresses its interior', async () => {
    // The workspaces shape: node_modules entries are links into packages/.
    // git reports the link itself but never its interior, so the descendant
    // enumeration must synthesize node_modules/pkgA/.cache/x.js — the path the
    // user's file-level rule addresses — or the omit decision silently no-ops.
    sourceRoot = await makeSourceRoot('symlink-omit');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', 'index.js'), 'i');
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(sourceRoot, 'node_modules', 'pkgA'));
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    // The synthesized descendant matched, so the collapsed node_modules dir is
    // omitted wholesale (a symlink cannot expose part of a directory) and the
    // rule's ancestor directories are exposed to the rerouter.
    expect(policy.omit).toEqual(['node_modules']);
    expect(policy.isOmitAncestor('node_modules')).toBe(true);
    expect(policy.isOmitAncestor('node_modules/pkgA')).toBe(true);
    expect(policy.isOmitAncestor('node_modules/pkgA/.cache')).toBe(true);
    // classify stays matcher-direct and pattern-based.
    expect(policy.classify('node_modules/pkgA')).toBe('share');
    expect(policy.classify('node_modules/pkgA/.cache/x.js')).toBe('omit');
  });

  it('sees through a symlinked node_modules package when a .worktreeinclude rule addresses its interior', async () => {
    sourceRoot = await makeSourceRoot('symlink-copy');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', 'index.js'), 'i');
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(sourceRoot, 'node_modules', 'pkgA'));
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    // The synthesized descendant is the copy source the executor reads through
    // the link, and its ancestor package classifies copy so no symlink stands
    // above the copied descendant.
    expect(policy.copy).toEqual(['node_modules/pkgA/.cache/x.js']);
    expect(policy.classify('node_modules/pkgA')).toBe('copy');
    expect(policy.classify('node_modules/pkgA/.cache/x.js')).toBe('copy');
  });

  it('terminates on a symlink cycle while enumerating symlinked package descendants', async () => {
    sourceRoot = await makeSourceRoot('symlink-cycle');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'packages', 'a'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'a', 'index.js'), 'i');
    // packages/a/loop -> ../../node_modules/a resolves back to the walked
    // package; the cycle guard must stop the second visit.
    await fs.symlink('../../node_modules/a', path.join(sourceRoot, 'packages', 'a', 'loop'));
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/a', path.join(sourceRoot, 'node_modules', 'a'));
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/a/index.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.isOmitAncestor('node_modules/a')).toBe(true);
    // The loop path exists in the checkout and classifies share (unruled).
    expect(policy.classify('node_modules/a/loop')).toBe('share');
  });

  it('sees through a TRACKED symlinked node_modules package when a .worktreeignore rule addresses its interior', async () => {
    // The workspaces shape with the links COMMITTED (force-added): git never
    // reports a tracked file as ignored, so the ignored enumeration is blind
    // to the link — the tracked-symlink phase must synthesize its interior or
    // the file-level rule silently no-ops and a worktree-side write at the
    // ruled path reaches the source.
    sourceRoot = await makeSourceRoot('tracked-symlink-omit');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    // The tracked phase covers only the node_modules trees the rerouter owns
    // (derived from the workspaces globs); without a workspaces declaration
    // the fixture's tracked links would fail closed as out of reach.
    await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', 'index.js'), 'i');
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(sourceRoot, 'node_modules', 'pkgA'));
    await commitTrackedNodeModules(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    // The synthesized descendant matched, so the rule's ancestor directories
    // — including the tracked link itself — are exposed to the rerouter.
    expect(policy.isOmitAncestor('node_modules')).toBe(true);
    expect(policy.isOmitAncestor('node_modules/pkgA')).toBe(true);
    expect(policy.isOmitAncestor('node_modules/pkgA/.cache')).toBe(true);
    // classify stays matcher-direct and pattern-based.
    expect(policy.classify('node_modules/pkgA')).toBe('share');
    expect(policy.classify('node_modules/pkgA/.cache/x.js')).toBe('omit');
    expect(policy.classify('node_modules/pkgA/index.js')).toBe('share');
  });

  it('sees through a TRACKED symlinked node_modules package when a .worktreeinclude rule addresses its interior', async () => {
    sourceRoot = await makeSourceRoot('tracked-symlink-copy');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', 'index.js'), 'i');
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(sourceRoot, 'node_modules', 'pkgA'));
    await commitTrackedNodeModules(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    // The synthesized descendant is the copy source the executor reads
    // through the tracked link, and its ancestor package classifies copy so
    // the reroute walk materializes it instead of recreating the link.
    expect(policy.copy).toEqual(['node_modules/pkgA/.cache/x.js']);
    expect(policy.classify('node_modules/pkgA')).toBe('copy');
    expect(policy.classify('node_modules/pkgA/.cache/x.js')).toBe('copy');
  });

  it('keeps omit winning over copy for a TRACKED symlinked node_modules descendant', async () => {
    sourceRoot = await makeSourceRoot('tracked-symlink-omit-wins');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', 'index.js'), 'i');
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(sourceRoot, 'node_modules', 'pkgA'));
    await commitTrackedNodeModules(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/pkgA/.cache/x.js\n');
    await fs.writeFile(path.join(sourceRoot, '.worktreeinclude'), 'node_modules/pkgA/.cache/x.js\n');

    const policy = await loadPolicy(sourceRoot);

    expect(policy.copy).toEqual([]);
    expect(policy.classify('node_modules/pkgA/.cache/x.js')).toBe('omit');
  });

  it('keeps tracked symlinked packages out of the policy when neither config file exists', async () => {
    sourceRoot = await makeSourceRoot('tracked-symlink-no-config');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.mkdir(path.join(sourceRoot, 'packages', 'pkgA', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'packages', 'pkgA', '.cache', 'x.js'), 'x');
    await fs.mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true });
    await fs.symlink('../packages/pkgA', path.join(sourceRoot, 'node_modules', 'pkgA'));
    await commitTrackedNodeModules(sourceRoot);

    const policy = await loadPolicy(sourceRoot);

    expect(policy.ignorePatterns).toEqual([]);
    expect(policy.includePatterns).toEqual([]);
    expect(policy.omit).toEqual([]);
    expect(policy.copy).toEqual([]);
    expect(policy.isOmitAncestor('node_modules/pkgA')).toBe(false);
  });

  it('sees through a TRACKED symlinked package under a non-packages workspaces glob (apps/*)', async () => {
    // The tracked phase is scoped to the node_modules trees the rerouter owns,
    // which are derived from the workspaces globs — a glob like apps/* (not
    // packages/*) must still put apps/bar/node_modules in reach, or the rule
    // silently no-ops and the checkout's link stays writable.
    sourceRoot = await makeSourceRoot('tracked-apps-glob');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }));
    await fs.mkdir(path.join(sourceRoot, 'apps', 'bar', '.cache'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'apps', 'bar', '.cache', 'tmp'), 'x');
    await fs.writeFile(path.join(sourceRoot, 'apps', 'bar', 'index.js'), 'i');
    await fs.mkdir(path.join(sourceRoot, 'apps', 'bar', 'node_modules'), { recursive: true });
    await fs.symlink('../../bar', path.join(sourceRoot, 'apps', 'bar', 'node_modules', 'bar'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['add', '.'], { cwd: sourceRoot });
    execFileSync('git', ['add', '-f', 'apps/bar/node_modules'], { cwd: sourceRoot });
    execFileSync('git', ['commit', '-q', '-m', 'track apps workspace link'], { cwd: sourceRoot });
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'apps/bar/node_modules/bar/.cache/tmp\n');

    const policy = await loadPolicy(sourceRoot);

    // The glob-derived tree is in reach, so the interior is synthesized and
    // the rule's ancestor directories are exposed to the rerouter.
    expect(policy.isOmitAncestor('apps/bar/node_modules/bar')).toBe(true);
    expect(policy.isOmitAncestor('apps/bar/node_modules/bar/.cache')).toBe(true);
    expect(policy.classify('apps/bar/node_modules/bar/.cache/tmp')).toBe('omit');
  });

  it('fails closed on a TRACKED node_modules symlink outside the rerouted workspace trees, naming the path', async () => {
    // A tracked node_modules-segment symlink OUTSIDE the trees the rerouter
    // owns can never be enforced by the walk — the checkout's link would stay
    // in place and a worktree-side write at a ruled path would reach the
    // source. The policy must fail closed naming the path instead of silently
    // leaving the rule unenforced.
    sourceRoot = await makeSourceRoot('tracked-out-of-reach');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    await fs.mkdir(path.join(sourceRoot, 'vendor', 'x', 'node_modules'), { recursive: true });
    await fs.symlink('../../../packages/pkgA', path.join(sourceRoot, 'vendor', 'x', 'node_modules', 'link'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['add', '-f', 'vendor/x/node_modules'], { cwd: sourceRoot });
    execFileSync('git', ['commit', '-q', '-m', 'track out-of-reach node_modules link'], { cwd: sourceRoot });
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/pkgA\n');

    const error = await loadPolicy(sourceRoot).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(WorktreeIncludeError);
    expect(error).not.toBeNull();
    expect((error as Error).message).toContain('vendor/x/node_modules/link');
  });

  it('names the remedy variable when the enumeration deadline expires', async () => {
    sourceRoot = await makeSourceRoot('timeout-remedy');
    await initGitRepo(sourceRoot, ['node_modules/'], [{ rel: 'README.md', content: 'hi' }]);
    await fs.writeFile(path.join(sourceRoot, '.worktreeignore'), 'node_modules/pkgA\n');
    const timeoutKey = 'CARDS_WORKTREE_POLICY_TIMEOUT_MS';
    const previous = process.env[timeoutKey];
    process.env[timeoutKey] = '1';
    // Deterministic expiry: every Date.now() reading advances simulated time
    // by 10ms, so whatever instant the 1ms budget is stamped at, the very next
    // reading — including the deadline check itself — is already past it. The
    // previous wall-clock-only version passed only when the host was slow
    // enough to lose a 1ms race against its own git spawn: on a fast, idle box
    // the whole enumeration (one tracked-symlink scan, no ignored paths) fit
    // between two real readings and the test failed with a null error.
    let simulatedNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (simulatedNow += 10));
    try {
      const ignored = await discoverIgnoredPaths(sourceRoot);
      const error = await loadWorktreePathPolicy({ sourceRoot, ignored }).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(WorktreeIncludeError);
      expect((error as Error).message).toContain('enumeration timed out');
      expect((error as Error).message).toContain(timeoutKey);
      expect((error as Error).message).toContain('30000');
    } finally {
      nowSpy.mockRestore();
      if (previous === undefined) {
        delete process.env[timeoutKey];
      } else {
        process.env[timeoutKey] = previous;
      }
    }
  });
});

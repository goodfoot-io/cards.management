/**
 * Per-worktree hook delivery tests.
 *
 * Covers the outfit disk phase (A2 race fix / D9 ordering / D10a guard) layered
 * on the pure createWorktree primitive, and the generated dispatcher scripts
 * (D2 stdin classification, D3 exit-code propagation, D11 no-stdin-hang). The
 * hook-provisioning logic moved out of createWorktree into
 * outfitWorktreeForCard; createWorktree is now a pure git primitive. No mocks —
 * real git worktrees, real bash invocation of the generated dispatcher scripts.
 * A minimal fake CardsClient stands in for the API phase's addBranch.
 *
 * @summary Per-worktree hook provisioning (outfit) + dispatcher script tests
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardsClient } from '../src/client/cardsClient.js';
import { createWorktree, provisionSharedHooksDir } from '../src/worktree.js';
import { outfitWorktreeForCard } from '../src/worktreeForCard.js';

const CARDS_WORKTREES_DIR_KEY = 'CARDS_WORKTREES_DIR';

let _bash: string | undefined;

/**
 * Resolves a `bash` executable for running the generated dispatcher scripts.
 *
 * On POSIX `bash` is on PATH. On Windows, Git for Windows ships bash but usually
 * keeps it off the PATH, so derive it from `git --exec-path`
 * (`.../<GitRoot>/mingw{64,32}/libexec/git-core`) — the same bash git uses to run
 * hooks at runtime. Falls back to the bare name so a missing bash surfaces a
 * clear ENOENT rather than a silent skip.
 *
 * @returns Absolute path to a bash executable, or the bare name `bash`.
 */
function resolveBash(): string {
  if (_bash !== undefined) return _bash;
  if (process.platform !== 'win32') {
    _bash = 'bash';
    return _bash;
  }
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim().replace(/\\/g, '/');
  const marker = execPath.search(/\/mingw(?:64|32)\//);
  const gitRoot = marker >= 0 ? execPath.slice(0, marker) : path.dirname(path.dirname(execPath));
  for (const candidate of [`${gitRoot}/bin/bash.exe`, `${gitRoot}/usr/bin/bash.exe`]) {
    if (existsSync(candidate)) {
      _bash = candidate;
      return _bash;
    }
  }
  _bash = 'bash';
  return _bash;
}

/**
 * Minimal CardsClient fake whose addBranch resolves immediately — outfit's API
 * phase only needs addBranch to succeed for these on-disk hook tests.
 *
 * @returns A CardsClient stand-in with no-op addBranch/removeBranch.
 */
function makeFakeClient(): CardsClient {
  return {
    addBranch: async () => ({ outcome: 'created', revision: 'test-revision' }),
    removeBranch: async () => undefined
  } as unknown as CardsClient;
}

/**
 * Creates a pure worktree then outfits it as card-bound — the composition that
 * createWorktreeForCard performs at creation time. Returns the worktree path and
 * the settle promise from the underlying createWorktree.
 *
 * @param ref - Branch ref to create.
 * @param cardId - Card identifier to bind.
 * @param cwd - Source repo working directory.
 * @param compiledScriptPaths - Compiled .mjs map for the dispatcher.
 * @returns The worktree path and the underlying createWorktree settle promise.
 */
async function createAndOutfit(
  ref: string,
  cardId: string,
  cwd: string,
  compiledScriptPaths: Record<string, string>
): Promise<{ path: string; settle: Promise<unknown> }> {
  const result = await createWorktree(ref, { cwd });
  await outfitWorktreeForCard(makeFakeClient(), result.path, {
    cardId,
    parentBranch: 'main',
    compiledScriptPaths
  });
  return { path: result.path, settle: result.settle };
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

function gitWorktreeConfig(worktreeDir: string, key: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreeDir, 'config', '--worktree', key], {
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

describe('createWorktree per-worktree hook provisioning', () => {
  let tmpBase = '';
  let repoDir = '';
  let worktreesDir = '';
  let mjsDir = '';
  let homeDir = '';
  let sharedHooksDir = '';
  let compiledScriptPaths: Record<string, string>;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Canonicalize: the provisioner records CARD_ORIGINAL_HOOK_PATH as the
    // realpath of .git/hooks, so on macOS it resolves to /private/var/...
    // rather than /var/... — realpath the base so derived paths match.
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wht-test-')));
    repoDir = path.join(tmpBase, 'repo');
    worktreesDir = path.join(tmpBase, 'worktrees');
    mjsDir = path.join(tmpBase, 'git-hooks');
    homeDir = path.join(tmpBase, 'home');
    sharedHooksDir = path.join(homeDir, '.cards', 'workspace-hooks');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    await fs.mkdir(mjsDir);
    await fs.mkdir(homeDir);
    initGitRepo(repoDir);

    // Real compiled-artifact stand-ins: a node script per Cards-active type
    // that records its invocation so dispatcher tests can assert delivery.
    for (const hook of ['pre-commit', 'post-commit', 'post-rewrite']) {
      const p = path.join(mjsDir, `${hook}.mjs`);
      await fs.writeFile(
        p,
        `import fs from 'node:fs';\n` +
          `let stdin='';try{stdin=fs.readFileSync(0,'utf8');}catch{}\n` +
          `fs.appendFileSync(process.env.CARDS_TEST_LOG, 'cards:${hook}:'+process.argv.slice(2).join(',')+':'+stdin+'\\n');\n`
      );
    }
    compiledScriptPaths = {
      'pre-commit': path.join(mjsDir, 'pre-commit.mjs'),
      'post-commit': path.join(mjsDir, 'post-commit.mjs'),
      'post-rewrite': path.join(mjsDir, 'post-rewrite.mjs')
    };

    process.env = { ...originalEnv, [CARDS_WORKTREES_DIR_KEY]: worktreesDir, HOME: homeDir };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tmpBase) {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it('writes .cards/CARD_ID and .cards/CARD_ORIGINAL_HOOK_PATH before settle resolves (A2)', async () => {
    const { path: wPath, settle } = await createAndOutfit('cards/main-1/1', 'main-1', repoDir, compiledScriptPaths);

    // Inspect immediately — do NOT await settle. The agent could commit here.
    const cardId = await fs.readFile(path.join(wPath, '.cards', 'CARD_ID'), 'utf8');
    expect(cardId).toBe('main-1\n');
    const orig = await fs.readFile(path.join(wPath, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), 'utf8');
    expect(orig).toBe(path.join(repoDir, '.git', 'hooks'));

    await settle;
  });

  it('sets per-worktree core.hooksPath, with extensions.worktreeConfig set first (D9), before settle resolves', async () => {
    const { path: wPath, settle } = await createAndOutfit('cards/main-2/1', 'main-2', repoDir, compiledScriptPaths);

    // Both git-config invariants must hold before settle is awaited.
    const worktreeConfigEnabled = execFileSync('git', ['-C', repoDir, 'config', 'extensions.worktreeConfig'], {
      encoding: 'utf8'
    }).trim();
    expect(worktreeConfigEnabled).toBe('true');

    expect(gitWorktreeConfig(wPath, 'core.hooksPath')).toBe(sharedHooksDir);

    await settle;
  });

  it('writes a dispatcher script for every client-side hook type plus the three Cards .mjs', async () => {
    const { settle } = await createAndOutfit('cards/main-3/1', 'main-3', repoDir, compiledScriptPaths);
    await settle;

    const entries = (await fs.readdir(sharedHooksDir)).sort();
    const expectedHooks = [
      'applypatch-msg',
      'pre-applypatch',
      'post-applypatch',
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'pre-rebase',
      'post-checkout',
      'post-merge',
      'pre-push',
      'post-rewrite',
      'reference-transaction',
      'post-index-change',
      'pre-merge-commit',
      'sendemail-validate',
      'push-to-checkout'
    ];
    for (const h of expectedHooks) {
      expect(entries).toContain(h);
    }
    expect(entries).toContain('pre-commit.mjs');
    expect(entries).toContain('post-commit.mjs');
    expect(entries).toContain('post-rewrite.mjs');
  });

  // Regression: dispatchers resolve $NODE_RUN to the bundled VSCODE_NODE, which
  // is a desktop VS Code's Electron binary. git spawns these hooks without
  // ELECTRON_RUN_AS_NODE=1, so without the export every commit pops a focus-
  // stealing Electron GUI window (very visible on a macOS host).
  it('exports ELECTRON_RUN_AS_NODE in the Cards-hook dispatchers', async () => {
    const { settle } = await createAndOutfit('cards/main-6/1', 'main-6', repoDir, compiledScriptPaths);
    await settle;

    for (const hook of ['post-commit', 'pre-commit', 'post-rewrite']) {
      const content = await fs.readFile(path.join(sharedHooksDir, hook), 'utf-8');
      expect(content).toContain('export ELECTRON_RUN_AS_NODE=1');
    }
  });

  it('does NOT set core.hooksPath when cardId is omitted (unbound worktree, no hook injection)', async () => {
    const { path: wPath, settle } = await createWorktree('feature/unbound', { cwd: repoDir });
    await settle;

    expect(gitWorktreeConfig(wPath, 'core.hooksPath')).toBeNull();
    await expect(fs.access(sharedHooksDir)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('throws the D10a guard when outfit is given an empty compiledScriptPaths map', async () => {
    const { path: wPath, settle } = await createWorktree('cards/main-4/1', { cwd: repoDir });
    await settle;
    await expect(
      outfitWorktreeForCard(makeFakeClient(), wPath, {
        cardId: 'main-4',
        parentBranch: 'main',
        compiledScriptPaths: {}
      })
    ).rejects.toThrow(/compiledScriptPaths must be non-empty/);
  });

  it('rejects an empty cardId', async () => {
    const { path: wPath, settle } = await createWorktree('cards/main-5/1', { cwd: repoDir });
    await settle;
    await expect(
      outfitWorktreeForCard(makeFakeClient(), wPath, {
        cardId: '',
        parentBranch: 'main',
        compiledScriptPaths
      })
    ).rejects.toThrow(/non-empty/);
  });
});

describe('provisionSharedHooksDir content-addressed skip', () => {
  let tmpBase = '';
  let hooksDir = '';
  let mjsPath = '';
  let compiled: Record<string, string>;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'phd-test-'));
    hooksDir = path.join(tmpBase, 'workspace-hooks');
    mjsPath = path.join(tmpBase, 'post-commit.mjs');
    await fs.writeFile(mjsPath, '// v1\n');
    compiled = { 'post-commit': mjsPath };
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('skips re-provisioning when inputs are unchanged', async () => {
    await provisionSharedHooksDir(hooksDir, compiled);
    // Tamper with a provisioned dispatcher; an unchanged-input re-run must skip
    // and leave the tamper in place, proving it did not rewrite the files.
    const preCommit = path.join(hooksDir, 'pre-commit');
    await fs.writeFile(preCommit, 'TAMPERED');

    await provisionSharedHooksDir(hooksDir, compiled);

    expect(await fs.readFile(preCommit, 'utf-8')).toBe('TAMPERED');
  });

  it('re-provisions when a compiled .mjs input changes', async () => {
    await provisionSharedHooksDir(hooksDir, compiled);
    const preCommit = path.join(hooksDir, 'pre-commit');
    await fs.writeFile(preCommit, 'TAMPERED');

    // Change the .mjs content and bump its mtime so the stat-based key differs.
    await fs.writeFile(mjsPath, '// v2 changed\n');
    await fs.utimes(mjsPath, new Date(), new Date(Date.now() + 5_000));

    await provisionSharedHooksDir(hooksDir, compiled);

    // The dispatcher was rewritten (tamper gone) and the new .mjs content landed.
    expect(await fs.readFile(preCommit, 'utf-8')).not.toBe('TAMPERED');
    expect(await fs.readFile(path.join(hooksDir, 'post-commit.mjs'), 'utf-8')).toContain('v2 changed');
  });
});

describe('generated dispatcher scripts', () => {
  let tmpBase = '';
  let sharedDir = '';
  let worktreeRoot = '';
  let originalHooksDir = '';
  let testLog = '';
  const originalEnv = process.env;

  /**
   * Provisions a shared hooks dir via a real card-bound worktree, then points
   * a synthetic worktree root at a controllable original-hooks dir so we can
   * exercise the dispatchers directly with bash.
   */
  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'disp-test-'));
    const repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    const mjsDir = path.join(tmpBase, 'git-hooks');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    await fs.mkdir(mjsDir);
    initGitRepo(repoDir);

    testLog = path.join(tmpBase, 'invocations.log');
    await fs.writeFile(testLog, '');

    for (const hook of ['pre-commit', 'post-commit', 'post-rewrite']) {
      await fs.writeFile(
        path.join(mjsDir, `${hook}.mjs`),
        `import fs from 'node:fs';\n` +
          `let stdin='';try{stdin=fs.readFileSync(0,'utf8');}catch{}\n` +
          `fs.appendFileSync(process.env.CARDS_TEST_LOG, 'cards:${hook}:'+process.argv.slice(2).join(',')+':'+stdin+'\\n');\n`
      );
    }

    const homeDir = path.join(tmpBase, 'home');
    await fs.mkdir(homeDir);
    process.env = { ...originalEnv, [CARDS_WORKTREES_DIR_KEY]: worktreesDir, HOME: homeDir };
    const { path: wPath, settle } = await createAndOutfit('cards/main-9/1', 'main-9', repoDir, {
      'pre-commit': path.join(mjsDir, 'pre-commit.mjs'),
      'post-commit': path.join(mjsDir, 'post-commit.mjs'),
      'post-rewrite': path.join(mjsDir, 'post-rewrite.mjs')
    });
    await settle;

    sharedDir = path.join(homeDir, '.cards', 'workspace-hooks');

    // A real git worktree root so `git rev-parse --show-toplevel` resolves.
    worktreeRoot = wPath;
    originalHooksDir = path.join(tmpBase, 'orig-hooks');
    await fs.mkdir(originalHooksDir, { recursive: true });
    await fs.writeFile(path.join(worktreeRoot, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), originalHooksDir);
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tmpBase) {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  /**
   * Runs a dispatcher script with bash from inside the worktree root.
   *
   * @param hookType - Dispatcher script name to run.
   * @param args - Positional args passed to the hook.
   * @param stdin - Data piped to the hook's stdin.
   * @returns Process status, stdout, and stderr.
   */
  function runDispatcher(
    hookType: string,
    args: string[],
    stdin: string
  ): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(resolveBash(), [path.join(sharedDir, hookType), ...args], {
        cwd: worktreeRoot,
        input: stdin,
        encoding: 'utf8',
        env: { ...process.env, CARDS_TEST_LOG: testLog }
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  async function makeOriginalHook(name: string, body: string): Promise<void> {
    const p = path.join(originalHooksDir, name);
    await fs.writeFile(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }

  it('post-rewrite delivers identical stdin to both the Cards .mjs and the original hook (D2)', async () => {
    const origStdinCapture = path.join(tmpBase, 'orig-rewrite-stdin');
    await makeOriginalHook('post-rewrite', `cat > "${origStdinCapture}"`);

    const stdinPayload = 'oldsha newsha\nanother pair\n';
    const res = runDispatcher('post-rewrite', ['amend'], stdinPayload);
    expect(res.status).toBe(0);

    const log = await fs.readFile(testLog, 'utf8');
    expect(log).toContain(`cards:post-rewrite:amend:${stdinPayload}`);
    const origSeen = await fs.readFile(origStdinCapture, 'utf8');
    expect(origSeen).toBe(stdinPayload);
  });

  it('pre-push inherits stdin directly and propagates the original hook non-zero exit (D3)', async () => {
    await makeOriginalHook('pre-push', `read -r line; echo "got:$line"; exit 7`);

    const res = runDispatcher('pre-push', ['origin', 'url'], 'refdata\n');
    expect(res.status).toBe(7);
    expect(res.stdout).toContain('got:refdata');
    // No Cards .mjs for pre-push
    const log = await fs.readFile(testLog, 'utf8');
    expect(log).not.toContain('cards:pre-push');
  });

  it('reference-transaction is pass-through; original non-zero exit propagates (D3)', async () => {
    await makeOriginalHook('reference-transaction', `exit 3`);
    const res = runDispatcher('reference-transaction', ['committed'], 'a b ref\n');
    expect(res.status).toBe(3);
  });

  it('commit-msg forwards the $1 file path and never reads stdin', async () => {
    const seenArg = path.join(tmpBase, 'commit-msg-arg');
    await makeOriginalHook('commit-msg', `echo -n "$1" > "${seenArg}"`);

    const msgFile = path.join(tmpBase, 'COMMIT_EDITMSG');
    await fs.writeFile(msgFile, 'a message');
    // Provide stdin that must be ignored — a stdin-reading template would hang.
    const res = runDispatcher('commit-msg', [msgFile], 'SHOULD-BE-IGNORED');
    expect(res.status).toBe(0);
    expect(await fs.readFile(seenArg, 'utf8')).toBe(msgFile);
  });

  it('missing CARD_ORIGINAL_HOOK_PATH → dispatcher skips original and exits 0', async () => {
    await fs.rm(path.join(worktreeRoot, '.cards', 'CARD_ORIGINAL_HOOK_PATH'));
    const res = runDispatcher('post-commit', [], '');
    expect(res.status).toBe(0);
  });

  it('pre-commit blocks the commit fail-closed when the Cards .mjs exits non-zero', async () => {
    // Rewrite the compiled pre-commit to fail.
    const failingMjs = path.join(sharedDir, 'pre-commit.mjs');
    await fs.writeFile(failingMjs, `process.exit(42);\n`);
    const res = runDispatcher('pre-commit', [], '');
    expect(res.status).toBe(42);
  });

  it('post-commit runs the Cards hook then chains the original (D5)', async () => {
    const origMarker = path.join(tmpBase, 'orig-post-commit-ran');
    await makeOriginalHook('post-commit', `touch "${origMarker}"`);
    const res = runDispatcher('post-commit', [], '');
    expect(res.status).toBe(0);
    const log = await fs.readFile(testLog, 'utf8');
    expect(log).toContain('cards:post-commit:');
    await expect(fs.access(origMarker)).resolves.toBeUndefined();
  });

  it('pre-commit fails with an error when no Node interpreter is resolvable', async () => {
    // HOME is already a temp dir, so ~/.cards/VSCODE_NODE does not exist.
    // Remove node from PATH so that `command -v node` also fails, which
    // causes RESOLVE_NODE to set NODE_RUN="". The dispatcher must detect
    // the missing interpreter and block the commit instead of silently
    // skipping the Cards hook and exiting 0.
    const savedPath = process.env['PATH']!;

    // Build a minimal PATH with bash, cat, git, and dirname — the only
    // commands the pre-commit dispatcher prologue and RESOLVE_NODE need —
    // but deliberately excluding node.
    const noNodeBin = path.join(tmpBase, 'no-node-bin');
    await fs.mkdir(noNodeBin, { recursive: true });
    const bash = resolveBash();
    for (const cmd of ['bash', 'cat', 'git', 'dirname']) {
      const realPath = execFileSync(bash, ['-c', `command -v ${cmd}`], {
        encoding: 'utf8'
      }).trim();
      if (realPath) {
        await fs.symlink(realPath, path.join(noNodeBin, cmd));
      }
    }
    process.env['PATH'] = noNodeBin;

    try {
      const res = runDispatcher('pre-commit', [], '');
      // The current (unfixed) code exits 0 because [ -n "$NODE_RUN" ] is
      // false when NODE_RUN is empty, silently skipping the Cards hook.
      // After the fix the dispatcher must exit non-zero and write an
      // error about the missing Node interpreter to stderr.
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/node/i);
    } finally {
      process.env['PATH'] = savedPath;
    }
  });

  // ─── CARDS_SKIP_HOOK ────────────────────────────────────────────────

  it('CARDS_SKIP_HOOK=1 skips pre-commit even when .mjs would block', async () => {
    const prev = process.env['CARDS_SKIP_HOOK'];
    process.env['CARDS_SKIP_HOOK'] = '1';
    try {
      // Write a failing pre-commit.mjs — if the dispatcher delegated, it'd
      // exit 42 and block the commit.
      const failingMjs = path.join(sharedDir, 'pre-commit.mjs');
      await fs.writeFile(failingMjs, `process.exit(42);\n`);

      const res = runDispatcher('pre-commit', [], '');
      // The dispatcher checks CARDS_SKIP_HOOK before delegation and exits 0.
      expect(res.status).toBe(0);

      // The Cards .mjs must NOT have fired — the skip guard exits before
      // RESOLVE_NODE runs.
      const log = await fs.readFile(testLog, 'utf8');
      expect(log).not.toContain('cards:pre-commit');
    } finally {
      delete process.env['CARDS_SKIP_HOOK'];
      if (prev !== undefined) process.env['CARDS_SKIP_HOOK'] = prev;
    }
  });

  it('CARDS_SKIP_HOOK=1 skips post-commit Cards hook', async () => {
    const prev = process.env['CARDS_SKIP_HOOK'];
    process.env['CARDS_SKIP_HOOK'] = '1';
    try {
      const res = runDispatcher('post-commit', [], '');
      expect(res.status).toBe(0);

      // The Cards .mjs must NOT have fired.
      const log = await fs.readFile(testLog, 'utf8');
      expect(log).not.toContain('cards:post-commit');
    } finally {
      delete process.env['CARDS_SKIP_HOOK'];
      if (prev !== undefined) process.env['CARDS_SKIP_HOOK'] = prev;
    }
  });
});

/**
 * Skipped CLI integration tests for the `create-worktree` binary.
 *
 * These tests verify exit-code mapping and JSON output shape. They are skipped in
 * Phase 2 and will be unskipped in Phase 3 once `applyWorktreeInclude` is implemented.
 *
 * Spawns the CLI via `tsx` against `src/bin/create-worktree.ts`, mirroring the
 * pattern used in `card.test.ts`.
 *
 * @summary Phase 2 skipped CLI integration specs for create-worktree
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Starts a minimal stub Cards API that records branch registrations and writes
 * a discovery file the CLI's createCardsClient() reads via CARDS_DISCOVERY_PATH.
 *
 * @param discoveryPath - Absolute path to write the cards-api.json discovery file.
 * @returns The server, captured addBranch request bodies, and a stop() helper.
 */
async function startStubApi(discoveryPath: string): Promise<{
  server: Server;
  addBranchCalls: Array<{ cardId: string; body: unknown }>;
  stop: () => Promise<void>;
}> {
  const addBranchCalls: Array<{ cardId: string; body: unknown }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const match = /^\/cards\/([^/]+)\/branches$/.exec(req.url ?? '');
    if (req.method === 'POST' && match) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        addBranchCalls.push({ cardId: decodeURIComponent(match[1]!), body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcome: 'created', revision: 'test-revision' }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await fs.writeFile(
    discoveryPath,
    JSON.stringify({
      host: '127.0.0.1',
      port,
      accessToken: 'test-token',
      pid: process.pid,
      startedAt: new Date().toISOString()
    })
  );
  return {
    server,
    addBranchCalls,
    stop: () =>
      new Promise<void>((resolve) => {
        // Drop any lingering keep-alive sockets so close() resolves promptly.
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

const createWorktreeBinPath = fileURLToPath(new URL('../../src/bin/create-worktree.ts', import.meta.url));
/** tsx CLI entrypoint, spawned via node for cross-platform support. */
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

/**
 * Spawns the create-worktree CLI and returns stdout, stderr, and exit code.
 *
 * @param args - CLI arguments.
 * @param cwd - Working directory for the process.
 * @param env - Optional extra environment variables merged over `process.env`.
 * @returns stdout, stderr, and exit code.
 */
function runCreateWorktree(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, createWorktreeBinPath, ...args], {
      encoding: 'utf8',
      cwd,
      ...(env ? { env: { ...process.env, ...env } } : {})
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1
    };
  }
}

/**
 * Async variant of {@link runCreateWorktree}. Required for card-bound tests
 * whose stub Cards API runs in this same process: a synchronous execFileSync
 * would block the event loop, deadlocking against the in-process HTTP server
 * the spawned CLI must reach. Spawning asynchronously keeps the loop free.
 *
 * @param args - CLI arguments.
 * @param cwd - Working directory for the process.
 * @param env - Extra environment variables merged over `process.env`.
 * @returns stdout, stderr, and exit code.
 */
async function runCreateWorktreeAsync(
  args: string[],
  cwd: string,
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsxCli, createWorktreeBinPath, ...args],
      { encoding: 'utf8', cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, exitCode: code });
      }
    );
  });
}

/**
 * Initialises a minimal git repo at `dir` with a README tracked, so
 * `git worktree add` can operate against it.
 *
 * @param dir - Absolute path to initialise as a git repo.
 */
async function initGitRepo(dir: string): Promise<void> {
  const { execFileSync: exec } = await import('node:child_process');
  exec('git', ['init', '-q'], { cwd: dir });
  exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  exec('git', ['add', '.'], { cwd: dir });
  exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

/**
 * Creates the extension/home/API fixtures required by a card-bound CLI run.
 *
 * @param tmpBase - Isolated test directory containing the fixture resources.
 * @returns Paths and the running Cards API fixture.
 */
async function prepareCardBoundRun(tmpBase: string): Promise<{
  extDir: string;
  homeDir: string;
  discoveryPath: string;
  stub: Awaited<ReturnType<typeof startStubApi>>;
}> {
  const extDir = path.join(tmpBase, 'ext');
  const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
  await fs.mkdir(gitHooksDir, { recursive: true });
  for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
    await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
  }
  const homeDir = path.join(tmpBase, 'home');
  await fs.mkdir(homeDir, { recursive: true });
  const discoveryPath = path.join(tmpBase, 'cards-api.json');
  const stub = await startStubApi(discoveryPath);
  return { extDir, homeDir, discoveryPath, stub };
}

/**
 * Per-test timeout for the CLI integration specs. Each spawns `node + tsx`
 * (cold transpile) plus real `git worktree` operations; on Windows that cold
 * start routinely exceeds vitest's 5s default, so allow more headroom.
 */
const CLI_TEST_TIMEOUT_MS = 60_000;

describe('create-worktree CLI', () => {
  let tmpBase = '';
  let stubStop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stubStop) {
      await stubStop();
      stubStop = undefined;
    }
    if (tmpBase) {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it(
    'exits 0 and JSON output includes copiedFromInclude:0 when no .worktreeinclude exists',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      const result = runCreateWorktree(['test-branch'], repoDir);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(parsed['copiedFromInclude']).toBe(0);
      expect(typeof parsed['reroutedSymlinks']).toBe('number');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 0 and copiedFromInclude is 1 when include file matches one gitignored file',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      // Add .gitignore and .worktreeinclude after initial commit
      await fs.writeFile(path.join(repoDir, '.gitignore'), '.env\n');
      await fs.writeFile(path.join(repoDir, '.worktreeinclude'), '.env\n');
      await fs.writeFile(path.join(repoDir, '.env'), 'SECRET=1');

      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'add include'], { cwd: repoDir });

      const result = runCreateWorktree(['test-branch-include'], repoDir);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(parsed['copiedFromInclude']).toBe(1);
    },
    CLI_TEST_TIMEOUT_MS
  );

  // Relies on POSIX file-mode unreadability (chmod 0o000). Two environments
  // cannot enforce it: Windows has no equivalent (chmod cannot remove read
  // access), and the superuser (uid 0) bypasses POSIX DAC and reads a 0o000 file
  // anyway — so the expected exit-3 never occurs. Skipped honestly in both.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'exits 3 and writes an error message to stderr when .worktreeinclude is unreadable',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      const includePath = path.join(repoDir, '.worktreeinclude');
      await fs.writeFile(includePath, '.env\n');
      await fs.chmod(includePath, 0o000);

      try {
        const result = runCreateWorktree(['test-branch-err'], repoDir);

        expect(result.exitCode).toBe(3);
        expect(result.stdout).not.toContain('"copiedFromInclude"');
        expect(result.stderr.length).toBeGreaterThan(0);
      } finally {
        await fs.chmod(includePath, 0o644);
      }
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 2 when invoked without arguments (missing argument regression)',
    () => {
      const result = runCreateWorktree([], os.tmpdir());
      expect(result.exitCode).toBe(2);
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'provisions card-bound worktree with compiledScriptPaths from EXTENSION_PATH',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      // Fake extension install with compiled git-hook artifacts.
      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }

      const homeDir = path.join(tmpBase, 'home');
      await fs.mkdir(homeDir, { recursive: true });

      // Stand up a stub Cards API so the fail-closed CLI can register the branch.
      const discoveryPath = path.join(tmpBase, 'cards-api.json');
      const stub = await startStubApi(discoveryPath);
      stubStop = stub.stop;

      const result = await runCreateWorktreeAsync(['--card-id', 'main-77', 'card-branch'], repoDir, {
        EXTENSION_PATH: extDir,
        HOME: homeDir,
        CARDS_DISCOVERY_PATH: discoveryPath
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      const worktreePath = parsed['worktree'] as string;

      // The branch was registered with the API against the early worktree path.
      expect(stub.addBranchCalls).toHaveLength(1);
      expect(stub.addBranchCalls[0]!.cardId).toBe('main-77');
      expect(stub.addBranchCalls[0]!.body).toMatchObject({ name: 'card-branch', worktree: worktreePath });

      // Attribution marker written.
      const cardId = await fs.readFile(path.join(worktreePath, '.cards', 'CARD_ID'), 'utf-8');
      expect(cardId.trim()).toBe('main-77');

      // Per-worktree core.hooksPath points at the global shared dispatcher dir,
      // and the compiled .mjs were copied there from the fake extension install.
      const hooksPath = execFileSync('git', ['-C', worktreePath, 'config', '--worktree', 'core.hooksPath'], {
        encoding: 'utf8'
      }).trim();
      expect(hooksPath).toBe(path.join(homeDir, '.cards', 'workspace-hooks'));
      const copied = await fs.readFile(path.join(hooksPath, 'post-commit.mjs'), 'utf-8');
      expect(copied).toBe('// post-commit stub\n');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'inherits the checkout card from a package subdirectory and ignores ambient CARD_ID',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      const packageDir = path.join(repoDir, 'packages', 'example');
      await fs.mkdir(packageDir, { recursive: true });
      await initGitRepo(repoDir);
      await fs.mkdir(path.join(repoDir, '.cards'));
      await fs.writeFile(path.join(repoDir, '.cards', 'CARD_ID'), 'main-inherited\n');
      const parentBranch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8'
      }).trim();

      const fixture = await prepareCardBoundRun(tmpBase);
      stubStop = fixture.stub.stop;
      const result = await runCreateWorktreeAsync(['worker-branch'], packageDir, {
        EXTENSION_PATH: fixture.extDir,
        HOME: fixture.homeDir,
        CARDS_DISCOVERY_PATH: fixture.discoveryPath,
        CARD_ID: 'main-ambient'
      });

      expect(result.exitCode).toBe(0);
      expect(fixture.stub.addBranchCalls).toHaveLength(1);
      expect(fixture.stub.addBranchCalls[0]).toMatchObject({
        cardId: 'main-inherited',
        body: { name: 'worker-branch', parentBranch, intent: 'create' }
      });
      const output = JSON.parse(result.stdout.trim()) as { worktree: string };
      await expect(fs.readFile(path.join(output.worktree, '.cards', 'CARD_ID'), 'utf8')).resolves.toBe(
        'main-inherited\n'
      );
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'uses an explicit card instead of the inherited marker',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      await fs.mkdir(path.join(repoDir, '.cards'));
      await fs.writeFile(path.join(repoDir, '.cards', 'CARD_ID'), 'main-parent\n');
      const fixture = await prepareCardBoundRun(tmpBase);
      stubStop = fixture.stub.stop;

      const result = await runCreateWorktreeAsync(['--card-id', 'main-explicit', 'worker-explicit'], repoDir, {
        EXTENSION_PATH: fixture.extDir,
        HOME: fixture.homeDir,
        CARDS_DISCOVERY_PATH: fixture.discoveryPath
      });

      expect(result.exitCode).toBe(0);
      expect(fixture.stub.addBranchCalls[0]!.cardId).toBe('main-explicit');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'does not read a wrong-type source marker when --card-id is explicit',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      // Reading this as a file fails on every supported platform. Explicit
      // selection must bypass it entirely rather than depend on marker health.
      await fs.mkdir(path.join(repoDir, '.cards', 'CARD_ID'), { recursive: true });
      const fixture = await prepareCardBoundRun(tmpBase);
      stubStop = fixture.stub.stop;

      const result = await runCreateWorktreeAsync(['--card-id', 'main-explicit', 'wrong-marker-worker'], repoDir, {
        EXTENSION_PATH: fixture.extDir,
        HOME: fixture.homeDir,
        CARDS_DISCOVERY_PATH: fixture.discoveryPath
      });

      expect(result.exitCode).toBe(0);
      expect(fixture.stub.addBranchCalls[0]!.cardId).toBe('main-explicit');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it.skipIf(process.platform === 'win32')(
    'canonicalizes a symlinked invocation before inheriting checkout identity',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      await fs.mkdir(path.join(repoDir, '.cards'));
      await fs.writeFile(path.join(repoDir, '.cards', 'CARD_ID'), 'main-symlinked\n');
      const alias = path.join(tmpBase, 'checkout-alias');
      await fs.symlink(repoDir, alias);
      const fixture = await prepareCardBoundRun(tmpBase);
      stubStop = fixture.stub.stop;

      const result = await runCreateWorktreeAsync(['symlink-worker'], alias, {
        EXTENSION_PATH: fixture.extDir,
        HOME: fixture.homeDir,
        CARDS_DISCOVERY_PATH: fixture.discoveryPath
      });

      expect(result.exitCode).toBe(0);
      expect(fixture.stub.addBranchCalls[0]!.cardId).toBe('main-symlinked');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'does not inherit an outer checkout marker across a nested repository boundary',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const outer = path.join(tmpBase, 'outer');
      await fs.mkdir(outer);
      await initGitRepo(outer);
      await fs.mkdir(path.join(outer, '.cards'));
      await fs.writeFile(path.join(outer, '.cards', 'CARD_ID'), 'main-outer\n');
      const nested = path.join(outer, 'nested');
      await fs.mkdir(nested);
      await initGitRepo(nested);

      const result = runCreateWorktree(['nested-worker'], nested, { CARD_ID: 'main-ambient' });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const output = JSON.parse(result.stdout.trim()) as { worktree: string };
      await expect(fs.access(path.join(output.worktree, '.cards', 'CARD_ID'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'defaults parentBranch to the source repo HEAD when --parent-branch is omitted',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      const headBranch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8'
      }).trim();

      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }
      const homeDir = path.join(tmpBase, 'home');
      await fs.mkdir(homeDir, { recursive: true });

      const discoveryPath = path.join(tmpBase, 'cards-api.json');
      const stub = await startStubApi(discoveryPath);
      stubStop = stub.stop;

      const result = await runCreateWorktreeAsync(['--card-id', 'main-77', 'card-branch'], repoDir, {
        EXTENSION_PATH: extDir,
        HOME: homeDir,
        CARDS_DISCOVERY_PATH: discoveryPath
      });

      expect(result.exitCode).toBe(0);
      expect(stub.addBranchCalls[0]!.body).toMatchObject({ parentBranch: headBranch });
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'honors an explicit --parent-branch over the source repo HEAD',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }
      const homeDir = path.join(tmpBase, 'home');
      await fs.mkdir(homeDir, { recursive: true });

      const discoveryPath = path.join(tmpBase, 'cards-api.json');
      const stub = await startStubApi(discoveryPath);
      stubStop = stub.stop;

      const result = await runCreateWorktreeAsync(
        ['--card-id', 'main-77', '--parent-branch', 'release/v2', 'card-branch'],
        repoDir,
        { EXTENSION_PATH: extDir, HOME: homeDir, CARDS_DISCOVERY_PATH: discoveryPath }
      );

      expect(result.exitCode).toBe(0);
      expect(stub.addBranchCalls[0]!.body).toMatchObject({ parentBranch: 'release/v2' });
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 2 (fail-closed) when --card-id given but the Cards API is unavailable',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }

      // Point discovery at a nonexistent file so createCardsClient() returns null.
      const result = runCreateWorktree(['--card-id', 'main-77', 'card-branch'], repoDir, {
        EXTENSION_PATH: extDir,
        CARDS_DISCOVERY_PATH: path.join(tmpBase, 'no-such-api.json')
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Cards API unavailable');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 2 (fail-closed) and leaves no worktree when --card-id points at an unreachable server',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }
      const homeDir = path.join(tmpBase, 'home');
      await fs.mkdir(homeDir, { recursive: true });

      // A well-formed discovery file pointing at a dead port: createCardsClient
      // returns a client, addBranch fails with a network error. retryOnNetworkError
      // is disabled so the CLI fails fast instead of hanging forever.
      const discoveryPath = path.join(tmpBase, 'cards-api.json');
      await fs.writeFile(
        discoveryPath,
        JSON.stringify({
          host: '127.0.0.1',
          port: 1, // reserved/unreachable
          accessToken: 'test-token',
          pid: process.pid,
          startedAt: new Date().toISOString()
        })
      );

      const result = await runCreateWorktreeAsync(['--card-id', 'main-77', 'card-branch'], repoDir, {
        EXTENSION_PATH: extDir,
        HOME: homeDir,
        CARDS_DISCOVERY_PATH: discoveryPath
      });

      expect(result.exitCode).toBe(2);
      // The worktree was rolled back: no orphaned worktree registered with git and
      // no leftover directory under the repo's worktrees root. This is the exact
      // orphaned-unregistered state the card retires — addBranch never succeeded,
      // so the worktree must not persist.
      const worktrees = execFileSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8'
      });
      expect(worktrees).not.toContain('card-branch');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 2 when --parent-branch is supplied from an unbound checkout',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      const result = runCreateWorktree(['--parent-branch', 'main', 'some-branch'], repoDir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--parent-branch requires a card-bound source or --card-id');
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 2 with detached-HEAD guidance when source HEAD is detached and no --parent-branch given',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      // Detach HEAD at the current commit.
      const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', repoDir, 'checkout', '-q', '--detach', sha]);

      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }
      const homeDir = path.join(tmpBase, 'home');
      await fs.mkdir(homeDir, { recursive: true });

      const discoveryPath = path.join(tmpBase, 'cards-api.json');
      const stub = await startStubApi(discoveryPath);
      stubStop = stub.stop;

      const result = await runCreateWorktreeAsync(['--card-id', 'main-77', 'card-branch'], repoDir, {
        EXTENSION_PATH: extDir,
        HOME: homeDir,
        CARDS_DISCOVERY_PATH: discoveryPath
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('detached-HEAD');
      // No bogus "HEAD" parent branch was registered.
      expect(stub.addBranchCalls).toHaveLength(0);
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'honors explicit --parent-branch even when source HEAD is detached',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);
      const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', repoDir, 'checkout', '-q', '--detach', sha]);

      const extDir = path.join(tmpBase, 'ext');
      const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
      await fs.mkdir(gitHooksDir, { recursive: true });
      for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
        await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
      }
      const homeDir = path.join(tmpBase, 'home');
      await fs.mkdir(homeDir, { recursive: true });

      const discoveryPath = path.join(tmpBase, 'cards-api.json');
      const stub = await startStubApi(discoveryPath);
      stubStop = stub.stop;

      const result = await runCreateWorktreeAsync(
        ['--card-id', 'main-77', '--parent-branch', 'main', 'card-branch'],
        repoDir,
        { EXTENSION_PATH: extDir, HOME: homeDir, CARDS_DISCOVERY_PATH: discoveryPath }
      );

      expect(result.exitCode).toBe(0);
      expect(stub.addBranchCalls[0]!.body).toMatchObject({ parentBranch: 'main' });
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    'exits 2 with actionable error when --card-id given but extension path unresolvable',
    async () => {
      tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cwt-cli-')));
      const repoDir = path.join(tmpBase, 'repo');
      await fs.mkdir(repoDir);
      await initGitRepo(repoDir);

      // EXTENSION_PATH empty and HOME pointed at a dir with no .cards/EXTENSION_PATH.
      const fakeHome = path.join(tmpBase, 'home');
      await fs.mkdir(fakeHome, { recursive: true });

      const result = runCreateWorktree(['--card-id', 'main-77', 'card-branch'], repoDir, {
        EXTENSION_PATH: '',
        // `os.homedir()` reads HOME on POSIX but USERPROFILE on Windows. Redirect
        // both so the `~/.cards/EXTENSION_PATH` probe misses on every platform;
        // otherwise on Windows it falls through to the real profile (where a dev's
        // EXTENSION_PATH file exists), the extension path resolves, and the CLI
        // advances past this branch to a "Card not found" failure instead.
        HOME: fakeHome,
        USERPROFILE: fakeHome
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Cannot resolve extension path');
    },
    CLI_TEST_TIMEOUT_MS
  );
});

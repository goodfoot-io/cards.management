/**
 * Integration tests for the `remove-worktree` CLI binary.
 *
 * Spawns the CLI via `tsx` against `src/bin/remove-worktree.ts`, mirroring the
 * pattern used in `createWorktreeCli.test.ts`.
 *
 * @summary CLI integration specs for remove-worktree
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Starts a minimal stub Cards API that records branch unregistrations (DELETE)
 * and writes a discovery file the CLI's createCardsClient() reads via
 * CARDS_DISCOVERY_PATH.
 *
 * @param discoveryPath - Absolute path to write the cards-api.json discovery file.
 * @returns The server, captured removeBranch calls, and a stop() helper.
 */
async function startStubApi(discoveryPath: string): Promise<{
  server: Server;
  removeBranchCalls: Array<{ cardId: string; name: string }>;
  stop: () => Promise<void>;
}> {
  const removeBranchCalls: Array<{ cardId: string; name: string }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The claim phase reads the branch registry, takes the cleanup owner
    // token, and only then deletes — mirror those routes faithfully, because
    // removeWorktreeForCard refuses deletion when the authority cannot answer
    // them. Query strings (expectedRevision/expectedCleanupOwner) are stripped
    // before matching, and the branch name arrives percent-encoded.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const branchMatch = /^\/cards\/([^/]+)\/branches\/([^/]+)$/.exec(url.pathname);
    const ownerMatch = /^\/cards\/([^/]+)\/branches\/([^/]+)\/owner$/.exec(url.pathname);
    if (req.method === 'GET' && /^\/cards\/([^/]+)\/branches$/.exec(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          branches: [
            {
              name: 'cards/main-88/1',
              revision: 'stub-revision-1',
              parentBranch: 'master',
              addedAt: new Date().toISOString()
            }
          ]
        })
      );
      return;
    }
    if (req.method === 'PATCH' && ownerMatch) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ outcome: 'applied', revision: 'stub-revision-2' }));
      return;
    }
    if (req.method === 'DELETE' && branchMatch) {
      removeBranchCalls.push({
        cardId: decodeURIComponent(branchMatch[1]!),
        name: decodeURIComponent(branchMatch[2]!)
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ outcome: 'removed' }));
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
    removeBranchCalls,
    stop: () =>
      new Promise<void>((resolve) => {
        // Drop any lingering keep-alive sockets so close() resolves promptly.
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

const removeWorktreeBinPath = fileURLToPath(new URL('../../src/bin/remove-worktree.ts', import.meta.url));
/** tsx CLI entrypoint, spawned via node for cross-platform support. */
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

/**
 * Spawns the remove-worktree CLI and returns stdout, stderr, and exit code.
 *
 * @param args - CLI arguments.
 * @param cwd - Working directory for the process.
 * @param env - Additional environment variables.
 * @returns stdout, stderr, and exit code.
 */
function runRemoveWorktree(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, removeWorktreeBinPath, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env }
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
 * Async variant of {@link runRemoveWorktree}. Required for card-bound tests
 * whose stub Cards API runs in this same process: a synchronous execFileSync
 * would block the event loop, deadlocking against the in-process HTTP server
 * the spawned CLI must reach.
 *
 * @param args - CLI arguments.
 * @param cwd - Working directory for the process.
 * @param env - Additional environment variables merged over `process.env`.
 * @returns stdout, stderr, and exit code.
 */
async function runRemoveWorktreeAsync(
  args: string[],
  cwd: string,
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsxCli, removeWorktreeBinPath, ...args],
      { encoding: 'utf8', cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, exitCode: code });
      }
    );
  });
}

/**
 * Async variant of the create-worktree spawn, used to provision a card-bound
 * worktree while a stub API runs in-process (avoids the execFileSync deadlock).
 *
 * @param args - CLI arguments (after the bin path).
 * @param cwd - Working directory for the process.
 * @param env - Additional environment variables merged over `process.env`.
 * @returns stdout of the CLI.
 */
async function runCreateWorktreeAsync(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const { execFile } = await import('node:child_process');
  const createBin = fileURLToPath(new URL('../../src/bin/create-worktree.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [tsxCli, createBin, ...args],
      { encoding: 'utf8', cwd, env: { ...process.env, ...env } },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

/**
 * Initialises a minimal git repo at `dir` with a commit.
 *
 * @param dir - Absolute path to initialise as a git repo.
 */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('remove-worktree CLI', () => {
  let tmpBase = '';
  let stubStop: (() => Promise<void>) | undefined;
  // Sandbox $HOME for the whole suite. createWorktree resolves the GLOBAL shared
  // hooks dir from `$HOME/.cards/workspace-hooks` (resolveHomeDir), and the
  // spawned create/remove CLIs inherit this process's env. Without this, a
  // card-bound `create-worktree` here would provision the stub hook scripts into
  // the developer's REAL ~/.cards/workspace-hooks, clobbering live commit
  // attribution for every worktree on the machine. Pinning HOME to a temp dir
  // confines provisioning to the sandbox for every test, present and future.
  let homeBase = '';
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-home-')));
    originalHome = process.env['HOME'];
    process.env['HOME'] = homeBase;
  });

  afterEach(async () => {
    if (stubStop) {
      await stubStop();
      stubStop = undefined;
    }
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    if (homeBase) {
      await fs.rm(homeBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      homeBase = '';
    }
    if (tmpBase) {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      tmpBase = '';
    }
  });

  it('exits 2 when invoked without arguments', () => {
    const result = runRemoveWorktree([], os.tmpdir());
    expect(result.exitCode).toBe(2);
  });

  it('exits 2 when given extra arguments', () => {
    const result = runRemoveWorktree(['/some/path', 'extra'], os.tmpdir());
    expect(result.exitCode).toBe(2);
  });

  it('exits 0 when removing an existing worktree', async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-cli-')));
    const repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);

    const { execFileSync: exec } = await import('node:child_process');
    const createBin = fileURLToPath(new URL('../../src/bin/create-worktree.ts', import.meta.url));
    const createOut = exec(process.execPath, [tsxCli, createBin, 'feature/cli-remove-test'], {
      encoding: 'utf8',
      cwd: repoDir,
      env: { ...process.env, CARDS_WORKTREES_DIR: worktreesDir }
    });
    const parsed = JSON.parse(createOut.trim()) as { worktree: string };
    const worktreePath = parsed['worktree'];

    const result = runRemoveWorktree([worktreePath], repoDir, { CARDS_WORKTREES_DIR: worktreesDir });
    expect(result.exitCode).toBe(0);

    await expect(fs.access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    // Spawns the create-worktree then remove-worktree CLIs as child processes,
    // each doing real git + worktree wiring; under the full parallel workspace
    // run on Windows this exceeds the 5s default (git-subprocess latency).
  }, 30000);

  it('unregisters the branch and removes the worktree for a card-bound worktree', async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-cli-')));
    const repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);

    // Fake extension install so create-worktree --card-id can provision hooks.
    const extDir = path.join(tmpBase, 'ext');
    const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
    await fs.mkdir(gitHooksDir, { recursive: true });
    for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
      await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
    }

    const discoveryPath = path.join(tmpBase, 'cards-api.json');
    const stub = await startStubApi(discoveryPath);
    stubStop = stub.stop;

    const createOut = await runCreateWorktreeAsync(['--card-id', 'main-88', 'cards/main-88/1'], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      EXTENSION_PATH: extDir,
      CARDS_DISCOVERY_PATH: discoveryPath
    });
    const worktreePath = (JSON.parse(createOut.trim()) as { worktree: string }).worktree;

    const branchName = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8'
    }).trim();

    // Stub stays up during removal, so spawn the CLI asynchronously to keep the
    // in-process server's event loop free.
    const result = await runRemoveWorktreeAsync([worktreePath], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      CARDS_DISCOVERY_PATH: discoveryPath
    });
    expect(result.exitCode).toBe(0);

    await expect(fs.access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stub.removeBranchCalls).toEqual([{ cardId: 'main-88', name: branchName }]);
  }, 30000);

  it('exits 0 and still removes the worktree when the API is unavailable for a bound worktree', async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-cli-')));
    const repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);

    const extDir = path.join(tmpBase, 'ext');
    const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
    await fs.mkdir(gitHooksDir, { recursive: true });
    for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
      await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
    }

    const discoveryPath = path.join(tmpBase, 'cards-api.json');
    const stub = await startStubApi(discoveryPath);

    // Create while the stub is up (async to avoid the in-process deadlock).
    const createOut = await runCreateWorktreeAsync(['--card-id', 'main-88', 'cards/main-88/1'], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      EXTENSION_PATH: extDir,
      CARDS_DISCOVERY_PATH: discoveryPath
    });
    const worktreePath = (JSON.parse(createOut.trim()) as { worktree: string }).worktree;

    // Take the API down before removal so createCardsClient returns null. With
    // no in-process server, the synchronous remove runner is safe.
    await stub.stop();

    const result = runRemoveWorktree([worktreePath], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      CARDS_DISCOVERY_PATH: path.join(tmpBase, 'no-such-api.json')
    });
    // Fail-open on branch unregister: the worktree is still removed, exit 0.
    expect(result.exitCode).toBe(0);
    await expect(fs.access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);

  it('exits 2 fail-closed and keeps the worktree when the discovery server is unreachable for a bound worktree', async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-cli-')));
    const repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(worktreesDir);
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);

    const extDir = path.join(tmpBase, 'ext');
    const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
    await fs.mkdir(gitHooksDir, { recursive: true });
    for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
      await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
    }

    const discoveryPath = path.join(tmpBase, 'cards-api.json');
    const stub = await startStubApi(discoveryPath);

    const createOut = await runCreateWorktreeAsync(['--card-id', 'main-88', 'cards/main-88/1'], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      EXTENSION_PATH: extDir,
      CARDS_DISCOVERY_PATH: discoveryPath
    });
    const worktreePath = (JSON.parse(createOut.trim()) as { worktree: string }).worktree;

    // Take the real server down but leave a WELL-FORMED discovery file pointing
    // at a dead port: createCardsClient returns a client (discovery succeeds),
    // and the cleanup-ownership claim hits a network error. retryOnNetworkError
    // is disabled, so the command must fail fast instead of hanging forever.
    // A claim that cannot be proven refuses deletion (fail-closed): the
    // worktree stays on disk and the branch record stays registered, recoverable
    // once the server returns.
    await stub.stop();
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

    const startedAt = Date.now();
    const result = await runRemoveWorktreeAsync([worktreePath], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      CARDS_DISCOVERY_PATH: discoveryPath
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.exitCode).toBe(2);
    expect(
      await fs.access(worktreePath).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(result.stderr).not.toContain('branch unregister failed');
    // Bounded: must not hang on the forever-retry path (cap is 30s/backoff).
    expect(elapsedMs).toBeLessThan(20000);
  }, 30000);

  it('exits 0 (fail-open) when the API returns an error for the branch unregister', async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-cli-')));
    const repoDir = path.join(tmpBase, 'repo');
    const worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(repoDir);
    await fs.mkdir(worktreesDir);
    initGitRepo(repoDir);

    const extDir = path.join(tmpBase, 'ext');
    const gitHooksDir = path.join(extDir, 'dist', 'git-hooks');
    await fs.mkdir(gitHooksDir, { recursive: true });
    for (const name of ['pre-commit', 'post-commit', 'post-rewrite']) {
      await fs.writeFile(path.join(gitHooksDir, `${name}.mjs`), `// ${name} stub\n`);
    }

    const discoveryPath = path.join(tmpBase, 'cards-api.json');
    const stub = await startStubApi(discoveryPath);
    stubStop = stub.stop;

    const createOut = await runCreateWorktreeAsync(['--card-id', 'main-88', 'cards/main-88/1'], repoDir, {
      CARDS_WORKTREES_DIR: worktreesDir,
      EXTENSION_PATH: extDir,
      CARDS_DISCOVERY_PATH: discoveryPath
    });
    const worktreePath = (JSON.parse(createOut.trim()) as { worktree: string }).worktree;

    // Replace the stub with one that serves the claim phase (branch registry,
    // cleanup-owner token) but returns 500 for the DELETE, so removeBranch
    // throws an ApiError (not a network error) — the unregister phase fails but
    // disk teardown already succeeded. The CLI classifies this as a
    // BranchUnregisterError and exits 0 (fail-open), not as a teardown failure.
    await stub.stop();
    stubStop = undefined;
    const errServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'DELETE') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom', code: 'INTERNAL' }));
        return;
      }
      if (req.method === 'GET' && /^\/cards\/([^/]+)\/branches$/.exec(url.pathname)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            branches: [
              {
                name: 'cards/main-88/1',
                revision: 'stub-revision-1',
                parentBranch: 'master',
                addedAt: new Date().toISOString()
              }
            ]
          })
        );
        return;
      }
      if (req.method === 'PATCH' && /^\/cards\/([^/]+)\/branches\/([^/]+)\/owner$/.exec(url.pathname)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ outcome: 'applied', revision: 'stub-revision-2' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => errServer.listen(0, '127.0.0.1', resolve));
    const addr = errServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
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

    try {
      const result = await runRemoveWorktreeAsync([worktreePath], repoDir, {
        CARDS_WORKTREES_DIR: worktreesDir,
        CARDS_DISCOVERY_PATH: discoveryPath
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('branch unregister failed');
      await expect(fs.access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      errServer.closeAllConnections();
      await new Promise<void>((resolve) => errServer.close(() => resolve()));
    }
  }, 30000);

  it('exits 2 when path is outside the worktrees root', async () => {
    tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rwt-cli-')));
    const worktreesDir = path.join(tmpBase, 'worktrees');
    await fs.mkdir(worktreesDir);
    const outsidePath = path.join(tmpBase, 'outside');
    await fs.mkdir(outsidePath);

    const result = runRemoveWorktree([outsidePath], os.tmpdir(), { CARDS_WORKTREES_DIR: worktreesDir });
    expect(result.exitCode).toBe(2);
  });
});

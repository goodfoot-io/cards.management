/**
 * Bounded slot git against real repositories: a deadline or `abortAll` ends
 * git and the descendants it forked without signalling the caller's group, a
 * process that left git's tree survives in that group, and the shutdown fence
 * refuses new calls before anything is spawned.
 * @summary Bounded git deadline, abort, fence and descendant containment
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoundedGit, type GitChildEvent, ShutdownError } from '../src/bounded-git.js';
import { createProcessIdentity } from '../src/process-identity.js';
import { TSX_IMPORT } from './helpers/tsx.js';

const POSIX = process.platform !== 'win32';
const SOURCE = resolve(__dirname, '../src');

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0'
};

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bounded-git-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
}

/**
 * Creates a repository with two commits on `main`, and `other` at the first.
 * @param hooks - Hook scripts by name, installed under a private hooks path.
 * @returns The repository path.
 */
function makeRepo(hooks: Record<string, string> = {}): string {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'branch', 'other');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'two');
  const hooksDir = join(dir, 'hooks');
  mkdirSync(hooksDir);
  for (const [name, body] of Object.entries(hooks)) {
    writeFileSync(join(hooksDir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(hooksDir, name), 0o755);
  }
  git(repo, 'config', 'core.hooksPath', hooksDir);
  return repo;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readPid(path: string, timeoutMs = 10_000): Promise<number> {
  await waitFor(() => existsSync(path) && readFileSync(path, 'utf8').trim() !== '', timeoutMs);
  return Number(readFileSync(path, 'utf8').trim());
}

describe.runIf(POSIX)('POSIX deadline', () => {
  it("leaves no descendant of a timed-out post-checkout hook alive, and spares the caller's group", async () => {
    const pidFile = join(dir, 'hook.pid');
    const repo = makeRepo({ 'post-checkout': `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 30` });
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(sibling);
    const events: GitChildEvent[] = [];

    const runner = createBoundedGit();
    const started = Date.now();
    const result = await runner.run(repo, ['checkout', '-q', 'other'], {
      timeoutMs: 1_000,
      graceMs: 500,
      record: (event) => events.push(event)
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const hookPid = await readPid(pidFile);
    await waitFor(() => !isAlive(hookPid));
    expect(isAlive(sibling.pid as number)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['spawned', 'identified', 'exited']);
  });

  it("leaves a double-forked escapee alive in the caller's group, where it keeps a slot lock held", async () => {
    const slotRoot = join(dir, 'slots');
    mkdirSync(slotRoot);
    const escapeeFile = join(dir, 'escapee.pid');
    const repo = makeRepo({
      'post-checkout': `( sleep 30 & echo $! > ${JSON.stringify(escapeeFile)} )\nexec sleep 30`
    });
    const script = join(dir, 'handler.mts');
    writeFileSync(
      script,
      `
import { createBoundedGit } from ${JSON.stringify(join(SOURCE, 'bounded-git.ts'))};
import { acquireSlotLock } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
const acquired = await acquireSlotLock(${JSON.stringify(slotRoot)}, 1, { executionId: 'e1', cardId: 'c1', purpose: 'work' });
if (acquired.status !== 'acquired') process.exit(3);
await createBoundedGit().run(${JSON.stringify(repo)}, ['checkout', '-q', 'other'], { timeoutMs: 1000, graceMs: 500 });
process.kill(process.pid, 'SIGKILL');
`
    );
    const handler = spawn(process.execPath, [TSX_IMPORT, script], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, ...GIT_ENV }
    });
    children.push(handler);
    const pgid = handler.pid as number;
    try {
      const exit = await new Promise<string | null>((resolveExit) =>
        handler.once('exit', (_code, signal) => resolveExit(signal))
      );
      expect(exit).toBe('SIGKILL');
      const escapee = await readPid(escapeeFile);
      expect(isAlive(escapee)).toBe(true);
      const { readSlotLock } = await import('../src/slot-lock.js');
      const state = await readSlotLock(slotRoot, 1);
      expect(state.state).toBe('held');
      if (state.state === 'held') expect(state.survivors).toMatchObject({ holderAlive: false, groupAlive: true });
    } finally {
      expect(pgid).toBeGreaterThan(1);
      expect(pgid).toBe(handler.pid);
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {}
    }
  });

  it("completes git's own cleanup of index.lock when a smudge filter times out", async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitattributes'), '*.bin filter=slow\n');
    writeFileSync(join(repo, 'a.bin'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    git(repo, 'config', 'filter.slow.smudge', 'sleep 30');
    git(repo, 'config', 'filter.slow.required', 'true');
    rmSync(join(repo, 'a.bin'));

    const result = await createBoundedGit().run(repo, ['checkout', '-q', '--', 'a.bin'], {
      timeoutMs: 1_000,
      graceMs: 1_000
    });

    expect(result.timedOut).toBe(true);
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
  });

  it('does not SIGKILL a descendant whose PID was reused during the grace period', async () => {
    const pidFile = join(dir, 'hook.pid');
    const repo = makeRepo({ 'post-checkout': `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 30` });
    const fakePid = 2_147_000_001;
    const sent: Array<[number, NodeJS.Signals]> = [];
    let probes = 0;
    const real = createProcessIdentity();
    const runner = createBoundedGit({
      descendants: async () => [{ pid: fakePid, startIdentity: 'before' }],
      startIdentity: async (pid) => {
        if (pid !== fakePid) {
          const probe = await real.identify(pid, 2_000);
          return probe === null || probe === 'unknown' ? probe : probe.startIdentity;
        }
        probes++;
        return 'after';
      },
      kill: (pid, signal) => {
        sent.push([pid, signal]);
        if (pid !== fakePid) process.kill(pid, signal);
      }
    });

    const result = await runner.run(repo, ['checkout', '-q', 'other'], { timeoutMs: 1_000, graceMs: 300 });

    expect(result.timedOut).toBe(true);
    expect(probes).toBeGreaterThan(0);
    expect(sent).toContainEqual([fakePid, 'SIGTERM']);
    expect(sent).not.toContainEqual([fakePid, 'SIGKILL']);
    const hookPid = await readPid(pidFile);
    try {
      process.kill(hookPid, 'SIGKILL');
    } catch {}
  });
});

describe('abort and fence', () => {
  it.runIf(POSIX)('abortAll ends every in-flight call within its grace period', async () => {
    const repo = makeRepo();
    const second = join(dir, 'second');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', second, 'other');
    // Installed after the worktree exists, so only the two calls below run it.
    writeFileSync(join(dir, 'hooks', 'post-checkout'), '#!/bin/sh\nexec sleep 30\n');
    chmodSync(join(dir, 'hooks', 'post-checkout'), 0o755);
    const runner = createBoundedGit();
    const calls = [
      runner.run(repo, ['checkout', '-q', 'other'], { timeoutMs: 60_000 }),
      runner.run(second, ['checkout', '-q', '--detach', 'main'], { timeoutMs: 60_000 })
    ];
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));

    const started = Date.now();
    await runner.abortAll({ graceMs: 500 });
    const results = await Promise.all(calls);

    expect(Date.now() - started).toBeLessThan(5_000);
    for (const result of results) expect(result.aborted).toBe(true);
  });

  it('rejects with ShutdownError without spawning once the shutdown signal has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: GitChildEvent[] = [];
    const runner = createBoundedGit({ shutdownSignal: controller.signal });

    await expect(
      runner.run(dir, ['status'], { timeoutMs: 5_000, record: (event) => events.push(event) })
    ).rejects.toBeInstanceOf(ShutdownError);
    expect(events).toEqual([]);
  });

  it('returns the output of a call that finishes in time', async () => {
    const repo = makeRepo();
    const result = await createBoundedGit().run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'main\n', timedOut: false, aborted: false });
  });
});

describe.runIf(process.platform === 'win32')('Windows deadline [R14]', () => {
  it('a timed-out worktree add with a hook child leaves no tree, and record saw pending first', async () => {
    const pidFile = join(dir, 'hook.pid');
    const repo = makeRepo({ 'post-checkout': `echo $$ > "${pidFile.replace(/\\/g, '/')}"\nsleep 30` });
    const events: GitChildEvent[] = [];
    const result = await createBoundedGit().run(repo, ['worktree', 'add', '-q', join(dir, 'wt'), 'other'], {
      timeoutMs: 2_000,
      record: (event) => events.push(event)
    });
    expect(result.timedOut).toBe(true);
    expect(events[0]?.kind).toBe('spawned');
    expect(events.at(-1)?.kind).toBe('exited');
    const gitPid = events[0]?.pid as number;
    expect(isAlive(gitPid)).toBe(false);
  });
});

/**
 * Polls a condition every 20 ms.
 * @param check - Condition to wait for.
 * @param timeoutMs - Ceiling before failing.
 * @throws {Error} When the condition stays false past the ceiling.
 */
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

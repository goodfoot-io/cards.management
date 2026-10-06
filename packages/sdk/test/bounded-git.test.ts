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
import { build } from 'esbuild';
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

describe.runIf(POSIX)('POSIX stop report [L4]', () => {
  it('SIGKILLs a member that a SIGTERM-ignoring hook forks during the grace period', async () => {
    const lateFile = join(dir, 'late.pid');
    const repo = makeRepo({
      'post-checkout': `trap '' TERM\nsleep 0.8\n(trap '' TERM; exec sleep 30) &\necho $! > ${JSON.stringify(lateFile)}\nwait`
    });

    const result = await createBoundedGit().run(repo, ['checkout', '-q', 'other'], { timeoutMs: 500, graceMs: 1_500 });

    expect(result.timedOut).toBe(true);
    expect(result.stopReport).toEqual({ survivors: [], complete: true });
    const late = await readPid(lateFile);
    await waitFor(() => !isAlive(late));
  });

  it.runIf(process.platform === 'linux')("SIGKILLs a hook's setsid descendant, which has left the group", async () => {
    const escapeeFile = join(dir, 'escapee.pid');
    const repo = makeRepo({
      'post-checkout': `trap '' TERM\nsetsid sleep 30 &\necho $! > ${JSON.stringify(escapeeFile)}\nsleep 30`
    });

    const result = await createBoundedGit().run(repo, ['checkout', '-q', 'other'], { timeoutMs: 1_000, graceMs: 500 });

    expect(result.stopReport).toEqual({ survivors: [], complete: true });
    const escapee = await readPid(escapeeFile);
    await waitFor(() => !isAlive(escapee));
  });

  /**
   * Runs a timed-out checkout whose hook records its PID, with platform overrides.
   * @param overrides - Platform functions to replace.
   * @returns The result and the hook's PID, which the caller must end.
   */
  async function stopWith(
    overrides: Parameters<typeof createBoundedGit>[0]
  ): Promise<{ result: Awaited<ReturnType<ReturnType<typeof createBoundedGit>['run']>>; hookPid: number }> {
    const pidFile = join(dir, 'hook.pid');
    const repo = makeRepo({ 'post-checkout': `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 30` });
    const result = await createBoundedGit(overrides).run(repo, ['checkout', '-q', 'other'], {
      timeoutMs: 1_000,
      graceMs: 200
    });
    return { result, hookPid: await readPid(pidFile) };
  }

  /**
   * Ends a hook a test kept alive by stubbing the platform's signals.
   * @param pid - The hook's PID, read from the file the hook wrote.
   */
  function endHook(pid: number): void {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }

  it('reports an incomplete stop when the process table cannot be listed', async () => {
    const { result, hookPid } = await stopWith({ descendants: async () => 'unknown' });
    endHook(hookPid);
    expect(result.timedOut).toBe(true);
    expect(result.stopReport.complete).toBe(false);
  });

  it('reports a member whose identity cannot be read as a survivor, without signalling it', async () => {
    const fakePid = 2_147_000_002;
    const sent: Array<[number, NodeJS.Signals]> = [];
    const real = createProcessIdentity();
    const { result, hookPid } = await stopWith({
      descendants: async () => [{ pid: fakePid, startIdentity: 'start' }],
      startIdentity: async (pid) => {
        if (pid === fakePid) return 'unknown';
        const probe = await real.identify(pid, 2_000);
        return probe === null || probe === 'unknown' ? probe : probe.startIdentity;
      },
      kill: (pid, signal) => {
        sent.push([pid, signal]);
        if (pid !== fakePid) process.kill(pid, signal);
      }
    });
    endHook(hookPid);
    expect(result.stopReport).toEqual({ survivors: [{ pid: fakePid, startIdentity: 'start' }], complete: true });
    expect(sent).not.toContainEqual([fakePid, 'SIGKILL']);
  });

  it('reports a member still running under its identity after SIGKILL as a survivor', async () => {
    const fakePid = 2_147_000_003;
    const real = createProcessIdentity();
    const { result, hookPid } = await stopWith({
      descendants: async () => [{ pid: fakePid, startIdentity: 'start' }],
      startIdentity: async (pid) => {
        if (pid === fakePid) return 'start';
        const probe = await real.identify(pid, 2_000);
        return probe === null || probe === 'unknown' ? probe : probe.startIdentity;
      },
      kill: (pid, signal) => {
        if (pid !== fakePid) process.kill(pid, signal);
      }
    });
    endHook(hookPid);
    expect(result.stopReport).toEqual({ survivors: [{ pid: fakePid, startIdentity: 'start' }], complete: true });
  });

  it('abortAll returns the survivors of every stopped call', async () => {
    const fakePid = 2_147_000_004;
    const pidFile = join(dir, 'hook.pid');
    const repo = makeRepo({ 'post-checkout': `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 30` });
    const runner = createBoundedGit({
      descendants: async () => [{ pid: fakePid, startIdentity: 'start' }],
      startIdentity: async (pid) => (pid === fakePid ? 'start' : null),
      kill: (pid, signal) => {
        if (pid !== fakePid) process.kill(pid, signal);
      }
    });
    const call = runner.run(repo, ['checkout', '-q', 'other'], { timeoutMs: 60_000 });
    const hookPid = await readPid(pidFile);
    const report = await runner.abortAll({ graceMs: 200 });
    endHook(hookPid);
    expect(report).toEqual({ survivors: [{ pid: fakePid, startIdentity: 'start' }], complete: true });
    expect((await call).aborted).toBe(true);
  });
});

describe.runIf(POSIX)('shutdown release of a launched handler [L4]', () => {
  /**
   * Runs a handler that leads its own group, as a launched one does: it takes a work
   * lock, starts `body`, shuts down, and prints the lock's state from its exit.
   * @param slotRoot - Slot root of the lock.
   * @param body - Statements run after the lock is taken; `git` and `lock` are in scope.
   * @returns The lock state the handler printed and its group id, which the caller must end.
   */
  async function runHandler(
    slotRoot: string,
    body: string
  ): Promise<{ report: { state: string; released: boolean }; pgid: number }> {
    const script = join(dir, 'handler.mts');
    writeFileSync(
      script,
      `
import { createBoundedGit } from ${JSON.stringify(join(SOURCE, 'bounded-git.ts'))};
import { createShutdownCoordinator } from ${JSON.stringify(join(SOURCE, 'config/runtime-shutdown.ts'))};
import { acquireSlotLock, readSlotLock } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
const shutdown = createShutdownCoordinator({
  exit: () => {
    void readSlotLock(${JSON.stringify(slotRoot)}, 1).then((state) => {
      process.stdout.write(JSON.stringify({ state: state.state, released: state.snapshot?.released != null }));
      process.exit(0);
    });
  }
});
const git = createBoundedGit({ shutdownSignal: shutdown.signal });
const acquired = await acquireSlotLock(${JSON.stringify(slotRoot)}, 1, { executionId: 'e1', cardId: 'c1', purpose: 'work', environment: { shutdown, git } });
if (acquired.status !== 'acquired') process.exit(3);
const lock = acquired.lock;
${body}
await shutdown.shutdownAndExit(0, 'completed');
`
    );
    // Bundled, as a launched handler is: tsx would add its esbuild service to the group.
    const bundle = join(dir, 'handler.mjs');
    await build({
      entryPoints: [script],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent'
    });
    const handler = spawn(process.execPath, [bundle], {
      stdio: ['ignore', 'pipe', 'inherit'],
      detached: true,
      env: { ...process.env, ...GIT_ENV }
    });
    children.push(handler);
    const pgid = handler.pid as number;
    let output = '';
    handler.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    await new Promise((resolveExit) => handler.once('exit', resolveExit));
    return { report: JSON.parse(output), pgid };
  }

  /**
   * Ends what a handler left in its group.
   * @param pgid - The group the handler led, which is its PID.
   * @param pid - The handler's PID, recorded at spawn.
   */
  function endGroup(pgid: number, pid: number): void {
    expect(pgid).toBeGreaterThan(1);
    expect(pgid).toBe(pid);
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  }

  it('releases only once a hook that ignored SIGTERM and forked during the grace period is gone', async () => {
    const slotRoot = join(dir, 'slots');
    mkdirSync(slotRoot);
    const lateFile = join(dir, 'late-write');
    const repo = makeRepo({
      'pre-commit': `trap '' TERM\nsleep 1\n(trap '' TERM; sleep 3; echo late > ${JSON.stringify(lateFile)}; exec sleep 30) &\nwait`
    });
    const { report, pgid } = await runHandler(
      slotRoot,
      `void git.run(${JSON.stringify(repo)}, ['commit', '-q', '--allow-empty', '-m', 'x'], { timeoutMs: 60_000 });
await new Promise((resolveWait) => setTimeout(resolveWait, 800));`
    );
    try {
      expect(report).toEqual({ state: 'free', released: true });
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
      expect(existsSync(lateFile)).toBe(false);
    } finally {
      endGroup(pgid, children.at(-1)?.pid as number);
    }
  });

  it('keeps the lock while a process the handler left in its group is alive, and records it', async () => {
    const slotRoot = join(dir, 'slots');
    mkdirSync(slotRoot);
    const { report, pgid } = await runHandler(
      slotRoot,
      `const { spawn } = await import('node:child_process');
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref();
await new Promise((resolveWait) => setTimeout(resolveWait, 300));`
    );
    try {
      expect(report).toEqual({ state: 'held', released: false });
      const { readSlotLock } = await import('../src/slot-lock.js');
      const state = await readSlotLock(slotRoot, 1);
      expect(state.state).toBe('held');
      expect(state.snapshot?.companions).toHaveLength(1);
    } finally {
      endGroup(pgid, children.at(-1)?.pid as number);
    }
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

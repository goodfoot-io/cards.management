/**
 * The slot-lock spike's harnesses as cross-platform stress tests: many real
 * processes racing for one ordinal, acquire/release churn with eager GC under a
 * mutual-exclusion marker, the stale empty-target rename, zombie and
 * leaderless-group liveness, and the handler and agent sharing the action
 * group under every available `sh -c` shell.
 * @summary Slot lock contention, GC churn and process-group liveness stress tests
 */
import { type ChildProcess, fork, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessIdentity } from '../src/process-identity.js';
import { publishGeneration, readSlotLock } from '../src/slot-lock.js';
import { ownerFile, writeGeneration } from './helpers/slot-lock-fixtures.js';
import { TSX_IMPORT } from './helpers/tsx.js';

const POSIX = process.platform !== 'win32';
const SOURCE = resolve(__dirname, '../src');
const WORKERS = 16;

let base: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'slot-lock-stress-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(base, { recursive: true, force: true });
});

function forkWorker(script: string, args: string[]): ChildProcess {
  const worker = fork(script, args, { execArgv: [TSX_IMPORT], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(worker);
  return worker;
}

function nextMessage<T>(worker: ChildProcess, match: (message: T) => boolean): Promise<T> {
  return new Promise((resolveMessage) => {
    const listener = (message: T): void => {
      if (!match(message)) return;
      worker.off('message', listener);
      resolveMessage(message);
    };
    worker.on('message', listener);
  });
}

describe('contention [L1]', () => {
  it.skip(`gives exactly one of ${WORKERS} racing processes each generation`, async () => {
    const slotRoot = join(base, 'slots');
    mkdirSync(slotRoot);
    const script = join(base, 'contender.mts');
    writeFileSync(
      script,
      `
import { acquireSlotLock } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
let held = null;
process.on('message', async (message) => {
  if (message.release) {
    if (held) await held.release();
    held = null;
    process.send({ released: message.round });
    return;
  }
  while (Date.now() < message.at) {}
  const result = await acquireSlotLock(${JSON.stringify(slotRoot)}, 1, { executionId: 'e' + process.pid, cardId: 'c', purpose: 'work' });
  if (result.status === 'acquired') held = result.lock;
  process.send({ round: message.round, status: result.status, generation: result.status === 'acquired' ? result.lock.generation : null });
});
process.send({ ready: true });
`
    );
    const workers = Array.from({ length: WORKERS }, () => forkWorker(script, []));
    await Promise.all(
      workers.map((worker) => nextMessage<{ ready?: boolean }>(worker, (message) => message.ready === true))
    );

    const rounds = 25;
    for (let round = 1; round <= rounds; round++) {
      const replies = Promise.all(
        workers.map((worker) =>
          nextMessage<{ round?: number; status: string; generation: number | null }>(
            worker,
            (message) => message.round === round
          )
        )
      );
      const at = Date.now() + 50;
      for (const worker of workers) worker.send({ round, at });
      const results = await replies;
      const winners = results.filter((result) => result.status === 'acquired');
      expect(winners, `round ${round}`).toHaveLength(1);
      expect(winners[0]?.generation).toBe(round);
      for (const result of results) {
        if (result.status !== 'acquired') expect(['held', 'taken']).toContain(result.status);
      }
      const released = Promise.all(
        workers.map((worker) => nextMessage<{ released?: number }>(worker, (message) => message.released === round))
      );
      for (const worker of workers) worker.send({ release: true, round });
      await released;
    }
    for (const worker of workers) worker.disconnect();
  });
});

describe('GC churn [L1]', () => {
  it.skip('never lets two holders overlap while every acquirer collects eagerly', async () => {
    const slotRoot = join(base, 'slots');
    mkdirSync(slotRoot);
    const marker = join(base, 'inside');
    const script = join(base, 'churner.mts');
    writeFileSync(
      script,
      `
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { acquireSlotLock } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
const until = Date.now() + 5000;
const stats = { attempts: 0, won: 0, violations: 0 };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
while (Date.now() < until) {
  stats.attempts++;
  const result = await acquireSlotLock(${JSON.stringify(slotRoot)}, 1, { executionId: 'e' + process.pid, cardId: 'c', purpose: 'work' });
  if (result.status !== 'acquired') { await pause(Math.random() * 3); continue; }
  stats.won++;
  try { closeSync(openSync(${JSON.stringify(marker)}, 'wx')); } catch { stats.violations++; }
  await pause(Math.random() * 2);
  try { unlinkSync(${JSON.stringify(marker)}); } catch {}
  await result.lock.release();
}
process.send(stats, () => process.exit(0));
`
    );
    const results = await Promise.all(
      Array.from({ length: WORKERS }, () => {
        const worker = forkWorker(script, []);
        return nextMessage<{ attempts: number; won: number; violations: number }>(worker, () => true);
      })
    );
    const won = results.reduce((sum, result) => sum + result.won, 0);
    const violations = results.reduce((sum, result) => sum + result.violations, 0);
    expect(won).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });
});

describe('stale empty target [L1]', () => {
  it.skip('backs off a rename that replaced a lower generation emptied behind the maximum', async () => {
    const slotRoot = join(base, 'slots');
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    mkdirSync(join(slotRoot, '.locks', '1', '2'));
    writeGeneration(slotRoot, 1, 3, { owner: ownerFile({ executionId: 'max' }) });

    const result = await publishGeneration(join(slotRoot, '.locks', '1'), 1, { owner: ownerFile(), creating: null });

    expect(result).toMatchObject({ status: 'backed_off', generation: 2, higher: 3 });
    expect(existsSync(join(slotRoot, '.locks', '1', '2', 'released.json'))).toBe(true);
  });
});

describe.runIf(POSIX)('liveness [L3] [L4]', () => {
  it.skip('reads an unreaped zombie holder as alive and frees it once init reaps it', async () => {
    const slotRoot = join(base, 'slots');
    const identity = createProcessIdentity();
    const parent = spawn('/bin/sh', ['-c', 'sleep 0.2 & echo $!; exec sleep 30'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    children.push(parent);
    const pgid = parent.pid as number;
    const zombie = Number(
      await new Promise<string>((resolveLine) =>
        parent.stdout?.once('data', (chunk) => resolveLine(String(chunk).trim()))
      )
    );
    const recorded = await identity.identify(zombie, 2_000);
    if (recorded === null || recorded === 'unknown') throw new Error('zombie holder unreadable');
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({
        domain: await identity.currentProcessDomain(),
        holder: { pid: zombie, startIdentity: recorded.startIdentity, processGroupId: pgid }
      })
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));

    expect(identity.isProcessAbsent(zombie)).toBe(false);
    expect(await identity.identify(zombie, 2_000)).toMatchObject({ startIdentity: recorded.startIdentity });
    expect((await readSlotLock(slotRoot, 1)).state).toBe('held');

    parent.kill('SIGKILL');
    await waitFor(async () => (await readSlotLock(slotRoot, 1)).state === 'free');
  });

  it.skip('keeps a leaderless group held until its last member exits', async () => {
    const slotRoot = join(base, 'slots');
    const identity = createProcessIdentity();
    const leader = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; exit 0'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    children.push(leader);
    const pgid = leader.pid as number;
    const leaderIdentity = await identity.identify(pgid, 2_000);
    const member = Number(
      await new Promise<string>((resolveLine) =>
        leader.stdout?.once('data', (chunk) => resolveLine(String(chunk).trim()))
      )
    );
    await new Promise((resolveExit) =>
      leader.exitCode === null ? leader.once('exit', resolveExit) : resolveExit(null)
    );
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({
        domain: await identity.currentProcessDomain(),
        holder: {
          pid: pgid,
          startIdentity:
            leaderIdentity !== null && leaderIdentity !== 'unknown' ? leaderIdentity.startIdentity : 'gone',
          processGroupId: pgid
        }
      })
    });

    expect(await readSlotLock(slotRoot, 1)).toMatchObject({
      state: 'held',
      survivors: { holderAlive: false, groupAlive: true }
    });

    const memberIdentity = await identity.identify(member, 2_000);
    expect(memberIdentity).toMatchObject({ processGroupId: pgid });
    expect(pgid).toBeGreaterThan(1);
    process.kill(-pgid, 'SIGKILL');
    await waitFor(async () => (await readSlotLock(slotRoot, 1)).state === 'free');
  });
});

describe.runIf(POSIX)('action group [L4b]', () => {
  const shells = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell));
  const shapes = {
    simple: '"$NODE_BIN" "$TSX_IMPORT" ./handler.mts',
    andList: 'cd . && "$NODE_BIN" "$TSX_IMPORT" ./handler.mts',
    trailing: '"$NODE_BIN" "$TSX_IMPORT" ./handler.mts; true'
  };

  it.skip.each(
    shells.flatMap((shell) => Object.entries(shapes).map(([shape, command]) => [shell, shape, command]))
  )('records the handler and its agent in the action group under %s (%s)', async (shell, _shape, command) => {
    const slotRoot = join(base, 'slots');
    writeFileSync(
      join(base, 'handler.mts'),
      `
import { spawn } from 'node:child_process';
import { createProcessIdentity } from ${JSON.stringify(join(SOURCE, 'process-identity.ts'))};
import { acquireSlotLock } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
const acquired = await acquireSlotLock(${JSON.stringify(slotRoot)}, 1, { executionId: 'e', cardId: 'c', purpose: 'work' });
if (acquired.status !== 'acquired') process.exit(3);
const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
const recording = await acquired.lock.addCompanion(agent, 'agent');
const agentIdentity = await createProcessIdentity().identify(agent.pid, 2000);
agent.kill('SIGKILL');
process.stdout.write(JSON.stringify({
  handlerGroup: acquired.lock.owner.holder.processGroupId,
  agentGroup: agentIdentity && agentIdentity !== 'unknown' ? agentIdentity.processGroupId : null,
  recorded: recording.status
}));
process.exit(0);
`
    );
    const root = spawn(command, [], {
      shell,
      detached: true,
      cwd: base,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, NODE_BIN: process.execPath, TSX_IMPORT }
    });
    children.push(root);
    let output = '';
    root.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    await new Promise((resolveExit) => root.once('exit', resolveExit));
    const report = JSON.parse(output);
    expect(report).toEqual({ handlerGroup: root.pid, agentGroup: root.pid, recorded: 'recorded' });
  });
});

/**
 * Polls an async condition every 20 ms.
 * @param check - Condition to wait for.
 * @param timeoutMs - Ceiling before failing.
 * @throws {Error} When the condition stays false past the ceiling.
 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

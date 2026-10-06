/**
 * Slot locks on real temporary directories: generation publication, dead-holder
 * judgement across process domains and unverified owners, companions, handoff,
 * the shutdown fence, scanner-error tolerance and garbage collection. Liveness
 * is answered by an injected process world unless a case needs real processes.
 * @summary Slot lock acquire, judgement, holding, fence and GC
 */
import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessIdentity, type ProcessDomain } from '../src/process-identity.js';
import {
  type AcquireSlotLockOptions,
  type AcquireSlotLockResult,
  acquireSlotLock,
  createSlotJudgeContext,
  HANDOFF_EXPIRY_MS,
  LOCK_SWEEP_AGE_MS,
  listSlotLockOrdinals,
  publishGeneration,
  readSlotLock,
  readSlotLockSnapshot,
  ShutdownError,
  slotLockOwnerSchema,
  slotLockPids,
  withSlotLock
} from '../src/slot-lock.js';
import {
  DARWIN_DOMAIN,
  type FakeWorld,
  fakeIdentity,
  fakeWorld,
  INTENT,
  LINUX_DOMAIN,
  lockEnvironment,
  ownerFile,
  SELF_GROUP,
  SELF_PID,
  WINDOWS_DOMAIN,
  writeGeneration
} from './helpers/slot-lock-fixtures.js';
import { TSX_IMPORT } from './helpers/tsx.js';

const POSIX = process.platform !== 'win32';
const SOURCE = resolve(__dirname, '../src');

let slotRoot: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  slotRoot = mkdtempSync(join(tmpdir(), 'slot-lock-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(slotRoot, { recursive: true, force: true });
});

function generations(ordinal = 1): number[] {
  return readdirSync(join(slotRoot, '.locks', String(ordinal)))
    .filter((name) => /^[1-9]\d*$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

function generationDir(generation: number, ordinal = 1): string {
  return join(slotRoot, '.locks', String(ordinal), String(generation));
}

async function acquire(
  world: FakeWorld | null,
  options: Partial<AcquireSlotLockOptions> = {},
  ordinal = 1
): Promise<AcquireSlotLockResult> {
  const { environment } = lockEnvironment(world);
  return acquireSlotLock(slotRoot, ordinal, {
    executionId: 'exec-2',
    cardId: 'main-734',
    purpose: 'work',
    environment,
    ...options
  });
}

function acquired(result: AcquireSlotLockResult): Extract<AcquireSlotLockResult, { status: 'acquired' }> {
  if (result.status !== 'acquired') throw new Error(`expected acquired, got ${JSON.stringify(result)}`);
  return result;
}

/**
 * Converts an instant to Windows `CreationDate` ticks.
 * @param at - The instant.
 * @returns 100 ns ticks since 0001-01-01 UTC, as a decimal string.
 */
function ticks(at: Date): string {
  return String((BigInt(at.getTime()) + 62_135_596_800_000n) * 10_000n);
}

describe('acquire and publish', () => {
  it('creates generation 1 with the full owner and an empty previous when the ordinal is new', async () => {
    const world = fakeWorld();
    const result = acquired(await acquire(world));

    expect(result.previous).toEqual({ generation: 0, owner: null, companions: [], creating: null });
    expect(result.verified).toBe(true);
    expect(result.lock.generation).toBe(1);
    const owner = slotLockOwnerSchema.parse(JSON.parse(readFileSync(join(generationDir(1), 'owner.json'), 'utf8')));
    expect(owner).toMatchObject({
      executionId: 'exec-2',
      cardId: 'main-734',
      purpose: 'work',
      domain: LINUX_DOMAIN,
      holder: { pid: SELF_PID, startIdentity: 'self-start', processGroupId: SELF_GROUP }
    });
    expect(await listSlotLockOrdinals(slotRoot)).toEqual([1]);
  });

  it('takes over a released generation and GCs every generation below the new maximum', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    writeGeneration(slotRoot, 1, 2, { owner: ownerFile(), released: true });
    const result = acquired(await acquire(fakeWorld()));

    expect(result.lock.generation).toBe(3);
    expect(result.previous.generation).toBe(2);
    expect(generations()).toEqual([3]);
    expect(readdirSync(join(slotRoot, '.locks', '1')).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('leaves a crash between temp write and rename invisible: the next acquirer takes generation 1', async () => {
    const lockDir = join(slotRoot, '.locks', '1');
    mkdirSync(join(lockDir, '.tmp-crashed'), { recursive: true });
    writeFileSync(join(lockDir, '.tmp-crashed', 'owner.json'), JSON.stringify(ownerFile()));

    const result = acquired(await acquire(fakeWorld()));

    expect(result.lock.generation).toBe(1);
    expect(result.previous.generation).toBe(0);
    expect(existsSync(join(lockDir, '.tmp-crashed'))).toBe(true);
  });

  it('sweeps .tmp-* and .gc-* entries older than an hour and keeps fresh ones', async () => {
    const lockDir = join(slotRoot, '.locks', '1');
    const old = new Date(Date.now() - LOCK_SWEEP_AGE_MS - 60_000);
    for (const name of ['.tmp-old', '.gc-old', '.tmp-fresh', '.gc-fresh'])
      mkdirSync(join(lockDir, name), { recursive: true });
    utimesSync(join(lockDir, '.tmp-old'), old, old);
    utimesSync(join(lockDir, '.gc-old'), old, old);

    acquired(await acquire(fakeWorld()));

    const entries = readdirSync(lockDir)
      .filter((name) => name.startsWith('.'))
      .sort();
    expect(entries).toEqual(['.gc-fresh', '.tmp-fresh']);
  });

  it('reports taken when another acquirer created the next generation first', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    writeGeneration(slotRoot, 1, 2, { owner: ownerFile({ executionId: 'winner' }) });

    const result = await publishGeneration(join(slotRoot, '.locks', '1'), 1, { owner: ownerFile(), creating: null });

    expect(result).toEqual({ status: 'taken', generation: 2 });
    expect(JSON.parse(readFileSync(join(generationDir(2), 'owner.json'), 'utf8')).executionId).toBe('winner');
    expect(readdirSync(join(slotRoot, '.locks', '1')).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('backs off a stale-listing publish when a higher generation exists', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    writeGeneration(slotRoot, 1, 3, { owner: ownerFile({ executionId: 'newest' }) });

    const result = await publishGeneration(join(slotRoot, '.locks', '1'), 1, { owner: ownerFile(), creating: null });

    expect(result).toEqual({ status: 'backed_off', generation: 2, higher: 3 });
    expect(existsSync(join(generationDir(2), 'released.json'))).toBe(true);
    expect((await readSlotLock(slotRoot, 1, lockEnvironmentOptions(fakeWorld()))).snapshot?.generation).toBe(3);
  });

  it('backs off on verify when a stale rename replaced an emptied lower generation', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    mkdirSync(generationDir(2));
    writeGeneration(slotRoot, 1, 3, { owner: ownerFile({ executionId: 'newest' }) });

    const result = await publishGeneration(join(slotRoot, '.locks', '1'), 1, { owner: ownerFile(), creating: null });

    expect(result).toMatchObject({ status: 'backed_off', higher: 3 });
    expect(existsSync(join(generationDir(2), 'released.json'))).toBe(true);
  });

  it('never replaces a target a GC rename emptied, because GC moves it away before emptying it', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    writeGeneration(slotRoot, 1, 2, { owner: ownerFile(), released: true });
    const first = acquired(await acquire(fakeWorld()));
    expect(first.lock.generation).toBe(3);

    const stale = await publishGeneration(join(slotRoot, '.locks', '1'), 1, { owner: ownerFile(), creating: null });

    expect(stale.status).toBe('backed_off');
    expect(generations().at(-1)).toBe(3);
    const owner = JSON.parse(readFileSync(join(generationDir(3), 'owner.json'), 'utf8'));
    expect(owner.executionId).toBe('exec-2');
  });

  it('treats ENOENT on the back-off write into an already collected generation as success', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), released: true });
    writeGeneration(slotRoot, 1, 3, { owner: ownerFile({ executionId: 'newest' }) });
    const lockDir = join(slotRoot, '.locks', '1');

    const result = await publishGeneration(
      lockDir,
      1,
      { owner: ownerFile(), creating: null },
      {
        fs: {
          readFile: (path) => readFile(path, 'utf8'),
          rename: async (from, to) => {
            await rename(from, to);
            if (to === generationDir(2)) await rename(to, join(lockDir, '.gc-collected'));
          }
        }
      }
    );

    expect(result).toMatchObject({ status: 'backed_off', generation: 2 });
  });

  it('retries transient rename errors while the destination is absent, then acquires', async () => {
    let failures = 3;
    const result = acquired(
      await acquire(fakeWorld(), {
        environment: {
          ...lockEnvironment(fakeWorld()).environment,
          fs: {
            readFile: (path) => readFile(path, 'utf8'),
            rename: async (from, to) => {
              if (failures > 0 && to === generationDir(1)) {
                failures--;
                throw Object.assign(new Error('scanner'), { code: 'EPERM' });
              }
              await rename(from, to);
            }
          }
        }
      })
    );
    expect(failures).toBe(0);
    expect(result.lock.generation).toBe(1);
  });

  it('reports unavailable once transient rename errors outlast the budget', async () => {
    const started = Date.now();
    const result = await acquire(fakeWorld(), {
      environment: {
        ...lockEnvironment(fakeWorld()).environment,
        renameBudgetMs: 300,
        fs: {
          readFile: (path) => readFile(path, 'utf8'),
          rename: async (from, to) => {
            if (to === generationDir(1)) throw Object.assign(new Error('scanner'), { code: 'EBUSY' });
            await rename(from, to);
          }
        }
      }
    });
    expect(result.status).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(existsSync(generationDir(1))).toBe(false);
  });

  it('never replaces a target with a truncated temp file when an atomic write crashes', async () => {
    let crash = false;
    const { environment } = lockEnvironment(fakeWorld(), {
      renameBudgetMs: 100,
      fs: {
        readFile: (path) => readFile(path, 'utf8'),
        rename: async (from, to) => {
          if (crash && to.endsWith('creating.json')) throw Object.assign(new Error('crash'), { code: 'EIO' });
          await rename(from, to);
        }
      }
    });
    const { lock } = acquired(
      await acquireSlotLock(slotRoot, 1, { executionId: 'e', cardId: 'c', purpose: 'work', environment })
    );
    await lock.writeIntent(INTENT);
    crash = true;

    await expect(lock.writeIntent({ ...INTENT, op: 'recreate' })).rejects.toThrow();

    expect(JSON.parse(readFileSync(join(generationDir(1), 'creating.json'), 'utf8'))).toEqual(INTENT);
    const snapshot = await readSlotLockSnapshot(slotRoot, 1);
    expect(snapshot).toMatchObject({ creating: INTENT });
  });
});

describe('previous snapshot and intent carry [F12] [G2]', () => {
  it('returns the judged generation as previous although GC collected it', async () => {
    writeGeneration(slotRoot, 1, 4, {
      owner: ownerFile({ executionId: 'old' }),
      companions: [{ pid: 3_000, startIdentity: 'agent-start', role: 'agent' }],
      creating: INTENT
    });
    const result = acquired(await acquire(fakeWorld()));

    expect(result.previous).toMatchObject({
      generation: 4,
      owner: { executionId: 'old' },
      companions: [{ pid: 3_000 }],
      creating: INTENT
    });
    expect(generations()).toEqual([5]);
    expect(JSON.parse(readFileSync(join(generationDir(5), 'creating.json'), 'utf8'))).toEqual(INTENT);
  });

  it.runIf(POSIX)('keeps the intent in the maximum when an acquirer dies after publish, before GC', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), creating: INTENT, released: true });
    await runCrashingAcquirer('after-publish');

    expect(generations()).toEqual([1, 2]);
    expect(JSON.parse(readFileSync(join(generationDir(2), 'creating.json'), 'utf8'))).toEqual(INTENT);
    const next = acquired(await acquire(null));
    expect(next.previous.creating).toEqual(INTENT);
    expect(next.previous.generation).toBe(2);
  });

  it.runIf(POSIX)('keeps the intent in the maximum when an acquirer dies during GC', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), creating: INTENT, released: true });
    await runCrashingAcquirer('during-gc');

    expect(generations()).toEqual([2]);
    const next = acquired(await acquire(null));
    expect(next.previous.creating).toEqual(INTENT);
  });

  /**
   * Runs a real acquirer that publishes generation 2 with the carried intent
   * and SIGKILLs itself at the given point.
   * @param point - `after-publish` before GC starts, `during-gc` after renaming generation 1 away.
   */
  async function runCrashingAcquirer(point: 'after-publish' | 'during-gc'): Promise<void> {
    const script = join(slotRoot, 'crash.mts');
    const lockDir = join(slotRoot, '.locks', '1');
    writeFileSync(
      script,
      `
import { rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createProcessIdentity } from ${JSON.stringify(join(SOURCE, 'process-identity.ts'))};
import { publishGeneration, readSlotLockSnapshot } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
const identity = createProcessIdentity();
const self = await identity.currentProcessIdentity();
const snapshot = await readSlotLockSnapshot(${JSON.stringify(slotRoot)}, 1);
if (snapshot === null || 'unreadable' in snapshot) process.exit(3);
const owner = {
  version: 1, executionId: 'crasher', cardId: 'main-734', purpose: 'work',
  domain: await identity.currentProcessDomain(), hostname: hostname(), createdAt: new Date().toISOString(),
  holder: { pid: process.pid, startIdentity: self === 'unknown' ? null : self.startIdentity, processGroupId: await identity.currentProcessGroupId() }
};
const published = await publishGeneration(${JSON.stringify(lockDir)}, snapshot.generation, { owner, creating: snapshot.creating });
if (published.status !== 'published') process.exit(4);
if (${JSON.stringify(point)} === 'during-gc') await rename(join(${JSON.stringify(lockDir)}, '1'), join(${JSON.stringify(lockDir)}, '.gc-crashed'));
process.kill(process.pid, 'SIGKILL');
`
    );
    // Its own group, as the wrapper's action group would be, so the group dies with it.
    const child = spawn(process.execPath, [TSX_IMPORT, script], { detached: true, stdio: 'ignore' });
    children.push(child);
    const signal = await new Promise<string | null>((resolveExit) =>
      child.once('exit', (_code, sig) => resolveExit(sig))
    );
    expect(signal).toBe('SIGKILL');
    // tsx's esbuild service outlives its parent briefly and keeps the recorded group alive.
    const pgid = child.pid as number;
    expect(pgid).toBeGreaterThan(1);
    await waitFor(() => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    });
  }
});

describe('dead-holder judgement', () => {
  it('takes over a holder whose PID, group and companions are gone', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile(),
      companions: [{ pid: 3_000, startIdentity: 'agent-start', role: 'agent' }]
    });
    const result = acquired(await acquire(fakeWorld()));
    expect(result.lock.generation).toBe(2);
  });

  it('takes over a holder whose PID was recycled by another process', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'someone-else', processGroupId: 5_000 });
    acquired(await acquire(world));
  });

  it('stays held while the agent keeps the group alive after the handler died', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
    const world = fakeWorld();
    world.processes.set(2_100, { parentPid: 1, startIdentity: 'agent-start', processGroupId: 2_000 });
    const result = await acquire(world);
    expect(result).toMatchObject({
      status: 'held',
      survivors: { holderAlive: false, groupAlive: true, companions: [] }
    });
  });

  it('stays held while a slot git child in the group outlives the handler [F2]', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
    const world = fakeWorld();
    world.processes.set(2_200, { parentPid: 1, startIdentity: 'git-start', processGroupId: 2_000 });
    const state = await readSlotLock(slotRoot, 1, lockEnvironmentOptions(world));
    expect(state).toMatchObject({ state: 'held', survivors: { groupAlive: true } });
  });

  it('stays held while a recorded companion lives', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile(),
      companions: [{ pid: 3_000, startIdentity: 'agent-start', role: 'agent' }]
    });
    const world = fakeWorld();
    world.processes.set(3_000, { parentPid: 1, startIdentity: 'agent-start', processGroupId: 3_000 });
    expect(await acquire(world)).toMatchObject({ status: 'held', survivors: { companions: [3_000] } });
  });

  it('reads lock_unknown, never free, when a holder probe answers unknown', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
    const world = fakeWorld();
    world.processes.set(2_000, 'unknown');
    const result = await acquire(world);
    expect(result.status).toBe('unknown');
    expect(generations()).toEqual([1]);
  });

  it('reads lock_unknown for an owner.json missing a required key', async () => {
    const { holder: _holder, ...partial } = ownerFile();
    writeGeneration(slotRoot, 1, 1, { owner: JSON.stringify(partial) });
    expect((await acquire(fakeWorld())).status).toBe('unknown');
  });

  it('validates every unverified owner form [N2]', () => {
    for (const owner of [
      ownerFile({ holder: { startIdentity: null } }),
      ownerFile({ holder: { processGroupId: null } }),
      ownerFile({ holder: { startIdentity: null, processGroupId: null } }),
      ownerFile({ domain: { ...LINUX_DOMAIN, machineId: null, bootId: null } }),
      ownerFile({ domain: { ...LINUX_DOMAIN, pidNamespace: null, pidNamespaceInit: null } }),
      ownerFile({ domain: { ...DARWIN_DOMAIN, bootSessionUuid: null, machineId: null } }),
      ownerFile({ domain: { ...WINDOWS_DOMAIN, bootTime: null, machineId: null }, holder: { processGroupId: null } })
    ]) {
      expect(slotLockOwnerSchema.safeParse(owner).success).toBe(true);
    }
  });

  it.each([
    'owner.json',
    'companions.json',
    'handoff.json',
    'creating.json'
  ])('reads lock_unknown on a non-ENOENT read error of %s [F11]', async (name) => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile(),
      companions: [],
      handoff: { token: 't', expiresAt: '2026-01-01T00:00:00.000Z' },
      creating: INTENT
    });
    const result = await acquire(fakeWorld(), {
      environment: {
        ...lockEnvironment(fakeWorld()).environment,
        fs: {
          readFile: async (path) => {
            if (path.endsWith(name)) throw Object.assign(new Error('scanner'), { code: 'EACCES' });
            return readFile(path, 'utf8');
          },
          rename
        }
      }
    });
    expect(result.status).toBe('unknown');
  });

  it('reads lock_unknown for a malformed optional file', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile(), companions: '{"version":1,' });
    expect((await acquire(fakeWorld())).status).toBe('unknown');
  });

  it('lists every recorded PID of a snapshot once', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile(),
      companions: [
        { pid: 3_000, startIdentity: 'agent-start', role: 'agent' },
        { pid: 2_000, startIdentity: 'holder-start', role: 'agent' }
      ]
    });
    const snapshot = await readSlotLockSnapshot(slotRoot, 1);
    if (snapshot === null || 'unreadable' in snapshot) throw new Error('unreadable');
    expect([...slotLockPids(snapshot)].sort()).toEqual([2_000, 3_000]);
  });
});

describe('process domain [F1] [K] [G4]', () => {
  it('ignores a hostname and machine id change within the same domain [N1]', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ hostname: 'old-container', domain: { ...LINUX_DOMAIN, machineId: null } })
    });
    const live = fakeWorld();
    live.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
    expect((await acquire(live)).status).toBe('held');

    acquired(await acquire(fakeWorld({ domain: { ...LINUX_DOMAIN, machineId: 'machine-2' } })));
  });

  it.each<[string, ProcessDomain]>([
    ['PID namespace', { ...LINUX_DOMAIN, pidNamespace: '4026532000' }],
    ['PID namespace birth marker', { ...LINUX_DOMAIN, pidNamespaceInit: '999' }],
    ['boot id', { ...LINUX_DOMAIN, bootId: 'boot-2' }]
  ])('takes over at once a holder recorded in another %s, with no PID probe', async (_name, holderDomain) => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ domain: holderDomain }),
      companions: [{ pid: 3_000, startIdentity: 'agent-start', role: 'agent' }]
    });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
    world.processes.set(3_000, { parentPid: 1, startIdentity: 'agent-start', processGroupId: 2_000 });

    acquired(await acquire(world));
    expect(world.calls.identify).not.toContain(2_000);
    expect(world.calls.absent).not.toContain(2_000);
    expect(world.calls.groups).not.toContain(2_000);
  });

  it('takes over at once a macOS holder from another boot session', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ domain: { ...DARWIN_DOMAIN, bootSessionUuid: 'session-0' } })
    });
    const world = fakeWorld({ domain: DARWIN_DOMAIN });
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
    acquired(await acquire(world));
    expect(world.calls.absent).not.toContain(2_000);
  });

  it('does not let a live unrelated group with a reused pgid hold a lock from a reused namespace inode', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile({ domain: { ...LINUX_DOMAIN, pidNamespaceInit: '50' } }) });
    const world = fakeWorld();
    world.processes.set(2_300, { parentPid: 1, startIdentity: 'unrelated', processGroupId: 2_000 });
    acquired(await acquire(world));
  });

  it('takes over Windows holders of an earlier boot by the PID rules [G3] [N1]', async () => {
    const handlerStart = new Date('2026-10-04T09:00:00Z');
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({
        domain: { ...WINDOWS_DOMAIN, bootTime: '2026-10-04T08:00:00.0000000Z' },
        holder: { startIdentity: ticks(handlerStart), processGroupId: null }
      })
    });
    const world = fakeWorld({ platform: 'win32' });
    world.processes.set(2_000, { parentPid: 4, startIdentity: ticks(new Date()), processGroupId: 0 });
    acquired(await acquire(world));
  });

  it('keeps a live Windows holder held across a forward clock step that moved LastBootUpTime', async () => {
    const handlerStart = new Date('2026-10-05T09:00:00Z');
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({
        domain: { ...WINDOWS_DOMAIN, bootTime: '2026-10-05T08:00:00.0000000Z' },
        holder: { startIdentity: ticks(handlerStart), processGroupId: null }
      })
    });
    const world = fakeWorld({
      platform: 'win32',
      domain: { ...WINDOWS_DOMAIN, bootTime: '2026-10-05T08:10:00.0000000Z' }
    });
    world.processes.set(2_000, { parentPid: 4, startIdentity: ticks(handlerStart), processGroupId: 0 });
    expect((await acquire(world)).status).toBe('held');
  });

  it('ignores a rewritten MachineGuid on Windows: live held, dead taken over', async () => {
    const handlerStart = new Date('2026-10-05T09:00:00Z');
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ domain: WINDOWS_DOMAIN, holder: { startIdentity: ticks(handlerStart), processGroupId: null } })
    });
    const world = fakeWorld({ platform: 'win32', domain: { ...WINDOWS_DOMAIN, machineId: 'guid-2' } });
    world.processes.set(2_000, { parentPid: 4, startIdentity: ticks(handlerStart), processGroupId: 0 });
    expect((await acquire(world)).status).toBe('held');
    world.processes.delete(2_000);
    acquired(await acquire(world));
  });
});

describe('unverified owners and readers [W] [N2] [N3]', () => {
  it('acquires with a null start identity when its own probe fails, keeping the separately read group', async () => {
    const world = fakeWorld({ self: 'unknown' });
    const result = acquired(await acquire(world));
    expect(result.verified).toBe(false);
    expect(result.lock.owner.holder).toEqual({ pid: SELF_PID, startIdentity: null, processGroupId: SELF_GROUP });
  });

  it('acquires with a null domain part when it cannot read one', async () => {
    const world = fakeWorld({ domain: { ...LINUX_DOMAIN, pidNamespace: null, pidNamespaceInit: null } });
    const result = acquired(await acquire(world));
    expect(result.verified).toBe(false);
    expect(result.lock.owner.domain).toMatchObject({ pidNamespace: null, pidNamespaceInit: null });
  });

  it('takes over an unverified owner once every recorded PID and its group answer ESRCH', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ holder: { startIdentity: null } }),
      companions: [{ pid: 3_000, startIdentity: 'agent-start', role: 'agent' }]
    });
    acquired(await acquire(fakeWorld()));
  });

  it('reads an unverified owner whose PID is live, even reused, as lock_unknown', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile({ holder: { startIdentity: null } }) });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'reused', processGroupId: 7_000 });
    const result = await acquire(world);
    expect(result).toMatchObject({ status: 'unknown', detail: { unverifiedOwner: true } });
  });

  it('judges a verified owner by PID absence alone when the reader is unverified', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
    const world = fakeWorld({ self: 'unknown' });
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'reused', processGroupId: 7_000 });
    expect((await acquire(world)).status).toBe('unknown');
    world.processes.delete(2_000);
    acquired(await acquire(world));
  });

  it('keeps an unverified owner held by a live member of its separately read group', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile({ holder: { startIdentity: null } }) });
    const world = fakeWorld();
    world.processes.set(2_100, { parentPid: 1, startIdentity: 'agent-start', processGroupId: 2_000 });
    expect((await acquire(world)).status).toBe('unknown');
  });

  it('reads an owner with no group as lock_unknown while its holder lives, and dead once all answer ESRCH', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ holder: { startIdentity: null, processGroupId: null } }),
      companions: [{ pid: 3_000, startIdentity: 'agent-start', role: 'agent' }]
    });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
    expect((await acquire(world)).status).toBe('unknown');
    world.processes.delete(2_000);
    world.processes.set(3_000, { parentPid: 1, startIdentity: 'agent-start', processGroupId: 2_000 });
    expect((await acquire(world)).status).toBe('unknown');
    world.processes.delete(3_000);
    acquired(await acquire(world));
  });

  it.each<[string, ProcessDomain, ProcessDomain]>([
    ['Linux', { ...LINUX_DOMAIN, bootId: 'boot-0', pidNamespace: null }, LINUX_DOMAIN],
    ['macOS', { ...DARWIN_DOMAIN, bootSessionUuid: 'session-0' }, DARWIN_DOMAIN]
  ])('takes over at once an unverified %s owner from another boot, with no PID probe', async (_name, holderDomain, readerDomain) => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ domain: holderDomain, holder: { startIdentity: null } })
    });
    const world = fakeWorld({ domain: readerDomain });
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'reused', processGroupId: 2_000 });
    acquired(await acquire(world));
    expect(world.calls.absent).not.toContain(2_000);
  });

  it('lets PID absence decide when either boot part is null', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: ownerFile({ domain: { ...LINUX_DOMAIN, bootId: null }, holder: { startIdentity: null } })
    });
    const world = fakeWorld({ domain: { ...LINUX_DOMAIN, bootId: 'boot-2' } });
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'reused', processGroupId: 2_000 });
    expect((await acquire(world)).status).toBe('unknown');
    world.processes.delete(2_000);
    acquired(await acquire(world));
  });

  it.runIf(process.platform === 'linux')(
    'records an unverified owner when /proc/self is not this process',
    async () => {
      const identity = createProcessIdentity({ readLink: async () => '1' });
      const { environment } = lockEnvironment(null, { identity });
      const result = acquired(
        await acquireSlotLock(slotRoot, 1, { executionId: 'exec-2', cardId: 'main-734', purpose: 'work', environment })
      );
      expect(result.verified).toBe(false);
      expect(result.lock.owner.domain).toMatchObject({ pidNamespace: null, pidNamespaceInit: null });
    }
  );
});

describe('Windows judgement [F7] [H3]', () => {
  const handlerStart = new Date('2026-10-05T09:00:00Z');
  const writtenAt = new Date('2026-10-05T09:05:00Z');

  function windowsOwner(): ReturnType<typeof ownerFile> {
    return ownerFile({ domain: WINDOWS_DOMAIN, holder: { startIdentity: ticks(handlerStart), processGroupId: null } });
  }

  it.each<[string, number, Date, 'dead' | 'alive']>([
    ['after its writtenAt', 2_000, new Date('2026-10-05T09:06:00Z'), 'dead'],
    ['between the two', 2_000, new Date('2026-10-05T09:04:00Z'), 'alive'],
    // A backward clock step between the handler's start and the spawn dates the companion first.
    ["before the handler's start, after a backward clock step", 2_000, new Date('2026-10-05T08:59:30Z'), 'alive'],
    ['under another parent', 4, new Date('2026-10-05T09:04:00Z'), 'dead']
  ])('reads a live pending companion created %s (parent %i) as %s', async (_name, parentPid, created, expected) => {
    writeGeneration(slotRoot, 1, 1, {
      owner: windowsOwner(),
      companions: [{ pid: 3_000, startIdentity: 'pending', writtenAt: writtenAt.toISOString(), role: 'git' }]
    });
    const world = fakeWorld({ platform: 'win32' });
    world.processes.set(3_000, { parentPid, startIdentity: ticks(created), processGroupId: 0 });
    const result = await acquire(world);
    expect(result.status).toBe(expected === 'dead' ? 'acquired' : 'held');
  });

  it('retries a timed-out CIM batch once', async () => {
    const world = fakeWorld({ platform: 'win32' });
    world.identifyManyTimeouts = 1;
    const context = await createSlotJudgeContext([2_000], {
      timeoutMs: 100,
      retryTimeoutMs: 100,
      identity: fakeIdentity(world)
    });
    expect(world.calls.identifyMany).toBe(2);
    expect(context.verified).toBe(true);
  });

  it('acquires unverified after a self probe fails on the retry, reusing an all-ESRCH slot and skipping the rest', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: windowsOwner() });
    writeGeneration(slotRoot, 2, 1, {
      owner: ownerFile({
        domain: WINDOWS_DOMAIN,
        holder: { pid: 2_500, startIdentity: ticks(handlerStart), processGroupId: null }
      })
    });
    const world = fakeWorld({ platform: 'win32' });
    world.identifyManyTimeouts = 2;
    world.processes.set(2_500, { parentPid: 4, startIdentity: ticks(handlerStart), processGroupId: 0 });
    const identity = fakeIdentity(world);
    const context = await createSlotJudgeContext([2_000, 2_500], { timeoutMs: 100, retryTimeoutMs: 100, identity });
    expect(world.calls.identifyMany).toBe(2);
    expect(context.verified).toBe(false);
    expect(context.unverifiedReason).not.toBeNull();

    const skipped = await acquire(world, { context }, 2);
    expect(skipped).toMatchObject({ status: 'unknown' });
    if (skipped.status === 'unknown') expect(skipped.detail.reason).not.toBe('');
    const reused = acquired(await acquire(world, { context }, 1));
    expect(reused.verified).toBe(false);
    expect(reused.lock.owner.holder.startIdentity).toBeNull();
  });

  it('filters candidates with kill(pid, 0) before the CIM batch', async () => {
    const world = fakeWorld({ platform: 'win32' });
    world.processes.set(2_500, { parentPid: 4, startIdentity: '1', processGroupId: 0 });
    const context = await createSlotJudgeContext([2_000, 2_500], {
      timeoutMs: 100,
      retryTimeoutMs: 100,
      identity: fakeIdentity(world)
    });
    expect(world.calls.absent).toEqual(expect.arrayContaining([2_000, 2_500]));
    expect(context.identities.get(2_000)).toBeNull();
    expect(context.identities.get(2_500)).toMatchObject({ pid: 2_500 });
  });
});

describe('handoff [R1]', () => {
  function handoffOwner(): ReturnType<typeof ownerFile> {
    return ownerFile();
  }

  it('accepts the matching token while the source lives and refuses a wrong one', async () => {
    const expiresAt = new Date(Date.now() + HANDOFF_EXPIRY_MS).toISOString();
    writeGeneration(slotRoot, 1, 1, { owner: handoffOwner(), handoff: { token: 'secret', expiresAt } });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });

    expect(await acquire(world, { handoff: { generation: 1, token: 'wrong' } })).toMatchObject({ status: 'taken' });
    const claimed = acquired(await acquire(world, { handoff: { generation: 1, token: 'secret' } }));
    expect(claimed.lock.generation).toBe(2);
  });

  it('refuses a matching token once the generation moved on', async () => {
    const expiresAt = new Date(Date.now() + HANDOFF_EXPIRY_MS).toISOString();
    writeGeneration(slotRoot, 1, 1, { owner: handoffOwner(), handoff: { token: 'secret', expiresAt } });
    writeGeneration(slotRoot, 1, 2, { owner: ownerFile({ executionId: 'other' }) });
    expect(await acquire(fakeWorld(), { handoff: { generation: 1, token: 'secret' } })).toMatchObject({
      status: 'taken'
    });
  });

  it('keeps the slot held after the source died until the handoff expires', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: handoffOwner(),
      handoff: { token: 'secret', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    });
    expect(await acquire(fakeWorld())).toMatchObject({ status: 'held', handoffPending: true });
  });

  it('lets the token claim after expiry while the generation is the unreleased maximum, and others once holders died', async () => {
    writeGeneration(slotRoot, 1, 1, {
      owner: handoffOwner(),
      handoff: { token: 'secret', expiresAt: new Date(Date.now() - 1_000).toISOString() }
    });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
    expect((await acquire(world)).status).toBe('held');
    acquired(await acquire(world, { handoff: { generation: 1, token: 'secret' } }));

    writeGeneration(slotRoot, 2, 1, {
      owner: handoffOwner(),
      handoff: { token: 'secret', expiresAt: new Date(Date.now() - 1_000).toISOString() }
    });
    world.processes.delete(2_000);
    acquired(await acquire(world, {}, 2));
  });

  it('offerHandoff writes the token atomically and latches so no release follows', async () => {
    const world = fakeWorld();
    const env = lockEnvironment(world);
    const { lock } = acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'work',
        environment: env.environment
      })
    );
    const token = await lock.offerHandoff();
    expect(token.generation).toBe(1);
    const handoff = JSON.parse(readFileSync(join(generationDir(1), 'handoff.json'), 'utf8'));
    expect(handoff.token).toBe(token.token);
    expect(Date.parse(handoff.expiresAt) - Date.now()).toBeGreaterThan(HANDOFF_EXPIRY_MS - 10_000);
    expect(await lock.release()).toBe(false);

    await env.shutdown.shutdownAndExit(0, 'switch');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
  });
});

describe('companions [L4b] [F7]', () => {
  it('records a live child whose probed parent is this process', async () => {
    const { lock } = acquired(await acquire(null));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    const recording = await lock.addCompanion(child, 'agent');
    expect(recording).toMatchObject({ status: 'recorded', companion: { pid: child.pid, role: 'agent' } });
    const companions = JSON.parse(readFileSync(join(generationDir(1), 'companions.json'), 'utf8'));
    expect(companions.companions).toHaveLength(1);

    await lock.removeCompanion(child.pid as number);
    expect(JSON.parse(readFileSync(join(generationDir(1), 'companions.json'), 'utf8')).companions).toEqual([]);
  });

  it('does not record a child that already exited', async () => {
    const { lock } = acquired(await acquire(null));
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    children.push(child);
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    expect(await lock.addCompanion(child, 'agent')).toEqual({ status: 'exited' });
    expect(existsSync(join(generationDir(1), 'companions.json'))).toBe(false);
  });

  it('does not record a process whose probed parent is another process', async () => {
    const world = fakeWorld();
    const { lock } = acquired(await acquire(world));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    world.processes.set(child.pid as number, { parentPid: 4_242, startIdentity: 'x', processGroupId: SELF_GROUP });
    expect(await lock.addCompanion(child, 'agent')).toEqual({ status: 'not_child', parentPid: 4_242 });
  });

  it('records a Windows companion as pending when its probe times out', async () => {
    const world = fakeWorld({ platform: 'win32' });
    const { lock } = acquired(await acquire(world));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    world.processes.set(child.pid as number, 'unknown');
    const recording = await lock.addCompanion(child, 'agent');
    expect(recording).toMatchObject({
      status: 'recorded',
      companion: { pid: child.pid, startIdentity: 'pending', role: 'agent' }
    });
  });

  it('records Windows slot git as pending at spawn, then its identity, then removes it on exit [F2]', async () => {
    const world = fakeWorld({ platform: 'win32' });
    const { lock } = acquired(await acquire(world));
    const read = (): unknown[] =>
      JSON.parse(readFileSync(join(generationDir(1), 'companions.json'), 'utf8')).companions;

    lock.recordGit({ kind: 'spawned', pid: 4_000 });
    await waitFor(() => existsSync(join(generationDir(1), 'companions.json')) && read().length === 1);
    expect(read()).toMatchObject([{ pid: 4_000, startIdentity: 'pending', role: 'git' }]);
    lock.recordGit({
      kind: 'identified',
      pid: 4_000,
      identity: { pid: 4_000, parentPid: SELF_PID, startIdentity: '638000', processGroupId: 0 }
    });
    await waitFor(() => (read()[0] as { startIdentity?: string } | undefined)?.startIdentity === '638000');
    lock.recordGit({ kind: 'exited', pid: 4_000 });
    await waitFor(() => read().length === 0);
  });

  it('ignores slot git events on POSIX, where git is in the recorded group', async () => {
    const { lock } = acquired(await acquire(fakeWorld()));
    lock.recordGit({ kind: 'spawned', pid: 4_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(existsSync(join(generationDir(1), 'companions.json'))).toBe(false);
  });

  it('adds the agent’s live children created after it to the Windows release snapshot and does not release [L4]', async () => {
    const world = fakeWorld({ platform: 'win32' });
    const env = lockEnvironment(world);
    const { lock } = acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'work',
        environment: env.environment
      })
    );
    const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
    children.push(agent);
    const agentPid = agent.pid as number;
    world.processes.set(agentPid, { parentPid: SELF_PID, startIdentity: '100', processGroupId: 0 });
    expect((await lock.addCompanion(agent, 'agent')).status).toBe('recorded');
    world.processes.set(5_000, { parentPid: agentPid, startIdentity: '200', processGroupId: 0 });
    world.processes.set(5_001, { parentPid: agentPid, startIdentity: '50', processGroupId: 0 });
    await new Promise((resolveExit) => agent.once('exit', resolveExit));

    await env.shutdown.shutdownAndExit(0, 'completed');

    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
    const recorded = JSON.parse(readFileSync(join(generationDir(1), 'companions.json'), 'utf8')).companions.map(
      (companion: { pid: number }) => companion.pid
    );
    expect(recorded).toContain(5_000);
    expect(recorded).not.toContain(5_001);
  });
});

describe('shutdown fence [G1] [F4]', () => {
  async function workLock(world: FakeWorld | null = fakeWorld()) {
    const env = lockEnvironment(world);
    const result = acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'work',
        environment: env.environment
      })
    );
    return { ...env, lock: result.lock };
  }

  it('refuses operations and throws at checkpoints once the fence has closed', async () => {
    const { lock, shutdown } = await workLock();
    let ran = false;
    void shutdown.shutdownAndExit(0, 'completed');
    await expect(
      lock.operation('late', async () => {
        ran = true;
      })
    ).rejects.toBeInstanceOf(ShutdownError);
    expect(ran).toBe(false);
    expect(() => lock.checkpoint()).toThrow(ShutdownError);
  });

  it('ignores release() from in-process code once the fence has closed', async () => {
    const { lock, shutdown } = await workLock();
    let releaseHook = (): void => {};
    shutdown.register(
      () =>
        new Promise<void>((resolveHook) => {
          releaseHook = resolveHook;
        })
    );
    const done = shutdown.shutdownAndExit(0, 'completed');
    expect(await lock.release()).toBe(false);
    releaseHook();
    await done;
  });

  it('releases a work lock from the hook when no operation was in flight, after aborting slot git', async () => {
    const { lock, shutdown, aborts } = await workLock();
    await lock.operation('done-before', async () => {});
    await shutdown.shutdownAndExit(0, 'completed');
    expect(aborts).toEqual([1_500]);
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(true);
  });

  it('keeps a work lock when an operation was in flight at the fence', async () => {
    const { lock, shutdown } = await workLock();
    let finish = (): void => {};
    const operation = lock.operation(
      'in-flight',
      () =>
        new Promise<void>((resolveOperation) => {
          finish = resolveOperation;
        })
    );
    await shutdown.shutdownAndExit(143, 'signal');
    finish();
    await operation;
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
  });

  it('releases a removal lock after fn returns with the fence open, but not once fn saw the fence close', async () => {
    const env = lockEnvironment(fakeWorld());
    const options = { executionId: 'e', cardId: 'c', environment: env.environment };
    expect(await withSlotLock(slotRoot, 1, 'removal', options, async () => 'first')).toEqual({
      status: 'done',
      value: 'first'
    });
    expect(existsSync(join(generationDir(1, 1), 'released.json'))).toBe(true);

    const second = await withSlotLock(slotRoot, 2, 'removal', options, async () => {
      void env.shutdown.shutdownAndExit(0, 'completed');
      return 'second';
    });
    expect(second).toEqual({ status: 'done', value: 'second' });
    await waitFor(() => env.exits.length === 1);
    expect(existsSync(join(generationDir(1, 2), 'released.json'))).toBe(false);
  });

  it('never releases a removal lock from the hook, even with no operation in flight', async () => {
    const env = lockEnvironment(fakeWorld());
    const result = acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'removal',
        environment: env.environment
      })
    );
    void result;
    await env.shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
  });

  it('releases a removal lock when fn throws with the fence open, and rethrows', async () => {
    const env = lockEnvironment(fakeWorld());
    await expect(
      withSlotLock(
        slotRoot,
        1,
        'removal',
        { executionId: 'e', cardId: 'c', environment: env.environment },
        async () => {
          throw new Error('removal failed');
        }
      )
    ).rejects.toThrow('removal failed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(true);
  });

  it('returns the acquire outcome from withSlotLock without running fn when the slot is held', async () => {
    writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
    const world = fakeWorld();
    world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
    let ran = false;
    const result = await withSlotLock(
      slotRoot,
      1,
      'removal',
      { executionId: 'e', cardId: 'c', environment: lockEnvironment(world).environment },
      async () => {
        ran = true;
      }
    );
    expect(result.status).toBe('held');
    expect(ran).toBe(false);
  });

  it('waits for a live companion within the budget and releases once it exits', async () => {
    const { lock, shutdown } = await workLock(null);
    const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    children.push(agent);
    expect((await lock.addCompanion(agent, 'agent')).status).toBe('recorded');
    await shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(true);
  });

  it('does not release while a companion outlives the shutdown budget', async () => {
    const { lock, shutdown } = await workLock(null);
    const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(agent);
    expect((await lock.addCompanion(agent, 'agent')).status).toBe('recorded');
    await shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
  });

  /**
   * A fake world whose handler leads its own process group, as a launched handler does.
   * @returns A Linux world with no processes but this handler, whose PID is its group id.
   */
  function leaderWorld(): FakeWorld {
    return fakeWorld({
      selfGroup: SELF_PID,
      self: { parentPid: 1, startIdentity: 'self-start', processGroupId: SELF_PID }
    });
  }

  /**
   * Reads the current generation's companions.
   * @returns Each companion entry as persisted in `companions.json`.
   */
  function recordedCompanions(): unknown[] {
    return JSON.parse(readFileSync(join(generationDir(1), 'companions.json'), 'utf8')).companions;
  }

  it('keeps the lock and records the survivors when stopping slot git leaves members alive [L4]', async () => {
    const env = lockEnvironment(fakeWorld(), {
      git: { abortAll: async () => ({ survivors: [{ pid: 4_400, startIdentity: 'hook-start' }], complete: true }) }
    });
    acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'work',
        environment: env.environment
      })
    );
    await env.shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
    expect(recordedCompanions()).toEqual([{ pid: 4_400, startIdentity: 'hook-start', role: 'agent' }]);
  });

  it('keeps the lock when stopping slot git could not list its tree [L4]', async () => {
    const env = lockEnvironment(fakeWorld(), { git: { abortAll: async () => ({ survivors: [], complete: false }) } });
    acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'work',
        environment: env.environment
      })
    );
    await env.shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
  });

  it("keeps the lock at shutdown while a member of the handler's group is alive, and records it [L4]", async () => {
    const world = leaderWorld();
    const { shutdown } = await workLock(world);
    world.processes.set(4_500, { parentPid: 1, startIdentity: 'orphan-start', processGroupId: SELF_PID });
    await shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
    expect(recordedCompanions()).toEqual([{ pid: 4_500, startIdentity: 'orphan-start', role: 'agent' }]);
  });

  it("refuses an explicit release while a member of the handler's group is alive [L4]", async () => {
    const world = leaderWorld();
    const { lock } = await workLock(world);
    world.processes.set(4_500, { parentPid: SELF_PID, startIdentity: 'child-start', processGroupId: SELF_PID });
    expect(await lock.release()).toBe(false);
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
    world.processes.delete(4_500);
    expect(await lock.release()).toBe(true);
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(true);
  });

  it('refuses a release when the process table cannot be listed [L4]', async () => {
    const world = leaderWorld();
    const identity = { ...fakeIdentity(world), enumerate: async () => 'unknown' as const };
    const env = lockEnvironment(world, { identity });
    const result = acquired(
      await acquireSlotLock(slotRoot, 1, {
        executionId: 'e',
        cardId: 'c',
        purpose: 'work',
        environment: env.environment
      })
    );
    expect(await result.lock.release()).toBe(false);
    await env.shutdown.shutdownAndExit(0, 'completed');
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(false);
  });

  it.runIf(POSIX)('releases at once under a /bin/sh -c parent, with no wait for the group to drain', async () => {
    const script = join(slotRoot, 'handler.mts');
    writeFileSync(
      script,
      `
import { acquireSlotLock } from ${JSON.stringify(join(SOURCE, 'slot-lock.ts'))};
const acquired = await acquireSlotLock(${JSON.stringify(slotRoot)}, 1, { executionId: 'e', cardId: 'c', purpose: 'work' });
if (acquired.status !== 'acquired') process.exit(3);
const started = Date.now();
const released = await acquired.lock.release();
process.stdout.write(JSON.stringify({ released, elapsed: Date.now() - started }));
process.exit(0);
`
    );
    const root = spawn('/bin/sh', ['-c', `"$NODE_BIN" "$TSX_IMPORT" ${JSON.stringify(script)}; true`], {
      detached: true,
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
    expect(report.released).toBe(true);
    expect(report.elapsed).toBeLessThan(1_000);
  });

  it.runIf(POSIX)("releases a removal lock while a sibling in the cleaner's group is alive", async () => {
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(sibling);
    const result = await withSlotLock(
      slotRoot,
      1,
      'removal',
      { executionId: 'e', cardId: 'c', environment: lockEnvironment(null).environment },
      async () => 'removed'
    );
    expect(result).toEqual({ status: 'done', value: 'removed' });
    expect(existsSync(join(generationDir(1), 'released.json'))).toBe(true);
  });

  it('writes and clears the creation intent', async () => {
    const { lock } = await workLock();
    await lock.writeIntent(INTENT);
    expect(JSON.parse(readFileSync(join(generationDir(1), 'creating.json'), 'utf8'))).toEqual(INTENT);
    await lock.clearIntent();
    expect(existsSync(join(generationDir(1), 'creating.json'))).toBe(false);
  });
});

/**
 * Read options whose identity answers from a fake world.
 * @param world - The fake world.
 * @returns Options for `readSlotLock`.
 */
function lockEnvironmentOptions(world: FakeWorld): { environment: { identity: ReturnType<typeof fakeIdentity> } } {
  return { environment: { identity: fakeIdentity(world) } };
}

/**
 * Polls a condition every 10 ms.
 * @param check - Condition to wait for.
 * @param timeoutMs - Ceiling before failing.
 * @throws {Error} When the condition stays false past the ceiling.
 */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

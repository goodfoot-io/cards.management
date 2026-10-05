/**
 * Process identity: real probes of live, exited and reaped processes, the
 * liveness checks, the process domain and its comparison, and the macOS `ps`
 * and Windows CIM rules through injected OS readers.
 * @summary Process identity, liveness, domain and probe-failure rules
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BoundedCommandResult,
  compareDomains,
  createProcessIdentity,
  type ProcessDomain,
  type ProcessIdentityReaders
} from '../src/process-identity.js';

const LINUX = process.platform === 'linux';
const DARWIN = process.platform === 'darwin';
const POSIX = process.platform !== 'win32';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

function spawnSleeper(detached = false): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached });
  children.push(child);
  return child;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  if (child.pid === undefined) throw new Error('child had no pid');
  return child.pid;
}

function esrch(): never {
  throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
}

function commandResult(partial: Partial<BoundedCommandResult>): BoundedCommandResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, outputComplete: true, ...partial };
}

describe('real probes', () => {
  it('reads this process with its parent and group', async () => {
    const service = createProcessIdentity();
    const self = await service.identify(process.pid, 2_000);
    expect(self).not.toBeNull();
    expect(self).not.toBe('unknown');
    if (self === null || self === 'unknown') return;
    expect(self.pid).toBe(process.pid);
    expect(self.parentPid).toBe(process.ppid);
    if (POSIX) expect(self.processGroupId).toBe(await service.currentProcessGroupId());
    if (LINUX) expect(self.startIdentity).toMatch(/^[0-9a-f-]+:\d+$/);
  });

  it('keeps a live child identity stable and reads a reaped one as absent', async () => {
    const service = createProcessIdentity();
    const child = spawnSleeper();
    const pid = child.pid as number;
    const first = await service.identify(pid, 2_000);
    const second = await service.identify(pid, 2_000);
    expect(first).not.toBeNull();
    expect(first).not.toBe('unknown');
    expect(second).toEqual(first);
    expect(service.isProcessAbsent(pid)).toBe(false);

    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    expect(await service.identify(pid, 2_000)).toBeNull();
    expect(service.isProcessAbsent(pid)).toBe(true);
  });

  it('reads this process as present', async () => {
    expect(createProcessIdentity().isProcessAbsent(process.pid)).toBe(false);
    expect(createProcessIdentity().isProcessAbsent(await exitedPid())).toBe(true);
  });

  it.runIf(POSIX)('reads a live group as alive and an emptied group as gone', async () => {
    const service = createProcessIdentity();
    const ownGroup = await service.currentProcessGroupId();
    expect(ownGroup).not.toBeNull();
    expect(service.isProcessGroupAlive(ownGroup as number)).toBe(true);

    const leader = spawnSleeper(true);
    const pgid = leader.pid as number;
    expect(service.isProcessGroupAlive(pgid)).toBe(true);
    leader.kill('SIGKILL');
    await new Promise((resolveExit) => leader.once('exit', resolveExit));
    expect(service.isProcessGroupAlive(pgid)).toBe(false);
  });

  it('refuses a group id that would signal more than one recorded group', () => {
    const service = createProcessIdentity({ platform: 'linux' });
    expect(() => service.isProcessGroupAlive(1)).toThrow(RangeError);
    expect(() => service.isProcessGroupAlive(0)).toThrow(RangeError);
  });

  it('has no process groups on Windows', () => {
    expect(createProcessIdentity({ platform: 'win32' }).isProcessGroupAlive(4242)).toBeNull();
  });

  it.runIf(LINUX)('reads the Linux domain with its boot and PID namespace', async () => {
    const domain = await createProcessIdentity().currentProcessDomain();
    expect(domain.platform).toBe('linux');
    if (domain.platform !== 'linux') return;
    expect(domain.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(domain.pidNamespace).toMatch(/^\d+$/);
    expect(domain.pidNamespaceInit).toMatch(/^\d+$/);
  });

  it.runIf(DARWIN)('reads the macOS domain from kern.bootsessionuuid, stable across reads', async () => {
    const first = await createProcessIdentity().currentProcessDomain();
    const second = await createProcessIdentity().currentProcessDomain();
    expect(first.platform).toBe('darwin');
    if (first.platform !== 'darwin') return;
    expect(first.bootSessionUuid).toMatch(/^[0-9A-Fa-f-]{36}$/);
    expect(second).toEqual(first);
  });

  it.runIf(process.platform === 'win32')('batches N pids plus self into one real CIM call', async () => {
    const service = createProcessIdentity();
    const a = spawnSleeper();
    const b = spawnSleeper();
    const result = await service.identifyMany([a.pid as number, b.pid as number], {
      timeoutMs: 15_000,
      includeSelf: true
    });
    expect(result.identities.get(a.pid as number)).toMatchObject({ pid: a.pid });
    expect(result.identities.get(b.pid as number)).toMatchObject({ pid: b.pid });
    expect(result.self).toMatchObject({ pid: process.pid });
    expect(result.domain?.platform).toBe('win32');
  });
});

describe('macOS ps contract [F9]', () => {
  function darwin(
    run: ProcessIdentityReaders['runCommand'],
    kill: ProcessIdentityReaders['kill']
  ): ReturnType<typeof createProcessIdentity> {
    return createProcessIdentity({ platform: 'darwin', runCommand: run, kill });
  }

  it('reads exit 1 with empty output and a fresh ESRCH as absent', async () => {
    let probes = 0;
    const service = darwin(
      async () => commandResult({ exitCode: 1 }),
      () => {
        probes++;
        if (probes > 1) esrch();
      }
    );
    expect(await service.identify(4242, 2_000)).toBeNull();
    expect(probes).toBe(2);
  });

  it('reads exit 1 with empty output as unknown while kill(pid, 0) still succeeds', async () => {
    const service = darwin(
      async () => commandResult({ exitCode: 1 }),
      () => {}
    );
    expect(await service.identify(4242, 2_000)).toBe('unknown');
  });

  it('reads exit 1 with stderr (errx, usage) as unknown even after ESRCH', async () => {
    let probes = 0;
    const service = darwin(
      async () => commandResult({ exitCode: 1, stderr: 'ps: illegal option\nusage: ps ...' }),
      () => {
        probes++;
        if (probes > 1) esrch();
      }
    );
    expect(await service.identify(4242, 2_000)).toBe('unknown');
  });

  it('reads exit 2 as unknown', async () => {
    const service = darwin(
      async () => commandResult({ exitCode: 2 }),
      () => {}
    );
    expect(await service.identify(4242, 2_000)).toBe('unknown');
  });

  it('short-circuits on ESRCH before running ps', async () => {
    let runs = 0;
    const service = darwin(async () => {
      runs++;
      return commandResult({ exitCode: 0 });
    }, esrch);
    expect(await service.identify(4242, 2_000)).toBeNull();
    expect(runs).toBe(0);
  });

  it('parses a live ps row', async () => {
    const service = darwin(
      async () => commandResult({ stdout: ' 4242     1  4242  0 Ss   Mon Oct  5 17:40:12 2026\n' }),
      () => {}
    );
    expect(await service.identify(4242, 2_000)).toMatchObject({
      pid: 4242,
      parentPid: 1,
      processGroupId: 4242,
      startIdentity: 'Mon Oct 5 17:40:12 2026'
    });
  });
});

describe('Windows CIM batching', () => {
  const roster = (rows: object[], extra: object = {}): string =>
    JSON.stringify({ processes: rows, machineId: 'guid-1', bootTime: '2026-10-05T08:00:00.0000000Z', ...extra });

  it('makes one CIM call for N pids plus self, domain included', async () => {
    const calls: string[][] = [];
    const service = createProcessIdentity({
      platform: 'win32',
      pid: 100,
      kill: () => {},
      runCommand: async (_file, args) => {
        calls.push([...args]);
        return commandResult({
          stdout: roster([
            { pid: 100, parentPid: 4, startIdentity: '638000000000000000' },
            { pid: 200, parentPid: 100, startIdentity: '638000000000000100' }
          ])
        });
      }
    });
    const result = await service.identifyMany([200, 300], { timeoutMs: 5_000, includeSelf: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(' ')).toContain('ProcessId=200');
    expect(calls[0]?.join(' ')).toContain('ProcessId=300');
    expect(calls[0]?.join(' ')).toContain('ProcessId=100');
    expect(result.identities.get(200)).toMatchObject({ pid: 200, startIdentity: '638000000000000100' });
    expect(result.identities.get(300)).toBeNull();
    expect(result.self).toMatchObject({ pid: 100, startIdentity: '638000000000000000' });
    expect(result.domain).toEqual({ platform: 'win32', machineId: 'guid-1', bootTime: '2026-10-05T08:00:00.0000000Z' });
  });

  it('answers unknown for every pid and self when the call times out', async () => {
    const service = createProcessIdentity({
      platform: 'win32',
      pid: 100,
      kill: () => {},
      runCommand: async () => commandResult({ timedOut: true, exitCode: null, outputComplete: false })
    });
    const result = await service.identifyMany([200], { timeoutMs: 5_000, includeSelf: true });
    expect(result.identities.get(200)).toBe('unknown');
    expect(result.self).toBe('unknown');
  });

  it('caches the domain read with the self probe', async () => {
    let runs = 0;
    const service = createProcessIdentity({
      platform: 'win32',
      pid: 100,
      kill: () => {},
      runCommand: async () => {
        runs++;
        return commandResult({ stdout: roster([{ pid: 100, parentPid: 4, startIdentity: '638000000000000000' }]) });
      }
    });
    await service.identifyMany([], { timeoutMs: 5_000, includeSelf: true });
    expect((await service.currentProcessDomain()).platform).toBe('win32');
    expect(runs).toBe(1);
  });
});

describe('injected Linux domain reads', () => {
  const files: Record<string, string> = {
    '/etc/machine-id': 'machine-1\n',
    '/proc/sys/kernel/random/boot_id': 'boot-1\n',
    '/proc/1/stat': '1 (init) S 0 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 16557974 0 0\n',
    '/proc/self/stat': '4242 (node) S 1 4100 4100 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1834455 0 0\n',
    '/proc/4242/stat': '4242 (node) S 1 4100 4100 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1834455 0 0\n'
  };

  function linux(overrides: Partial<ProcessIdentityReaders> = {}): ReturnType<typeof createProcessIdentity> {
    return createProcessIdentity({
      platform: 'linux',
      pid: 4242,
      kill: () => {},
      readText: async (path) => {
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' });
        return text;
      },
      readLink: async () => '4242',
      inode: async () => '4026531836',
      ...overrides
    });
  }

  it('reads every part', async () => {
    expect(await linux().currentProcessDomain()).toEqual({
      platform: 'linux',
      machineId: 'machine-1',
      bootId: 'boot-1',
      pidNamespace: '4026531836',
      pidNamespaceInit: '16557974'
    });
    expect(await linux().currentProcessGroupId()).toBe(4100);
    expect(await linux().currentProcessIdentity()).toMatchObject({ pid: 4242, startIdentity: 'boot-1:1834455' });
  });

  it('records the namespace parts as unreadable when /proc/self is not this process', async () => {
    const domain = await linux({ readLink: async () => '1' }).currentProcessDomain();
    expect(domain).toMatchObject({ pidNamespace: null, pidNamespaceInit: null, bootId: 'boot-1' });
  });

  it('records a missing or unreadable machine id as null and still reads the deciding parts', async () => {
    const domain = await linux({
      readText: async (path) => {
        if (path === '/etc/machine-id') throw Object.assign(new Error(path), { code: 'EACCES' });
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' });
        return text;
      }
    }).currentProcessDomain();
    expect(domain).toMatchObject({ machineId: null, bootId: 'boot-1', pidNamespace: '4026531836' });
  });

  it('reads the group independently of an unreadable start identity [N2]', async () => {
    const service = linux({
      readText: async (path) => {
        if (path === '/proc/sys/kernel/random/boot_id') throw Object.assign(new Error(path), { code: 'EACCES' });
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error(path), { code: 'ENOENT' });
        return text;
      }
    });
    expect(await service.currentProcessIdentity()).toBe('unknown');
    expect(await service.currentProcessGroupId()).toBe(4100);
  });
});

describe('compareDomains [F1]', () => {
  const linux = (parts: Partial<Extract<ProcessDomain, { platform: 'linux' }>> = {}): ProcessDomain => ({
    platform: 'linux',
    machineId: 'm',
    bootId: 'b',
    pidNamespace: 'n',
    pidNamespaceInit: 'i',
    ...parts
  });
  const darwin = (bootSessionUuid: string | null, machineId: string | null = 'm'): ProcessDomain => ({
    platform: 'darwin',
    machineId,
    bootSessionUuid
  });

  it('is the same domain when the deciding parts match, whatever the machine id', () => {
    expect(compareDomains(linux(), linux())).toBe('same');
    expect(compareDomains(linux({ machineId: null }), linux({ machineId: 'other' }))).toBe('same');
    expect(compareDomains(darwin('u', 'a'), darwin('u', 'b'))).toBe('same');
  });

  it('is another domain when a boot or namespace part differs [K] [G4]', () => {
    expect(compareDomains(linux({ bootId: 'b2' }), linux())).toBe('other');
    expect(compareDomains(linux({ pidNamespace: 'n2' }), linux())).toBe('other');
    expect(compareDomains(linux({ pidNamespaceInit: 'i2' }), linux())).toBe('other');
    expect(compareDomains(darwin('u2'), darwin('u'))).toBe('other');
  });

  it('always applies the PID rules on Windows, even across boot times [N1]', () => {
    const windows = (bootTime: string | null, machineId: string | null): ProcessDomain => ({
      platform: 'win32',
      machineId,
      bootTime
    });
    expect(compareDomains(windows('2026-10-01', 'a'), windows('2026-10-05', 'b'))).toBe('pid_rules');
    expect(compareDomains(windows(null, null), windows('2026-10-05', 'b'))).toBe('pid_rules');
  });

  it('is unverified when a deciding part is unreadable and no boot part differs [W] [N3]', () => {
    expect(compareDomains(linux({ pidNamespace: null }), linux())).toBe('unverified');
    expect(compareDomains(linux(), linux({ bootId: null }))).toBe('unverified');
    expect(compareDomains(darwin(null), darwin('u'))).toBe('unverified');
    expect(compareDomains(linux({ pidNamespace: null, bootId: 'b2' }), linux())).toBe('other');
  });

  it('is another domain across platforms', () => {
    expect(compareDomains(darwin('u'), linux())).toBe('other');
  });
});

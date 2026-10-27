/**
 * The wrapper's session platform: the control-helper registry, the bounded
 * session identity reads behind `createNodeSessionPlatform`, and the launch
 * anchor check in `verifySessionLeadership`. Every read either answers or
 * reports `unknown`; only confirmed absence is `null`, and a helper whose exit
 * is unproven stays protected from cleanup.
 * @summary Session platform, helper registry and leadership checks
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createControlHelperRegistry,
  createNodeSessionPlatform,
  DEFAULT_SESSION_PROBE_TIMEOUT_MS,
  runIdentityProbe,
  type SessionExecFile,
  type SessionPlatform,
  verifySessionLeadership,
  type WrapperProcessIdentity
} from '../src/process-identity.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(original.readFile), readdir: vi.fn(original.readdir) };
});

const LINUX = process.platform === 'linux';
const PROBE_MS = 40;
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.mocked(readFile).mockReset();
  vi.mocked(readdir).mockReset();
  // Only children this file spawned, signalled through their own handles.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

/**
 * Spawns a long-lived Node child owned by this test file.
 * @param detached - Whether the child leads its own session.
 * @returns The child, once it has a PID.
 */
async function spawnSleeper(detached = false): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached });
  children.push(child);
  await once(child, 'spawn');
  if (child.pid === undefined) throw new Error('child had no pid');
  return child as ChildProcess & { pid: number };
}

/**
 * Spawns a child and waits for it to exit and be reaped.
 * @returns The PID the child had.
 */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  if (child.pid === undefined) throw new Error('child had no pid');
  return child.pid;
}

/**
 * A helper that accepted the work and will never report back.
 * @returns The exec seam and the spy standing in for killing what it started.
 */
function wedged(): { exec: SessionExecFile; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn(() => true);
  return { exec: () => ({ kill }), kill };
}

/**
 * An exec seam that answers once with fixed output.
 * @param stdout - What the helper printed.
 * @param error - The failure it reported, if any.
 * @param pid - The helper's PID.
 * @returns The seam.
 */
function answers(stdout: string, error: Error | null = null, pid = 9001): SessionExecFile {
  return (_command, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout, ''));
    return { pid, kill: () => true };
  };
}

/**
 * A `/proc/<pid>/stat` line with the given fields after `comm`.
 * @param comm - The command name, which may contain spaces and parentheses.
 * @param fields - State, parent, group and session.
 * @param fields.state - Kernel state letter.
 * @param fields.ppid - Parent PID.
 * @param fields.pgid - Process group.
 * @param fields.sid - Session leader PID.
 * @param fields.start - Start time in clock ticks.
 * @param pid - The PID the line describes.
 * @returns The line as the kernel would print it, with starttime as the 20th field after comm.
 */
function statLine(
  comm: string,
  fields: { state: string; ppid: number; pgid: number; sid: number; start: string },
  pid = 4200
): string {
  // Fields 3–7 then tty..vsize: starttime is the 20th field after comm.
  const rest = [fields.state, fields.ppid, fields.pgid, fields.sid, 0, -1, 4194560];
  while (rest.length < 19) rest.push(0);
  rest.push(fields.start);
  return `${pid} (${comm}) ${rest.join(' ')} 0 0\n`;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('createControlHelperRegistry', () => {
  it('always lists and protects the wrapper itself', () => {
    const helpers = createControlHelperRegistry(4100);
    expect(helpers.pids).toEqual([4100]);
    expect(helpers.has(4100)).toBe(true);
    helpers.release(4100);
    expect(helpers.has(4100)).toBe(true);
    expect(helpers.pids).toEqual([4100]);
  });

  it('protects a registered helper until it is released', () => {
    const helpers = createControlHelperRegistry(4100);
    helpers.register(9001);
    helpers.register(9002);
    expect(helpers.pids).toEqual([4100, 9001, 9002]);
    expect(helpers.has(9001)).toBe(true);
    helpers.release(9001);
    expect(helpers.has(9001)).toBe(false);
    expect(helpers.pids).toEqual([4100, 9002]);
  });

  it('lists a helper registered twice once', () => {
    const helpers = createControlHelperRegistry(4100);
    helpers.register(9001);
    helpers.register(9001);
    expect(helpers.pids).toEqual([4100, 9001]);
  });

  it.each([0, 1, -1, -4100, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('ignores the unsafe PID %s', (pid) => {
    const helpers = createControlHelperRegistry(4100);
    helpers.register(pid);
    expect(helpers.pids).toEqual([4100]);
    expect(helpers.has(pid)).toBe(false);
  });
});

describe('the session identity probe ceiling', () => {
  it.each(['identify', 'enumerate'] as const)('answers unknown when a darwin %s helper never returns', async (op) => {
    const platform = createNodeSessionPlatform({
      platform: 'darwin',
      execFile: wedged().exec,
      probeTimeoutMs: PROBE_MS
    });
    const startedAt = Date.now();
    expect(await (op === 'identify' ? platform.identify(4200) : platform.enumerate())).toBe('unknown');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('requests a literal forced stop for a helper that missed its deadline', async () => {
    const helper = wedged();
    await createNodeSessionPlatform({
      platform: 'darwin',
      execFile: helper.exec,
      probeTimeoutMs: PROBE_MS
    }).enumerate();
    await vi.waitFor(() => expect(helper.kill).toHaveBeenCalledWith('SIGKILL'));
  });

  it('asks the helper boundary to bound itself, in the C locale and UTC', async () => {
    let seen: Parameters<SessionExecFile>[2] | null = null;
    const exec: SessionExecFile = (_command, _args, options) => {
      seen = options;
      return undefined;
    };
    await createNodeSessionPlatform({ platform: 'darwin', execFile: exec, probeTimeoutMs: PROBE_MS }).enumerate();
    expect(seen).toMatchObject({ timeout: PROBE_MS, killSignal: 'SIGKILL', env: { LC_ALL: 'C', TZ: 'UTC' } });
  });

  it('bounds a probe nobody configured', async () => {
    let timeout = -1;
    const exec: SessionExecFile = (_command, _args, options, callback) => {
      timeout = options.timeout;
      callback(new Error('no such process'), '');
      return undefined;
    };
    await createNodeSessionPlatform({ platform: 'darwin', execFile: exec }).identify(4200);
    expect(timeout).toBe(DEFAULT_SESSION_PROBE_TIMEOUT_MS);
  });

  it('narrows the ceiling to a shorter per-call budget but never widens it', async () => {
    const timeouts: number[] = [];
    let exited: Promise<unknown> = Promise.resolve();
    const exec: SessionExecFile = (_command, _args, options, callback) => {
      timeouts.push(options.timeout);
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      children.push(child);
      exited = once(child, 'exit');
      callback(null, '');
      return child;
    };
    const platform = createNodeSessionPlatform({ platform: 'darwin', execFile: exec, probeTimeoutMs: 500 });
    await platform.enumerate(PROBE_MS);
    await exited;
    await platform.enumerate(10_000);
    await exited;
    expect(timeouts).toEqual([PROBE_MS, 500]);
  });

  it('answers unknown at once for a non-positive ceiling', async () => {
    const helper = wedged();
    expect(await runIdentityProbe(helper.exec, 'ps', [], 0)).toEqual({ stdout: '', failed: true });
  });
});

describe('darwin ps observations', () => {
  it('parses an answered roster, keeping the spaced lstart as the start identity', async () => {
    const platform = createNodeSessionPlatform({
      platform: 'darwin',
      execFile: answers('4200 4100 4100 0xabc S Mon Jan  5 10:00:00 2026\n')
    });
    expect(await platform.enumerate()).toEqual([
      {
        pid: 4200,
        parentPid: 4100,
        processGroupId: 4100,
        sessionToken: 'darwin:0xabc',
        state: 'S',
        startIdentity: 'Mon Jan 5 10:00:00 2026'
      }
    ]);
  });

  it('does not treat a partially malformed roster as a complete snapshot', async () => {
    const platform = createNodeSessionPlatform({
      platform: 'darwin',
      execFile: answers('4200 4100 4100 0xabc S Mon Jan  5 10:00:00 2026\nMALFORMED\n')
    });
    expect(await platform.enumerate()).toBe('unknown');
  });

  it('does not treat an empty roster as a snapshot of nothing', async () => {
    expect(await createNodeSessionPlatform({ platform: 'darwin', execFile: answers('') }).enumerate()).toBe('unknown');
  });

  it('excludes the enumeration helper from its own snapshot', async () => {
    const platform = createNodeSessionPlatform({
      platform: 'darwin',
      execFile: answers(
        '4100 1 4100 0xabc S Mon Jan  5 10:00:00 2026\n4200 4100 4100 0xabc S Mon Jan  5 10:00:00 2026\n',
        null,
        4200
      )
    });
    expect(await platform.enumerate()).toEqual([expect.objectContaining({ pid: 4100 })]);
  });

  it('reads an identity row and answers unknown for a malformed one', async () => {
    const row = '4200 4100 4100 0xabc S Mon Jan  5 10:00:00 2026\n';
    expect(
      await createNodeSessionPlatform({ platform: 'darwin', execFile: answers(row) }).identify(4200)
    ).toMatchObject({ pid: 4200, sessionToken: 'darwin:0xabc' });
    expect(
      await createNodeSessionPlatform({ platform: 'darwin', execFile: answers('4200 4100\n') }).identify(4200)
    ).toBe('unknown');
  });

  /**
   * A `ps -p` that exited 1 with the given output, as Apple's `ps` does for a missing PID.
   * @param stdout - What it printed.
   * @param stderr - What it printed to stderr.
   * @returns The seam.
   */
  function exitOne(stdout: string, stderr: string): SessionExecFile {
    return (_command, _args, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error('exit 1'), { code: 1 }), stdout, stderr));
      return { pid: 9001, kill: () => true };
    };
  }

  it('confirms absence only when ps exits 1 silently and a fresh probe agrees', async () => {
    // The fresh probe is signal 0 against a PID this file spawned and reaped.
    const gone = await exitedPid();
    expect(
      await createNodeSessionPlatform({ platform: 'darwin', execFile: exitOne('', '') }).identify(gone)
    ).toBeNull();
  });

  it('keeps an exit-1 ps unknown while the PID is still live', async () => {
    expect(
      await createNodeSessionPlatform({ platform: 'darwin', execFile: exitOne('', '') }).identify(process.pid)
    ).toBe('unknown');
  });

  it('keeps an exit-1 ps that printed a diagnostic unknown', async () => {
    const gone = await exitedPid();
    expect(
      await createNodeSessionPlatform({ platform: 'darwin', execFile: exitOne('', 'ps: illegal option') }).identify(
        gone
      )
    ).toBe('unknown');
  });
});

describe('identity helper lifetime protection', () => {
  it('registers a helper while it runs and releases it on a clean exit', async () => {
    const helpers = createControlHelperRegistry(4100);
    let complete: ((error: Error | null, stdout: string) => void) | undefined;
    const probe = runIdentityProbe(
      (_command, _args, _options, callback) => {
        complete = callback;
        return { pid: 9001, kill: () => true };
      },
      'ps',
      [],
      1_000,
      helpers
    );
    expect(helpers.has(9001)).toBe(true);
    complete?.(null, 'rows');
    await expect(probe).resolves.toEqual({ stdout: 'rows', failed: false, exitCode: 0, helperPid: 9001 });
    expect(helpers.has(9001)).toBe(false);
  });

  it('retains a helper whose error supplies no confirmed completion', async () => {
    const helpers = createControlHelperRegistry(4100);
    await expect(
      runIdentityProbe(
        (_command, _args, _options, callback) => {
          callback(new Error('helper state unreadable'), '');
          return { pid: 9001, kill: () => true };
        },
        'ps',
        [],
        PROBE_MS,
        helpers
      )
    ).resolves.toMatchObject({ failed: true, helperPid: 9001 });
    expect(helpers.has(9001)).toBe(true);
  });

  it('retains a timed-out helper until a later completion callback', async () => {
    const helpers = createControlHelperRegistry(4100);
    let complete: ((error: Error | null, stdout: string) => void) | undefined;
    const kill = vi.fn(() => true);
    const probe = runIdentityProbe(
      (_command, _args, _options, callback) => {
        complete = callback;
        return { pid: 9001, kill };
      },
      'ps',
      [],
      PROBE_MS,
      helpers
    );
    await expect(probe).resolves.toMatchObject({ failed: true, helperPid: 9001 });
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(helpers.has(9001)).toBe(true);
    complete?.(null, '');
    await Promise.resolve();
    expect(helpers.has(9001)).toBe(false);
  });

  it('answers failed when the exec boundary throws', async () => {
    const exec: SessionExecFile = () => {
      throw new Error('spawn EACCES');
    };
    expect(await runIdentityProbe(exec, 'ps', [], PROBE_MS)).toEqual({ stdout: '', failed: true });
  });

  it.skipIf(process.platform === 'win32')(
    'protects a real production helper during its life and releases it only after exit',
    async () => {
      const fixture = await mkdtemp(path.join(tmpdir(), 'sdk-identity-helper-'));
      const originalPath = process.env['PATH'];
      const helpers = createControlHelperRegistry(process.pid);
      const registered = vi.spyOn(helpers, 'register');
      let probe: Promise<unknown> | undefined;
      try {
        const executable = path.join(fixture, 'ps');
        await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
        await chmod(executable, 0o755);
        process.env['PATH'] = `${fixture}${path.delimiter}${originalPath ?? ''}`;
        probe = createNodeSessionPlatform({ platform: 'darwin', helpers, probeTimeoutMs: 100 }).enumerate();
        await vi.waitFor(() => expect(registered).toHaveBeenCalled());
        const helperPid = registered.mock.calls[0]?.[0];
        if (helperPid === undefined) throw new Error('Probe helper was not registered');
        expect(helperPid).toBeGreaterThan(1);
        expect(helpers.has(helperPid)).toBe(true);
        await expect(probe).resolves.toBe('unknown');
        await vi.waitFor(() => expect(helpers.has(helperPid)).toBe(false), { timeout: 2_000 });
      } finally {
        if (originalPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = originalPath;
        await probe;
        await rm(fixture, { recursive: true, force: true });
      }
    }
  );
});

describe('Windows CIM process observations', () => {
  const tick = '638957412345678901';
  const row = { pid: 4200, parentPid: 4100, startIdentity: tick };

  function output(stdout: string, error: Error | null = null): SessionExecFile {
    return (command, args, options, callback) => {
      expect(command).toBe('powershell.exe');
      expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
      expect(args.at(-1)).toContain('Get-CimInstance Win32_Process');
      expect(args.at(-1)).toContain("$ErrorActionPreference = 'Stop'");
      expect(args.at(-1)).toContain('CreationDate.ToUniversalTime().Ticks.ToString()');
      expect(options.killSignal).toBe('SIGKILL');
      queueMicrotask(() => callback(error, stdout));
      return { pid: 9001, kill: () => true };
    };
  }

  it('filters the identity query to the requested PID', async () => {
    let script = '';
    const exec: SessionExecFile = (_command, args, _options, callback) => {
      script = args.at(-1) ?? '';
      queueMicrotask(() => callback(null, ''));
      return undefined;
    };
    await createNodeSessionPlatform({ platform: 'win32', execFile: exec }).identify(4200);
    expect(script).toContain('-Filter "ProcessId=4200"');
  });

  it.each([JSON.stringify(row), JSON.stringify([row])])('parses a CIM row shape %s', async (stdout) => {
    expect(await createNodeSessionPlatform({ platform: 'win32', execFile: output(stdout) }).identify(4200)).toEqual({
      ...row,
      processGroupId: 0,
      sessionToken: 'windows:process-observation'
    });
  });

  it('excludes its CIM helper and keeps exact creation ticks', async () => {
    const helpers = createControlHelperRegistry(4100);
    const platform = createNodeSessionPlatform({
      platform: 'win32',
      helpers,
      execFile: output(JSON.stringify([row, { ...row, pid: 9001 }]))
    });
    expect(await platform.enumerate()).toEqual([expect.objectContaining({ pid: 4200, startIdentity: tick })]);
    expect(helpers.has(9001)).toBe(false);
  });

  it('skips pseudo-process rows before judging their creation time', async () => {
    const platform = createNodeSessionPlatform({
      platform: 'win32',
      execFile: output(JSON.stringify([{ pid: 0, parentPid: 0, startIdentity: null }, row]))
    });
    expect(await platform.enumerate()).toEqual([expect.objectContaining({ pid: 4200 })]);
  });

  it.each(['', '[]'])('reports confirmed absence from an empty successful query %s', async (stdout) => {
    expect(await createNodeSessionPlatform({ platform: 'win32', execFile: output(stdout) }).identify(4200)).toBeNull();
  });

  it.each([
    'unreadable',
    'null',
    JSON.stringify({ ...row, pid: '4200' }),
    JSON.stringify({ ...row, parentPid: -1 }),
    JSON.stringify({ ...row, startIdentity: '0' }),
    JSON.stringify({ ...row, startIdentity: Number(tick) }),
    JSON.stringify([row, { pid: 4201, parentPid: 4100, startIdentity: null }])
  ])('does not turn malformed or incomplete output into absence: %s', async (stdout) => {
    const platform = createNodeSessionPlatform({ platform: 'win32', execFile: output(stdout) });
    expect(await platform.identify(4200)).toBe('unknown');
    expect(await platform.enumerate()).toBe('unknown');
  });

  it('reports unavailable PowerShell as unknown', async () => {
    const platform = createNodeSessionPlatform({ platform: 'win32', execFile: output('', new Error('ENOENT')) });
    expect(await platform.identify(4200)).toBe('unknown');
    expect(await platform.enumerate()).toBe('unknown');
  });
});

describe('Linux /proc observations', () => {
  const BOOT = '0f0e0d0c-0b0a-0908-0706-050403020100';

  /**
   * Answers the boot ID read, then the given stat reads in order.
   * @param stats - Each stat read's content or failure.
   */
  function procReads(...stats: (string | Error)[]): void {
    vi.mocked(readFile).mockResolvedValueOnce(`${BOOT}\n`);
    for (const stat of stats) {
      if (typeof stat === 'string') vi.mocked(readFile).mockResolvedValueOnce(stat);
      else vi.mocked(readFile).mockRejectedValueOnce(stat);
    }
  }

  it('parses a stat line whose command name holds spaces and parentheses', async () => {
    procReads(statLine('a (b) c', { state: 'S', ppid: 4100, pgid: 4150, sid: 4100, start: '987654' }));
    expect(await createNodeSessionPlatform({ platform: 'linux' }).identify(4200)).toEqual({
      pid: 4200,
      parentPid: 4100,
      processGroupId: 4150,
      state: 'S',
      startIdentity: `${BOOT}:987654`,
      sessionToken: `linux:${BOOT}:4100`,
      sessionLeaderPid: 4100
    });
  });

  it('answers unknown for a malformed stat line', async () => {
    procReads('4200 (truncated) S 4100\n');
    expect(await createNodeSessionPlatform({ platform: 'linux' }).identify(4200)).toBe('unknown');
  });

  it.each([
    ['ENOENT', null],
    ['ESRCH', null],
    ['EACCES', 'unknown'],
    ['EIO', 'unknown']
  ] as const)('reads a stat failure with %s as %s', async (code, expected) => {
    procReads(errno(code));
    expect(await createNodeSessionPlatform({ platform: 'linux' }).identify(4200)).toBe(expected);
  });

  it('answers unknown when the boot ID is unreadable', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(errno('EACCES'));
    expect(await createNodeSessionPlatform({ platform: 'linux' }).identify(4200)).toBe('unknown');
  });

  it('enumerates numeric entries, skipping processes that exited mid-scan', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['4200', 'self', '4300', 'sys'] as never);
    procReads(statLine('node', { state: 'S', ppid: 1, pgid: 4200, sid: 4200, start: '10' }), errno('ENOENT'));
    expect(await createNodeSessionPlatform({ platform: 'linux' }).enumerate()).toEqual([
      expect.objectContaining({ pid: 4200, sessionToken: `linux:${BOOT}:4200` })
    ]);
  });

  it('answers unknown for a scan with an unreadable process', async () => {
    vi.mocked(readdir).mockResolvedValueOnce(['4200', '4300'] as never);
    procReads(statLine('node', { state: 'S', ppid: 1, pgid: 4200, sid: 4200, start: '10' }), errno('EACCES'));
    expect(await createNodeSessionPlatform({ platform: 'linux' }).enumerate()).toBe('unknown');
  });

  it.each(['identify', 'enumerate'] as const)('bounds a stalled boot read for %s', async (op) => {
    vi.mocked(readFile).mockImplementationOnce(() => new Promise(() => undefined));
    const platform = createNodeSessionPlatform({ platform: 'linux' });
    const result = op === 'identify' ? platform.identify(4200, PROBE_MS) : platform.enumerate(PROBE_MS);
    const ceiling = new Promise((resolve) => setTimeout(() => resolve('deadline-missed'), 500));
    expect(await Promise.race([result, ceiling])).toBe('unknown');
  });

  it('bounds the scan when readdir never completes', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('boot');
    vi.mocked(readdir).mockImplementationOnce(() => new Promise(() => undefined));
    const result = createNodeSessionPlatform({ platform: 'linux' }).enumerate(PROBE_MS);
    const ceiling = new Promise((resolve) => setTimeout(() => resolve('deadline-missed'), 500));
    expect(await Promise.race([result, ceiling])).toBe('unknown');
  });

  it('shares one elapsed budget between the boot read and the directory scan', async () => {
    vi.mocked(readFile).mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve('boot'), 30)));
    vi.mocked(readdir).mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([]), 30)));
    const started = performance.now();
    expect(await createNodeSessionPlatform({ platform: 'linux' }).enumerate(PROBE_MS)).toBe('unknown');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([0, 1, -4200, 1.5])('answers absent for the unsafe PID %s without reading', async (pid) => {
    expect(await createNodeSessionPlatform({ platform: 'linux' }).identify(pid)).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it.runIf(LINUX)('reads this process and a reaped child from the real /proc', async () => {
    const platform = createNodeSessionPlatform();
    const self = await platform.identify(process.pid);
    expect(self).toMatchObject({ pid: process.pid, parentPid: process.ppid });
    if (self === null || self === 'unknown') throw new Error('own identity was unreadable');
    expect(self.startIdentity).toMatch(/^[0-9a-f-]+:\d+$/);
    expect(await platform.identify(await exitedPid())).toBeNull();
    const live = await platform.enumerate();
    if (live === 'unknown') throw new Error('real enumeration was unreadable');
    // State may change between reads; the start identity must not.
    expect(live).toContainEqual(expect.objectContaining({ pid: process.pid, startIdentity: self.startIdentity }));
  });
});

describe('verifySessionLeadership', () => {
  const self: WrapperProcessIdentity = {
    pid: 4100,
    parentPid: 1,
    startIdentity: 'boot:4100',
    processGroupId: 4100,
    sessionLeaderPid: 4100,
    sessionToken: 'owned-session'
  };

  /**
   * A platform answering fixed observations.
   * @param identity - What `identify` answers.
   * @param roster - What `enumerate` answers.
   * @returns The platform, with a spy on `enumerate`.
   */
  function observed(
    identity: WrapperProcessIdentity | null | 'unknown',
    roster: readonly WrapperProcessIdentity[] | 'unknown' = [identity as WrapperProcessIdentity]
  ): SessionPlatform & { enumerate: ReturnType<typeof vi.fn> } {
    return { identify: async () => identity, enumerate: vi.fn(async () => roster) };
  }

  it('verifies a Linux session leader alone in its session', async () => {
    expect(await verifySessionLeadership(observed(self), { pid: 4100, os: 'linux' })).toEqual({
      status: 'verified',
      identity: self
    });
  });

  it.each([null, 'unknown'] as const)('refuses at identify when the wrapper reads as %s', async (identity) => {
    expect(await verifySessionLeadership(observed(identity, []), { pid: 4100, os: 'linux' })).toMatchObject({
      status: 'refused',
      stage: 'identify'
    });
  });

  it.each([0, 1, -4100])('refuses the unsafe wrapper PID %s before reading anything', async (pid) => {
    const platform = observed(self);
    const identify = vi.spyOn(platform, 'identify');
    expect(await verifySessionLeadership(platform, { pid, os: 'linux' })).toMatchObject({
      status: 'refused',
      stage: 'identify'
    });
    expect(identify).not.toHaveBeenCalled();
  });

  it('refuses a Linux wrapper that does not lead its session', async () => {
    expect(
      await verifySessionLeadership(observed({ ...self, sessionLeaderPid: 4000 }), { pid: 4100, os: 'linux' })
    ).toMatchObject({ status: 'refused', stage: 'verify-session', reason: expect.stringContaining('leader 4000') });
  });

  it('judges macOS by process-group leadership, since it has no numeric session ID', async () => {
    const darwinSelf = { ...self, sessionLeaderPid: undefined };
    expect(await verifySessionLeadership(observed(darwinSelf), { pid: 4100, os: 'darwin' })).toMatchObject({
      status: 'verified'
    });
    expect(
      await verifySessionLeadership(observed({ ...darwinSelf, processGroupId: 4000 }), { pid: 4100, os: 'darwin' })
    ).toMatchObject({ status: 'refused', stage: 'verify-session' });
  });

  it('refuses a session another process already shares', async () => {
    const intruder = { ...self, pid: 4300, parentPid: 1 };
    expect(await verifySessionLeadership(observed(self, [self, intruder]), { pid: 4100, os: 'linux' })).toMatchObject({
      status: 'refused',
      stage: 'verify-session',
      reason: expect.stringContaining('process 4300')
    });
  });

  it('does not count a registered helper or another session as an intruder', async () => {
    const helpers = createControlHelperRegistry(4100);
    helpers.register(9001);
    const roster = [self, { ...self, pid: 9001 }, { ...self, pid: 4400, sessionToken: 'other-session' }];
    expect(await verifySessionLeadership(observed(self, roster), { pid: 4100, os: 'linux', helpers })).toMatchObject({
      status: 'verified'
    });
  });

  it('refuses when enumeration is unreadable', async () => {
    expect(await verifySessionLeadership(observed(self, 'unknown'), { pid: 4100, os: 'linux' })).toMatchObject({
      status: 'refused',
      stage: 'verify-session',
      reason: 'Live process enumeration failed'
    });
  });

  it('verifies a Windows wrapper by identity alone, without inventing a session', async () => {
    const windowsSelf = { ...self, processGroupId: 0, sessionToken: 'windows:process-observation' };
    const platform = observed(windowsSelf);
    expect(await verifySessionLeadership(platform, { pid: 4100, os: 'win32' })).toEqual({
      status: 'verified',
      identity: windowsSelf
    });
    expect(platform.enumerate).not.toHaveBeenCalled();
  });

  it.each(['identify', 'enumerate'] as const)('refuses a %s seam that never settles', async (operation) => {
    const started = performance.now();
    const result = await verifySessionLeadership(
      {
        identify: () => (operation === 'identify' ? new Promise(() => undefined) : Promise.resolve(self)),
        enumerate: () => new Promise(() => undefined)
      },
      { pid: 4100, os: 'linux' }
    );
    expect(result).toMatchObject({
      status: 'refused',
      stage: operation === 'identify' ? 'identify' : 'verify-session'
    });
    expect(performance.now() - started).toBeLessThan(DEFAULT_SESSION_PROBE_TIMEOUT_MS + 750);
  });

  it.runIf(LINUX)('verifies a real detached child and refuses a real attached one', async () => {
    const platform = createNodeSessionPlatform();
    const leader = await spawnSleeper(true);
    expect(await verifySessionLeadership(platform, { pid: leader.pid, os: 'linux' })).toMatchObject({
      status: 'verified',
      identity: { pid: leader.pid, sessionLeaderPid: leader.pid }
    });
    const attached = await spawnSleeper(false);
    expect(await verifySessionLeadership(platform, { pid: attached.pid, os: 'linux' })).toMatchObject({
      status: 'refused',
      stage: 'verify-session'
    });
  });
});

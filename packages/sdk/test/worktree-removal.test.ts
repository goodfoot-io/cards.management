/**
 * Slot-level removal against real git worktrees and real slot locks:
 * quarantine and verified removal with move-back only into an absent slot
 * path, residue recovery under the slot's `removal` lock, the occupant probe
 * on injected and real `/proc` and `lsof` results, and the fsmonitor stop.
 * @summary Slot quarantine, removal, residue recovery, occupant probe and fsmonitor stop
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitBoundedResult } from '../src/bounded-git.js';
import { ShutdownError } from '../src/config/runtime-shutdown.js';
import { type BoundedCommandResult, runBoundedCommand } from '../src/process-identity.js';
import { acquireSlotLock, type SlotLock, withSlotLock } from '../src/slot-lock.js';
import {
  describeSlotOccupancy,
  findSlotOccupants,
  findSlotResidue,
  OccupantProbeError,
  type ProcReader,
  processesNotInspected,
  quarantinePathFor,
  quarantineSlot,
  recoverSlotResidue,
  recoverSlotResidueLocked,
  removeQuarantinedCheckout,
  removeQuarantinedSlot,
  requireCurrentSlotLock,
  type SlotGitError,
  type SlotRemovalGit,
  type SlotResidueLocker,
  slotOccupied,
  stopSlotFsmonitor
} from '../src/worktree-removal.js';
import { fakeWorld, lockEnvironment, ownerFile, writeGeneration } from './helpers/slot-lock-fixtures.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };

/**
 * Runs git synchronously for fixture setup and inspection.
 * @param cwd - Working directory.
 * @param args - Git arguments.
 * @returns Trimmed standard output.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

/**
 * Lists the checkout paths git records for a repository.
 * @param repo - The main repository.
 * @returns Real paths of every registered worktree, the main one included.
 */
function worktreePaths(repo: string): string[] {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * A git runner answering every call with one canned result, recording the arguments.
 * @param result - What each call returns.
 * @returns The runner and the arguments it saw.
 */
function cannedGit(result: Partial<GitBoundedResult>): { git: SlotRemovalGit; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    git: {
      run: async (_cwd, args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          stopReport: { survivors: [], complete: true },
          ...result
        };
      }
    }
  };
}

/**
 * Builds an errno-shaped error.
 * @param code - Errno code such as `EACCES`.
 * @returns An error carrying that code, as `node:fs` throws.
 */
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('slot removal', () => {
  let base: string;
  let repo: string;
  let slotRoot: string;
  let slotPath: string;
  let children: ChildProcess[];

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'cards-slot-removal-')));
    repo = join(base, 'repo');
    slotRoot = join(base, 'slots');
    slotPath = join(slotRoot, '1');
    children = [];
    await mkdir(repo);
    await mkdir(slotRoot);
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'tracked.txt'), 'tracked\n');
    git(repo, 'add', 'tracked.txt');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial');
    git(repo, 'worktree', 'add', '-q', '-b', 'slot-1', slotPath);
  });

  afterEach(async () => {
    for (const child of children) {
      const pgid = child.pid;
      if (pgid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
      // Only the detached group this test spawned and recorded.
      expect(pgid).toBeGreaterThan(1);
      process.kill(-pgid, 'SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(base, { recursive: true, force: true });
  });

  /**
   * Takes the slot's `removal` lock in an isolated lock environment.
   * @param ordinal - Slot ordinal.
   * @returns The held lock and its environment.
   */
  async function removalLock(ordinal = 1): Promise<{ lock: SlotLock; env: ReturnType<typeof lockEnvironment> }> {
    const env = lockEnvironment(fakeWorld());
    const result = await acquireSlotLock(slotRoot, ordinal, {
      executionId: 'exec-removal',
      cardId: 'main-1',
      purpose: 'removal',
      environment: env.environment
    });
    if (result.status !== 'acquired') throw new Error(`lock not acquired: ${result.status}`);
    return { lock: result.lock, env };
  }

  /**
   * Binds `withSlotLock` to the slot root in an isolated lock environment.
   * @param env - The lock environment.
   * @returns The locker residue recovery takes.
   */
  function locker(env: ReturnType<typeof lockEnvironment>): SlotResidueLocker {
    return (ordinal, purpose, fn) =>
      withSlotLock(
        slotRoot,
        ordinal,
        purpose,
        { executionId: 'exec-recovery', cardId: 'main-1', environment: env.environment },
        fn
      );
  }

  /** A checkpoint that never returns, freezing removal as a crash would. */
  const frozen = (): Promise<void> => new Promise<void>(() => undefined);

  /**
   * Waits until a frozen removal has reached its checkpoint.
   * @param reached - Flag set by the checkpoint.
   */
  async function until(reached: () => boolean): Promise<void> {
    while (!reached()) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  describe('quarantine and removal', () => {
    it('names a fresh sibling quarantine per call', () => {
      const first = quarantinePathFor(slotPath);
      expect(first).toMatch(new RegExp(`^${slotPath.replaceAll('.', '\\.')}\\.deleting-${UUID}$`));
      expect(quarantinePathFor(slotPath)).not.toBe(first);
    });

    it('moves the checkout to its quarantine through git', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      expect(existsSync(slotPath)).toBe(false);
      expect(await readFile(join(quarantine, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(worktreePaths(repo)).toContain(quarantine);
    });

    it('passes core.fsmonitor=false to every git call', async () => {
      const { git: runner, calls } = cannedGit({});
      await quarantineSlot(repo, slotPath, { git: runner });
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
    });

    it('reports a refused move as a slot git error', async () => {
      await expect(quarantineSlot(repo, join(slotRoot, '9'))).rejects.toMatchObject({
        name: 'SlotGitError'
      } satisfies Partial<SlotGitError>);
    });

    it('removes a clean quarantined checkout and drops git’s record of it', async () => {
      const { lock } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      await expect(removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock })).resolves.toEqual({
        status: 'removed',
        processesNotInspected: expect.any(Number)
      });
      expect(existsSync(quarantine)).toBe(false);
      expect(existsSync(`${quarantine}.held`)).toBe(false);
      expect(worktreePaths(repo)).not.toContain(quarantine);
      expect((await readdir(slotRoot)).filter((name) => name !== '.locks')).toEqual([]);
    });

    it('refuses an untracked file and moves the checkout back to its absent slot path', async () => {
      const { lock } = await removalLock();
      await writeFile(join(slotPath, 'untracked.txt'), 'work in progress\n');
      const quarantine = await quarantineSlot(repo, slotPath);
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock });
      expect(outcome).toMatchObject({ status: 'refused', reason: 'uncommitted_changes', checkoutPath: slotPath });
      expect(await readFile(join(slotPath, 'untracked.txt'), 'utf8')).toBe('work in progress\n');
      expect(existsSync(quarantine)).toBe(false);
      expect(worktreePaths(repo)).toContain(slotPath);
    });

    it.runIf(process.platform === 'linux')(
      'refuses as in use when a real process entered the slot after the caller probed it, and moves it back',
      async () => {
        const { lock } = await removalLock();
        // The caller's own probe found the slot empty; a process enters before the quarantine move.
        expect(slotOccupied(await findSlotOccupants(slotPath))).toBe(false);
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: join(slotPath),
          detached: true,
          stdio: 'ignore'
        });
        children.push(child);
        await new Promise((resolve) => child.once('spawn', resolve));
        const quarantine = await quarantineSlot(repo, slotPath);
        const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock });
        expect(outcome).toMatchObject({ status: 'refused', reason: 'in_use', checkoutPath: slotPath });
        expect(outcome.status === 'refused' && outcome.detail).toContain(`(pid ${String(child.pid)})`);
        expect(await readFile(join(slotPath, 'tracked.txt'), 'utf8')).toBe('tracked\n');
        expect(worktreePaths(repo)).toContain(slotPath);
      }
    );

    it('removes the quarantine past its own uninspectable process, and counts it', async () => {
      const { lock } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      const hidden: ProcReader = {
        readdir: async (path) => {
          if (path === '/proc') return ['77'];
          throw errno('EACCES');
        },
        readlink: async () => {
          throw errno('EACCES');
        },
        readFile: async (path) => (path.endsWith('status') ? 'Uid:\t1000\t1000\t1000\t1000\n' : 'sudo\n')
      };
      const outcome = await removeQuarantinedSlot(
        { repoRoot: repo, slotPath, quarantine, lock },
        { occupants: { platform: 'linux', uid: 1000, proc: hidden } }
      );
      expect(outcome).toEqual({ status: 'removed', processesNotInspected: 1 });
      expect(existsSync(quarantine)).toBe(false);
    });

    it('counts the processes it could not inspect in a refusal too', async () => {
      const { lock } = await removalLock();
      await writeFile(join(slotPath, 'untracked.txt'), 'work in progress\n');
      const quarantine = await quarantineSlot(repo, slotPath);
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock });
      // The content check refuses before the probe runs.
      expect(outcome).toMatchObject({ status: 'refused', reason: 'uncommitted_changes', processesNotInspected: 0 });
    });

    it('removes the quarantine when only other users’ processes were hidden', async () => {
      const { lock } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      const others: ProcReader = {
        readdir: async (path) => {
          if (path === '/proc') return ['78'];
          throw errno('EACCES');
        },
        readlink: async () => {
          throw errno('EACCES');
        },
        readFile: async (path) => (path.endsWith('status') ? 'Uid:\t0\t0\t0\t0\n' : 'tailscaled\n')
      };
      await expect(
        removeQuarantinedSlot(
          { repoRoot: repo, slotPath, quarantine, lock },
          { occupants: { platform: 'linux', uid: 1000, proc: others } }
        )
      ).resolves.toEqual({ status: 'removed', processesNotInspected: 1 });
    });

    it('never nests the checkout into a recreated slot path, leaving it at the quarantine', async () => {
      const { lock } = await removalLock();
      await writeFile(join(slotPath, 'untracked.txt'), 'work in progress\n');
      const quarantine = await quarantineSlot(repo, slotPath);
      await mkdir(slotPath);
      await writeFile(join(slotPath, 'newcomer.txt'), 'new\n');
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock });
      expect(outcome).toMatchObject({ status: 'refused', reason: 'removal_restored', checkoutPath: quarantine });
      expect(await readdir(slotPath)).toEqual(['newcomer.txt']);
      expect(await readFile(join(quarantine, 'untracked.txt'), 'utf8')).toBe('work in progress\n');
      expect(worktreePaths(repo)).toContain(quarantine);
    });

    it('stops between entries once the fence closes and leaves the restored quarantine for recovery', async () => {
      const { lock, env } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      const removal = removeQuarantinedSlot(
        { repoRoot: repo, slotPath, quarantine, lock },
        {
          checkpoint: async (entry) => {
            if (entry === join(quarantine, 'tracked.txt')) void env.shutdown.shutdownAndExit(0, 'completed');
          }
        }
      );
      await expect(removal).rejects.toThrow(ShutdownError);
      expect(await readFile(join(quarantine, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(existsSync(`${quarantine}.held`)).toBe(false);
      expect(existsSync(slotPath)).toBe(false);
    });

    it('treats a lock that is no longer the maximum generation as lost', async () => {
      const { lock } = await removalLock();
      await expect(requireCurrentSlotLock(lock)).resolves.toBeUndefined();
      writeGeneration(slotRoot, 1, lock.generation + 1, { owner: ownerFile() });
      await expect(requireCurrentSlotLock(lock)).rejects.toThrow(/generation/);
    });

    it('treats a released lock as lost', async () => {
      const { lock } = await removalLock();
      await lock.release();
      await expect(requireCurrentSlotLock(lock)).rejects.toThrow(/released/);
    });

    it('treats a closed fence as a shutdown', async () => {
      const { lock, env } = await removalLock();
      void env.shutdown.shutdownAndExit(0, 'completed');
      await expect(requireCurrentSlotLock(lock)).rejects.toThrow(ShutdownError);
    });
  });

  describe('residue', () => {
    it('lists quarantines and holding areas per ordinal, ignoring other entries', async () => {
      const first = `${join(slotRoot, '1')}.deleting-11111111-1111-4111-8111-111111111111`;
      const third = `${join(slotRoot, '3')}.deleting-33333333-3333-4333-8333-333333333333`;
      await mkdir(first);
      await mkdir(`${first}.held`);
      await mkdir(`${third}.held`);
      await mkdir(join(slotRoot, '2'));
      await mkdir(join(slotRoot, '4.deleting-not-a-uuid'));
      await expect(findSlotResidue(slotRoot)).resolves.toEqual([
        { ordinal: 1, slotPath: join(slotRoot, '1'), quarantines: [first], holdings: [`${first}.held`] },
        { ordinal: 3, slotPath: join(slotRoot, '3'), quarantines: [], holdings: [`${third}.held`] }
      ]);
    });

    it('finds no residue in a slot root without removal leftovers', async () => {
      await expect(findSlotResidue(slotRoot)).resolves.toEqual([]);
    });

    it('moves a lone quarantine back to its absent slot path', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'moved_back', quarantine, slotPath }
      ]);
      expect(await readFile(join(slotPath, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(worktreePaths(repo)).toContain(slotPath);
    });

    it('reports a lone quarantine stranded when the slot path exists', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      await mkdir(slotPath);
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'quarantine_stranded', quarantine, slotPath }
      ]);
      expect(existsSync(join(quarantine, 'tracked.txt'))).toBe(true);
      expect(await readdir(slotPath)).toEqual([]);
    });

    it('finishes a committed removal and prunes the vanished quarantine', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      let reached = false;
      void removeQuarantinedCheckout(
        { root: quarantine, holding: `${quarantine}.held`, restoreTo: slotPath },
        {
          prove: async () => undefined,
          requireCurrent: () => undefined,
          filesystem: {
            unlink: async () => {
              reached = true;
              await frozen();
            }
          }
        }
      );
      await until(() => reached);
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'removal_finished', quarantine },
        { kind: 'pruned', quarantine }
      ]);
      expect(existsSync(`${quarantine}.held`)).toBe(false);
      expect(worktreePaths(repo)).not.toContain(quarantine);
    });

    it('restores an interrupted removal and moves it back to its absent slot path', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      let reached = false;
      void removeQuarantinedCheckout(
        { root: quarantine, holding: `${quarantine}.held`, restoreTo: slotPath },
        {
          prove: async () => undefined,
          requireCurrent: () => undefined,
          checkpoint: async (entry) => {
            if (entry !== join(quarantine, '.git')) return;
            reached = true;
            await frozen();
          }
        }
      );
      await until(() => reached);
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'moved_back', quarantine, slotPath }
      ]);
      expect(await readFile(join(slotPath, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(git(slotPath, 'status', '--porcelain')).toBe('');
    });

    it('prunes git’s record of a quarantine that vanished without a holding area', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      await rm(quarantine, { recursive: true, force: true });
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'pruned', quarantine }
      ]);
      expect(worktreePaths(repo)).not.toContain(quarantine);
    });

    it('keeps a holding area it cannot account for and reports the failure', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      let reached = false;
      void removeQuarantinedCheckout(
        { root: quarantine, holding: `${quarantine}.held`, restoreTo: slotPath },
        {
          prove: async () => undefined,
          requireCurrent: () => undefined,
          checkpoint: async (entry) => {
            if (entry !== join(quarantine, '.git')) return;
            reached = true;
            await frozen();
          }
        }
      );
      await until(() => reached);
      await writeFile(join(`${quarantine}.held`, 'stray'), 'unknown\n');
      const { lock } = await removalLock();
      const reports = await recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock });
      expect(reports).toEqual([
        { kind: 'recovery_failed', holding: `${quarantine}.held`, detail: expect.stringMatching(/unrecorded stray/) }
      ]);
      expect(await readdir(`${quarantine}.held`)).toContain('manifest.json');
    });

    it('recovers a slot under a free lock and releases it', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      const env = lockEnvironment(fakeWorld());
      await expect(recoverSlotResidue(slotRoot, locker(env), { repoRoot: repo })).resolves.toEqual([
        { ordinal: 1, status: 'recovered', reports: [{ kind: 'moved_back', quarantine, slotPath }] }
      ]);
      const generations = await readdir(join(slotRoot, '.locks', '1'));
      expect(existsSync(join(slotRoot, '.locks', '1', generations.at(-1)!, 'released.json'))).toBe(true);
    });

    it('skips a slot whose lock is held and leaves its residue untouched', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      writeGeneration(slotRoot, 1, 1, { owner: ownerFile() });
      const world = fakeWorld();
      world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
      const recoveries = await recoverSlotResidue(slotRoot, locker(lockEnvironment(world)), { repoRoot: repo });
      expect(recoveries).toEqual([
        { ordinal: 1, status: 'skipped', lock: expect.objectContaining({ status: 'held' }) }
      ]);
      expect(existsSync(join(quarantine, 'tracked.txt'))).toBe(true);
      expect(existsSync(slotPath)).toBe(false);
    });
  });

  describe('occupants', () => {
    /** One fake `/proc/<pid>`: its links, owner, command, and which reads the kernel refuses. */
    interface FakeProcess {
      readonly cwd?: string;
      readonly root?: string;
      readonly fds?: string[];
      readonly comm?: string;
      /** Effective uid in `status`; the prober's 1000 by default. */
      readonly uid?: number;
      /** Errno for every link read; the process hides or exited. */
      readonly fail?: string;
      /** Errno for the `status` read. */
      readonly failStatus?: string;
      /** Scheduler state in `status`; `S` by default. */
      readonly state?: string;
    }

    /**
     * A `/proc` stand-in over fake processes.
     * @param processes - Processes by pid.
     * @returns The reader.
     */
    function proc(processes: Record<string, FakeProcess>): ProcReader {
      const entry = (path: string): { info: FakeProcess; rest: string[] } => {
        const [, , pid = '', ...rest] = path.split('/');
        const info = processes[pid];
        if (info === undefined) throw errno('ENOENT');
        return { info, rest };
      };
      return {
        readdir: async (path) => {
          if (path === '/proc') return ['self', 'meminfo', ...Object.keys(processes)];
          const { info } = entry(path);
          if (info.fail !== undefined) throw errno(info.fail);
          return (info.fds ?? []).map((_, index) => String(index));
        },
        readlink: async (path) => {
          const { info, rest } = entry(path);
          if (info.fail !== undefined) throw errno(info.fail);
          if (rest[0] === 'cwd') return info.cwd ?? '/';
          if (rest[0] === 'root') return info.root ?? '/';
          return info.fds?.[Number(rest[1])] ?? '/dev/null';
        },
        readFile: async (path) => {
          const { info, rest } = entry(path);
          if (rest[0] === 'status') {
            if (info.failStatus !== undefined) throw errno(info.failStatus);
            const uid = String(info.uid ?? 1000);
            return `Name:\t${info.comm ?? 'proc'}\nState:\t${info.state ?? 'S'} (sleeping)\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
          }
          return `${info.comm ?? 'proc'}\n`;
        }
      };
    }

    const linux = (processes: Record<string, FakeProcess>, uid = 1000) =>
      findSlotOccupants(slotPath, { platform: 'linux', uid, proc: proc(processes) });

    it('finds processes whose cwd, root or open file is inside the slot, and nothing beside it', async () => {
      await expect(
        linux({
          10: { cwd: join(slotPath, 'src'), comm: 'node' },
          11: { cwd: '/', fds: ['/dev/null', `${join(slotPath, 'tracked.txt')} (deleted)`], comm: 'vim' },
          12: { cwd: `${slotPath}-other`, fds: [`${slotPath}.deleting-x/file`], comm: 'bash' },
          13: { cwd: slotPath, comm: 'git' },
          14: { root: slotPath, comm: 'chrooted' }
        })
      ).resolves.toEqual({
        occupants: [
          { pid: 10, command: 'node' },
          { pid: 11, command: 'vim' },
          { pid: 13, command: 'git' },
          { pid: 14, command: 'chrooted' }
        ],
        uninspectable: [],
        otherUsers: 0
      });
    });

    it('counts hidden processes of other users without blocking, and skips exited ones', async () => {
      const probe = await linux({
        20: { fail: 'EACCES', uid: 0, comm: 'tailscaled' },
        21: { fail: 'EPERM', uid: 1001 },
        22: { fail: 'ESRCH' },
        23: { fail: 'ENOENT' },
        24: { fail: 'EACCES', failStatus: 'ENOENT' }
      });
      expect(probe).toEqual({ occupants: [], uninspectable: [], otherUsers: 2 });
      expect(slotOccupied(probe)).toBe(false);
    });

    it.each([
      ['a hidden process of its own user', { fail: 'EACCES', comm: 'sudo-child' }],
      ['an own process hiding only its descriptors', { fail: 'EPERM', comm: 'sudo-child' }],
      [
        'a hidden process whose owner cannot be read',
        { fail: 'EACCES', uid: 0, failStatus: 'EACCES', comm: 'sudo-child' }
      ]
    ])('counts %s without blocking', async (_case, process) => {
      const probe = await linux({ 30: process });
      expect(probe).toEqual({ occupants: [], uninspectable: [{ pid: 30, command: 'sudo-child' }], otherUsers: 0 });
      expect(slotOccupied(probe)).toBe(false);
      expect(processesNotInspected(probe)).toBe(1);
    });

    it.each([
      'Z',
      'X'
    ])('skips a hidden process in state %s, which is exiting rather than uninspectable', async (state) => {
      const probe = await linux({ 32: { fail: 'EACCES', state }, 33: { fail: 'EACCES', uid: 0, state } });
      expect(probe).toEqual({ occupants: [], uninspectable: [], otherUsers: 0 });
    });

    it('blocks only on proven occupants, and names only them', async () => {
      const probe = await linux({
        34: { cwd: slotPath, comm: 'node' },
        35: { fail: 'EACCES', comm: 'ssh-agent' },
        36: { fail: 'EACCES', uid: 0 }
      });
      expect(slotOccupied(probe)).toBe(true);
      expect(processesNotInspected(probe)).toBe(2);
      expect(describeSlotOccupancy(probe)).toBe('in use by node (pid 34)');
    });

    it('treats every hidden process as its own when the prober is root', async () => {
      await expect(linux({ 31: { fail: 'EACCES', uid: 1000, comm: 'x' } }, 0)).resolves.toEqual({
        occupants: [],
        uninspectable: [{ pid: 31, command: 'x' }],
        otherUsers: 0
      });
    });

    it('throws on any other errno, or a status without an owner', async () => {
      await expect(linux({ 40: { fail: 'ENOTDIR' } })).rejects.toThrow(OccupantProbeError);
      await expect(linux({ 41: { fail: 'EACCES', failStatus: 'EIO' } })).rejects.toThrow(OccupantProbeError);
      await expect(
        findSlotOccupants(slotPath, {
          platform: 'linux',
          uid: 1000,
          proc: { ...proc({ 42: { fail: 'EACCES' } }), readFile: async () => 'Name:\tx\n' }
        })
      ).rejects.toThrow(/no Uid line/);
    });

    it('throws when /proc itself is unreadable', async () => {
      await expect(
        findSlotOccupants(slotPath, {
          platform: 'linux',
          proc: {
            readdir: async () => {
              throw errno('ENOENT');
            },
            readlink: async () => '/',
            readFile: async () => ''
          }
        })
      ).rejects.toThrow(OccupantProbeError);
    });

    it.runIf(process.platform === 'linux')(
      'finds no occupant of an empty slot among the host’s real processes',
      async () => {
        // Processes mid-exec read EACCES for a moment; they are counted, never occupants.
        const probe = await findSlotOccupants(slotPath);
        expect(probe.occupants).toEqual([]);
        expect(slotOccupied(probe)).toBe(false);
      }
    );

    it.runIf(process.platform === 'linux')('finds a real process whose cwd is inside the slot', async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: slotPath,
        detached: true,
        stdio: 'ignore'
      });
      children.push(child);
      await new Promise((resolve) => child.once('spawn', resolve));
      const probe = await findSlotOccupants(slotPath);
      expect(probe.occupants).toContainEqual({ pid: child.pid, command: expect.any(String) });
    });

    it.runIf(process.platform === 'linux')(
      'counts the host’s real processes of other users as other users when probing as a different uid',
      async () => {
        // The prober claims an unused uid, so every process the kernel hides is someone else's.
        const probe = await findSlotOccupants(slotPath, { uid: 54_321 });
        expect(probe.uninspectable).toEqual([]);
        expect(probe.otherUsers).toBeGreaterThanOrEqual(0);
      }
    );

    /**
     * `lsof` and `ps` stand-ins returning canned results and recording their argv.
     * @param lsofResult - Fields overriding a clean `lsof` exit with empty output.
     * @param psResult - Fields overriding a clean `ps` exit listing uids 1000, 0 and 1000.
     * @returns The runner and its calls.
     */
    function commands(
      lsofResult: Partial<BoundedCommandResult>,
      psResult: Partial<BoundedCommandResult> = {}
    ): {
      runCommand: NonNullable<Parameters<typeof findSlotOccupants>[1]>['runCommand'];
      calls: Array<{ file: string; args: readonly string[] }>;
    } {
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      return {
        calls,
        runCommand: async (file, args) => {
          calls.push({ file, args });
          const clean = { stdout: '', stderr: '', exitCode: 0, timedOut: false, outputComplete: true };
          return file === 'ps'
            ? { ...clean, stdout: ' 1000\n    0\n 1000\n  501\n', ...psResult }
            : { ...clean, ...lsofResult };
        }
      };
    }

    const darwin = (runCommand: ReturnType<typeof commands>['runCommand'], uid = 1000) =>
      findSlotOccupants(slotPath, { platform: 'darwin', uid, runCommand });

    it('parses lsof process records on macOS and counts the processes of other uids ps lists', async () => {
      const { runCommand, calls } = commands({ stdout: 'p123\ncnode\np456\ncgit\n' });
      await expect(darwin(runCommand)).resolves.toEqual({
        occupants: [
          { pid: 123, command: 'node' },
          { pid: 456, command: 'git' }
        ],
        uninspectable: [],
        otherUsers: 2
      });
      expect(calls).toEqual([
        { file: 'lsof', args: ['-n', '-P', '-w', '-F', 'pc', '+D', slotPath] },
        { file: 'ps', args: ['-ax', '-o', 'uid='] }
      ]);
    });

    it('skips ps as root, which lsof inspects fully', async () => {
      const { runCommand, calls } = commands({});
      await expect(darwin(runCommand, 0)).resolves.toEqual({ occupants: [], uninspectable: [], otherUsers: 0 });
      expect(calls.map(({ file }) => file)).toEqual(['lsof']);
    });

    it.runIf(process.platform !== 'win32')(
      'reads the real ps listing in the shape the macOS probe parses',
      async () => {
        const lsofLess: ReturnType<typeof commands>['runCommand'] = async (file, args, options) =>
          file === 'ps'
            ? runBoundedCommand(file, args, options)
            : { stdout: '', stderr: '', exitCode: 1, timedOut: false, outputComplete: true };
        const probe = await darwin(lsofLess, 54_321);
        expect(probe.otherUsers).toBeGreaterThan(0);
      }
    );

    it.each([
      ['empty', ''],
      ['warning-only', 'lsof: WARNING: can’t stat() fuse file system /run/user/1000/doc\n']
    ])('treats lsof exit 1 with %s output as no occupants', async (_kind, stderr) => {
      const { runCommand } = commands({ exitCode: 1, stderr });
      await expect(darwin(runCommand)).resolves.toEqual({ occupants: [], uninspectable: [], otherUsers: 2 });
    });

    it.each([
      ['exit 1 with a process record', { exitCode: 1, stdout: 'p123\ncnode\n' }],
      ['exit 2', { exitCode: 2, stderr: 'lsof: illegal option\n' }],
      ['a timeout', { exitCode: null, timedOut: true }],
      ['a missing binary', { exitCode: null, error: 'spawn lsof ENOENT' }],
      ['truncated output', { stdout: 'p123\ncnode\n', outputComplete: false }]
    ])('throws on lsof %s', async (_kind, result) => {
      await expect(darwin(commands(result).runCommand)).rejects.toThrow(OccupantProbeError);
    });

    it.each([
      ['a failed exit', { exitCode: 1, stderr: 'ps: bad option\n' }],
      ['a missing binary', { exitCode: null, error: 'spawn ps ENOENT' }],
      ['a timeout', { exitCode: null, timedOut: true }],
      ['truncated output', { outputComplete: false }],
      ['a non-numeric uid', { stdout: 'root\n' }]
    ])('throws on ps %s, since other users could then go uncounted', async (_kind, result) => {
      await expect(darwin(commands({}, result).runCommand)).rejects.toThrow(OccupantProbeError);
    });

    it('reports no occupants on Windows, where the OS refuses the removal itself', async () => {
      await expect(findSlotOccupants(slotPath, { platform: 'win32' })).resolves.toEqual({
        occupants: [],
        uninspectable: [],
        otherUsers: 0
      });
    });
  });

  describe('fsmonitor', () => {
    it('asks git to stop the daemon with fsmonitor disabled for the call itself', async () => {
      const { git: runner, calls } = cannedGit({});
      await stopSlotFsmonitor(slotPath, { git: runner });
      expect(calls).toEqual([['-c', 'core.fsmonitor=false', 'fsmonitor--daemon', 'stop']]);
    });

    it.each([
      'fsmonitor-daemon is not running',
      'fatal: fsmonitor--daemon not supported on this platform',
      "git: 'fsmonitor--daemon' is not a git command. See 'git --help'."
    ])('treats "%s" as stopped', async (stderr) => {
      const { git: runner } = cannedGit({ exitCode: 128, stderr });
      await expect(stopSlotFsmonitor(slotPath, { git: runner })).resolves.toBeUndefined();
    });

    it.each([
      ['another failure', { exitCode: 128, stderr: 'fatal: not a git repository' }],
      ['a timeout', { exitCode: null, timedOut: true }]
    ])('throws a slot git error on %s', async (_kind, result) => {
      const { git: runner } = cannedGit(result);
      await expect(stopSlotFsmonitor(slotPath, { git: runner })).rejects.toMatchObject({ name: 'SlotGitError' });
    });

    it.runIf(process.platform === 'linux')('succeeds against real git where the daemon is unsupported', async () => {
      await expect(stopSlotFsmonitor(slotPath)).resolves.toBeUndefined();
    });

    it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
      'stops a running daemon before the occupant probe',
      async () => {
        git(slotPath, 'fsmonitor--daemon', 'start');
        await stopSlotFsmonitor(slotPath);
        expect(() => git(slotPath, 'fsmonitor--daemon', 'status')).toThrow();
        await expect(findSlotOccupants(slotPath)).resolves.toMatchObject({ occupants: [] });
      }
    );
  });
});

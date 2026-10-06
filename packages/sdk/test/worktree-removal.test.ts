/**
 * Slot-level removal against real git worktrees and real slot locks:
 * quarantine and the committed move into `.purge` with move-back only into an
 * absent slot path, residue recovery under the slot's `removal` lock, the
 * occupant probe on injected and real `/proc` and `lsof` results, and the
 * fsmonitor stop. Submodule set-aside and the purge are in
 * `worktree-purge.test.ts`.
 * @summary Slot quarantine, removal, residue recovery, occupant probe and fsmonitor stop
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitBoundedResult } from '../src/bounded-git.js';
import { ShutdownError } from '../src/config/runtime-shutdown.js';
import { type BoundedCommandResult, runBoundedCommand } from '../src/process-identity.js';
import { acquireSlotLock, type SlotLock, withSlotLock } from '../src/slot-lock.js';
import {
  describeSlotOccupancy,
  findSlotOccupants,
  findSlotResidue,
  isSlotEntryName,
  OccupantProbeError,
  type ProcReader,
  processesNotInspected,
  quarantinePathFor,
  quarantineSlot,
  recoverSlotResidue,
  recoverSlotResidueLocked,
  removedCopyPathFor,
  removeQuarantinedSlot,
  requireCurrentSlotLock,
  type SlotGitError,
  type SlotRemovalGit,
  type SlotRemovalProofs,
  type SlotRemovalStep,
  type SlotResidueLocker,
  slotOccupied,
  slotRootHoldsSlotEntry,
  stopSlotFsmonitor
} from '../src/worktree-removal.js';
import { fakeWorld, lockEnvironment, ownerFile, writeGeneration } from './helpers/slot-lock-fixtures.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Admits every set-aside, as a caller with no submodule judgment of its own would. */
const PROOFS: SlotRemovalProofs = { proveSetAside: async () => null };
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
 * A git runner answering every call with a canned result, recording the arguments.
 * @param result - What each call returns, or a function of its arguments giving it.
 * @returns The runner and the arguments it saw.
 */
function cannedGit(result: Partial<GitBoundedResult> | ((args: readonly string[]) => Partial<GitBoundedResult>)): {
  git: SlotRemovalGit;
  calls: string[][];
} {
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
          ...(typeof result === 'function' ? result(args) : result)
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
      const { git: runner, calls } = cannedGit((args) =>
        args.includes('rev-parse') ? { stdout: join(base, 'no-git-dir') } : {}
      );
      await quarantineSlot(repo, slotPath, { git: runner });
      expect(calls.map((args) => args[2])).toEqual(['rev-parse', 'ls-files', 'worktree']);
      for (const args of calls) expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
    });

    it('reports a refused move as a slot git error and leaves the slot in place', async () => {
      git(repo, 'worktree', 'lock', slotPath);
      await expect(quarantineSlot(repo, slotPath)).rejects.toMatchObject({
        name: 'SlotGitError'
      } satisfies Partial<SlotGitError>);
      expect(await readFile(join(slotPath, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(await readdir(slotRoot)).toEqual(['1']);
    });

    it('commits a clean quarantined checkout to its copy under .purge and drops git’s record of it', async () => {
      const { lock } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      const copy = removedCopyPathFor(quarantine);
      expect(copy).toMatch(new RegExp(`^${join(slotRoot, '.purge', '1')}\\.${UUID}$`));
      await expect(removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS)).resolves.toEqual({
        status: 'removed',
        copy,
        processesNotInspected: expect.any(Number)
      });
      expect(existsSync(quarantine)).toBe(false);
      expect(worktreePaths(repo)).not.toContain(quarantine);
      expect((await readdir(slotRoot)).filter((name) => name !== '.locks')).toEqual(['.purge']);
      expect((await readdir(join(slotRoot, '.purge'))).sort()).toEqual([basename(copy), `${basename(copy)}.json`]);
      expect(await readdir(copy)).toEqual(['checkout']);
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
      // The branch stays; only the checkout went.
      expect(git(repo, 'branch', '--list', 'slot-1')).toContain('slot-1');
    });

    it('asks nothing of the caller about a slot that set no submodules aside', async () => {
      const { lock } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      let asked = false;
      const outcome = await removeQuarantinedSlot(
        { repoRoot: repo, slotPath, quarantine, lock },
        {
          proveSetAside: async () => {
            asked = true;
            return 'refused';
          }
        }
      );
      expect(outcome).toMatchObject({ status: 'removed' });
      expect(asked).toBe(false);
    });

    it('refuses an untracked file and moves the checkout back to its absent slot path', async () => {
      const { lock } = await removalLock();
      await writeFile(join(slotPath, 'untracked.txt'), 'work in progress\n');
      const quarantine = await quarantineSlot(repo, slotPath);
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS);
      expect(outcome).toMatchObject({ status: 'refused', reason: 'uncommitted_changes', checkoutPath: slotPath });
      expect(await readFile(join(slotPath, 'untracked.txt'), 'utf8')).toBe('work in progress\n');
      expect(existsSync(quarantine)).toBe(false);
      expect(worktreePaths(repo)).toContain(slotPath);
      // The refused removal left no copy or record behind.
      expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
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
        const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS);
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
        { ...PROOFS, occupants: { platform: 'linux', uid: 1000, proc: hidden } }
      );
      expect(outcome).toEqual({ status: 'removed', copy: removedCopyPathFor(quarantine), processesNotInspected: 1 });
      expect(existsSync(quarantine)).toBe(false);
    });

    it('counts the processes it could not inspect in a refusal too', async () => {
      const { lock } = await removalLock();
      await writeFile(join(slotPath, 'untracked.txt'), 'work in progress\n');
      const quarantine = await quarantineSlot(repo, slotPath);
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS);
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
          { ...PROOFS, occupants: { platform: 'linux', uid: 1000, proc: others } }
        )
      ).resolves.toEqual({ status: 'removed', copy: removedCopyPathFor(quarantine), processesNotInspected: 1 });
    });

    it('never nests the checkout into a recreated slot path, leaving it at the quarantine', async () => {
      const { lock } = await removalLock();
      await writeFile(join(slotPath, 'untracked.txt'), 'work in progress\n');
      const quarantine = await quarantineSlot(repo, slotPath);
      await mkdir(slotPath);
      await writeFile(join(slotPath, 'newcomer.txt'), 'new\n');
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS);
      expect(outcome).toMatchObject({ status: 'refused', reason: 'removal_restored', checkoutPath: quarantine });
      expect(await readdir(slotPath)).toEqual(['newcomer.txt']);
      expect(await readFile(join(quarantine, 'untracked.txt'), 'utf8')).toBe('work in progress\n');
      expect(worktreePaths(repo)).toContain(quarantine);
    });

    it('stops before its commit once the fence closes and leaves the quarantine for recovery', async () => {
      const { lock, env } = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      const removal = removeQuarantinedSlot(
        { repoRoot: repo, slotPath, quarantine, lock },
        {
          ...PROOFS,
          checkpoint: async (step) => {
            if (step === 'recorded') void env.shutdown.shutdownAndExit(0, 'completed');
          }
        }
      );
      await expect(removal).rejects.toThrow(ShutdownError);
      expect(await readFile(join(quarantine, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(existsSync(join(removedCopyPathFor(quarantine), 'checkout'))).toBe(false);
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
    it('lists quarantines and set-aside submodules per ordinal, ignoring other entries', async () => {
      const first = `${join(slotRoot, '1')}.deleting-11111111-1111-4111-8111-111111111111`;
      const third = `${join(slotRoot, '3')}.deleting-33333333-3333-4333-8333-333333333333`;
      await mkdir(first);
      await mkdir(`${first}.submodules`);
      await mkdir(`${third}.submodules`);
      await mkdir(`${third}.held`);
      await mkdir(join(slotRoot, '2'));
      await mkdir(join(slotRoot, '4.deleting-not-a-uuid'));
      await expect(findSlotResidue(slotRoot)).resolves.toEqual([
        { ordinal: 1, slotPath: join(slotRoot, '1'), quarantines: [first], setAsides: [`${first}.submodules`] },
        { ordinal: 3, slotPath: join(slotRoot, '3'), quarantines: [], setAsides: [`${third}.submodules`] }
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

    /**
     * Starts a removal of the quarantined slot that freezes, as a crash would, at one step.
     * @param quarantine - Where {@link quarantineSlot} moved the slot.
     * @param at - The step it freezes at.
     */
    async function frozenRemoval(quarantine: string, at: SlotRemovalStep): Promise<void> {
      const { lock } = await removalLock();
      let reached = false;
      void removeQuarantinedSlot(
        { repoRoot: repo, slotPath, quarantine, lock },
        {
          ...PROOFS,
          checkpoint: async (step) => {
            if (step !== at) return;
            reached = true;
            await frozen();
          }
        }
      );
      await until(() => reached);
      // The crashed owner's lock is abandoned; recovery takes a later generation.
      await lock.release();
    }

    it('prunes the vanished quarantine of a removal that committed before git’s record was dropped', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      await frozenRemoval(quarantine, 'committed');
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'pruned', quarantine }
      ]);
      expect(worktreePaths(repo)).not.toContain(quarantine);
      expect(await readFile(join(removedCopyPathFor(quarantine), 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
    });

    it('moves a recorded but uncommitted removal back to its absent slot path', async () => {
      const quarantine = await quarantineSlot(repo, slotPath);
      await frozenRemoval(quarantine, 'recorded');
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

    it('keeps set-aside submodules it cannot put back and reports the failure', async () => {
      const area = `${quarantinePathFor(slotPath)}.submodules`;
      await mkdir(join(area, '0'), { recursive: true });
      await writeFile(
        join(area, 'setaside.json'),
        JSON.stringify({ version: 1, gitDir: join(base, 'g'), paths: ['lib'] })
      );
      // Something now occupies the place the held submodule checkout must return to.
      await mkdir(join(slotPath, 'lib'));
      await writeFile(join(slotPath, 'lib', 'newcomer.txt'), 'new\n');
      const { lock } = await removalLock();
      await expect(recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock })).resolves.toEqual([
        { kind: 'recovery_failed', holding: area, detail: expect.stringMatching(/is not the empty directory/) }
      ]);
      expect(await readdir(area)).toEqual(['0', 'setaside.json']);
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

describe('slot root entries', () => {
  const uuid = '0f8e2a3c-1b2d-4e5f-8a9b-0c1d2e3f4a5b';

  it.each([
    ['1', true],
    ['12', true],
    ['0', false],
    ['01', false],
    ['1a', false],
    [`3.deleting-${uuid}`, true],
    [`3.deleting-${uuid}.submodules`, true],
    ['3.deleting-x', true],
    [`03.deleting-${uuid}`, false],
    ['.locks', false],
    ['.purge', false],
    [`.purge/1.${uuid}`, false],
    [`1.${uuid}`, false]
  ])('counts %s as a slot entry: %s', (name, expected) => {
    expect(isSlotEntryName(name)).toBe(expected);
  });

  it('names the quarantine a removal creates as a slot entry', () => {
    expect(isSlotEntryName(basename(quarantinePathFor('/slots/3')))).toBe(true);
  });

  describe('a card slot root', () => {
    let root: string;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'cards-slot-root-')));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('holds no slot entry when only its locks and removed copies remain', async () => {
      await mkdir(join(root, '.locks', '3'), { recursive: true });
      await mkdir(join(root, '.purge', `3.${uuid}`), { recursive: true });
      await expect(slotRootHoldsSlotEntry(root)).resolves.toBe(false);
    });

    it.each(['3', '3.deleting-x'])('holds a slot entry beside its locks when %s is present', async (name) => {
      await mkdir(join(root, '.locks'));
      await mkdir(join(root, name));
      await expect(slotRootHoldsSlotEntry(root)).resolves.toBe(true);
    });

    it('holds no slot entry when it does not exist', async () => {
      await expect(slotRootHoldsSlotEntry(join(root, 'deleted-card'))).resolves.toBe(false);
    });
  });
});

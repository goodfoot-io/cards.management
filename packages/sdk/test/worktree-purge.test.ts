/**
 * The deferred purge of removed slots against real git worktrees with nested
 * submodules and real slot locks: why git forces the submodule set-aside and
 * makes `worktree remove` of a moved checkout safe, the set-aside and its
 * reversal, crash recovery at every step of a removal, and the purge of each
 * removed copy under its ordinal's lock, which deletes only what is unchanged
 * since the removal and keeps and reports anything else.
 * @summary Submodule set-aside, removal crash recovery and the verified purge of removed slot copies
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShutdownError } from '../src/bounded-git.js';
import { acquireSlotLock, type SlotLock, withSlotLock } from '../src/slot-lock.js';
import {
  findRemovedSlotCopies,
  purgeRemovedSlots,
  quarantinePathFor,
  quarantineSlot,
  REMOVED_COPY_MINIMUM_AGE_MS,
  type RemovedSlotPurgeOptions,
  recoverSlotResidueLocked,
  removedCopyPathFor,
  removeQuarantinedSlot,
  type SetAsideSubmodules,
  type SlotRemovalProofs,
  type SlotRemovalStep,
  type SlotResidueLocker,
  setAsideSubmodules,
  summarizeRemovedSlotPurge
} from '../src/worktree-removal.js';
import { fakeWorld, lockEnvironment, ownerFile, writeGeneration } from './helpers/slot-lock-fixtures.js';

/** Admits every set-aside, as a caller with no submodule judgment of its own would. */
const PROOFS: SlotRemovalProofs = { proveSetAside: async () => null };
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  // Local submodule clones in the fixture only, and none of the host's commit hooks.
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
};

/**
 * Runs git synchronously for fixture setup and inspection.
 * @param cwd - Working directory.
 * @param args - Git arguments.
 * @returns Trimmed standard output.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/**
 * Lists the checkout paths git records for a repository.
 * @param repo - The main repository.
 * @returns Paths of every registered worktree, the main one included.
 */
function worktreePaths(repo: string): string[] {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/** A checkpoint that never returns, freezing a removal or purge as a crash would. */
const frozen = (): Promise<void> => new Promise<void>(() => undefined);

/**
 * Waits until a frozen operation has reached its checkpoint.
 * @param reached - Flag set by the checkpoint.
 */
async function until(reached: () => boolean): Promise<void> {
  while (!reached()) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('slot purge', () => {
  /** Repositories built once: a plain one, and one with a submodule `lib` that has its own submodule `inner`. */
  let templates: string;
  let base: string;
  let repo: string;
  let cardsDir: string;
  let slotRoot: string;
  let slotPath: string;
  let env: ReturnType<typeof lockEnvironment>;
  let children: ChildProcess[];

  beforeAll(async () => {
    templates = await realpath(await mkdtemp(join(tmpdir(), 'cards-slot-purge-templates-')));
    const plain = join(templates, 'plain');
    await mkdir(plain);
    git(plain, 'init', '-q', '-b', 'main');
    await writeFile(join(plain, 'tracked.txt'), 'tracked\n');
    git(plain, 'add', 'tracked.txt');
    git(plain, 'commit', '-q', '-m', 'initial');
    const inner = join(templates, 'inner-src');
    const lib = join(templates, 'lib-src');
    for (const source of [inner, lib]) {
      await mkdir(source);
      git(source, 'init', '-q', '-b', 'main');
      await writeFile(join(source, 'README'), `${basename(source)}\n`);
      git(source, 'add', 'README');
      git(source, 'commit', '-q', '-m', 'initial');
    }
    git(lib, 'submodule', 'add', '-q', inner, 'inner');
    git(lib, 'commit', '-q', '-m', 'inner');
    const withLib = join(templates, 'with-lib');
    await cp(plain, withLib, { recursive: true });
    git(withLib, 'submodule', 'add', '-q', lib, 'lib');
    git(withLib, 'commit', '-q', '-m', 'lib');
  });

  afterAll(async () => {
    await rm(templates, { recursive: true, force: true });
  });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'cards-slot-purge-')));
    repo = join(base, 'repo');
    cardsDir = join(base, 'cards');
    slotRoot = join(cardsDir, 'main-1');
    slotPath = join(slotRoot, '1');
    env = lockEnvironment(fakeWorld());
    children = [];
    await mkdir(slotRoot, { recursive: true });
    await cp(join(templates, 'plain'), repo, { recursive: true });
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

  /** Adds the slot worktree without submodules. */
  function addSlot(): void {
    git(repo, 'worktree', 'add', '-q', '-b', 'slot-1', slotPath);
  }

  /**
   * Makes the repository the one with a submodule `lib` that has its own
   * submodule `inner`, then adds the slot worktree and initializes both in it.
   */
  async function addSlotWithSubmodules(): Promise<void> {
    await rm(repo, { recursive: true });
    await cp(join(templates, 'with-lib'), repo, { recursive: true });
    addSlot();
    git(slotPath, 'submodule', 'update', '-q', '--init', '--recursive');
  }

  /**
   * The slot's own git directory.
   * @param checkout - Any checkout of the slot, at its current path.
   * @returns Its absolute git directory.
   */
  const gitDirOf = (checkout: string): string => git(checkout, 'rev-parse', '--absolute-git-dir');

  /**
   * Takes a slot's `removal` lock.
   * @param root - The slot root.
   * @param ordinal - Slot ordinal.
   * @returns The held lock.
   */
  async function removalLock(root = slotRoot, ordinal = 1): Promise<SlotLock> {
    const result = await acquireSlotLock(root, ordinal, {
      executionId: 'exec-removal',
      cardId: 'main-1',
      purpose: 'removal',
      environment: env.environment
    });
    if (result.status !== 'acquired') throw new Error(`lock not acquired: ${result.status}`);
    return result.lock;
  }

  /**
   * Removes the slot through quarantine and commit.
   * @returns The removed copy.
   */
  async function removeSlot(): Promise<string> {
    const lock = await removalLock();
    const quarantine = await quarantineSlot(repo, slotPath);
    const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS);
    await lock.release();
    if (outcome.status !== 'removed') throw new Error(`not removed: ${outcome.detail}`);
    return outcome.copy;
  }

  /**
   * Binds `withSlotLock` to a slot root, as the purging card's pass would.
   * @param cardId - The card running the pass.
   * @returns The locker factory the purge takes.
   */
  const lockerFor =
    (cardId = 'main-1') =>
    (root: string): SlotResidueLocker =>
    (ordinal, purpose, fn) =>
      withSlotLock(root, ordinal, purpose, { executionId: 'exec-purge', cardId, environment: env.environment }, fn);

  /**
   * Runs one purge pass with a generous deadline and no minimum age unless overridden.
   * @param overrides - Option and locker overrides.
   * @param locker - The locker factory.
   * @returns The pass's outcomes and failure.
   */
  const purgePass = (
    overrides: Partial<RemovedSlotPurgeOptions> = {},
    locker: (root: string) => SlotResidueLocker = lockerFor()
  ) =>
    purgeRemovedSlots(cardsDir, locker, {
      repoRoot: repo,
      deadline: Date.now() + 60_000,
      minimumAge: 0,
      ...overrides
    });

  /**
   * Runs one purge pass that must not fail.
   * @param overrides - Option and locker overrides.
   * @param locker - The locker factory.
   * @returns The pass's outcomes.
   */
  const purge = async (
    overrides: Partial<RemovedSlotPurgeOptions> = {},
    locker: (root: string) => SlotResidueLocker = lockerFor()
  ) => {
    const { outcomes, failure } = await purgePass(overrides, locker);
    expect(failure).toBeNull();
    return outcomes;
  };

  /**
   * A locker that hands its lock to the test, so a frozen pass's lock can be released as a crash would.
   * @param onLock - Receives the held lock.
   * @returns The locker factory.
   */
  const capturingLocker =
    (onLock: (lock: SlotLock) => void) =>
    (root: string): SlotResidueLocker =>
    async (ordinal, purpose, fn) => {
      const result = await acquireSlotLock(root, ordinal, {
        executionId: 'exec-frozen',
        cardId: 'main-1',
        purpose,
        environment: env.environment
      });
      if (result.status !== 'acquired') return result;
      onLock(result.lock);
      return { status: 'done', value: await fn(result.lock, result.previous) };
    };

  /**
   * Backdates every file of the slot beyond the racy window, so its record proves files by identity
   * alone rather than by content hash, as for any checkout older than a few seconds.
   */
  async function age(): Promise<void> {
    const aged = new Date(Date.now() - 3_600_000);
    for (const entry of await readdir(slotPath, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), aged, aged);
  }

  /**
   * The slot root's entries besides its locks.
   * @returns Sorted names.
   */
  const residue = async (): Promise<string[]> => (await readdir(slotRoot)).filter((name) => name !== '.locks').sort();

  describe('git evidence', () => {
    it('drops only the administrative record of a worktree whose path is gone, and nothing else', async () => {
      addSlot();
      const admin = gitDirOf(slotPath);
      const moved = join(base, 'moved');
      await rename(slotPath, moved);
      // Exit 0, or execFileSync throws.
      git(repo, 'worktree', 'remove', slotPath);
      expect(existsSync(admin)).toBe(false);
      expect(worktreePaths(repo)).not.toContain(slotPath);
      expect(await readFile(join(moved, 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect((await readdir(moved)).sort()).toEqual(['.git', 'tracked.txt']);
      expect(git(repo, 'branch', '--list', 'slot-1')).toContain('slot-1');
      // A second removal finds no worktree, so a repeated step fails loudly instead of touching anything.
      expect(() => git(repo, 'worktree', 'remove', '--force', slotPath)).toThrow(/is not a working tree/);
    });

    it('refuses to move a worktree with initialized submodules, which is why they are set aside', async () => {
      await addSlotWithSubmodules();
      expect(() => git(repo, 'worktree', 'move', slotPath, `${slotPath}.moved`)).toThrow(/submodule/);
    });
  });

  describe('submodule set-aside', () => {
    beforeEach(addSlotWithSubmodules);

    it('sets initialized submodules and their repositories aside, so the quarantine reads clean', async () => {
      const gitDir = gitDirOf(slotPath);
      const quarantine = await quarantineSlot(repo, slotPath);
      const area = `${quarantine}.submodules`;
      expect((await readdir(area)).sort()).toEqual(['0', 'modules', 'setaside.json']);
      expect(await readFile(join(area, '0', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
      expect(await readdir(join(quarantine, 'lib'))).toEqual([]);
      expect(existsSync(join(gitDirOf(quarantine), 'modules'))).toBe(false);
      expect(git(quarantine, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      // Git keeps the worktree's administrative directory through the move, now without its modules.
      expect(gitDirOf(quarantine)).toBe(gitDir);
    });

    it('puts the submodules back when git refuses the move', async () => {
      git(repo, 'worktree', 'lock', slotPath);
      await expect(quarantineSlot(repo, slotPath)).rejects.toMatchObject({ name: 'SlotGitError' });
      expect(await residue()).toEqual(['1']);
      expect(await readFile(join(slotPath, 'lib', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
      expect(existsSync(join(gitDirOf(slotPath), 'modules', 'lib'))).toBe(true);
      expect(git(slotPath, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      expect(git(slotPath, 'submodule', 'status', '--recursive')).not.toMatch(/^-/m);
    });

    it('refuses a file hidden in an uninitialized submodule directory, and restores everything', async () => {
      const lock = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      await writeFile(join(quarantine, 'lib', 'stray.txt'), 'hidden from git\n');
      const outcome = await removeQuarantinedSlot({ repoRoot: repo, slotPath, quarantine, lock }, PROOFS);
      expect(outcome).toMatchObject({ status: 'refused', reason: 'uncommitted_changes', checkoutPath: slotPath });
      // The held submodule cannot return over the stray file, so it stays set aside for recovery to report.
      expect(outcome.status === 'refused' && outcome.detail).toMatch(
        /^Uninitialized submodule directories hold files git does not show: lib\/stray\.txt; its submodules stay set aside at .*\.submodules: .* is not the empty directory/
      );
      expect(await readFile(join(slotPath, 'lib', 'stray.txt'), 'utf8')).toBe('hidden from git\n');
      expect(await readFile(join(`${quarantine}.submodules`, '0', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
    });

    it('hands the caller the set-aside it recorded, and a refusal restores the slot with its submodules', async () => {
      const gitDir = gitDirOf(slotPath);
      const lock = await removalLock();
      const quarantine = await quarantineSlot(repo, slotPath);
      const judged: SetAsideSubmodules[] = [];
      const outcome = await removeQuarantinedSlot(
        { repoRoot: repo, slotPath, quarantine, lock },
        {
          proveSetAside: async (setAside) => {
            judged.push(setAside);
            return 'lib holds unpushed commits';
          }
        }
      );
      expect(judged).toEqual([{ slotPath, quarantine, area: `${quarantine}.submodules`, gitDir, paths: ['lib'] }]);
      expect(outcome).toEqual({
        status: 'refused',
        reason: 'submodules',
        detail: 'lib holds unpushed commits',
        checkoutPath: slotPath,
        processesNotInspected: expect.any(Number)
      });
      // The refused removal left no copy or record behind.
      expect(await residue()).toEqual(['.purge', '1']);
      expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
      expect(await readFile(join(slotPath, 'lib', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
      expect(existsSync(join(gitDirOf(slotPath), 'modules', 'lib'))).toBe(true);
      expect(git(slotPath, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it('commits the checkout and its set-aside submodules to one copy', async () => {
      const copy = await removeSlot();
      expect((await readdir(copy)).sort()).toEqual(['checkout', 'submodules']);
      expect(await readFile(join(copy, 'submodules', '0', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
      expect(await residue()).toEqual(['.purge']);
      expect(worktreePaths(repo)).toEqual([repo]);
    });

    describe('crash recovery', () => {
      /**
       * Freezes a removal at one step, then abandons its lock as a crash would.
       * @param quarantine - Where {@link quarantineSlot} moved the slot.
       * @param at - The step it freezes at.
       */
      async function crashAt(quarantine: string, at: SlotRemovalStep): Promise<void> {
        const lock = await removalLock();
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
        await lock.release();
      }

      /**
       * Recovers the slot's residue under a fresh lock.
       * @returns The reports.
       */
      async function recover() {
        const lock = await removalLock();
        try {
          return await recoverSlotResidueLocked({ repoRoot: repo, slotPath, lock });
        } finally {
          await lock.release();
        }
      }

      /** Asserts the slot is back, whole and clean, with no residue beside it. */
      async function expectSlotRestored(): Promise<void> {
        expect(await readFile(join(slotPath, 'lib', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
        expect(git(slotPath, 'status', '--porcelain', '--untracked-files=all')).toBe('');
        expect(git(slotPath, 'submodule', 'status', '--recursive')).not.toMatch(/^-/m);
        expect(worktreePaths(repo)).toEqual([repo, slotPath]);
      }

      it('puts back submodules set aside before the quarantine move', async () => {
        const area = `${quarantinePathFor(slotPath)}.submodules`;
        await expect(setAsideSubmodules(slotPath, area)).resolves.toBe(true);
        await expect(recover()).resolves.toEqual([{ kind: 'submodules_restored', setAside: area, slotPath }]);
        await expectSlotRestored();
        expect(await residue()).toEqual(['1']);
      });

      it('moves back a quarantine whose removal never recorded, with its submodules', async () => {
        const quarantine = await quarantineSlot(repo, slotPath);
        await expect(recover()).resolves.toEqual([{ kind: 'moved_back', quarantine, slotPath }]);
        await expectSlotRestored();
        expect(await residue()).toEqual(['1']);
      });

      it('moves back a recorded removal that never committed, and the purge clears its record silently', async () => {
        const quarantine = await quarantineSlot(repo, slotPath);
        await crashAt(quarantine, 'recorded');
        expect(existsSync(`${removedCopyPathFor(quarantine)}.json`)).toBe(true);
        await expect(recover()).resolves.toEqual([{ kind: 'moved_back', quarantine, slotPath }]);
        await expectSlotRestored();
        await expect(purge()).resolves.toEqual([]);
        expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
      });

      it('joins the submodules to a committed copy, prunes git’s record, and the purge deletes it', async () => {
        const quarantine = await quarantineSlot(repo, slotPath);
        await crashAt(quarantine, 'committed');
        await expect(recover()).resolves.toEqual([
          { kind: 'removal_finished', quarantine },
          { kind: 'pruned', quarantine }
        ]);
        const copy = removedCopyPathFor(quarantine);
        expect((await readdir(copy)).sort()).toEqual(['checkout', 'submodules']);
        expect(worktreePaths(repo)).toEqual([repo]);
        await expect(purge()).resolves.toEqual([{ copy, status: 'purged', processesNotInspected: expect.any(Number) }]);
        expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
      });

      it('lets the purge finish a committed removal that recovery never saw', async () => {
        const quarantine = await quarantineSlot(repo, slotPath);
        await crashAt(quarantine, 'committed');
        const copy = removedCopyPathFor(quarantine);
        await expect(purge()).resolves.toEqual([{ copy, status: 'purged', processesNotInspected: expect.any(Number) }]);
        expect(await residue()).toEqual(['.purge']);
        expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
        expect(worktreePaths(repo)).toEqual([repo]);
      });

      it('leaves a quarantine stranded, with its submodules, when the slot path was recreated', async () => {
        const quarantine = await quarantineSlot(repo, slotPath);
        await mkdir(slotPath);
        await expect(recover()).resolves.toEqual([{ kind: 'quarantine_stranded', quarantine, slotPath }]);
        expect(existsSync(`${quarantine}.submodules`)).toBe(true);
      });
    });
  });

  describe('purge', () => {
    it('deletes a removed copy on the next pass, leaving nothing behind', async () => {
      await addSlotWithSubmodules();
      const copy = await removeSlot();
      const outcomes = await purge();
      expect(outcomes).toEqual([{ copy, status: 'purged', processesNotInspected: expect.any(Number) }]);
      expect(summarizeRemovedSlotPurge({ outcomes, failure: null })).toEqual({
        purged: 1,
        pending: 0,
        kept: [],
        failure: null
      });
      expect(await residue()).toEqual(['.purge']);
      expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
      expect(git(repo, 'branch', '--list', 'slot-1')).toContain('slot-1');
      await expect(purge()).resolves.toEqual([]);
    });

    it('keeps and reports a copy written after its removal, every pass, and touches nothing in it', async () => {
      addSlot();
      const copy = await removeSlot();
      await writeFile(join(copy, 'checkout', 'late.txt'), 'late work\n');
      const kept = {
        copy,
        status: 'kept',
        detail: `It changed after its removal: checkout/late.txt. Check its contents, then delete ${copy} by hand`,
        processesNotInspected: expect.any(Number)
      };
      const outcomes = await purge();
      expect(outcomes).toEqual([kept]);
      expect(summarizeRemovedSlotPurge({ outcomes, failure: null })).toEqual({
        purged: 0,
        pending: 0,
        kept: [{ path: copy, detail: kept.detail }],
        failure: null
      });
      await expect(purge()).resolves.toEqual([kept]);
      expect(await readFile(join(copy, 'checkout', 'late.txt'), 'utf8')).toBe('late work\n');
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
    });

    it('keeps a copy whose tracked file was rewritten in place', async () => {
      addSlot();
      const copy = await removeSlot();
      await appendFile(join(copy, 'checkout', 'tracked.txt'), 'more\n');
      await expect(purge()).resolves.toEqual([
        expect.objectContaining({
          status: 'kept',
          detail: expect.stringMatching(/^It changed after its removal: checkout\/tracked\.txt\./)
        })
      ]);
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\nmore\n');
    });

    it('keeps a copy written during its purge and restores every entry', async () => {
      addSlot();
      const copy = await removeSlot();
      let written = false;
      const outcomes = await purge({
        checkpoint: async (entry) => {
          if (written || !entry.endsWith('tracked.txt')) return;
          written = true;
          await writeFile(join(copy, 'checkout', 'late.txt'), 'late work\n');
        }
      });
      expect(outcomes).toEqual([
        expect.objectContaining({ copy, status: 'kept', detail: expect.stringContaining(`delete ${copy} by hand`) })
      ]);
      expect(await readFile(join(copy, 'checkout', 'late.txt'), 'utf8')).toBe('late work\n');
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(existsSync(join(copy, 'checkout', '.git'))).toBe(true);
      expect(existsSync(`${copy}.held`)).toBe(false);
    });

    it.runIf(process.platform === 'linux')('leaves a copy pending while a process is proven inside it', async () => {
      addSlot();
      const copy = await removeSlot();
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: join(copy, 'checkout'),
        detached: true,
        stdio: 'ignore'
      });
      children.push(child);
      await new Promise((resolve) => child.once('spawn', resolve));
      const outcomes = await purge();
      expect(outcomes).toEqual([
        expect.objectContaining({
          copy,
          status: 'pending',
          detail: expect.stringContaining(`(pid ${String(child.pid)})`)
        })
      ]);
      expect(summarizeRemovedSlotPurge({ outcomes, failure: null })).toEqual({
        purged: 0,
        pending: 1,
        kept: [],
        failure: null
      });
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
    });

    /**
     * Rewrites a copy's removal time in its record.
     * @param copy - The removed copy.
     * @param removedAt - The value to record, or undefined to drop the field.
     */
    async function recordRemovalTime(copy: string, removedAt: unknown): Promise<void> {
      const record = JSON.parse(await readFile(`${copy}.json`, 'utf8')) as Record<string, unknown>;
      await writeFile(`${copy}.json`, JSON.stringify({ ...record, removedAt }));
    }

    it('leaves a copy removed less than the minimum age ago pending and untouched', async () => {
      addSlot();
      const copy = await removeSlot();
      const record = JSON.parse(await readFile(`${copy}.json`, 'utf8')) as { removedAt: string };
      const eligibleAt = new Date(Date.parse(record.removedAt) + REMOVED_COPY_MINIMUM_AGE_MS).toISOString();
      await expect(purge({ minimumAge: REMOVED_COPY_MINIMUM_AGE_MS })).resolves.toEqual([
        {
          copy,
          status: 'pending',
          detail: `It was removed at ${record.removedAt} and waits until ${eligibleAt}`,
          processesNotInspected: 0
        }
      ]);
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
    });

    it('purges a copy removed longer than the minimum age ago', async () => {
      addSlot();
      const copy = await removeSlot();
      await recordRemovalTime(copy, new Date(Date.now() - REMOVED_COPY_MINIMUM_AGE_MS - 1_000).toISOString());
      await expect(purge({ minimumAge: REMOVED_COPY_MINIMUM_AGE_MS })).resolves.toEqual([
        { copy, status: 'purged', processesNotInspected: expect.any(Number) }
      ]);
      expect(existsSync(copy)).toBe(false);
    });

    it.each([
      ['missing', undefined],
      ['not a timestamp', 'yesterday'],
      ['not canonical', '2026-01-01'],
      ['not a string', 1_700_000_000_000]
    ])('keeps a copy whose removal time is %s', async (_case, removedAt) => {
      addSlot();
      const copy = await removeSlot();
      await recordRemovalTime(copy, removedAt);
      await expect(purge()).resolves.toEqual([
        {
          copy,
          status: 'kept',
          detail: `Its removal record has no valid removal time. Check its contents, then delete ${copy} by hand`,
          processesNotInspected: 0
        }
      ]);
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
    });

    it('reports a purge that failed, with the outcomes it reached, and never as a clean one', async () => {
      addSlot();
      const copy = await removeSlot();
      const failing = (): SlotResidueLocker => async () => {
        throw new Error('The lock store is unreadable');
      };
      const result = await purgePass({}, failing);
      expect(result).toEqual({ outcomes: [], failure: 'The lock store is unreadable' });
      expect(summarizeRemovedSlotPurge(result)).toEqual({
        purged: 0,
        pending: 0,
        kept: [],
        failure: 'The lock store is unreadable'
      });
      expect(existsSync(join(copy, 'checkout', 'tracked.txt'))).toBe(true);
    });

    it('lets a shutdown through rather than reporting it as a failed purge', async () => {
      addSlot();
      await removeSlot();
      const stopping = (): SlotResidueLocker => async () => {
        throw new ShutdownError('stopping');
      };
      await expect(purgePass({}, stopping)).rejects.toBeInstanceOf(ShutdownError);
    });

    it('leaves copies pending once the deadline passed', async () => {
      addSlot();
      const copy = await removeSlot();
      await expect(purge({ deadline: Date.now() - 1 })).resolves.toEqual([
        { copy, status: 'pending', detail: 'The cleanup budget ran out', processesNotInspected: expect.any(Number) }
      ]);
      expect(existsSync(join(copy, 'checkout', 'tracked.txt'))).toBe(true);
    });

    it('leaves a copy pending while its ordinal’s lock is held', async () => {
      addSlot();
      const copy = await removeSlot();
      const generations = await readdir(join(slotRoot, '.locks', '1'));
      writeGeneration(slotRoot, 1, Math.max(...generations.map(Number)) + 1, { owner: ownerFile() });
      const world = fakeWorld();
      world.processes.set(2_000, { parentPid: 1, startIdentity: 'holder-start', processGroupId: 2_000 });
      env = lockEnvironment(world);
      await expect(purge()).resolves.toEqual([
        { copy, status: 'pending', detail: 'Slot 1 lock is held', processesNotInspected: expect.any(Number) }
      ]);
      expect(existsSync(join(copy, 'checkout', 'tracked.txt'))).toBe(true);
    });

    it('purges a deleted card’s copy from another card’s pass', async () => {
      addSlot();
      const copy = await removeSlot();
      // The card is deleted; only its slot root with the waiting copy remains.
      await mkdir(join(cardsDir, 'main-2'));
      await expect(purge({}, lockerFor('main-2'))).resolves.toEqual([
        { copy, status: 'purged', processesNotInspected: expect.any(Number) }
      ]);
      expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
    });

    it('reserves the ordinal while its copy, record or interrupted purge waits', async () => {
      addSlot();
      const copy = await removeSlot();
      await expect(findRemovedSlotCopies(slotRoot)).resolves.toEqual([{ ordinal: 1, copy }]);
      await rename(copy, `${copy}.held`);
      await expect(findRemovedSlotCopies(slotRoot)).resolves.toEqual([{ ordinal: 1, copy }]);
      await rm(`${copy}.held`, { recursive: true });
      await expect(findRemovedSlotCopies(slotRoot)).resolves.toEqual([{ ordinal: 1, copy }]);
      await rm(`${copy}.json`);
      await expect(findRemovedSlotCopies(slotRoot)).resolves.toEqual([]);
    });

    it('frees the ordinal once its copy is purged', async () => {
      addSlot();
      await removeSlot();
      await purge();
      await expect(findRemovedSlotCopies(slotRoot)).resolves.toEqual([]);
    });

    it('keeps a copy whose removal record is unreadable', async () => {
      addSlot();
      const copy = await removeSlot();
      await writeFile(`${copy}.json`, '{');
      await expect(purge()).resolves.toEqual([
        {
          copy,
          status: 'kept',
          detail: `It has no readable removal record. Check its contents, then delete ${copy} by hand`,
          processesNotInspected: expect.any(Number)
        }
      ]);
      expect(existsSync(join(copy, 'checkout', 'tracked.txt'))).toBe(true);
    });

    it('finishes a purge interrupted after its commit', async () => {
      await addSlotWithSubmodules();
      const copy = await removeSlot();
      let reached = false;
      let held: SlotLock | undefined;
      void purge(
        {
          filesystem: {
            unlink: async () => {
              reached = true;
              await frozen();
            }
          }
        },
        capturingLocker((lock) => {
          held = lock;
        })
      );
      await until(() => reached);
      expect(existsSync(copy)).toBe(false);
      await held?.release();
      await expect(purge()).resolves.toEqual([{ copy, status: 'purged', processesNotInspected: expect.any(Number) }]);
      expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
    });

    it('restores a purge killed mid-dismantle, and keeps the copy whose entries it cannot re-verify', async () => {
      await addSlotWithSubmodules();
      await age();
      const copy = await removeSlot();
      let taken = 0;
      let reached = false;
      let held: SlotLock | undefined;
      void purge(
        {
          checkpoint: async () => {
            if (++taken < 4) return;
            reached = true;
            await frozen();
          }
        },
        capturingLocker((lock) => {
          held = lock;
        })
      );
      await until(() => reached);
      expect(existsSync(`${copy}.held`)).toBe(true);
      await held?.release();
      // The kill lost the change times observed as entries were held, so the restored files are unproven.
      const outcomes = await purge();
      expect(outcomes).toEqual([
        expect.objectContaining({
          copy,
          status: 'kept',
          detail: expect.stringMatching(
            new RegExp(
              `^Its purge was interrupted, and these entries cannot be proven unchanged since: .+\\. Check its contents, then delete ${copy.replaceAll('.', '\\.')} by hand$`
            )
          )
        })
      ]);
      expect(existsSync(`${copy}.held`)).toBe(false);
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
      expect(await readFile(join(copy, 'submodules', '0', 'inner', 'README'), 'utf8')).toBe('inner-src\n');
    });

    it('leaves a copy pending when the deadline passes mid-dismantle, and deletes it on the next pass', async () => {
      await addSlotWithSubmodules();
      await age();
      const copy = await removeSlot();
      const deadline = Date.now() + 1_000;
      let taken = 0;
      const outcomes = await purge({
        deadline,
        checkpoint: async () => {
          if (++taken !== 4) return;
          while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });
      expect(outcomes).toEqual([
        { copy, status: 'pending', detail: 'The cleanup budget ran out', processesNotInspected: expect.any(Number) }
      ]);
      expect(existsSync(`${copy}.held`)).toBe(false);
      // The restoration re-recorded what it put back, so its own renames do not read as changes.
      await expect(purge()).resolves.toEqual([{ copy, status: 'purged', processesNotInspected: expect.any(Number) }]);
      expect(await readdir(join(slotRoot, '.purge'))).toEqual([]);
    });

    it('leaves a copy pending when an operation is refused, and deletes it once the blocker is gone', async () => {
      addSlot();
      const copy = await removeSlot();
      let refused = false;
      const outcomes = await purge({
        filesystem: {
          rmdir: async (path) => {
            if (refused || path !== join(copy, 'checkout')) return (await import('node:fs/promises')).rmdir(path);
            refused = true;
            throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          }
        }
      });
      expect(outcomes).toEqual([
        expect.objectContaining({ copy, status: 'pending', detail: expect.stringMatching(/EBUSY/) })
      ]);
      expect(await readFile(join(copy, 'checkout', 'tracked.txt'), 'utf8')).toBe('tracked\n');
      // The restoration's own renames read as no change against the re-recorded identities.
      await expect(purge()).resolves.toEqual([{ copy, status: 'purged', processesNotInspected: expect.any(Number) }]);
    });
  });
});

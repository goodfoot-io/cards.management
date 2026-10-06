/**
 * Witness of the submodule rule: a real workspace whose `main` records a
 * submodule that itself records a nested one, both cloned from bare remotes.
 * Each way a removal would lose submodule work keeps the slot with a remedy,
 * and running that remedy lets the next pass remove it, submodules included.
 *
 * @summary Slot cleanup submodule rule witness tests
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Logger, type WorktreeCleanupDecision } from '@cards.management/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AcquiredSlot,
  acquireSlot,
  cleanupCardSlots,
  SLOT_CLEANUP_PASS_BUDGET_MS,
  type SlotCleanupResult
} from '../src/lib/worktrees/index.js';
import {
  ageRemovedCopies,
  createSlotFixture,
  FIXTURE_GIT_ENV,
  GIT_HEAVY_TIMEOUT_MS,
  type SlotFixture
} from './helpers/slot-fixture.js';

let fx: SlotFixture;
/** The bare remotes every test clones from, made once. */
let remotes: string;

/** Git with local file clones allowed, as `submodule update` over a path remote needs. */
const FILE_PROTOCOL = ['-c', 'protocol.file.allow=always'];

/**
 * Runs git outside any fixture.
 * @param args - Git arguments.
 * @param cwd - Working directory.
 */
async function git(args: readonly string[], cwd: string): Promise<void> {
  await promisify(execFile)('git', [...args], { cwd, env: { ...process.env, ...FIXTURE_GIT_ENV } });
}

/**
 * Creates a bare remote with one pushed commit, optionally recording a submodule.
 * @param name - The remote's name under the remotes directory.
 * @param submodule - A remote to record at `nested`; none by default.
 * @returns The bare remote's path.
 */
async function remote(name: string, submodule?: string): Promise<string> {
  const bare = join(remotes, `${name}.git`);
  const work = join(remotes, `${name}-work`);
  await git(['init', '-q', '--bare', '-b', 'main', bare], remotes);
  await git(['clone', '-q', bare, work], remotes);
  await writeFile(join(work, 'file.txt'), name);
  await git(['add', 'file.txt'], work);
  if (submodule !== undefined) await git([...FILE_PROTOCOL, 'submodule', 'add', '-q', submodule, 'nested'], work);
  await git(['commit', '-q', '-m', name], work);
  await git(['push', '-q', 'origin', 'main'], work);
  return bare;
}

beforeAll(async () => {
  remotes = await realpath(await mkdtemp(join(tmpdir(), 'slot-submodule-remotes-')));
  await remote('sub', await remote('nested'));
}, GIT_HEAVY_TIMEOUT_MS);

afterAll(async () => {
  await rm(remotes, { recursive: true, force: true });
});

beforeEach(async () => {
  fx = await createSlotFixture();
  await fx.git([...FILE_PROTOCOL, 'submodule', 'add', '-q', join(remotes, 'sub.git'), 'sub']);
  await fx.git(['commit', '-q', '-m', 'record sub']);
}, GIT_HEAVY_TIMEOUT_MS);

afterEach(async () => {
  await fx.dispose();
});

/**
 * Creates a slot from `main` and releases it, with its submodules uninitialized.
 * @returns The released slot.
 */
async function finishedSlot(): Promise<AcquiredSlot> {
  const slot = await acquireSlot(fx.input('exec-1'), { client: fx.client, logger: new Logger(), layer: fx.layer });
  await slot.lock.release();
  return slot;
}

/**
 * Initializes a slot's submodules recursively, as a user's `submodule update` does.
 * @param slot - The slot whose checkout is initialized.
 */
async function initialize(slot: AcquiredSlot): Promise<void> {
  await fx.git([...FILE_PROTOCOL, 'submodule', 'update', '-q', '--init', '--recursive'], slot.worktreePath);
}

/**
 * Runs a cleanup pass for the fixture's card.
 * @param mode - Preview or cleanup.
 * @returns Every slot's decision.
 */
function pass(mode: 'preview' | 'cleanup' = 'cleanup'): Promise<SlotCleanupResult> {
  return cleanupCardSlots(fx.cleanupContext(), { requester: null, mode, budgetMs: SLOT_CLEANUP_PASS_BUDGET_MS });
}

/**
 * Finds a slot's decision.
 * @param result - The pass that decided.
 * @param slot - The slot whose decision is wanted.
 * @returns Its decision.
 * @throws When the pass made none for the slot.
 */
function decisionOf(result: SlotCleanupResult, slot: AcquiredSlot): WorktreeCleanupDecision {
  const decision = result.decisions.find((entry) => entry.branch === slot.branch);
  if (decision === undefined) throw new Error(`No decision for ${slot.branch}`);
  return decision;
}

/**
 * Whether a path exists.
 * @param path - The path tested.
 * @returns True when it exists.
 */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

/**
 * Runs every git command a detail names, as the user would.
 * @param detail - The decision's detail, whose backticked git commands are run.
 * @returns Each git command line, in the order run.
 */
async function runStatedCommands(detail: string): Promise<string[]> {
  const commands = [...detail.matchAll(/`(git [^`]+)`/g)].map(([, command]) => command ?? '');
  for (const command of commands) await fx.git(command.split(' ').slice(1));
  return commands;
}

/**
 * Checks a slot is gone with everything of it: ref, checkout, git's worktree
 * record with its module repositories, and the removed copy, which a pass
 * purges once it is an hour old. The main repository's submodule
 * configuration stays.
 * @param slot - The removed slot.
 */
async function expectGone(slot: AcquiredSlot): Promise<void> {
  expect(await fx.git(['branch', '--list', slot.branch])).toBe('');
  expect(await fx.git(['worktree', 'list', '--porcelain'])).not.toContain(slot.worktreePath);
  expect(await exists(slot.worktreePath)).toBe(false);
  await ageRemovedCopies(fx.slotRoot);
  expect((await pass()).purge).toEqual({ purged: 1, pending: 0, kept: [], failure: null });
  expect(await readdir(join(fx.slotRoot, '.purge'))).toEqual([]);
  expect(await fx.git(['config', 'submodule.sub.url'])).toBe(join(remotes, 'sub.git'));
}

/** A removed slot's decision. */
const REMOVED = { reason: 'eligible', outcome: 'removed' };

describe('cleanupCardSlots submodules', () => {
  it(
    'removes a slot whose submodule was never initialized',
    async () => {
      const slot = await finishedSlot();

      expect(decisionOf(await pass('preview'), slot)).toMatchObject({ reason: 'eligible', outcome: 'eligible' });
      expect(decisionOf(await pass(), slot)).toMatchObject({ reason: 'eligible', outcome: 'removed' });
      expect(await fx.git(['branch', '--list', slot.branch])).toBe('');
    },
    GIT_HEAVY_TIMEOUT_MS
  );

  it(
    'removes a slot whose initialized submodules are clean and pushed, with their checkouts',
    async () => {
      const slot = await finishedSlot();
      await initialize(slot);

      const preview = decisionOf(await pass('preview'), slot);
      expect(preview).toMatchObject({ reason: 'eligible', outcome: 'eligible' });
      expect(preview.detail).toContain(
        `git-ignored files and the submodule checkouts in ${slot.worktreePath} are deleted with it`
      );
      expect(decisionOf(await pass(), slot)).toMatchObject(REMOVED);
      await expectGone(slot);
    },
    GIT_HEAVY_TIMEOUT_MS
  );

  /**
   * Empties a slot's submodule directory by hand, as a step that names no git command asks.
   * @param slot - The slot whose `sub` is emptied.
   */
  const emptySub = async (slot: AcquiredSlot): Promise<void> => {
    await rm(join(slot.worktreePath, 'sub'), { recursive: true, force: true });
    await mkdir(join(slot.worktreePath, 'sub'));
  };

  it.each([
    {
      finding: 'a nested commit no remote-tracking ref reaches',
      initialized: true,
      arrange: async (slot: AcquiredSlot) => {
        const nested = join(slot.worktreePath, 'sub', 'nested');
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'local'], nested);
        await fx.git(['update-ref', 'refs/heads/side', 'HEAD'], nested);
        await fx.git(['checkout', '-q', '--detach', 'HEAD~'], nested);
        const commit = (await fx.git(['rev-parse', 'side'], nested)).slice(0, 12);
        return [`sub/nested has commit ${commit}`, 'refs/heads/side', `\`git -C ${nested} push origin side\``];
      }
    },
    {
      finding: 'a stash',
      initialized: true,
      arrange: async (slot: AcquiredSlot) => {
        const sub = join(slot.worktreePath, 'sub');
        await writeFile(join(sub, 'file.txt'), 'edited');
        await fx.git(['stash', '-q'], sub);
        return ['sub has stashed changes', `\`git -C ${sub} stash clear\``];
      }
    },
    {
      finding: 'a change the parent is configured to ignore',
      initialized: true,
      arrange: async (slot: AcquiredSlot) => {
        await fx.git(['config', 'submodule.sub.ignore', 'all'], slot.worktreePath);
        await writeFile(join(slot.worktreePath, 'sub', 'file.txt'), 'edited');
        return ['sub has uncommitted or untracked changes'];
      }
    },
    {
      finding: 'a checkout off the recorded commit',
      initialized: true,
      arrange: async (slot: AcquiredSlot) => {
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'moved'], join(slot.worktreePath, 'sub'));
        return ['sub is at', 'checkout --detach'];
      }
    },
    {
      finding: 'a repository kept inside the checkout',
      initialized: false,
      arrange: async (slot: AcquiredSlot) => {
        await rm(join(slot.worktreePath, 'sub'), { recursive: true, force: true });
        await fx.git(
          [...FILE_PROTOCOL, 'clone', '-q', '--recurse-submodules', join(remotes, 'sub.git'), 'sub'],
          slot.worktreePath
        );
        return ['sub keeps its repository inside its checkout', 'submodule absorbgitdirs -- sub'];
      }
    },
    {
      finding: 'a repository kept inside the checkout over an absorbed one',
      initialized: true,
      arrange: async (slot: AcquiredSlot) => {
        await rm(join(slot.worktreePath, 'sub'), { recursive: true, force: true });
        await fx.git([...FILE_PROTOCOL, 'clone', '-q', join(remotes, 'sub.git'), 'sub'], slot.worktreePath);
        return ['sub keeps its repository inside its checkout', 'then empty that directory'];
      },
      remedy: emptySub
    },
    {
      finding: 'untracked files in an uninitialized submodule directory',
      initialized: false,
      arrange: async (slot: AcquiredSlot) => {
        await writeFile(join(slot.worktreePath, 'sub', 'notes.txt'), 'notes');
        return ['sub is an uninitialized submodule directory holding files git does not track'];
      },
      remedy: async (slot: AcquiredSlot) => {
        await rename(join(slot.worktreePath, 'sub', 'notes.txt'), join(fx.scratch, 'notes.txt'));
      }
    }
  ])(
    'keeps a slot with $finding, and its remedy clears it',
    async ({ initialized, arrange, remedy }) => {
      const slot = await finishedSlot();
      if (initialized) await initialize(slot);
      const expected = await arrange(slot);

      for (const mode of ['preview', 'cleanup'] as const) {
        const decision = decisionOf(await pass(mode), slot);
        expect(decision).toMatchObject({ reason: 'submodules', outcome: 'preserved' });
        for (const text of expected) expect(decision.detail).toContain(text);
        expect(decision.detail).toMatch(/run Clean Up Worktrees again$/);
      }

      await runStatedCommands(decisionOf(await pass('preview'), slot).detail);
      await remedy?.(slot);

      expect(decisionOf(await pass(), slot)).toMatchObject(REMOVED);
      await expectGone(slot);
    },
    GIT_HEAVY_TIMEOUT_MS
  );

  it(
    'judges a submodule repository no checkout claims',
    async () => {
      const slot = await finishedSlot();
      await initialize(slot);
      const sub = join(slot.worktreePath, 'sub');
      await writeFile(join(sub, 'file.txt'), 'edited');
      await fx.git(['stash', '-q'], sub);
      // The checkout goes, its repository under the slot's git directory stays.
      await emptySub(slot);

      const decision = decisionOf(await pass(), slot);

      expect(decision).toMatchObject({ reason: 'submodules', outcome: 'preserved' });
      expect(decision.detail).toContain('modules/sub has stashed changes');
      expect(decision.detail).toContain('update-ref -d refs/stash');
      await runStatedCommands(decision.detail);
      expect(decisionOf(await pass(), slot)).toMatchObject(REMOVED);
      await expectGone(slot);
    },
    GIT_HEAVY_TIMEOUT_MS
  );
});

describe('cleanupCardSlots submodules changed after the judge', () => {
  /** A change made between the judge under the lock and the quarantine, and what the refusal says. */
  interface Race {
    readonly change: string;
    readonly reason: 'submodules' | 'uncommitted_changes';
    /**
     * Makes the change.
     * @param slot - The slot checkout, still at its own path.
     * @returns What the detail contains, and a check that the work is still at the slot path.
     */
    readonly make: (slot: string) => Promise<{ expected: string[]; intact: () => Promise<void> }>;
  }

  it.each<Race>([
    {
      change: 'a submodule commit',
      reason: 'submodules',
      make: async (slot) => {
        const sub = join(slot, 'sub');
        await fx.git(['checkout', '-q', '-b', 'work'], sub);
        await writeFile(join(sub, 'precious.txt'), 'unpushed work');
        await fx.git(['add', 'precious.txt'], sub);
        await fx.git(['commit', '-q', '-m', 'precious'], sub);
        const commit = await fx.git(['rev-parse', 'HEAD'], sub);
        return {
          expected: ['sub is at', `\`git -C ${sub} checkout --detach`],
          intact: async () => expect(await fx.git(['rev-parse', 'work'], sub)).toBe(commit)
        };
      }
    },
    {
      change: 'a nested submodule commit no remote-tracking ref reaches',
      reason: 'submodules',
      make: async (slot) => {
        const nested = join(slot, 'sub', 'nested');
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'local'], nested);
        await fx.git(['update-ref', 'refs/heads/side', 'HEAD'], nested);
        await fx.git(['checkout', '-q', '--detach', 'HEAD~'], nested);
        const commit = await fx.git(['rev-parse', 'side'], nested);
        return {
          expected: [`sub/nested has commit ${commit.slice(0, 12)}`, `\`git -C ${nested} push origin side\``],
          intact: async () => expect(await fx.git(['rev-parse', 'side'], nested)).toBe(commit)
        };
      }
    },
    {
      change: 'an uncommitted submodule file',
      reason: 'submodules',
      make: async (slot) => {
        const sub = join(slot, 'sub');
        await writeFile(join(sub, 'precious.txt'), 'uncommitted work');
        return {
          expected: ['sub has uncommitted or untracked changes', `\`git -C ${sub} clean -ffd\``],
          intact: async () => expect(await readFile(join(sub, 'precious.txt'), 'utf8')).toBe('uncommitted work')
        };
      }
    },
    {
      change: 'a submodule stash',
      reason: 'submodules',
      make: async (slot) => {
        const sub = join(slot, 'sub');
        await writeFile(join(sub, 'file.txt'), 'stashed work');
        await fx.git(['stash', '-q'], sub);
        return {
          expected: ['sub has stashed changes', `\`git -C ${sub} stash clear\``],
          intact: async () => expect(await fx.git(['stash', 'list'], sub)).not.toBe('')
        };
      }
    },
    {
      change: 'an uncommitted file in the slot itself',
      reason: 'uncommitted_changes',
      make: async (slot) => {
        await writeFile(join(slot, 'precious.txt'), 'uncommitted work');
        return {
          expected: ['Checkout has uncommitted changes: precious.txt', 'commit, stash or discard them'],
          intact: async () => expect(await readFile(join(slot, 'precious.txt'), 'utf8')).toBe('uncommitted work')
        };
      }
    }
  ])(
    'refuses a slot that gained $change after the judge, and puts it back intact',
    async ({ reason, make }) => {
      const slot = await finishedSlot();
      await initialize(slot);
      const race: { made: Awaited<ReturnType<Race['make']>> | null } = { made: null };
      // The fsmonitor stop comes after the judge under the lock and before the quarantine.
      fx.beforeGit = async (args) => {
        if (race.made === null && args.includes('fsmonitor--daemon')) race.made = await make(slot.worktreePath);
      };

      const decision = decisionOf(await pass(), slot);
      fx.beforeGit = null;

      if (race.made === null) throw new Error('The change was never made');
      const { expected, intact } = race.made;
      expect(decision).toMatchObject({ reason, outcome: 'preserved' });
      for (const text of expected) expect(decision.detail).toContain(text);
      expect(decision.detail).toMatch(/; then run Clean Up Worktrees again$/);
      await intact();
      expect(await fx.git(['branch', '--list', slot.branch])).not.toBe('');
      expect(await fx.git(['status', '--porcelain'], join(slot.worktreePath, 'sub', 'nested'))).toBe('');
      expect(await readdir(join(fx.slotRoot, '.purge'))).toEqual([]);
      expect((await readdir(fx.slotRoot)).filter((name) => name.includes('.deleting-'))).toEqual([]);
    },
    GIT_HEAVY_TIMEOUT_MS
  );
});

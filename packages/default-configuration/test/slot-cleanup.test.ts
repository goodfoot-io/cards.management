/**
 * `cleanupCardSlots` against real repositories and real slot locks: the
 * lock-free pre-check, per-reason preservation, removal, the requester's
 * slot, `locked` reports, failure isolation, the budget and the modes.
 *
 * @summary Slot cleanup acceptance tests
 * @module
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Logger, type WorktreeCleanupDecision } from '@cards.management/sdk';
import { readSlotLockSnapshot } from '@cards.management/sdk/slot-lock';
import {
  findSlotOccupants,
  OccupantProbeError,
  type OccupantProbeOptions,
  type ProcReader,
  removeQuarantinedSlot
} from '@cards.management/sdk/worktree-removal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AcquiredSlot,
  acquireSlot,
  cleanupCardSlots,
  type SlotCleanupOptions,
  type SlotCleanupResult,
  type SlotLayer
} from '../src/lib/worktrees/index.js';
import { createSlotFixture, type SlotFixture } from './helpers/slot-fixture.js';

let fx: SlotFixture;

beforeEach(async () => {
  fx = await createSlotFixture();
});

afterEach(async () => {
  await fx.dispose();
});

/**
 * Acquires a slot for one execution.
 * @param executionId - The acquiring execution.
 * @returns The held slot.
 */
function acquire(executionId: string): Promise<AcquiredSlot> {
  return acquireSlot(fx.input(executionId), { client: fx.client, logger: new Logger(), layer: fx.layer });
}

/**
 * Creates a slot and releases it, as a finished session leaves it.
 * @param executionId - The execution that used it.
 * @returns The released slot.
 */
async function finishedSlot(executionId: string): Promise<AcquiredSlot> {
  const slot = await acquire(executionId);
  await slot.lock.release();
  return slot;
}

/**
 * Runs a pass for the fixture's card.
 * @param options - Mode, requester and budget.
 * @returns The pass result.
 */
function pass(options: Partial<SlotCleanupOptions> = {}): Promise<SlotCleanupResult> {
  return cleanupCardSlots(fx.cleanupContext(), { requester: null, mode: 'cleanup', ...options });
}

/**
 * Whether a path exists.
 * @param path - Path to test.
 * @returns True when it exists.
 */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

/**
 * Finds the decision for a slot.
 * @param result - Pass result.
 * @param branch - Slot branch.
 * @returns Its decision.
 * @throws When the pass made no decision for the slot.
 */
function decisionOf(result: SlotCleanupResult, branch: string): WorktreeCleanupDecision {
  const decision = result.decisions.find((entry) => entry.branch === branch);
  if (decision === undefined) throw new Error(`No decision for ${branch}`);
  return decision;
}

/**
 * A layer whose occupant probes, the pass's own and the quarantined
 * checkout's, read the host's `/proc` as the kernel shows a process that is
 * not dumpable: its cwd, root and descriptors refuse with `EACCES`, its
 * world-readable `status` does not. A really undumpable process of this user
 * would make every concurrent test file's slots `in_use`, so only the
 * spawned process is hidden, and only from this pass.
 * @param hidden - The pid the kernel hides.
 * @param uid - The prober's effective uid; the test's own by default.
 * @returns The fixture's layer with those probes.
 */
function hidingLayer(hidden: number, uid?: number): SlotLayer {
  const refuse = (path: string): Promise<never> =>
    Promise.reject(Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' }));
  const hiddenEntry = new RegExp(`^/proc/${hidden}/(cwd|root|fd)(/|$)`);
  const proc: ProcReader = {
    readdir: (path) => (hiddenEntry.test(path) ? refuse(path) : readdir(path)),
    readlink: (path) => (hiddenEntry.test(path) ? refuse(path) : readlink(path)),
    readFile: (path) => readFile(path, 'utf8')
  };
  const occupants: OccupantProbeOptions = { proc, ...(uid === undefined ? {} : { uid }) };
  const removal = fx.layer.seams.removal;
  return {
    ...fx.layer,
    seams: {
      ...fx.layer.seams,
      removal: {
        ...removal,
        findSlotOccupants: (path) => findSlotOccupants(path, occupants),
        removeQuarantinedSlot: (target, options) => removeQuarantinedSlot(target, { ...options, occupants })
      }
    }
  };
}

/**
 * Lists a slot's lock generations.
 * @param ordinal - Slot ordinal.
 * @returns Generation directory names.
 */
async function generationsOf(ordinal: number): Promise<string[]> {
  return (await readdir(join(fx.slotRoot, '.locks', String(ordinal))).catch(() => [])).filter((name) =>
    /^\d+$/.test(name)
  );
}

describe('cleanupCardSlots preview', () => {
  it('reports a merged clean slot eligible and an unmerged one preserved, taking no locks', async () => {
    const merged = await acquire('exec-1');
    const unmerged = await acquire('exec-2');
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], unmerged.worktreePath);
    await merged.lock.release();
    await unmerged.lock.release();
    const before = [await generationsOf(1), await generationsOf(2)];

    const result = await pass({ mode: 'preview' });

    expect(result.ok).toBe(true);
    expect(decisionOf(result, merged.branch)).toMatchObject({ reason: 'eligible', outcome: 'eligible' });
    expect(decisionOf(result, unmerged.branch)).toMatchObject({ reason: 'unmerged_commits', outcome: 'preserved' });
    expect([await generationsOf(1), await generationsOf(2)]).toEqual(before);
  });

  it('reports a held slot locked, naming the holder execution', async () => {
    const held = await acquire('exec-holder');

    const result = await pass({ mode: 'preview' });

    expect(decisionOf(result, held.branch)).toMatchObject({ reason: 'locked', outcome: 'preserved' });
    expect(decisionOf(result, held.branch).detail).toContain('exec-holder');
  });

  it('counts unjudgeable locks and their unverified owners', async () => {
    const held = await acquire('exec-holder');
    const ownerPath = join(fx.slotRoot, '.locks', '1', String(held.lock.generation), 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { holder: Record<string, unknown> };
    owner.holder['startIdentity'] = null;
    await writeFile(ownerPath, JSON.stringify(owner));

    const result = await pass({ mode: 'preview' });

    expect(decisionOf(result, held.branch)).toMatchObject({ reason: 'lock_unknown', outcome: 'preserved' });
    expect(decisionOf(result, held.branch).detail).toContain('unverified owner');
    expect(result.unknownLocks).toEqual({ count: 1, unverifiedOwners: 1 });
  });

  it('lists no ordinal that has only a lock directory', async () => {
    await finishedSlot('exec-1');
    await mkdir(join(fx.slotRoot, '.locks', '9', '1'), { recursive: true });

    const result = await pass({ mode: 'preview' });

    expect(result.decisions.map((decision) => decision.branch)).toEqual(['cards/card-1/1']);
  });
});

describe('cleanupCardSlots preservation', () => {
  it('spares the requester slot', async () => {
    const own = await acquire('exec-own');

    const result = await pass({ requester: 'exec-own' });

    expect(decisionOf(result, own.branch)).toMatchObject({ reason: 'requester_slot', outcome: 'preserved' });
  });

  it('preserves a slot with uncommitted changes', async () => {
    const slot = await acquire('exec-1');
    await writeFile(join(slot.worktreePath, 'draft.txt'), 'draft');
    await slot.lock.release();

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({
      reason: 'uncommitted_changes',
      outcome: 'preserved'
    });
  });

  it('preserves a checkout whose HEAD left the slot branch', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['checkout', '-q', '--detach'], slot.worktreePath);
    await slot.lock.release();

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({ reason: 'head_off_branch', outcome: 'preserved' });
  });

  it('preserves a checkout whose worktree entry is locked, with the lock reason', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['worktree', 'lock', '--reason', 'kept by a test', slot.worktreePath]);
    await slot.lock.release();

    const decision = decisionOf(await pass(), slot.branch);

    expect(decision).toMatchObject({ reason: 'unusable_checkout', outcome: 'preserved' });
    expect(decision.detail).toContain('kept by a test');
  });

  it('preserves a slot branch checked out at another path as checked_out_elsewhere', async () => {
    const slot = await finishedSlot('exec-1');
    await fx.git(['worktree', 'remove', '--force', slot.worktreePath]);
    await fx.git(['worktree', 'add', '-q', join(fx.repoRoot, '..', 'elsewhere'), slot.branch]);

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({
      reason: 'checked_out_elsewhere',
      outcome: 'preserved'
    });
  });

  it('preserves an unregistered slot named by an invalid entry as invalid_entry', async () => {
    const slot = await finishedSlot('exec-1');
    fx.client.registrations.delete(slot.branch);
    fx.client.invalidEntries.push({ name: slot.branch, reason: 'unparseable' });

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({ reason: 'invalid_entry', outcome: 'preserved' });
  });

  it('skips a directory at a slot path that is not a checkout, keeping its content', async () => {
    const path = join(fx.slotRoot, '5');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'notes.txt'), 'not a checkout');

    const result = await pass();

    expect(decisionOf(result, 'cards/card-1/5')).toMatchObject({ reason: 'unusable_checkout', outcome: 'preserved' });
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('not a checkout');
  });

  it('preserves every unregistered slot when registrations cannot be read', async () => {
    const slot = await finishedSlot('exec-1');
    fx.client.failGetBranches = true;

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({ outcome: 'preserved' });
  });

  it('treats a slot whose legacy owner is running as locked', async () => {
    const slot = await finishedSlot('exec-1');
    const registration = fx.client.registrations.get(slot.branch);
    if (registration === undefined) throw new Error('slot not registered');
    registration.legacyExecutionOwner = 'legacy-exec';
    fx.client.executionStatus.set('legacy-exec', 'running');

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({ outcome: 'preserved' });
  });

  it('unregisters a registration whose ref and directory are both gone', async () => {
    const slot = await finishedSlot('exec-1');
    await fx.git(['worktree', 'remove', '--force', slot.worktreePath]);
    await fx.git(['branch', '-D', slot.branch]);

    // Preview predicts the unregistration without making it.
    expect(decisionOf(await pass({ mode: 'preview' }), slot.branch)).toMatchObject({
      reason: 'missing',
      outcome: 'eligible'
    });
    expect(fx.client.registrations.has(slot.branch)).toBe(true);

    const decision = decisionOf(await pass(), slot.branch);

    expect(decision).toMatchObject({ reason: 'missing', outcome: 'removed' });
    expect(fx.client.registrations.has(slot.branch)).toBe(false);
  });
});

describe('cleanupCardSlots next steps', () => {
  /** What every permanent refusal's detail ends with: the pass that then removes the slot. */
  const AGAIN = /run Clean Up Worktrees again$/;

  /**
   * Sets a slot's registered parent branch.
   * @param branch - Slot branch.
   * @param parentBranch - The parent to record.
   * @throws When the slot is not registered.
   */
  function setParent(branch: string, parentBranch: string): void {
    const registration = fx.client.registrations.get(branch);
    if (registration === undefined) throw new Error('slot not registered');
    registration.parentBranch = parentBranch;
  }

  it.each([
    {
      reason: 'unmerged_commits',
      arrange: (slot: AcquiredSlot) => fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], slot.worktreePath),
      step: (slot: AcquiredSlot) => [
        `merge ${slot.branch} into main`,
        `\`git -C ${slot.worktreePath} reset --hard main\``,
        `\`git -C ${slot.worktreePath} clean -ffd\``
      ]
    },
    {
      reason: 'uncommitted_changes',
      arrange: (slot: AcquiredSlot) => writeFile(join(slot.worktreePath, 'draft.txt'), 'draft'),
      step: (slot: AcquiredSlot) => ['commit, stash or discard', `\`git -C ${slot.worktreePath} reset --hard main\``]
    },
    {
      reason: 'head_off_branch',
      arrange: (slot: AcquiredSlot) => fx.git(['checkout', '-q', '--detach'], slot.worktreePath),
      step: (slot: AcquiredSlot) => [
        `\`git -C ${slot.worktreePath} switch --discard-changes ${slot.branch}\``,
        `\`git -C ${slot.worktreePath} reset --hard main\``
      ]
    },
    {
      reason: 'parent_branch_missing',
      arrange: async (slot: AcquiredSlot) => setParent(slot.branch, 'gone'),
      step: () => ['recreate gone in the main repository', '`git branch gone <commit>`']
    },
    {
      reason: 'invalid_entry',
      arrange: async (slot: AcquiredSlot) => {
        fx.client.registrations.delete(slot.branch);
        fx.client.invalidEntries.push({ name: slot.branch, reason: 'unparseable' });
      },
      step: () => ['under branches/ in the card repository']
    },
    {
      reason: 'checked_out_elsewhere',
      arrange: async (slot: AcquiredSlot) => {
        await fx.git(['worktree', 'remove', '--force', slot.worktreePath]);
        await fx.git(['worktree', 'add', '-q', join(fx.repoRoot, '..', 'elsewhere'), slot.branch]);
      },
      step: () => ['switch that checkout to another branch or remove it']
    },
    {
      reason: 'submodules',
      arrange: async (slot: AcquiredSlot) => {
        const head = await fx.git(['rev-parse', 'HEAD'], slot.worktreePath);
        await fx.git(['update-index', '--add', '--cacheinfo', `160000,${head},sub`], slot.worktreePath);
        await fx.git(['commit', '-q', '-m', 'gitlink'], slot.worktreePath);
        // An uninitialized submodule is an empty directory; without it, status reports the gitlink deleted.
        await mkdir(join(slot.worktreePath, 'sub'));
        await fx.git(['merge', '-q', '--ff-only', slot.branch]);
      },
      step: (slot: AcquiredSlot) => [
        'while main has submodules no pass removes this slot',
        `\`git -C ${slot.worktreePath} reset --hard main\``
      ]
    }
  ])('names the next step for $reason', async ({ reason, arrange, step }) => {
    const slot = await finishedSlot('exec-1');
    await arrange(slot);

    for (const mode of ['preview', 'cleanup'] as const) {
      const decision = decisionOf(await pass({ mode }), slot.branch);
      expect(decision).toMatchObject({ reason, outcome: 'preserved' });
      expect(decision.detail).toMatch(AGAIN);
      for (const text of step(slot)) expect(decision.detail).toContain(text);
    }
  });

  it('names the next step for in_use, in preview and in cleanup', async () => {
    const slot = await finishedSlot('exec-1');
    const { spawn } = await import('node:child_process');
    const occupant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: slot.worktreePath });
    try {
      for (const mode of ['preview', 'cleanup'] as const) {
        const decision = decisionOf(await pass({ mode }), slot.branch);
        expect(decision).toMatchObject({ reason: 'in_use', outcome: 'preserved' });
        expect(decision.detail).toContain(`pid ${occupant.pid}`);
        expect(decision.detail).toContain(`stop the processes working in ${slot.worktreePath}`);
        expect(decision.detail).toMatch(AGAIN);
      }
    } finally {
      occupant.kill('SIGKILL');
    }
  });

  /**
   * Runs the git commands a decision's next step names, as the user would,
   * with `<commit>` standing for the main branch.
   * @param detail - The decision's detail.
   * @returns How many commands ran.
   */
  async function runStatedCommands(detail: string): Promise<number> {
    const commands = [...detail.matchAll(/`(git [^`]+)`/g)].map(([, command]) => command ?? '');
    for (const command of commands) await fx.git(command.replace('<commit>', 'main').split(' ').slice(1));
    return commands.length;
  }

  it.each([
    {
      reason: 'unmerged_commits',
      arrange: (slot: AcquiredSlot) => fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], slot.worktreePath)
    },
    {
      reason: 'unmerged_commits',
      arrange: async (slot: AcquiredSlot) => {
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], slot.worktreePath);
        await fx.git(['update-ref', '-d', `refs/heads/${slot.branch}`]);
      }
    },
    {
      reason: 'uncommitted_changes',
      arrange: async (slot: AcquiredSlot) => {
        await writeFile(join(slot.worktreePath, 'draft.txt'), 'draft');
        await fx.git(['init', '-q', join(slot.worktreePath, 'nested')]);
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'nested'], join(slot.worktreePath, 'nested'));
      }
    },
    {
      reason: 'head_off_branch',
      arrange: async (slot: AcquiredSlot) => {
        await fx.git(['checkout', '-q', '--detach'], slot.worktreePath);
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'detached work'], slot.worktreePath);
        await writeFile(join(slot.worktreePath, 'draft.txt'), 'draft');
      }
    },
    {
      reason: 'parent_branch_missing',
      arrange: async (slot: AcquiredSlot) => {
        const registration = fx.client.registrations.get(slot.branch);
        if (registration === undefined) throw new Error('slot not registered');
        registration.parentBranch = 'gone';
      }
    }
  ])('removes a $reason slot once the git commands its next step names have run', async ({ reason, arrange }) => {
    const slot = await finishedSlot('exec-1');
    await arrange(slot);
    const refused = decisionOf(await pass(), slot.branch);
    expect(refused).toMatchObject({ reason, outcome: 'preserved' });

    expect(await runStatedCommands(refused.detail)).toBeGreaterThan(0);

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({ reason: 'eligible', outcome: 'removed' });
    expect(await exists(slot.worktreePath)).toBe(false);
    expect(fx.client.registrations.has(slot.branch)).toBe(false);
  });

  it('says the git-ignored files of a clean slot are deleted with it, in preview and in the removal', async () => {
    await writeFile(join(fx.repoRoot, '.gitignore'), '.env\n');
    await fx.git(['add', '.gitignore']);
    await fx.git(['commit', '-q', '-m', 'ignore .env']);
    const slot = await finishedSlot('exec-1');
    await writeFile(join(slot.worktreePath, '.env'), 'SECRET=1\n');
    const note = `git-ignored files in ${slot.worktreePath} are deleted with it`;

    const preview = decisionOf(await pass({ mode: 'preview' }), slot.branch);
    expect(preview).toMatchObject({ reason: 'eligible', outcome: 'eligible' });
    expect(preview.detail).toContain(note);

    const removed = decisionOf(await pass(), slot.branch);
    expect(removed).toMatchObject({ reason: 'eligible', outcome: 'removed' });
    expect(removed.detail).toContain(note);
    expect(await exists(slot.worktreePath)).toBe(false);
  });
});

describe('cleanupCardSlots removal', () => {
  it('removes a merged clean slot: checkout, ref and registration', async () => {
    const slot = await finishedSlot('exec-1');

    const result = await pass();

    expect(result.ok).toBe(true);
    expect(decisionOf(result, slot.branch)).toMatchObject({ reason: 'eligible', outcome: 'removed' });
    expect(fx.client.registrations.has(slot.branch)).toBe(false);
    expect(await fx.git(['branch', '--list', slot.branch])).toBe('');
  });

  it('removes an unregistered clean merged slot without calling removeBranch', async () => {
    const slot = await finishedSlot('exec-1');
    fx.client.registrations.delete(slot.branch);

    expect(decisionOf(await pass(), slot.branch)).toMatchObject({ outcome: 'removed' });
    expect(fx.client.calls.filter((call) => call.startsWith('removeBranch'))).toEqual([]);
  });

  it('refuses a slot with an occupant as in_use', async () => {
    const slot = await finishedSlot('exec-1');
    const { spawn } = await import('node:child_process');
    const occupant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: slot.worktreePath });
    try {
      expect(decisionOf(await pass(), slot.branch)).toMatchObject({ reason: 'in_use', outcome: 'preserved' });
    } finally {
      occupant.kill('SIGKILL');
    }
  });

  it.runIf(process.platform === 'linux')(
    'preserves a slot as in_use, in preview and cleanup, when one of the user’s own processes cannot be inspected',
    async () => {
      const slot = await finishedSlot('exec-1');
      const { spawn } = await import('node:child_process');
      const hidden = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: fx.scratch });
      try {
        const layer = hidingLayer(hidden.pid ?? 0);
        for (const mode of ['preview', 'cleanup'] as const) {
          const result = await cleanupCardSlots({ ...fx.cleanupContext(), layer }, { requester: null, mode });
          const decision = decisionOf(result, slot.branch);
          expect(decision).toMatchObject({ reason: 'in_use', outcome: 'preserved' });
          expect(decision.detail).toContain(`your own processes could not be inspected`);
          expect(decision.detail).toContain(`(pid ${hidden.pid})`);
          expect(decision.detail).toContain(`stop the processes working in ${slot.worktreePath}`);
          expect(decision.detail).not.toMatch(/\bclean\b/);
        }
        expect(await exists(slot.worktreePath)).toBe(true);
      } finally {
        hidden.kill('SIGKILL');
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'removes a slot past another user’s uninspectable process, counting it once for the pass and never in a detail',
    async () => {
      const slot = await finishedSlot('exec-1');
      const { spawn } = await import('node:child_process');
      const hidden = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: slot.worktreePath });
      try {
        // A prober whose uid is not the hidden process's owner sees it as another user's.
        const layer = hidingLayer(hidden.pid ?? 0, (process.geteuid?.() ?? 0) + 1);
        for (const mode of ['preview', 'cleanup'] as const) {
          const result = await cleanupCardSlots({ ...fx.cleanupContext(), layer }, { requester: null, mode });
          const decision = decisionOf(result, slot.branch);
          expect(decision).toMatchObject({ reason: 'eligible', outcome: mode === 'preview' ? 'eligible' : 'removed' });
          expect(decision.detail).not.toMatch(/process|inspect|prob/);
          expect(result.otherUsersNotInspected).toBeGreaterThanOrEqual(1);
        }
        expect(await exists(slot.worktreePath)).toBe(false);
      } finally {
        hidden.kill('SIGKILL');
      }
    }
  );

  it('preserves a slot as in_use when the occupant probe itself fails', async () => {
    const slot = await finishedSlot('exec-1');
    const removal = fx.layer.seams.removal;
    const layer: SlotLayer = {
      ...fx.layer,
      seams: {
        ...fx.layer.seams,
        removal: {
          ...removal,
          findSlotOccupants: () => Promise.reject(new OccupantProbeError('injected probe failure'))
        }
      }
    };

    const result = await cleanupCardSlots({ ...fx.cleanupContext(), layer }, { requester: null, mode: 'cleanup' });

    const decision = decisionOf(result, slot.branch);
    expect(decision).toMatchObject({ reason: 'in_use', outcome: 'preserved' });
    expect(decision.detail).toContain('injected probe failure');
    expect(await exists(slot.worktreePath)).toBe(true);
    expect(await fx.git(['branch', '--list', slot.branch])).not.toBe('');
    expect(fx.client.registrations.has(slot.branch)).toBe(true);
  });

  it('keeps the ref with the registration when the slot path is recreated during removal, then removes both', async () => {
    const slot = await finishedSlot('exec-1');
    const oid = await fx.git(['rev-parse', slot.branch]);
    let recreated = false;
    // An editor saves into the slot path after the checkout moved to quarantine.
    fx.beforeGit = async (args, cwd) => {
      if (recreated || args[0] !== 'status' || !cwd.includes('.deleting-')) return;
      recreated = true;
      await mkdir(slot.worktreePath);
      await writeFile(join(slot.worktreePath, 'stray.txt'), 'editor save');
    };

    const blocked = decisionOf(await pass(), slot.branch);
    fx.beforeGit = null;

    expect(recreated).toBe(true);
    expect(blocked).toMatchObject({ reason: 'removal_blocked', outcome: 'preserved' });
    expect(blocked.detail).toMatch(/keep anything wanted from .* and remove it, then run Clean Up Worktrees again$/);
    expect(await fx.git(['rev-parse', slot.branch])).toBe(oid);
    expect(fx.client.registrations.has(slot.branch)).toBe(true);
    expect(await readFile(join(slot.worktreePath, 'stray.txt'), 'utf8')).toBe('editor save');

    // Following the detail clears the state: the next pass removes the merged ref and the registration.
    await rm(slot.worktreePath, { recursive: true });
    const removed = decisionOf(await pass(), slot.branch);

    expect(removed).toMatchObject({ reason: 'eligible', outcome: 'removed' });
    expect(await fx.git(['branch', '--list', slot.branch])).toBe('');
    expect(fx.client.registrations.has(slot.branch)).toBe(false);
  });

  it('restores a slot whose held content changes during removal and reports it removal_restored', async () => {
    await writeFile(join(fx.repoRoot, 'notes.txt'), 'notes\n');
    await fx.git(['add', 'notes.txt']);
    await fx.git(['commit', '-q', '-m', 'notes']);
    const slot = await finishedSlot('exec-1');
    const removal = fx.layer.seams.removal;
    let wrote = false;
    const layer: SlotLayer = {
      ...fx.layer,
      seams: {
        ...fx.layer.seams,
        removal: {
          ...removal,
          removeQuarantinedSlot: (target, options) =>
            removal.removeQuarantinedSlot(target, {
              ...options,
              // The Git marker is taken last, so every other entry is already held: write into the held notes.
              checkpoint: async (entryPath) => {
                if (wrote || basename(entryPath) !== '.git') return;
                const holding = `${target.quarantine}.held`;
                for (const name of await readdir(holding)) {
                  if (!/^\d+$/.test(name)) continue;
                  const held = join(holding, name);
                  if ((await readFile(held, 'utf8')) !== 'notes\n') continue;
                  await writeFile(held, 'notes\nlate write\n');
                  wrote = true;
                }
              }
            })
        }
      }
    };

    const result = await cleanupCardSlots({ ...fx.cleanupContext(), layer }, { requester: null, mode: 'cleanup' });

    expect(wrote).toBe(true);
    expect(decisionOf(result, slot.branch)).toMatchObject({ reason: 'removal_restored', outcome: 'preserved' });
    expect(await readFile(join(slot.worktreePath, 'notes.txt'), 'utf8')).toBe('notes\nlate write\n');
    expect((await readdir(fx.slotRoot)).filter((name) => name.includes('.deleting-'))).toEqual([]);
    expect(await fx.git(['worktree', 'list', '--porcelain'])).toContain(slot.worktreePath);
    expect(await fx.git(['branch', '--list', slot.branch])).not.toBe('');
    expect(fx.client.registrations.has(slot.branch)).toBe(true);
  });

  it('recovers residue under the lock', async () => {
    const slot = await finishedSlot('exec-1');
    const quarantine = `${slot.worktreePath}.deleting-${randomUUID()}`;
    await fx.git(['worktree', 'move', slot.worktreePath, quarantine]);

    const result = await pass();

    expect(decisionOf(result, slot.branch).outcome).toBe('removed');
    expect(await readdir(fx.slotRoot)).not.toContain(basename(quarantine));
  });
});

describe('cleanupCardSlots failures and budget', () => {
  it('returns a discovery failure instead of rejecting', async () => {
    await finishedSlot('exec-1');
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') throw new Error('injected discovery failure');
    };

    const result = await pass();

    expect(result.failure).toMatchObject({ stage: 'discovery' });
    expect(result.failure?.message).toContain('injected discovery failure');
    expect(result.ok).toBe(false);
  });

  it('reports a slot whose checks throw as cleanup_failed and goes on', async () => {
    const failing = await acquire('exec-1');
    const other = await acquire('exec-2');
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], other.worktreePath);
    await failing.lock.release();
    await other.lock.release();
    fx.beforeGit = async (args, cwd) => {
      if (cwd === failing.worktreePath && args[0] === 'status') throw new Error('injected status failure');
    };

    const result = await pass();

    expect(decisionOf(result, failing.branch)).toMatchObject({ reason: 'cleanup_failed', outcome: 'failed' });
    expect(decisionOf(result, failing.branch).detail).toContain('injected status failure');
    expect(decisionOf(result, other.branch)).toMatchObject({ reason: 'unmerged_commits' });
  });

  it('reports slots not started within the budget as budget_exhausted without locking them', async () => {
    await finishedSlot('exec-1');
    const before = await generationsOf(1);

    const result = await pass({ budgetMs: 0 });

    expect(decisionOf(result, 'cards/card-1/1')).toMatchObject({ reason: 'budget_exhausted', outcome: 'preserved' });
    expect(await generationsOf(1)).toEqual(before);
  });

  it('fails prepare-delete on a preserved slot, on budget_exhausted and on a pass failure', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], slot.worktreePath);
    await slot.lock.release();

    expect((await pass({ mode: 'prepare-delete' })).ok).toBe(false);
    expect((await pass({ mode: 'prepare-delete', budgetMs: 0 })).ok).toBe(false);
  });

  it('treats the requester as absent in prepare-delete', async () => {
    const own = await acquire('exec-own');

    const result = await pass({ mode: 'prepare-delete', requester: 'exec-own' });

    expect(decisionOf(result, own.branch)).toMatchObject({ reason: 'locked' });
    expect(result.ok).toBe(false);
  });

  it('succeeds prepare-delete on a card without slots', async () => {
    const result = await pass({ mode: 'prepare-delete' });

    expect(result).toEqual({
      decisions: [],
      unknownLocks: { count: 0, unverifiedOwners: 0 },
      otherUsersNotInspected: 0,
      ok: true
    });
  });

  it('never removal-locks a slot it preserves, so concurrent launches reuse existing slots', async () => {
    const unmerged: AcquiredSlot[] = [];
    for (const executionId of ['exec-1', 'exec-2', 'exec-3']) {
      const slot = await acquire(executionId);
      await fx.git(['commit', '-q', '--allow-empty', '-m', `work of ${executionId}`], slot.worktreePath);
      unmerged.push(slot);
    }
    await finishedSlot('exec-4');
    for (const slot of unmerged) await slot.lock.release();

    const [, ...launches] = await Promise.all([pass(), acquire('exec-5'), acquire('exec-6')]);

    expect(launches.every((slot) => slot.outcome === 'reused')).toBe(true);
    expect(Math.max(...launches.map((slot) => slot.ordinal))).toBeLessThanOrEqual(4);
    const snapshots = await Promise.all([1, 2, 3].map((ordinal) => readSlotLockSnapshot(fx.slotRoot, ordinal)));
    for (const snapshot of snapshots)
      if (snapshot !== null && !('unreadable' in snapshot)) expect(snapshot.owner.purpose).toBe('work');
  });
});

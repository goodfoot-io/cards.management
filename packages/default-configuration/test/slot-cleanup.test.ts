/**
 * `cleanupCardSlots` against real repositories and real slot locks: the
 * lock-free pre-check, per-reason preservation, removal, the requester's
 * slot, `locked` reports, failure isolation, the budget and the modes.
 *
 * @summary Slot cleanup acceptance tests
 * @module
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Logger, type WorktreeCleanupDecision } from '@cards.management/sdk';
import { readSlotLockSnapshot } from '@cards.management/sdk/slot-lock';
import { OccupantProbeError } from '@cards.management/sdk/worktree-removal';
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

    expect(result).toEqual({ decisions: [], unknownLocks: { count: 0, unverifiedOwners: 0 }, ok: true });
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

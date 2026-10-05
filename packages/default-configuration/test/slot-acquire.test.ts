/**
 * `acquireSlot` against real repositories and real slot locks: LIFO reuse,
 * usability refusals, reattach, recreate, create, ordinal reservation, the
 * create-only ref, in-process rollback, handoff and legacy owners, and the
 * SDK provisioning the slot git runner drives.
 *
 * @summary Slot acquisition acceptance tests
 * @module
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@cards.management/sdk';
import { isProcessAbsent } from '@cards.management/sdk/process-identity';
import { acquireSlotLock, readSlotLockSnapshot } from '@cards.management/sdk/slot-lock';
import { captureOriginalHooksPath } from '@cards.management/sdk/worktree';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AcquiredSlot, acquireSlot, describeSkippedSlots } from '../src/lib/worktrees/index.js';
import { abandonSlotLock, createSlotFixture, type SlotFixture } from './helpers/slot-fixture.js';

let fx: SlotFixture;

beforeEach(async () => {
  fx = await createSlotFixture();
});

afterEach(async () => {
  await fx.dispose();
});

/**
 * Acquires a slot for one execution through the fixture's layer.
 * @param executionId - The acquiring execution.
 * @param overrides - Input fields to replace.
 * @returns The held slot.
 */
function acquire(executionId: string, overrides: Parameters<SlotFixture['input']>[1] = {}): Promise<AcquiredSlot> {
  return acquireSlot(fx.input(executionId, overrides), { client: fx.client, logger: new Logger(), layer: fx.layer });
}

/**
 * Reads a slot's current generation snapshot.
 * @param ordinal - Slot ordinal.
 * @returns Every file of the slot's newest generation.
 * @throws When the slot has no readable generation.
 */
async function snapshotOf(ordinal: number) {
  const snapshot = await readSlotLockSnapshot(fx.slotRoot, ordinal);
  if (snapshot === null || 'unreadable' in snapshot) throw new Error(`No readable generation for slot ${ordinal}`);
  return snapshot;
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
 * Reads a ref's oid.
 * @param branch - Branch name.
 * @returns The oid, or null when the ref is absent.
 */
async function oidOf(branch: string): Promise<string | null> {
  return fx.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => null);
}

describe('acquireSlot', () => {
  it('binds a created slot to its card through the SDK provisioning and the slot git runner', async () => {
    const slot = await acquire('exec-1');

    expect((await readFile(join(slot.worktreePath, '.cards', 'CARD_ID'), 'utf8')).trim()).toBe(fx.cardId);
    expect(await fx.git(['config', '--worktree', 'core.hooksPath'], slot.worktreePath)).toBe(fx.layer.sharedHooksDir);
    expect(await fx.git(['config', `branch.${slot.branch}.cardsParent`])).toBe('main');
    expect(await fx.git(['status', '--porcelain', '--untracked-files=all'], slot.worktreePath)).toBe('');
    await slot.lock.release();
  });

  it('rejects a failed slot git call with its numeric exit code, so an unset config key reads as unset', async () => {
    const runGit = fx.layer.git.provisioningRunner({});

    const failure = await runGit(fx.repoRoot, ['config', 'core.hooksPath']).catch((error: unknown) => error);

    expect(failure).toMatchObject({ exitCode: 1 });
    expect(await captureOriginalHooksPath(fx.repoRoot, runGit)).toBe(join(fx.repoRoot, '.git', 'hooks'));
  });

  it('creates, registers and provisions ordinal 1 for a card without slots, and clears its intent', async () => {
    const slot = await acquire('exec-1');

    expect(slot).toMatchObject({
      ordinal: 1,
      branch: 'cards/card-1/1',
      worktreePath: join(fx.slotRoot, '1'),
      parentBranch: 'main',
      outcome: 'created',
      skipped: [],
      handoffLost: null
    });
    expect(await oidOf('cards/card-1/1')).toBe(await oidOf('main'));
    expect(await fx.git(['rev-parse', '--abbrev-ref', 'HEAD'], slot.worktreePath)).toBe('cards/card-1/1');
    expect(fx.client.registrations.get('cards/card-1/1')).toMatchObject({
      worktree: slot.worktreePath,
      parentBranch: 'main'
    });
    expect(fx.provisioned).toHaveLength(1);
    expect(fx.provisioned[0]).toMatchObject({ branch: 'cards/card-1/1', worktreePath: slot.worktreePath });
    expect((await snapshotOf(1)).creating).toBeNull();
  });

  it('reuses the most recently released free slot first (LIFO)', async () => {
    const [one, two, three] = [await acquire('exec-1'), await acquire('exec-2'), await acquire('exec-3')];
    expect([one.ordinal, two.ordinal, three.ordinal]).toEqual([1, 2, 3]);
    for (const slot of [two, three, one]) {
      await slot.lock.release();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    const next = await acquire('exec-4');

    expect(next).toMatchObject({ ordinal: 1, outcome: 'reused' });
    expect(fx.provisioned).toHaveLength(3);
  });

  it('passes over a held slot and creates the next ordinal', async () => {
    await acquire('exec-1');

    expect(await acquire('exec-2')).toMatchObject({ ordinal: 2, outcome: 'created' });
  });

  it('gives two concurrent acquires different slots, both for one free slot and for one new ordinal', async () => {
    const first = await acquire('exec-1');
    await first.lock.release();

    const reuse = await Promise.all([acquire('exec-2'), acquire('exec-3')]);
    expect(new Set(reuse.map((slot) => slot.ordinal)).size).toBe(2);
    expect(reuse.map((slot) => slot.outcome).sort()).toEqual(['created', 'reused']);

    const fresh = await Promise.all([acquire('exec-4'), acquire('exec-5')]);
    expect(new Set([...reuse, ...fresh].map((slot) => slot.ordinal)).size).toBe(4);
  });

  it('passes over a head_off_branch checkout and keeps its detached commit', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['checkout', '-q', '--detach'], slot.worktreePath);
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'detached work'], slot.worktreePath);
    const detached = await fx.git(['rev-parse', 'HEAD'], slot.worktreePath);
    await slot.lock.release();

    const next = await acquire('exec-2');

    expect(next.ordinal).toBe(2);
    expect(await fx.git(['rev-parse', 'HEAD'], slot.worktreePath)).toBe(detached);
  });

  it('treats a checkout whose worktree entry is locked as unusable', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['worktree', 'lock', '--reason', 'held by a test', slot.worktreePath]);
    await slot.lock.release();

    const next = await acquire('exec-2');

    expect(next.ordinal).toBe(2);
    expect(await exists(slot.worktreePath)).toBe(true);
  });

  it('reattaches a free slot whose checkout is gone, keeping the commits on its ref', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'slot work'], slot.worktreePath);
    const tip = await oidOf(slot.branch);
    await slot.lock.release();
    await rm(slot.worktreePath, { recursive: true, force: true });

    const next = await acquire('exec-2');

    expect(next).toMatchObject({ ordinal: 1, outcome: 'reattached' });
    expect(await fx.git(['rev-parse', 'HEAD'], next.worktreePath)).toBe(tip);
    expect((await snapshotOf(1)).creating).toBeNull();
  });

  it('recreates a free registered slot whose ref and checkout are gone', async () => {
    const slot = await acquire('exec-1');
    await slot.lock.release();
    await fx.git(['worktree', 'remove', '--force', slot.worktreePath]);
    await fx.git(['branch', '-D', slot.branch]);

    const next = await acquire('exec-2');

    expect(next).toMatchObject({ ordinal: 1, outcome: 'recreated' });
    expect(await oidOf(slot.branch)).toBe(await oidOf('main'));
  });

  it('reserves ordinals past an unregistered ref, an invalid entry, a .deleting directory and a lock directory', async () => {
    await fx.git(['branch', 'cards/card-1/3', 'main']);
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'unmerged'], fx.repoRoot);
    await fx.git(['update-ref', 'refs/heads/cards/card-1/3', 'HEAD']);
    await fx.git(['reset', '-q', '--hard', 'HEAD~1']);
    const unmerged = await oidOf('cards/card-1/3');
    fx.client.invalidEntries.push({ name: 'cards/card-1/5', reason: 'unparseable' });
    await mkdir(join(fx.slotRoot, '6.deleting-test'), { recursive: true });
    const reservation = await acquireSlotLock(fx.slotRoot, 7, {
      executionId: 'exec-reserve',
      cardId: fx.cardId,
      purpose: 'removal',
      environment: fx.layer.lockEnvironment ?? {}
    });
    if (reservation.status !== 'acquired') throw new Error('reservation lock not acquired');
    await reservation.lock.release();

    const slot = await acquire('exec-1');

    expect(slot.ordinal).toBe(8);
    expect(await oidOf('cards/card-1/3')).toBe(unmerged);
  });

  it('leaves a ref created behind its back untouched and moves to the next ordinal (create-only)', async () => {
    let foreign: string | null = null;
    fx.beforeGit = async (args) => {
      if (args[0] === 'update-ref' && args[1] === 'refs/heads/cards/card-1/1' && foreign === null) {
        await fx.git(['commit', '-q', '--allow-empty', '-m', 'foreign'], fx.repoRoot);
        foreign = await fx.git(['rev-parse', 'HEAD']);
        await fx.git(['update-ref', 'refs/heads/cards/card-1/1', foreign]);
        await fx.git(['reset', '-q', '--hard', 'HEAD~1']);
      }
    };

    const slot = await acquire('exec-1');

    expect(slot.ordinal).toBe(2);
    expect(await oidOf('cards/card-1/1')).toBe(foreign);
    expect(fx.client.registrations.has('cards/card-1/1')).toBe(false);
  });

  it('rolls back a create whose worktree add fails, deleting only the ref it created', async () => {
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add') throw new Error('injected worktree add failure');
    };

    await expect(acquire('exec-1')).rejects.toThrow('injected worktree add failure');

    expect(await oidOf('cards/card-1/1')).toBeNull();
    expect(await exists(join(fx.slotRoot, '1'))).toBe(false);
    expect(fx.client.registrations.size).toBe(0);
    expect((await snapshotOf(1)).creating).toBeNull();
  });

  it('rolls back a create whose provisioning fails, including its checkout', async () => {
    fx.beforeProvision = async () => {
      throw new Error('injected provisioning failure');
    };

    await expect(acquire('exec-1')).rejects.toThrow('injected provisioning failure');

    expect(await oidOf('cards/card-1/1')).toBeNull();
    expect(await exists(join(fx.slotRoot, '1'))).toBe(false);
    expect(await fx.git(['worktree', 'list', '--porcelain'])).not.toContain(join(fx.slotRoot, '1'));
    expect((await snapshotOf(1)).creating).toBeNull();
  });

  it('keeps the ref of a failed reattach', async () => {
    const slot = await acquire('exec-1');
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'slot work'], slot.worktreePath);
    const tip = await oidOf(slot.branch);
    await slot.lock.release();
    await rm(slot.worktreePath, { recursive: true, force: true });
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes(slot.worktreePath))
        throw new Error('injected reattach failure');
    };

    const next = await acquire('exec-2');

    expect(next.ordinal).toBe(2);
    expect(await oidOf(slot.branch)).toBe(tip);
    expect(fx.client.registrations.has(slot.branch)).toBe(true);
  });

  it('counts a registration whose response was lost as registered', async () => {
    fx.client.failAfterAddBranch = true;

    const slot = await acquire('exec-1');

    expect(slot).toMatchObject({ ordinal: 1, outcome: 'created' });
    expect(fx.client.registrations.has(slot.branch)).toBe(true);
  });

  it('preserves stray content found at the slot path during a create and never reuses that ordinal', async () => {
    const path = join(fx.slotRoot, '1');
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes(path)) {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'notes.txt'), 'not ours');
      }
    };

    await expect(acquire('exec-1')).rejects.toThrow();
    fx.beforeGit = null;

    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('not ours');
    expect((await acquire('exec-2')).ordinal).toBe(2);
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('not ours');
  });

  it('removes the empty entry-less directory a failed worktree add leaves at the slot path', async () => {
    const path = join(fx.slotRoot, '1');
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes(path)) {
        await mkdir(path, { recursive: true });
        throw new Error('injected worktree add failure after mkdir');
      }
    };

    await expect(acquire('exec-1')).rejects.toThrow('injected worktree add failure after mkdir');

    expect(await exists(path)).toBe(false);
    expect(await oidOf('cards/card-1/1')).toBeNull();
  });

  describe('a worktree add that outlives its deadline', () => {
    /**
     * Acquires with a short checkout deadline and asserts the create was rolled back.
     * @param pidFile - Where the stalled process wrote its PID.
     */
    async function expectTimedOutCreateRolledBack(pidFile: string): Promise<void> {
      await expect(
        acquireSlot(fx.input('exec-1'), {
          client: fx.client,
          logger: new Logger(),
          layer: { ...fx.layer, checkoutTimeoutMs: 1_500 }
        })
      ).rejects.toThrow('timed out');

      const path = join(fx.slotRoot, '1');
      expect(await exists(path)).toBe(false);
      expect(await fx.git(['worktree', 'list', '--porcelain'])).not.toContain(path);
      expect(await oidOf('cards/card-1/1')).toBeNull();
      expect(fx.client.registrations.size).toBe(0);
      const left = await snapshotOf(1);
      expect(left.creating).toBeNull();
      expect(left.released).not.toBeNull();
      // The stalled process was in git's tree, so the deadline ended it.
      const stalled = Number((await readFile(pidFile, 'utf8')).trim());
      expect(stalled).toBeGreaterThan(1);
      // Its new parent may take a moment to reap it.
      const deadline = Date.now() + 5_000;
      while (!isProcessAbsent(stalled) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(isProcessAbsent(stalled)).toBe(true);
    }

    it('rolls back a create whose smudge filter stalls the checkout', async () => {
      const pidFile = join(fx.scratch, 'smudge.pid');
      await writeFile(join(fx.repoRoot, '.gitattributes'), '*.slow filter=slow\n');
      await writeFile(join(fx.repoRoot, 'data.slow'), 'content\n');
      await fx.git(['add', '.gitattributes', 'data.slow']);
      await fx.git(['commit', '-q', '-m', 'slow file']);
      await fx.git(['config', 'filter.slow.clean', 'cat']);
      await fx.git(['config', 'filter.slow.smudge', `sh -c 'echo $$ > "${pidFile}"; exec sleep 600'`]);

      await expectTimedOutCreateRolledBack(pidFile);
    });

    it('rolls back a create whose post-checkout hook waits on a process it backgrounded', async () => {
      const pidFile = join(fx.scratch, 'hook.pid');
      const hook = join(fx.repoRoot, '.git', 'hooks', 'post-checkout');
      await writeFile(hook, `#!/bin/sh\nsleep 600 &\necho $! > "${pidFile}"\nwait\n`);
      await chmod(hook, 0o755);

      await expectTimedOutCreateRolledBack(pidFile);
    });
  });

  it('uses the main repository slot root when REPO_ROOT is a linked worktree', async () => {
    const linked = join(fx.repoRoot, '..', 'linked');
    await fx.git(['worktree', 'add', '-q', '-b', 'linked', linked]);

    const slot = await acquire('exec-1', { repoRoot: linked });

    expect(slot.worktreePath).toBe(join(fx.slotRoot, '1'));
  });

  it('treats a slot whose legacy owner is running as held and one whose owner is terminal as free', async () => {
    const slot = await acquire('exec-1');
    await slot.lock.release();
    const registration = fx.client.registrations.get(slot.branch);
    if (registration === undefined) throw new Error('slot not registered');
    registration.legacyExecutionOwner = 'legacy-exec';
    fx.client.executionStatus.set('legacy-exec', 'running');

    expect((await acquire('exec-2')).ordinal).toBe(2);

    fx.client.executionStatus.set('legacy-exec', 'terminal');
    expect(await acquire('exec-3')).toMatchObject({ ordinal: 1, outcome: 'reused' });
  });

  it('keeps the slot of a dead handler whose agent group is alive held', async () => {
    const slot = await acquire('exec-1');
    // The owner's PID is dead, but its recorded group is this live test process's.
    await abandonSlotLock(slot.lock);
    const ownerPath = join(fx.slotRoot, '.locks', '1', String(slot.lock.generation), 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { holder: Record<string, unknown> };
    owner.holder = { ...owner.holder, processGroupId: slot.lock.owner.holder.processGroupId };
    await writeFile(ownerPath, JSON.stringify(owner));

    expect((await acquire('exec-2')).ordinal).toBe(2);
  });

  it('takes over the slot of a dead handler and finishes the creation it left', async () => {
    const slot = await acquire('exec-1');
    await slot.lock.writeIntent({
      version: 1,
      op: 'reattach',
      branch: slot.branch,
      path: slot.worktreePath,
      createdOid: null,
      registeredBefore: true
    });
    await abandonSlotLock(slot.lock);

    const next = await acquire('exec-2');

    // The interrupted reattach's checkout is rolled back, never reused, and the slot is reattached afresh.
    expect(next).toMatchObject({ ordinal: 1, outcome: 'reattached' });
    expect((await snapshotOf(1)).creating).toBeNull();
  });

  it('formats skipped unjudgeable slots for the launch output', () => {
    expect(describeSkippedSlots([])).toBeNull();
    expect(
      describeSkippedSlots([
        { ordinal: 3, reason: 'holder probe timed out' },
        { ordinal: 5, reason: 'unverified owner, PID alive' }
      ])
    ).toBe('2 slots skipped as unjudgeable: 3 (holder probe timed out), 5 (unverified owner, PID alive)');
  });
});

describe('acquireSlot handoff', () => {
  it('lands the successor in the source checkout while the source is alive', async () => {
    const source = await acquire('exec-1');
    const { generation, token } = await source.lock.offerHandoff();

    const successor = await acquire('exec-2', {
      switchToInteractiveData: {
        sessionId: 'session-1',
        slot: { ordinal: 1, branch: source.branch, worktreePath: source.worktreePath, generation, token }
      }
    });

    expect(successor).toMatchObject({ ordinal: 1, outcome: 'handoff', handoffLost: null });
    expect(successor.worktreePath).toBe(source.worktreePath);
  });

  it('lands the successor in the source checkout after the source died within the expiry', async () => {
    const source = await acquire('exec-1');
    const { generation, token } = await source.lock.offerHandoff();
    await abandonSlotLock(source.lock);

    const successor = await acquire('exec-2', {
      switchToInteractiveData: {
        sessionId: 'session-1',
        slot: { ordinal: 1, branch: source.branch, worktreePath: source.worktreePath, generation, token }
      }
    });

    expect(successor).toMatchObject({ ordinal: 1, outcome: 'handoff' });
  });

  it('still claims an expired, untaken handoff', async () => {
    const source = await acquire('exec-1');
    const { generation, token } = await source.lock.offerHandoff();
    await abandonSlotLock(source.lock);
    const handoffPath = join(fx.slotRoot, '.locks', '1', String(generation), 'handoff.json');
    await writeFile(handoffPath, JSON.stringify({ token, expiresAt: new Date(Date.now() - 1_000).toISOString() }));

    const successor = await acquire('exec-2', {
      switchToInteractiveData: {
        sessionId: 'session-1',
        slot: { ordinal: 1, branch: source.branch, worktreePath: source.worktreePath, generation, token }
      }
    });

    expect(successor).toMatchObject({ ordinal: 1, outcome: 'handoff' });
  });

  it('reports handoff_lost and acquires normally when another acquirer took the expired slot', async () => {
    const source = await acquire('exec-1');
    const { generation, token } = await source.lock.offerHandoff();
    await abandonSlotLock(source.lock);
    const handoffPath = join(fx.slotRoot, '.locks', '1', String(generation), 'handoff.json');
    await writeFile(handoffPath, JSON.stringify({ token, expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const taker = await acquire('exec-2');
    expect(taker.ordinal).toBe(1);

    const successor = await acquire('exec-3', {
      switchToInteractiveData: {
        sessionId: 'session-1',
        slot: { ordinal: 1, branch: source.branch, worktreePath: source.worktreePath, generation, token }
      }
    });

    expect(successor.ordinal).toBe(2);
    expect(successor.handoffLost).toMatch(/^handoff_lost/);
  });
});

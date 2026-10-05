/**
 * `recoverCreationIntent` on the state each interrupted creation step leaves,
 * built in real repositories: the next holder rolls back what the creator
 * made, never what it did not, and never unregisters a finished create.
 *
 * @summary Creation-intent recovery acceptance tests
 * @module
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireSlotLock, type SlotCreationIntent, type SlotLock } from '@cards.management/sdk/slot-lock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CreationContext, recoverCreationIntent } from '../src/lib/worktrees/intent.js';
import { createSlotFixture, type SlotFixture } from './helpers/slot-fixture.js';

let fx: SlotFixture;
let lock: SlotLock;
let context: CreationContext;

const BRANCH = 'cards/card-1/1';

beforeEach(async () => {
  fx = await createSlotFixture();
  const result = await acquireSlotLock(fx.slotRoot, 1, {
    executionId: 'exec-recover',
    cardId: fx.cardId,
    purpose: 'work',
    environment: fx.layer.lockEnvironment ?? {}
  });
  if (result.status !== 'acquired') throw new Error(`lock not acquired: ${result.status}`);
  lock = result.lock;
  context = {
    git: fx.layer.git,
    client: fx.client,
    place: { cardId: fx.cardId, repoRoot: fx.repoRoot, slotRoot: fx.slotRoot },
    log: () => {}
  };
});

afterEach(async () => {
  await lock.release();
  await fx.dispose();
});

/**
 * The intent a creator of slot 1 writes.
 * @param op - Creation kind.
 * @param createdOid - Oid the ref is created at; null for a reattach.
 * @returns A version 1 intent for `cards/card-1/1` at the slot path.
 */
function intentFor(op: SlotCreationIntent['op'], createdOid: string | null): SlotCreationIntent {
  return {
    version: 1,
    op,
    branch: BRANCH,
    path: join(fx.slotRoot, '1'),
    createdOid,
    registeredBefore: op !== 'create'
  };
}

/**
 * Runs recovery as the next holder.
 * @param intent - The interrupted creation.
 * @returns The recovery outcome.
 */
function recover(intent: SlotCreationIntent) {
  return lock.operation('recovery', () => recoverCreationIntent(lock, intent, 'exec-dead', context));
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
 * Reads the slot ref.
 * @returns Its oid, or null when absent.
 */
function slotOid(): Promise<string | null> {
  return fx.git(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]).catch(() => null);
}

describe('recoverCreationIntent', () => {
  it.skip('rolls back an intent written before any git step', async () => {
    const main = await fx.git(['rev-parse', 'main']);

    expect(await recover(intentFor('create', main))).toEqual({ status: 'rolled_back' });
    expect(await slotOid()).toBeNull();
  });

  it.skip('deletes a ref created at createdOid', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);

    expect(await recover(intentFor('create', main))).toEqual({ status: 'rolled_back' });
    expect(await slotOid()).toBeNull();
  });

  it.skip('keeps a ref that moved past createdOid', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);
    await fx.git(['commit', '-q', '--allow-empty', '-m', 'moved'], fx.repoRoot);
    const moved = await fx.git(['rev-parse', 'HEAD']);
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, moved]);

    const outcome = await recover(intentFor('create', main));

    expect(outcome.status).toBe('creation_residue');
    expect(await slotOid()).toBe(moved);
  });

  it.skip('removes the checkout and entry a create added, then its ref', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);
    await fx.git(['worktree', 'add', '-q', path, BRANCH]);

    expect(await recover(intentFor('create', main))).toEqual({ status: 'rolled_back' });
    expect(await exists(path)).toBe(false);
    expect(await fx.git(['worktree', 'list', '--porcelain'])).not.toContain(path);
    expect(await slotOid()).toBeNull();
  });

  it.skip('removes a checkout whose add was interrupted while its entry is locked initializing', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);
    await fx.git(['worktree', 'add', '-q', path, BRANCH]);
    await fx.git(['worktree', 'lock', '--reason', 'initializing', path]);

    expect(await recover(intentFor('create', main))).toEqual({ status: 'rolled_back' });
    expect(await exists(path)).toBe(false);
  });

  it.skip('only clears the intent of a create that finished registration', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);
    await fx.git(['worktree', 'add', '-q', path, BRANCH]);
    await fx.client.addBranch(fx.cardId, { intent: 'create', name: BRANCH, worktree: path, parentBranch: 'main' });

    expect(await recover(intentFor('create', main))).toEqual({ status: 'completed' });
    expect(await exists(path)).toBe(true);
    expect(await slotOid()).toBe(main);
    expect(fx.client.calls.filter((call) => call.startsWith('removeBranch'))).toEqual([]);
  });

  it.skip('rolls back a recreate without unregistering the slot', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await fx.client.addBranch(fx.cardId, { intent: 'create', name: BRANCH, worktree: path, parentBranch: 'main' });
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);
    await fx.git(['worktree', 'add', '-q', path, BRANCH]);

    expect(await recover(intentFor('recreate', main))).toEqual({ status: 'rolled_back' });
    expect(await slotOid()).toBeNull();
    expect(fx.client.registrations.has(BRANCH)).toBe(true);
  });

  it.skip('rolls back a reattach by removing its checkout and keeping its ref', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await fx.git(['update-ref', `refs/heads/${BRANCH}`, main, '']);
    await fx.git(['worktree', 'add', '-q', path, BRANCH]);

    expect(await recover(intentFor('reattach', null))).toEqual({ status: 'rolled_back' });
    expect(await exists(path)).toBe(false);
    expect(await slotOid()).toBe(main);
  });

  it.skip('preserves an entry-less directory with content and reports creation_residue', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'notes.txt'), 'not ours');

    const outcome = await recover(intentFor('create', main));

    expect(outcome.status).toBe('creation_residue');
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('not ours');
  });

  it.skip('removes an empty entry-less directory', async () => {
    const main = await fx.git(['rev-parse', 'main']);
    const path = join(fx.slotRoot, '1');
    await mkdir(path, { recursive: true });

    expect(await recover(intentFor('create', main))).toEqual({ status: 'rolled_back' });
    expect(await exists(path)).toBe(false);
  });
});

/**
 * Creation intents: the `creating.json` a holder writes before the first git
 * mutation of a create, recreate or reattach, and the recovery that undoes an
 * interrupted one under the next lock of that ordinal.
 *
 * @summary Creation-intent recovery and in-process rollback of slot creations
 * @module
 */

import { rmdir } from 'node:fs/promises';
import type { SlotCreationIntent, SlotLock } from '@cards.management/sdk/slot-lock';
import { listWorktreeEntries, pathExists, refOid, samePath } from './checkout.js';
import type { SlotPlace } from './discovery.js';
import { type RegistrationClient, unregisterSlot } from './registration.js';
import type { SlotGit } from './slot-git.js';

/** What creation recovery needs. */
export interface CreationContext {
  readonly git: SlotGit;
  readonly client: RegistrationClient;
  readonly place: SlotPlace;
  /** Structured log line. */
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** Outcome of recovering or rolling back one creation. */
export type CreationRecovery =
  /** The create had finished; only the intent was cleared. */
  | { readonly status: 'completed' }
  /** The ref, admin entry and directory the creation made are gone. */
  | { readonly status: 'rolled_back' }
  /** Rolled back, but a non-empty directory without an entry, or a ref that gained commits, stays. */
  | { readonly status: 'creation_residue'; readonly detail: string };

/**
 * Undoes the git side of a creation: the admin entry and checkout at its path,
 * an empty entry-less directory, and a ref still at the oid the creation made.
 * @param lock - The ordinal's held lock.
 * @param intent - The creation to undo.
 * @param context - Git, client, place and log.
 * @returns Rolled back, or the residue left at the path.
 */
async function undoCreation(
  lock: SlotLock,
  intent: SlotCreationIntent,
  context: CreationContext
): Promise<CreationRecovery> {
  const { git, place } = context;
  const mutate = { record: (event: Parameters<SlotLock['recordGit']>[0]) => lock.recordGit(event) };
  let hasEntry = false;
  for (const entry of await listWorktreeEntries(git, place.repoRoot)) {
    if (await samePath(entry.path, intent.path)) hasEntry = true;
  }
  if (hasEntry) {
    lock.checkpoint();
    const removed = await git.run(place.repoRoot, ['worktree', 'remove', '-f', '-f', intent.path], mutate);
    if (removed.exitCode !== 0 && !/is not a working tree/.test(removed.stderr))
      throw new Error(`git worktree remove -f -f ${intent.path} failed: ${removed.stderr.trim()}`);
  }
  let residue: string | null = null;
  if (await pathExists(intent.path)) {
    lock.checkpoint();
    try {
      // rmdir only: an entry-less directory's origin is uncertain, so content is never deleted [G8].
      await rmdir(intent.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOTDIR') throw error;
      residue = `${intent.path} is a non-empty directory without a git worktree entry, left by an interrupted ${intent.op}; it is preserved`;
    }
  }
  const current = intent.createdOid === null ? null : await refOid(git, place.repoRoot, intent.branch);
  if (current !== null && current !== intent.createdOid) {
    const moved = `refs/heads/${intent.branch} moved from ${intent.createdOid} to ${current} after an interrupted ${intent.op}; it is preserved`;
    residue = residue === null ? moved : `${residue}; ${moved}`;
  }
  if (intent.createdOid !== null && current === intent.createdOid) {
    lock.checkpoint();
    // The oid guard leaves a ref that gained commits untouched.
    const deleted = await git.run(
      place.repoRoot,
      ['update-ref', '-d', `refs/heads/${intent.branch}`, intent.createdOid],
      mutate
    );
    if (deleted.exitCode !== 0 && (await refOid(git, place.repoRoot, intent.branch)) === intent.createdOid)
      throw new Error(`git update-ref -d refs/heads/${intent.branch} failed: ${deleted.stderr.trim()}`);
  }
  return residue === null ? { status: 'rolled_back' } : { status: 'creation_residue', detail: residue };
}

/**
 * Recovers an interrupted creation carried into this lock's generation. Never
 * unregisters: a create that registered is complete, and a recreate or
 * reattach keeps the registration it started with.
 * @param lock - The ordinal's held lock (`work` or `removal`).
 * @param intent - The carried `creating.json`.
 * @param creator - Execution of the dead or released creator, for the log.
 * @param context - Git, client, place and log.
 * @returns How the creation was settled.
 */
export async function recoverCreationIntent(
  lock: SlotLock,
  intent: SlotCreationIntent,
  creator: string | null,
  context: CreationContext
): Promise<CreationRecovery> {
  if (intent.op === 'create' && !intent.registeredBefore) {
    const { branches } = await context.client.getBranches(context.place.cardId);
    if (branches.some((branch) => branch.name === intent.branch)) {
      await lock.clearIntent();
      context.log('Slot creation had completed; intent cleared', { branch: intent.branch, creator });
      return { status: 'completed' };
    }
  }
  const outcome = await undoCreation(lock, intent, context);
  lock.checkpoint();
  await lock.clearIntent();
  context.log('Interrupted slot creation recovered', {
    branch: intent.branch,
    op: intent.op,
    path: intent.path,
    creator,
    outcome: outcome.status,
    ...(outcome.status === 'creation_residue' ? { detail: outcome.detail } : {})
  });
  return outcome;
}

/**
 * Rolls back this handler's own failed creation, as one slot operation: the
 * same steps as recovery, plus unregistration when this attempt registered.
 * Once the fence has closed it does not start, or stops at its next
 * checkpoint, and the intent stays for the next holder.
 * @param lock - The ordinal's held lock.
 * @param intent - The in-memory intent of the failed creation.
 * @param registered - Whether this attempt's `addBranch` succeeded.
 * @param context - Git, client, place and log.
 * @returns How the creation was undone.
 */
export function rollbackCreation(
  lock: SlotLock,
  intent: SlotCreationIntent,
  registered: boolean,
  context: CreationContext
): Promise<CreationRecovery> {
  return lock.operation(`rollback of ${intent.op} ${intent.branch}`, async () => {
    if (registered) {
      lock.checkpoint();
      await unregisterSlot(context.client, context.place.cardId, intent.branch);
    }
    const outcome = await undoCreation(lock, intent, context);
    lock.checkpoint();
    await lock.clearIntent();
    context.log('Failed slot creation rolled back', {
      branch: intent.branch,
      op: intent.op,
      outcome: outcome.status,
      ...(outcome.status === 'creation_residue' ? { detail: outcome.detail } : {})
    });
    return outcome;
  });
}

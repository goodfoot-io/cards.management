/**
 * Slot discovery: the union of a card's registrations, its slot refs, git's
 * worktree list and the names under its slot root. Lock directories are not a
 * discovery source; they only reserve ordinals for creation.
 *
 * @summary Discovers a card's worktree slots and the next free ordinal
 * @module
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BranchInfo } from '@cards.management/sdk/client';
import { listSlotLockOrdinals } from '@cards.management/sdk/slot-lock';
import { worktreeSlotNumber } from '@cards.management/sdk/worktree-path-policy';
import { checkedOutPaths, listWorktreeEntries, pathExists, refOid, samePath, type WorktreeEntry } from './checkout.js';
import type { RegistrationClient } from './registration.js';
import type { SlotGit } from './slot-git.js';

/** Where a card's slots live. */
export interface SlotPlace {
  readonly cardId: string;
  /** Main repository root; never a linked worktree. */
  readonly repoRoot: string;
  /** `<worktrees>/<repo id>/cards/<cardId>`. */
  readonly slotRoot: string;
}

/** One slot as found on disk, in git and in the registrations. */
export interface DiscoveredSlot {
  readonly ordinal: number;
  readonly branch: string;
  /** The registered checkout path, or `<slotRoot>/<ordinal>`. */
  readonly path: string;
  readonly registration: BranchInfo | null;
  /** Reason of an invalid branch file naming this slot. */
  readonly invalidEntry: string | null;
  /** Oid of `refs/heads/<branch>`, or null when the ref is absent. */
  readonly oid: string | null;
  /** Git's worktree entry at the slot path. */
  readonly entry: WorktreeEntry | null;
  /** Every path at which git has the slot branch checked out. */
  readonly checkedOutAt: readonly string[];
  readonly directoryExists: boolean;
  /** Quarantine residue (`<n>.deleting-*`, `<n>.held*`) beside the slot path. */
  readonly residue: readonly string[];
}

/** Everything a pass needs to know about a card's slots. */
export interface SlotInventory extends SlotPlace {
  /** Slots in ascending ordinal order. */
  readonly slots: readonly DiscoveredSlot[];
  readonly entries: readonly WorktreeEntry[];
  /** True when registrations could not be read, or an invalid branch file could not be attributed to a branch. */
  readonly registrationsUncertain: boolean;
  /** Why registrations could not be read; null when they were. */
  readonly registrationError: string | null;
  /** Highest ordinal seen anywhere, lock reservations included; 0 when none. */
  readonly highestOrdinal: number;
}

/**
 * Converts a slot branch to its ordinal when it is a slot of this card.
 * @param cardId - Card whose slot prefix the branch must carry.
 * @param branch - Full branch name to recognise.
 * @returns The ordinal, or null for a non-slot or an ordinal past safe integers.
 */
export function slotOrdinal(cardId: string, branch: string): number | null {
  const ordinal = worktreeSlotNumber(cardId, branch);
  return ordinal === null || ordinal > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(ordinal);
}

/**
 * Builds the slot branch name.
 * @param cardId - Card owning the slot.
 * @param ordinal - Positive slot number.
 * @returns `cards/<cardId>/<ordinal>`.
 */
export function slotBranch(cardId: string, ordinal: number): string {
  return `cards/${cardId}/${ordinal}`;
}

/**
 * Decodes the branch an invalid entry names: either a branch name or its `branches/<encoded>.json` file.
 * @param name - Name the server reported for the unreadable branch file.
 * @returns The branch name, or null when the file name cannot be decoded.
 */
function invalidEntryBranch(name: string): string | null {
  if (!name.startsWith('branches/')) return name;
  if (!name.endsWith('.json')) return null;
  try {
    return decodeURIComponent(name.slice('branches/'.length, -'.json'.length));
  } catch {
    return null;
  }
}

/**
 * Lists the names under the slot root.
 * @param slotRoot - Card slot root.
 * @returns Names, or none when the root does not exist.
 */
async function slotRootNames(slotRoot: string): Promise<readonly string[]> {
  try {
    return await readdir(slotRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Discovers every slot of a card.
 * @param git - Slot git.
 * @param client - Cards API client for the registrations.
 * @param place - Card, main repository and slot root.
 * @returns The inventory.
 * @throws When refs, the worktree list or the slot root cannot be read. Unreadable registrations
 * are reported through `registrationError` instead, with every slot then unregistered.
 */
export async function discoverSlots(
  git: SlotGit,
  client: Pick<RegistrationClient, 'getBranches'>,
  place: SlotPlace
): Promise<SlotInventory> {
  const { cardId, repoRoot, slotRoot } = place;
  let registrationError: string | null = null;
  const [registrations, refs, entries, names, lockOrdinals] = await Promise.all([
    client.getBranches(cardId).catch((error: unknown) => {
      registrationError = error instanceof Error ? error.message : String(error);
      return { branches: [], invalidEntries: [] };
    }),
    git.text(repoRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/cards/${cardId}/`]),
    listWorktreeEntries(git, repoRoot),
    slotRootNames(slotRoot),
    listSlotLockOrdinals(slotRoot)
  ]);

  let highest = 0;
  const reserve = (ordinal: number | null): void => {
    if (ordinal !== null && ordinal > highest) highest = ordinal;
  };
  const ordinals = new Set<number>();
  const found = (ordinal: number | null): void => {
    if (ordinal === null) return;
    ordinals.add(ordinal);
    reserve(ordinal);
  };

  const registered = new Map<number, BranchInfo>();
  for (const branch of registrations.branches) {
    const ordinal = slotOrdinal(cardId, branch.name);
    if (ordinal === null) continue;
    registered.set(ordinal, branch);
    found(ordinal);
  }
  const invalid = new Map<number, string>();
  let registrationsUncertain = registrationError !== null;
  for (const entry of registrations.invalidEntries) {
    const branch = invalidEntryBranch(entry.name);
    if (branch === null) {
      registrationsUncertain = true;
      continue;
    }
    const ordinal = slotOrdinal(cardId, branch);
    if (ordinal === null) continue;
    invalid.set(ordinal, entry.reason);
    found(ordinal);
  }
  for (const ref of refs.split('\n')) {
    if (ref.startsWith('refs/heads/')) found(slotOrdinal(cardId, ref.slice('refs/heads/'.length)));
  }
  for (const entry of entries) {
    if (entry.branchRef?.startsWith('refs/heads/'))
      found(slotOrdinal(cardId, entry.branchRef.slice('refs/heads/'.length)));
  }
  const residue = new Map<number, string[]>();
  for (const name of names) {
    const match = /^([1-9]\d*)(\..*)?$/.exec(name);
    if (match === null) continue;
    const ordinal = slotOrdinal(cardId, slotBranch(cardId, Number(match[1])));
    if (match[2] === undefined) {
      found(ordinal);
    } else if ((match[2].startsWith('.deleting-') || match[2].startsWith('.held')) && ordinal !== null) {
      reserve(ordinal);
      residue.set(ordinal, [...(residue.get(ordinal) ?? []), join(slotRoot, name)]);
    }
  }
  // Quarantine residue makes its slot a discovered slot: recovery runs under its lock.
  for (const ordinal of residue.keys()) ordinals.add(ordinal);
  for (const ordinal of lockOrdinals) reserve(ordinal);

  const slots: DiscoveredSlot[] = [];
  for (const ordinal of [...ordinals].sort((left, right) => left - right)) {
    const branch = slotBranch(cardId, ordinal);
    const registration = registered.get(ordinal) ?? null;
    const path = registration?.worktree ?? join(slotRoot, String(ordinal));
    let entry: WorktreeEntry | null = null;
    for (const candidate of entries) {
      if (await samePath(candidate.path, path)) entry = candidate;
    }
    slots.push({
      ordinal,
      branch,
      path,
      registration,
      invalidEntry: invalid.get(ordinal) ?? null,
      oid: await refOid(git, repoRoot, branch),
      entry,
      checkedOutAt: checkedOutPaths(entries, branch),
      directoryExists: await pathExists(path),
      residue: residue.get(ordinal) ?? []
    });
  }
  return { ...place, slots, entries, registrationsUncertain, registrationError, highestOrdinal: highest };
}

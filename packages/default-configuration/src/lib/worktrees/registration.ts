/**
 * Slot registrations written through the Cards API, retry-idempotent: a call
 * that failed but whose effect is visible on a re-read counts as done.
 *
 * @summary Retry-idempotent slot registration and unregistration
 * @module
 */

import type { CardsClient } from '@cards.management/sdk/client';

/** The registration a slot is written with. */
export interface SlotRegistration {
  readonly branch: string;
  readonly worktreePath: string;
  readonly parentBranch: string;
}

/** The client calls registration needs. */
export type RegistrationClient = Pick<CardsClient, 'addBranch' | 'removeBranch' | 'getBranches'>;

/**
 * Registers a new slot with create-only semantics. A failure whose re-read
 * shows an equal entry is success; any other failure is rethrown.
 * @param client - Cards API client.
 * @param cardId - Card owning the slot.
 * @param registration - Branch, checkout path and parent branch.
 */
export async function registerSlot(
  client: RegistrationClient,
  cardId: string,
  registration: SlotRegistration
): Promise<void> {
  try {
    await client.addBranch(cardId, {
      intent: 'create',
      name: registration.branch,
      worktree: registration.worktreePath,
      parentBranch: registration.parentBranch
    });
  } catch (error) {
    const current = await client.getBranches(cardId).catch(() => null);
    const found = current?.branches.find((branch) => branch.name === registration.branch);
    if (
      found !== undefined &&
      found.worktree === registration.worktreePath &&
      found.parentBranch === registration.parentBranch
    )
      return;
    throw error;
  }
}

/**
 * Unregisters a slot. A failure whose re-read shows no entry is success; any
 * other failure is rethrown.
 * @param client - Cards API client.
 * @param cardId - Card owning the slot.
 * @param branch - Slot branch whose registration is removed.
 */
export async function unregisterSlot(client: RegistrationClient, cardId: string, branch: string): Promise<void> {
  try {
    await client.removeBranch(cardId, branch);
  } catch (error) {
    const current = await client.getBranches(cardId).catch(() => null);
    if (
      current !== null &&
      !current.branches.some((entry) => entry.name === branch) &&
      !current.invalidEntries.some((entry) => entry.name === branch)
    )
      return;
    throw error;
  }
}

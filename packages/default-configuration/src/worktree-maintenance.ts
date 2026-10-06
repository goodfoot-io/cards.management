/**
 * Default `worktreeMaintenance` root command: one slot cleanup pass over the
 * card's worktree slots in the requested mode, reported as the card's cleanup
 * preview.
 *
 * The server launches the command for Clean Up Worktrees (`cleanup`), the
 * delete-card dialog (`preview`, then `prepare-delete`) and SDK callers, and
 * hands its report back without reading it. The pass spares no requester: the
 * command's own execution only owns the pass's `removal` locks. The report is
 * the SDK's {@link WorktreeCleanupPreview}, carrying the pass's unjudgeable-lock
 * counts and any pass-level failure, so a caller can show why slots were kept.
 *
 * @summary Default worktree maintenance root command
 * @module
 */

import type { WorktreeCleanupPreview } from '@cards.management/sdk';
import { defineWorktreeMaintenance } from '@cards.management/sdk/config';
import { clearsCardDeletion } from '@cards.management/sdk/protocol';
import { cleanupCardSlots, type SlotCleanupContext, type SlotCleanupResult } from './lib/worktrees/index.js';

/**
 * Builds the command's report from a pass.
 * @param cardId - The maintained card.
 * @param result - The pass's outcome.
 * @returns The report; `canDeleteCard` is the SDK's `clearsCardDeletion` of it, so the report always satisfies the preview schema.
 */
export function maintenanceReport(cardId: string, result: SlotCleanupResult): WorktreeCleanupPreview {
  return {
    cardId,
    canDeleteCard: clearsCardDeletion(result),
    decisions: result.decisions,
    unknownLocks: result.unknownLocks,
    ...(result.failure === undefined ? {} : { failure: result.failure })
  };
}

/** Slot layer override for tests; the host's layer otherwise. */
type MaintenanceLayer = Pick<SlotCleanupContext, 'layer'>;

/**
 * Creates the command over a slot layer.
 * @param overrides - Slot layer to run the pass on; the host's by default.
 * @returns The `worktreeMaintenance` command.
 */
export function createWorktreeMaintenance(overrides: MaintenanceLayer = {}) {
  return defineWorktreeMaintenance({}, async (input, { client, logger, report }) => {
    const result = await cleanupCardSlots(
      {
        client,
        logger,
        cardId: input.cardId,
        executionId: input.executionId,
        workspacePath: input.repoRoot,
        ...overrides
      },
      { requester: null, mode: input.mode }
    );
    report({ ...maintenanceReport(input.cardId, result) });
  });
}

export default createWorktreeMaintenance();

/**
 * `cleanupCardSlots`: removes a card's merged, clean, unused slots and reports
 * a decision for every slot. A lock-free pre-check decides which slots are
 * candidates; only those, and slots with residue to recover, are taken under
 * a `removal` lock, where every check is repeated. A pass never rejects.
 *
 * @summary Slot cleanup pass for in-handler passes and worktree maintenance
 * @module
 */

import type { ActionContext, WorktreeCleanupDecision } from '@cards.management/sdk';
import type { SlotClient } from './acquire.js';
import type { SlotLayer } from './layer.js';

/** What a pass does: report only, remove, or remove and require that nothing remains. */
export type SlotCleanupMode = 'preview' | 'cleanup' | 'prepare-delete';

/** Budget of an in-handler start or end pass, and of `preview`. */
export const SLOT_CLEANUP_PASS_BUDGET_MS = 60_000;

/** Budget of a maintenance `cleanup` or `prepare-delete`, inside the root command's 300 s deadline. */
export const SLOT_CLEANUP_MAINTENANCE_BUDGET_MS = 270_000;

/** Where and for whom a pass runs. */
export interface SlotCleanupContext {
  readonly client: SlotClient;
  readonly logger: ActionContext['logger'];
  readonly cardId: string;
  /** Any checkout of the workspace repository; the main repository and slot root are resolved from it. */
  readonly workspacePath: string;
  /** Git, seams and lock environment; the host's by default. */
  readonly layer?: SlotLayer;
}

/** Options of one pass. */
export interface SlotCleanupOptions {
  /**
   * Execution whose own slot is spared, reported `requester_slot`; null for
   * maintenance. `prepare-delete` treats it as absent.
   */
  readonly requester: string | null;
  readonly mode: SlotCleanupMode;
  /**
   * Time after which slots not yet started are reported `budget_exhausted`
   * and not locked. Defaults to {@link SLOT_CLEANUP_PASS_BUDGET_MS} for
   * `preview` and in-handler passes (a non-null requester), and to
   * {@link SLOT_CLEANUP_MAINTENANCE_BUDGET_MS} otherwise.
   */
  readonly budgetMs?: number;
}

/** Where a pass failed outside any one slot. */
export type SlotCleanupStage = 'discovery' | 'self_probe';

/** A pass's outcome. */
export interface SlotCleanupResult {
  /** One decision per discovered slot, in ordinal order. */
  readonly decisions: readonly WorktreeCleanupDecision[];
  /** Set when the pass stopped outside any slot; `decisions` holds those made before. */
  readonly failure?: { readonly stage: SlotCleanupStage; readonly message: string };
  /**
   * Whether the pass met its mode's bar: for `prepare-delete`, no slot is
   * preserved, `budget_exhausted` or `cleanup_failed` and no `failure` is
   * set; for the other modes, no `failure` is set.
   */
  readonly ok: boolean;
}

/**
 * Runs one cleanup pass over a card's slots.
 * @param context - Client, logger, card and workspace.
 * @param options - Requester, mode and budget.
 * @returns Every slot's decision, any pass-level failure, and whether the mode's bar was met. Never rejects.
 */
export async function cleanupCardSlots(
  context: SlotCleanupContext,
  options: SlotCleanupOptions
): Promise<SlotCleanupResult> {
  void context;
  void options;
  throw new Error('Not Implemented');
}

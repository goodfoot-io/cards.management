/**
 * Worktree maintenance report contracts. The `worktreeMaintenance` root command
 * reports these shapes inside its opaque `execution.commandReport`; callers
 * parse them back out of the report with {@link worktreeCleanupPreviewSchema},
 * and the server never reads them.
 * @summary Public cleanup preview and decision shapes reported by worktree maintenance
 */

import { z } from 'zod';

/** A branch file excluded from usable registrations without hiding its card. */
export interface InvalidBranchEntry {
  readonly name: string;
  readonly reason: string;
}

/** Content, lock, and occupancy checks reported for one worktree slot. */
export type WorktreeCleanupReason =
  | 'eligible'
  | 'missing'
  | 'requester_slot'
  | 'unmerged_commits'
  | 'uncommitted_changes'
  | 'parent_branch_missing'
  | 'invalid_entry'
  | 'unusable_checkout'
  | 'submodules'
  | 'checked_out_elsewhere'
  | 'containment_unproven'
  | 'git_failed'
  | 'removal_blocked'
  | 'removal_restored'
  | 'in_use'
  | 'head_off_branch'
  | 'quarantine_stranded'
  /**
   * A recovered creation left a non-empty directory with no worktree entry at
   * the slot path; it may be a stray writer's, so it is preserved. The detail
   * names the path and the dead creator's execution.
   */
  | 'creation_residue'
  /** The slot lock is held; the detail names the holder's execution. */
  | 'locked'
  | 'lock_unknown'
  | 'lock_unavailable'
  | 'handoff_lost'
  | 'cleanup_failed'
  | 'budget_exhausted';

/** One slot's preview or final cleanup decision. */
export interface WorktreeCleanupDecision {
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly reason: WorktreeCleanupReason;
  readonly detail: string;
  readonly outcome: 'eligible' | 'preserved' | 'removed' | 'failed';
}

/** Slots a pass could not judge, and how many of them carry an unverified owner. */
export interface WorktreeUnknownLocks {
  readonly count: number;
  /** Never more than {@link WorktreeUnknownLocks.count}. */
  readonly unverifiedOwners: number;
}

/** A stage that failed during a pass, so its decisions may be incomplete. */
export interface WorktreeMaintenanceStageFailure {
  readonly stage: 'discovery' | 'self_probe';
  readonly message: string;
}

/** Authenticated preview used before requesting cleanup or card deletion. */
export interface WorktreeCleanupPreview {
  readonly cardId: string;
  readonly canDeleteCard: boolean;
  readonly decisions: readonly WorktreeCleanupDecision[];
  /** Every pass reports its unknown locks, zero included. */
  readonly unknownLocks: WorktreeUnknownLocks;
  /** Present when a stage failed and the decisions may be incomplete. */
  readonly failure?: WorktreeMaintenanceStageFailure;
}

const worktreeCleanupReasonSchema = z.enum([
  'eligible',
  'missing',
  'requester_slot',
  'unmerged_commits',
  'uncommitted_changes',
  'parent_branch_missing',
  'invalid_entry',
  'unusable_checkout',
  'submodules',
  'checked_out_elsewhere',
  'containment_unproven',
  'git_failed',
  'removal_blocked',
  'removal_restored',
  'in_use',
  'head_off_branch',
  'quarantine_stranded',
  'creation_residue',
  'locked',
  'lock_unknown',
  'lock_unavailable',
  'handoff_lost',
  'cleanup_failed',
  'budget_exhausted'
] as const satisfies readonly WorktreeCleanupReason[]);

const worktreeCleanupDecisionSchema = z.strictObject({
  branch: z.string(),
  worktreePath: z.string().nullable(),
  reason: worktreeCleanupReasonSchema,
  detail: z.string(),
  outcome: z.enum(['eligible', 'preserved', 'removed', 'failed'])
});

const worktreeUnknownLocksSchema = z
  .strictObject({
    count: z.int().nonnegative(),
    unverifiedOwners: z.int().nonnegative()
  })
  .refine((locks) => locks.unverifiedOwners <= locks.count, {
    message: 'unverifiedOwners cannot exceed count',
    path: ['unverifiedOwners']
  });

/**
 * Parses a `worktreeMaintenance` command report, which arrives as the opaque
 * `execution.commandReport` payload, into a {@link WorktreeCleanupPreview}.
 * Unknown fields, reasons and outcomes are rejected rather than passed through.
 */
export const worktreeCleanupPreviewSchema = z.strictObject({
  cardId: z.string().min(1),
  canDeleteCard: z.boolean(),
  decisions: z.array(worktreeCleanupDecisionSchema),
  unknownLocks: worktreeUnknownLocksSchema,
  failure: z.strictObject({ stage: z.enum(['discovery', 'self_probe']), message: z.string() }).optional()
}) satisfies z.ZodType<WorktreeCleanupPreview>;

/**
 * Worktree maintenance report contracts. The `worktreeMaintenance` root command
 * reports these shapes inside its opaque `execution.commandReport`; callers
 * parse them back out of the report, and the server never reads them.
 * @summary Public cleanup preview and decision shapes reported by worktree maintenance
 */

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

/** Authenticated preview used before requesting cleanup or card deletion. */
export interface WorktreeCleanupPreview {
  readonly cardId: string;
  readonly canDeleteCard: boolean;
  readonly decisions: readonly WorktreeCleanupDecision[];
}

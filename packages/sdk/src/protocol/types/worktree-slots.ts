/**
 * Admission-owned slot assignments and content cleanup contracts.
 * @summary Public slot assignment, cleanup preview, and cleanup result shapes
 */

/** One execution's durable assignment, retained after its execution ends. */
export interface WorktreeAssignment {
  readonly branch: string;
  readonly assignedAt: string;
  readonly endedAt: string | null;
}

/** Checkout returned by the authenticated assignment operation. */
export interface AssignedWorktree {
  readonly branch: string;
  readonly worktreePath: string;
}

/** Explicit grounds for refusing an authenticated slot assignment. */
export type WorktreeAssignmentRefusal =
  | 'worktree_busy'
  | 'card_deleting'
  | 'not_running'
  | 'creation_failed'
  | 'authority_unavailable';

/** Idempotent assignment completion or an explicit refusal. */
export type WorktreeAssignmentOutcome =
  | { readonly status: 'completed'; readonly payload: AssignedWorktree }
  | { readonly status: 'rejected'; readonly reason: WorktreeAssignmentRefusal; readonly detail: string };

/** A branch file excluded from usable registrations without hiding its card. */
export interface InvalidBranchEntry {
  readonly name: string;
  readonly reason: string;
}

/** Content and authority checks reported for one worktree slot. */
export type WorktreeCleanupReason =
  | 'eligible'
  | 'missing'
  | 'requester_slot'
  | 'running_execution'
  | 'creating'
  | 'deleting'
  | 'unmerged_commits'
  | 'uncommitted_changes'
  | 'parent_branch_missing'
  | 'invalid_entry'
  | 'unusable_checkout'
  | 'submodules'
  | 'checked_out_elsewhere'
  | 'authority_unavailable'
  | 'containment_unproven'
  | 'git_failed';

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

/** Complete results from one owner-process content cleanup pass. */
export interface WorktreeCleanupResponse {
  readonly cardId: string;
  readonly decisions: readonly WorktreeCleanupDecision[];
}

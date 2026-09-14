/**
 * Branch and worktree tracking types for Cards V2 workspace integration.
 *
 * These types support tracking Git branches and their associated worktrees within
 * a card's workspace. Branch metadata is persisted as per-entry files under the
 * branches/ and commits/ directories, tracked with static metadata (branch name, worktree path,
 * addedAt timestamp) and derived fields computed at read time (exists, isMerged, commits).
 *
 * The branch API (`GET /cards/:id/branches`, `POST /cards/:id/branches`) uses
 * these types to expose workspace tracking state to clients and enable branch
 * association with cards.
 *
 * @summary Branch and worktree tracking types for Cards V2 workspace integration
 * @module types/branch
 */

import { z } from 'zod';
import type { CommitDetails } from './timeline.js';

/**
 * Well-known SHA for an empty git tree.
 *
 * This is a deterministic value produced by `git hash-object -t tree /dev/null`
 * and never changes across git versions. Used as the diff base when comparing
 * against a state with no prior commits.
 */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Directory holding per-branch entry files, one `branches/<encodeURIComponent(name)>.json`
 * per tracked branch. The authoritative branch `name` lives inside each file's content,
 * never decoded from the filename. Concurrent same-card branch writes touch disjoint
 * paths so the git-plumbing compare-and-swap never serializes them into false conflicts.
 */
export const BRANCHES_DIR = 'branches';

/**
 * Directory holding per-commit entry files, one `commits/<sha>` per attributed commit
 * SHA (40-hex). Concurrent same-card attribution writes touch disjoint paths.
 */
export const COMMITS_DIR = 'commits';

/**
 * A single tracked branch within a card's workspace block.
 *
 * This is the minimal metadata persisted for each branch as a branches/<name>.json entry.
 * The worktree path is optional and machine-specific; it may become stale if
 * the worktree is moved or deleted outside of the cards system.
 */
export interface WorkspaceBranch {
  /** Opaque ownership token rotated by every successful registration write. */
  revision: string;
  /** Execution that exclusively owns this checkout. Absence means reusable. */
  activeExecutionOwner?: string;
  /**
   * Optional absolute path to worktree directory (machine-specific, may be stale).
   * This path is advisory only and should be validated before use.
   */
  worktree?: string;

  /**
   * Name of the branch this was created from (e.g., 'main', 'master').
   * Used as the base ref for comparisons, fast-forward detection, and rebase targeting.
   */
  parentBranch: string;

  /**
   * ISO 8601 timestamp when branch was added to the card.
   * Used for chronological sorting and audit trails.
   */
  addedAt: string;
}

/**
 * Branch info returned by GET /cards/:id/branches (includes computed fields).
 *
 * This type extends the persisted WorkspaceBranch data with runtime-computed
 * fields that reflect the current Git repository state. Computed fields are
 * never persisted.
 */
export interface BranchInfo {
  /** Opaque revision required by conditional ownership mutations. */
  revision: string;
  /** Execution that exclusively owns this checkout. Absence means reusable. */
  activeExecutionOwner?: string;
  /**
   * Branch name (may contain slashes, e.g., "feature/auth").
   * This is the Git ref name, not a filesystem path.
   */
  name: string;

  /**
   * Optional worktree path associated with this branch.
   * Copied from WorkspaceBranch.worktree if present.
   */
  worktree?: string;

  /**
   * Parent branch name from which this branch was created (e.g., 'main', 'master').
   * Used as the base ref for comparisons.
   */
  parentBranch: string;

  /**
   * ISO 8601 timestamp when branch was added.
   * Copied from WorkspaceBranch.addedAt.
   */
  addedAt: string;

  /**
   * Whether the branch still exists in git (computed at read time).
   * False if the branch ref has been deleted.
   */
  exists?: boolean;

  /**
   * Whether the branch tip is merged into requesting workspace HEAD.
   * Computed at read time, never stored. Only meaningful when exists=true.
   */
  isMerged?: boolean;

  /**
   * Commit SHAs reachable from this branch but not from HEAD (computed at read time).
   * Empty array if branch is fully merged or does not exist.
   */
  commits?: string[];
}

/**
 * Response shape for GET /cards/:id/branches.
 *
 * Returns all tracked branches for a card with computed runtime fields.
 */
export interface BranchesResponse {
  /**
   * List of tracked branches with computed fields.
   * Sorted by addedAt timestamp (oldest first).
   */
  branches: BranchInfo[];

  /**
   * All card-level commit SHAs from the commits/ directory.
   * Present regardless of branch state, so the UI can show changes
   * even after all tracked branches have been removed.
   */
  commits: string[];

  /**
   * Default branch of the workspace repository (e.g., 'main', 'master').
   * Detected from `refs/remotes/origin/HEAD`, falling back to current HEAD branch.
   * Used as the base ref for card-level commits when no tracked branches remain.
   */
  defaultBranch: string;

  /**
   * SHAs of card commits that are ancestors of HEAD at the requesting workspace.
   * Empty array when workspacePath is not provided or git operations fail gracefully.
   */
  mergedCommits: string[];

  /**
   * Branch name checked out at the requesting workspace (e.g., "main", "feature-auth").
   * "HEAD" when in detached HEAD state.
   * Empty string when workspacePath is not provided or git operations fail gracefully.
   */
  headBranch: string;

  /**
   * Commit details keyed by SHA for each entry in `commits`.
   * Empty when there are no commits. Only absent when `workspacePath` was not provided
   * (i.e. the reindex path — `commitDetails` is delivered separately via `WorkspaceCommitEvent`).
   */
  commitDetails?: Record<string, CommitDetails>;
}

/**
 * Request body for POST /cards/:id/branches.
 *
 * Used to add a new branch to a card's workspace tracking block.
 */
export interface AddBranchRequest {
  /**
   * Registration write semantics. `create` requires the name to be absent;
   * omitted intent retains the historical upsert behavior.
   */
  intent?: BranchRegistrationIntent;
  /**
   * Branch name to track.
   * Must be a valid Git ref name (may contain slashes).
   */
  name: string;

  /**
   * Optional worktree path.
   * Should be an absolute path to a valid worktree directory.
   */
  worktree?: string;

  /**
   * Parent branch name from which this branch was created (e.g., 'main', 'master').
   * Used as the base ref for comparisons.
   */
  parentBranch: string;
}

/** Controls whether branch registration may replace an existing record. */
export type BranchRegistrationIntent = 'create' | 'upsert';

/** Successful response from POST /cards/:id/branches. */
export interface AddBranchResponse {
  outcome: 'created' | 'upserted';
  /** Opaque token identifying the exact persisted registration version. */
  revision: string;
}

/** Optional query contract for DELETE /cards/:id/branches/:branchName. */
export interface RemoveBranchRequest {
  /** Delete only when the persisted registration still owns this token. */
  expectedRevision?: string;
  /** Exact cleanup claim required to remove a reclamation-owned registration. */
  expectedCleanupOwner?: string;
}

/** Successful response from branch removal. */
export interface RemoveBranchResponse {
  /** `preserved` means a revision mismatch left the current record untouched. */
  outcome: 'removed' | 'preserved';
}

/** Exact expected ownership state for a conditional mutation. */
export type BranchOwnerExpectation = { kind: 'none' } | { kind: 'execution'; executionId: string };

/** Request body for PATCH /cards/:id/branches/:branchName/owner. */
export interface UpdateBranchOwnerRequest {
  expectedRevision: string;
  expectedOwner: BranchOwnerExpectation;
  replacementOwner?: string;
}

/** A conditional ownership mutation never hides why it did not apply. */
export interface UpdateBranchOwnerResponse {
  outcome: 'applied' | 'idempotent' | 'revision_conflict' | 'owner_conflict' | 'missing';
  revision?: string;
  activeExecutionOwner?: string;
}

/** Strict authority mutation boundary shared by HTTP and direct store callers. */
export const UpdateBranchOwnerRequestSchema = z.strictObject({
  expectedRevision: z.string().min(1),
  expectedOwner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('execution'), executionId: z.string().min(1) })
  ]),
  replacementOwner: z.string().min(1).optional()
});

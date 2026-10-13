/**
 * Core card metadata for the Cards V2 protocol.
 *
 * These shapes model the metadata stored in `CARD.json` as well as the
 * derived card object used by the UI and APIs. The metadata fields are the
 * canonical source of truth for card identity and lifecycle state.
 *
 * Cards follow a directory-based storage model where each card lives in its own
 * folder containing `CARD.json` (metadata), `DESCRIPTION.md` (description),
 * optional plan documents, and attachments.
 *
 *
 * @summary Core card metadata for the Cards V2 protocol
 * @example
 * ```json
 * // CARD.json metadata
 * {
 *   "id": "main-0001",
 *   "title": "Implement authentication",
 *   "status": "active",
 *   "tags": ["feature", "security"],
 *   "gates": {
 *     "planRequired": true,
 *     "planApproved": true,
 *     "mergeRequestRequired": true,
 *     "mergeApproved": false
 *   },
 *   "isPinned": false,
 *   "order": 1,
 *   "repositoryId": "main"
 * }
 * ```
 *
 * @module types/card
 */

import type { CardStatus } from './status.js';

// --- Card Gates ---

/**
 * Gate flags that express workflow requirements and approval state for a card.
 *
 * Gates enforce development process discipline by requiring certain milestones
 * before a card can progress. The `*Required` flags indicate what the workflow
 * demands; the `*Approved` flags track whether those requirements have been met.
 *
 * Gates are evaluated by automation and UI to decide whether a card can move
 * to a later lifecycle state. They are stored with the card so the workflow
 * intent remains durable even if tooling changes.
 *
 * @example
 * ```typescript
 * // A card requiring plan approval before work starts
 * const gates: CardGates = {
 *   planRequired: true,
 *   planApproved: false,  // Cannot start until approved
 *   mergeRequestRequired: true,
 *   mergeApproved: false
 * };
 *
 * // After plan is approved, card can move to active
 * gates.planApproved = true;
 * ```
 *
 * @see {@link CardCreateGates} for the client-facing subset used during creation
 * @see {@link DEFAULT_CARD_GATES} for the default configuration
 */
export interface CardGates {
  /**
   * Whether a plan document is required before implementation begins.
   * When true, the card cannot transition from `todo` to `active`
   * until `planApproved` is also true.
   */
  planRequired: boolean;

  /**
   * Whether the plan has been approved by a reviewer.
   * Set via the `POST /cards/:id/gates/plan/approve` endpoint.
   */
  planApproved: boolean;

  /**
   * Whether merge request is required before the card can be marked done.
   * When true, the card must pass through `needs_review` status and
   * have `mergeApproved` set before transitioning to `done`.
   */
  mergeRequestRequired: boolean;

  /**
   * Whether the merge request requirement has been satisfied.
   * Set via the `POST /cards/:id/gates/mergeRequest/approve` endpoint.
   */
  mergeApproved: boolean;
}

/**
 * Default gate configuration used when a card declares no explicit gates.
 *
 * All requirements and approvals default to `false`, allowing cards to
 * progress through statuses without workflow enforcement.
 */
export const DEFAULT_CARD_GATES: CardGates = {
  planRequired: false,
  planApproved: false,
  mergeRequestRequired: false,
  mergeApproved: false
};

// --- Card Relations ---

/**
 * The type of relationship between two cards.
 *
 * - `related`: this card is related to the target (informational)
 * - `depends_on`: this card's work relies on the target's work (informational, directional)
 */
export type CardRelationType = 'related' | 'depends_on';

/**
 * All valid {@link CardRelationType} values as a readonly tuple.
 *
 * Use this for validation and exhaustiveness checks.
 */
export const CARD_RELATION_TYPES = ['related', 'depends_on'] as const satisfies readonly CardRelationType[];

/**
 * A directed relationship from one card to another.
 *
 * Relations are stored in the outgoing canonical direction only in
 * `CARD.meta.json`. Incoming relations are derived at read time
 * from the `card_relations` SQLite table.
 */
export interface CardRelation {
  /** The type of relationship. */
  type: CardRelationType;
  /** Stable branch-prefixed ID of the target card, e.g. `"main-0002"`. */
  cardId: string;
}

// --- Card Metadata ---

/**
 * File-persisted metadata stored in `CARD.json`.
 *
 * These fields are stored in the card's JSON metadata file and power sorting,
 * filtering, and workflow enforcement in the application. Timestamps
 * (`createdAt`, `updatedAt`) are derived from Git history at read time and not
 * persisted in the JSON file.
 *
 * @example
 * ```typescript
 * const metadata: CardMetadata = {
 *   id: 'main-0001',
 *   title: 'Implement user login',
 *   status: 'active',
 *   tags: ['feature', 'auth'],
 *   gates: DEFAULT_CARD_GATES,
 *   isPinned: false,
 *   order: 1,
 *   repositoryId: 'main',
 *   environment: 'default'
 * };
 * ```
 */
export interface CardMetadata {
  /** Original creation correlation UUID, retained for durable outcome lookup. */
  creationRequestId?: string;

  /**
   * Stable identifier used in URLs, filenames, and API routes.
   * Format: `{branch-prefix}-{counter}` (e.g., `main-0001`).
   */
  id: string;

  /**
   * Human-facing title shown in lists and headers.
   * Subject to {@link MAX_TITLE_LENGTH} validation.
   */
  title: string;

  /**
   * Current lifecycle state for the card.
   * Controls visibility in board columns and available actions.
   */
  status: CardStatus;

  /**
   * Tags used for filtering and grouping.
   * Each tag is normalized to lowercase and must match {@link TAG_PATTERN}.
   */
  tags: string[];

  /**
   * Workflow gate configuration for this card.
   * Controls status transition rules and approval requirements.
   */
  gates: CardGates;

  /**
   * Whether the card should be pinned to the top of lists.
   * Pinned cards appear before unpinned cards regardless of order value.
   */
  isPinned: boolean;

  /**
   * Relative order within a status column for drag-and-drop layouts.
   * Lower values appear first. Only compared among cards with the same
   * pinned state.
   */
  order: number;

  /**
   * Repository identifier for this card.
   * Used to associate cards with their Git repositories and scope queries.
   * Derived from the workspace's git remote URL or commit hash via
   * {@link resolveRepositoryId}.
   */
  repositoryId: string;

  /**
   * Environment name for action execution.
   * Determines which actions are available in the card's action menu.
   * Persisted in CARD.meta.json. Defaults to `'default'` at creation time.
   */
  environment: string;

  /**
   * Workspace branch the card was created from.
   * Records the branch name at card creation time for traceability.
   */
  parentBranch: string;

  /** Outgoing relations from this card to others. Absent when empty; never serialized as []. */
  relations?: CardRelation[];
}

// --- Card ---

/**
 * Full card representation including metadata and body content.
 *
 * This is the primary card type used throughout the application. It extends
 * {@link CardMetadata} with computed fields (timestamps derived from Git),
 * the description body, and runtime properties not persisted in CARD.meta.json.
 *
 * @example
 * ```typescript
 * const card: Card = {
 *   id: 'main-0001',
 *   title: 'Implement OAuth2',
 *   status: 'active',
 *   tags: ['feature', 'auth'],
 *   gates: { planRequired: true, planApproved: true, mergeRequestRequired: true, mergeApproved: false },
 *   isPinned: false,
 *   order: 1,
 *   repositoryId: 'main',
 *   environment: 'default',
 *   createdAt: '2024-01-15T10:30:00Z',
 *   updatedAt: '2024-01-16T14:22:00Z',
 *   description: '## Goals\n- Support Google and GitHub OAuth...',
 *   repositoryPath: '/home/user/project'
 * };
 * ```
 */
export interface Card extends CardMetadata {
  /**
   * ISO 8601 timestamp of when the card was created.
   * Derived from Git history at read time.
   */
  createdAt: string;

  /**
   * ISO 8601 timestamp of the most recent metadata update.
   * Derived from Git history at read time.
   */
  updatedAt: string;

  /**
   * Merge status of attributed workspace commits into the viewer's current branch HEAD.
   *
   * This is a computed, workspace-relative field. It is not persisted in CARD.meta.json.
   * The store defaults this to `null`; the Router overwrites it with the actual computed
   * value before sending API responses.
   *
   * - `true`: All workspace commits are merged into the viewer's HEAD
   * - `false`: Has workspace commits that are NOT merged into the viewer's HEAD
   * - `null`: No workspace commits exist for this card
   */
  isMerged: boolean | null;

  /**
   * Whether plan documents in the card repository have been updated more recently
   * than the latest workspace commit attribution.
   *
   * This is a computed, workspace-relative field. It is not persisted in CARD.meta.json.
   * The store defaults this to `true` (fail-closed); the Router overwrites it with the
   * actual computed value before sending API responses. When `true`, the `merged`
   * pseudotag is suppressed even if `isMerged === true`.
   */
  hasPlanDrift: boolean;

  /**
   * Whether the card has unread activity since the user last viewed its timeline.
   *
   * This is a computed, read-state field. It is not persisted in CARD.meta.json.
   * The store defaults this to `false`; the Router overwrites it with the actual
   * computed value before sending API responses.
   */
  hasUnread: boolean;

  /**
   * Absolute filesystem path to the repository containing the card directory.
   * Used for resolving relative paths in actions.
   */
  repositoryPath: string;

  /** Incoming relations targeting this card (derived from card_relations at read time, not persisted). */
  incomingRelations?: CardRelation[];
}

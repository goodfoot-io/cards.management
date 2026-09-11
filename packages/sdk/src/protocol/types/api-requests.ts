/**
 * Shared API request and response types for the Cards V2 REST API.
 *
 * These types define the wire-level contract between clients and server.
 * Both the server (for validation) and clients (for request construction)
 * compile against these shapes to ensure compatibility across the ecosystem.
 *
 * Request types model JSON payloads sent in HTTP bodies or query strings.
 * Response types model the JSON structures returned by endpoints. All
 * timestamps use ISO 8601 format for consistent parsing across platforms.
 *
 *
 * @summary Shared API request and response types for the Cards V2 REST API
 * @example
 * ```typescript
 * // Creating a card
 * const request: CreateCardRequest = {
 *   title: 'Implement auth flow',
 *   description: '## Goals\n- OAuth2 support',
 *   workspacePath: '/home/user/project',
 *   tags: ['backend', 'security'],
 *   gates: { planRequired: true }
 * };
 *
 * // Listing cards with filters
 * const query: ListCardsRequest = {
 *   workspacePath: '/home/user/project',
 *   status: 'active',
 *   limit: 20
 * };
 * ```
 *
 * @module types/api-requests
 */

import type { Card, CardRelation } from './card.js';
import type { CodingAgentId } from './coding-agent.js';
import type { OriginalCallerRequestId } from './runtime-admission.js';
import type { ExecutionMode } from './settings.js';
import type { CardStatus } from './status.js';
import type { TimelineItem } from './timeline.js';

// ============================================================================
// Variable Group API Types
// ============================================================================

/** Safe metadata returned when discovering a configured variable group. */
export interface VariableGroupSummary {
  /** Stable variable-group identifier. */
  id: string;
  /** Human-readable variable-group name. */
  name: string;
  /** Optional human-readable description. */
  description?: string;
  /** Number of non-secret variables in the group. */
  variableCount: number;
  /** Number of committed secrets in the group. */
  secretCount: number;
}

/** Response from `GET /variable-groups`. */
export type VariableGroupsResponse = VariableGroupSummary[];

// ============================================================================
// Card API Types
// ============================================================================

/**
 * Gate configuration for card creation requests.
 *
 * Unlike {@link CardGates}, this interface only includes requirement flags,
 * not approval state. Approval flags are managed server-side and cannot be
 * set by clients during creation.
 *
 * @example
 * ```typescript
 * const gates: CardCreateGates = {
 *   planRequired: true,    // Must have approved plan before starting work
 *   mergeRequestRequired: true   // Must have merge request approved before marking done
 * };
 * ```
 *
 * @see {@link CardGates} for the full gate state including approvals
 */
export interface CardCreateGates {
  /**
   * Whether a plan document is required before implementation begins.
   * When true, the card cannot transition to `active` until the
   * plan is approved.
   */
  planRequired?: boolean;

  /**
   * Whether merge request is required before the card can be marked done.
   * When true, the card must transition through `needs_review` before
   * reaching `done` status.
   */
  mergeRequestRequired?: boolean;
}

/**
 * Request body for `POST /cards`.
 *
 * Creates a new card with the specified metadata. The server generates
 * an ID based on the workspace branch prefix and an incrementing counter,
 * then populates `createdAt` and `updatedAt` timestamps automatically.
 *
 * @example
 * ```typescript
 * const request: CreateCardRequest = {
 *   title: 'Add user authentication',
 *   description: '## Overview\nImplement OAuth2 flow...',
 *   workspacePath: '/home/user/my-project',
 *   tags: ['feature', 'auth'],
 *   environment: 'production',
 *   gates: { planRequired: true, mergeRequestRequired: true }
 * };
 * ```
 */
export interface CreateCardRequest {
  /**
   * Human-facing title shown in lists and headers.
   * Subject to {@link MAX_TITLE_LENGTH} validation.
   */
  title: string;

  /**
   * Absolute filesystem path to the workspace repository.
   * Used to scope the card and derive its branch-based ID prefix.
   */
  workspacePath: string;

  /**
   * Tags for filtering and grouping.
   * Each tag is normalized to lowercase and validated against {@link TAG_PATTERN}.
   */
  tags?: string[];

  /**
   * Environment name for action execution targeting.
   * Must match a key in the settings.json `environments` object.
   * Defaults to `'default'` if omitted.
   */
  environment?: string;

  /**
   * Display order within the status column for drag-and-drop layouts.
   * Lower values appear first. Server assigns a default if omitted.
   */
  order?: number;

  /**
   * Gate requirements for the card's workflow.
   * Omitted gates default to `false` (not required).
   */
  gates?: CardCreateGates;

  /**
   * Full git author identity for commit attribution, e.g. `user <user@cards.local>`.
   * When omitted, commits use the card repo's git config default.
   */
  author?: string;

  /**
   * Outgoing relations to other cards.
   * Each entry specifies a relation type and a target card ID.
   */
  relations?: CardRelation[];
}

/**
 * Request body for `PATCH /cards/:id`.
 *
 * All fields are optional; only provided fields are updated. The `id` field
 * cannot be changed through this endpoint, and approval flags (`planApproved`,
 * `mergeApproved`) are protected and managed through dedicated gate endpoints.
 *
 * @example
 * ```typescript
 * // Update status and add a tag
 * const update: UpdateCardRequest = {
 *   status: 'active',
 *   tags: ['feature', 'auth', 'urgent']
 * };
 * ```
 */
export interface UpdateCardRequest {
  /**
   * Updated title for the card.
   * Subject to {@link MAX_TITLE_LENGTH} validation.
   */
  title?: string;

  /**
   * Updated lifecycle status.
   * Transitions may be blocked by gate requirements.
   */
  status?: CardStatus;

  /**
   * Updated tags array. Replaces existing tags entirely rather than merging.
   * To add a tag, include all existing tags plus the new one.
   */
  tags?: string[];

  /**
   * Whether the card should be pinned to the top of lists.
   * Pinned cards appear before unpinned cards regardless of order value.
   */
  isPinned?: boolean;

  /**
   * Updated display order within the status column.
   * Only affects position among cards with the same pinned state.
   */
  order?: number;

  /**
   * Full git author identity for commit attribution, e.g. `user <user@cards.local>`.
   * When omitted, commits use the card repo's git config default.
   */
  author?: string;

  /** Updated relations array. Replaces existing relations entirely. */
  relations?: CardRelation[];
}

/**
 * Query parameters for `GET /cards`.
 *
 * All filter parameters are optional except `workspacePath`. Filters are
 * combined with AND semantics, so a card must match all specified criteria.
 *
 * @example
 * ```typescript
 * // Find active cards tagged 'urgent'
 * const query: ListCardsRequest = {
 *   workspacePath: '/home/user/project',
 *   status: 'active',
 *   tag: 'urgent',
 *   limit: 50
 * };
 * ```
 */
export interface ListCardsRequest {
  /**
   * Absolute filesystem path to the workspace repository.
   * Cards are scoped to this path.
   */
  workspacePath: string;

  /**
   * Filter by card status.
   * Only cards with this exact status are returned.
   */
  status?: CardStatus;

  /**
   * Filter by a single tag.
   * Cards must have this tag in their tags array.
   */
  tag?: string;

  /**
   * Full-text search query.
   * Searches title and description content.
   */
  search?: string;

  /**
   * Maximum number of cards to return.
   * Defaults to server configuration if omitted.
   */
  limit?: number;

  /**
   * Pagination offset.
   * Skip this many cards before returning results.
   */
  offset?: number;
}

/**
 * Response from card endpoints.
 *
 * This is an alias for the {@link Card} type, used here for clarity in
 * API contexts where the response shape is being documented.
 */
export type CardResponse = Card;

/**
 * Response from `GET /cards/:id/has-updates`.
 *
 * Used for polling-based update detection. Clients can compare the
 * `updatedAt` timestamp against their cached version to decide whether
 * to fetch fresh data.
 */
export interface HasUpdatesResponse {
  /**
   * Whether the card has updates since the baseline timestamp.
   * The baseline is typically the client's last known `updatedAt` value.
   */
  hasUpdates: boolean;

  /**
   * ISO 8601 timestamp of the card's most recent update.
   * Compare this with cached values to detect changes.
   */
  updatedAt: string;
}

// ============================================================================
// Attachment API Types
// ============================================================================

/**
 * Request body for `POST /cards/:id/attachments`.
 *
 * Uploads a file attachment to the specified card. The file data must be
 * base64-encoded. The server validates the content, generates a unique ID,
 * and stores the file in the card's attachments directory.
 */
export interface CreateAttachmentRequest {
  /**
   * Original filename of the attachment.
   * Used for display purposes and to derive the stored filename.
   */
  name: string;

  /**
   * Base64-encoded file data.
   * The server decodes this and validates the content type.
   */
  data: string;

  /**
   * Optional human-readable context about what the attachment contains or why it was added.
   */
  description?: string;
}

/**
 * Response from attachment endpoints.
 *
 * Contains metadata about the stored attachment, including its sanitized
 * filename and detected MIME type. The `id` can be used to construct
 * URLs for retrieval or deletion.
 */
export interface AttachmentResponse {
  /**
   * Unique identifier for the attachment.
   * Format: `att-{uuid}_{sanitized-filename}`.
   */
  id: string;

  /**
   * Stored filename after sanitization.
   * May differ from `originalName` if special characters were removed.
   */
  name: string;

  /**
   * Original filename as uploaded by the client.
   * Preserved for display purposes even when the stored name differs.
   */
  originalName: string;

  /**
   * File size in bytes after decoding from base64.
   */
  size: number;

  /**
   * MIME type detected from the file content.
   * Used for content-type headers when serving the file.
   */
  mimeType: string;

  /**
   * Optional human-readable context about what the attachment contains or why it was added.
   */
  description?: string;
}

// ============================================================================
// Timeline API Types
// ============================================================================

/**
 * Query parameters for `GET /cards/:id/timeline`.
 *
 * Supports cursor-based pagination for efficient loading of large timelines.
 * Items are returned in reverse chronological order (newest first).
 */
export interface TimelineRequest {
  /**
   * Cursor for pagination.
   * Fetch entries created before this ID. Typically the last item's ID
   * from the previous page.
   */
  before?: string;

  /**
   * Maximum number of entries to return.
   * Defaults to server configuration if omitted.
   */
  limit?: number;
}

/**
 * Response from timeline endpoints.
 *
 * An array of {@link TimelineItem} entries in reverse chronological order.
 * Each item has a `type` discriminator for union narrowing.
 */
export type TimelineResponse = TimelineItem[];

// ============================================================================
// Commit API Types
// ============================================================================

/**
 * Request body for `POST /cards/:id/commits`.
 *
 * Associates a git commit with a card for timeline tracking. Commit details
 * (message, author, stats) are fetched from git at read time using the
 * workspace repository path stored in `repository_identities`.
 */
export interface AddCommitRequest {
  /**
   * Full 40-character git commit SHA hash.
   * Abbreviated hashes are not accepted.
   */
  sha: string;
}

/**
 * Response from commit attribution endpoints.
 *
 * Confirms the commit association and includes the timestamp of when
 * the association was created.
 */
export interface CommitAttributionResponse {
  /**
   * Full commit SHA as stored.
   */
  sha: string;

  /**
   * ISO 8601 timestamp when the commit was associated with the card.
   */
  createdAt: string;
}

// ============================================================================
// Gate API Types
// ============================================================================

/**
 * Valid gate names for approval endpoints.
 *
 * Used with `POST /cards/:id/gates/:gateName/approve` to approve
 * workflow gates.
 */
export type GateName = 'plan' | 'mergeRequest';

/**
 * Response from `POST /cards/:id/gates/:gateName/approve`.
 *
 * Returns the updated card with the gate approval applied. The corresponding
 * `*Approved` flag in the card's gates will be `true`.
 */
export type GateApprovalResponse = CardResponse;

// ============================================================================
// Tags API Types
// ============================================================================

/**
 * Query parameters for `GET /tags`.
 *
 * Retrieves all unique tags used across cards in a workspace.
 */
export interface ListTagsRequest {
  /**
   * Absolute filesystem path to the workspace repository.
   * Tags are aggregated from all cards scoped to this path.
   */
  workspacePath: string;
}

/**
 * Response from `GET /tags`.
 *
 * An array of unique tag strings used across the workspace's cards.
 * Tags are normalized to lowercase.
 */
export type TagsResponse = string[];

// ============================================================================
// Environment API Types
// ============================================================================

/**
 * Summary of an action for environment API responses.
 *
 * Excludes command details for security - clients see only the metadata
 * needed to render UI buttons and tooltips. The actual commands are
 * executed server-side.
 */
export interface ActionSummaryResponse {
  /**
   * Stable identifier for the action.
   * Used for telemetry and localization keys.
   */
  id: string;

  /**
   * Display name shown on the action button.
   */
  name: string;

  /**
   * Human-readable description shown in the button tooltip.
   */
  description?: string;

  /**
   * Path to icon file for the action button.
   * May use path variables like `${workspaceRoot}`.
   */
  icon?: string;

  /**
   * Whether the execution mode toggle is shown.
   * When true, users can choose between interactive and background modes.
   */
  supportsBackgroundMode?: boolean;

  /**
   * Whether multiple instances can run on the same card simultaneously.
   * When false, starting a new instance cancels any existing one.
   */
  allowConcurrent?: boolean;
}

/**
 * Response item from `GET /environments`.
 *
 * Represents a single environment with its available actions.
 */
export interface EnvironmentInfo {
  /**
   * Environment name identifier.
   * Matches a key in the settings.json `environments` object.
   */
  name: string;

  /**
   * Human-readable description for the environment selector tooltip.
   */
  description?: string;

  /**
   * Actions available in this environment.
   * May be empty if the environment is misconfigured.
   */
  actions: ActionSummaryResponse[];
}

/**
 * Response from `GET /environments`.
 *
 * An array of available environments, each containing its action summaries.
 */
export type EnvironmentsResponse = EnvironmentInfo[];

/**
 * Request body for `POST /cards/:id/actions/:name`.
 *
 * Controls how the relayed action is executed by the extension client.
 */
export interface ExecuteActionRequest {
  /** Stable original caller identity, persisted before the first attempt. */
  requestId: OriginalCallerRequestId;

  /** Stable launch-message identity, persisted before the first attempt. */
  messageId: string;

  /** One-shot coding-agent override. Omitted to preserve default selection. */
  selectedAgent?: CodingAgentId;

  /** One-shot model override forwarded to the selected coding agent. */
  model?: string;

  /** One-shot reasoning-effort override forwarded to the selected coding agent. */
  effort?: string;

  /**
   * Execution mode for the action.
   *
   * When omitted, the server runs the action interactively (the default). An
   * explicit `'background'` request for an action that does not support
   * background mode is rejected with 400.
   */
  mode?: ExecutionMode;

  /**
   * When true, the spawned agent is signalled to exit cleanly once the action
   * completes rather than leaving the session open. When omitted, defaults to
   * false.
   */
  exitWhenDone?: boolean;

  /**
   * Ordered one-shot variable-group selection for this launch.
   *
   * Omission preserves the persisted selection; an explicit empty array
   * selects no variable groups.
   */
  variableGroupIds?: string[];
}

// ============================================================================
// Health API Types
// ============================================================================

/**
 * Response from `GET /health`.
 *
 * Used for monitoring and load balancer health checks. The response
 * indicates the server is operational and accepting requests.
 */
export interface HealthResponse {
  /**
   * Health status indicator.
   * Currently always `'healthy'` when the endpoint responds.
   */
  status: 'healthy';

  /**
   * Server uptime in seconds since the process started.
   */
  uptime: number;

  /**
   * ISO 8601 timestamp of when this health check was performed.
   */
  timestamp: string;

  /**
   * Component health details.
   * Includes status of subsystems like WebSocket connections.
   */
  components: {
    websocket: {
      status: 'healthy';
      connections: number;
    };
  };
}

// ============================================================================
// Internal API Types
// ============================================================================

/**
 * Request body for `POST /internal/card-post-commit`.
 *
 * Sent by the card-repo post-commit hook after a commit lands in a card
 * repository. Triggers card sync and emits a `card:commit` event.
 */
export interface CardPostCommitRequest {
  /** Card ID whose repository received the commit. */
  cardId: string;
  /** Commit SHA from `git rev-parse HEAD`. */
  commitSha: string;
}

/**
 * Response from `POST /internal/card-post-commit`.
 */
export interface CardPostCommitResponse {
  /** Whether the operation succeeded. */
  success: true;
}

/**
 * Request body for `POST /internal/workspace-post-commit`.
 *
 * Sent by the workspace post-commit hook after a commit lands in a workspace
 * repository. Emits a `workspace:commit` event.
 */
export interface WorkspacePostCommitRequest {
  /** Card ID associated with the workspace branch. */
  cardId: string;
  /** Commit SHA from `git rev-parse HEAD`. */
  commitSha: string;
  /** Absolute path to the workspace repository root. */
  workspacePath: string;
}

/**
 * Response from `POST /internal/workspace-post-commit`.
 */
export interface WorkspacePostCommitResponse {
  /** Whether the operation succeeded. */
  success: true;
}

/**
 * Response from `GET /internal/connections`.
 *
 * Returns information about active WebSocket connections for debugging
 * and monitoring purposes.
 */
export interface ConnectionsResponse {
  /**
   * Number of active WebSocket connections.
   */
  count: number;

  /**
   * Connection identifiers.
   * Currently returns an empty array; reserved for future use.
   */
  connectionIds: string[];
}

/**
 * Response from `GET /internal/activity-state`.
 *
 * Indicates whether the server is considered active based on
 * connection count and recent activity.
 */
export interface ActivityStateResponse {
  /**
   * Number of active WebSocket connections.
   */
  activeConnections: number;

  /**
   * Whether the server is considered active.
   * True when at least one connection exists.
   */
  isActive: boolean;
}

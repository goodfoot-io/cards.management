/**
 * Domain event payloads emitted by the Cards V2 backend.
 *
 * These shapes are shared between servers and clients to ensure consistent
 * event handling over WebSocket transports.
 *
 *
 * @summary Domain event payloads emitted by the Cards V2 backend
 * @module types/events
 */

import type { VariableGroupSummary } from './api-requests.js';
import type { BranchInfo } from './branch.js';
import type { CardGates, CardRelation } from './card.js';
import type { CodingAgentId } from './coding-agent.js';
import type { CompareState } from './compare.js';
import type { CardCommit } from './fs.js';
import type {
  CardJournalEventMessage,
  CardReplayMessage,
  CardSnapshotMessage,
  CardSubscribeFailedMessage
} from './journal.js';
import type { ActionResult, ExecutionMode } from './settings.js';
import type { CardStatus } from './status.js';
import type { StreamMeta } from './stream.js';
import type { CommentTimelineItem, CommitDetails, CommitTimelineItem } from './timeline.js';

// --- Card Events ---

/**
 * Event payload when a card is created.
 */
export interface CardCreatedEvent {
  /** Event type discriminator. */
  type: 'card:created';
  /** ID of the newly created card. */
  cardId: string;
  /** Repository identifier the card belongs to. */
  repositoryId: string;
  /** Absolute workspace path the card was created from, for window-scoped filtering. */
  workspacePath: string;
}

/**
 * Event payload when a card is deleted.
 */
export interface CardDeletedEvent {
  /** Event type discriminator. */
  type: 'card:deleted';
  /** ID of the deleted card. */
  cardId: string;
}

// --- Comment Events ---

/**
 * Event payload when a comment is created.
 */
export interface CommentCreatedEvent {
  /** Event type discriminator. */
  type: 'comment:created';
  /** ID of the parent card. */
  cardId: string;
  /** ID of the newly created comment. */
  commentId: string;
}

// --- Timeline Events ---

/**
 * Event payload when a comment is added to the timeline.
 */
export interface TimelineCommentAddedEvent {
  /** Event type discriminator. */
  type: 'timeline:comment:added';
  /** ID of the parent card. */
  cardId: string;
  /** Full comment timeline item. */
  item: CommentTimelineItem;
}

/**
 * Event payload when a comment on the timeline is updated.
 */
export interface TimelineCommentUpdatedEvent {
  /** Event type discriminator. */
  type: 'timeline:comment:updated';
  /** ID of the parent card. */
  cardId: string;
  /** Updated comment timeline item. */
  item: CommentTimelineItem;
}

/**
 * Event payload when a comment is removed from the timeline.
 */
export interface TimelineCommentRemovedEvent {
  /** Event type discriminator. */
  type: 'timeline:comment:removed';
  /** ID of the parent card. */
  cardId: string;
  /** ID of the removed comment. */
  commentId: string;
}

/**
 * Event payload when a commit is added to the timeline.
 */
export interface TimelineCommitAddedEvent {
  /** Event type discriminator. */
  type: 'timeline:commit:added';
  /** ID of the parent card. */
  cardId: string;
  /** Full commit timeline item. */
  item: CommitTimelineItem;
}

/**
 * Event payload when a commit is removed from the timeline.
 */
export interface TimelineCommitRemovedEvent {
  /** Event type discriminator. */
  type: 'timeline:commit:removed';
  /** ID of the parent card. */
  cardId: string;
  /** SHA of the removed commit. */
  sha: string;
}

// --- Attachment Events ---

/**
 * Event payload when an attachment is added to a card.
 */
export interface AttachmentAddedEvent {
  /** Event type discriminator. */
  type: 'attachment:added';
  /** ID of the card that received the attachment. */
  cardId: string;
  /** ID of the newly added attachment. */
  attachmentId: string;
}

/**
 * Event payload when an attachment is removed from a card.
 */
export interface AttachmentRemovedEvent {
  /** Event type discriminator. */
  type: 'attachment:removed';
  /** ID of the card that lost the attachment. */
  cardId: string;
  /** ID of the removed attachment. */
  attachmentId: string;
}

// --- Compare Events ---

/**
 * Event payload when a compare session is set or updated.
 */
export interface CompareChangedEvent {
  /** Event type discriminator. */
  type: 'compare:changed';
  /** The new active compare state. */
  state: CompareState;
}

/**
 * Event payload when the active compare session is cleared.
 */
export interface CompareClearedEvent {
  /** Event type discriminator. */
  type: 'compare:cleared';
}

// --- Stream Events ---

/**
 * Broadcast when a new stream is created and ready to receive lines.
 *
 * Fired immediately after the `.meta.json` file is committed with
 * `status: 'active'`. Subscribers can use this to render a new stream
 * viewer widget in the UI.
 */
export interface StreamStartedEvent {
  /** Event type discriminator. */
  type: 'stream:started';
  /** ID of the parent card. */
  cardId: string;
  /** Full stream metadata snapshot at creation time. */
  meta: StreamMeta;
}

/**
 * Broadcast when a terminated stream is reopened and ready to receive new lines.
 *
 * Fired immediately after the stream's `isActive` flag is set back to true and it is ready
 * to receive appends again. Subscribers can use this to re-enable stream viewer
 * widgets and reattach listeners that were released when the stream ended.
 */
export interface StreamResumedEvent {
  /** Event type discriminator. */
  type: 'stream:resumed';
  /** ID of the parent card. */
  cardId: string;
  /** Full stream metadata snapshot after resume (`isActive` will be true). */
  meta: StreamMeta;
  /** Number of lines the stream had before resume. */
  previousLineCount: number;
}

/**
 * Broadcast for each line appended to a stream.
 *
 * Contains the raw, unmodified NDJSON line as stored on disk. Clients are
 * responsible for applying any stream-type-specific transform on their side.
 * Use `streamType` together with `cardId` and `relPath` to unambiguously
 * identify the stream and select the appropriate client-side transform.
 */
export interface StreamLineEvent {
  /** Event type discriminator. */
  type: 'stream:line';
  /** ID of the parent card. */
  cardId: string;
  /** Stream's source-relative path (forward slashes, may be multi-segment) within its `streamType` directory. */
  relPath: string;
  /** Stream type key identifying the client-side transform to apply. */
  streamType: string;
  /** 1-based line number in the stream. */
  lineNumber: number;
  /** Raw, unmodified NDJSON line as stored on disk. */
  line: string;
}

/**
 * Broadcast when a stream is closed.
 *
 * After this event, no further `stream:line` events will be emitted for this
 * stream. The stream's `isActive` flag will be set to false in its metadata.
 */
export interface StreamEndedEvent {
  /** Event type discriminator. */
  type: 'stream:ended';
  /** ID of the parent card. */
  cardId: string;
  /** Stream's source-relative path (forward slashes, may be multi-segment) within its `streamType` directory. */
  relPath: string;
  /** Stream type key. */
  streamType: string;
  /** Total number of lines received before closure. */
  lineCount: number;
}

/**
 * Broadcast when a transform throws or times out on a single line.
 *
 * The stream continues processing; this is a per-line warning, not a
 * terminal event. The corresponding `stream:line` event for the same
 * `lineNumber` will carry the raw (untransformed) content as a fallback.
 */
export interface StreamErrorEvent {
  /** Event type discriminator. */
  type: 'stream:error';
  /** ID of the parent card. */
  cardId: string;
  /** Stream's source-relative path (forward slashes, may be multi-segment) within its `streamType` directory. */
  relPath: string;
  /** 1-based line number where the transform failed. */
  lineNumber: number;
  /** Human-readable error message from the transform. */
  error: string;
}

// --- Filesystem Events ---

/**
 * Event payload emitted after each card repository commit is reindexed.
 *
 * Carries the full commit metadata so clients can update their file index
 * without a round-trip to `GET /cards/:id/git/log`.
 */
export interface CardCommitEvent {
  /** Event type discriminator. */
  type: 'card:commit';
  /** ID of the card whose repository received this commit. */
  cardId: string;
  /** Full commit metadata including per-file diff. */
  commit: CardCommit;
}

// --- Workspace Events ---

/**
 * Event payload emitted after a workspace commit is processed for a card.
 *
 * Carries the new HEAD SHA so clients can refresh branch and merge status
 * without requiring the user to close and reopen the panel.
 */
export interface WorkspaceCommitEvent {
  /** Event type discriminator. */
  type: 'workspace:commit';
  /** ID of the card whose workspace branch received this commit. */
  cardId: string;
  /** HEAD SHA of the workspace repository after the commit. */
  sha: string;
  /** Tracked branches with computed fields. Optional — absent if git operations failed at broadcast time. */
  branches?: BranchInfo[];
  /** All card-level commit SHAs from commits.csv. Optional. */
  commits?: string[];
  /** Default branch of the workspace repository. Optional. */
  defaultBranch?: string;
  /** SHAs of card commits merged into HEAD. Optional. */
  mergedCommits?: string[];
  /** Branch name checked out at the workspace. Optional. */
  headBranch?: string;
  /** Details for the newly attributed commit. */
  commitDetail?: CommitDetails;
}

/**
 * Event payload emitted when the incoming relations list for a card changes.
 *
 * Broadcast after any REST-layer mutation to card relations. Carries the
 * complete updated list so clients can replace their local state without
 * a round-trip.
 */
export interface CardIncomingRelationsChangedEvent {
  /** Event type discriminator. */
  type: 'card:incomingRelationsChanged';
  /** ID of the card whose incoming relations changed. */
  cardId: string;
  /** Updated list of incoming relations targeting this card. */
  incomingRelations: CardRelation[];
}

/**
 * Data-carrying event emitted after card metadata changes.
 *
 * Contains all fields needed to build a {@link CardListSummary} without
 * an HTTP fetch. Emitted from `POST /internal/card-post-commit` and the
 * store event bridge.
 */
export interface CardsMetadataEvent {
  /** Event type discriminator. */
  type: 'cards:metadata';
  /** ID of the card whose metadata changed. */
  cardId: string;
  /** Repository identifier the card belongs to. */
  repositoryId: string;
  /**
   * Workspace branch the card was created from (e.g., 'main').
   */
  parentBranch: string;
  /** Card title. */
  title: string;
  /** Current status. */
  status: CardStatus;
  /** Tags for categorization and search. */
  tags: string[];
  /** Whether the card is pinned. */
  isPinned: boolean;
  /** Display order within a status column. */
  order: number;
  /** Gate state. */
  gates: CardGates;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
  /** Merge status of workspace commits. `null` when unknown or no workspace commits exist. */
  isMerged: boolean | null;
  /** Whether plan documents are newer than the latest commit. Suppresses `merged` when true. */
  hasPlanDrift: boolean;
  /** Outgoing relations from this card. */
  relations: CardRelation[];
  /** Incoming relations targeting this card. */
  incomingRelations: CardRelation[];
  /** Whether the card has unread activity since the user last viewed its timeline. */
  hasUnread: boolean;
}

// --- Action Events ---

/**
 * Event payload requesting execution of a card action.
 */
export interface ActionExecuteRequestEvent {
  /** Event type discriminator. */
  type: 'action:executeRequest';
  /** Correlation ID linking the request to its result. */
  correlationId: string;
  /** Stable original caller identity, reused unchanged by every retry. */
  requestId: string;
  /** Stable launch-message identity, reused unchanged by every retry. */
  messageId: string;
  /** ID of the card whose action is being executed. */
  cardId: string;
  /** ID of the action to execute. */
  actionId: string;
  /** Name of the environment in which to run the action. */
  environmentName: string;
  /** Absolute workspace path of the single executor that should handle the action. */
  workspacePath: string;
  /** One-shot coding-agent override. Omitted to preserve default selection. */
  selectedAgent?: CodingAgentId;
  /** Execution mode controlling whether the action runs interactively or in the background. */
  mode: ExecutionMode;
  /** When true, the spawned agent is signalled to exit cleanly once the action completes. */
  exitWhenDone: boolean;
  /** Ordered one-shot variable-group selection; omission preserves persisted selection. */
  variableGroupIds?: string[];
}

/**
 * Event payload carrying the result of a card action execution.
 */
export interface ActionExecuteResultEvent {
  /** Event type discriminator. */
  type: 'action:executeResult';
  /** Correlation ID linking this result back to its originating request. */
  correlationId: string;
  /** Outcome of the action execution. */
  result: ActionResult;
}

/** Client-to-server registration of the executor for a workspace. */
export interface ActionExecutorRegisterMessage {
  /** Message type discriminator. */
  type: 'action:executorRegister';
  /** Absolute path of the workspace this connection can execute actions for. */
  workspacePath: string;
  /** Repository identifier used to resolve linked worktrees safely. */
  repositoryId: string;
}

/** Event requesting safe variable-group summaries for an exact workspace. */
export interface VariableGroupListRequestEvent {
  /** Event type discriminator. */
  type: 'variableGroup:listRequest';
  /** Correlation ID linking the request to its result. */
  correlationId: string;
  /** Absolute workspace path of the single executor that should handle the request. */
  workspacePath: string;
}

/** Event returning safe variable-group summaries or a relay-safe error. */
export interface VariableGroupListResultEvent {
  /** Event type discriminator. */
  type: 'variableGroup:listResult';
  /** Correlation ID linking this result back to its originating request. */
  correlationId: string;
  /** Listing outcome. */
  result: { success: true; groups: VariableGroupSummary[] } | { success: false; error: string };
}

/** Client-to-server action relay messages. */
export type ActionClientMessage =
  | ActionExecutorRegisterMessage
  | ActionExecuteResultEvent
  | VariableGroupListResultEvent;

// --- Domain Event Union ---

/**
 * Discriminated union of all domain events.
 *
 * The `type` field enables safe narrowing in switch statements so callers can
 * respond to specific event payloads without unsafe casts.
 *
 * @example
 * ```typescript
 * function handleEvent(event: DomainEvent): void {
 *   switch (event.type) {
 *     case 'cards:metadata':
 *       console.log(event.title);
 *       break;
 *     case 'comment:created':
 *       console.log(event.commentId);
 *       break;
 *     default:
 *       break;
 *   }
 * }
 * ```
 */
export type DomainEvent =
  | CardCreatedEvent
  | CardDeletedEvent
  | CommentCreatedEvent
  | AttachmentAddedEvent
  | AttachmentRemovedEvent
  | TimelineCommentAddedEvent
  | TimelineCommentUpdatedEvent
  | TimelineCommentRemovedEvent
  | TimelineCommitAddedEvent
  | TimelineCommitRemovedEvent
  | StreamStartedEvent
  | StreamResumedEvent
  | StreamLineEvent
  | StreamEndedEvent
  | StreamErrorEvent
  | CompareChangedEvent
  | CompareClearedEvent
  | CardCommitEvent
  | WorkspaceCommitEvent
  | CardIncomingRelationsChangedEvent
  | CardsMetadataEvent
  | ActionExecuteRequestEvent
  | ActionExecuteResultEvent
  | VariableGroupListRequestEvent
  | VariableGroupListResultEvent
  // Journal / subscribe-replay protocol (server -> client only; the client ->
  // server CardSubscribeMessage/CardUnsubscribeMessage half of the protocol
  // lives in ./journal.js and is not part of this receive-side union).
  | CardReplayMessage
  | CardSnapshotMessage
  | CardSubscribeFailedMessage
  | CardJournalEventMessage;

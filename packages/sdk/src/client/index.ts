/**
 * HTTP client for CRUD operations against the Cards V2 REST API and a
 * WebSocket event subscriber for real-time card, timeline, and stream
 * change notifications.
 *
 * @summary REST client, WebSocket event subscriber, and API discovery for the Cards V2 API
 * @module
 */

// Compare types (re-exported from protocol for convenience)
export type {
  CompareBranchRangeRequest,
  CompareDynamicRequest,
  CompareFixedAttributionRequest,
  CompareMode,
  CompareRequest,
  CompareState
} from '../protocol/index.js';
// Card repo filters (browser-safe)
export {
  BOOKKEEPING_PATHSPEC_EXCLUSIONS,
  CARD_REPO_LOG_PATHSPEC_EXCLUSIONS,
  formatCommit,
  getUnattributedCommits,
  isBookkeepingCommit
} from './cardRepoFilters.js';
export {
  CardsClient,
  type ExecutionProcessStatus,
  type RootCommandCompletion,
  type RootCommandInputs,
  type RunRootCommandOptions
} from './cardsClient.js';
export { calculateBackoffMs, EventSubscriber } from './eventSubscriber.js';
// Client types
export type {
  AddBranchRequest,
  AttachmentResponse,
  BranchesResponse,
  BranchInfo,
  CardCreateData,
  CardsClientOptions,
  CardUpdateData,
  ListCardsOptions,
  TimelineOptions
} from './types/client.js';
// Error classes
export {
  ApiError,
  CARD_DELETE_REFUSAL_CODES,
  type CardDeleteRefusalCode,
  CardDeleteRefusedError,
  NetworkError,
  RequestCancelledError,
  RetryExhaustedError,
  RootCommandError,
  type RootCommandFailureCause
} from './types/errors.js';
// Event types
export type { DiscoverResult, EventCallback, EventMap, EventSubscriberOptions } from './types/events.js';

/**
 * Individual protocol type definitions organized by domain: card structures,
 * lifecycle statuses, REST request/response shapes, WebSocket events, settings
 * schemas, webview messaging contracts, and input constraint constants.
 *
 * @summary Domain-organized protocol types, events, and constraint constants
 * @module types
 */

// --- API Discovery Types ---
export type { CardsApiInfo, SessionBaseline } from './api.js';
// --- API Request/Response Types ---
export type {
  ActionSummaryResponse,
  ActivityStateResponse,
  AddCommitRequest,
  AttachmentResponse,
  CardCreateGates,
  CardPostCommitRequest,
  CardPostCommitResponse,
  CardResponse,
  CommitAttributionResponse,
  ConnectionsResponse,
  CreateAttachmentRequest,
  CreateCardRequest,
  EnvironmentInfo,
  EnvironmentsResponse,
  GateApprovalResponse,
  GateName,
  HasUpdatesResponse,
  HealthResponse,
  ListCardsRequest,
  ListTagsRequest,
  TagsResponse,
  TimelineRequest,
  TimelineResponse,
  UpdateCardRequest,
  VariableGroupSummary,
  VariableGroupsResponse,
  WorkspacePostCommitRequest,
  WorkspacePostCommitResponse
} from './api-requests.js';
// --- Branch Types ---
export type {
  AddBranchRequest,
  AddBranchResponse,
  BranchesResponse,
  BranchInfo,
  BranchOwnerExpectation,
  BranchRegistrationIntent,
  RemoveBranchRequest,
  RemoveBranchResponse,
  UpdateBranchOwnerRequest,
  UpdateBranchOwnerResponse,
  WorkspaceBranch
} from './branch.js';
export {
  BRANCHES_DIR,
  COMMITS_DIR,
  EMPTY_TREE_SHA,
  UpdateBranchOwnerRequestSchema
} from './branch.js';
// --- Card Types ---
export type { Card, CardGates, CardMetadata, CardRelation, CardRelationType } from './card.js';
export { CARD_RELATION_TYPES, DEFAULT_CARD_GATES } from './card.js';
// --- Coding Agent Types ---
export type { CodingAgentId } from './coding-agent.js';
export { CODING_AGENT_IDS, isCodingAgentId } from './coding-agent.js';
// --- Compare Types ---
export type {
  CompareBranchRangeRequest,
  CompareDynamicRequest,
  CompareFixedAttributionRequest,
  CompareMode,
  CompareRequest,
  CompareState
} from './compare.js';
// --- Input Constraints ---
export {
  MAX_ID_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  TAG_PATTERN
} from './constraints.js';
export type { HtmlFileCspPolicyOptions } from './csp.js';
// --- HTML File CSP ---
export { buildHtmlFileCspPolicy } from './csp.js';
// --- WebSocket Event Types ---
export type {
  ActionClientMessage,
  AttachmentAddedEvent,
  AttachmentRemovedEvent,
  CardCommitEvent,
  CardCreatedEvent,
  CardDeletedEvent,
  CardIncomingRelationsChangedEvent,
  CardsMetadataEvent,
  CommentCreatedEvent,
  CompareChangedEvent,
  CompareClearedEvent,
  DomainEvent,
  StreamEndedEvent,
  StreamErrorEvent,
  StreamLineEvent,
  StreamResumedEvent,
  StreamStartedEvent,
  TimelineCommentAddedEvent,
  TimelineCommentRemovedEvent,
  TimelineCommentUpdatedEvent,
  TimelineCommitAddedEvent,
  TimelineCommitRemovedEvent,
  VariableGroupListRequestEvent,
  VariableGroupListResultEvent,
  WorkspaceCommitEvent
} from './events.js';
// --- Filesystem Types ---
export type { CardCommit, CardCommitDiffUnavailable, CardCommitFile, CardSnapshot } from './fs.js';
// --- Filesystem Callback Types ---
export type {
  AsyncFileExistsCallback,
  AsyncListFilesCallback,
  AsyncReadFileCallback,
  AsyncWriteFileCallback,
  FileExistsCallback,
  ListFilesCallback,
  ReadFileCallback
} from './fs-callbacks.js';
// --- Hook Configuration Types ---
export type { HookConfig, HookEvent, HookScript } from './hooks.js';
// --- HTML File Types ---
export type {
  CollectedResourceReference,
  ElementSpan,
  HtmlContentCheckResult,
  HtmlCssSource,
  HtmlDocumentFacts,
  HtmlInfoFile,
  HtmlInfoValidationResult,
  HtmlInlineEventHandler,
  HtmlIntrinsicLayoutCheckResult,
  HtmlIntrinsicLayoutInputs,
  HtmlStylesheetReference,
  ResourceReferenceClass,
  ScriptSpan
} from './html.js';
export {
  BASE_ELEMENT_TAG_NAMES,
  checkHtmlContent,
  checkIntrinsicHtmlLayout,
  classifyResourceReference,
  collectResourceReferences,
  FRAME_ELEMENT_TAG_NAMES,
  filterStructuralParseErrors,
  htmlCardDocPathForSidecar,
  htmlCardDocSidecarPath,
  INFORMATIONAL_PARSE5_CODES,
  isHtmlCardDocPath,
  isHtmlCardDocSidecarPath,
  validateHtmlInfo
} from './html.js';
// --- HTTP Client Types ---
export type { HttpClient } from './http.js';
// --- Per-Card Journal / Subscribe-Replay Protocol Types ---
export type {
  CardJournalClientMessage,
  CardJournalEntry,
  CardJournalEventMessage,
  CardJournalServerMessage,
  CardReplayMessage,
  CardSnapshotMessage,
  CardSubscribeFailedMessage,
  CardSubscribeMessage,
  CardUnsubscribeMessage,
  MergeStatusSnapshot,
  MergeStatusValue,
  PlanDriftValue
} from './journal.js';
// --- Notification Types ---
export type { NotificationCreateRequest, NotificationSeverity } from './notifications.js';
// --- Response Envelope Types ---
export type { ApiError, ApiSuccess, FieldError } from './response.js';
// --- Runtime Protocol: Launch Admission ---
export type {
  AdmissionRejectionReason,
  AdmissionScope,
  AdmissionUncertaintyReason,
  AdmittedLaunchCredentials,
  BoundExecution,
  ClientLaunchAdmission,
  CredentialRefusalReason,
  ImmutableActionParams,
  IssuedRoleCredential,
  LaunchAdmissionRefusal,
  LaunchAdmissionRequest,
  LaunchOutcome,
  OriginalCallerRequestId,
  PresentedCredential,
  ReplayedLaunchAdmission,
  RetrievedAdmission,
  SpawnPhase
} from './runtime-admission.js';
// --- Runtime Protocol: Authorization and Delivery Table ---
export {
  type AuthorizationContext,
  type AuthorizationOutcome,
  type AuthorizationRefusalReason,
  authorizeMessage,
  deliveryClassFor,
  type ExecutionRequirement,
  type MessageContract,
  type MessageDirection,
  RUNTIME_MESSAGE_CONTRACTS
} from './runtime-authorization.js';
export {
  CHILD_RUNTIME_CREDENTIAL_ROLES,
  type ChildRuntimeCredentialRole,
  type RuntimeCredentialFile,
  runtimeCredentialFileSchema
} from './runtime-credential-file.js';
// --- Runtime Protocol: Delivery Classes ---
export {
  authorizeTermination,
  canRetireDurableResult,
  DELIVERY_CLASS_POLICIES,
  DELIVERY_CLASSES,
  type DeliveryClass,
  type DeliveryClassPolicy,
  type DeliveryDecision,
  type DeliveryDisposition,
  type DurableIntentRecord,
  type DurableResultRecord,
  deliveryClassSchema,
  evaluateDisposableTelemetry,
  evaluateDurableIntent,
  evaluateDurableResult,
  evaluateReadinessReceipt,
  evaluateReconciledSnapshot,
  type ReadinessRecord,
  type SnapshotStamp,
  type TelemetryBufferState,
  type TerminationAuthorization,
  type TerminationAuthorizationInput,
  type TerminationRefusalReason
} from './runtime-delivery.js';
// --- Runtime Protocol: Envelope ---
export {
  type EnvelopeRejectionReason,
  EnvelopeValidationError,
  envelopeHeaderSchema,
  parseEnvelope,
  type RuntimeEnvelope
} from './runtime-envelope.js';
// --- Runtime Protocol: Identity and State ---
export {
  CONNECTION_STATES,
  type ConnectionState,
  compareOwnership,
  connectionStateSchema,
  EXECUTION_LIFECYCLE_STATES,
  type ExecutionIdentity,
  type ExecutionLifecycleState,
  type ExecutionRef,
  executionIdentitySchema,
  executionLifecycleStateSchema,
  executionRefSchema,
  isAdmittedExecution,
  type OwnershipComparison,
  type OwnershipStamp,
  ownershipStampSchema,
  PRODUCER_ROLES,
  type ProducerIdentity,
  type ProducerRole,
  producerIdentitySchema,
  producerRoleSchema,
  type RuntimeScope,
  runtimeScopeSchema
} from './runtime-identity.js';
// --- Runtime Protocol: Message Catalogue ---
export {
  launchRequestPayloadSchema,
  MAX_CONTROL_FRAME_BYTES,
  RUNTIME_MESSAGE_PAYLOADS,
  RUNTIME_MESSAGE_TYPES,
  type RuntimeCapabilities,
  type RuntimeMessageType,
  type RuntimePayload,
  runtimeMessageTypeSchema,
  worktreeAssignmentResultPayloadSchema
} from './runtime-messages.js';
// --- Runtime Protocol: Transition Tables ---
export {
  CONNECTION_TRANSITIONS,
  CONNECTION_TRIGGERS,
  type ConnectionTransition,
  type ConnectionTrigger,
  EXECUTION_LIFECYCLE_TRANSITIONS,
  findConnectionTransition,
  findLifecycleTransition,
  LIFECYCLE_GUARDS,
  type LifecycleGuard,
  type LifecycleTransition,
  type LifecycleTrigger,
  TERMINAL_LIFECYCLE_STATES
} from './runtime-transitions.js';
// --- Runtime Protocol: Transport and Connection Fencing ---
export type {
  ConnectionGeneration,
  ConnectionSlotKey,
  ConnectionSubject,
  FrameRefusalReason,
  RegistrationOutcome,
  RegistrationRefusalReason
} from './runtime-transport.js';
export {
  connectionGenerationSchema,
  connectionSlotKeySchema,
  connectionSubjectSchema,
  FRAME_REFUSAL_REASONS,
  frameRefusalReasonSchema,
  INITIAL_CONNECTION_GENERATION,
  MAX_OUTSTANDING_MESSAGES,
  REGISTRATION_REFUSAL_REASONS,
  RUNTIME_CREDENTIAL_HEADERS,
  RUNTIME_UPGRADE_PATH,
  registrationOutcomeSchema,
  registrationRefusalReasonSchema
} from './runtime-transport.js';
// --- Runtime Protocol: Version Gate ---
export {
  assertSupportedProtocolVersion,
  protocolVersionSchema,
  RUNTIME_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsupportedProtocolVersionError
} from './runtime-version.js';
// --- Settings Types ---
export type {
  Action,
  ActionResult,
  ActionState,
  CardsAssistant,
  Command,
  Environment,
  ExecutionMode,
  Settings
} from './settings.js';
// --- Status Types ---
export type {
  CardStatus,
  ProcessState,
  SessionType
} from './status.js';
// --- Stream Types ---
export type {
  AttachmentInfoFile,
  StreamDefinition,
  StreamMeta,
  StreamMetaFile
} from './stream.js';
// --- Timeline Types ---
export type {
  Comment,
  CommentTimelineItem,
  CommitAuthor,
  CommitDetails,
  CommitStats,
  CommitTimelineItem,
  FileChange,
  TimelineItem
} from './timeline.js';
// --- Validation Types ---
export type { ValidationErrorCode } from './validation.js';
// --- Webview Messaging Types ---
export type {
  ActionMessage,
  ApiRequestMessage,
  ApiResponseMessage,
  CardDetailMessage,
  EventMessage,
  ExtensionToWebviewMessage,
  LaunchClaudeAction,
  NavigateMessage,
  ServerChangedMessage,
  StateUpdateMessage,
  ThemeUpdateMessage,
  ValidationErrorMessage,
  WebviewAction,
  WebviewDidConnectMessage,
  WebviewState,
  WebviewTimelineEntry,
  WebviewToExtensionMessage
} from './webview.js';
// --- Wrapper Command Types ---
export type {
  CancelAcknowledgment,
  CancelCommand,
  SwitchToInteractiveCommand,
  WrapperCommand,
  WrapperErrorResponse,
  WrapperResponse
} from './wrapper-commands.js';

/**
 * Type-safe configuration authoring for the Cards extension, providing factory
 * functions to define actions and stream transforms along with environment
 * helpers, structured logging, and a runtime executor that compiles
 * configuration into deployable settings.
 *
 * @summary Configuration authoring and runtime execution for Cards extensions
 * @module
 */

// ============================================================================
// Detached Child Output
// ============================================================================

export {
  DETACHED_CHILD_LOG_FILENAME,
  DETACHED_CHILD_RECORD_PREFIX,
  type DetachedChildCaptureIdentity,
  type DetachedChildOutputCapture,
  type DetachedChildOutputCaptureFailure,
  type DetachedChildOutputCaptureResult,
  type DetachedChildOutputPathResult,
  prepareDetachedChildOutputCapture,
  resolveDetachedChildOutputPath
} from './detached-child-output.js';

// ============================================================================
// Action Factories
// ============================================================================

export {
  type ActionConfig,
  type ActionHandler,
  defineAction
} from './factories/action.js';
export {
  type CardsAssistantConfig,
  type CardsAssistantHandler,
  defineCardsAssistant
} from './factories/cards-assistant.js';

// ============================================================================
// Configuration
// ============================================================================

export type {
  EnvironmentConfig,
  SettingsConfig,
  StreamConfigDefinition
} from './config.js';
export { defineConfig } from './define-config.js';

// ============================================================================
// Schema Types
// ============================================================================

export type {
  Action,
  CardsAssistant,
  Command,
  Environment,
  Settings,
  StreamDefinition
} from './schema.js';

// ============================================================================
// Input Types
// ============================================================================

export type {
  ActionContext,
  ActionInput,
  AgentTerminationResult,
  CardsAssistantContext,
  CardsAssistantInput
} from './inputs.js';

// ============================================================================
// Command Types
// ============================================================================

export type { ActionCommand, CardsAssistantCommand } from './command-types.js';

// ============================================================================
// Type Utilities
// ============================================================================

export type { SameShape } from './type-utils.js';

// ============================================================================
// Environment Variables
// ============================================================================

export {
  CARDS_ENV_VARS,
  extractActionInput,
  extractCardsAssistantInput,
  getBaseBranch,
  getCardRepoPath,
  getExecutionMode,
  getRuntimeCredentialFilePath,
  getWorkspaceBranch,
  getWorkspacePath,
  readSwitchToInteractiveData,
  vscodeNodeCommandRef
} from './env.js';
export {
  clearPendingShutdownRequest,
  type PendingShutdownRequest,
  readPendingShutdownRequest,
  type ShutdownReadyMessage,
  writePendingShutdownRequest
} from './shutdown.js';

// ============================================================================
// Exit Codes
// ============================================================================

export {
  EXIT_CODES,
  type ExitCode,
  writeError
} from './exit-codes.js';

// ============================================================================
// Logger
// ============================================================================

export {
  type ILogger,
  LOG_LEVELS,
  type LogEvent,
  type LogEventError,
  type LogEventHandler,
  Logger,
  type LoggerConfig,
  type LogLevel,
  resolveLogFilePath,
  type Unsubscribe
} from './logger.js';

// ============================================================================
// IPC Endpoint
// ============================================================================

export { createIpcEndpoint, createNonexistentIpcEndpoint } from './ipc-endpoint.js';

// ============================================================================
// Runtime
// ============================================================================

export { executeCommand } from './runtime.js';

// ============================================================================
// Watcher
// ============================================================================

export type {
  ServerControlMessage,
  ServerHelloAckMessage,
  ServerToWatcherMessage,
  WatcherContext,
  WatcherEventMessage,
  WatcherHelloMessage,
  WatcherLogMessage,
  WatcherStopAckMessage,
  WatcherToServerMessage
} from './watcher/index.js';
export {
  socketEndpoint,
  type WatcherHandle,
  type WatcherHandler,
  WatcherHandshakeError,
  type WatcherRegistration,
  WatcherRegistrationError
} from './watcher/index.js';

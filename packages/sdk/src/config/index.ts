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
export {
  defineWorktreeMaintenance,
  type WorktreeMaintenanceConfig,
  type WorktreeMaintenanceHandler
} from './factories/worktree-maintenance.js';

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
  StreamDefinition,
  WorktreeMaintenance
} from './schema.js';

// ============================================================================
// Input Types
// ============================================================================

export type {
  ActionContext,
  ActionInput,
  CardsAssistantContext,
  CardsAssistantInput,
  WorktreeMaintenanceContext,
  WorktreeMaintenanceInput
} from './inputs.js';

// ============================================================================
// Command Types
// ============================================================================

export type { ActionCommand, CardsAssistantCommand, WorktreeMaintenanceCommand } from './command-types.js';

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
  extractWorktreeMaintenanceInput,
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
// Runtime
// ============================================================================

export { executeCommand } from './runtime.js';
export {
  configureShutdown,
  createShutdownCoordinator,
  installShutdownSignalHandlers,
  registerShutdownHook,
  SHUTDOWN_BUDGET_MS,
  type ShutdownConfiguration,
  type ShutdownCoordinator,
  type ShutdownCoordinatorOptions,
  ShutdownError,
  type ShutdownHook,
  type ShutdownReason,
  shutdownAndExit,
  shutdownSignal
} from './runtime-shutdown.js';

// ============================================================================
// Watcher
// ============================================================================

export type { WatcherContext } from './watcher/index.js';
export {
  type WatcherRegistration,
  WatcherRegistrationError
} from './watcher/index.js';

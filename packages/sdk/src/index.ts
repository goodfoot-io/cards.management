/**
 * Unified SDK for the Cards V2 extension ecosystem, consolidating protocol
 * type definitions, HTTP/WebSocket client capabilities, and type-safe
 * configuration authoring into a single importable surface.
 *
 * @summary Cards V2 SDK combining protocol types, client, and configuration utilities
 * @module
 */

export {
  CARDS_DIR_NAME,
  generateRepoId,
  resolveGlobalCardsConfigDir,
  resolveWorktreeDir,
  resolveWorktreesRoot
} from './cards-config.js';
// Re-export all protocol types at the top level for convenience
export * from './protocol/index.js';

// Re-export configuration exports, excluding names that collide with protocol.
// The colliding configuration types (Action, Command, Environment, Settings,
// StreamDefinition) are available via the `@cards.management/sdk/config` subpath export.

// --- Card Repo Layout ---
export {
  ATTACHMENTS_DIR,
  ATTACHMENTS_PREFIX,
  COMMENTS_DIR,
  COMMENTS_PREFIX,
  PLANS_DIR,
  PLANS_PREFIX
} from './cardRepoLayout.js';
// --- cardsParent git config + bind-time resolver ---
export {
  type CardsParentRefused,
  type CardsParentResolved,
  type CardsParentResult,
  resolveCardsParentBranch,
  writeCardsParentConfig
} from './cardsParentBranch.js';
// --- Command Types ---
export type { ActionCommand } from './config/command-types.js';
// --- Configuration ---
export type {
  EnvironmentConfig,
  SettingsConfig,
  StreamConfigDefinition
} from './config/config.js';
export { defineConfig } from './config/define-config.js';
// --- Environment Variables ---
export {
  CARDS_ENV_VARS,
  extractActionInput,
  getExecutionMode,
  readSwitchToInteractiveData,
  resolveExtensionPath
} from './config/env.js';
// --- Exit Codes ---
export {
  EXIT_CODES,
  type ExitCode,
  writeError
} from './config/exit-codes.js';
// --- Action Factories ---
export {
  type ActionConfig,
  type ActionHandler,
  defineAction
} from './config/factories/action.js';
// --- Input Types ---
export type {
  ActionContext,
  ActionInput
} from './config/inputs.js';
// --- Logger ---
export {
  type ILogger,
  LOG_LEVELS,
  type LogEvent,
  type LogEventError,
  type LogEventHandler,
  Logger,
  type LoggerConfig,
  type LogLevel,
  type Unsubscribe
} from './config/logger.js';
// --- Runtime ---
export { executeCommand } from './config/runtime.js';
// --- Type Utilities ---
export type { SameShape } from './config/type-utils.js';
// --- Git Hooks ---
export {
  atomicWriteHookFile,
  compiledHookScriptPaths,
  type HookFileFs,
  type HookName,
  RESOLVE_NODE_BASH
} from './git-hooks.js';
// --- Process Tree ---
export { findAgentPid, isAgentProcessTreeDrained, PROCESS_TREE_MAX_DEPTH } from './process-tree.js';
// --- Scaffold Dir ---
export { resolveScaffoldDir, resolveScaffoldDirFromSource } from './scaffold-dir.js';
// --- Session Resolver ---
export { resolveSessionId } from './session-resolver.js';
// --- Symlink Capability ---
export { canCreateSymlinks, invalidateSymlinkCapability } from './symlink-capability.js';
// --- Theme CSS value safety ---
export { isSafeCssValue, KNOWN_VALUE_SHAPES } from './theme/cssValue.js';
// --- Timer Utilities ---
export {
  type CreateDebounceOptions,
  createDebounce,
  type DebounceHandle,
  TimeoutError,
  type WithTimeoutOptions,
  withTimeout
} from './timer.js';
// --- Unbound-worktree candidate set ---
export {
  addUnboundCandidate,
  clearUnboundCandidates,
  readUnboundCandidates,
  removeUnboundCandidate,
  type UnboundWorktreeCandidate
} from './unboundWorktreeCandidates.js';
// --- Worktree ---
export { SymlinkPrivilegeError } from './worktree.js';

/**
 * Settings schema types for the actions-based execution system.
 *
 * This module defines the `settings.json` structure that provides composable
 * environments containing actions. Settings are loaded from project, user,
 * and default locations with complete override semantics (later sources
 * replace earlier ones for each environment key).
 *
 * The settings system replaces the older hooks-based architecture with a more
 * flexible model where:
 *
 * - **Environments** group related configurations by deployment target
 * - **Actions** define executable workflows with start/end lifecycle commands
 *
 *
 * @summary Settings schema types for the actions-based execution system
 * @example
 * ```json
 * // settings.json
 * {
 *   "environments": {
 *     "default": {
 *       "version": 1,
 *       "description": "Standard development workflow",
 *       "actions": [
 *         {
 *           "name": "Start Work",
 *           "description": "Begin implementation session",
 *           "command": { "command": "npx claude-code" },
 *           "supportsBackgroundMode": true
 *         }
 *       ],
 *     }
 *   }
 * }
 * ```
 *
 * @module types/settings
 */

import type { StreamDefinition } from './stream.js';

// --- Command ---

/**
 * Configuration for a shell command execution.
 *
 * Commands are executed in a shell context with the working directory set
 * to the workspace root. Environment variables from the parent process are
 * inherited, and additional card-specific variables are injected.
 *
 * @example
 * ```typescript
 * const command: Command = {
 *   command: 'npm run build && npm test',
 *   timeout: 60000  // 1 minute timeout
 * };
 * ```
 */
export interface Command {
  /**
   * Shell command to execute.
   * Supports shell features like pipes, redirects, and command chaining.
   * Working directory is the workspace root.
   */
  command: string;

  /**
   * Timeout in milliseconds before the command is terminated.
   * Defaults to 30000 (30 seconds) if omitted.
   * Long-running processes should set appropriate values.
   */
  timeout?: number;
}

// --- Action ---

/**
 * An action that can be invoked on a card.
 *
 * Actions represent executable workflows. They appear as buttons in the
 * card UI and can run in interactive (terminal) or background mode. Each
 * action has a command that executes the workflow.
 *
 * @example
 * ```typescript
 * const action: Action = {
 *   id: 'implement',
 *   name: 'Start Implementation',
 *   description: 'Launch Claude Code for this card',
 *   command: { command: 'npx claude-code --card $CARD_ID' },
 *   supportsBackgroundMode: true,
 *   allowConcurrent: false
 * };
 * ```
 */
export interface Action {
  /**
   * Stable identifier for telemetry, localization, and action lookup.
   * Should be lowercase with hyphens (e.g., `'start-implementation'`).
   */
  id: string;

  /**
   * Display name shown on the action button.
   * Keep it short and action-oriented (e.g., "Start Work", "Review Code").
   */
  name: string;

  /**
   * Human-readable description shown in the button tooltip.
   * Explains what the action does when invoked.
   */
  description?: string;

  /**
   * Path to icon file for the action button.
   * Supports path variables like `${workspaceRoot}` and `${extensionPath}`.
   */
  icon?: string;

  /**
   * Command executed when the action is invoked.
   * This is the primary workflow entry point.
   */
  command: Command;

  /**
   * Whether the execution mode toggle is shown in the UI.
   * When true, users can choose between interactive (terminal) and
   * background execution. Defaults to false.
   */
  supportsBackgroundMode?: boolean;

  /**
   * Whether multiple instances can run on the same card simultaneously.
   * When false (the default), starting a new instance cancels any
   * existing running instance of this action.
   */
  allowConcurrent?: boolean;
}

// --- Environment ---

/**
 * An environment groups related actions.
 *
 * Environments represent deployment targets or workflow contexts (e.g.,
 * "development", "staging", "production"). Each card is assigned to an
 * environment, which determines the available actions.
 *
 * @example
 * ```typescript
 * const env: Environment = {
 *   version: 1,
 *   description: 'Development environment with full tooling',
 *   actions: [
 *     { name: 'Start Work', command: { command: 'npx claude-code' } },
 *     { name: 'Run Tests', command: { command: 'npm test' } }
 *   ]
 * };
 * ```
 */
export interface Environment {
  /**
   * Schema version (integer) for forward compatibility.
   * Increment when the environment structure changes in breaking ways.
   * Currently expected to be `1`.
   */
  version: number;

  /**
   * Human-readable description shown in the environment selector tooltip.
   * Helps users understand the purpose of this environment.
   */
  description?: string;

  /**
   * Array of available actions in this environment.
   * Actions appear as buttons in the card action menu.
   * An empty array is valid but triggers a configuration warning.
   */
  actions: Action[];

  /**
   * Stream type definitions keyed by type name (e.g., `"claude-session"`).
   *
   * Each entry configures the transform module and size guardrails for a
   * particular kind of JSONL stream. Type names must be lowercase with
   * hyphens (`/^[a-z][a-z0-9-]*$/`).
   *
   * @see StreamDefinition for the per-type configuration shape.
   */
  streams?: Record<string, StreamDefinition>;
}

// --- Settings ---

/**
 * Root `settings.json` structure containing all environments.
 *
 * Settings are loaded from multiple sources in priority order:
 * 1. Project settings (`.cards/settings.json` in workspace)
 * 2. User settings (`~/.config/cards/settings.json`)
 * 3. Default settings (bundled with the extension)
 *
 * Each environment key in later sources completely replaces the same key
 * from earlier sources (no deep merging).
 *
 * @example
 * ```typescript
 * const settings: Settings = {
 *   environments: {
 *     default: {
 *       version: 1,
 *       actions: [{ name: 'Start', command: { command: 'echo hello' } }]
 *     },
 *     production: {
 *       version: 1,
 *       description: 'Production deployment workflow',
 *       actions: [{ name: 'Deploy', command: { command: './deploy.sh' } }]
 *     }
 *   }
 * };
 * ```
 */
// --- CardsAssistant ---

/**
 * Cards assistant handler configuration in settings.json.
 *
 * Defines the command used to launch the cards assistant, which operates
 * outside the per-card action pipeline (no card context, worktree, or
 * per-action runtime authority).
 */
export interface CardsAssistant {
  /** Command to execute for the cards assistant handler */
  command: Command;
}

export interface Settings {
  /**
   * Named environments, each containing actions.
   * Cards reference environments by key name.
   * The `'default'` environment is used when no specific environment is set.
   */
  environments: Record<string, Environment>;

  /** Optional cards assistant handler configuration */
  cardsAssistant?: CardsAssistant;
}

// --- Runtime Types ---

/**
 * Represents a currently running action instance.
 *
 * Action state is tracked in memory and used for UI feedback and
 * concurrency control. Each invocation generates a unique instance ID.
 *
 * @example
 * ```typescript
 * const state: ActionState = {
 *   actionName: 'Start Work',
 *   instanceId: '550e8400-e29b-41d4-a716-446655440000',
 *   startedAt: Date.now(),
 *   mode: 'interactive'
 * };
 * ```
 */
export interface ActionState {
  /**
   * The action's display name from its configuration.
   */
  actionName: string;

  /**
   * UUID v4 generated when the action is invoked.
   * Used to track and cancel specific instances.
   */
  instanceId: string;

  /**
   * Unix timestamp in milliseconds when the action started.
   * Used for elapsed time display and timeout enforcement.
   */
  startedAt: number;

  /**
   * Execution mode for this instance.
   * Interactive mode opens a terminal; background mode runs silently.
   */
  mode: 'interactive' | 'background';

  /** Authoritative runtime transport state; absence is never interpreted as terminal. */
  runtimeConnection?: 'connected' | 'reconnecting' | 'disconnected' | 'unknown';

  /** Last authenticated runtime contact, as a Unix timestamp in milliseconds. */
  runtimeLastContactAt?: number;

  /** Next scheduled reconnect attempt, as a Unix timestamp in milliseconds. */
  runtimeRetryAt?: number;

  /** Last authoritative transport rejection, retained while retrying. */
  runtimeRejection?: string;

  /**
   * When present, indicates this is a synthetic terminal ActionState broadcast
   * for an action that was rejected by the coding-agent gate before dispatch.
   *
   * The webview's `onActionStateChanged` subscription uses the absence of this
   * action in the `states` array to clear the spinner — this field is additive
   * context for future consumers (e.g. error messaging).
   */
  gateRejection?: 'gate-pending' | 'gate-aborted' | 'gate-error';

  /** Outcome supplied by the first accepted shutdown request. */
  shutdownOutcome?: 'success' | 'blocked' | 'error';

  /** Optional free-text detail supplied with the shutdown request. */
  shutdownMessage?: string;

  /** Current phase of the correlated, bounded shutdown lifecycle. */
  shutdownState?: 'pending' | 'readiness_timeout' | 'terminating' | 'graceful' | 'forced' | 'failed';

  /** Durable shutdown intent exists but cannot yet be safely completed. */
  shutdownDisposition?: 'pending' | 'deferred' | 'terminal';

  /** Terminal result reported by the action handler after agent termination. */
  terminationResult?: 'graceful' | 'forced' | 'failed';

  /**
   * Capabilities the running handler has advertised through the authenticated runtime.
   *
   * `switchToInteractive` is true when the handler called
   * `context.onSwitchToInteractive(...)`. The webview uses this to enable or
   * disable the "Switch to interactive" control on a per-instance basis,
   * since today only `spawnClaudeSession` registers the callback.
   */
  capabilities?: {
    switchToInteractive?: boolean;
  };
}

/**
 * Result returned from action execution.
 *
 * Captures the outcome of running an action's start or end command.
 * Used for logging, error reporting, and triggering follow-up behavior.
 *
 * @example
 * ```typescript
 * // Successful execution
 * const success: ActionResult = { success: true, exitCode: 0 };
 *
 * // Failed execution
 * const failure: ActionResult = {
 *   success: false,
 *   exitCode: 1,
 *   error: 'npm test failed: 3 assertions failed'
 * };
 *
 * // Timeout
 * const timeout: ActionResult = {
 *   success: false,
 *   timedOut: true,
 *   error: 'Process exceeded 30000ms timeout'
 * };
 * ```
 */
export interface ActionResult {
  /**
   * Whether the action completed successfully.
   * True if the process exited with code 0 and did not timeout.
   */
  success: boolean;

  /**
   * Exit code from the process.
   * Undefined if the process was killed or timed out before exiting.
   */
  exitCode?: number;

  /**
   * Truncated stderr output, maximum 500 characters.
   * Provides context for failures without overwhelming storage.
   */
  error?: string;

  /**
   * Whether the action exceeded its configured timeout.
   * When true, the process was forcibly terminated.
   */
  timedOut?: boolean;
}

/**
 * Execution mode for actions.
 *
 * - `'interactive'`: Opens a terminal window for user interaction
 * - `'background'`: Runs silently without user-visible UI
 */
export type ExecutionMode = 'interactive' | 'background';

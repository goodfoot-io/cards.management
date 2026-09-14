/**
 * Factory function for creating action handlers.
 *
 * This is the primary authoring API for action developers. It wraps a handler
 * function and attaches metadata for settings.json generation. The SameShape
 * utility provides compile-time typo detection.
 *
 *
 * @summary Factory function for creating action handlers
 * @module
 */

import type { ActionCommand } from '../command-types.js';
import type { ActionContext, ActionInput } from '../inputs.js';
import type { SameShape } from '../type-utils.js';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for {@link defineAction} factory.
 *
 * All fields except `actionName` are optional and forwarded to settings.json.
 * The CLI extracts this metadata via AST analysis, so values must be string
 * literals or boolean/number literals in the source code.
 *
 * @example
 * ```typescript
 * const config: ActionConfig = {
 *   actionName: 'Launch Claude',
 *   description: 'Start a Claude coding session',
 *   icon: './icons/claude.svg',
 *   supportsBackgroundMode: true,
 *   timeout: 30000
 * };
 * ```
 */
export interface ActionConfig {
  /**
   * Stable identifier for the action used in telemetry, localization, and API lookups.
   *
   * Should be lowercase with hyphens (e.g., 'launch-claude', 'run-tests').
   * If omitted, the CLI generates an ID by slugifying `actionName`.
   */
  id?: string;

  /**
   * The action name used to identify the action in settings.json.
   *
   * This name appears in the UI. Keep it concise but descriptive.
   */
  actionName: string;

  /**
   * Human-readable description shown in button tooltip.
   *
   * Explain what the action does in a few words. Shown on hover in the UI.
   */
  description?: string;

  /**
   * Path to icon file for the action button.
   *
   * Paths are relative to the settings.json file location.
   * SVG format recommended for crisp rendering at any size.
   */
  icon?: string;

  /**
   * Whether to show the execution mode toggle in the UI.
   *
   * When true, users can choose between interactive and background modes.
   * When false (default), the action always runs in interactive mode.
   */
  supportsBackgroundMode?: boolean;

  /**
   * Maximum execution time in milliseconds.
   *
   * If the action exceeds this timeout, the runtime will terminate it.
   * Omit to use the platform's default timeout policy.
   */
  timeout?: number;

  /**
   * Handler source file path, injected by the `injectSourcePath` esbuild
   * plugin during config loading. Do not set manually.
   *
   * @internal
   */
  sourcePath?: string;
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler function signature for action events.
 *
 * Throwing an error signals action failure. The error message is logged and
 * surfaced to the user. For expected errors, throw with a descriptive message.
 *
 * @param input - Action input payload from environment variables
 * @param context - Runtime context with logger, cwd, and callback methods
 * @returns Promise that resolves when the action completes
 *
 * @example
 * ```typescript
 * const handler: ActionHandler = async (input, { logger, onCancel }) => {
 *   onCancel(() => {
 *     logger.info('Cancelling action');
 *   });
 *
 *   try {
 *     logger.info('Starting action', { cardId: input.cardId });
 *     await performAction(input);
 *     logger.info('Action completed successfully');
 *   } catch (err) {
 *     logger.logError(err, 'Action failed');
 *     throw err; // Re-throw to signal failure
 *   }
 * };
 * ```
 */
export type ActionHandler = (input: ActionInput, context: ActionContext) => void | Promise<void>;

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates an action handler with metadata for settings.json generation.
 *
 * This factory wraps your handler function and attaches metadata that the CLI
 * extracts when building settings.json. The returned command is both callable
 * (for the runtime) and inspectable (for the CLI).
 *
 * The generic parameter preserves the action name as a literal type.
 *
 * @template T - The config type extending ActionConfig
 * @param config - Action metadata (uses SameShape to catch typos)
 * @param handler - Async function that implements the action logic
 * @returns A callable command with attached metadata
 *
 * @example
 * ```typescript
 * // Basic usage
 * export default defineAction(
 *   { actionName: 'Launch Claude' },
 *   async (input, { logger }) => {
 *     logger.info('Launching Claude', { cardId: input.cardId });
 *     await spawnClaude(input);
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // With full configuration
 * export default defineAction(
 *   {
 *     actionName: 'Deploy Application',
 *     description: 'Deploy to production',
 *     icon: './icons/deploy.svg',
 *     supportsBackgroundMode: true,
 *     timeout: 60000
 *   },
 *   async (input, context) => {
 *     context.onCancel(() => cleanup());
 *     await deploy(input, context);
 *   }
 * );
 * ```
 */
export function defineAction<T extends ActionConfig>(
  config: SameShape<ActionConfig, T>,
  handler: ActionHandler
): ActionCommand<T['actionName']> {
  const fn = async (input: ActionInput, context: ActionContext): Promise<void> => {
    await handler(input, context);
  };

  fn.factoryType = 'action' as const;
  fn.id = config.id;
  fn.actionName = config.actionName;
  fn.description = config.description;
  fn.icon = config.icon;
  fn.supportsBackgroundMode = config.supportsBackgroundMode;
  fn.timeout = config.timeout;
  fn.sourcePath = config.sourcePath;

  return fn as ActionCommand<T['actionName']>;
}

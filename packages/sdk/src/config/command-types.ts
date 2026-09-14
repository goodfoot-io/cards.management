/**
 * Command type definitions for action handlers.
 *
 * These types define the callable command interfaces returned by factory
 * functions. Each command preserves metadata for CLI extraction and settings.json
 * generation while remaining executable by the runtime.
 *
 * The generic parameter `N` preserves the action name as a literal type,
 * enabling compile-time validation of action references.
 *
 *
 * @summary Command type definitions for action handlers
 * @module
 */

import type { ActionContext, ActionInput, CardsAssistantContext, CardsAssistantInput } from './inputs.js';

// ============================================================================
// Command Types
// ============================================================================

/**
 * Callable command returned by action factory.
 *
 * This interface combines the callable signature with metadata properties
 * that the CLI and runtime use. The function is what the runtime invokes;
 * the properties are what the CLI extracts for settings.json generation.
 *
 * The generic parameter `N` preserves the action name as a literal type.
 *
 * @template N - The literal action name type (e.g., 'Launch Claude')
 *
 * @example
 * ```typescript
 * // The command can be called directly (by the runtime)
 * await command(input, context);
 *
 * // And inspected for metadata (by the CLI)
 * console.log(command.factoryType); // 'action'
 * console.log(command.actionName);  // 'Launch Claude'
 * ```
 */
export interface ActionCommand<N extends string = string> {
  /**
   * Invokes the wrapped handler with the provided input and context.
   * @param input - Action input payload from environment variables
   * @param context - Runtime context with logger, cwd, and callback methods
   * @returns Resolves when the handler completes
   */
  (input: ActionInput, context: ActionContext): Promise<void>;

  /** Discriminant for the CLI's AST analyzer. */
  factoryType: 'action';

  /** Explicit action ID from config, if provided. */
  id?: string;

  /** Action name from config - preserved as literal type. */
  actionName: N;

  /** Description from config, if provided. */
  description?: string;

  /** Icon path from config, if provided. */
  icon?: string;

  /** Background mode flag from config, if provided. */
  supportsBackgroundMode?: boolean;

  /** Timeout from config, if provided. */
  timeout?: number;

  /**
   * Path to the handler source file for CLI compilation.
   *
   * When provided, the CLI will compile this file into a standalone bundle
   * and generate proper command paths in settings.json. If omitted, the
   * CLI will generate placeholder command strings.
   */
  sourcePath?: string;
}

// ============================================================================
// Cards Assistant Command
// ============================================================================

/**
 * Callable command returned by the cards-assistant factory.
 *
 * Parallel to {@link ActionCommand} but for the workspace-scoped cards
 * assistant. Has no action-specific metadata (no actionName, description,
 * icon, etc.) since there is only one cards assistant per configuration.
 *
 * @example
 * ```typescript
 * // The command can be called directly (by the runtime)
 * await command(input, context);
 *
 * // And inspected for metadata (by the CLI)
 * console.log(command.factoryType); // 'cards-assistant'
 * ```
 */
export interface CardsAssistantCommand {
  /**
   * Invokes the wrapped handler with the provided input and context.
   * @param input - Cards assistant input payload from environment variables
   * @param context - Runtime context with logger and cwd
   * @returns Resolves when the handler completes
   */
  (input: CardsAssistantInput, context: CardsAssistantContext): Promise<void>;

  /** Discriminant for the CLI's AST analyzer. */
  factoryType: 'cards-assistant';

  /**
   * Path to the handler source file for CLI compilation.
   *
   * When provided, the CLI will compile this file into a standalone bundle
   * and generate proper command paths in settings.json. If omitted, the
   * CLI will generate placeholder command strings.
   */
  sourcePath?: string;
}

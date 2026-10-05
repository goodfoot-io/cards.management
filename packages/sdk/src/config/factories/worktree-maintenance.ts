/**
 * Factory for the `worktreeMaintenance` root configuration command.
 *
 * The configuration owns every worktree concern, including preview, cleanup and
 * the card-deletion pre-check. The server launches this command on a card as a
 * root command and returns its opaque report to the caller; it never interprets
 * the report.
 *
 * @summary Factory for the worktree maintenance root command handler
 * @module
 */

import type { WorktreeMaintenanceCommand } from '../command-types.js';
import type { WorktreeMaintenanceContext, WorktreeMaintenanceInput } from '../inputs.js';
import type { SameShape } from '../type-utils.js';

// ============================================================================
// Configuration Types
// ============================================================================

/** Configuration for the worktree maintenance handler. */
export interface WorktreeMaintenanceConfig {
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

/** Handler for the worktree maintenance root command. */
export type WorktreeMaintenanceHandler = (
  input: WorktreeMaintenanceInput,
  context: WorktreeMaintenanceContext
) => void | Promise<void>;

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Defines the worktree maintenance root command.
 *
 * @param config - Configuration; `sourcePath` is injected during config loading.
 * @param handler - Runs one maintenance pass and reports it through `context.report()`.
 * @returns A command the CLI compiles into the settings' `worktreeMaintenance` entry.
 */
export function defineWorktreeMaintenance<T extends WorktreeMaintenanceConfig>(
  config: SameShape<WorktreeMaintenanceConfig, T>,
  handler: WorktreeMaintenanceHandler
): WorktreeMaintenanceCommand {
  const fn = async (input: WorktreeMaintenanceInput, context: WorktreeMaintenanceContext): Promise<void> => {
    await handler(input, context);
  };

  fn.factoryType = 'worktree-maintenance' as const;
  fn.sourcePath = config.sourcePath;

  return fn as WorktreeMaintenanceCommand;
}

/**
 * Factory functions for declaring type-safe action and cards-assistant handlers.
 *
 * @summary Factories for defining actions and cards assistants
 * @module
 */

export {
  type ActionConfig,
  type ActionHandler,
  defineAction
} from './action.js';
export {
  type CardsAssistantConfig,
  type CardsAssistantHandler,
  defineCardsAssistant
} from './cards-assistant.js';
export {
  defineWorktreeMaintenance,
  type WorktreeMaintenanceConfig,
  type WorktreeMaintenanceHandler
} from './worktree-maintenance.js';

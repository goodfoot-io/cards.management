/**
 * SubagentStart hook implementation.
 *
 * Gives subagents card awareness via context injection only.
 * Uses the shared {@link buildAdditionalContext} for context.
 *
 * @summary SubagentStart hook — card context injection only
 * @see https://code.claude.com/docs/en/hooks#subagentstart
 */

import { extractActionInput } from '@cards.management/sdk/config';
import { subagentStartHook, subagentStartOutput } from '@goodfoot/agent-hooks/claude-code';
import { buildAdditionalContext, CardRepoAccessError } from '../../shared/context.js';

/**
 * Builds the shipped Claude child-start hook.
 * @returns A hook that injects card context for a starting subagent.
 */
export function createClaudeSubagentStartHandler(): Parameters<typeof subagentStartHook>[1] {
  return async (_input, { logger }) => {
    let actionInput: ReturnType<typeof extractActionInput>;
    try {
      actionInput = extractActionInput();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Not running inside an action subprocess', { error: message });
      return subagentStartOutput({
        systemMessage: 'SubagentStart hook: not running inside an action subprocess.'
      });
    }

    let systemMessage: string;
    try {
      systemMessage = buildAdditionalContext(actionInput);
    } catch (error) {
      if (error instanceof CardRepoAccessError) {
        logger.error('Card repo inaccessible', { repoPath: error.repoPath, error: error.message });
        return subagentStartOutput({
          continue: false,
          ...error.toHookFailure('subagent')
        });
      }
      throw error;
    }

    return subagentStartOutput({
      systemMessage,
      hookSpecificOutput: {
        additionalContext: systemMessage
      }
    });
  };
}

export default subagentStartHook({}, createClaudeSubagentStartHandler());

/**
 * SubagentStart hook implementation.
 *
 * Gives subagents card awareness via context injection only.
 * Uses the shared {@link buildAdditionalContext} for context.
 *
 * @summary SubagentStart hook — card context injection only
 */

import { extractActionInput } from '@cards.management/sdk/config';
import { addActiveSubagent } from '@cards.management/sessions/card-repo';
import { subagentStartHook, subagentStartOutput } from '@goodfoot/agent-hooks/codex';
import { buildAdditionalContext, CardRepoAccessError } from '../../shared/context.js';
import type { WorkAuthority } from '../../shared/work-authority.js';
import { createHookWorkAuthority } from '../../shared/work-authority.js';

/**
 * Builds the shipped Codex child-start gate.
 * @param authorityFactory - Injected authority factory.
 * @returns A hook that blocks child startup until durable admission.
 */
export function createCodexSubagentStartHandler(
  authorityFactory: () => WorkAuthority = createHookWorkAuthority
): Parameters<typeof subagentStartHook>[1] {
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

    const hostBoundaryId = `codex:child:${_input.session_id}:${_input.turn_id}:${_input.agent_id}`;
    try {
      await authorityFactory().admit({ cause: 'childTask', messageId: hostBoundaryId, requestId: hostBoundaryId });
    } catch (error) {
      return subagentStartOutput({
        continue: false,
        systemMessage: `Cards child admission failed: ${error instanceof Error ? error.message : String(error)}`
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

    try {
      await addActiveSubagent(_input.session_id, _input.agent_id);
    } catch (error) {
      logger.warn('Failed to record active subagent', {
        sessionId: _input.session_id,
        agentId: _input.agent_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return subagentStartOutput({
      systemMessage,
      additionalContext: systemMessage
    });
  };
}

export default subagentStartHook({}, createCodexSubagentStartHandler());

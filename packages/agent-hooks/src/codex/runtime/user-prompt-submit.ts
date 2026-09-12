/**
 * Codex root-turn durable admission gate.
 * @summary Codex root-turn work admission
 * @module user-prompt-submit
 */
import { BlockError, userPromptSubmitHook, userPromptSubmitOutput } from '@goodfoot/agent-hooks/codex';
import type { WorkAuthority } from '../../shared/work-authority.js';
import { createHookWorkAuthority } from '../../shared/work-authority.js';

/**
 * Builds the shipped Codex turn hook.
 * @param authorityFactory - Injected authority factory.
 * @returns Codex UserPromptSubmit hook.
 */
export function createCodexTurnHandler(
  authorityFactory: () => WorkAuthority = createHookWorkAuthority
): Parameters<typeof userPromptSubmitHook>[1] {
  return async (input) => {
    const hostBoundaryId = `codex:turn:${input.session_id}:${input.turn_id}`;
    try {
      await authorityFactory().admit({ cause: 'turn', messageId: hostBoundaryId, requestId: hostBoundaryId });
    } catch (error) {
      throw new BlockError(`Cards work admission failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return userPromptSubmitOutput();
  };
}

export default userPromptSubmitHook({}, createCodexTurnHandler());

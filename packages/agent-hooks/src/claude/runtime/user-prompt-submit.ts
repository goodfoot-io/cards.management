/**
 * Claude root-turn durable admission gate.
 * @summary Claude root-turn work admission
 * @module user-prompt-submit
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { userPromptSubmitHook, userPromptSubmitOutput } from '@goodfoot/agent-hooks/claude-code';
import type { WorkAuthority } from '../../shared/work-authority.js';
import { createHookWorkAuthority } from '../../shared/work-authority.js';

/**
 * Builds the shipped Claude turn hook.
 * @param authorityFactory - Injected authority factory.
 * @returns Claude UserPromptSubmit hook.
 */
export function createClaudeTurnHandler(
  authorityFactory: () => WorkAuthority = createHookWorkAuthority
): Parameters<typeof userPromptSubmitHook>[1] {
  return async (input) => {
    try {
      const position = statSync(input.transcript_path).size;
      const prompt = createHash('sha256').update(input.prompt).digest('hex');
      const hostBoundaryId = `claude:turn:${input.session_id}:${position}:${prompt}`;
      await authorityFactory().admit({ cause: 'turn', messageId: hostBoundaryId, requestId: hostBoundaryId });
      return userPromptSubmitOutput();
    } catch (error) {
      return userPromptSubmitOutput({
        continue: false,
        stopReason: `Cards work admission failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };
}

export default userPromptSubmitHook({}, createClaudeTurnHandler());

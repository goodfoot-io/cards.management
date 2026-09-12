/**
 * Stop hook — Claude shutdown drain readiness acknowledgement.
 *
 * Correlates a pending `cards shutdown` request against a strict, fail-closed
 * idle check (tracked subagents plus the launcher-owned process tree) and only
 * then signals readiness back to the action dispatcher over the request's
 * authenticated runtime authority. Matcher-less so it composes alongside `stop.ts`'s
 * unattributed-commit check in the same Stop event group; each hook is
 * independent and neither blocks nor depends on the other.
 *
 * @summary Stop hook — Claude shutdown drain readiness acknowledgement
 * @see https://code.claude.com/docs/en/hooks#stop
 */

import { extractActionInput } from '@cards.management/sdk/config';
import { stopHook } from '@goodfoot/agent-hooks/claude-code';
import { attemptShutdownDrain } from '../../shared/shutdown-drain.js';

export default stopHook({}, async (input, { logger }) => {
  try {
    extractActionInput();
  } catch (error) {
    logger.warn('stop-shutdown-drain: not inside an action subprocess', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  await attemptShutdownDrain(input.session_id, logger, 'stop-shutdown-drain');

  return null;
});

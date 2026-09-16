/**
 * Shared session-idle check for Stop hooks.
 *
 * Replaces WAITING_STEM_RE text-sniffing with a structural check against
 * actual subagent state. Exported so any hook that needs an idle
 * determination can call a single authority.
 *
 * @summary Shared session-idle check for Stop hooks
 * @module session-idle
 */

import { getActiveSubagentCount } from '@cards.management/sessions/card-repo';

/**
 * Returns `true` when the session has no active subagents — i.e., the agent
 * is genuinely idle and safe to nudge toward merge or routing.
 *
 * Fail-open: if the underlying state read throws, the error is caught
 * and `true` is returned (treat as idle rather than blocking indefinitely).
 *
 * @param sessionId - Session to check for active work.
 * @returns `true` when the session is idle.
 */
export function isSessionIdle(sessionId: string): boolean {
  try {
    return getActiveSubagentCount(sessionId) === 0;
  } catch (error) {
    console.warn('isSessionIdle: error reading subagent state, treating as idle:', error);
    return true;
  }
}

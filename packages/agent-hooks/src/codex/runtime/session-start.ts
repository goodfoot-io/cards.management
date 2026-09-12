/**
 * SessionStart hook implementation.
 *
 * Runs as a subprocess of an action. Uses {@link extractActionInput} to
 * confirm we are inside an action subprocess and to expose the action
 * process environment variables to the session context.
 *
 * @summary SessionStart hook implementation
 */

import type { ActionInput } from '@cards.management/sdk/config';
import { extractActionInput } from '@cards.management/sdk/config';
import { findAgentPid } from '@cards.management/sdk/process-tree';
import { buildCodexManifest } from '@cards.management/sdk/transcript-sync';
import { sessionStartHook, sessionStartOutput } from '@goodfoot/agent-hooks/codex';
import {
  buildAdditionalContext,
  buildCardRepoLogBlock,
  buildEnvBlock,
  buildWorkspaceRepoLogBlocks,
  CardRepoAccessError
} from '../../shared/context.js';
import { createSpawnWatcher } from '../../shared/spawn-watcher.js';

export { buildCardRepoLogBlock, buildEnvBlock, buildWorkspaceRepoLogBlocks, CardRepoAccessError };

/**
 * Spawns the session's stream-sync-watcher via the shared factory; only the
 * manifest builder is Codex-specific. `buildCodexManifest` throws when
 * `rolloutPath`'s basename does not match Codex's rollout naming convention
 * or embeds a different session id (a wiring bug upstream); that is caught
 * and warned exactly like a spawn failure. This is the fix for Codex sessions
 * previously syncing nothing — the runtime hook now builds a real manifest
 * instead of never spawning a watcher at all.
 */
const spawnWatcher = createSpawnWatcher(({ agentPid, sessionId, transcriptPath, actionInput }) =>
  buildCodexManifest({
    sessionId,
    cardId: actionInput.cardId,
    rolloutPath: transcriptPath,
    monitorPid: agentPid,
    cardRepoPath: actionInput.cardRepoPath
  })
);

export default sessionStartHook({}, async (input, { logger }) => {
  let actionInput: ActionInput;
  try {
    actionInput = extractActionInput();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Not running inside an action subprocess', { error: message });
    return sessionStartOutput({
      systemMessage: 'SessionStart hook: not running inside an action subprocess.'
    });
  }

  const agentPid = await findAgentPid();
  if (agentPid && input.transcript_path) {
    spawnWatcher(agentPid, input.session_id, input.transcript_path, actionInput, logger);
  } else {
    // The PID only feeds best-effort transcript watching; its absence is a warning, not a fatal.
    // When the watcher does not spawn (null agentPid or null transcript_path), the route-nudge
    // marker written later by stop-route-nudge.ts for this session will not be cleaned up. This
    // is a bounded, harmless leak: the marker is an empty file keyed by a dead session id with
    // zero behavioral impact on future sessions. It is accepted because there is no SessionEnd
    // event on Codex, and a reaper's age-gating would risk deleting live sessions' artifacts.
    logger.warn('Could not identify agent PID; transcript watcher disabled', {
      sessionId: input.session_id,
      ppid: process.ppid,
      cardId: actionInput.cardId,
      cardRepoPath: actionInput.cardRepoPath,
      actionName: actionInput.actionName
    });
  }

  logger.info('Action subprocess confirmed', {
    cardId: actionInput.cardId,
    actionName: actionInput.actionName,
    environment: actionInput.environment,
    executionMode: actionInput.executionMode
  });

  let systemMessage: string;
  try {
    systemMessage = buildAdditionalContext(actionInput);
  } catch (error) {
    if (error instanceof CardRepoAccessError) {
      logger.error('Card repo inaccessible', { repoPath: error.repoPath, error: error.message });
      return sessionStartOutput({
        continue: false,
        ...error.toHookFailure('session')
      });
    }
    throw error;
  }

  return sessionStartOutput({
    systemMessage,
    additionalContext: systemMessage
  });
});

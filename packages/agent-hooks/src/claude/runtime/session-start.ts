/**
 * SessionStart hook implementation.
 *
 * Runs as a subprocess of an action. Uses {@link extractActionInput} to
 * confirm we are inside an action subprocess and to expose the action
 * process environment variables to the session context.
 *
 * @summary SessionStart hook implementation
 * @see https://code.claude.com/docs/en/hooks#sessionstart
 */

import { execFileSyncNoWindow } from '@cards.management/sdk/bin/child-process';
import type { ActionInput } from '@cards.management/sdk/config';
import { extractActionInput } from '@cards.management/sdk/config';
import { findAgentPid } from '@cards.management/sdk/process-tree';
import { buildClaudeCodeManifest } from '@cards.management/sdk/transcript-sync';
import { writeSessionHeadSha } from '@cards.management/sessions/card-repo';
import { sessionStartHook, sessionStartOutput } from '@goodfoot/agent-hooks/claude-code';
import {
  buildAdditionalContext,
  buildCardRepoLogBlock,
  buildEnvBlock,
  buildWorkspaceRepoLogBlocks,
  CardRepoAccessError
} from '../../shared/context.js';
import { persistSessionEnv } from '../../shared/session-env.js';
import { createSpawnWatcher } from '../../shared/spawn-watcher.js';

export { buildCardRepoLogBlock, buildEnvBlock, buildWorkspaceRepoLogBlocks, CardRepoAccessError };

/**
 * Resolves the git HEAD sha for a repository path.
 *
 * Returns `null` when the path is not a git repository or git is
 * unavailable. Intentionally fails open so hook failures do not block
 * Claude.
 *
 * @param repoPath - Repository directory where `git rev-parse HEAD` should run.
 * @returns Current `HEAD` SHA, or `null` when unavailable.
 */
export function resolveHeadSha(repoPath: string): string | null {
  try {
    // In background mode this hook subprocess is console-less under stock node
    // on win32; `execFileSyncNoWindow` forces `windowsHide: true` so the `git`
    // call does not pop a console window (no-op on POSIX).
    return execFileSyncNoWindow('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Spawns the session's stream-sync-watcher via the shared factory; only the
 * manifest builder is Claude-specific. `buildClaudeCodeManifest` throws when
 * `transcriptPath`'s basename disagrees with `sessionId` (a wiring bug
 * upstream); that is caught and warned exactly like a spawn failure.
 */
const spawnWatcher = createSpawnWatcher(({ agentPid, sessionId, transcriptPath, actionInput }) =>
  buildClaudeCodeManifest({
    sessionId,
    cardId: actionInput.cardId,
    transcriptPath,
    monitorPid: agentPid,
    cardRepoPath: actionInput.cardRepoPath
  })
);

export default sessionStartHook({}, async (input, { logger, persistEnvVar }) => {
  // Persist session env vars unconditionally — before extractActionInput so
  // they are available in every session, including non-action subprocesses.
  persistSessionEnv(input.session_id, input.transcript_path, persistEnvVar);
  logger.info('Persisted session env vars to environment', {
    sessionId: input.session_id,
    transcriptPath: input.transcript_path
  });

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

  const headSha = resolveHeadSha(actionInput.cardRepoPath);
  if (headSha) {
    writeSessionHeadSha(input.session_id, headSha);
    logger.info('Stored git HEAD sha', { headSha, repoPath: actionInput.cardRepoPath });
  } else {
    logger.warn('Could not resolve git HEAD sha', { repoPath: actionInput.cardRepoPath });
  }

  const agentPid = await findAgentPid();
  if (agentPid) {
    spawnWatcher(agentPid, input.session_id, input.transcript_path, actionInput, logger);
  } else {
    // Card identity is already known via actionInput.cardId, and workspace commit
    // attribution now resolves the card via resolveCardId (worktree-file only)
    // independent of the PID. The PID only feeds best-effort transcript watching;
    // its absence is a warning, not a fatal.
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
    hookSpecificOutput: {
      additionalContext: systemMessage
    }
  });
});

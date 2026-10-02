/**
 * Notification hook (`notification_type: "idle_prompt"`) — merged route/merge
 * and exit-when-done nudge.
 *
 * Replaces `stop-exit-when-done.ts` and `stop-route-nudge.ts`. Both used
 * `Stop` + a hand-maintained `isSessionIdle()` (active-subagent count only,
 * blind to background Bash tasks); this hook instead matches the CLI's own
 * `idle_prompt` notification, which fires only once the CLI's internal
 * loading/queued-work state is genuinely clear.
 *
 * Evaluates the route-nudge condition first (not tagged `blocked`; merge
 * ungated or approved; workspace branch has unmerged commits); falls through
 * to the exit-when-done condition (`actionInput.exitWhenDone === true`) only
 * when the route condition doesn't hold. Each branch keeps its own
 * independent once-per-condition-state marker, so one being superseded by the
 * other on a given idle moment does not permanently forfeit it — it can still
 * fire later once its own condition holds and the session goes idle again.
 *
 * Delivers via `additionalContext` (Notification hooks have no
 * `decision: 'block'`), not `stopOutput`.
 *
 * Fail-open: every error path returns `null`.
 *
 * @summary Notification(idle_prompt) hook — merged route/merge and exit-when-done nudge
 * @see https://code.claude.com/docs/en/hooks#notification
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractActionInput,
  getBaseBranch,
  getCardRepoPath,
  getWorkspaceBranch,
  getWorkspacePath
} from '@cards.management/sdk/config';
import {
  hasSessionExitWhenDoneNudgeFired,
  hasSessionRouteNudgeFired,
  markSessionExitWhenDoneNudgeFired,
  markSessionRouteNudgeFired
} from '@cards.management/sessions/card-repo';
import { type Logger, notificationHook, notificationOutput } from '@goodfoot/agent-hooks/claude-code';

interface CardMeta {
  tags?: string[];
  gates?: {
    mergeRequestRequired?: boolean;
    mergeApproved?: boolean;
  };
}

function readCardMeta(cardRepoPath: string): CardMeta {
  const raw = readFileSync(join(cardRepoPath, 'CARD.meta.json'), 'utf-8');
  return JSON.parse(raw) as CardMeta;
}

// Every build target compiles this hook to `<outBase>/hooks/bin/<name>.mjs`
// (see agent-hooks/scripts/build.mjs) with skills shipped as a sibling of
// `hooks/` at `<outBase>/skills/...`. Resolving from `import.meta.url` finds
// the runbook wherever the plugin is installed; a repo-root-relative string
// only resolves when the agent's cwd happens to be this monorepo's root,
// which is not true for an installed (marketplace) plugin.
function resolveMergeRunbookPath(): string {
  return fileURLToPath(new URL('../../skills/card/references/merge.md', import.meta.url));
}

function resolveShutdownRunbookPath(): string {
  return fileURLToPath(new URL('../../skills/card/references/shutdown.md', import.meta.url));
}

function getUnmergedCount(workspacePath: string, baseBranch: string, workspaceBranch: string): number {
  const output = execFileSync('git', ['rev-list', '--count', `${baseBranch}..${workspaceBranch}`], {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return parseInt(output.trim(), 10);
}

/**
 * Attempts the route-nudge branch.
 *
 * @param sessionId - The session to check and mark the route-nudge state for.
 * @param logger - Hook logger for warn/error diagnostics on fail-open paths.
 * @returns The additionalContext string when the route condition holds and
 *   fires, `null` when it doesn't hold or any step fails open.
 */
function tryRouteNudge(sessionId: string, logger: Logger): string | null {
  let cardRepoPath: string;
  let workspacePath: string;
  let baseBranch: string;
  let workspaceBranch: string;
  try {
    cardRepoPath = getCardRepoPath();
    workspacePath = getWorkspacePath();
    baseBranch = getBaseBranch();
    workspaceBranch = getWorkspaceBranch();
  } catch (error) {
    logger.warn('notification-idle-nudge: not inside an action subprocess', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  let nudgeFired: boolean;
  try {
    nudgeFired = hasSessionRouteNudgeFired(sessionId);
  } catch (error) {
    logger.warn('notification-idle-nudge: failed to check route-nudge marker', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (nudgeFired) {
    return null;
  }

  let meta: CardMeta;
  try {
    meta = readCardMeta(cardRepoPath);
  } catch (error) {
    logger.warn('notification-idle-nudge: failed to read CARD.meta.json', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.includes('blocked')) {
    return null;
  }

  const mergeRequestRequired = meta.gates?.mergeRequestRequired === true;
  const mergeApproved = meta.gates?.mergeApproved === true;
  if (mergeRequestRequired && !mergeApproved) {
    return null;
  }

  let count: number;
  try {
    count = getUnmergedCount(workspacePath, baseBranch, workspaceBranch);
  } catch (error) {
    logger.warn('notification-idle-nudge: git rev-list failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (count === 0) {
    return null;
  }

  try {
    markSessionRouteNudgeFired(sessionId);
  } catch (error) {
    logger.error('notification-idle-nudge: failed to write route-nudge marker', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  return [
    `Workspace branch \`${workspaceBranch}\` has ${count} commit(s) not merged into \`${baseBranch}\`. The card does not have a \`blocked\` tag, and merge is either ungated or already approved.`,
    '',
    `If validation and evaluation have passed and no scope remains, read \`${resolveMergeRunbookPath()}\` (\`merge.md\` in \`runtime:card\`'s \`references/\`) and follow its \`<instructions>\` to merge.`,
    '',
    'Otherwise, load the `runtime:card` skill and follow its `<routing-instructions>` to determine the next action — but do not re-run validation or evaluation just because this nudge fired.'
  ].join('\n');
}

/**
 * Attempts the exit-when-done branch.
 *
 * @param sessionId - The session to check and mark the exit-when-done nudge state for.
 * @param logger - Hook logger for warn/error diagnostics on fail-open paths.
 * @returns The additionalContext string when `exitWhenDone` is true and it
 *   fires, `null` otherwise.
 */
function tryExitWhenDoneNudge(sessionId: string, logger: Logger): string | null {
  let actionInput: ReturnType<typeof extractActionInput>;
  try {
    actionInput = extractActionInput();
  } catch (error) {
    logger.warn('notification-idle-nudge: not inside an action subprocess', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (!actionInput.exitWhenDone) {
    return null;
  }

  let nudgeFired: boolean;
  try {
    nudgeFired = hasSessionExitWhenDoneNudgeFired(sessionId);
  } catch (error) {
    logger.warn('notification-idle-nudge: failed to check exit-when-done nudge marker', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  if (nudgeFired) {
    return null;
  }

  try {
    markSessionExitWhenDoneNudgeFired(sessionId);
  } catch (error) {
    logger.error('notification-idle-nudge: failed to write exit-when-done nudge marker', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  return [
    'EXIT_WHEN_DONE=true — a reminder for when work is done, not a signal to stop now.',
    '',
    `Once the card's work is finished and validated, read \`${resolveShutdownRunbookPath()}\` (\`shutdown.md\` in \`runtime:card\`'s \`references/\`) and follow its \`<instructions>\`: ensure all subagents and background work are finished, then make \`cards "$CARD_ID" shutdown --outcome success|blocked|error --message "..."\` the sole tool call in your final assistant turn. Do not make any later tool call. The action handler stops the validated Claude launcher and completes bounded best-effort subprocess cleanup. Detached or reparented descendants may survive.`
  ].join('\n');
}

export default notificationHook({ matcher: 'idle_prompt' }, async (input, { logger }) => {
  const additionalContext = tryRouteNudge(input.session_id, logger) ?? tryExitWhenDoneNudge(input.session_id, logger);

  if (!additionalContext) {
    return null;
  }

  return notificationOutput({
    hookSpecificOutput: {
      additionalContext
    }
  });
});

/**
 * Interview action for Cards workflows.
 *
 * Branches on `input.codingAgent` via {@link resolveCodingAgent}:
 * - Claude: spawns the `claude` CLI and instructs it to load the
 *   `runtime:interview` skill for the current card.
 * - Codex: spawns the `codex` CLI interactively with a short prompt that
 *   instructs Codex to load the `$runtime:interview` skill and follow its
 *   `<routing-instructions>`. The skill itself is provided by the bundled
 *   `runtime` plugin staged into the per-launch `CODEX_HOME`.
 * - OpenCode: spawns the `opencode run` CLI interactively with a short prompt
 *   that instructs it to load the `interview` skill and follow its
 *   `<routing-instructions>`. The skill itself is provided by the bundled
 *   `runtime` plugin staged into the per-launch cache and registered through
 *   the staged `OPENCODE_CONFIG` document.
 * - Antigravity: spawns the `agy` CLI interactively with a short prompt that
 *   references the interview skill by its Antigravity-native address; the
 *   skill content itself ships in the managed Antigravity payload.
 *
 * The process always runs interactively — stdio is inherited so the user gets
 * direct terminal control. Background mode is not supported because interviews
 * require active user participation.
 *
 * The action awaits process exit before resolving, so the terminal closes
 * only after the underlying CLI finishes and cleanup is complete.
 *
 * @summary Interview action for Cards workflows
 * @module
 * @see {@link defineAction} for factory behavior and metadata attachment
 */

import { randomUUID } from 'node:crypto';
import { type ActionContext, type ActionInput, defineAction } from '@cards.management/sdk/config';
import { spawnAntigravitySession } from '../lib/antigravity-session.js';
import { spawnClaudeSession } from '../lib/claude-session.js';
import { spawnCodexSession } from '../lib/codex-session.js';
import { resolveCodingAgent } from '../lib/coding-agent.js';
import { spawnOpencodeSession } from '../lib/opencode-session.js';

/**
 * Interview action handler.
 *
 * Spawns the `claude`, `codex`, or `opencode` CLI as a child process using the
 * corresponding interview-routing skill, selected by `input.codingAgent`.
 * The process lifecycle is tied to the action: cancellation sends SIGTERM.
 * Session resume is not supported — each interview always starts fresh.
 */
export default defineAction(
  {
    actionName: 'Interview',
    description: 'Start an interview session for the card',
    supportsBackgroundMode: false,
    timeout: 3600000
  },
  async (input: ActionInput, context: ActionContext) => {
    const agent = resolveCodingAgent(input);

    if (agent === 'antigravity-cli') {
      await spawnAntigravitySession(input, context, {
        suppressExitWhenDone: true,
        prompt: 'Load the `runtime:interview` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    if (agent === 'codex-cli') {
      await spawnCodexSession(input, context, {
        suppressExitWhenDone: true,
        prompt: 'Load the `$runtime:interview` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    if (agent === 'opencode-cli') {
      await spawnOpencodeSession(input, context, {
        suppressExitWhenDone: true,
        prompt: 'Load the `interview` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    await spawnClaudeSession(input, context, {
      prompt: 'Load the `runtime:interview` skill and follow the `<routing-instructions>`.',
      sessionId: randomUUID(),
      resume: false,
      supportsSwitchToInteractive: false,
      suppressExitWhenDone: true
    });
  }
);

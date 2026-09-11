/**
 * Captain action for Cards workflows.
 *
 * Branches on `input.codingAgent` via {@link resolveCodingAgent}:
 * - Claude: spawns the `claude` CLI with a prompt that instructs Claude to
 *   load the `runtime:captain` skill and follow its `<routing-instructions>`.
 *   In interactive mode, the process inherits stdio so the user gets direct
 *   terminal control. In background mode, Claude runs with `--print` so it
 *   executes non-interactively (takes a prompt, runs, and exits). The watcher
 *   handles all transcript streaming.
 * - Codex: spawns the `codex` CLI with a short prompt that
 *   instructs Codex to load the `$runtime:captain` skill and follow its
 *   `<routing-instructions>`. The skill itself is provided by the bundled
 *   `runtime` plugin staged into the per-launch `CODEX_HOME`. Background mode
 *   runs through the non-interactive `codex exec` command.
 * - OpenCode: spawns the `opencode` CLI. Interactive actions boot the TUI with
 *   a short prompt that instructs it to load the `captain` skill and follow its
 *   `<routing-instructions>`; the skill itself is provided by the bundled
 *   `runtime` plugin staged into the per-launch cache and registered through
 *   the staged `OPENCODE_CONFIG` document. Background dispatch runs the
 *   headless one-shot (`opencode run`) in the card worktree — piped stdio,
 *   stderr captured to the action log, and inline post-exit cleanup, mirroring
 *   the Claude background path.
 * - Antigravity: spawns the `agy` CLI in the card worktree. Interactive
 *   actions run terminal-owned (`-i`); background dispatch runs the one-shot
 *   (`-p`) with child-owned stream-json output, whose final result record the
 *   launcher parses — exit zero without a successful final record fails the
 *   action. Prompts reference the captain skill by its Antigravity-native
 *   address; the skill content ships in the managed Antigravity payload.
 *
 * The action awaits process exit before resolving, so the terminal closes
 * only after the underlying CLI finishes and cleanup is complete.
 *
 * @summary Captain action for Cards workflows
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
 * Captain action handler.
 *
 * Spawns the `claude`, `codex`, or `opencode` CLI as a child process, selected
 * by `input.codingAgent`. The process lifecycle is tied to the action:
 * cancellation sends SIGTERM. In the Claude branch, switching to interactive
 * mode preserves the session ID for resumption; Codex and OpenCode background
 * sessions deliberately register no switch-to-interactive callback because a
 * resumable headless session identity is not available to the action at launch.
 */
export default defineAction(
  {
    actionName: 'Captain',
    description: 'Delegates work to free-form subagents',
    supportsBackgroundMode: true
  },
  async (input: ActionInput, context: ActionContext) => {
    const agent = resolveCodingAgent(input);

    if (agent === 'antigravity-cli') {
      await spawnAntigravitySession(input, context, {
        prompt: 'Load the `runtime:captain` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    if (agent === 'codex-cli') {
      await spawnCodexSession(input, context, {
        prompt: 'Load the `$runtime:captain` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    if (agent === 'opencode-cli') {
      await spawnOpencodeSession(input, context, {
        prompt: 'Load the `captain` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    const switchData = input.switchToInteractiveData as { sessionId?: string } | undefined;
    const [sessionId, resume] = [switchData?.sessionId ?? randomUUID(), !!switchData?.sessionId];

    await spawnClaudeSession(input, context, {
      prompt: 'Load the `runtime:captain` skill and follow the `<routing-instructions>`.',
      sessionId,
      resume,
      supportsSwitchToInteractive: true
    });
  }
);

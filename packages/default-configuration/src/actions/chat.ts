/**
 * Chat action for Cards workflows.
 *
 * Branches on `input.codingAgent` via {@link resolveCodingAgent}:
 * - Claude: spawns the `claude` CLI with the `runtime:chat-routing` skill
 *   appended as the system prompt.
 * - Codex: spawns the `codex` CLI with the codex `chat-routing` skill
 *   appended as `developer_instructions` (the Codex analog of
 *   `--append-system-prompt`).
 * - OpenCode: spawns the `opencode run` CLI with the opencode `chat-routing`
 *   skill prepended to the opening positional turn (`opencode run` has no
 *   system-prompt override flag).
 * - Antigravity: spawns the `agy` CLI interactively with a short prompt that
 *   references the chat-routing skill by its Antigravity-native address; the
 *   skill content itself ships in the managed Antigravity payload.
 *
 * The process always runs interactively — stdio is inherited so the user gets
 * direct terminal control. Background mode is not supported because chat
 * requires active user participation.
 *
 * The action awaits process exit before resolving, so the terminal closes
 * only after the underlying CLI finishes and cleanup is complete.
 *
 * @summary Chat action for Cards workflows
 * @module
 * @see {@link defineAction} for factory behavior and metadata attachment
 */

import { randomUUID } from 'node:crypto';
import { type ActionContext, type ActionInput, defineAction } from '@cards.management/sdk/config';
import chatRoutingSkill from '../../../../claude/runtime/skills/chat-routing/SKILL.md';
import codexChatRoutingSkill from '../../../../codex/runtime/skills/chat-routing/SKILL.md';
import opencodeChatRoutingSkill from '../../../../opencode/runtime/skills/chat-routing/SKILL.md';
import { spawnAntigravitySession } from '../lib/antigravity-session.js';
import { spawnClaudeSession } from '../lib/claude-session.js';
import { spawnCodexSession } from '../lib/codex-session.js';
import { resolveCodingAgent } from '../lib/coding-agent.js';
import { spawnOpencodeSession } from '../lib/opencode-session.js';

/**
 * Strips YAML frontmatter (`---` delimited block at the start) from a markdown string.
 * @param md - Markdown string potentially containing frontmatter.
 * @returns The markdown content without frontmatter.
 */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

const CHAT_ROUTING_SKILL: string = stripFrontmatter(chatRoutingSkill).trim();
const CHAT_ROUTING_SKILL_CODEX: string = stripFrontmatter(codexChatRoutingSkill).trim();
const CHAT_ROUTING_SKILL_OPENCODE: string = stripFrontmatter(opencodeChatRoutingSkill).trim();

/**
 * Chat action handler.
 *
 * Spawns the `claude`, `codex`, or `opencode` CLI as a child process, selected
 * by `input.codingAgent`. The process lifecycle is tied to the action:
 * cancellation sends SIGTERM. Session resume is not supported — each chat
 * always starts fresh.
 */
export default defineAction(
  {
    actionName: 'Chat',
    description: 'Start a chat session for the card',
    supportsBackgroundMode: false,
    timeout: 3600000
  },
  async (input: ActionInput, context: ActionContext) => {
    const agent = resolveCodingAgent(input);

    if (agent === 'antigravity-cli') {
      await spawnAntigravitySession(input, context, {
        suppressExitWhenDone: true,
        prompt: 'Load the `runtime:chat-routing` skill and follow the `<routing-instructions>`.'
      });
      return;
    }

    if (agent === 'codex-cli') {
      await spawnCodexSession(input, context, {
        suppressExitWhenDone: true,
        appendSystemPrompt: CHAT_ROUTING_SKILL_CODEX
      });
      return;
    }

    if (agent === 'opencode-cli') {
      await spawnOpencodeSession(input, context, {
        suppressExitWhenDone: true,
        appendSystemPrompt: CHAT_ROUTING_SKILL_OPENCODE
      });
      return;
    }

    await spawnClaudeSession(input, context, {
      sessionId: randomUUID(),
      resume: false,
      supportsSwitchToInteractive: false,
      suppressExitWhenDone: true,
      appendSystemPrompt: CHAT_ROUTING_SKILL
    });
  }
);

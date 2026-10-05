/**
 * Settings configuration for default Claude Code workflows.
 *
 * This configuration defines the standard environment with actions and types
 * for Claude Code card-based workflows. The configuration is transformed to
 * settings.json at build time via the build-settings script.
 *
 *
 * @summary Settings configuration for default Claude Code workflows
 * @module
 */

import { defineConfig } from '@cards.management/sdk/config';
// Action handlers
import captain from './src/actions/captain.js';
import chat from './src/actions/chat.js';
import interview from './src/actions/interview.js';
import launch from './src/actions/launch.js';
// Cards assistant handler
import cardsAssistant from './src/cards-assistant.js';
// Worktree slot maintenance root command
import worktreeMaintenance from './src/worktree-maintenance.js';

export default defineConfig({
  cardsAssistant,
  worktreeMaintenance,
  environments: {
    default: {
      version: 1,
      description: 'Standard Cards coding-agent workflows',
      actions: [launch, interview, chat, captain],
      streams: {
        'claude-code-session': {
          version: 1,
          wwwRoot: './src/streams/claude-code-session/www',
          maxLineLength: 1_048_576
        },
        'codex-session': {
          version: 1,
          wwwRoot: './src/streams/codex-session/www',
          // Codex rollout lines can carry full function-call payloads, so the
          // per-line limit is larger (4 MiB) than the Claude renderer's.
          maxLineLength: 4_194_304
        },
        'opencode-session': {
          version: 1,
          // Unlike the sibling streams, this entrypoint is generated (it
          // cannot be committed under src/ — see
          // scripts/generate-opencode-entry.mjs). scripts/build.mjs
          // materializes it here before the settings build runs; pointing at
          // the src/ directory instead would ship a wwwRoot that resolves to
          // nothing at runtime.
          wwwRoot: './dist/www-entry/opencode-session',
          // The Cards runtime exporter appends one normalized envelope per
          // line; OpenCode truncates tool output before it reaches the part,
          // so lines stay well under 1 MiB.
          maxLineLength: 1_048_576
        },
        'antigravity-session': {
          version: 1,
          // Like the opencode-session sibling, this entrypoint is generated
          // (it cannot be committed under src/ — see
          // scripts/generate-antigravity-entry.mjs: the build-unchanged
          // watcher would restart mid-build on a src/ write, and the Cards
          // integration hook treats newly staged .html as a published page
          // whose assets must resolve under a repository-root assets/
          // directory). scripts/build.mjs materializes it here before the
          // settings build runs; pointing at the src/ directory instead
          // would ship a wwwRoot that resolves to nothing at runtime.
          wwwRoot: './dist/www-entry/antigravity-session',
          // One normalized destination record per line, and a record's whole
          // step content — including embedded tool payloads — rides that one
          // line, so the limit sits between the Claude renderer's 1 MiB and
          // the Codex renderer's 4 MiB.
          maxLineLength: 2_097_152
        }
      }
    }
  }
});

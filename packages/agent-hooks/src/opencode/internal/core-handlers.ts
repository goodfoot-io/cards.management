/**
 * Factories for the OpenCode `cards` (core) plugin handlers.
 *
 * - **UserPromptSubmit** (`createUserPromptSubmitPlugin`) nudges toward the
 *   `cards` skill via a `chat.message` parts-append when the prompt
 *   mentions card concepts — OpenCode has no hook-output channel, so the nudge
 *   rides a synthetic text part appended to the outgoing user message.
 * - **PostToolUse(Skill)** (`createPostToolUseSkillPlugin`) silently records
 *   cards skill loads through `tool.execute.after`, short-circuiting
 *   the prompt nudge once the skill is in play.
 *
 * Both handlers gate on the root-session registry built from
 * `event`/`session.created` so child sessions never trigger Cards behavior.
 * Every hook body is wrapped in catch-all isolation: a throwing plugin kills
 * the user's whole OpenCode session.
 *
 * @summary Factory implementations for the OpenCode core handlers
 * @module internal/core-handlers
 */

import { randomBytes } from 'node:crypto';
import type { Plugin } from '@opencode-ai/plugin';
import {
  buildNudgeContext,
  findCardIds,
  promptHasCardTerm,
  promptHasCreationIntent,
  TASK_NOTIFICATION_RE
} from '../card-mention.js';
import { createOpencodeLog, type OpencodeLog } from '../hook-log.js';
import { createRootSessionRegistry } from '../opencode-state.js';
import { defaultOpencodeHandlerDeps, type OpencodeHandlerDeps } from './deps.js';

/** Marker key recorded and consulted for the cards skill. */
const CARDS_SKILL = 'cards:cards';

/**
 * Cards skill address emitted in nudge text.
 *
 * OpenCode registers skills in one flat namespace keyed by SKILL.md
 * frontmatter name, so the shipped skill resolves as bare `cards` — the
 * Claude/Codex `plugin:skill` spelling does not resolve here.
 */
const CARDS_SKILL_ADDRESS = 'cards';

/**
 * Builds the bundle-wide logger for a plugin factory.
 *
 * @param directory - Session working directory supplied at plugin init.
 * @param deps - Handler dependencies supplying the IO seam.
 * @param client - Live SDK client, or `null`.
 * @returns The structured logger.
 */
function buildLogger(
  directory: string,
  deps: OpencodeHandlerDeps,
  client: Parameters<Plugin>[0]['client']
): OpencodeLog {
  return createOpencodeLog({ client, cwd: directory, io: deps.io });
}

/**
 * Wraps one hook body in catch-all isolation with a named warning.
 *
 * @template T Hook return type.
 * @param log - Logger for the failure entry.
 * @param name - Handler name for the warning line.
 * @param body - The actual hook logic.
 * @returns An async function safe to hand to OpenCode.
 */
async function guarded<T>(log: OpencodeLog | null, name: string, body: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = `${name} failed (fail-open): ${message}`;
    if (log) {
      await log.warn(entry);
    } else {
      process.stderr.write(`[opencode-cards-hooks] warn: ${entry}\n`);
    }
    return undefined;
  }
}

/**
 * Reports whether a loaded skill name refers to the cards skill.
 *
 * OpenCode discovers skills by directory name while the sibling agents use the
 * `cards:cards` namespace, so both spellings count as the same load.
 *
 * @param skill - The skill identifier reported by the tool call.
 * @returns `true` when the identifier names the cards skill.
 */
function isCardsSkill(skill: string): boolean {
  return skill === 'cards' || skill.startsWith('cards:cards');
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

/**
 * Generates a synthetic text-part id in OpenCode's own shape.
 *
 * The live binary rejects parts whose id does not match its prefixed,
 * fixed-length convention (`prt_` + 26 characters) — a bare UUID crashes the
 * message pipeline (observed on OpenCode v1.18.21). Matching the observed shape
 * keeps the appended nudge part indistinguishable from a native one.
 *
 * @returns An `prt_`-prefixed identifier of the expected length.
 */
function nextPartId(): string {
  return `prt_${randomBytes(13).toString('hex')}`;
}

/**
 * Creates the card-mention nudge plugin over `chat.message`.
 *
 * Detection mirrors the Claude/Codex siblings exactly: skill-already-loaded
 * and `<task-notification>` short-circuits, whitespace-bounded card terms,
 * verb-anchored creation intent, and on-disk-confirmed card IDs. The nudge is
 * appended to the outgoing message parts as a synthetic text part — delivery
 * to the model through this channel is the per-prompt enhancement path; the
 * reliable every-turn path is the runtime bundle's system transform.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event` (registry feed) and
 *   `chat.message` hooks.
 */
export function createUserPromptSubmitPlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'prompt-nudge registry event', () => {
          if (event.type === 'session.created') {
            registry.observe({ id: event.properties.info.id, parentID: event.properties.info.parentID });
          }
        }),

      'chat.message': async (input, output) =>
        guarded(log, 'chat.message card nudge', async () => {
          // Resumed sessions never re-emit `created`; their first message
          // classifies them as roots under registry rule (b).
          registry.noteObserved(input.sessionID);
          if (!registry.isRoot(input.sessionID)) {
            return;
          }

          // Short-circuit when the skill has already been loaded this session.
          if (deps.markers.hasSkillLoaded(input.sessionID, CARDS_SKILL)) {
            return;
          }

          const prompt =
            output.parts
              .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
              .map((part) => part.text)
              .join('\n') || '';

          // Short-circuit on task-notification bodies — agent-authored prose,
          // not a real user prompt.
          if (!prompt || TASK_NOTIFICATION_RE.test(prompt)) {
            return;
          }

          const hasTerm = promptHasCardTerm(prompt);
          const hasCreationIntent = promptHasCreationIntent(prompt);
          const cardIds = findCardIds(prompt);

          // Already working the identified card (CARD_ID env set by the
          // launcher) — naming that same card is not a signal to nudge.
          const currentCardId = process.env['CARD_ID']?.trim();
          if (currentCardId && cardIds.includes(currentCardId)) {
            return;
          }

          if (!hasTerm && !hasCreationIntent && cardIds.length === 0) {
            return;
          }

          await log.info('Nudging to load cards', {
            sessionId: input.sessionID,
            hasTerm,
            hasCreationIntent,
            cardIds
          });

          // Parts-append nudge: a synthetic text part riding the user turn.
          output.parts.push({
            id: nextPartId(),
            sessionID: input.sessionID,
            messageID: input.messageID ?? output.message.id,
            type: 'text',
            text: buildNudgeContext(cardIds, hasCreationIntent, CARDS_SKILL_ADDRESS),
            synthetic: true
          });
        })
    };
  };
}

// ---------------------------------------------------------------------------
// PostToolUse(Skill)
// ---------------------------------------------------------------------------

/**
 * Narrows unknown tool arguments to `{ skill: string }`.
 *
 * The skill-loading tool is not part of a typed union we can import, so the
 * shape is guarded at runtime; mismatches fail open.
 *
 * @param value - The tool arguments value to narrow.
 * @returns `true` when `value` is a non-null object with a string `skill`.
 */
function isSkillToolArgs(value: unknown): value is { skill: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'skill' in value &&
    typeof (value as Record<string, unknown>)['skill'] === 'string'
  );
}

/**
 * Creates the silent skill-load recorder plugin over `tool.execute.after`.
 *
 * When the executed tool reports a cards skill load, a per-session marker is
 * persisted so the {@link createUserPromptSubmitPlugin} nudge stops asking.
 * Recording is silent — the hook returns without mutating its output.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event` (registry feed) and
 *   `tool.execute.after` hooks.
 */
export function createPostToolUseSkillPlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'skill-marker registry event', () => {
          if (event.type === 'session.created') {
            registry.observe({ id: event.properties.info.id, parentID: event.properties.info.parentID });
          }
        }),

      'tool.execute.after': async (input) =>
        guarded(log, 'post-tool-use-skill', async () => {
          // Resumed sessions classify on their first tool execution.
          registry.noteObserved(input.sessionID);
          if (!registry.isRoot(input.sessionID)) {
            return;
          }
          if (input.tool.toLowerCase() !== 'skill') {
            return;
          }
          if (!isSkillToolArgs(input.args)) {
            return;
          }
          if (!isCardsSkill(input.args.skill)) {
            return;
          }

          deps.markers.markSkillLoaded(input.sessionID, CARDS_SKILL);
          await log.info('Recorded cards skill load', {
            sessionId: input.sessionID,
            skill: input.args.skill
          });
        })
    };
  };
}

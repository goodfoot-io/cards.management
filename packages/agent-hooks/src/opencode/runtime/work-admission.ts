/**
 * OpenCode's injected chat.message and child-session admission boundaries.
 * @summary OpenCode durable work admission
 * @module work-admission
 */

import type { Plugin } from '@opencode-ai/plugin';
import type { WorkAuthority, WorkBoundary } from '../../shared/work-authority.js';
import { createHookWorkAuthority } from '../../shared/work-authority.js';
import { defineOpencodePluginModule } from '../internal/plugin-module.js';
import { createInertRuntimePlugin, isCardsActionSession } from '../internal/runtime-handlers.js';

/**
 * Admits an OpenCode boundary before downstream plugin work.
 * @param _authority - Injected authority.
 * @param _boundary - Stable host boundary.
 */
export async function admitOpencodeBoundary(_authority: WorkAuthority, _boundary: WorkBoundary): Promise<void> {
  await _authority.admit(_boundary);
}

/**
 * Builds the OpenCode root-turn and child-start admission plugin.
 * @param authorityFactory - Injected authority factory.
 * @returns Plugin that blocks messages and aborts rejected children.
 */
export function createWorkAdmissionPlugin(authorityFactory: () => WorkAuthority = createHookWorkAuthority): Plugin {
  return async ({ client }) => ({
    'chat.message': async (input) => {
      const id = `opencode:turn:${input.sessionID}:${input.messageID}`;
      await authorityFactory().admit({ cause: 'turn', messageId: id, requestId: id });
    },
    event: async ({ event }) => {
      if (event.type !== 'session.created' || !event.properties.info.parentID) return;
      const childId = event.properties.info.id;
      const id = `opencode:child:${event.properties.info.parentID}:${childId}`;
      try {
        await authorityFactory().admit({ cause: 'childTask', messageId: id, requestId: id });
      } catch (error) {
        await client.session.abort({ path: { id: childId } });
        throw error;
      }
    }
  });
}

/** Shipped plugin, inert outside Cards-owned actions. */
export const CardsWorkAdmission: Plugin = isCardsActionSession()
  ? createWorkAdmissionPlugin()
  : createInertRuntimePlugin();

export default defineOpencodePluginModule('cards-work-admission', CardsWorkAdmission);

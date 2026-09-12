/**
 * Tests for the Antigravity transport: dispatch and the failure-marker
 * policy. The full stdin→stdout wire is covered by spawning the compiled
 * bundles in the compiled-output suite.
 *
 * @summary Tests for the Antigravity transport driver
 */

import { join } from 'node:path';
import { Logger } from '@goodfoot/agent-hooks';
import { describe, expect, it } from 'vitest';
import { HandlerFailure, handlePreInvocation } from '../../../src/antigravity/internal/handlers.js';
import { markerPath } from '../../../src/antigravity/internal/markers.js';
import { dispatchAntigravityHook } from '../../../src/antigravity/internal/transport.js';
import { CONVERSATION_ID, makeDeps, makeTempDir, removeTempDir, SESSION_ID, withoutEnv } from '../helpers.js';

function joinCardsHome(root: string): string {
  return join(root, 'cards-home');
}

describe('dispatchAntigravityHook', () => {
  it('passes the parsed input and a context carrying the same deps through', async () => {
    const root = makeTempDir('dispatch');
    try {
      const { deps } = makeDeps(root);
      let seen: unknown;
      let sameDeps = false;
      const result = await dispatchAntigravityHook(
        { value: 1 },
        async (raw, ctx) => {
          seen = raw;
          sameDeps = ctx.deps === deps;
          return { output: { ok: true } };
        },
        deps
      );
      expect(seen).toEqual({ value: 1 });
      expect(sameDeps).toBe(true);
      expect(result).toEqual({ output: { ok: true } });
    } finally {
      removeTempDir(root);
    }
  });

  it('writes the conversation-scoped failure marker when the handler fails', async () => {
    const root = makeTempDir('dispatch-failure');
    try {
      const { deps } = makeDeps(root);
      await expect(
        dispatchAntigravityHook(
          { conversationId: CONVERSATION_ID },
          async () => {
            throw new HandlerFailure('watcher-setup', 'spawn returned false', CONVERSATION_ID);
          },
          deps
        )
      ).rejects.toBeInstanceOf(HandlerFailure);

      const failurePath = markerPath(joinCardsHome(root), SESSION_ID, CONVERSATION_ID, 'failure');
      expect(deps.io.existsSync(failurePath)).toBe(true);
      const payload = JSON.parse(deps.io.readTextFileSync(failurePath)) as { stage: string; reason: string };
      expect(payload.stage).toBe('watcher-setup');
      expect(payload.reason).toContain('spawn returned false');
    } finally {
      removeTempDir(root);
    }
  });

  it('records unexpected throws as the unexpected stage', async () => {
    const root = makeTempDir('dispatch-unexpected');
    try {
      const { deps } = makeDeps(root);
      await expect(
        dispatchAntigravityHook(
          { conversationId: CONVERSATION_ID },
          async () => {
            throw new Error('boom');
          },
          deps
        )
      ).rejects.toBeInstanceOf(HandlerFailure);

      const failurePath = markerPath(joinCardsHome(root), SESSION_ID, CONVERSATION_ID, 'failure');
      const payload = JSON.parse(deps.io.readTextFileSync(failurePath)) as { stage: string };
      expect(payload.stage).toBe('unexpected');
    } finally {
      removeTempDir(root);
    }
  });

  it('resolves the marker session from the deps resolver at failure time', async () => {
    const root = makeTempDir('dispatch-scope');
    try {
      const { deps } = makeDeps(root, { resolveSessionId: () => null });
      await expect(
        dispatchAntigravityHook(
          { conversationId: CONVERSATION_ID },
          async () => {
            throw new HandlerFailure('input', 'field transcriptPath invalid', CONVERSATION_ID);
          },
          deps
        )
      ).rejects.toBeInstanceOf(HandlerFailure);

      expect(deps.io.existsSync(markerPath(joinCardsHome(root), null, CONVERSATION_ID, 'failure'))).toBe(true);
    } finally {
      removeTempDir(root);
    }
  });
});

describe('inert gating inside handlers', () => {
  it('PreInvocation stays inert and writes no ready marker outside a Cards action', async () => {
    const restore = withoutEnv('CARD_ID');
    const root = makeTempDir('transport-inert');
    try {
      const { deps } = makeDeps(root, { loadActionInput: () => null });
      const result = await handlePreInvocation({ conversationId: CONVERSATION_ID }, { deps, logger: new Logger() });
      expect(result.output).toEqual({});
      expect(deps.io.existsSync(markerPath(joinCardsHome(root), SESSION_ID, CONVERSATION_ID, 'ready'))).toBe(false);
    } finally {
      restore();
      removeTempDir(root);
    }
  });
});

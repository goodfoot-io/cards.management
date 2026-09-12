/**
 * Tests for the Antigravity PreInvocation handler contract: registration,
 * card-context readiness, watcher setup, and the ready/failure marker
 * invariants.
 *
 * @summary Tests for the Antigravity PreInvocation handler
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AntigravityHandlerDeps } from '../../../src/antigravity/internal/deps.js';
import { type HandlerFailure, handlePreInvocation } from '../../../src/antigravity/internal/handlers.js';
import { defaultAntigravityIo } from '../../../src/antigravity/internal/io.js';
import { markerPath } from '../../../src/antigravity/internal/markers.js';
import { dispatchAntigravityHook } from '../../../src/antigravity/internal/transport.js';
import {
  CONVERSATION_ID,
  type DepsRecorders,
  makeCardRepo,
  makeDeps,
  makeInvocationInput,
  makeTempDir,
  removeTempDir,
  SESSION_ID,
  withoutEnv
} from '../helpers.js';

let root: string;
let restoreEnv: () => void;

beforeEach(() => {
  root = makeTempDir('pre-invocation');
  makeCardRepo(root);
  restoreEnv = withoutEnv('CARD_ID', 'ANTIGRAVITY_SESSION_ID', 'CARDS_ASSISTANT_SESSION', 'CARDS_ASSISTANT_WINDOW_ID');
  process.env['CARD_ID'] = 'main-453';
  process.env['ANTIGRAVITY_SESSION_ID'] = SESSION_ID;
});

afterEach(() => {
  restoreEnv();
  removeTempDir(root);
});

function cardsHome(): string {
  return join(root, 'cards-home');
}

function readyMarker(): string {
  return markerPath(cardsHome(), SESSION_ID, CONVERSATION_ID, 'ready');
}

function failureMarker(): string {
  return markerPath(cardsHome(), SESSION_ID, CONVERSATION_ID, 'failure');
}

/**
 * Runs the handler through the real transport dispatch, as the host would.
 *
 * @param overrides - Deps overrides merged last.
 * @param input - Raw stdin value (defaults to the valid invocation fixture).
 * @returns The result (when no failure), the caught failure, and the recorders.
 */
async function run(
  overrides: Partial<AntigravityHandlerDeps> = {},
  input: unknown = makeInvocationInput(root)
): Promise<{ result: { output?: unknown } | null; failure: HandlerFailure | null; recorders: DepsRecorders }> {
  const { deps, recorders } = makeDeps(root, overrides);
  let result: { output?: unknown } | null = null;
  let failure: HandlerFailure | null = null;
  try {
    result = await dispatchAntigravityHook(input, handlePreInvocation, deps);
  } catch (error) {
    failure = error as HandlerFailure;
  }
  return { result, failure, recorders };
}

describe('PreInvocation success contract', () => {
  it('admits the root invocation before registration and watcher work', async () => {
    const admit = vi.fn(async () => ({ workRevision: 1 }));
    const { failure } = await run({ workAuthority: { admit, observeRevision: async () => 0 } });
    expect(failure).toBeNull();
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'turn', requestId: `antigravity:turn:${CONVERSATION_ID}:0` })
    );
  });

  it('fails closed before setup when root admission is rejected', async () => {
    const { failure, recorders } = await run({
      workAuthority: {
        admit: async () => {
          throw new Error('drain barrier held');
        },
        observeRevision: async () => 0
      }
    });
    expect(failure?.reason).toContain('drain barrier held');
    expect(recorders.watcherSpawns).toEqual([]);
  });

  it('returns no message and writes the ready marker on the host 0-indexed first invocation', async () => {
    const { result } = await run();
    expect(result?.output).toEqual({});
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(true);
  });

  it('records the durable session ↔ conversation mapping in the ready marker', async () => {
    const { failure } = await run();
    expect(failure).toBeNull();
    expect(JSON.parse(defaultAntigravityIo.readTextFileSync(readyMarker()))).toEqual({
      conversationId: CONVERSATION_ID,
      sessionId: SESSION_ID,
      transcriptPath: join(root, 'gemini-home', '.gemini', 'antigravity-cli', 'conversations', `${CONVERSATION_ID}.db`),
      modelName: 'gemini-3-pro'
    });
  });

  it('registers the session → worktree/transcript mapping', async () => {
    const { failure, recorders } = await run();
    expect(failure).toBeNull();
    expect(recorders.registrations).toEqual([
      {
        sessionId: SESSION_ID,
        worktreeDir: join(root, 'workspace'),
        transcriptPath: join(
          root,
          'gemini-home',
          '.gemini',
          'antigravity-cli',
          'conversations',
          `${CONVERSATION_ID}.db`
        )
      }
    ]);
  });

  it('registers the canonical conversation DB path, absent DB included', async () => {
    const { failure, recorders } = await run();
    expect(failure).toBeNull();
    const registered = recorders.registrations[0]?.transcriptPath;
    expect(registered).toBe(
      join(root, 'gemini-home', '.gemini', 'antigravity-cli', 'conversations', `${CONVERSATION_ID}.db`)
    );
    expect(registered).not.toBe(join(root, 'transcripts', `${CONVERSATION_ID}.jsonl`));
    expect(existsSync(registered as string)).toBe(false);
  });

  it('spawns the watcher with the canonical sqlite-poll manifest keyed by the agent PID', async () => {
    const { failure, recorders } = await run();
    expect(failure).toBeNull();
    expect(recorders.watcherSpawns).toHaveLength(1);
    expect(recorders.watcherSpawns[0]?.manifest).toMatchObject({
      version: 2,
      sessionId: SESSION_ID,
      cardId: 'main-453',
      runtime: 'antigravity',
      streamType: 'antigravity-session',
      monitorPid: 4242,
      cardRepoPath: join(root, 'cards', 'main-453'),
      sources: [
        {
          pattern: `${CONVERSATION_ID}.db`,
          role: 'main',
          mode: 'sqlite-poll',
          conversationId: CONVERSATION_ID,
          sidecarPath: join(
            root,
            'cards',
            'main-453',
            'streams',
            'antigravity-session',
            `${CONVERSATION_ID}.db.emission-state.json`
          )
        }
      ]
    });
    expect(recorders.watcherSpawns[0]?.manifest.watchRoot).toBe(
      join(root, 'gemini-home', '.gemini', 'antigravity-cli', 'conversations')
    );
    expect(recorders.watcherSpawns[0]?.extensionPath).toBe(join(root, 'extension'));
  });

  it('writes no failure marker on the success path', async () => {
    const { failure } = await run();
    expect(failure).toBeNull();
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(false);
  });
});

describe('Cards Assistant PreInvocation contract', () => {
  it('classifies an explicit Assistant launch without fabricating CARD_ID', async () => {
    delete process.env['CARD_ID'];
    process.env['CARDS_ASSISTANT_SESSION'] = '1';
    process.env['CARDS_ASSISTANT_WINDOW_ID'] = 'window-453';

    const { failure, recorders } = await run({ loadActionInput: () => null });

    expect(failure).toBeNull();
    expect(recorders.registrations).toEqual([
      {
        sessionId: SESSION_ID,
        worktreeDir: join(root, 'workspace'),
        transcriptPath: join(
          root,
          'gemini-home',
          '.gemini',
          'antigravity-cli',
          'conversations',
          `${CONVERSATION_ID}.db`
        )
      }
    ]);
    expect(recorders.watcherSpawns).toEqual([]);
    expect(JSON.parse(defaultAntigravityIo.readTextFileSync(readyMarker()))).toMatchObject({
      sessionId: SESSION_ID,
      windowId: 'window-453',
      workspacePath: join(root, 'workspace'),
      conversationId: CONVERSATION_ID
    });
  });

  it('keeps a foreign agy session inert even when it inherits a session-like variable', async () => {
    delete process.env['CARD_ID'];
    delete process.env['CARDS_ASSISTANT_SESSION'];

    const { result, recorders } = await run({ loadActionInput: () => null });

    expect(result?.output).toEqual({});
    expect(recorders.registrations).toEqual([]);
    expect(recorders.watcherSpawns).toEqual([]);
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails an Assistant launch when its window identity is missing', async () => {
    delete process.env['CARD_ID'];
    process.env['CARDS_ASSISTANT_SESSION'] = '1';
    delete process.env['CARDS_ASSISTANT_WINDOW_ID'];

    const { failure } = await run({ loadActionInput: () => null });

    expect(failure?.stage).toBe('session-identity');
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });
});

describe('PreInvocation failure contract', () => {
  it('stays inert without a Cards action environment', async () => {
    delete process.env['CARD_ID'];
    const { result } = await run();
    expect(result?.output).toEqual({});
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed on invalid input and scopes the failure marker to the conversation', async () => {
    const input = makeInvocationInput(root) as unknown as Record<string, unknown>;
    delete input['transcriptPath'];
    const { failure } = await run({}, input);
    expect(failure?.stage).toBe('input');
    const payload = JSON.parse(defaultAntigravityIo.readTextFileSync(failureMarker())) as {
      stage: string;
      reason: string;
    };
    expect(payload.stage).toBe('input');
    expect(payload.reason).toContain('transcriptPath');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('scopes the failure marker to the unknown-conversation placeholder when no conversation id arrived', async () => {
    const input = makeInvocationInput(root) as unknown as Record<string, unknown>;
    delete input['conversationId'];
    const { failure } = await run({}, input);
    expect(failure?.stage).toBe('input');
    expect(defaultAntigravityIo.existsSync(markerPath(cardsHome(), SESSION_ID, null, 'failure'))).toBe(true);
  });

  it('fails closed when the launcher session identity is missing', async () => {
    const { failure } = await run({ resolveSessionId: () => null });
    expect(failure?.stage).toBe('session-identity');
    expect(defaultAntigravityIo.existsSync(markerPath(cardsHome(), null, CONVERSATION_ID, 'failure'))).toBe(true);
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when the action environment is broken', async () => {
    const { failure } = await run({ loadActionInput: () => null });
    expect(failure?.stage).toBe('action-env');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when the card repository is inaccessible', async () => {
    rmSync(join(root, 'cards', 'main-453', 'CARD.meta.json'));
    const { failure } = await run();
    expect(failure?.stage).toBe('card-context');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when the agent PID cannot be identified', async () => {
    const { failure } = await run({ findMonitorPid: async () => null });
    expect(failure?.stage).toBe('watcher-setup');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when the manifest builder rejects the canonical conversation DB path', async () => {
    const { failure } = await run({ conversationDbPath: () => join(root, 'conversations', 'wrong.jsonl') });
    expect(failure?.stage).toBe('watcher-setup');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when the watcher spawn does not happen', async () => {
    const { failure } = await run({ spawnWatcher: () => false });
    expect(failure?.stage).toBe('watcher-setup');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when session registration fails', async () => {
    const { failure } = await run({
      registerSession: async () => {
        throw new Error('disk full');
      }
    });
    expect(failure?.stage).toBe('session-registration');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
  });

  it('fails closed when the ready marker cannot be written', async () => {
    const failingIo = {
      ...defaultAntigravityIo,
      writeTextFileSync: (path: string, data: string) => {
        if (path.endsWith('.ready')) {
          throw new Error('read-only filesystem');
        }
        defaultAntigravityIo.writeTextFileSync(path, data);
      }
    };
    const { failure } = await run({ io: failingIo });
    expect(failure?.stage).toBe('ready-marker');
    expect(defaultAntigravityIo.existsSync(readyMarker())).toBe(false);
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
  });
});

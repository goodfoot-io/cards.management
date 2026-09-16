/**
 * Tests for the Antigravity Stop handler contract: idempotent drain and
 * cleanup, the drain-ready marker, and the no-continue output invariant.
 *
 * @summary Tests for the Antigravity Stop handler
 */

import { join } from 'node:path';
import { Logger } from '@goodfoot/agent-hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AntigravityHandlerDeps } from '../../../src/antigravity/internal/deps.js';
import { type HandlerFailure, handleStop } from '../../../src/antigravity/internal/handlers.js';
import { defaultAntigravityIo } from '../../../src/antigravity/internal/io.js';
import { markerPath } from '../../../src/antigravity/internal/markers.js';
import { dispatchAntigravityHook } from '../../../src/antigravity/internal/transport.js';
import {
  CONVERSATION_ID,
  type DepsRecorders,
  makeCardRepo,
  makeCommonInput,
  makeDeps,
  makeTempDir,
  removeTempDir,
  SESSION_ID,
  withoutEnv
} from '../helpers.js';

let root: string;
let restoreEnv: () => void;

beforeEach(() => {
  root = makeTempDir('stop');
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

function drainReadyMarker(): string {
  return markerPath(cardsHome(), SESSION_ID, CONVERSATION_ID, 'drain-ready');
}

function failureMarker(): string {
  return markerPath(cardsHome(), SESSION_ID, CONVERSATION_ID, 'failure');
}

/**
 * Runs the handler through the real transport dispatch, as the host would.
 *
 * @param overrides - Deps overrides merged last.
 * @param input - Raw stdin value (defaults to the valid common input).
 * @returns The result (when no failure), the caught failure, and the recorders.
 */
async function run(
  overrides: Partial<AntigravityHandlerDeps> = {},
  input: unknown = makeCommonInput(root)
): Promise<{ result: { output?: unknown } | null; failure: HandlerFailure | null; recorders: DepsRecorders }> {
  const { deps, recorders } = makeDeps(root, overrides);
  let result: { output?: unknown } | null = null;
  let failure: HandlerFailure | null = null;
  try {
    result = await dispatchAntigravityHook(input, handleStop, deps);
  } catch (error) {
    failure = error as HandlerFailure;
  }
  return { result, failure, recorders };
}

describe('Stop drain and cleanup contract', () => {
  it('returns no continue decision and records drain readiness', async () => {
    const { result } = await run();
    expect(result?.output).toEqual({});
    expect(JSON.stringify(result?.output)).not.toContain('continue');
    expect(JSON.stringify(result?.output)).not.toContain('decision');
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(true);
  });

  it('writes the transcript-watcher flush sentinel for the canonical antigravity session stream', async () => {
    await run();
    const sentinel = join(root, 'cards', 'main-453', 'streams', 'antigravity-session', `${SESSION_ID}.flush`);
    expect(defaultAntigravityIo.existsSync(sentinel)).toBe(true);
  });

  it('cleans up the session artifacts', async () => {
    const cleaned: string[] = [];
    const { failure } = await run({
      cleanupSessionArtifacts: (sessionId) => {
        cleaned.push(sessionId);
      }
    });
    expect(failure).toBeNull();
    expect(cleaned).toEqual([SESSION_ID]);
  });

  it('is idempotent across repeated Stop invocations', async () => {
    const { deps } = makeDeps(root);
    const first = await handleStop(makeCommonInput(root), { deps, logger: new Logger() });
    const second = await handleStop(makeCommonInput(root), { deps, logger: new Logger() });
    expect(first.output).toEqual({});
    expect(second.output).toEqual({});
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(true);
  });

  it('stays inert without a Cards action environment', async () => {
    delete process.env['CARD_ID'];
    const { result } = await run();
    expect(result?.output).toEqual({});
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(false);
  });

  it('fails closed on invalid input', async () => {
    const input = makeCommonInput(root) as unknown as Record<string, unknown>;
    delete input['workspacePaths'];
    const { failure } = await run({}, input);
    expect(failure?.stage).toBe('input');
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(false);
  });
});

describe('Cards Assistant Stop contract', () => {
  it('records drain readiness and cleans session artifacts without card shutdown or stream paths', async () => {
    delete process.env['CARD_ID'];
    process.env['CARDS_ASSISTANT_SESSION'] = '1';
    process.env['CARDS_ASSISTANT_WINDOW_ID'] = 'window-453';
    const cleaned: string[] = [];

    const { failure } = await run({
      loadActionInput: () => null,
      cleanupSessionArtifacts: (sessionId) => cleaned.push(sessionId)
    });

    expect(failure).toBeNull();
    expect(cleaned).toEqual([SESSION_ID]);
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(true);
    expect(defaultAntigravityIo.existsSync(join(root, 'cards', 'main-453', 'streams'))).toBe(false);
  });

  it('fails closed when Assistant cleanup fails', async () => {
    delete process.env['CARD_ID'];
    process.env['CARDS_ASSISTANT_SESSION'] = '1';
    process.env['CARDS_ASSISTANT_WINDOW_ID'] = 'window-453';

    const { failure } = await run({
      loadActionInput: () => null,
      cleanupSessionArtifacts: () => {
        throw new Error('cleanup denied');
      }
    });

    expect(failure?.stage).toBe('session-cleanup');
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(false);
  });
});

describe('Stop marker invariants', () => {
  it('fails closed without drain readiness when the drain-ready marker cannot be written', async () => {
    const failingIo = {
      ...defaultAntigravityIo,
      writeTextFileSync: (path: string, data: string) => {
        if (path.endsWith('.drain-ready')) {
          throw new Error('read-only filesystem');
        }
        defaultAntigravityIo.writeTextFileSync(path, data);
      }
    };
    const { failure } = await run({ io: failingIo });
    expect(failure?.stage).toBe('drain-marker');
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(false);
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
  });

  it('treats artifact cleanup failure as best-effort and still records drain readiness', async () => {
    const { failure } = await run({
      cleanupSessionArtifacts: () => {
        throw new AggregateError([new Error('permission denied')], 'Session cleanup had 1 failure(s)');
      }
    });
    expect(failure).toBeNull();
    expect(defaultAntigravityIo.existsSync(drainReadyMarker())).toBe(true);
  });
});

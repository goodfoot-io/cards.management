/**
 * Tests for the Antigravity PostInvocation handler contract: the
 * idle/route/merge/shutdown decision, at-most-once injection, and the
 * pending-shutdown acknowledgement.
 *
 * @summary Tests for the Antigravity PostInvocation handler
 */

import { join } from 'node:path';
import { Logger } from '@goodfoot/agent-hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AntigravityHandlerDeps } from '../../../src/antigravity/internal/deps.js';
import { type HandlerFailure, handlePostInvocation } from '../../../src/antigravity/internal/handlers.js';
import { defaultAntigravityIo } from '../../../src/antigravity/internal/io.js';
import { markerPath } from '../../../src/antigravity/internal/markers.js';
import { dispatchAntigravityHook } from '../../../src/antigravity/internal/transport.js';
import {
  CONVERSATION_ID,
  type DepsRecorders,
  makeActionInput,
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
  root = makeTempDir('post-invocation');
  makeCardRepo(root);
  restoreEnv = withoutEnv(
    'CARD_ID',
    'ANTIGRAVITY_SESSION_ID',
    'CARD_REPO_PATH',
    'WORKSPACE_PATH',
    'BASE_BRANCH',
    'WORKSPACE_BRANCH'
  );
  process.env['CARD_ID'] = 'main-453';
  process.env['ANTIGRAVITY_SESSION_ID'] = SESSION_ID;
  process.env['CARD_REPO_PATH'] = join(root, 'cards', 'main-453');
  process.env['WORKSPACE_PATH'] = join(root, 'workspace');
  process.env['BASE_BRANCH'] = 'main';
  process.env['WORKSPACE_BRANCH'] = 'cards/main-453/1';
});

afterEach(() => {
  restoreEnv();
  removeTempDir(root);
});

function cardsHome(): string {
  return join(root, 'cards-home');
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
    result = await dispatchAntigravityHook(input, handlePostInvocation, deps);
  } catch (error) {
    failure = error as HandlerFailure;
  }
  return { result, failure, recorders };
}

describe('PostInvocation merge route', () => {
  it('injects the merge route on the host 0-indexed first invocation', async () => {
    const { result } = await run(
      { unmergedCommitCount: () => 2 },
      makeInvocationInput(root, { invocationNum: 0, initialNumSteps: 1 })
    );
    const injectSteps = (result?.output as { injectSteps?: Array<{ ephemeralMessage: string }> } | undefined)
      ?.injectSteps;
    expect(injectSteps).toHaveLength(1);
    expect(injectSteps?.[0]?.ephemeralMessage).toContain('2 commit(s) not merged into `main`');
  });

  it('injects one ephemeral merge step with the Antigravity-native address when commits are unmerged', async () => {
    const { result } = await run({ unmergedCommitCount: () => 3 });
    const injectSteps = (result?.output as { injectSteps?: Array<{ ephemeralMessage: string }> } | undefined)
      ?.injectSteps;
    expect(injectSteps).toHaveLength(1);
    const message = injectSteps?.[0]?.ephemeralMessage ?? '';
    expect(message).toContain('3 commit(s) not merged into `main`');
    expect(message).toContain(join(root, 'skills', 'card', 'references', 'merge.md'));
    expect(message).toContain('`card` skill');
    expect(message).not.toContain('runtime:card');
    expect(JSON.stringify(result?.output)).not.toContain('"decision"');
  });

  it('consumes the session once-marker when it injects the merge route', async () => {
    const { failure, recorders } = await run({ unmergedCommitCount: () => 3 });
    expect(failure).toBeNull();
    expect(recorders.markers.routeNudged.has(SESSION_ID)).toBe(true);
  });

  it('injects at most once while the route marker is consumed', async () => {
    const { deps } = makeDeps(root, { unmergedCommitCount: () => 3 });
    const first = await handlePostInvocation(makeInvocationInput(root), { deps, logger: new Logger() });
    expect((first.output as { injectSteps?: unknown[] }).injectSteps).toHaveLength(1);
    const second = await handlePostInvocation(makeInvocationInput(root), { deps, logger: new Logger() });
    expect(second.output).toEqual({});
  });

  it('stays silent for a blocked card', async () => {
    makeCardRepo(root, { tags: ['blocked'] });
    const { result } = await run({ unmergedCommitCount: () => 3 });
    expect(result?.output).toEqual({});
  });

  it('stays silent when merge is required but unapproved', async () => {
    makeCardRepo(root, { gates: { mergeRequestRequired: true, mergeApproved: false } });
    const { result } = await run({ unmergedCommitCount: () => 3 });
    expect(result?.output).toEqual({});
  });

  it('injects the merge route when merge is required and already approved', async () => {
    makeCardRepo(root, { gates: { mergeRequestRequired: true, mergeApproved: true } });
    const { result } = await run({ unmergedCommitCount: () => 2 });
    const injectSteps = (result?.output as { injectSteps?: unknown[] } | undefined)?.injectSteps;
    expect(injectSteps).toHaveLength(1);
  });

  it('stays silent with zero unmerged commits', async () => {
    const { result } = await run({ unmergedCommitCount: () => 0 });
    expect(result?.output).toEqual({});
  });

  it('stays silent while the session has active subagents', async () => {
    const { deps, recorders } = makeDeps(root, { unmergedCommitCount: () => 3 });
    recorders.markers.subagentCounts.set(SESSION_ID, 1);
    const result = await handlePostInvocation(makeInvocationInput(root), { deps, logger: new Logger() });
    expect(result.output).toEqual({});
    expect(recorders.markers.routeNudged.has(SESSION_ID)).toBe(false);
  });
});

describe('PostInvocation shutdown route', () => {
  it('injects the shutdown step for an idle exit-when-done session', async () => {
    const { result, recorders } = await run({
      loadActionInput: () => makeActionInput(root, { exitWhenDone: true })
    });
    const injectSteps = (result?.output as { injectSteps?: Array<{ ephemeralMessage: string }> } | undefined)
      ?.injectSteps;
    expect(injectSteps).toHaveLength(1);
    const message = injectSteps?.[0]?.ephemeralMessage ?? '';
    expect(message).toContain(join(root, 'skills', 'card', 'references', 'shutdown.md'));
    expect(message).toContain('cards "$CARD_ID" shutdown');
    expect(recorders.markers.exitNudged.has(SESSION_ID)).toBe(true);
  });

  it('prefers the merge route when both routes condition on the same invocation', async () => {
    const { result, recorders } = await run({
      unmergedCommitCount: () => 3,
      loadActionInput: () => makeActionInput(root, { exitWhenDone: true })
    });
    const message = (result?.output as { injectSteps?: Array<{ ephemeralMessage: string }> })?.injectSteps?.[0]
      ?.ephemeralMessage;
    expect(message).toContain('merge.md');
    expect(recorders.markers.routeNudged.has(SESSION_ID)).toBe(true);
    expect(recorders.markers.exitNudged.has(SESSION_ID)).toBe(false);
  });

  it('stays silent when exit-when-done already fired', async () => {
    const { deps, recorders } = makeDeps(root, {
      loadActionInput: () => makeActionInput(root, { exitWhenDone: true })
    });
    recorders.markers.exitNudged.add(SESSION_ID);
    const result = await handlePostInvocation(makeInvocationInput(root), { deps, logger: new Logger() });
    expect(result.output).toEqual({});
  });

  it('stays silent when exit-when-done is disabled', async () => {
    const { result } = await run({});
    expect(result?.output).toEqual({});
  });
});

describe('PostInvocation pending-shutdown acknowledgement', () => {
  const pendingRequest = { version: 1 as const, requestId: 'req-453', socketPath: '/tmp/cards-action-453.sock' };

  it('acknowledges drain readiness instead of injecting a step', async () => {
    const { result, recorders } = await run({
      readPendingShutdownRequest: () => pendingRequest,
      loadActionInput: () => makeActionInput(root, { exitWhenDone: true }),
      unmergedCommitCount: () => 3
    });
    expect(recorders.shutdownAcks).toEqual([
      { socketPath: pendingRequest.socketPath, requestId: pendingRequest.requestId }
    ]);
    expect(result?.output).toEqual({});
  });

  it('waits without acknowledging while the process tree is not drained', async () => {
    const { result, recorders } = await run({
      readPendingShutdownRequest: () => pendingRequest,
      isAgentProcessTreeDrained: async () => false
    });
    expect(recorders.shutdownAcks).toEqual([]);
    expect(result?.output).toEqual({});
  });

  it('fails closed when the drain state cannot be proven', async () => {
    const { failure, recorders } = await run({
      readPendingShutdownRequest: () => pendingRequest,
      isAgentProcessTreeDrained: async () => null
    });
    expect(failure?.stage).toBe('decision');
    expect(recorders.shutdownAcks).toEqual([]);
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
  });
});

describe('PostInvocation idle and failure invariants', () => {
  it('injects no step when no route is due', async () => {
    const { result } = await run({});
    expect(result?.output).toEqual({});
  });

  it('fails closed on decision errors without injecting a guessed route', async () => {
    const { failure } = await run({
      unmergedCommitCount: () => {
        throw new Error('git failed');
      }
    });
    expect(failure?.stage).toBe('decision');
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
  });

  it('fails closed on invalid invocation input', async () => {
    const { failure } = await run({}, makeInvocationInput(root, { invocationNum: -1 }));
    expect(failure?.stage).toBe('input');
    expect(defaultAntigravityIo.existsSync(failureMarker())).toBe(true);
  });

  it('stays inert without a Cards action environment', async () => {
    delete process.env['CARD_ID'];
    const { result } = await run({ unmergedCommitCount: () => 3 });
    expect(result?.output).toEqual({});
  });
});

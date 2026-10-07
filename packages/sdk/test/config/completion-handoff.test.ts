/**
 * The completion handoff: a handler declares readiness only while it watches,
 * sees the wrapper's request once, and, under the real runtime, finishes its
 * own end-of-session work with the shutdown fence still open before exiting
 * as completed.
 * @summary Completion handoff channel and its runtime wiring
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  declareCompletionReady,
  EXECUTION_COMPLETION_DIR_ENV,
  isCompletionReady,
  requestCompletion,
  watchCompletionRequest
} from '../../src/config/completion-handoff.js';
import { EXIT_CODES } from '../../src/config/exit-codes.js';
import { type HandlerHarness, SDK_SOURCE, startHandlerHarness } from '../helpers/runtime-handler.js';

describe('completion handoff channel', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'cards-completion-')), 'exec-1');
  });

  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  it('is not ready until the handler declares it', () => {
    expect(isCompletionReady(dir)).toBe(false);
    declareCompletionReady(dir);
    expect(isCompletionReady(dir)).toBe(true);
  });

  it('refuses a relative directory', () => {
    expect(() => declareCompletionReady('relative/exec-1')).toThrow('must be absolute');
    expect(() => requestCompletion('relative/exec-1')).toThrow('must be absolute');
  });

  it('declares readiness and reports the request exactly once', async () => {
    let requests = 0;
    const stop = watchCompletionRequest(dir, () => requests++, { pollMs: 5 });
    try {
      expect(isCompletionReady(dir)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(requests).toBe(0);
      requestCompletion(dir);
      await waitFor(() => requests === 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(requests).toBe(1);
    } finally {
      stop();
    }
  });

  it('neither declares nor watches once its signal has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    watchCompletionRequest(dir, () => requests++, { pollMs: 5, signal: controller.signal });
    expect(isCompletionReady(dir)).toBe(false);
    requestCompletion(dir);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests).toBe(0);
  });

  it('stops watching when its signal aborts', async () => {
    const controller = new AbortController();
    let requests = 0;
    watchCompletionRequest(dir, () => requests++, { pollMs: 5, signal: controller.signal });
    controller.abort();
    requestCompletion(dir);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests).toBe(0);
  });
});

describe('completion handoff in the handler runtime', () => {
  let harness: HandlerHarness;

  beforeEach(async () => {
    harness = await startHandlerHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const actionEnv = (completionDir: string): NodeJS.ProcessEnv => ({
    CARD_ID: 'main-1',
    ACTION_NAME: 'Implement',
    CARDS_EXECUTION_ID: 'exec-1',
    ENVIRONMENT: 'default',
    EXECUTION_MODE: 'background',
    EXIT_WHEN_DONE: 'true',
    WORKSPACE_PATH: harness.dir,
    REPO_ROOT: harness.dir,
    CARD_REPO_PATH: harness.dir,
    CONFIG_PATH: harness.dir,
    EXTENSION_PATH: harness.dir,
    MARKETPLACE_PATH: harness.dir,
    [EXECUTION_COMPLETION_DIR_ENV]: completionDir
  });

  const completingHandler = (log: string): string => `
import { appendFileSync } from 'node:fs';
import { executeCommand } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime.ts'))};
import { shutdownSignal } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime-shutdown.ts'))};
const log = ${JSON.stringify(log)};
const command = Object.assign(async (_input, context) => {
  context.onShutdown(async (reason) => { appendFileSync(log, 'shutdown:' + reason + '\\n'); });
  let finishAgent;
  const agent = new Promise((resolve) => { finishAgent = resolve; });
  context.onComplete(async () => {
    appendFileSync(log, 'complete:' + shutdownSignal.aborted + '\\n');
    finishAgent();
  });
  appendFileSync(log, 'ready\\n');
  await agent;
  appendFileSync(log, 'end-pass:' + shutdownSignal.aborted + '\\n');
}, { factoryType: 'action', actionName: 'Implement' });
await executeCommand(command);
`;

  it('runs the completion callback and lets the action finish with the fence open', async () => {
    const log = join(harness.dir, 'events.log');
    const completionDir = join(harness.dir, 'completion', 'exec-1');
    const run = harness.start(completingHandler(log), actionEnv(completionDir));
    await waitFor(() => lines(log).includes('ready') && isCompletionReady(completionDir), 20_000);

    requestCompletion(completionDir);

    expect(await run.exited).toEqual({ code: EXIT_CODES.SUCCESS, signal: null });
    expect(lines(log)).toEqual(['ready', 'complete:false', 'end-pass:false', 'shutdown:completed']);
  });

  it('declares nothing outside a wrapper', async () => {
    const log = join(harness.dir, 'events.log');
    const { [EXECUTION_COMPLETION_DIR_ENV]: _omitted, ...env } = actionEnv(join(harness.dir, 'completion', 'exec-1'));
    const run = harness.start(completingHandler(log), env);
    await waitFor(() => lines(log).includes('ready'), 20_000);

    expect(existsSync(join(harness.dir, 'completion'))).toBe(false);
    run.child.kill('SIGTERM');
    await run.exited;
  });
});

/**
 * Polls a condition every 10 ms.
 * @param check - Condition to wait for.
 * @param timeoutMs - Ceiling before failing.
 * @throws {Error} When the condition stays false past the ceiling.
 */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

/**
 * Reads a log's lines.
 * @param log - The log file.
 * @returns Its lines, or none when it does not exist yet.
 */
function lines(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

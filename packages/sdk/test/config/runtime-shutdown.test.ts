/**
 * The handler runtime's single-flight shutdown: hooks run in reverse order
 * under one budget after the fence signal aborts, a failing hook never blocks
 * the exit, and repeated signals neither rerun hooks nor fall back to their
 * default action. The signal paths run in real handler processes.
 * @summary Runtime shutdown hooks, budget, fence and signal handling
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/config/exit-codes.js';
import {
  createShutdownCoordinator,
  SHUTDOWN_BUDGET_MS,
  type ShutdownReason
} from '../../src/config/runtime-shutdown.js';
import { type HandlerHarness, SDK_SOURCE, startHandlerHarness } from '../helpers/runtime-handler.js';
import { TSX_IMPORT } from '../helpers/tsx.js';

const POSIX = process.platform !== 'win32';

describe('shutdown coordinator', () => {
  it('aborts the fence before the first hook and runs hooks in reverse order, then exits', async () => {
    const events: string[] = [];
    const coordinator = createShutdownCoordinator({ exit: (code) => events.push(`exit:${code}`) });
    coordinator.configure({ finalize: () => events.push('finalize') });
    coordinator.register(async (reason) => {
      events.push(`first:${reason}:${coordinator.signal.aborted}`);
    });
    coordinator.register(async (reason) => {
      events.push(`second:${reason}:${coordinator.signal.aborted}`);
    });

    expect(coordinator.signal.aborted).toBe(false);
    void coordinator.shutdownAndExit(3, 'completed');
    expect(coordinator.signal.aborted).toBe(true);
    await waitFor(() => events.includes('exit:3'));

    expect(events).toEqual(['second:completed:true', 'first:completed:true', 'finalize', 'exit:3']);
  });

  it('reports a throwing hook and still runs the rest and exits', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const coordinator = createShutdownCoordinator({ exit: (code) => events.push(`exit:${code}`) });
    coordinator.configure({ onHookError: (error) => errors.push(error) });
    coordinator.register(async () => {
      events.push('first');
    });
    coordinator.register(async () => {
      throw new Error('hook failed');
    });

    void coordinator.shutdownAndExit(1, 'failed');
    await waitFor(() => events.includes('exit:1'));

    expect(events).toEqual(['first', 'exit:1']);
    expect(errors).toHaveLength(1);
  });

  it('cuts an overrunning hook off at the budget and exits', async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const coordinator = createShutdownCoordinator({ exit: (code) => events.push(`exit:${code}`), budgetMs: 200 });
    coordinator.configure({ onHookError: (error) => errors.push(error) });
    coordinator.register(async () => {
      events.push('never-reached');
    });
    coordinator.register(() => new Promise<void>(() => {}));

    const started = Date.now();
    void coordinator.shutdownAndExit(0, 'completed');
    await waitFor(() => events.includes('exit:0'));

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(events).toEqual(['exit:0']);
    expect(errors).toHaveLength(1);
  });

  it('is single-flight: a second call during the hooks shares the promise and changes nothing', async () => {
    const reasons: ShutdownReason[] = [];
    const exits: number[] = [];
    const coordinator = createShutdownCoordinator({ exit: (code) => exits.push(code) });
    let releaseHook = (): void => {};
    coordinator.register(async (reason) => {
      reasons.push(reason);
      await new Promise<void>((resolveHook) => {
        releaseHook = resolveHook;
      });
    });

    const first = coordinator.shutdownAndExit(0, 'completed');
    await waitFor(() => reasons.length === 1);
    const second = coordinator.shutdownAndExit(143, 'signal');
    releaseHook();
    await waitFor(() => exits.length === 1);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    expect(second).toBe(first);
    expect(reasons).toEqual(['completed']);
    expect(exits).toEqual([0]);
  });

  it('accepts a registration after shutdown began and never runs it', async () => {
    const events: string[] = [];
    const coordinator = createShutdownCoordinator({ exit: (code) => events.push(`exit:${code}`) });
    let releaseHook = (): void => {};
    coordinator.register(
      () =>
        new Promise<void>((resolveHook) => {
          releaseHook = resolveHook;
        })
    );
    void coordinator.shutdownAndExit(0, 'completed');
    const unregister = coordinator.register(async () => {
      events.push('late');
    });
    unregister();
    releaseHook();
    await waitFor(() => events.includes('exit:0'));

    expect(events).toEqual(['exit:0']);
  });

  it('removes an unregistered hook', async () => {
    const events: string[] = [];
    const coordinator = createShutdownCoordinator({ exit: (code) => events.push(`exit:${code}`) });
    const unregister = coordinator.register(async () => {
      events.push('removed');
    });
    unregister();
    void coordinator.shutdownAndExit(0, 'completed');
    await waitFor(() => events.includes('exit:0'));

    expect(events).toEqual(['exit:0']);
  });

  it('uses a three second default budget', () => {
    expect(SHUTDOWN_BUDGET_MS).toBe(3_000);
  });
});

describe('handler process shutdown paths', () => {
  let dir: string;
  let children: ChildProcess[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-shutdown-'));
    children = [];
  });

  afterEach(() => {
    for (const child of children) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Starts a real handler process running a cards-assistant command through
   * `executeCommand`, with two hooks that log their reason and the fence state.
   * @param mode - `complete` returns, `fail` throws, `wait` blocks until signalled.
   * @param hook - `log` logs, `throw` makes the later hook throw, `hang` makes it hang, `slow` makes it take a second.
   * @returns The process, its log path and its exit.
   */
  function startHandler(
    mode: 'complete' | 'fail' | 'wait',
    hook: 'log' | 'throw' | 'hang' | 'slow' = 'log'
  ): { child: ChildProcess; log: string; exited: Promise<{ code: number | null; signal: string | null }> } {
    const log = join(dir, 'events.log');
    const script = join(dir, 'handler.mts');
    writeFileSync(
      script,
      `
import { appendFileSync } from 'node:fs';
import { executeCommand } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime.ts'))};
import { registerShutdownHook, shutdownSignal } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime-shutdown.ts'))};
const log = ${JSON.stringify(log)};
const command = Object.assign(async () => {
  registerShutdownHook(async (reason) => { appendFileSync(log, 'first:' + reason + ':' + shutdownSignal.aborted + '\\n'); });
  registerShutdownHook(async (reason) => {
    appendFileSync(log, 'second:' + reason + '\\n');
    if (${JSON.stringify(hook)} === 'throw') throw new Error('hook failed');
    if (${JSON.stringify(hook)} === 'hang') await new Promise(() => {});
    if (${JSON.stringify(hook)} === 'slow') await new Promise((done) => setTimeout(done, 1000));
  });
  appendFileSync(log, 'ready\\n');
  if (${JSON.stringify(mode)} === 'fail') throw new Error('handler failed');
  if (${JSON.stringify(mode)} === 'wait') { setInterval(() => {}, 1000); await new Promise(() => {}); }
}, { factoryType: 'cards-assistant' });
await executeCommand(command);
`
    );
    const child = spawn(process.execPath, [TSX_IMPORT, script], {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        CARDS_HOOKS_LOG_FILE: '/dev/null',
        MARKETPLACE_PATH: dir,
        EXTENSION_PATH: dir,
        REPO_ROOT: dir
      }
    });
    children.push(child);
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) =>
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    );
    return { child, log, exited };
  }

  it('runs the hooks in reverse order before exiting 0 on completion', async () => {
    const handler = startHandler('complete');
    expect(await handler.exited).toEqual({ code: 0, signal: null });
    expect(lines(handler.log)).toEqual(['ready', 'second:completed', 'first:completed:true']);
  });

  it('runs the hooks before exiting 1 on failure', async () => {
    const handler = startHandler('fail');
    expect(await handler.exited).toEqual({ code: 1, signal: null });
    expect(lines(handler.log)).toEqual(['ready', 'second:failed', 'first:failed:true']);
  });

  it('exits despite a throwing hook', async () => {
    const handler = startHandler('complete', 'throw');
    expect(await handler.exited).toEqual({ code: 0, signal: null });
    expect(lines(handler.log)).toEqual(['ready', 'second:completed', 'first:completed:true']);
  });

  it('exits within the budget despite a hanging hook', async () => {
    const handler = startHandler('complete', 'hang');
    await waitFor(() => lines(handler.log).includes('ready'), 20_000);
    const started = Date.now();
    expect(await handler.exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_BUDGET_MS + 2_000);
  });

  it.runIf(POSIX)('runs the hooks on SIGTERM and exits 143', async () => {
    const handler = startHandler('wait');
    await waitFor(() => lines(handler.log).includes('ready'), 20_000);
    handler.child.kill('SIGTERM');
    expect(await handler.exited).toEqual({ code: 143, signal: null });
    expect(lines(handler.log)).toEqual(['ready', 'second:signal', 'first:signal:true']);
  });

  it.runIf(POSIX)('runs the hooks on SIGINT and exits 130', async () => {
    const handler = startHandler('wait');
    await waitFor(() => lines(handler.log).includes('ready'), 20_000);
    handler.child.kill('SIGINT');
    expect(await handler.exited).toEqual({ code: 130, signal: null });
    expect(lines(handler.log)).toEqual(['ready', 'second:signal', 'first:signal:true']);
  });

  it.runIf(POSIX)('runs each hook once and exits once under 50 SIGTERMs sent 25 ms apart', async () => {
    const handler = startHandler('wait', 'slow');
    await waitFor(() => lines(handler.log).includes('ready'), 20_000);
    let exited = false;
    void handler.exited.then(() => {
      exited = true;
    });
    for (let sent = 0; sent < 50 && !exited; sent++) {
      handler.child.kill('SIGTERM');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(await handler.exited).toEqual({ code: 143, signal: null });
    expect(lines(handler.log)).toEqual(['ready', 'second:signal', 'first:signal:true']);
  });
});

describe('switch path', () => {
  let harness: HandlerHarness;

  beforeEach(async () => {
    harness = await startHandlerHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('runs the hooks in reverse order before exiting with the switch code', async () => {
    const log = join(harness.dir, 'events.log');
    const run = harness.start(
      `
import { appendFileSync } from 'node:fs';
import { executeCommand } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime.ts'))};
import { shutdownSignal } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime-shutdown.ts'))};
const log = ${JSON.stringify(log)};
const command = Object.assign(async (_input, context) => {
  context.onShutdown(async (reason) => { appendFileSync(log, 'first:' + reason + ':' + shutdownSignal.aborted + '\\n'); });
  context.onShutdown(async (reason) => { appendFileSync(log, 'second:' + reason + '\\n'); });
  context.onSwitchToInteractive(() => ({ sessionId: 'session-1' }));
  appendFileSync(log, 'ready\\n');
  await new Promise(() => {});
}, { factoryType: 'action', actionName: 'Implement' });
await executeCommand(command);
`,
      {
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
        MARKETPLACE_PATH: harness.dir
      }
    );
    await waitFor(
      () =>
        lines(log).includes('ready') &&
        harness.server.received.some((envelope) => envelope.type === 'runtime.capabilities'),
      20_000
    );

    harness.server.sendCommand('switch-1', undefined, { type: 'execution.switchToInteractiveCommand', payload: {} });

    expect(await run.exited).toEqual({ code: EXIT_CODES.SWITCH_TO_INTERACTIVE, signal: null });
    expect(lines(log)).toEqual(['ready', 'second:switch', 'first:switch:true']);
    expect(harness.server.received.find((envelope) => envelope.type === 'execution.interactiveHandoff')).toMatchObject({
      payload: { launchProtocol: 2 }
    });
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
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

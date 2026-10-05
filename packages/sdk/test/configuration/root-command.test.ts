/**
 * The `executeCommand` root-command branch in real handler processes: it
 * extracts the maintenance input from the env and the agent-handler credential,
 * sends the last reported object as `execution.commandReport` before exiting,
 * and fails closed on bad input, a missing report or a failing handler.
 * @summary Worktree maintenance root command execution and report delivery
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_COMMAND_REPORT_BYTES } from '../../src/protocol/types/runtime-messages.js';
import { type HandlerHarness, SDK_SOURCE, startHandlerHarness } from '../helpers/runtime-handler.js';

let harness: HandlerHarness;

beforeEach(async () => {
  harness = await startHandlerHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/**
 * Source of a maintenance handler whose behaviour the `BEHAVIOUR` env selects.
 * @param output - File the handler writes its input to.
 * @param log - File the handler's shutdown hook appends to.
 * @returns The module source.
 */
function maintenanceHandler(output: string, log: string): string {
  return `
import { appendFileSync, writeFileSync } from 'node:fs';
import { executeCommand } from ${JSON.stringify(join(SDK_SOURCE, 'config/runtime.ts'))};
import { defineWorktreeMaintenance } from ${JSON.stringify(join(SDK_SOURCE, 'config/factories/worktree-maintenance.ts'))};
const behaviour = process.env.BEHAVIOUR;
const command = defineWorktreeMaintenance({}, async (input, context) => {
  writeFileSync(${JSON.stringify(output)}, JSON.stringify(input));
  context.onShutdown(async (reason) => { appendFileSync(${JSON.stringify(log)}, 'hook:' + reason + '\\n'); });
  if (behaviour === 'throw') throw new Error('maintenance failed');
  if (behaviour === 'oversize') {
    try {
      context.report({ blob: 'x'.repeat(${MAX_COMMAND_REPORT_BYTES}) });
    } catch {
      appendFileSync(${JSON.stringify(log)}, 'oversize-refused\\n');
    }
    context.report({ fits: true });
    return;
  }
  if (behaviour === 'silent') return;
  context.report({ first: true });
  context.report({ decisions: [{ branch: 'cards/main-1/2', outcome: 'removed' }] });
});
await executeCommand(command);
`;
}

function env(mode: string, behaviour: string): NodeJS.ProcessEnv {
  return {
    CARD_ID: 'main-1',
    CARDS_EXECUTION_ID: 'exec-1',
    REPO_ROOT: harness.dir,
    CARD_REPO_PATH: join(harness.dir, 'card-repo'),
    EXTENSION_PATH: join(harness.dir, 'extension'),
    CARDS_ROOT_COMMAND_INPUT: JSON.stringify({ mode }),
    BEHAVIOUR: behaviour
  };
}

function commandReports(): unknown[] {
  return harness.server.received
    .filter((envelope) => envelope.type === 'execution.commandReport')
    .map((envelope) => envelope.payload);
}

function lines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

describe('executeCommand root command branch', () => {
  it('passes the env-derived input, sends the last report before exiting 0, and runs shutdown hooks', async () => {
    const output = join(harness.dir, 'input.json');
    const log = join(harness.dir, 'events.log');
    const run = harness.start(maintenanceHandler(output, log), env('cleanup', 'report'));

    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      executionId: 'exec-1',
      cardId: 'main-1',
      mode: 'cleanup',
      repoRoot: harness.dir,
      cardRepoPath: join(harness.dir, 'card-repo'),
      extensionPath: join(harness.dir, 'extension')
    });
    expect(commandReports()).toEqual([{ decisions: [{ branch: 'cards/main-1/2', outcome: 'removed' }] }]);
    const report = harness.server.received.find((envelope) => envelope.type === 'execution.commandReport');
    expect(report).toMatchObject({
      requestId: 'req-1',
      execution: { executionId: 'exec-1' },
      producer: { role: 'agent-handler' }
    });
    expect(lines(log)).toEqual(['hook:completed']);
  });

  it.each(['preview', 'prepare-delete'])('accepts the %s mode', async (mode) => {
    const output = join(harness.dir, 'input.json');
    const run = harness.start(maintenanceHandler(output, join(harness.dir, 'events.log')), env(mode, 'report'));
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ mode });
  });

  it.each([
    ['an unknown mode', JSON.stringify({ mode: 'purge' })],
    ['extra input fields', JSON.stringify({ mode: 'cleanup', cardId: 'main-2' })],
    ['input that is not JSON', 'cleanup'],
    ['no input', undefined]
  ])('fails before the handler runs on %s', async (_name, input) => {
    const output = join(harness.dir, 'input.json');
    const run = harness.start(maintenanceHandler(output, join(harness.dir, 'events.log')), {
      ...env('cleanup', 'report'),
      CARDS_ROOT_COMMAND_INPUT: input
    });
    expect((await run.exited).code).toBe(1);
    expect(lines(output)).toEqual([]);
    expect(commandReports()).toEqual([]);
  });

  it('fails when CARDS_EXECUTION_ID disagrees with the credential', async () => {
    const output = join(harness.dir, 'input.json');
    const run = harness.start(maintenanceHandler(output, join(harness.dir, 'events.log')), {
      ...env('cleanup', 'report'),
      CARDS_EXECUTION_ID: 'exec-2'
    });
    expect((await run.exited).code).toBe(1);
    expect(lines(output)).toEqual([]);
    expect(commandReports()).toEqual([]);
  });

  it('exits 1 and sends nothing when the handler never reports', async () => {
    const log = join(harness.dir, 'events.log');
    const run = harness.start(maintenanceHandler(join(harness.dir, 'input.json'), log), env('preview', 'silent'));
    expect((await run.exited).code).toBe(1);
    expect(commandReports()).toEqual([]);
    expect(lines(log)).toEqual(['hook:failed']);
  });

  it('exits 1 and sends nothing when the handler throws after reporting nothing', async () => {
    const log = join(harness.dir, 'events.log');
    const run = harness.start(maintenanceHandler(join(harness.dir, 'input.json'), log), env('cleanup', 'throw'));
    expect((await run.exited).code).toBe(1);
    expect(commandReports()).toEqual([]);
    expect(lines(log)).toEqual(['hook:failed']);
  });

  it('refuses a report over the bound at the call and keeps the previous one', async () => {
    const log = join(harness.dir, 'events.log');
    const run = harness.start(maintenanceHandler(join(harness.dir, 'input.json'), log), env('preview', 'oversize'));
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(commandReports()).toEqual([{ fits: true }]);
    expect(lines(log)).toEqual(['oversize-refused', 'hook:completed']);
  });
});

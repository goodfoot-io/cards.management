/**
 * Authenticated action runtime composition checks.
 * @summary Durable action runtime tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCommand, CardsAssistantCommand } from '../../src/config/command-types.js';
import { CARDS_ENV_VARS } from '../../src/config/env.js';
import { EXIT_CODES } from '../../src/config/exit-codes.js';

const runtime = vi.hoisted(() => ({
  onMessage: undefined as ((message: unknown) => Promise<void>) | undefined,
  send: vi.fn(async (_message: { type: string; [key: string]: unknown }) => ({
    status: 'accepted',
    messageId: 'accepted'
  })),
  start: vi.fn(async (): Promise<{ status: string }> => ({ status: 'connected' })),
  stop: vi.fn(async () => undefined)
}));

vi.mock('../../src/client/api-discovery.js', () => ({
  discoverApiInfo: vi.fn(async () => ({ host: '127.0.0.1', port: 1234, accessToken: 'token' }))
}));
vi.mock('../../src/client/runtime/outbox/index.js', () => ({
  createFileClientOutbox: vi.fn(() => ({})),
  resolveOutboxRoot: vi.fn(() => '/runtime/outbox')
}));
vi.mock('../../src/client/runtime/index.js', () => ({
  loadRuntimeCredential: vi.fn(() => ({
    execution: { executionId: 'execution-1' },
    credential: { requestId: 'request-1' }
  })),
  createRuntimeClientFromCredentialFile: vi.fn((options: { onMessage: (message: unknown) => Promise<void> }) => {
    runtime.onMessage = options.onMessage;
    return runtime;
  })
}));

import { executeCommand, logger } from '../../src/config/runtime.js';

describe('executeCommand', () => {
  const originalEnv = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runtime.onMessage = undefined;
    runtime.send.mockClear();
    runtime.start.mockClear();
    runtime.stop.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(logger, 'close').mockImplementation(() => undefined);
    Object.assign(process.env, {
      [CARDS_ENV_VARS.CARD_ID]: 'card-123',
      [CARDS_ENV_VARS.ACTION_NAME]: 'Test Action',
      [CARDS_ENV_VARS.ENVIRONMENT]: 'default',
      [CARDS_ENV_VARS.EXECUTION_MODE]: 'interactive',
      [CARDS_ENV_VARS.EXIT_WHEN_DONE]: 'false',
      [CARDS_ENV_VARS.WORKSPACE_PATH]: '/workspace',
      [CARDS_ENV_VARS.REPO_ROOT]: '/workspace',
      [CARDS_ENV_VARS.CARD_REPO_PATH]: '/workspace/cards',
      [CARDS_ENV_VARS.CONFIG_PATH]: '/workspace/.cards/config',
      [CARDS_ENV_VARS.EXTENSION_PATH]: '/extension/path',
      [CARDS_ENV_VARS.MARKETPLACE_PATH]: '/marketplace'
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('executes cards-assistant commands without opening an action runtime', async () => {
    const handler = vi.fn(async () => undefined);
    const command: CardsAssistantCommand = Object.assign(handler, { factoryType: 'cards-assistant' as const });
    await executeCommand(command);
    expect(handler).toHaveBeenCalledOnce();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.SUCCESS);
  });

  it('fails closed when authenticated runtime registration is unavailable', async () => {
    runtime.start.mockResolvedValueOnce({ status: 'unavailable' });
    const handler = vi.fn(async () => undefined);
    const command: ActionCommand = Object.assign(handler, {
      factoryType: 'action' as const,
      actionName: 'Test Action'
    });
    await executeCommand(command);
    expect(handler).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.ERROR);
  });

  it('takes durable custody before reporting a correlated agent termination', async () => {
    let release!: () => void;
    const handler = vi.fn(async (_input, context) => {
      context.onAgentShutdown(async () => 'graceful');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const command: ActionCommand = Object.assign(handler, {
      factoryType: 'action' as const,
      actionName: 'Test Action'
    });
    const executing = executeCommand(command);
    await vi.waitFor(() => expect(runtime.onMessage).toBeTypeOf('function'));
    await runtime.onMessage?.({
      type: 'execution.agentShutdownCommand',
      messageId: 'command-1',
      payload: { shutdownRequestId: 'shutdown-1', workRevision: 1 }
    });
    expect(runtime.send.mock.calls.map(([message]) => message.type)).toEqual([
      'execution.commandCustody',
      'execution.agentTermination'
    ]);
    expect(runtime.send.mock.calls[1]?.[0]).toMatchObject({
      causationId: 'command-1',
      payload: { shutdownRequestId: 'shutdown-1', commandMessageId: 'command-1', result: 'graceful' }
    });
    release();
    await executing;
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});

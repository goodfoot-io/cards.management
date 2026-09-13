/**
 * Authenticated action runtime composition checks.
 * @summary Durable action runtime tests
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCommand, CardsAssistantCommand } from '../../src/config/command-types.js';
import { CARDS_ENV_VARS } from '../../src/config/env.js';
import { EXIT_CODES } from '../../src/config/exit-codes.js';
import type { ActionContext, ActionInput } from '../../src/config/inputs.js';

const runtime = vi.hoisted(() => ({
  options: undefined as
    | { capabilities: { switchToInteractive: boolean }; onMessage: (message: unknown) => Promise<void> }
    | undefined,
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
  createRuntimeClientFromCredentialFile: vi.fn(
    (options: { capabilities: { switchToInteractive: boolean }; onMessage: (message: unknown) => Promise<void> }) => {
      runtime.options = options;
      runtime.onMessage = options.onMessage;
      return runtime;
    }
  )
}));

import { executeCommand, logger } from '../../src/config/runtime.js';

describe('executeCommand', () => {
  const originalEnv = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let cardsHome: string;

  function commandJournalFile(messageId: string): string {
    return path.join(
      cardsHome,
      'runtime',
      'agent-handler-commands',
      'execution-1',
      `${createHash('sha256').update(messageId).digest('hex')}.json`
    );
  }

  async function readCommandPhase(messageId: string): Promise<string> {
    return (JSON.parse(await readFile(commandJournalFile(messageId), 'utf8')) as { phase: string }).phase;
  }

  beforeEach(async () => {
    cardsHome = await mkdtemp(path.join(tmpdir(), 'cards-agent-handler-'));
    runtime.onMessage = undefined;
    runtime.options = undefined;
    runtime.send.mockClear();
    runtime.send.mockResolvedValue({ status: 'accepted', messageId: 'accepted' });
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
      [CARDS_ENV_VARS.MARKETPLACE_PATH]: '/marketplace',
      CARDS_HOME: cardsHome
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    await rm(cardsHome, { recursive: true, force: true });
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

  it('performs and reports shutdown once when custody ACK is lost and the command is replayed', async () => {
    runtime.send.mockRejectedValueOnce(new Error('connection closed before ACK'));
    let release!: () => void;
    const shutdown = vi.fn(async () => 'graceful' as const);
    const handler = vi.fn(async (_input, context) => {
      context.onAgentShutdown(shutdown);
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
    const incoming = {
      type: 'execution.agentShutdownCommand',
      messageId: 'lost-custody-command',
      payload: { shutdownRequestId: 'shutdown-lost', workRevision: 1 }
    };
    await runtime.onMessage?.(incoming);
    await runtime.onMessage?.(incoming);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execution.agentTermination',
        causationId: 'lost-custody-command'
      })
    );
    release();
    await executing;
  });

  it('performs cancellation once despite an uncertain custody ACK and duplicate delivery', async () => {
    runtime.send.mockRejectedValueOnce(new Error('custody ACK dropped'));
    let release!: () => void;
    const cancel = vi.fn(async () => undefined);
    const handler = vi.fn(async (_input, context) => {
      context.onCancel(cancel);
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
    const incoming = { type: 'execution.cancelCommand', messageId: 'cancel-lost-ack', payload: {} };
    await runtime.onMessage?.(incoming);
    await runtime.onMessage?.(incoming);
    expect(cancel).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.SUCCESS);
    expect(await readCommandPhase('cancel-lost-ack')).toBe('effect-observed');
    release();
    await executing;
  });

  it('performs and reports interactive handoff once despite an uncertain custody ACK and replay', async () => {
    let custodyAttempted = false;
    runtime.send.mockImplementation(async (message) => {
      if (message.type === 'execution.commandCustody' && !custodyAttempted) {
        custodyAttempted = true;
        throw new Error('custody ACK dropped');
      }
      return { status: 'accepted', messageId: 'accepted' };
    });
    let release!: () => void;
    const switchToInteractive = vi.fn(() => ({ sessionId: 'stable-session' }));
    const handler = vi.fn(async (_input, context) => {
      context.onSwitchToInteractive(switchToInteractive);
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
    const incoming = { type: 'execution.switchToInteractiveCommand', messageId: 'switch-lost-ack', payload: {} };
    await runtime.onMessage?.(incoming);
    await runtime.onMessage?.(incoming);
    expect(switchToInteractive).toHaveBeenCalledOnce();
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execution.interactiveHandoff',
        causationId: 'switch-lost-ack'
      })
    );
    expect(await readCommandPhase('switch-lost-ack')).toBe('effect-observed');
    release();
    await executing;
  });

  it.each([
    [
      'execution.cancelCommand',
      {
        type: 'execution.cancelCommand',
        messageId: 'restart-cancel',
        requestId: 'execution-request',
        causationId: 'cancel-request',
        payload: {}
      }
    ],
    [
      'execution.switchToInteractiveCommand',
      {
        type: 'execution.switchToInteractiveCommand',
        messageId: 'restart-switch',
        requestId: 'execution-request',
        causationId: 'switch-request',
        payload: {}
      }
    ],
    [
      'execution.agentShutdownCommand',
      {
        type: 'execution.agentShutdownCommand',
        messageId: 'restart-shutdown',
        requestId: 'execution-request',
        causationId: 'shutdown-request',
        payload: { shutdownRequestId: 'shutdown-restart', workRevision: 1 }
      }
    ]
  ] as const)('reconciles interrupted %s effects as explicitly in doubt after restart', async (commandType, incoming) => {
    await mkdir(path.dirname(commandJournalFile(incoming.messageId)), { recursive: true });
    await writeFile(
      commandJournalFile(incoming.messageId),
      `${JSON.stringify({
        executionId: 'execution-1',
        messageId: incoming.messageId,
        commandType,
        phase: 'effect-started'
      })}\n`
    );
    let release!: () => void;
    const cancel = vi.fn(async () => undefined);
    const switchToInteractive = vi.fn(() => ({ sessionId: 'duplicate' }));
    const shutdown = vi.fn(async () => 'graceful' as const);
    const handler = vi.fn(async (_input, context) => {
      context.onCancel(cancel);
      context.onSwitchToInteractive(switchToInteractive);
      context.onAgentShutdown(shutdown);
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
    await runtime.onMessage?.(incoming);
    expect(cancel).not.toHaveBeenCalled();
    expect(switchToInteractive).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(await readCommandPhase(incoming.messageId)).toBe('effect-in-doubt-reported');
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execution.commandEffectResult',
        causationId: incoming.messageId,
        payload: expect.objectContaining({
          commandMessageId: incoming.messageId,
          controlRequestId: incoming.causationId,
          commandType,
          disposition: 'in-doubt'
        })
      })
    );
    release();
    await executing;
  });

  it.each([
    ['execution.cancelCommand', 'retry-cancel', {}],
    ['execution.switchToInteractiveCommand', 'retry-switch', {}],
    ['execution.agentShutdownCommand', 'retry-shutdown', { shutdownRequestId: 'shutdown-retry', workRevision: 1 }]
  ] as const)('retries uncertain %s diagnostics live and remains terminal after fresh replay', async (type, id, payload) => {
    const incoming = {
      type,
      messageId: id,
      requestId: 'execution-request',
      causationId: `${id}-request`,
      payload
    };
    await mkdir(path.dirname(commandJournalFile(incoming.messageId)), { recursive: true });
    await writeFile(
      commandJournalFile(incoming.messageId),
      `${JSON.stringify({
        executionId: 'execution-1',
        messageId: incoming.messageId,
        commandType: incoming.type,
        phase: 'effect-started'
      })}\n`
    );
    const cancel = vi.fn(async () => undefined);
    const switchToInteractive = vi.fn(() => ({ sessionId: 'must-not-run' }));
    const shutdown = vi.fn(async () => 'graceful' as const);
    const run = async () => {
      let release!: () => void;
      const handler: ActionCommand = Object.assign(
        async (_input: ActionInput, context: ActionContext) => {
          context.onCancel(cancel);
          context.onSwitchToInteractive(switchToInteractive);
          context.onAgentShutdown(shutdown);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        { factoryType: 'action' as const, actionName: 'Test Action' }
      );
      const executing = executeCommand(handler);
      await vi.waitFor(() => expect(runtime.onMessage).toBeTypeOf('function'));
      return { executing, release };
    };

    let reportUnavailable = true;
    runtime.send.mockImplementation(async (message) => {
      if (message.type === 'execution.commandEffectResult' && reportUnavailable) {
        reportUnavailable = false;
        return { status: 'unavailable', messageId: 'not-enqueued' };
      }
      return { status: 'accepted', messageId: 'accepted' };
    });
    const first = await run();
    await runtime.onMessage?.(incoming);
    expect(await readCommandPhase(incoming.messageId)).toBe('effect-in-doubt');
    const reports = () =>
      runtime.send.mock.calls
        .map(([message]) => message)
        .filter(({ type }) => type === 'execution.commandEffectResult');
    const firstReport = reports().at(-1);

    await runtime.onMessage?.(incoming);
    expect(reports()).toHaveLength(2);
    expect(reports().at(-1)).toEqual(firstReport);
    expect(await readCommandPhase(incoming.messageId)).toBe('effect-in-doubt-reported');
    first.release();
    await first.executing;

    runtime.onMessage = undefined;
    const reportCount = reports().length;
    const fresh = await run();
    const replay = runtime.onMessage as ((message: unknown) => Promise<void>) | undefined;
    if (replay === undefined) throw new Error('runtime replay receiver was not installed');
    await replay(incoming);
    expect(cancel).not.toHaveBeenCalled();
    expect(switchToInteractive).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(reports()).toHaveLength(reportCount);
    expect(await readCommandPhase(incoming.messageId)).toBe('effect-in-doubt-reported');
    fresh.release();
    await fresh.executing;
  });

  it.each([
    ['execution.cancelCommand', 'fresh-cancel', {}],
    ['execution.switchToInteractiveCommand', 'fresh-switch', {}],
    ['execution.agentShutdownCommand', 'fresh-shutdown', { shutdownRequestId: 'shutdown-fresh', workRevision: 1 }]
  ] as const)('lets a fresh handler retry an uncertain %s diagnostic', async (type, id, payload) => {
    const incoming = {
      type,
      messageId: id,
      requestId: 'execution-request',
      causationId: `${id}-request`,
      payload
    };
    await mkdir(path.dirname(commandJournalFile(id)), { recursive: true });
    await writeFile(
      commandJournalFile(id),
      `${JSON.stringify({ executionId: 'execution-1', messageId: id, commandType: type, phase: 'effect-started' })}\n`
    );
    const callbacks = {
      cancel: vi.fn(async () => undefined),
      switch: vi.fn(() => ({ sessionId: 'must-not-run' })),
      shutdown: vi.fn(async () => 'graceful' as const)
    };
    const run = async () => {
      let release!: () => void;
      const handler: ActionCommand = Object.assign(
        async (_input: ActionInput, context: ActionContext) => {
          context.onCancel(callbacks.cancel);
          context.onSwitchToInteractive(callbacks.switch);
          context.onAgentShutdown(callbacks.shutdown);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        { factoryType: 'action' as const, actionName: 'Test Action' }
      );
      const executing = executeCommand(handler);
      await vi.waitFor(() => expect(runtime.onMessage).toBeTypeOf('function'));
      return { executing, release };
    };
    let unavailable = true;
    runtime.send.mockImplementation(async (message) => {
      if (message.type === 'execution.commandEffectResult' && unavailable) {
        unavailable = false;
        return { status: 'unavailable', messageId: 'not-enqueued' };
      }
      return { status: 'accepted', messageId: 'accepted' };
    });
    const reports = () =>
      runtime.send.mock.calls
        .map(([message]) => message)
        .filter(({ type }) => type === 'execution.commandEffectResult');
    const first = await run();
    await runtime.onMessage?.(incoming);
    expect(await readCommandPhase(id)).toBe('effect-in-doubt');
    const originalReport = reports()[0];
    first.release();
    await first.executing;

    runtime.onMessage = undefined;
    const fresh = await run();
    const replay = runtime.onMessage as ((message: unknown) => Promise<void>) | undefined;
    if (replay === undefined) throw new Error('fresh runtime replay receiver was not installed');
    await replay(incoming);
    expect(reports()).toHaveLength(2);
    expect(reports()[1]).toEqual(originalReport);
    expect(await readCommandPhase(id)).toBe('effect-in-doubt-reported');
    expect(callbacks.cancel).not.toHaveBeenCalled();
    expect(callbacks.switch).not.toHaveBeenCalled();
    expect(callbacks.shutdown).not.toHaveBeenCalled();
    fresh.release();
    await fresh.executing;
  });

  it('advertises switch only after a handler exists and reports its correlated continuation', async () => {
    let release!: () => void;
    const handler = vi.fn(async (_input, context) => {
      context.onSwitchToInteractive(() => ({ sessionId: 'claude-session-1' }));
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
    expect(runtime.options?.capabilities.switchToInteractive).toBe(false);
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'runtime.capabilities',
        payload: expect.objectContaining({ capabilities: expect.objectContaining({ switchToInteractive: true }) })
      })
    );
    await runtime.onMessage?.({
      type: 'execution.switchToInteractiveCommand',
      messageId: 'switch-command-1',
      payload: {}
    });
    expect(runtime.send.mock.calls.map(([message]) => message.type)).toContain('execution.interactiveHandoff');
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execution.interactiveHandoff',
        causationId: 'switch-command-1',
        payload: { continuation: { kind: 'inline', value: '{"sessionId":"claude-session-1"}' } }
      })
    );
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.SWITCH_TO_INTERACTIVE);
    release();
    await executing;
  });
});

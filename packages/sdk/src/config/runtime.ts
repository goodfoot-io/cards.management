/**
 * Runtime orchestration for compiled Cards action handlers.
 *
 * This module is bundled into compiled handlers by the CLI. It provides the
 * execution harness that reads handler input from environment variables, sets
 * up the logger context, invokes the user's handler, and exits the process
 * with the appropriate code.
 *
 * The runtime is designed to never return in normal use. All code paths
 * terminate with `process.exit()`. The only exception is test scenarios
 * where `process.exit` is mocked.
 *
 * ## Execution Flow
 *
 * 1. Extract input payload from environment variables based on command type
 * 2. Set logger context with command type and input
 * 3. Connect to the authenticated durable runtime (fail-closed)
 * 4. Build ActionContext with logger, cwd, and durable command callbacks
 * 5. Invoke the command with input and context
 * 6. On success: close the authenticated runtime connection and exit with code 0
 * 7. On error: log error, write to stderr, close the connection, and exit with code 1
 *
 *
 * @summary Runtime orchestration for compiled Cards action handlers
 * @module
 * @see {@link executeCommand} for the main entry point
 *
 * @example
 * ```typescript
 * // This is what compiled handlers look like internally
 * import { executeCommand } from '@cards.management/sdk/config/runtime';
 * import myCommand from './my-command.js';
 *
 * executeCommand(myCommand);
 * ```
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';
import { createCardsClient, discoverApiInfo } from '../client/api-discovery.js';
import {
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential,
  type RuntimeClient
} from '../client/runtime/index.js';
import { createFileClientOutbox, resolveOutboxRoot } from '../client/runtime/outbox/index.js';
import type { RuntimeEnvelope, RuntimePayload } from '../protocol/index.js';
import { commandReportPayloadSchema } from '../protocol/types/runtime-messages.js';
import type { ActionCommand, CardsAssistantCommand, WorktreeMaintenanceCommand } from './command-types.js';
import { extractActionInput, extractCardsAssistantInput, extractWorktreeMaintenanceInput } from './env.js';
import { EXIT_CODES, writeError } from './exit-codes.js';
import type {
  ActionContext,
  ActionInput,
  CardsAssistantContext,
  CardsAssistantInput,
  WorktreeMaintenanceContext,
  WorktreeMaintenanceInput
} from './inputs.js';
import { Logger } from './logger.js';
import {
  configureShutdown,
  installShutdownSignalHandlers,
  registerShutdownHook,
  shutdownAndExit
} from './runtime-shutdown.js';

/**
 * Logger for the handler runtime process.
 *
 * Constructed with the `cards-default-configuration-hooks` subsystem so that,
 * absent an explicit `CARDS_HOOKS_LOG_FILE`/`CARDS_LOG_DIR` override, file
 * output resolves to the computed `<mainRepoRoot>/.cards/logs/
 * cards-default-configuration-hooks.log` default. The platform no longer
 * injects a default `CARDS_HOOKS_LOG_FILE`, so the subsystem is what keeps this
 * subsystem's logs from going dark.
 */
export const logger = new Logger({ subsystem: 'cards-default-configuration-hooks' });

// ============================================================================
// Command Type Union
// ============================================================================

/**
 * Union of all command types supported by the runtime.
 *
 * This type union allows {@link executeCommand} to accept any command returned by
 * the factory functions. The runtime dispatches based on the `factoryType`
 * discriminant.
 *
 * @internal
 */
type AnyCommand = ActionCommand | CardsAssistantCommand | WorktreeMaintenanceCommand;

type AgentCommandType = 'execution.cancelCommand' | 'execution.switchToInteractiveCommand';
type AgentCommandPhase =
  | 'claimed'
  | 'effect-started'
  | 'effect-observed'
  | 'effect-in-doubt'
  | 'effect-in-doubt-reported';

interface AgentCommandProgress {
  commandType: AgentCommandType;
  phase: AgentCommandPhase;
  observedAt?: string;
}

/**
 * Writes owner-only local evidence that fences duplicate agent command effects.
 * @param executionId - Stable execution scope.
 * @param messageId - Stable inbound command identity.
 * @param commandType - Received command kind whose effect is being tracked.
 * @param phase - Latest durably observed effect phase.
 * @param observedAt - Stable first-observation time retained across result replay.
 */
async function recordAgentCommandPhase(
  executionId: string,
  messageId: string,
  commandType: AgentCommandType,
  phase: AgentCommandPhase,
  observedAt?: string
): Promise<void> {
  const root = path.join(resolveGlobalCardsConfigDir(), 'runtime', 'agent-handler-commands', executionId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${createHash('sha256').update(messageId).digest('hex')}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ executionId, messageId, commandType, phase, observedAt })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/**
 * Reads durable command progress; corrupt or unverifiable evidence fails closed.
 * @param executionId - Stable execution scope.
 * @param messageId - Stable inbound command identity.
 * @returns The recorded phase, or null when this command is new.
 */
async function readAgentCommandProgress(executionId: string, messageId: string): Promise<AgentCommandProgress | null> {
  const file = path.join(
    resolveGlobalCardsConfigDir(),
    'runtime',
    'agent-handler-commands',
    executionId,
    `${createHash('sha256').update(messageId).digest('hex')}.json`
  );
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (value['executionId'] !== executionId || value['messageId'] !== messageId)
      throw new Error('Agent command journal identity mismatch');
    if (
      value['commandType'] !== 'execution.cancelCommand' &&
      value['commandType'] !== 'execution.switchToInteractiveCommand'
    )
      throw new Error('Agent command journal type is invalid');
    if (
      value['phase'] !== 'claimed' &&
      value['phase'] !== 'effect-started' &&
      value['phase'] !== 'effect-observed' &&
      value['phase'] !== 'effect-in-doubt' &&
      value['phase'] !== 'effect-in-doubt-reported'
    )
      throw new Error('Agent command journal phase is invalid');
    if (value['observedAt'] !== undefined && typeof value['observedAt'] !== 'string')
      throw new Error('Agent command journal observation time is invalid');
    return { commandType: value['commandType'], phase: value['phase'], observedAt: value['observedAt'] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalizes an unknown error value into a human-readable message.
 *
 * Errors in JavaScript can be thrown with any value. This function ensures
 * we always get a string message regardless of what was thrown.
 *
 * @param error - The caught error value, which may or may not be an Error instance
 * @returns A string message suitable for logging or display
 *
 * @internal
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handles errors during environment variable extraction.
 *
 * Environment extraction can fail if required variables are missing or
 * malformed. This provides user-friendly error output and ensures proper
 * cleanup before exit.
 *
 * @param error - The error thrown during extraction
 * @returns Settles only when `process.exit` is mocked
 *
 * @internal
 */
function handleEnvExtractionError(error: unknown): Promise<never> {
  const message = getErrorMessage(error);
  logger.error(`Failed to extract input from environment: ${message}`);
  writeError(`Handler failed: ${message}`);
  return shutdownAndExit(EXIT_CODES.ERROR, 'failed');
}

/**
 * Handles errors thrown by the user's command handler.
 *
 * When a handler throws or rejects, we want to provide useful debugging
 * information. This writes the full stack trace to stderr (which the
 * execution wrapper captures) and logs a structured error event.
 *
 * @param error - The error thrown or rejection reason from the handler
 * @returns Settles only when `process.exit` is mocked
 *
 * @internal
 */
function handleHandlerError(error: unknown): Promise<never> {
  const errorOutput = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${errorOutput}\n`);
  logger.error(`Handler error: ${getErrorMessage(error)}`);
  return shutdownAndExit(EXIT_CODES.ERROR, 'failed');
}

// ============================================================================
// Execute Function
// ============================================================================

/**
 * Executes a command handler with full runtime orchestration.
 *
 * This is the main entry point that compiled handlers use. The CLI generates
 * wrapper code that imports the user's command and passes it to this function.
 * From there, executeCommand handles all the ceremony: environment parsing, logging
 * setup, handler invocation, error handling, and process termination.
 *
 * The function exits the process in all normal code paths. The returned
 * promise only resolves if `process.exit` is mocked, which happens in test
 * scenarios. Production code should not await this function or expect it
 * to return.
 *
 * ## Error Handling
 *
 * Errors are handled at three levels:
 *
 * 1. **Environment extraction errors** (missing/invalid variables): Log the
 *    error and exit. These indicate a problem with how the handler was invoked.
 *
 * 2. **Handler errors** (user code throws): Write the stack trace to stderr,
 *    log a structured error, and exit. The execution wrapper captures stderr
 *    for debugging.
 *
 * 3. **Unexpected errors**: Catch-all for any other failures during runtime
 *    orchestration.
 *
 * @param command - The command to execute, returned from a factory function
 * @returns A promise that resolves only when `process.exit` is mocked (tests)
 *
 * @example
 * ```typescript
 * // Generated wrapper code (produced by CLI)
 * import { executeCommand } from '@cards.management/sdk/config/runtime';
 * import command from './user-command.js';
 *
 * // This call never returns in production
 * executeCommand(command);
 * ```
 */
export async function executeCommand(command: AnyCommand): Promise<void> {
  // Let the child CLI settle after terminal closure before reporting the handler outcome.
  process.on('SIGHUP', () => {});
  configureShutdown({
    onHookError: (error) => logger.error(`Shutdown hook failed: ${getErrorMessage(error)}`),
    finalize: () => {
      logger.clearContext();
      logger.close();
    }
  });
  installShutdownSignalHandlers();

  try {
    // Dispatch on factoryType BEFORE env extraction. Cards-assistant commands
    // run without CARD_ID, ACTION_NAME, etc., so extractActionInput() would
    // throw if called unconditionally.
    if (command.factoryType === 'cards-assistant') {
      let input: CardsAssistantInput;

      try {
        input = extractCardsAssistantInput();
      } catch (error) {
        return handleEnvExtractionError(error);
      }

      logger.setContext(command.factoryType, {});

      const context: CardsAssistantContext = { logger, cwd: process.cwd() };

      try {
        await command(input, context);
      } catch (error) {
        return handleHandlerError(error);
      }

      return shutdownAndExit(EXIT_CODES.SUCCESS, 'completed');
    } else if (command.factoryType === 'worktree-maintenance') {
      return executeRootCommand(command);
    } else {
      // Existing action path
      let input: ActionInput;

      try {
        input = extractActionInput();
      } catch (error) {
        return handleEnvExtractionError(error);
      }

      // Set logger context with command type
      logger.setContext(command.factoryType, { ...input });

      // Callback registration state
      let cancelCallback: (() => void | Promise<void>) | undefined;
      let switchToInteractiveCallback: (() => unknown | Promise<unknown>) | undefined;
      let commandProcessed = false;
      const commandEffects = new Map<string, Promise<void>>();
      let runtimeClient: RuntimeClient;
      const loaded = loadRuntimeCredential('agent-handler');
      if (input.executionId !== loaded.execution.executionId) {
        throw new Error('Action execution identity does not match its runtime credential');
      }
      const sendDurable = async <
        T extends 'execution.commandCustody' | 'execution.interactiveHandoff' | 'execution.commandEffectResult'
      >(
        type: T,
        payload: RuntimePayload<T>,
        causationId: string
      ): Promise<boolean> => {
        const result = await runtimeClient.send({
          type,
          payload,
          messageId: `${causationId}:agent-handler:${type}`,
          requestId: loaded.credential.requestId,
          causationId,
          execution: loaded.execution,
          deadlineMs: 5_000
        });
        return result.status === 'accepted';
      };

      // Build ActionContext with logger, cwd, and durable-runtime callbacks.
      const context: ActionContext = {
        logger,
        cwd: process.cwd(),
        onShutdown: registerShutdownHook,
        onCancel: (callback) => {
          cancelCallback = callback;
        },
        onSwitchToInteractive: (callback) => {
          switchToInteractiveCallback = callback;
          void runtimeClient?.send({
            type: 'runtime.capabilities',
            payload: {
              revision: 1,
              capabilities: { switchToInteractive: true }
            },
            messageId: `${loaded.execution.executionId}:agent-handler:switch-capability`,
            requestId: loaded.credential.requestId,
            execution: loaded.execution
          });
        }
      };

      runtimeClient = createRuntimeClientFromCredentialFile({
        role: 'agent-handler',
        capabilities: { switchToInteractive: false },
        outbox: createFileClientOutbox({ root: resolveOutboxRoot(resolveGlobalCardsConfigDir()) }),
        discover: async () => {
          const info = await discoverApiInfo();
          return info ? { host: info.host, port: info.port, accessToken: info.accessToken } : null;
        },
        onMessage: async (cmd: RuntimeEnvelope) => {
          // First-wins semantics for user-initiated commands.
          if (commandProcessed) return;

          if (cmd.type !== 'execution.cancelCommand' && cmd.type !== 'execution.switchToInteractiveCommand') return;
          const commandType: AgentCommandType = cmd.type;
          const existingEffect = commandEffects.get(cmd.messageId);
          if (existingEffect) return existingEffect;

          const effect = (async (): Promise<void> => {
            const progress = await readAgentCommandProgress(loaded.execution.executionId, cmd.messageId);
            if (progress?.commandType !== undefined && progress.commandType !== commandType)
              throw new Error('Agent command replay changed command type');
            if (progress?.phase === 'effect-observed' || progress?.phase === 'effect-in-doubt-reported') return;
            if (progress?.phase === 'effect-started' || progress?.phase === 'effect-in-doubt') {
              // Callback effects have no transactional recovery protocol. A
              // restart cannot distinguish "crashed before callback" from
              // "callback completed before persistence", so retrying could
              // duplicate a destructive effect. Preserve that uncertainty as
              // an explicit terminal state instead of pretending completion.
              const observedAt = progress.observedAt ?? new Date().toISOString();
              if (progress.phase === 'effect-started')
                await recordAgentCommandPhase(
                  loaded.execution.executionId,
                  cmd.messageId,
                  commandType,
                  'effect-in-doubt',
                  observedAt
                );
              const controlRequestId = cmd.causationId ?? cmd.requestId;
              if (controlRequestId === null || controlRequestId === undefined)
                throw new Error('Agent command reconciliation lacks its control request identity');
              const accepted = await sendDurable(
                'execution.commandEffectResult',
                {
                  commandMessageId: cmd.messageId,
                  controlRequestId,
                  commandType,
                  disposition: 'in-doubt',
                  observedAt,
                  reason: 'handler-restarted-during-effect'
                },
                cmd.messageId
              );
              if (!accepted) {
                logger.warn(`Agent command in-doubt result remains pending delivery: ${cmd.messageId}`);
                return;
              }
              await recordAgentCommandPhase(
                loaded.execution.executionId,
                cmd.messageId,
                commandType,
                'effect-in-doubt-reported',
                observedAt
              );
              logger.error(`Agent command effect is in doubt after restart: ${cmd.messageId}`);
              return;
            }
            if (progress === null)
              await recordAgentCommandPhase(loaded.execution.executionId, cmd.messageId, commandType, 'claimed');

            // `send` durably forms this obligation in the client outbox before it
            // waits for an ACK. ACK uncertainty must not suppress an effect the
            // handler has already received and claimed locally.
            try {
              await sendDurable('execution.commandCustody', { commandMessageId: cmd.messageId }, cmd.messageId);
            } catch (error) {
              logger.warn(`Command custody ACK uncertain: ${getErrorMessage(error)}`);
            }

            await recordAgentCommandPhase(loaded.execution.executionId, cmd.messageId, commandType, 'effect-started');

            commandProcessed = true;

            if (cmd.type === 'execution.cancelCommand') {
              await handleCancelCommand(cancelCallback, async () => {
                await recordAgentCommandPhase(
                  loaded.execution.executionId,
                  cmd.messageId,
                  commandType,
                  'effect-observed'
                );
              });
            } else if (cmd.type === 'execution.switchToInteractiveCommand') {
              await handleSwitchToInteractiveCommand(
                switchToInteractiveCallback,
                cmd as RuntimeEnvelope<'execution.switchToInteractiveCommand'>,
                sendDurable,
                async () => {
                  await recordAgentCommandPhase(
                    loaded.execution.executionId,
                    cmd.messageId,
                    commandType,
                    'effect-observed'
                  );
                }
              );
            }
          })();
          commandEffects.set(cmd.messageId, effect);
          const releaseEffect = (): void => {
            if (commandEffects.get(cmd.messageId) === effect) commandEffects.delete(cmd.messageId);
          };
          void effect.then(releaseEffect, releaseEffect);
          return effect;
        }
      });
      const connected = await runtimeClient.start();
      if (connected.status !== 'connected') {
        throw new Error(`Authenticated runtime connection ${connected.status}`);
      }

      // Execute the action command handler
      try {
        await command(input, context);
      } catch (error) {
        await runtimeClient.stop();
        return handleHandlerError(error);
      }

      await runtimeClient.stop();
      return shutdownAndExit(EXIT_CODES.SUCCESS, 'completed');
    }
  } catch (error) {
    // Unexpected error - try to clean up and exit
    logger.error(`Unexpected runtime error: ${getErrorMessage(error)}`);
    return shutdownAndExit(EXIT_CODES.ERROR, 'failed');
  }
}

/**
 * Runs a root configuration command: loads the `agent-handler` credential,
 * extracts the command's own input, runs it with a report sink, and sends
 * `execution.commandReport` before exiting through the shutdown path.
 *
 * A root command succeeds only by reporting: a handler that returns without a
 * report, throws, or whose report the server does not accept exits 1 and
 * leaves the caller with no report. Cancellation is the wrapper's signal, which
 * the shutdown signal handlers already turn into an exit.
 *
 * @param command - The root command to execute.
 * @returns Settles only when `process.exit` is mocked.
 * @throws Error when the execution identity disagrees with the credential, the
 *   Cards API cannot be discovered, or the runtime connection fails.
 * @internal
 */
async function executeRootCommand(command: WorktreeMaintenanceCommand): Promise<never> {
  let input: WorktreeMaintenanceInput;
  try {
    input = extractWorktreeMaintenanceInput();
  } catch (error) {
    return handleEnvExtractionError(error);
  }
  logger.setContext(command.factoryType, { ...input });

  const loaded = loadRuntimeCredential('agent-handler');
  if (input.executionId !== loaded.execution.executionId) {
    throw new Error('Root command execution identity does not match its runtime credential');
  }
  const client = await createCardsClient(undefined, { retryOnNetworkError: false });
  if (client === null) throw new Error('Cards API discovery failed');

  const runtimeClient = createRuntimeClientFromCredentialFile({
    role: 'agent-handler',
    capabilities: { switchToInteractive: false },
    outbox: createFileClientOutbox({ root: resolveOutboxRoot(resolveGlobalCardsConfigDir()) }),
    discover: async () => {
      const info = await discoverApiInfo();
      return info ? { host: info.host, port: info.port, accessToken: info.accessToken } : null;
    },
    // A root command registers no cancel or switch callbacks: its cancel is the
    // wrapper's SIGTERM, so no server command needs a handler-side effect.
    onMessage: async () => undefined
  });
  const connected = await runtimeClient.start();
  if (connected.status !== 'connected') {
    await runtimeClient.stop();
    throw new Error(`Authenticated runtime connection ${connected.status}`);
  }

  let report: Record<string, unknown> | undefined;
  const context: WorktreeMaintenanceContext = {
    logger,
    cwd: process.cwd(),
    client,
    report: (candidate) => {
      const parsed = commandReportPayloadSchema.safeParse(candidate);
      if (!parsed.success) throw new Error(`Invalid command report: ${parsed.error.message}`);
      // A JSON copy: later mutation of the caller's object cannot change what is sent.
      report = JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
    },
    onShutdown: registerShutdownHook
  };

  try {
    await command(input, context);
  } catch (error) {
    await runtimeClient.stop();
    return handleHandlerError(error);
  }
  if (report === undefined) {
    await runtimeClient.stop();
    logger.error('Root command finished without a report');
    return shutdownAndExit(EXIT_CODES.ERROR, 'failed');
  }

  const sent = await runtimeClient.send({
    type: 'execution.commandReport',
    payload: report,
    messageId: `${loaded.execution.executionId}:agent-handler:execution.commandReport`,
    requestId: loaded.credential.requestId,
    execution: loaded.execution,
    deadlineMs: 5_000
  });
  await runtimeClient.stop();
  if (sent.status !== 'accepted') {
    logger.error(`Command report was not accepted: ${sent.status}`);
    return shutdownAndExit(EXIT_CODES.ERROR, 'failed');
  }
  return shutdownAndExit(EXIT_CODES.SUCCESS, 'completed');
}

// ============================================================================
// Authenticated Runtime Command Handlers
// ============================================================================

/**
 * Resolves a callback result that may be sync or async into a Promise.
 *
 * User-registered callbacks may return void, a value, or a Promise.
 * This normalizes all cases into a single Promise for consistent handling.
 *
 * @param result - Callback return value that may already be a promise.
 * @returns Promise resolving to the callback result.
 * @internal
 */
function toPromise<T>(result: T | Promise<T>): Promise<T> {
  if (result && typeof (result as Promise<T>).then === 'function') {
    return result as Promise<T>;
  }
  return Promise.resolve(result);
}

/**
 * Handles an authenticated durable cancel command.
 *
 * If a cancel callback was registered, it is invoked, and after it completes
 * the process exits successfully through the shutdown hooks — the
 * user-initiated stop is an expected shutdown, not a handler error. Exiting
 * with `EXIT_CODES.ERROR` here propagates through the wrapper as a non-zero
 * exit, which the VS Code terminal surfaces as `terminated with exit code: 1`
 * even though nothing actually failed.
 *
 * Callback rejections are reported via the logger but still resolve to a
 * successful exit — once cancellation has been requested the runtime's job
 * is to wind down promptly, not to escalate cleanup failures.
 *
 * Without a callback the handler shuts down with `128 + SIGTERM`, the code the
 * installed `SIGTERM` handler would exit with, so cancellation ends it exactly
 * as the wrapper's own stop signal does.
 *
 * @param callback - The registered cancel callback, if any
 * @param recordObserved - Persists terminal evidence before process termination.
 * @returns Settles only when `process.exit` is mocked.
 * @internal
 */
async function handleCancelCommand(
  callback: (() => void | Promise<void>) | undefined,
  recordObserved: () => Promise<void>
): Promise<void> {
  if (!callback) {
    await recordObserved();
    // Without a callback, cancellation ends the handler as the wrapper's SIGTERM would.
    return shutdownAndExit(128 + osConstants.signals.SIGTERM, 'cancel');
  }

  try {
    // Contain synchronous callback failures inside the lifecycle handler.
    await toPromise(callback());
  } catch (error) {
    logger.error(`onCancel callback error: ${getErrorMessage(error)}`);
  }
  await recordObserved();
  return shutdownAndExit(EXIT_CODES.SUCCESS, 'cancel');
}

/**
 * Handles an authenticated durable switch-to-interactive command.
 *
 * If no callback was registered, the command is ignored. Otherwise, the
 * callback's continuation is durably accepted before the process exits.
 *
 * @param callback - The registered switchToInteractive callback, if any
 * @param command - Correlated switch command whose identity fences the handoff.
 * @param sendDurable - Authenticated sender for the continuation result.
 * @param recordObserved - Persists terminal evidence before process termination.
 * @returns Resolves at once when no callback was registered; otherwise settles only when `process.exit` is mocked.
 * @internal
 */
async function handleSwitchToInteractiveCommand(
  callback: (() => unknown | Promise<unknown>) | undefined,
  command: RuntimeEnvelope<'execution.switchToInteractiveCommand'>,
  sendDurable: <T extends 'execution.commandCustody' | 'execution.interactiveHandoff'>(
    type: T,
    payload: RuntimePayload<T>,
    causationId: string
  ) => Promise<boolean>,
  recordObserved: () => Promise<void>
): Promise<void> {
  if (!callback) {
    await recordObserved();
    return;
  }

  try {
    // Contain synchronous callback failures inside the lifecycle handler.
    const continuation = await toPromise(callback());
    const accepted = await sendDurable(
      'execution.interactiveHandoff',
      { launchProtocol: 2, continuation: { kind: 'inline', value: JSON.stringify(continuation) } },
      command.messageId
    );
    await recordObserved();
    return accepted
      ? shutdownAndExit(EXIT_CODES.SWITCH_TO_INTERACTIVE, 'switch')
      : shutdownAndExit(EXIT_CODES.ERROR, 'failed');
  } catch (error) {
    logger.error(`switchToInteractive callback error: ${getErrorMessage(error)}`);
    await recordObserved();
    return shutdownAndExit(EXIT_CODES.ERROR, 'failed');
  }
}

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
import path from 'node:path';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';
import { discoverApiInfo } from '../client/api-discovery.js';
import {
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential,
  type RuntimeClient
} from '../client/runtime/index.js';
import { createFileClientOutbox, resolveOutboxRoot } from '../client/runtime/outbox/index.js';
import type { RuntimeEnvelope, RuntimePayload } from '../protocol/index.js';
import type { ActionCommand, CardsAssistantCommand } from './command-types.js';
import { extractActionInput, extractCardsAssistantInput } from './env.js';
import { EXIT_CODES, writeError } from './exit-codes.js';
import type {
  ActionContext,
  ActionInput,
  AgentTerminationResult,
  CardsAssistantContext,
  CardsAssistantInput
} from './inputs.js';
import { Logger } from './logger.js';

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
type AnyCommand = ActionCommand | CardsAssistantCommand;

type AgentCommandType =
  | 'execution.cancelCommand'
  | 'execution.switchToInteractiveCommand'
  | 'execution.agentShutdownCommand';
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
      value['commandType'] !== 'execution.switchToInteractiveCommand' &&
      value['commandType'] !== 'execution.agentShutdownCommand'
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
 * Cleans up logger state and terminates the process.
 *
 * This function never returns. It clears the logger's context, closes
 * open file handles to flush pending writes, and exits with the specified
 * code.
 *
 * @param exitCode - The exit code to pass to `process.exit()`
 * @returns Never returns; process terminates
 *
 * @internal
 */
function cleanupAndExit(exitCode: number): never {
  logger.clearContext();
  logger.close();
  process.exit(exitCode);
}

/**
 * Handles errors during environment variable extraction.
 *
 * Environment extraction can fail if required variables are missing or
 * malformed. This provides user-friendly error output and ensures proper
 * cleanup before exit.
 *
 * @param error - The error thrown during extraction
 * @returns Never returns; process terminates with error code
 *
 * @internal
 */
function handleEnvExtractionError(error: unknown): never {
  const message = getErrorMessage(error);
  logger.error(`Failed to extract input from environment: ${message}`);
  writeError(`Handler failed: ${message}`);
  cleanupAndExit(EXIT_CODES.ERROR);
}

/**
 * Handles errors thrown by the user's command handler.
 *
 * When a handler throws or rejects, we want to provide useful debugging
 * information. This writes the full stack trace to stderr (which the
 * execution wrapper captures) and logs a structured error event.
 *
 * @param error - The error thrown or rejection reason from the handler
 * @returns Never returns; process terminates with error code
 *
 * @internal
 */
function handleHandlerError(error: unknown): never {
  const errorOutput = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${errorOutput}\n`);
  logger.error(`Handler error: ${getErrorMessage(error)}`);
  cleanupAndExit(EXIT_CODES.ERROR);
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
  // Prevent SIGHUP from killing the action handler before post-exit cleanup
  // (e.g. spawnBranchCleanupWatcher) can run. When a VSCode terminal closes,
  // node-pty sends SIGHUP to the process group. Without this handler, Node.js
  // terminates immediately and any post-exit code after the awaited child
  // process never executes. The handler is a no-op: the child process (e.g.
  // claude CLI) will receive SIGHUP independently, exit, and the awaiting
  // code will resume to run post-exit cleanup.
  process.on('SIGHUP', () => {});

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

      cleanupAndExit(EXIT_CODES.SUCCESS);
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
      let agentShutdownCallback:
        | (() => AgentTerminationResult | undefined | Promise<AgentTerminationResult | undefined>)
        | undefined;
      let commandProcessed = false;
      let agentShutdownProcessed = false;
      const commandEffects = new Map<string, Promise<void>>();
      let runtimeClient: RuntimeClient;
      const loaded = loadRuntimeCredential('agent-handler');
      const sendDurable = async <
        T extends
          | 'execution.commandCustody'
          | 'execution.agentTermination'
          | 'execution.interactiveHandoff'
          | 'execution.commandEffectResult'
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
        onCancel: (callback) => {
          cancelCallback = callback;
        },
        onSwitchToInteractive: (callback) => {
          switchToInteractiveCallback = callback;
          void runtimeClient?.send({
            type: 'runtime.capabilities',
            payload: {
              revision: 1,
              capabilities: { switchToInteractive: true, agentShutdown: true, strictDrainBarrier: true }
            },
            messageId: `${loaded.execution.executionId}:agent-handler:switch-capability`,
            requestId: loaded.credential.requestId,
            execution: loaded.execution
          });
        },
        onAgentShutdown: (callback) => {
          agentShutdownCallback = callback;
        }
      };

      runtimeClient = createRuntimeClientFromCredentialFile({
        role: 'agent-handler',
        capabilities: { switchToInteractive: false, agentShutdown: true, strictDrainBarrier: true },
        outbox: createFileClientOutbox({ root: resolveOutboxRoot(resolveGlobalCardsConfigDir()) }),
        discover: async () => {
          const info = await discoverApiInfo();
          return info ? { host: info.host, port: info.port, accessToken: info.accessToken } : null;
        },
        onMessage: async (cmd: RuntimeEnvelope) => {
          // First-wins semantics for user-initiated commands; agentShutdown is
          // deduplicated independently so a later cancel still lands after it.
          if (commandProcessed) return;

          if (
            cmd.type !== 'execution.cancelCommand' &&
            cmd.type !== 'execution.switchToInteractiveCommand' &&
            cmd.type !== 'execution.agentShutdownCommand'
          )
            return;
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
              await sendDurable(
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

            if (cmd.type === 'execution.agentShutdownCommand') {
              if (agentShutdownProcessed) return;
              agentShutdownProcessed = true;
              await handleAgentShutdownCommand(
                agentShutdownCallback,
                cmd as RuntimeEnvelope<'execution.agentShutdownCommand'>,
                sendDurable
              );
              await recordAgentCommandPhase(
                loaded.execution.executionId,
                cmd.messageId,
                commandType,
                'effect-observed'
              );
              return;
            }

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
      cleanupAndExit(EXIT_CODES.SUCCESS);
    }
  } catch (error) {
    // Unexpected error - try to clean up and exit
    logger.error(`Unexpected runtime error: ${getErrorMessage(error)}`);
    cleanupAndExit(EXIT_CODES.ERROR);
  }
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
 * If a cancel callback was registered, it is invoked. Otherwise, SIGTERM
 * is sent to the current process as a fallback. After the callback completes
 * (or immediately if no callback), the process exits successfully — the
 * user-initiated stop is an expected shutdown, not a handler error. Exiting
 * with `EXIT_CODES.ERROR` here propagates through the wrapper as a non-zero
 * exit, which the VS Code terminal surfaces as `terminated with exit code: 1`
 * even though nothing actually failed.
 *
 * Callback rejections are reported via the logger but still resolve to a
 * successful exit — once cancellation has been requested the runtime's job
 * is to wind down promptly, not to escalate cleanup failures.
 *
 * @param callback - The registered cancel callback, if any
 * @param recordObserved - Persists terminal evidence before process termination.
 * @internal
 */
async function handleCancelCommand(
  callback: (() => void | Promise<void>) | undefined,
  recordObserved: () => Promise<void>
): Promise<void> {
  if (!callback) {
    await recordObserved();
    process.kill(process.pid, 'SIGTERM');
    return;
  }

  try {
    // Contain synchronous callback failures inside the lifecycle handler.
    await toPromise(callback());
  } catch (error) {
    logger.error(`onCancel callback error: ${getErrorMessage(error)}`);
  }
  await recordObserved();
  cleanupAndExit(EXIT_CODES.SUCCESS);
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
      { continuation: { kind: 'inline', value: JSON.stringify(continuation) } },
      command.messageId
    );
    await recordObserved();
    cleanupAndExit(accepted ? EXIT_CODES.SWITCH_TO_INTERACTIVE : EXIT_CODES.ERROR);
  } catch (error) {
    logger.error(`switchToInteractive callback error: ${getErrorMessage(error)}`);
    await recordObserved();
    cleanupAndExit(EXIT_CODES.ERROR);
  }
}

/**
 * Handles an authenticated durable agent-shutdown command.
 *
 * Invokes the registered `onAgentShutdown` callback — typically terminating
 * the agent CLI gracefully so the normal post-exit cascade proceeds — and
 * returns. Unlike {@link handleCancelCommand}, this handler never exits the
 * process and has no SIGTERM fallback: responding to a shutdown request is
 * entirely the callbacks' job, and with no callback registered the command
 * is a no-op. Callback rejections are reported via the logger only.
 *
 * @param callback - The registered agentShutdown callback, if any
 * @param command - Correlated shutdown command from the runtime.
 * @param sendDurable - Authenticated durable-result sender.
 * @returns Completion after the callback and any terminal result are settled.
 *
 * @internal
 */
function handleAgentShutdownCommand(
  callback: (() => AgentTerminationResult | undefined | Promise<AgentTerminationResult | undefined>) | undefined,
  command: RuntimeEnvelope<'execution.agentShutdownCommand'>,
  sendDurable: <T extends 'execution.commandCustody' | 'execution.agentTermination'>(
    type: T,
    payload: RuntimePayload<T>,
    causationId: string
  ) => Promise<boolean>
): Promise<void> {
  if (!callback) {
    return Promise.resolve();
  }

  try {
    // Contain synchronous callback failures inside the lifecycle handler.
    return toPromise(callback()).then(
      async (result) => {
        if (result !== undefined) {
          await sendDurable(
            'execution.agentTermination',
            {
              shutdownRequestId: command.payload.shutdownRequestId,
              commandMessageId: command.messageId,
              result
            },
            command.messageId
          );
        }
      },
      (error) => {
        logger.error(`onAgentShutdown callback error: ${getErrorMessage(error)}`);
      }
    );
  } catch (error) {
    logger.error(`onAgentShutdown callback error: ${getErrorMessage(error)}`);
    return Promise.resolve();
  }
}

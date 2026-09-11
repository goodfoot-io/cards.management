/**
 * Handler bodies for the Antigravity `runtime` hooks, wrapped around the
 * shared Cards runtime behaviors.
 *
 * Each handler maps one Antigravity host event to the shared internals the
 * existing hosts already use — action-env extraction, session registration,
 * reconciliation, watcher setup, the idle/route/merge/shutdown decision, and
 * process/session drain — under the Antigravity host contract's failure
 * policy: contract violations write a conversation-scoped failure marker and
 * never guess a continuation.
 *
 * Handlers receive the raw stdin JSON and a {@link HandlerContext}; they
 * either return a result carrying the pinned stdout payload or throw
 * {@link HandlerFailure}, which the transport turns into the failure marker.
 *
 * @summary Antigravity runtime handler bodies
 * @module internal/handlers
 */

import { join } from 'node:path';
import type { ActionInput, PendingShutdownRequest } from '@cards.management/sdk/config';
import { getBaseBranch, getWorkspaceBranch, getWorkspacePath } from '@cards.management/sdk/config';
import type { SessionSyncManifest } from '@cards.management/sdk/transcript-sync';
import type { Logger } from '@goodfoot/agent-hooks';
import { buildAdditionalContext } from '../../shared/context.js';
import { ANTIGRAVITY_STREAM_TYPE, type AntigravityCardMeta, type AntigravityHandlerDeps } from './deps.js';
import {
  type AntigravityInvocationInput,
  CARDS_ASSISTANT_WINDOW_ID_ENV_VAR,
  classifyCardsManagedSession,
  isCardsActionSession,
  parseCommonInput,
  parseInvocationInput,
  peekConversationId
} from './inputs.js';
import { postInvocationOutput, preInvocationOutput, stopOutput } from './outputs.js';

/**
 * The contract stage a {@link HandlerFailure} occurred at, recorded in the
 * failure marker's payload.
 */
export type HandlerFailureStage =
  | 'input'
  | 'session-identity'
  | 'action-env'
  | 'card-context'
  | 'session-registration'
  | 'session-cleanup'
  | 'watcher-setup'
  | 'decision'
  | 'drain-ack'
  | 'unexpected';

/**
 * The fail-closed signal a handler raises instead of guessing a
 * continuation. The transport writes the conversation-scoped failure marker
 * from this error's fields.
 */
export class HandlerFailure extends Error {
  override readonly name = 'HandlerFailure';

  constructor(
    /** Contract stage the failure occurred at. */
    public readonly stage: HandlerFailureStage,
    /** Human-readable reason the launcher surfaces. */
    public readonly reason: string,
    /** Conversation id the failure marker is scoped to, when the input carried one. */
    public readonly conversationId: string | null
  ) {
    super(`[${stage}] ${reason}`);
  }
}

/** The value a handler hands back to the transport. */
export interface AntigravityHandlerResult {
  /** JSON value written to stdout; `undefined` writes nothing. */
  output?: unknown;
}

/**
 * Registers a workspace/window Assistant invocation without entering any
 * card-action routing or settlement path.
 *
 * Registration is the whole contract: the session identity the launcher
 * exported pre-spawn is bound to its conversation and workspace so
 * `cards create`/`attach` and transcript resolution can find it. Nothing is
 * published back to the launcher — an Assistant launch is not gated on hook
 * evidence, and the only marker this path can produce is the shared failure
 * marker the transport writes when the contract is violated.
 *
 * @param raw - Raw pinned PreInvocation input.
 * @param ctx - Handler dependencies and logger.
 * @returns The standard no-message PreInvocation response.
 * @throws {HandlerFailure} When identity or registration fails.
 */
export async function handleCardsAssistantPreInvocation(
  raw: unknown,
  ctx: HandlerContext
): Promise<AntigravityHandlerResult> {
  const { deps, logger } = ctx;
  const input = parseInvocationOrThrow(raw);
  const sessionId = requireSessionId(deps, input.conversationId);
  const windowId = (process.env[CARDS_ASSISTANT_WINDOW_ID_ENV_VAR] ?? '').trim();
  if (windowId.length === 0) {
    throw new HandlerFailure(
      'session-identity',
      `${CARDS_ASSISTANT_WINDOW_ID_ENV_VAR} is not set: the launcher must export the owning window identity`,
      input.conversationId
    );
  }

  const workspacePath = input.workspacePaths[0] as string;
  const transcriptPath = deps.conversationDbPath(input.conversationId);
  try {
    await deps.registerSession(sessionId, workspacePath, transcriptPath);
  } catch (error) {
    throw new HandlerFailure(
      'session-registration',
      error instanceof Error ? error.message : String(error),
      input.conversationId
    );
  }

  logger.info('Antigravity Cards Assistant session registered', {
    sessionId,
    windowId,
    conversationId: input.conversationId,
    transcriptPath
  });
  return { output: preInvocationOutput() };
}

/**
 * Flushes and cleans a workspace/window Assistant session without card
 * shutdown acknowledgement, branch cleanup, or settlement.
 *
 * @param raw - Raw pinned Stop input.
 * @param ctx - Handler dependencies and logger.
 * @returns The standard no-decision Stop response.
 * @throws {HandlerFailure} When registration/artifact cleanup fails.
 */
export async function handleCardsAssistantStop(raw: unknown, ctx: HandlerContext): Promise<AntigravityHandlerResult> {
  const { deps, logger } = ctx;
  const input = parseCommonOrThrow(raw);
  const sessionId = requireSessionId(deps, input.conversationId);
  const cleanupErrors: Error[] = [];
  try {
    await deps.cleanupSessionRegistration(sessionId);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    deps.cleanupSessionArtifacts(sessionId);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (cleanupErrors.length > 0) {
    throw new HandlerFailure(
      'session-cleanup',
      new AggregateError(cleanupErrors, `Cards Assistant cleanup had ${cleanupErrors.length} failure(s)`).message,
      input.conversationId
    );
  }

  logger.info('Antigravity Cards Assistant cleanup complete', { sessionId, conversationId: input.conversationId });
  return { output: stopOutput() };
}

/** Dependencies and diagnostics handed to every handler invocation. */
export interface HandlerContext {
  /** Injectable edges; defaults wire the real SDK. */
  deps: AntigravityHandlerDeps;
  /** Structured logger (silent unless a log file is configured). */
  logger: Logger;
}

/**
 * Parses the invocation input, converting validation failures into a
 * fail-closed {@link HandlerFailure} scoped to the best-effort conversation
 * id.
 *
 * @param raw - The raw stdin JSON value.
 * @returns The validated invocation input.
 * @throws {HandlerFailure} At the `input` stage on any validation failure.
 */
function parseInvocationOrThrow(raw: unknown): AntigravityInvocationInput {
  const conversationId = peekConversationId(raw);
  try {
    return parseInvocationInput(raw);
  } catch (error) {
    throw new HandlerFailure('input', error instanceof Error ? error.message : String(error), conversationId);
  }
}

/**
 * Parses the common input, converting validation failures into a
 * fail-closed {@link HandlerFailure} scoped to the best-effort conversation
 * id.
 *
 * @param raw - The raw stdin JSON value.
 * @returns The validated common input.
 * @throws {HandlerFailure} At the `input` stage on any validation failure.
 */
function parseCommonOrThrow(raw: unknown): ReturnType<typeof parseCommonInput> {
  const conversationId = peekConversationId(raw);
  try {
    return parseCommonInput(raw);
  } catch (error) {
    throw new HandlerFailure('input', error instanceof Error ? error.message : String(error), conversationId);
  }
}

/**
 * Resolves the Cards session identity, fail-closed.
 *
 * @param deps - Handler dependencies.
 * @param conversationId - Conversation id for the failure marker scope.
 * @returns The Cards session id.
 * @throws {HandlerFailure} At the `session-identity` stage when the
 *   launcher-exported session id is absent.
 */
function requireSessionId(deps: AntigravityHandlerDeps, conversationId: string | null): string {
  const sessionId = deps.resolveSessionId();
  if (sessionId === null) {
    throw new HandlerFailure(
      'session-identity',
      'ANTIGRAVITY_SESSION_ID is not set: the launcher must export the Cards session id pre-spawn',
      conversationId
    );
  }
  return sessionId;
}

/**
 * Parses the Cards action environment, fail-closed.
 *
 * @param deps - Handler dependencies.
 * @param conversationId - Conversation id for the failure marker scope.
 * @returns The parsed action input.
 * @throws {HandlerFailure} At the `action-env` stage when the action
 *   environment is missing or malformed.
 */
function requireActionInput(deps: AntigravityHandlerDeps, conversationId: string | null): ActionInput {
  const actionInput = deps.loadActionInput();
  if (actionInput === null) {
    throw new HandlerFailure('action-env', 'the Cards action environment is missing or malformed', conversationId);
  }
  return actionInput;
}

/**
 * Builds the every-turn card context, asserting the card repository is
 * readable. The Antigravity launcher prompt carries the context itself; this
 * build is the readiness gate.
 *
 * @param actionInput - Parsed action input.
 * @param conversationId - Conversation id for the failure marker scope.
 * @returns The combined context string.
 * @throws {HandlerFailure} At the `card-context` stage when the card
 *   repository is inaccessible.
 */
function requireCardContext(actionInput: ActionInput, conversationId: string | null): string {
  try {
    return buildAdditionalContext(actionInput);
  } catch (error) {
    throw new HandlerFailure('card-context', error instanceof Error ? error.message : String(error), conversationId);
  }
}

/**
 * `PreInvocation` — session registration, card-context readiness, and
 * watcher setup.
 *
 * Contract: requires `conversationId`, non-empty `workspacePaths`,
 * `transcriptPath`, `artifactDirectoryPath`, `modelName`, `invocationNum`,
 * and `initialNumSteps`; returns no message. Success is the pinned no-message
 * output plus the registered session and spawned watcher — no durable marker
 * proves it, because the launcher's completion policy reads the native exit
 * status. Missing/invalid input, inaccessible card context, or watcher setup
 * failure prevents action success: it writes the failure marker and the
 * launcher terminates the child.
 *
 * @param raw - The raw stdin JSON value.
 * @param ctx - Handler dependencies and logger.
 * @returns The pinned no-message output.
 * @throws {HandlerFailure} On every contract violation.
 */
export async function handlePreInvocation(raw: unknown, ctx: HandlerContext): Promise<AntigravityHandlerResult> {
  const { deps, logger } = ctx;
  const sessionKind = classifyCardsManagedSession();
  if (sessionKind === 'foreign') {
    return { output: preInvocationOutput() };
  }
  if (sessionKind === 'cards-assistant') {
    return handleCardsAssistantPreInvocation(raw, ctx);
  }

  const input = parseInvocationOrThrow(raw);
  const sessionId = requireSessionId(deps, input.conversationId);

  // Best-effort reconciliation of cards left `active` by dead ad-hoc
  // monitors — never blocks session start (Codex session-start parity).
  try {
    await deps.runReconciliationSweep(logger);
  } catch (error) {
    logger.warn('reconciliation sweep failed', { error: error instanceof Error ? error.message : String(error) });
  }

  const actionInput = requireActionInput(deps, input.conversationId);
  requireCardContext(actionInput, input.conversationId);
  const conversationDbPath = deps.conversationDbPath(input.conversationId);

  const agentPid = await deps.findMonitorPid();
  if (agentPid === null) {
    throw new HandlerFailure(
      'watcher-setup',
      'could not identify the agent PID for the stream-sync-watcher',
      input.conversationId
    );
  }

  let manifest: SessionSyncManifest;
  try {
    manifest = deps.buildManifest({
      sessionId,
      cardId: actionInput.cardId,
      transcriptPath: conversationDbPath,
      monitorPid: agentPid,
      cardRepoPath: actionInput.cardRepoPath
    });
  } catch (error) {
    throw new HandlerFailure(
      'watcher-setup',
      `manifest build failed: ${error instanceof Error ? error.message : String(error)}`,
      input.conversationId
    );
  }

  const spawned = deps.spawnWatcher({ manifest, extensionPath: actionInput.extensionPath });
  if (!spawned) {
    throw new HandlerFailure('watcher-setup', 'the stream-sync-watcher did not spawn', input.conversationId);
  }

  // Registration records the canonical conversation DB path — computed from
  // the conversation id even though the DB does not exist yet; the SDK's
  // attach resolution derives the conversation id from the DB basename and
  // the poller waits for the file to appear.
  try {
    await deps.registerSession(sessionId, input.workspacePaths[0] as string, conversationDbPath);
  } catch (error) {
    throw new HandlerFailure(
      'session-registration',
      error instanceof Error ? error.message : String(error),
      input.conversationId
    );
  }

  logger.info('Antigravity session ready', { sessionId, conversationId: input.conversationId });
  return { output: preInvocationOutput() };
}

/**
 * Runs the strict, fail-closed drain authority for the shutdown handshake:
 * no tracked subagents plus a drained owned process tree.
 *
 * @param sessionId - Session to prove drained.
 * @param deps - Handler dependencies.
 * @param conversationId - Conversation id for the failure marker scope.
 * @returns `true` only when both proofs hold.
 * @throws {HandlerFailure} At the `decision` stage when the drain state
 *   cannot be proven.
 */
async function isSessionStrictlyDrained(
  sessionId: string,
  deps: AntigravityHandlerDeps,
  conversationId: string | null
): Promise<boolean> {
  let subagentCount: number;
  try {
    subagentCount = deps.sessionMarkers.getActiveSubagentCount(sessionId);
  } catch (error) {
    throw new HandlerFailure(
      'decision',
      `could not read subagent tracking: ${error instanceof Error ? error.message : String(error)}`,
      conversationId
    );
  }
  if (subagentCount !== 0) {
    return false;
  }
  const agentPid = await deps.findMonitorPid();
  if (agentPid === null) {
    throw new HandlerFailure('decision', 'could not identify the agent PID for the drain proof', conversationId);
  }
  let drained: boolean | null;
  try {
    drained = await deps.isAgentProcessTreeDrained(agentPid);
  } catch (error) {
    throw new HandlerFailure(
      'decision',
      `drain proof failed: ${error instanceof Error ? error.message : String(error)}`,
      conversationId
    );
  }
  if (drained === null) {
    throw new HandlerFailure('decision', 'the process tree drain state could not be proven', conversationId);
  }
  return drained;
}

/**
 * Reads CARD.meta.json for the route decision.
 *
 * @param deps - Handler dependencies.
 * @param cardRepoPath - Absolute card repository path.
 * @param conversationId - Conversation id for the failure marker scope.
 * @returns The parsed metadata.
 * @throws {HandlerFailure} At the `decision` stage when the metadata cannot
 *   be read.
 */
function requireCardMeta(
  deps: AntigravityHandlerDeps,
  cardRepoPath: string,
  conversationId: string | null
): AntigravityCardMeta {
  try {
    return deps.readCardMeta(cardRepoPath);
  } catch (error) {
    throw new HandlerFailure(
      'decision',
      `failed to read CARD.meta.json: ${error instanceof Error ? error.message : String(error)}`,
      conversationId
    );
  }
}

/**
 * Counts the workspace branch's unmerged commits.
 *
 * @param deps - Handler dependencies.
 * @param conversationId - Conversation id for the failure marker scope.
 * @returns The unmerged commit count with the branch names it was computed
 *   against.
 * @throws {HandlerFailure} At the `decision` stage when the count fails.
 */
function requireUnmergedCommitCount(
  deps: AntigravityHandlerDeps,
  conversationId: string | null
): {
  count: number;
  baseBranch: string;
  workspaceBranch: string;
  workspacePath: string;
} {
  let workspacePath: string;
  let baseBranch: string;
  let workspaceBranch: string;
  try {
    workspacePath = getWorkspacePath();
    baseBranch = getBaseBranch();
    workspaceBranch = getWorkspaceBranch();
  } catch (error) {
    throw new HandlerFailure(
      'decision',
      `workspace environment incomplete: ${error instanceof Error ? error.message : String(error)}`,
      conversationId
    );
  }
  try {
    return {
      count: deps.unmergedCommitCount(workspacePath, baseBranch, workspaceBranch),
      baseBranch,
      workspaceBranch,
      workspacePath
    };
  } catch (error) {
    throw new HandlerFailure(
      'decision',
      `git rev-list failed: ${error instanceof Error ? error.message : String(error)}`,
      conversationId
    );
  }
}

/**
 * `PostInvocation` — the shared idle/route/merge/shutdown decision with
 * Antigravity-native skill addresses.
 *
 * Contract: requires the invocation input fields; returns
 * `postInvocationOutput({ injectSteps: [{ ephemeralMessage }] })` only when
 * another model step is required. Decision errors write a failure marker and
 * inject no guessed route. A route is emitted at most once per state
 * transition, guarded by the shared once-per-session store
 * (`hasRouteNudgeFired`/`markRouteNudgeFired`); the injected step is the
 * route's whole record, and an idle turn writes nothing durable.
 *
 * @param raw - The raw stdin JSON value.
 * @param ctx - Handler dependencies and logger.
 * @returns The pinned step-injection output, or no output when idle.
 * @throws {HandlerFailure} On every contract violation.
 */
export async function handlePostInvocation(raw: unknown, ctx: HandlerContext): Promise<AntigravityHandlerResult> {
  const { deps, logger } = ctx;
  if (!isCardsActionSession()) {
    return { output: postInvocationOutput() };
  }

  const input = parseInvocationOrThrow(raw);
  const sessionId = requireSessionId(deps, input.conversationId);
  const actionInput = requireActionInput(deps, input.conversationId);

  try {
    // 1. Pending-shutdown handshake: a `cards shutdown` request always wins —
    // after acknowledgement the next step is termination, not more routing.
    const pendingRequest = deps.readPendingShutdownRequest(sessionId);
    if (pendingRequest !== undefined) {
      const drained = await isSessionStrictlyDrained(sessionId, deps, input.conversationId);
      if (drained) {
        await deps.sendShutdownReady(pendingRequest.socketPath, {
          type: 'shutdownReady',
          requestId: pendingRequest.requestId
        });
        deps.clearPendingShutdownRequest(sessionId, pendingRequest.requestId);
        logger.info('Acknowledged shutdown readiness', { sessionId });
      }
      return { output: postInvocationOutput() };
    }

    // 2. Merge route: the workspace branch has commits to merge, the card is
    // not blocked, and merge is ungated or already approved. At most once
    // per session via the shared route marker.
    let mergeDecision: { count: number; baseBranch: string; workspaceBranch: string } | null = null;
    if (!deps.sessionMarkers.hasRouteNudgeFired(sessionId)) {
      const meta = requireCardMeta(deps, actionInput.cardRepoPath, input.conversationId);
      const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
      const mergeRequestRequired = meta.gates?.mergeRequestRequired === true;
      const mergeApproved = meta.gates?.mergeApproved === true;
      const mergeGateOpen = !mergeRequestRequired || mergeApproved;
      const mergeable =
        deps.sessionMarkers.getActiveSubagentCount(sessionId) === 0 && !tags.includes('blocked') && mergeGateOpen;
      if (mergeable) {
        const unmerged = requireUnmergedCommitCount(deps, input.conversationId);
        if (unmerged.count > 0) {
          mergeDecision = {
            count: unmerged.count,
            baseBranch: unmerged.baseBranch,
            workspaceBranch: unmerged.workspaceBranch
          };
        }
      }
    }

    if (mergeDecision !== null) {
      deps.sessionMarkers.markRouteNudgeFired(sessionId);
      logger.info('Injecting merge route', { sessionId, count: mergeDecision.count });
      return {
        output: postInvocationOutput({
          injectSteps: [
            {
              ephemeralMessage: [
                `Workspace branch \`${mergeDecision.workspaceBranch}\` has ${mergeDecision.count} commit(s) not merged into \`${mergeDecision.baseBranch}\`.`,
                'If validation and evaluation have passed and no scope remains, read',
                `${deps.mergeRunbookPath()} and follow its <instructions> to merge.`,
                'Otherwise load the `card` skill and follow its <routing-instructions>.'
              ].join('\n')
            }
          ]
        })
      };
    }

    // 3. Shutdown route: an idle exit-when-done session whose work is done
    // should run the shutdown verb. At most once per session.
    if (actionInput.exitWhenDone && !deps.sessionMarkers.hasExitWhenDoneFired(sessionId)) {
      deps.sessionMarkers.markExitWhenDoneFired(sessionId);
      logger.info('Injecting shutdown route', { sessionId });
      return {
        output: postInvocationOutput({
          injectSteps: [
            {
              ephemeralMessage: [
                'EXIT_WHEN_DONE=true — a reminder for when work is done, not a signal to stop now.',
                "Once the card's work is finished and validated, read",
                `${deps.shutdownRunbookPath()} and follow its <instructions>: confirm the outcome, run`,
                '`cards "$CARD_ID" shutdown --outcome success|blocked|error --message "..."`, then end the session.',
                'The action handler terminates the launcher gracefully in response to the signal.'
              ].join('\n')
            }
          ]
        })
      };
    }

    // 4. Idle: the decision machinery ran and required no next step. Nothing
    // durable records it: a route is visible by the step it injected, and a
    // run that injected none has no marker to read.
    return { output: postInvocationOutput() };
  } catch (error) {
    if (error instanceof HandlerFailure) {
      throw error;
    }
    throw new HandlerFailure('decision', error instanceof Error ? error.message : String(error), input.conversationId);
  }
}

/**
 * Writes the transcript-watcher flush sentinel for the Antigravity stream.
 *
 * @param deps - Handler dependencies.
 * @param cardRepoPath - Absolute card repository path.
 * @param sessionId - Session whose watcher should flush.
 */
function writeFlushSentinel(deps: AntigravityHandlerDeps, cardRepoPath: string, sessionId: string): void {
  const dir = join(cardRepoPath, 'streams', ANTIGRAVITY_STREAM_TYPE);
  deps.io.ensureDirSync(dir);
  deps.io.writeTextFileSync(join(dir, `${sessionId}.flush`), '');
}

/**
 * `Stop` — process/session drain and call-scoped cleanup.
 *
 * Contract: requires `conversationId` plus the pinned common host fields;
 * returns no `continue` decision. Cleanup is idempotent and its completion is
 * carried by the exit status alone — no durable marker records it. It never
 * uses `decision: "continue"` to turn cleanup failure into another model
 * turn.
 *
 * The pending-shutdown acknowledgement is settlement-critical: a failure
 * there (or an unprovable drain state) writes the failure marker and skips
 * the acknowledgement, so the launcher's bounded wait fails closed. The flush
 * sentinel and session-artifact cleanup are best-effort — the watcher
 * provides crash resilience, and leftover artifacts are harmless.
 *
 * @param raw - The raw stdin JSON value.
 * @param ctx - Handler dependencies and logger.
 * @returns The pinned no-decision output.
 * @throws {HandlerFailure} On every contract violation.
 */
export async function handleStop(raw: unknown, ctx: HandlerContext): Promise<AntigravityHandlerResult> {
  const { deps, logger } = ctx;
  const sessionKind = classifyCardsManagedSession();
  if (sessionKind === 'foreign') {
    return { output: stopOutput() };
  }
  if (sessionKind === 'cards-assistant') {
    return handleCardsAssistantStop(raw, ctx);
  }

  const input = parseCommonOrThrow(raw);
  const sessionId = requireSessionId(deps, input.conversationId);
  const actionInput = requireActionInput(deps, input.conversationId);

  // 1. Pending-shutdown handshake under the strict drain authority. A
  // failed acknowledgement must block settlement: throw before the response
  // that reports Stop succeeded.
  let pendingRequest: PendingShutdownRequest | undefined;
  try {
    pendingRequest = deps.readPendingShutdownRequest(sessionId);
  } catch (error) {
    throw new HandlerFailure(
      'drain-ack',
      `failed to read the pending shutdown request: ${error instanceof Error ? error.message : String(error)}`,
      input.conversationId
    );
  }
  if (pendingRequest !== undefined) {
    let drained: boolean;
    try {
      drained = await isSessionStrictlyDrained(sessionId, deps, input.conversationId);
    } catch (error) {
      if (error instanceof HandlerFailure) {
        throw new HandlerFailure('drain-ack', error.reason, error.conversationId);
      }
      throw error;
    }
    if (drained) {
      try {
        await deps.sendShutdownReady(pendingRequest.socketPath, {
          type: 'shutdownReady',
          requestId: pendingRequest.requestId
        });
        deps.clearPendingShutdownRequest(sessionId, pendingRequest.requestId);
        logger.info('Acknowledged shutdown readiness', { sessionId });
      } catch (error) {
        throw new HandlerFailure(
          'drain-ack',
          `failed to acknowledge shutdown readiness: ${error instanceof Error ? error.message : String(error)}`,
          input.conversationId
        );
      }
    }
  }

  // 2. Flush sentinel for the stream-sync-watcher — best-effort.
  try {
    writeFlushSentinel(deps, actionInput.cardRepoPath, sessionId);
  } catch (error) {
    logger.warn('failed to write the flush sentinel', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // 3. Session artifact cleanup — best-effort, aggregate-tolerant.
  try {
    deps.cleanupSessionArtifacts(sessionId);
  } catch (error) {
    logger.warn('failed to clean up session artifacts', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  logger.info('Antigravity session cleanup complete', { sessionId, conversationId: input.conversationId });
  return { output: stopOutput() };
}

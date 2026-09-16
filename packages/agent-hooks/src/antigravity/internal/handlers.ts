/**
 * Handler bodies for the Antigravity `runtime` hooks, wrapped around the
 * shared Cards runtime behaviors.
 *
 * Each handler maps one Antigravity host event to the shared internals the
 * existing hosts already use — action-env extraction, session registration,
 * watcher setup, the idle/route/merge/shutdown decision, and
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
import type { ActionInput } from '@cards.management/sdk/config';
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
import { markerPath, type ReadyMarkerPayload, type RouteMarkerPayload, writeMarker } from './markers.js';
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
  | 'ready-marker'
  | 'decision'
  | 'drain-marker'
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

/** Durable workspace/window registration emitted for Cards Assistant. */
export interface CardsAssistantRuntimeRegistration {
  /** Cards-owned session identity inherited from the launcher. */
  sessionId: string;
  /** VS Code window/session identity that owns this Assistant process. */
  windowId: string;
  /** Exact active workspace selected as the launch cwd. */
  workspacePath: string;
  /** Host conversation identity from the pinned hook input. */
  conversationId: string;
  /** Canonical read-only SQLite conversation path for this conversation. */
  transcriptPath: string;
  /** Host model name recorded for diagnostics. */
  modelName: string;
}

/**
 * Registers and marks a workspace/window Assistant invocation without
 * entering any card-action routing or settlement path.
 *
 * @param raw - Raw pinned PreInvocation input.
 * @param ctx - Handler dependencies and logger.
 * @returns The standard no-message PreInvocation response.
 * @throws {HandlerFailure} When identity, registration, or ready-marker persistence fails.
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

  const registration: CardsAssistantRuntimeRegistration = {
    sessionId,
    windowId,
    workspacePath,
    conversationId: input.conversationId,
    transcriptPath,
    modelName: input.modelName
  };
  try {
    writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'ready'), registration);
  } catch (error) {
    throw new HandlerFailure(
      'ready-marker',
      error instanceof Error ? error.message : String(error),
      input.conversationId
    );
  }

  logger.info('Antigravity Cards Assistant session ready', {
    sessionId,
    windowId,
    conversationId: input.conversationId
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
 * @throws {HandlerFailure} When registration/artifact cleanup or drain-marker persistence fails.
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

  try {
    writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'drain-ready'));
  } catch (error) {
    throw new HandlerFailure(
      'drain-marker',
      error instanceof Error ? error.message : String(error),
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
 * and `initialNumSteps`; returns no message. Success writes the
 * conversation-scoped ready marker. Missing/invalid input, inaccessible card
 * context, or watcher setup failure prevents action success: it writes the
 * failure marker and the launcher terminates the child.
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

  const readyPayload: ReadyMarkerPayload = {
    conversationId: input.conversationId,
    sessionId,
    transcriptPath: conversationDbPath,
    modelName: input.modelName
  };
  try {
    writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'ready'), readyPayload);
  } catch (error) {
    throw new HandlerFailure(
      'ready-marker',
      error instanceof Error ? error.message : String(error),
      input.conversationId
    );
  }

  logger.info('Antigravity session ready', { sessionId, conversationId: input.conversationId });
  return { output: preInvocationOutput() };
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
 * transition (the shared once-per-session route markers); action settlement
 * requires the durable decision/idle marker, not hook exit zero.
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
    // 1. Merge route: the workspace branch has commits to merge, the card is
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
      writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'route'), {
        kind: 'merge'
      } satisfies RouteMarkerPayload);
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

    // 2. Shutdown route: an idle exit-when-done session whose work is done
    // should run the shutdown verb. At most once per session.
    if (actionInput.exitWhenDone && !deps.sessionMarkers.hasExitWhenDoneFired(sessionId)) {
      deps.sessionMarkers.markExitWhenDoneFired(sessionId);
      writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'route'), {
        kind: 'shutdown'
      } satisfies RouteMarkerPayload);
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

    // 3. Idle: the decision machinery ran and required no next step. The
    // durable marker — not hook exit zero — is what action settlement reads.
    writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'idle'));
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
 * returns no `continue` decision. Cleanup is idempotent and records drain
 * readiness. It never uses `decision: "continue"` to turn cleanup failure
 * into another model turn.
 *
 * The flush sentinel and session-artifact cleanup are best-effort — the
 * watcher provides crash resilience, and leftover artifacts are harmless.
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

  // 1. Flush sentinel for the stream-sync-watcher — best-effort.
  try {
    writeFlushSentinel(deps, actionInput.cardRepoPath, sessionId);
  } catch (error) {
    logger.warn('failed to write the flush sentinel', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // 2. Session artifact cleanup — best-effort, aggregate-tolerant.
  try {
    deps.cleanupSessionArtifacts(sessionId);
  } catch (error) {
    logger.warn('failed to clean up session artifacts', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // 3. Drain readiness: the idempotent acknowledgement the launcher waits for.
  try {
    writeMarker(deps.io, markerPath(deps.cardsConfigDir(), sessionId, input.conversationId, 'drain-ready'));
  } catch (error) {
    throw new HandlerFailure(
      'drain-marker',
      error instanceof Error ? error.message : String(error),
      input.conversationId
    );
  }

  logger.info('Antigravity session cleanup complete', { sessionId, conversationId: input.conversationId });
  return { output: stopOutput() };
}

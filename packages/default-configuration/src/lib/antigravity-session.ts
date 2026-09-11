/**
 * Shared session utilities for Antigravity action workflows.
 *
 * Mirrors the launch mechanics of {@link ./codex-session.js} and
 * {@link ./opencode-session.js} for the `agy` CLI: worktree resolution,
 * process-group ownership, cancel/shutdown drain wiring, status settle, and
 * mode-dependent post-exit branch cleanup.
 *
 * Invocation contract (notes/antigravity-host-contract.md, verified launch
 * surface): interactive launches run terminal-owned `agy -i <prompt>`;
 * background launches run child-owned `agy -p <prompt> --output-format
 * stream-json` and parse the final result record from the owned stdout. Cards
 * never passes `--dangerously-skip-permissions`.
 *
 * @summary Shared session utilities for Antigravity action workflows
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { type ActionContext, type ActionInput, CARDS_ENV_VARS } from '@cards.management/sdk/config';
import {
  finalizePersistedSqlitePollSession,
  type SqlitePollFinalizationOutcome
} from '@cards.management/sdk/transcript-sync';
import { createAntigravityTerminationController } from './antigravity-termination.js';
import { prepareAntigravityWorkspaceTrust, resolveAntigravitySettingsPath } from './antigravity-workspace-trust.js';
import { spawnBranchCleanupWatcher } from './branch-cleanup-watcher.js';
import {
  cleanupMergedBranches,
  errorMessage,
  resolveBaseBranch,
  resolveOrCreateWorktree,
  settleCardStatusForCleanup
} from './claude-session.js';
import { spawnAgentCli } from './spawn-cli.js';

/**
 * Options for {@link spawnAntigravitySession}.
 */
export interface AntigravitySessionOptions {
  /** Prompt string passed to the Antigravity CLI. */
  prompt?: string;
  /**
   * When true, overrides `EXIT_WHEN_DONE` to `'false'` in the child process
   * environment so the runtime's exit-when-done handler never nudges toward
   * `cards shutdown` for interaction-only actions.
   */
  suppressExitWhenDone?: boolean;
  /** Optional host model selected by the action invocation. */
  model?: string;
  /** Optional host effort selected by the action invocation. */
  effort?: string;
}

/** Antigravity execution controls supported by the pinned CLI contract. */
export interface AntigravityExecutionControls {
  /** Exact model identifier forwarded to `agy --model`. */
  model?: string;
  /** Exact effort identifier forwarded to `agy --effort`. */
  effort?: string;
}

/** Action-environment carriers for Antigravity's pinned execution controls. */
export const CARDS_AGENT_MODEL_ENV_VAR = 'CARDS_AGENT_MODEL';
export const CARDS_AGENT_EFFORT_ENV_VAR = 'CARDS_AGENT_EFFORT';

/**
 * Builds the pinned CLI flags for optional model and effort selections.
 *
 * @param controls - Optional action-selected execution controls.
 * @returns Safe argv tail containing complete flag/value pairs.
 * @throws {Error} Until the Phase 3 argv implementation replaces this stub.
 */
export function buildAntigravityExecutionControlArgs(controls: AntigravityExecutionControls): string[] {
  const args: string[] = [];
  for (const [flag, label, value] of [
    ['--model', 'model', controls.model],
    ['--effort', 'effort', controls.effort]
  ] as const) {
    if (value === undefined) continue;
    if (value.trim().length === 0) {
      throw new Error(`Antigravity ${label} selection must be a nonblank argv value`);
    }
    if (value.includes('\0')) {
      throw new Error(`Antigravity ${label} selection must not contain a NUL byte`);
    }
    args.push(flag, value);
  }
  return args;
}

/**
 * Structured final result record parsed from the child-owned `stream-json`
 * stdout of a background launch. The field set is pinned by the live
 * authentication-probe witness (`conversation_id`/`status`/`response`); the
 * surrounding stream-json event records are unpinned and tolerated.
 */
export interface AntigravityFinalRecord {
  /** Conversation identity attributed to the child. */
  conversationId: string;
  /** Host-reported final status (success is exactly `"SUCCESS"`). */
  status: string;
  /** Final assistant response text when the record carries it. */
  response?: string;
}

/**
 * Error thrown when the child-owned stream-json stdout cannot be trusted:
 * a non-JSON, non-blank line is a stream parse error and fails the action.
 */
export class AntigravityStreamError extends Error {
  override readonly name = 'AntigravityStreamError';
}

/**
 * Named failure reasons for an unsuccessful Antigravity launch. Exit zero
 * without the expected final record is failure, per the action matrix
 * lifecycle; a refused launch — one that never reached a session — is failure
 * too, and names its refusal here.
 */
export type AntigravitySessionFailureReason =
  | 'spawn-failure'
  | 'nonzero-exit'
  | 'signal-termination'
  | 'hook-failure'
  | 'lifecycle-evidence-missing'
  | 'process-tree-drain-failed'
  | 'transcript-finalization-degraded'
  | 'missing-final-record'
  | 'unsuccessful-final-record'
  | 'workspace-trust-unresolved';

/**
 * Error thrown when a launched Antigravity session ends without a successful
 * structured outcome. The {@link AntigravitySessionFailureError.reason} field
 * names the failure mode.
 */
export class AntigravitySessionFailureError extends Error {
  override readonly name = 'AntigravitySessionFailureError';

  /**
   * Creates the named-failure error.
   *
   * @param reason - Named failure mode.
   * @param message - Human-readable failure description.
   */
  constructor(
    public readonly reason: AntigravitySessionFailureReason,
    message: string
  ) {
    super(message);
  }
}

/**
 * Reads the first durable hook failure written for a Cards-owned session.
 *
 * @param sessionId - Pre-spawn session identity exported to the host.
 * @returns Named stage/reason text, or undefined when no failure marker exists.
 * @throws For marker-store IO failures other than an absent session directory.
 */
export async function readAntigravityHookFailure(sessionId: string): Promise<string | undefined> {
  const directory = join(resolveGlobalCardsConfigDir(), 'antigravity', 'runtime', 'markers', sessionId);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.failure')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (names.length === 0) return undefined;

  const markerPath = join(directory, names[0]!);
  const text = await readFile(markerPath, 'utf8');
  try {
    const value = JSON.parse(text) as { stage?: unknown; reason?: unknown };
    const stage = typeof value.stage === 'string' && value.stage.trim() ? value.stage : 'unknown-stage';
    const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason : 'missing failure reason';
    return `${stage}: ${reason}`;
  } catch {
    return `malformed failure marker ${names[0]}`;
  }
}

/** Positive hook evidence required before a card action may settle. */
export interface AntigravityLifecycleEvidence {
  /** Conversation identity proven by PreInvocation and, in background mode, stdout. */
  conversationId: string;
}

/**
 * Requires the complete hook lifecycle for one Cards-owned action session.
 *
 * @param sessionId - Cards-owned session identity exported before spawn.
 * @param expectedConversationId - Background stdout conversation identity, when available.
 * @returns Validated positive lifecycle evidence.
 * @throws {AntigravitySessionFailureError} When failure evidence exists or any positive marker is absent/invalid.
 */
export async function requireAntigravityLifecycleEvidence(
  sessionId: string,
  expectedConversationId?: string
): Promise<AntigravityLifecycleEvidence> {
  const directory = join(resolveGlobalCardsConfigDir(), 'antigravity', 'runtime', 'markers', sessionId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
    else throw error;
  }

  const failures = names.filter((name) => name.endsWith('.failure')).sort();
  if (failures.length > 0) {
    const failure = await readAntigravityHookFailure(sessionId);
    throw new AntigravitySessionFailureError(
      'hook-failure',
      `Antigravity runtime hook failure (${failure ?? 'failure marker could not be decoded'})`
    );
  }

  const readyNames = names.filter((name) => name.endsWith('.ready')).sort();
  if (readyNames.length !== 1) {
    throw new AntigravitySessionFailureError(
      'lifecycle-evidence-missing',
      `Antigravity lifecycle requires exactly one ready marker, found ${String(readyNames.length)}`
    );
  }
  const readyName = readyNames[0] as string;
  const conversationId = readyName.slice(0, -'.ready'.length);
  let ready: { conversationId?: unknown; sessionId?: unknown; transcriptPath?: unknown; modelName?: unknown };
  try {
    ready = JSON.parse(await readFile(join(directory, readyName), 'utf8')) as typeof ready;
  } catch (error) {
    throw new AntigravitySessionFailureError(
      'lifecycle-evidence-missing',
      `Antigravity ready marker is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    ready.conversationId !== conversationId ||
    ready.sessionId !== sessionId ||
    typeof ready.transcriptPath !== 'string' ||
    ready.transcriptPath.length === 0 ||
    typeof ready.modelName !== 'string' ||
    ready.modelName.length === 0 ||
    (expectedConversationId !== undefined && conversationId !== expectedConversationId)
  ) {
    throw new AntigravitySessionFailureError(
      'lifecycle-evidence-missing',
      'Antigravity ready marker does not prove the launched session/conversation identity'
    );
  }

  const hasIdle = names.includes(`${conversationId}.idle`);
  const hasRoute = names.includes(`${conversationId}.route`);
  if (!hasIdle && !hasRoute) {
    throw new AntigravitySessionFailureError(
      'lifecycle-evidence-missing',
      'Antigravity PostInvocation produced neither idle nor route evidence'
    );
  }
  if (!names.includes(`${conversationId}.drain-ready`)) {
    throw new AntigravitySessionFailureError(
      'lifecycle-evidence-missing',
      'Antigravity Stop did not produce drain-ready evidence'
    );
  }

  return { conversationId };
}

/**
 * Builds the CLI argument list for the `agy` process.
 *
 * Interactive actions run terminal-owned `agy -i <prompt>`. Background actions
 * run the one-shot `agy -p <prompt> --output-format stream-json`, whose stdout
 * the launcher owns and parses. Never includes
 * `--dangerously-skip-permissions`.
 *
 * @param prompt - Prompt passed to Antigravity.
 * @param executionMode - Dispatch mode: `'interactive'` uses `-i`, `'background'` uses `-p` with stream-json output.
 * @param controls - Optional pinned host model/effort controls.
 * @returns Array of CLI arguments.
 * @throws {Error} When a background launch has no prompt (nothing to run one-shot).
 */
export function buildAntigravityArgs(
  prompt: string | undefined,
  executionMode: 'interactive' | 'background',
  controls: AntigravityExecutionControls = {}
): string[] {
  const controlArgs =
    controls.model !== undefined || controls.effort !== undefined ? buildAntigravityExecutionControlArgs(controls) : [];
  if (executionMode === 'interactive') {
    return prompt === undefined ? ['-i', ...controlArgs] : ['-i', prompt, ...controlArgs];
  }

  if (prompt === undefined) {
    throw new Error(
      'Cannot launch Antigravity in background mode without a prompt: `agy -p` runs exactly one prompt and exits.'
    );
  }
  return ['-p', prompt, '--output-format', 'stream-json', ...controlArgs];
}

/**
 * Parses the final result record out of a completed background launch's
 * `stream-json` stdout.
 *
 * Every non-blank line must be JSON — anything else is a stream parse error.
 * Event records without the pinned result field set (`status` plus a
 * non-empty `conversation_id`) are tolerated and skipped; the LAST record
 * carrying the pinned field set wins.
 *
 * @param stdout - Full stdout captured from the child.
 * @returns The final result record, or `null` when the stream carried none.
 * @throws {AntigravityStreamError} When stdout contains a non-JSON, non-blank line.
 */
export function parseAntigravityFinalRecord(stdout: string): AntigravityFinalRecord | null {
  let final: AntigravityFinalRecord | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const excerpt = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
      throw new AntigravityStreamError(`agy stream-json contained a non-JSON line: "${excerpt}"`, { cause: error });
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const status = record['status'];
    const conversationId = record['conversation_id'];
    if (typeof status !== 'string' || typeof conversationId !== 'string' || conversationId.length === 0) continue;

    final = {
      conversationId,
      status,
      ...(typeof record['response'] === 'string' ? { response: record['response'] as string } : {})
    };
  }
  return final;
}

/**
 * Spawns an `agy` CLI session with worktree lifecycle and prompt-based skill
 * guidance.
 *
 * Stage order mirrors {@link ./codex-session.js}: API client → base branch →
 * worktree → CLI spawn with card env vars → cancel/shutdown drain wiring →
 * exit → status settle → mode-dependent branch cleanup. Background launches
 * additionally parse the child-owned stream-json stdout and fail the action on
 * nonzero exit, signal termination, stream parse errors, or a
 * missing/unsuccessful final record.
 *
 * @param input - Parsed action input from the environment.
 * @param context - Action context providing logger and lifecycle hooks.
 * @param options - Session-specific parameters.
 * @returns Resolves after the child exits and post-exit settle/cleanup ran.
 * @throws {AntigravitySessionFailureError} When a background launch ends without a successful structured outcome (spawn failure, nonzero exit, signal termination, missing final record, unsuccessful final record), when an interactive launch fails to spawn, or when a background launch cannot carry the authorized project's workspace trust into the checkout.
 * @throws {AntigravityTrustError} When the native Antigravity profile exists but its workspace trust cannot be read or safely updated.
 * @throws {AntigravityStreamError} When the background stdout stream carries a non-JSON, non-blank line.
 * @throws {Error} When Cards API discovery fails or the worktree settle phase rejected.
 */
export async function spawnAntigravitySession(
  input: ActionInput,
  context: ActionContext,
  options: AntigravitySessionOptions
): Promise<void> {
  const { prompt, suppressExitWhenDone } = options;
  const isInteractive = input.executionMode === 'interactive';

  context.logger.info(`${input.actionName} action started`, {
    cardId: input.cardId,
    environment: input.environment,
    executionMode: input.executionMode
  });

  // Session identity is minted pre-spawn and exported into the agy child
  // environment (ANTIGRAVITY_SESSION_ID) so every in-session `cards` CLI
  // inherits it — the witnessed session-identity carrier (plan Phase 5).
  const sessionId = randomUUID();

  const client = await createCardsClient(context.logger);
  if (!client) {
    throw new Error('Cards API discovery failed — cannot start session');
  }

  const baseBranch = await resolveBaseBranch(input.repoRoot, client);
  const {
    worktreePath: cwd,
    branchName,
    parentBranch,
    settle
  } = await resolveOrCreateWorktree(input, client, baseBranch, context.logger, sessionId);

  context.logger.info('Using worktree', { cwd, branch: branchName, baseBranch, parentBranch });

  // Worktree outfit/registration is part of launch preparation. Await it
  // before exposing the path to an agent process; a rejected settle removes
  // the worktree and must prevent spawn entirely.
  if (settle) await settle;

  // Carry the already authorized project's native folder trust into the exact
  // checkout before any agent process is exposed to it. `agy` raises its native
  // folder-trust dialog for a directory it has not been told to trust, and a
  // freshly created card worktree always is one — even though it shares its
  // repository identity with the approved project. The settle above removes the
  // worktree when it rejects, so a failed worktree preparation never reaches
  // this step.
  const workspaceTrust = await prepareAntigravityWorkspaceTrust({
    checkoutPath: cwd,
    projectRoot: input.repoRoot,
    settingsPath: resolveAntigravitySettingsPath()
  });
  if (workspaceTrust.kind === 'no-established-consent') {
    if (!isInteractive) {
      // A terminal can still answer the native dialog, so interactive launches
      // keep the native consent as their fallback. A background launch has
      // nobody to ask: the unresolved requirement is named here instead of
      // surfacing later as an unexplained missing final record.
      throw new AntigravitySessionFailureError(
        'workspace-trust-unresolved',
        `${input.actionName} action failed: Antigravity workspace trust for ${cwd} could not be carried ` +
          `from the authorized project ${input.repoRoot} (${workspaceTrust.reason}), and a background ` +
          'launch cannot answer the native folder-trust dialog'
      );
    }
    context.logger.warn('Antigravity workspace trust not carried — the native folder-trust dialog will ask', {
      cwd,
      reason: workspaceTrust.reason
    });
  } else {
    context.logger.info('Antigravity workspace trust prepared', {
      cwd,
      trustedPath: workspaceTrust.trustedPath,
      outcome: workspaceTrust.kind
    });
  }

  const args = buildAntigravityArgs(prompt, input.executionMode, {
    model: options.model ?? process.env[CARDS_AGENT_MODEL_ENV_VAR],
    effort: options.effort ?? process.env[CARDS_AGENT_EFFORT_ENV_VAR]
  });

  const child: ChildProcess = spawnAgentCli('agy', args, {
    cwd,
    // Detached on POSIX (matching the other launchers) so `agy` roots its own
    // process group instead of sharing the extension host's: the drain below
    // signals -pid, which must stay inside a launcher-owned group or it would
    // sweep sibling actions sharing the host's group.
    detached: process.platform !== 'win32',
    // Interactive actions inherit stdio so the user gets direct terminal
    // control (terminal-owned `-i`). Background runs are console-less and own
    // the stream-json stdout for final-result parsing; stderr is piped for
    // diagnostic capture. windowsHide keeps the cross-spawn cmd.exe hop
    // invisible on win32 — libuv ignores it when any fd is inherited, so the
    // interactive path must not set it.
    stdio: isInteractive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    ...(isInteractive ? {} : { windowsHide: true }),
    env: {
      ...process.env,
      WORKSPACE_PATH: cwd,
      BASE_BRANCH: baseBranch,
      PARENT_BRANCH: parentBranch,
      WORKSPACE_BRANCH: branchName,
      ANTIGRAVITY_SESSION_ID: sessionId,
      ...(suppressExitWhenDone ? { [CARDS_ENV_VARS.EXIT_WHEN_DONE]: 'false' } : {})
    }
  });

  const termination = createAntigravityTerminationController(child, {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 5_000
  });

  let transcriptFinalization: Promise<SqlitePollFinalizationOutcome> | undefined;
  const finalizeTranscript = (): Promise<SqlitePollFinalizationOutcome> => {
    transcriptFinalization ??= finalizePersistedSqlitePollSession({
      cardRepoPath: input.cardRepoPath,
      sessionId,
      warnFn: (message) => context.logger.warn(message),
      errorFn: (message) => context.logger.error(message)
    });
    return transcriptFinalization;
  };

  context.onCancel(async () => {
    context.logger.info(`${input.actionName} action cancelled, terminating agy`, { sessionId });
    const result = await termination.terminate('cancel');
    const finalization = await finalizeTranscript();
    const log =
      finalization.kind === 'flushed'
        ? context.logger.info.bind(context.logger)
        : context.logger.error.bind(context.logger);
    log(`${input.actionName} cancellation termination completed`, {
      sessionId,
      result,
      transcriptFinalization: finalization
    });
  });

  context.onAgentShutdown(async () => {
    context.logger.info(`${input.actionName} agent signalled shutdown, terminating agy`, { sessionId });
    const result = await termination.terminate('shutdown');
    const finalization = await finalizeTranscript();
    const log =
      finalization.kind === 'flushed'
        ? context.logger.info.bind(context.logger)
        : context.logger.error.bind(context.logger);
    log(`${input.actionName} shutdown termination completed`, {
      sessionId,
      result,
      transcriptFinalization: finalization
    });
    return result;
  });

  // Background mode: own the stream-json stdout for final-result parsing and
  // capture stderr for diagnostic logging.
  let stdoutText = '';
  if (!isInteractive) {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        context.logger.warn(text);
      }
    });
  }

  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>(
    (resolve) => {
      // Fail closed: a spawn failure (e.g. ENOENT) emits `error` but never
      // `close`, which would leave this promise hung forever. Mirrors the
      // cards-assistant launch guard.
      child.on('error', (error) => {
        context.logger.error('Failed to spawn agy', {
          error: error instanceof Error ? error.message : String(error)
        });
        resolve({
          exitCode: null,
          signal: null,
          spawnError: error instanceof Error ? error : new Error(String(error))
        });
      });
      child.on('close', (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    }
  );

  if (outcome.spawnError !== undefined) {
    throw new AntigravitySessionFailureError(
      'spawn-failure',
      `${input.actionName} action failed: the agy process could not be launched (${outcome.spawnError.message})`
    );
  }

  let final: AntigravityFinalRecord | null = null;
  let lifecycle: AntigravityLifecycleEvidence | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    // Root exit does not prove the detached process group is gone: surviving
    // descendants can still own the worktree. Run the same bounded tree drain
    // on every normal close before any success evidence or settlement.
    const normalDrain = await termination.terminate('normal-exit');
    if (outcome.signal) {
      throw new AntigravitySessionFailureError(
        'signal-termination',
        `${input.actionName} action failed: agy terminated on signal ${outcome.signal}`
      );
    }
    if (outcome.exitCode !== 0) {
      throw new AntigravitySessionFailureError(
        'nonzero-exit',
        `${input.actionName} action failed: agy exited with code ${outcome.exitCode}`
      );
    }
    if (normalDrain === 'failed') {
      throw new AntigravitySessionFailureError(
        'process-tree-drain-failed',
        `${input.actionName} action failed: Antigravity descendants remained after the bounded normal-exit drain`
      );
    }

    if (!isInteractive) {
      // Exit zero without the expected final record is failure, per the action
      // matrix lifecycle — a clean exit alone never settles a background launch.
      try {
        final = parseAntigravityFinalRecord(stdoutText);
      } catch (error) {
        context.logger.error(`${input.actionName} action failed: unparseable agy stream-json output`, {
          error: errorMessage(error)
        });
        throw error;
      }

      if (final === null) {
        throw new AntigravitySessionFailureError(
          'missing-final-record',
          `${input.actionName} action failed: agy exited 0 without the expected final stream-json record ` +
            '(exit zero without the final result record is failure)'
        );
      }
      if (final.status !== 'SUCCESS') {
        throw new AntigravitySessionFailureError(
          'unsuccessful-final-record',
          `${input.actionName} action failed: agy final record status is '${final.status}' (expected 'SUCCESS')`
        );
      }
    }

    lifecycle = await requireAntigravityLifecycleEvidence(sessionId, final?.conversationId);
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  }

  let finalization: SqlitePollFinalizationOutcome;
  try {
    finalization = await finalizeTranscript();
  } catch (error) {
    if (hasPrimaryFailure) {
      context.logger.error(`${input.actionName} transcript finalization also failed`, { error: errorMessage(error) });
      throw primaryFailure;
    }
    throw new AntigravitySessionFailureError(
      'transcript-finalization-degraded',
      `${input.actionName} action failed: final Antigravity transcript drain threw (${errorMessage(error)})`
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (finalization.kind === 'degraded') {
    throw new AntigravitySessionFailureError(
      'transcript-finalization-degraded',
      `${input.actionName} action failed: final Antigravity transcript drain degraded (${finalization.reason}: ${finalization.detail})`
    );
  }

  if (!isInteractive) {
    // Settle only after process, structured-result, hook, and transcript
    // finalization success. Cleanup reads this status as its first gate.
    await settleCardStatusForCleanup(input.cardRepoPath, context.logger);

    context.logger.info(`${input.actionName} background launch settled`, {
      sessionId,
      conversationId: lifecycle?.conversationId
    });

    // Post-exit cleanup: remove fully-merged branches inline — there is no
    // terminal to keep open in background mode.
    try {
      await cleanupMergedBranches(input, input.cardRepoPath, context.logger, sessionId);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('self-referential parentBranch') || message.includes('data corruption')) {
        throw error;
      }
      context.logger.warn('Post-exit cleanup failed (non-fatal)', { error: message, sessionId });
    }
    return;
  }

  // Interactive success uses the same verified-success settlement gate and
  // still settles before the detached cleanup watcher can inspect status.
  await settleCardStatusForCleanup(input.cardRepoPath, context.logger);
  context.logger.info(`${input.actionName} action completed`, { sessionId, exitCode: outcome.exitCode });

  // Interactive mode: hand post-exit cleanup to the detached watcher so the
  // terminal closes immediately (the watcher calls the same
  // {@link cleanupMergedBranches} function).
  try {
    await spawnBranchCleanupWatcher(
      {
        cardId: input.cardId,
        repoRoot: input.repoRoot,
        cardRepoPath: input.cardRepoPath,
        sessionId
      },
      context.logger
    );
  } catch (error) {
    context.logger.warn('Failed to spawn branch-cleanup watcher (non-fatal)', {
      error: errorMessage(error),
      sessionId
    });
  }
}

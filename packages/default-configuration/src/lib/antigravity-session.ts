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
 * stream-json`, whose stdout is discarded and whose turn is judged by the
 * shared outcome policy — exit status, plus `agy`'s own truncation notice
 * latched off a bounded stderr tail — and by the durable hook-failure marker.
 * Because that marker is the one channel `agy` does not sever, the launcher
 * establishes the marker store before spawning and refuses the launch by name
 * when it cannot. Cards never passes `--dangerously-skip-permissions`.
 *
 * @summary Shared session utilities for Antigravity action workflows
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, readdir, readFile } from 'node:fs/promises';
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
import { cleanupMergedBranches, errorMessage, resolveBaseBranch, resolveOrCreateWorktree } from './claude-session.js';
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
 * @throws {Error} When a selected model or effort value is blank.
 * @throws {Error} When a selected model or effort value contains a NUL byte.
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
 * Invariant suffix of `agy`'s print-mode timeout notice: the diagnostic reads
 * `[agy] print timeout after <duration> with turn in progress; returning
 * partial output`, and the value it embeds moves with the flag and the host
 * default (`after 1s` in the committed captures, `after 5m0s` on a host where
 * the action path passes no `--print-timeout`). Matching the whole line would
 * stop firing the moment that value moves, so only the suffix is matched.
 */
const AGY_PRINT_TIMEOUT_SUFFIX = 'with turn in progress; returning partial output';

/**
 * Named failure reasons for a completed-but-unsuccessful Antigravity launch.
 * Exit zero is not success: a background run is judged by the shared outcome
 * policy (exit status plus the latched CLI diagnostic) and by the durable
 * hook-failure marker, never by the result record it writes, which reports
 * `"SUCCESS"` on the truncated and hook-failed runs alike. A refused launch —
 * one that never reached a session, because the checkout's workspace trust
 * could not be carried — is failure too, and names its refusal here.
 */
export type AntigravitySessionFailureReason =
  | 'spawn-failure'
  | 'marker-store-unavailable'
  | 'nonzero-exit'
  | 'signal-termination'
  | 'hook-failure'
  | 'output-truncated'
  | 'process-tree-drain-failed'
  | 'transcript-finalization-degraded'
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
 * Resolves the Antigravity runtime marker store root.
 *
 * The directory the hook transport writes through its own `markerPath` and
 * {@link readAntigravityHookFailure} reads — derived here from the shared
 * layout rather than duplicated from the hook's module.
 *
 * @returns Absolute path `<cardsConfigDir>/antigravity/runtime/markers`.
 */
function antigravityMarkerRoot(): string {
  return join(resolveGlobalCardsConfigDir(), 'antigravity', 'runtime', 'markers');
}

/**
 * Establishes the Antigravity marker store before a session is launched.
 *
 * The durable `.failure` marker is the only channel a hook failure reaches
 * this launcher through — `agy` exits 0 with an empty stderr when its hooks
 * fail — so a store that cannot accept a write turns every hook failure of
 * the session into a silent success. The root is created on demand exactly as
 * the hook's own `writeMarker` would (`recursive` keeps it idempotent on an
 * existing root), then probed for write access, because a recursive mkdir
 * performs no write when the root already exists and would otherwise pass an
 * unwritable store. It establishes a precondition only: it reads no evidence
 * and never asks whether any hook ran.
 *
 * @throws {AntigravitySessionFailureError} `marker-store-unavailable` when the
 *   store cannot be created or is not writable, naming the store path.
 */
async function establishAntigravityMarkerStore(): Promise<void> {
  const markerRoot = antigravityMarkerRoot();
  try {
    await mkdir(markerRoot, { recursive: true });
    await access(markerRoot, constants.W_OK);
  } catch (error) {
    throw new AntigravitySessionFailureError(
      'marker-store-unavailable',
      `Antigravity marker store is not writable at ${markerRoot}: ${errorMessage(error)}`
    );
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
  const directory = join(antigravityMarkerRoot(), sessionId);
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
 * Spawns an `agy` CLI session with worktree lifecycle and prompt-based skill
 * guidance.
 *
 * Stage order mirrors {@link ./codex-session.js}: marker-store establishment →
 * API client → base branch → worktree → CLI spawn with card env vars →
 * cancel/shutdown drain wiring → exit → status settle → mode-dependent branch
 * cleanup. Background launches are judged by the shared outcome policy —
 * nonzero exit, signal termination, a failed process-tree drain, the latched
 * truncation notice, and the durable hook-failure marker all fail the action;
 * a clean exit that carries none of them settles as success, whatever the
 * discarded result record said.
 *
 * @param input - Parsed action input from the environment.
 * @param context - Action context providing logger and lifecycle hooks.
 * @param options - Session-specific parameters.
 * @returns Resolves after the child exits and post-exit settle/cleanup ran.
 * @throws {AntigravitySessionFailureError} When the marker store cannot be established before the spawn, when a background launch fails (spawn failure, nonzero exit, signal termination, output truncated by the CLI's print timeout, a runtime hook failure, or a failed process-tree drain), when the launch cannot carry the authorized project's workspace trust into the checkout, or when an interactive launch fails to spawn.
 * @throws {AntigravityTrustError} When the native Antigravity profile exists but its workspace trust cannot be read or safely updated.
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

  // The marker store is a launch precondition, not a post-hoc read. Both
  // execution modes are refused here, above every mode-conditioned branch, so
  // a session that could not record a hook failure is never launched: the
  // retired evidence checklist reported the same state on both modes, and its
  // absence from this path is a regression, not an accepted trade.
  await establishAntigravityMarkerStore();

  const client = await createCardsClient(context.logger);
  if (!client) {
    throw new Error('Cards API discovery failed — cannot start session');
  }

  const baseBranch = await resolveBaseBranch(input.repoRoot, client);
  const {
    worktreePath: cwd,
    branchName,
    parentBranch,
    reason,
    settle
  } = await resolveOrCreateWorktree(input, client, baseBranch, context.logger, sessionId);

  await context.reportWorktreeAssignment({ branch: branchName, worktreePath: cwd, reason });

  context.logger.info('Using worktree', { cwd, branch: branchName, baseBranch, parentBranch, reason });

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
    // control (terminal-owned `-i`). Background runs are console-less: stdout
    // is ignored — the parser that read the stream-json transcript is gone and
    // nothing consumed the buffer, so the run is judged by exit status, the
    // latched stderr notice, and the hook-failure marker — while stderr stays
    // piped as the diagnostic channel. windowsHide keeps the cross-spawn
    // cmd.exe hop invisible on win32 — libuv ignores it when any fd is
    // inherited, so the interactive path must not set it.
    stdio: isInteractive ? 'inherit' : ['ignore', 'ignore', 'pipe'],
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

  // Set by the two termination paths Cards owns. The truncation latch reads it
  // to tell an `agy` print timeout that interrupted a run Cards had already
  // decided to end from one that silently truncated work still in progress.
  let cardsTerminationRequested = false;

  context.onCancel(async () => {
    cardsTerminationRequested = true;
    context.logger.info(`${input.actionName} action cancelled, terminating agy`, { sessionId });
    const result = await termination.terminate();
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
    cardsTerminationRequested = true;
    context.logger.info(`${input.actionName} agent signalled shutdown, terminating agy`, { sessionId });
    const result = await termination.terminate();
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

  // Background mode: stderr is the diagnostic channel and also the only one
  // that carries the truncation class. A `--print-timeout` run exits 0, writes
  // `status:"SUCCESS"` with an empty response, and says what happened only
  // here, so the notice is latched as it streams past.
  let truncationObserved = false;
  let stderrTail = '';
  if (!isInteractive) {
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const trimmed = text.trim();
      if (trimmed) {
        context.logger.warn(trimmed);
      }
      // Match the notice's invariant suffix, never the whole line: the timeout
      // value it embeds moves with the flag and the host default, so a
      // full-line match would quietly stop firing when that value changes.
      stderrTail += text;
      if (stderrTail.includes(AGY_PRINT_TIMEOUT_SUFFIX)) {
        truncationObserved = true;
      }
      // Retain one byte less than the suffix, and test before truncating. The
      // hardest split that bound still admits is a one-character second half
      // (`…returning partial outpu` then `t`), and completing it needs exactly
      // the suffix minus the character it is missing — so this is as short as
      // the tail can be and still recover a notice from the next chunk. A
      // shorter bound drops the prefix, and testing after the truncation drops
      // it for the same split this is keeping.
      stderrTail = stderrTail.slice(-(AGY_PRINT_TIMEOUT_SUFFIX.length - 1));
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

  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    // Root exit does not prove the detached process group is gone: surviving
    // descendants can still own the worktree. Run the same bounded tree drain
    // on every normal close before any success evidence or settlement. It runs
    // ahead of the checks below, including the truncation latch, so a latched
    // run is still drained rather than abandoned with its group alive.
    const normalDrain = await termination.terminate();
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
      // Exit zero is not success. `agy` exits 0 for a CLI-level failure only
      // when the failure is its own turn's, which is the user's business — but
      // it also exits 0 when its print timeout cut the turn short, and that is
      // not a completed run. Having asked for the termination is what makes the
      // notice expected; a notice Cards did not cause means work was truncated
      // under it. This sits after the exit checks so a nonzero exit keeps
      // reporting itself: the latch exists for the class the exit code cannot
      // express, and adds nothing to one it already does. The retained tail is
      // tested once more here, beside the per-chunk test: one comparison, and
      // the decision no longer depends on a data event having been delivered
      // before the close it is read at.
      const truncated = truncationObserved || stderrTail.includes(AGY_PRINT_TIMEOUT_SUFFIX);
      if (truncated && !cardsTerminationRequested) {
        throw new AntigravitySessionFailureError(
          'output-truncated',
          `${input.actionName} action failed: agy reported a print timeout with its turn still in progress and ` +
            `returned partial output (exit code ${outcome.exitCode}); Cards did not request cancellation or shutdown`
        );
      }
    }

    // The failure marker is the only channel a hook failure has: `agy` exits 0,
    // writes no stderr, and records `status:"SUCCESS"` when its hooks fail, so
    // the durable marker written by the hook transport is what the action
    // reads. It is read for both modes — this is the verifier's old call site,
    // and a hook failure is not a property of the execution mode, so neither
    // mode may lose it. A healthy session writes no marker and this reads
    // nothing.
    const hookFailure = await readAntigravityHookFailure(sessionId);
    if (hookFailure !== undefined) {
      throw new AntigravitySessionFailureError('hook-failure', `Antigravity runtime hook failure (${hookFailure})`);
    }
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
    // A degraded drain is reported, not re-cast: the run itself succeeded, so
    // the export gap is surfaced at error level with both of its fields rather
    // than replacing a real outcome with a synthetic failure. This is a
    // stricter channel than the peer sessions have — none of them finalize
    // their transcript from the launcher at all.
    context.logger.error(`${input.actionName} transcript finalization degraded`, {
      sessionId,
      reason: finalization.reason,
      detail: finalization.detail
    });
  }

  // Settle before the mode split: both modes settle with the same policy and
  // differ only in who performs post-exit branch cleanup, and the settle has to
  // stay ahead of the cleanup watcher's on-disk status read in either mode.

  if (!isInteractive) {
    context.logger.info(`${input.actionName} background launch settled`, { sessionId });

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

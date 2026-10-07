/**
 * Shared session utilities for Claude Code action workflows.
 *
 * Provides reusable building blocks for actions that spawn the `claude` CLI:
 * plugin settings construction, CLI arg building, worktree slot acquisition. Both the `launch` and `interview` actions consume these
 * utilities.
 *
 * @summary Shared session utilities for Claude Code action workflows
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { type ActionContext, type ActionInput, CARDS_ENV_VARS } from '@cards.management/sdk';
import { execFileNoWindowAsync } from '@cards.management/sdk/bin/child-process';
import type { CardsClient } from '@cards.management/sdk/client';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { resolveClaudeConfigDir, updateMarketplaceRegistration } from '@cards.management/sdk/marketplace';

export { resolveClaudeConfigDir, updateMarketplaceRegistration };

import { createClaudeTerminationController } from './claude-termination.js';
import { spawnAgentCli } from './spawn-cli.js';
import { openSlotSession } from './worktrees/index.js';

const execFileAsync = execFileNoWindowAsync;

/**
 * Claude's own print-mode background-task wait ceiling diagnostic, emitted to
 * stderr immediately before it terminates a background session on its own
 * 600-second default (main-678). Background child envs force the ceiling to
 * unlimited (see {@link spawnClaudeSession}), but this string is still
 * latched in case an unrecognized future Claude build re-imposes a finite
 * ceiling silently ignoring the override.
 */
const CLAUDE_BACKGROUND_CEILING_DIAGNOSTIC = 'Background tasks still running after 600s; terminating.';

let _cliExecutable: string | undefined;

/**
 * Error thrown when the `claude` CLI cannot be resolved before a session spawn.
 */
export class ClaudeCliMissingError extends Error {
  override readonly name = 'ClaudeCliMissingError';

  constructor(cause: unknown) {
    super(
      'The `claude` CLI was not found on PATH. Install Claude Code and make sure `claude` resolves on PATH, ' +
        'or switch cards.defaultCodingAgent to another coding agent.'
    );
    this.cause = cause;
  }
}

/**
 * Resolves the CLI executable to use for spawning sessions.
 * Probes PATH for the `claude` CLI and fails closed when it is absent — the
 * session must launch the configured binary or error out explicitly, never an
 * unrelated substitute invoked with claude-specific flags it does not
 * understand. The result is cached for the process lifetime.
 *
 * @returns The CLI executable name.
 * @throws {ClaudeCliMissingError} When `claude` does not resolve on PATH.
 */
async function resolveCliExecutable(): Promise<string> {
  if (_cliExecutable !== undefined) return _cliExecutable;
  try {
    // `which` does not exist on native Windows; `where` is its equivalent.
    // Mirrors packages/extension/src/utils/nodeRuntime.ts. `where` prints to
    // stderr and exits non-zero when the executable is not found, which the
    // catch handles; on success it may print multiple lines (one per match).
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['claude']);
    _cliExecutable = 'claude';
  } catch (error) {
    throw new ClaudeCliMissingError(error);
  }
  return _cliExecutable;
}

/**
 * Extracts a human-readable message from an unknown catch value.
 * @param error - The caught value to extract a message from.
 * @returns The error message string.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves the stable marketplace symlink path set by ActionDispatcher.
 * Uses the MARKETPLACE_PATH environment variable which points to the
 * global-storage symlink rather than the versioned extension install path.
 *
 * @returns Absolute path to the marketplace directory.
 * @throws Error if MARKETPLACE_PATH is not set.
 */
export function resolveMarketplacePath(): string {
  const value = process.env[CARDS_ENV_VARS.MARKETPLACE_PATH];
  if (!value) {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.MARKETPLACE_PATH}`);
  }
  return value;
}

/**
 * Builds the `--settings` JSON that enables the `runtime` plugin and registers
 * the `cards.management` marketplace source so the spawned `claude` process
 * can resolve the plugin from the extension's bundled marketplace.
 *
 * Uses the marketplace bundled inside the extension install directory
 * (`<EXTENSION_PATH>/dist/marketplace`) so the spawned session always loads the
 * plugin version that shipped with the extension, regardless of worktree state.
 *
 * @param marketplacePath - Absolute path to the bundled marketplace directory.
 * @returns Serialised settings JSON string.
 */
export function buildPluginSettings(marketplacePath: string): string {
  return JSON.stringify({
    enabledPlugins: { 'runtime@cards.management': true },
    extraKnownMarketplaces: {
      'cards.management': {
        source: { source: 'directory', path: marketplacePath }
      }
    }
  });
}

/**
 * Builds the CLI argument list for the `claude` process.
 *
 * @param prompt - The prompt string for new sessions. Omit for prompt-less sessions.
 * @param sessionId - Session identifier (used for `--session-id` or `--resume`).
 * @param resume - When true, passes `--resume` instead of starting a new session.
 * @param mode - Execution mode; `'background'` appends `--print`.
 * @param cardRepoPath - Absolute path passed via `--add-dir`.
 * @param marketplacePath - Absolute path to the bundled marketplace directory.
 * @returns Array of CLI arguments.
 */
export function buildArgs(
  prompt: string | undefined,
  sessionId: string,
  resume: boolean,
  mode: ActionInput['executionMode'],
  cardRepoPath: string,
  marketplacePath: string
): string[] {
  const args: string[] = [];

  if (resume) {
    args.push('--resume', sessionId);
  } else {
    if (prompt !== undefined) {
      args.push(prompt);
    }
    args.push('--session-id', sessionId);
  }
  args.push('--settings', buildPluginSettings(marketplacePath));
  args.push('--add-dir', cardRepoPath);
  args.push('--disallowed-tools', 'EnterPlanMode, ExitPlanMode, NotebookEdit, TodoWrite');
  args.push('--teammate-mode', 'in-process');
  // Temporarily disable as this creates an interactive warning dialog
  // args.push('--dangerously-load-development-channels', 'plugin:runtime@cards.management');
  if (mode === 'background') {
    args.push('--print');
  }

  return args;
}

/**
 * Extracts the card ID from a `cards/<cardId>/<n>` branch name.
 *
 * @param branchName - Branch name to parse.
 * @returns The card ID, or `null` if the branch doesn't match the pattern.
 */
function cardIdFromBranch(branchName: string): string | null {
  const match = branchName.match(/^cards\/(.+)\/\d+$/);
  return match?.[1] ?? null;
}

/**
 * Resolves the base branch for the workspace, following the `parentBranch`
 * chain when HEAD is a `cards/*` worktree branch.
 *
 * Card branches are ephemeral and not valid merge targets. When the workspace
 * HEAD happens to be on one (e.g., the main checkout was left on a card
 * branch), this function queries the API for that branch's `parentBranch`
 * and recurses until it finds a non-`cards/*` branch.
 *
 * @param workspacePath - Directory where `git rev-parse` runs.
 * @param client - Cards API client for resolving parentBranch of card branches.
 * @returns The first non-`cards/*` branch in the parent chain.
 * @throws Error if the parent chain cannot be resolved (missing API records, cycles).
 */
export async function resolveBaseBranch(workspacePath: string, client?: CardsClient): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workspacePath
  });
  let branch = stdout.trim();

  const visited = new Set<string>();
  while (branch.startsWith('cards/')) {
    if (visited.has(branch)) {
      throw new Error(`Circular parentBranch chain detected: ${[...visited, branch].join(' → ')}`);
    }
    visited.add(branch);

    const cardId = cardIdFromBranch(branch);
    if (!cardId || !client) {
      throw new Error(
        `Workspace HEAD is on card branch "${branch}" but cannot resolve its parent. ` +
          'Switch the main checkout to a non-card branch (e.g., main).'
      );
    }

    const { branches } = await client.getBranches(cardId, { workspacePath });
    const record = branches.find((b) => b.name === branch);
    if (!record?.parentBranch) {
      // Fallback: read card-level parentBranch from CARD.meta.json via API.
      // Parallel implementations: Router (POST /cards) and CardsViewProvider resolve via store.getBranches().
      let cardParentBranch: string | undefined;
      try {
        const card = await client.getCard(cardId);
        cardParentBranch = card.parentBranch;
      } catch (error) {
        console.warn(`resolveBaseBranch: getCard(${cardId}) failed, using branch-record error`, errorMessage(error));
      }
      if (cardParentBranch && !cardParentBranch.startsWith('cards/')) {
        return cardParentBranch;
      }
      throw new Error(
        `Card branch "${branch}" has no parentBranch record. ` +
          'Switch the main checkout to a non-card branch (e.g., main).'
      );
    }

    branch = record.parentBranch;
  }

  return branch;
}

/**
 * Options for {@link spawnClaudeSession}.
 *
 * Actions provide the variable parts (prompt, session identity, switch-to-
 * interactive support); the helper handles everything else: worktree
 * resolution, marketplace registration, env construction, spawn, lifecycle
 * callbacks, and owner-assigned checkout selection.
 */
export interface ClaudeSessionOptions {
  /** Prompt string passed to the Claude CLI. Omit for prompt-less sessions. */
  prompt?: string;
  /** Session identifier (used for `--session-id` or `--resume`). */
  sessionId: string;
  /** When true, passes `--resume` instead of starting a new session. */
  resume: boolean;
  /**
   * When true, registers {@link ActionContext.onSwitchToInteractive} so
   * background-mode sessions can be promoted to interactive.
   */
  supportsSwitchToInteractive: boolean;
  /**
   * Content injected into the Claude CLI via `--append-system-prompt`.
   * When provided, appended after all other arguments.
   */
  appendSystemPrompt?: string;
  /**
   * When true, overrides `EXIT_WHEN_DONE` to `'false'` in the child process
   * environment so the Agent context block and stop hook agree that
   * exit-when-done is disabled for the session.
   */
  suppressExitWhenDone?: boolean;
}

/**
 * Spawns a `claude` CLI session with full worktree, marketplace, and
 * lifecycle management.
 *
 * Centralises the spawn logic shared by the `launch` and `interview`
 * actions so environment variable construction, worktree resolution,
 * marketplace registration, and checkout selection cannot drift between
 * callers.
 *
 * Steps:
 * 1. Create {@link CardsClient}
 * 2. Resolve base branch and worktree
 * 3. Register marketplace
 * 4. Build CLI args and spawn `claude`
 * 5. Wire onCancel (and optionally onSwitchToInteractive)
 * 6. Capture stderr in background mode
 * 7. Await process exit
 *
 * @param input - Parsed action input from the environment.
 * @param context - Action context providing logger and lifecycle hooks.
 * @param options - Session-specific parameters (prompt, session ID, etc.).
 */
export async function spawnClaudeSession(
  input: ActionInput,
  context: ActionContext,
  options: ClaudeSessionOptions
): Promise<void> {
  const { prompt, sessionId, resume, supportsSwitchToInteractive, appendSystemPrompt } = options;

  context.logger.info(`${input.actionName} action started`, {
    cardId: input.cardId,
    environment: input.environment,
    executionMode: input.executionMode,
    sessionId
  });

  if (options.suppressExitWhenDone && input.exitWhenDone) {
    context.logger.info('stop-exit-when-done: exit-when-done accepted but ignored for interactive action', {
      actionName: input.actionName
    });
  }

  const client = await createCardsClient(context.logger, { workspacePath: input.repoRoot });
  if (!client) {
    throw new Error('Cards API discovery failed — cannot start session');
  }

  const baseBranch = await resolveBaseBranch(input.repoRoot, client);

  const session = await openSlotSession(input, { client, logger: context.logger });
  const { worktreePath: cwd, branch: branchName, parentBranch } = session.slot;
  context.logger.info('Using worktree', { cwd, branch: branchName, baseBranch, parentBranch });

  const marketplacePath = resolveMarketplacePath();
  await updateMarketplaceRegistration(marketplacePath, context.logger);

  const args = buildArgs(prompt, sessionId, resume, input.executionMode, input.cardRepoPath, marketplacePath);
  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }
  const isInteractive = input.executionMode === 'interactive';
  const cliExecutable = await resolveCliExecutable();

  const child: ChildProcess = await session.spawnAgent(() =>
    spawnAgentCli(cliExecutable, args, {
      cwd,
      stdio: isInteractive ? 'inherit' : ['ignore', 'ignore', 'pipe'],
      // Background mode: the handler running this is console-less (spawned from the
      // GUI extension host via pipes), so cross-spawn's `cmd.exe /c claude.cmd` hop
      // would pop a console window under stock node on win32. No stdio fd is
      // inherited here, so `windowsHide: true` is honored by libuv. The interactive
      // path inherits stdio and must NOT set it — R2: libuv ignores windowsHide
      // when any fd is inherited, and the correct fix there is the console-subsystem
      // interpreter switch, not this option.
      ...(isInteractive ? {} : { windowsHide: true }),
      env: {
        ...process.env,
        WORKSPACE_PATH: cwd,
        CLAUDE_CODE_TASK_LIST_ID: `cards-extension-${input.cardId}`,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '1',
        BASE_BRANCH: baseBranch,
        PARENT_BRANCH: parentBranch,
        WORKSPACE_BRANCH: branchName,
        // Claude's own print-mode background-task wait ceiling defaults to 600s
        // and otherwise fires before Cards decides the session is done, killing
        // agent-team work still in flight (main-678). Cards — not Claude — owns
        // a background action's lifetime via cancellation, shutdown, or natural
        // completion, so force this print-only setting to unlimited on every
        // background child, overriding any finite value inherited from the
        // parent env. Interactive sessions must not acquire this override.
        ...(isInteractive ? {} : { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }),
        ...(options.suppressExitWhenDone ? { [CARDS_ENV_VARS.EXIT_WHEN_DONE]: 'false' } : {})
      }
    })
  );

  // The start pass runs alongside the agent's start; it never rejects and never changes the outcome.
  session.beginCleanup();

  const termination = createClaudeTerminationController(child, {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 5_000
  });

  // Tracks whether Cards itself asked the session to end, so a subsequent
  // Claude-imposed ceiling diagnostic (below) does not override an outcome
  // Cards already owns.
  let cardsTerminationRequested = false;

  context.onCancel(async () => {
    cardsTerminationRequested = true;
    context.logger.info(`${input.actionName} action cancelled, terminating claude`, { sessionId });
    const result = await termination.terminate('cancel');
    context.logger.info(`${input.actionName} cancellation termination completed`, { sessionId, result });
  });

  if (supportsSwitchToInteractive) {
    context.onSwitchToInteractive(async () => {
      context.logger.info('Switching to interactive mode', { sessionId });
      // The handoff latch is set before the agent is stopped, so no exit path can release the slot [F10].
      const handoff = await session.offerHandoff(sessionId);
      child.kill('SIGTERM');
      return handoff;
    });
  }

  // Background mode: capture stderr for diagnostic logging, and latch
  // recognition of Claude's own background-task wait-ceiling diagnostic. The
  // diagnostic can arrive split across chunk boundaries, so matching is done
  // against a running tail rather than each chunk in isolation.
  let ceilingDiagnosticObserved = false;
  let stderrTail = '';
  if (!isInteractive) {
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const trimmed = text.trim();
      if (trimmed) {
        context.logger.warn(trimmed);
      }
      stderrTail += text;
      if (stderrTail.includes(CLAUDE_BACKGROUND_CEILING_DIAGNOSTIC)) {
        ceilingDiagnosticObserved = true;
      }
      // Keep only enough trailing context to catch a match split across the
      // next chunk boundary — checked above BEFORE truncating, so a match
      // straddling this boundary is never cut in half.
      stderrTail = stderrTail.slice(-(CLAUDE_BACKGROUND_CEILING_DIAGNOSTIC.length - 1));
    });
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });

  // The end pass spares this slot and is skipped after a switch; it never rejects.
  await session.finish();

  // Claude's print-mode wait ceiling terminated the session before Cards
  // decided the work was done — the child still exits 0, but this is not a
  // successful completion. Fail through the same channel as the settle-error
  // throw below, unless Cards itself already requested this termination.
  if (ceilingDiagnosticObserved && !cardsTerminationRequested) {
    throw new Error(
      `${input.actionName} action was terminated by Claude's 600s background-task wait ceiling before completing (exit code ${exitCode}); Cards did not request cancellation or shutdown.`
    );
  }

  context.logger.info(`${input.actionName} action completed`, { sessionId, exitCode });
}

/**
 * Shared session utilities for Claude Code action workflows.
 *
 * Provides reusable building blocks for actions that spawn the `claude` CLI:
 * plugin settings construction, CLI arg building, worktree lifecycle management,
 * and branch cleanup. Both the `launch` and `interview` actions consume these
 * utilities.
 *
 * @summary Shared session utilities for Claude Code action workflows
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fsSyncNs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type ActionContext, type ActionInput, CARDS_ENV_VARS, resolveWorktreeDir } from '@cards.management/sdk';
import { execFileNoWindowAsync } from '@cards.management/sdk/bin/child-process';
import { readCardStatus } from '@cards.management/sdk/bin/process-utils';
import type { CardsClient } from '@cards.management/sdk/client';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { compiledHookScriptPaths } from '@cards.management/sdk/git-hooks';
import { resolveClaudeConfigDir, updateMarketplaceRegistration } from '@cards.management/sdk/marketplace';
import { BRANCHES_DIR } from '@cards.management/sdk/protocol';

export { resolveClaudeConfigDir, updateMarketplaceRegistration };

import type { CreateWorktreeResult } from '@cards.management/sdk/worktree';
import { checkWorktreeExists, cleanupFailedWorktree, findGitRoots } from '@cards.management/sdk/worktree';
import { createWorktreeForCard } from '@cards.management/sdk/worktree-for-card';
import { createClaudeTerminationController } from './claude-termination.js';
import { spawnAgentCli } from './spawn-cli.js';

// The branch-cleanup watcher (branch-cleanup-watcher.ts) runs these helpers in a
// detached, console-less subprocess on win32; the `where`/`which` probe and all
// `git` calls force `windowsHide: true` via the SDK no-window helper so no
// per-call console window appears under stock node (no-op on POSIX and in the
// attached handler path).
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
 * Checks whether a worktree path exists on disk.
 *
 * @param worktreePath - Absolute path to test.
 * @returns True when the path is accessible.
 */
async function worktreeExistsOnDisk(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Machine code the Cards API reports for a lost card-repository ref
 * compare-and-swap (`ConcurrentCardWriteError` in the hybrid store).
 *
 * Every branch mutation commits through `git update-ref refs/heads/main $new
 * $parent`, which refuses the update when another writer advanced the ref
 * first. Two launches admitted close together on one card each commit to that
 * card repo — `addBranch` inside `createWorktreeForCard`, then the ownership
 * claim — so losing this race is the expected outcome of the card's headline
 * scenario, not a caller error. The allocator treats it as retryable rather
 * than surfacing a failed launch.
 */
const CARD_WRITE_CONFLICT_CODE = 'CONCURRENT_CARD_WRITE';

/**
 * How many consecutive card-write conflicts a single ownership claim absorbs
 * before failing closed. Each retry re-reads the branch record and re-issues
 * the claim, so the budget only has to cover the writers that can legitimately
 * interleave with one claim — a handful of simultaneous launches on one card,
 * plus cleanup and post-commit attribution.
 */
const CARD_WRITE_CONFLICT_RETRIES = 4;

/**
 * How many slot allocations one resolver invocation may abandon to card-write
 * contention before failing the launch instead of advancing again. Every
 * attempt creates and then rolls back a real worktree, so an unbounded advance
 * under sustained contention is a disk and CPU amplifier; the cap is far above
 * the worst case the plan models (five synchronized contenders).
 */
const SLOT_ALLOCATION_WRITE_CONFLICTS = 8;

/**
 * Reports whether an error carries a given machine-readable `code`.
 *
 * The Cards client surfaces server error codes as `ApiError.code`; the SDK's
 * own worktree helpers throw errors carrying their own `code` (for example
 * `BRANCH_REGISTRATION_CONFLICT`). Both shapes are detected identically so a
 * single catch site can classify every retryable contention outcome.
 *
 * @param error - Thrown value to inspect.
 * @param code - Machine-readable code to match.
 * @returns True when the value exposes that exact code.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

/**
 * Reports whether an error is a lost card-repository ref compare-and-swap.
 *
 * @param error - Thrown value to inspect.
 * @returns True for a card-write conflict.
 */
function isCardWriteConflict(error: unknown): boolean {
  return hasErrorCode(error, CARD_WRITE_CONFLICT_CODE);
}

/**
 * Releases a numbered slot this invocation registered but could not claim.
 *
 * A claim that fails after registration would otherwise abandon the checkout:
 * the worktree and its branch record exist, belong to no execution, and are
 * invisible to the reuse path (which only offers unowned branches it can
 * still claim). Repeated contention accumulates those slots, so the allocation
 * loop releases the one it just registered before advancing.
 *
 * Claims the creator revision for exclusive cleanup before removing Git
 * resources. Conditional unregister happens last. Contention preserves the
 * checkout, and failed teardown retains the cleanup claim for recovery.
 *
 * @param client - Cards API client used for the conditional unregister.
 * @param cardId - Card the slot belongs to.
 * @param repoRoot - Primary repository root that owns the worktree.
 * @param branchName - Branch this invocation registered for the slot.
 * @param worktreePath - Absolute worktree path this invocation created.
 * @param expectedRevision - Revision returned by the registration this invocation made.
 * @param sessionId - Coding-agent session ID forwarded for commit attribution.
 * @param logger - Logger for diagnostic output.
 */
async function releaseUnclaimedSlot(
  client: CardsClient,
  cardId: string,
  repoRoot: string,
  branchName: string,
  worktreePath: string,
  expectedRevision: string,
  sessionId: string | undefined,
  logger: ActionContext['logger']
): Promise<void> {
  const cleanupOwner = `cleanup:${randomUUID()}`;
  const claim = await client.updateBranchOwner(
    cardId,
    branchName,
    {
      expectedRevision,
      expectedOwner: { kind: 'none' },
      replacementOwner: cleanupOwner
    },
    sessionId ? { sessionId } : undefined
  );
  if (claim.outcome !== 'applied' || !claim.revision) {
    logger.info('Preserved unclaimed worktree — registration changed', { branch: branchName });
    return;
  }
  const failures = await cleanupFailedWorktree(repoRoot, worktreePath, branchName);
  if (failures.length > 0) {
    throw new Error(`Unclaimed worktree cleanup incomplete: ${failures.join('; ')}`);
  }
  const removal = await client.removeBranch(cardId, branchName, {
    expectedRevision: claim.revision,
    expectedCleanupOwner: cleanupOwner,
    ...(sessionId ? { sessionId } : {})
  });
  if (removal.outcome !== 'removed') throw new Error(`Cleanup claim changed for ${branchName}`);
  logger.info('Released unclaimed worktree slot', { branch: branchName, worktree: worktreePath });
}

/**
 * Finds or creates a worktree for the card.
 *
 * Tries to reuse an existing branch whose worktree is still on disk. When no
 * valid branch exists, creates a new one and registers it with the API. New
 * card-bound worktrees are provisioned with the per-worktree hook dispatcher
 * (compiled `.mjs` paths from the extension install).
 *
 * @param input - Action input containing cardId and workspace paths.
 * @param client - Cards API client for branch CRUD.
 * @param baseBranch - Current branch in the workspace (used as parent).
 * @param logger - Logger for diagnostic output.
 * @param sessionId - Coding-agent session ID forwarded to the API so the card repo post-commit hook can attribute the commit.
 * @returns Worktree path, branch name, parent branch name, and optional settle promise.
 */
export async function resolveOrCreateWorktree(
  input: ActionInput,
  client: CardsClient,
  baseBranch: string,
  logger: ActionContext['logger'],
  sessionId?: string
): Promise<{
  worktreePath: string;
  branchName: string;
  parentBranch: string;
  reason: 'reused' | 'reattached' | 'allocated';
  /** Settlement is completed before ownership is exposed, so this is normally absent. */
  settle?: Promise<CreateWorktreeResult>;
}> {
  if (
    typeof input.executionId !== 'string' ||
    !input.executionId.trim() ||
    !input.worktreeDirective ||
    !['reuse', 'allocate', 'preowned'].includes(input.worktreeDirective.kind)
  ) {
    throw new Error('Worktree allocation requires an admitted execution and authority directive');
  }
  const { branches } = await client.getBranches(input.cardId, { workspacePath: input.repoRoot });

  /**
   * Re-reads one branch record from the durable store, bypassing the snapshot.
   *
   * @param branchName - Branch to look up.
   * @returns The branch's current record, or `undefined` if the store no longer lists it.
   */
  const readBranch = async (branchName: string) =>
    (await client.getBranches(input.cardId, { workspacePath: input.repoRoot })).branches.find(
      (branch) => branch.name === branchName
    );

  const claim = async (branchName: string, revision: string, currentOwner?: string): Promise<boolean> => {
    if (currentOwner !== undefined && currentOwner !== input.executionId) return false;
    let expectedRevision = revision;
    let expectedOwner = currentOwner;
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await client.updateBranchOwner(
          input.cardId,
          branchName,
          {
            expectedRevision,
            expectedOwner:
              expectedOwner === undefined ? { kind: 'none' } : { kind: 'execution', executionId: expectedOwner },
            replacementOwner: input.executionId
          },
          sessionId ? { sessionId } : undefined
        );
        if (outcome.outcome === 'revision_conflict' || outcome.outcome === 'owner_conflict') return false;
        if (outcome.outcome !== 'applied' && outcome.outcome !== 'idempotent') {
          throw new Error(`Worktree ownership claim failed closed for ${branchName}: ${outcome.outcome}`);
        }
        return true;
      } catch (error) {
        // Ref contention can be retried only while the slot is still free or
        // already ours. Reading a sibling owner is a refusal, never permission
        // to turn allocation into an ownership transfer.
        if (!isCardWriteConflict(error) || attempt >= CARD_WRITE_CONFLICT_RETRIES) throw error;
        const current = await readBranch(branchName);
        if (current === undefined) return false;
        logger.info('Retrying worktree ownership claim after a card write conflict', {
          branch: branchName,
          attempt: attempt + 1
        });
        expectedRevision = current.revision;
        if (current.activeExecutionOwner !== undefined && current.activeExecutionOwner !== input.executionId)
          return false;
        expectedOwner = current.activeExecutionOwner;
      }
    }
  };

  // Step 1: Try to reuse an existing branch with a valid worktree on disk
  const directive = input.worktreeDirective;
  const preownedBranch =
    directive?.kind === 'preowned'
      ? branches.find(
          (branch) =>
            branch.name === directive.branch &&
            branch.worktree === directive.worktreePath &&
            branch.activeExecutionOwner === input.executionId
        )
      : undefined;
  if (directive?.kind === 'preowned' && preownedBranch === undefined) {
    throw new Error(`Pre-owned worktree assignment is not owned by execution ${input.executionId}`);
  }
  const reusableBranches = (
    preownedBranch !== undefined
      ? [preownedBranch]
      : branches.filter((branch) => branch.activeExecutionOwner === undefined)
  ).sort((a, b) => {
    const prefix = `cards/${input.cardId}/`;
    const aSlot = Number.parseInt(a.name.slice(prefix.length), 10);
    const bSlot = Number.parseInt(b.name.slice(prefix.length), 10);
    return (
      (Number.isNaN(aSlot) ? Number.MAX_SAFE_INTEGER : aSlot) -
        (Number.isNaN(bSlot) ? Number.MAX_SAFE_INTEGER : bSlot) || a.name.localeCompare(b.name)
    );
  });
  if (preownedBranch !== undefined) {
    if (!preownedBranch.exists || preownedBranch.worktree === undefined)
      throw new Error(`Pre-owned worktree assignment is unavailable for execution ${input.executionId}`);
    if (!(await worktreeExistsOnDisk(preownedBranch.worktree)))
      throw new Error(`Pre-owned worktree checkout is missing for execution ${input.executionId}`);
    logger.info('Using authority-transferred worktree', {
      branch: preownedBranch.name,
      worktree: preownedBranch.worktree
    });
    return {
      worktreePath: preownedBranch.worktree,
      branchName: preownedBranch.name,
      parentBranch: preownedBranch.parentBranch,
      reason: 'reused'
    };
  }
  for (const branch of directive?.kind !== 'allocate' ? reusableBranches : []) {
    if (!branch.exists || !branch.worktree) continue;
    if (!(await worktreeExistsOnDisk(branch.worktree))) continue;

    if (!(await claim(branch.name, branch.revision, branch.activeExecutionOwner))) continue;
    logger.info('Reusing existing worktree', { branch: branch.name, worktree: branch.worktree });
    return {
      worktreePath: branch.worktree,
      branchName: branch.name,
      parentBranch: branch.parentBranch,
      reason: 'reused'
    };
  }

  // Step 2: Try to create a worktree for an existing branch whose worktree
  // is missing from disk (e.g. cleaned up by a previous session crash).
  for (const branch of directive?.kind !== 'allocate' ? reusableBranches : []) {
    if (!branch.exists) continue;
    if (!branch.name.startsWith(`cards/${input.cardId}/`)) continue;
    if (branch.worktree && (await worktreeExistsOnDisk(branch.worktree))) continue;
    if (!(await claim(branch.name, branch.revision, branch.activeExecutionOwner))) continue;

    logger.info('Reattaching worktree for existing branch', { branch: branch.name });
    const { path: worktreePath, settle } = await createWorktreeForCard(client, branch.name, {
      cwd: input.repoRoot,
      cardId: input.cardId,
      compiledScriptPaths: compiledHookScriptPaths(input.extensionPath),
      parentBranch: branch.parentBranch,
      sessionId,
      registrationIntent: 'upsert'
    });

    await settle;
    return { worktreePath, branchName: branch.name, parentBranch: branch.parentBranch, reason: 'reattached' };
  }

  // Step 3: No valid existing branch — create new one.
  //
  // Since every creator now routes through createWorktreeForCard, a newly
  // created worktree is always registered in the API the instant it exists on
  // disk, so this codepath can no longer leave git ahead of the API for
  // worktrees it produces. This git-probe loop is therefore a defensive safety
  // net, not load-bearing reconciliation: it recovers from *pre-existing*
  // orphaned worktrees (created before this consolidation, or whose API record
  // was deleted out-of-band) by probing git's actual state and incrementing
  // past any occupied slots so we never collide with a worktree git already
  // knows about. It is retained deliberately — removing it would risk
  // clobbering a legacy orphan on a user's disk.
  const prefix = `cards/${input.cardId}/`;
  const existingNumbers = branches
    .filter((b) => b.name.startsWith(prefix))
    .map((b) => parseInt(b.name.slice(prefix.length), 10))
    .filter((n) => !Number.isNaN(n));
  let nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
  let writeConflicts = 0;

  const { repoRoot } = await findGitRoots(input.repoRoot);
  for (;;) {
    const branchName = `${prefix}${nextNumber}`;
    if (await checkWorktreeExists(repoRoot, resolveWorktreeDir(repoRoot, branchName))) {
      logger.warn('Worktree already exists in git but not in API, skipping', { branch: branchName });
      nextNumber++;
      continue;
    }

    try {
      const {
        path: worktreePath,
        settle,
        registrationRevision
      } = await createWorktreeForCard(client, branchName, {
        cwd: input.repoRoot,
        cardId: input.cardId,
        compiledScriptPaths: compiledHookScriptPaths(input.extensionPath),
        parentBranch: baseBranch,
        sessionId,
        registrationIntent: 'create'
      });

      await settle;
      let claimed: boolean;
      try {
        claimed = await claim(branchName, registrationRevision);
      } catch (error) {
        // The claim threw after this invocation registered the slot, so the
        // settlement path inside createWorktreeForCard never rolled it back.
        // Release the registration this invocation created before surfacing
        // the failure, or the checkout is abandoned unowned.
        await releaseUnclaimedSlot(
          client,
          input.cardId,
          repoRoot,
          branchName,
          worktreePath,
          registrationRevision,
          sessionId,
          logger
        );
        throw error;
      }
      if (!claimed) {
        await releaseUnclaimedSlot(
          client,
          input.cardId,
          repoRoot,
          branchName,
          worktreePath,
          registrationRevision,
          sessionId,
          logger
        );
        logger.info('Concurrent allocator claimed registered candidate; advancing', { branch: branchName });
        nextNumber++;
        continue;
      }

      logger.info('Created new worktree', { branch: branchName, worktree: worktreePath });
      return { worktreePath, branchName, parentBranch: baseBranch, reason: 'allocated' };
    } catch (error) {
      const registrationConflict = hasErrorCode(error, 'BRANCH_REGISTRATION_CONFLICT');
      const worktreeCollision =
        error instanceof Error && error.message.startsWith('Error: Worktree already exists at ');
      // Two launches admitted close together on one card both commit to that
      // card repo, and the loser of the ref compare-and-swap is expected to
      // retry rather than fail the launch. Advance to the next slot exactly as
      // for an occupied Git slot, bounded because every attempt creates and
      // rolls back a real worktree.
      const cardWriteConflict = isCardWriteConflict(error);
      if (cardWriteConflict) {
        writeConflicts++;
        if (writeConflicts > SLOT_ALLOCATION_WRITE_CONFLICTS) throw error;
      }
      if (!registrationConflict && !worktreeCollision && !cardWriteConflict) {
        throw error;
      }
      logger.info(
        cardWriteConflict
          ? 'Card repository write contention — advancing to the next slot'
          : 'Concurrent allocator claimed candidate slot; advancing',
        { branch: branchName, ...(cardWriteConflict ? { writeConflicts } : {}) }
      );
      nextNumber++;
    }
  }
}

/**
 * Finds processes whose current working directory is at or inside the given
 * directory.
 *
 * Scans `/proc/[pid]/cwd` symlinks for processes rooted under `dirPath`,
 * skipping the current process. Returns an empty array when `/proc` is
 * unavailable (non-Linux) or when `dirPath` does not resolve — callers must
 * treat "no processes found" as best-effort, not a guarantee of emptiness.
 *
 * @param dirPath - Absolute path to the directory to scan for rooted processes.
 * @param logger - Logger for diagnostic output.
 * @returns The pids whose cwd is at or under `dirPath`.
 */
async function findProcessesInDirectory(dirPath: string, logger: ActionContext['logger']): Promise<number[]> {
  const pids: number[] = [];

  let resolvedDir: string;
  try {
    resolvedDir = fsSyncNs.realpathSync(dirPath);
  } catch {
    return pids; // worktree path does not resolve — nothing to find
  }

  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return pids; // /proc not available (non-Linux)
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;

    try {
      const cwdLink = await fs.readlink(`/proc/${pid}/cwd`);
      if (cwdLink === resolvedDir || cwdLink.startsWith(`${resolvedDir}/`)) {
        pids.push(pid);
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') continue;
      logger.debug('Failed to read /proc cwd symlink', { pid, error: errorMessage(error) });
    }
  }

  return pids;
}

/**
 * Kills processes whose current working directory is inside the given directory.
 *
 * Sends SIGTERM to every process rooted under `dirPath`, waits briefly, then
 * SIGKILLs any survivors. Non-fatal: failures are logged, not thrown.
 *
 * @param dirPath - Absolute path to the directory whose child processes should be killed.
 * @param logger - Logger for diagnostic output.
 */
async function killProcessesInDirectory(dirPath: string, logger: ActionContext['logger']): Promise<void> {
  const pidsToKill = await findProcessesInDirectory(dirPath, logger);

  if (pidsToKill.length === 0) return;

  logger.info('Killing processes with cwd inside worktree', { dirPath, pids: pidsToKill });

  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logger.debug('SIGTERM failed', { pid, error: errorMessage(error) });
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));

  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        logger.debug('SIGKILL failed', { pid, error: errorMessage(error) });
      }
    }
  }
}

/**
 * Runs a cleanup step and propagates failures to the per-branch boundary.
 * Later destructive steps on that branch stop, retaining the cleanup claim;
 * the sweep can still process other branches.
 *
 * @param step - Async operation to attempt.
 * @param label - Human-readable label logged on failure.
 * @param branchName - Branch name included in diagnostic output.
 * @param logger - Logger for diagnostic output.
 */
async function tryCleanupStep(
  step: () => Promise<unknown>,
  label: string,
  branchName: string,
  logger: ActionContext['logger']
): Promise<void> {
  try {
    await step();
  } catch (error) {
    logger.warn(label, { branch: branchName, error: errorMessage(error) });
    throw error;
  }
}

/**
 * Options for {@link cleanupMergedBranches}.
 */
export interface CleanupOptions {
  /**
   * Maximum total elapsed time (ms) for the exponential-backoff liveness
   * gate.  When a worktree is in use the sweep retries with doubling delay
   * until the blocking processes exit or this total has elapsed, whichever
   * happens first.  Default: 3,600,000 (1 hour).
   */
  backoffMaxMs?: number;
}

/**
 * A single parsed entry from the card repository's `branches/` directory.
 */
export interface BranchEntry {
  /** Execution currently owning this checkout; claimed entries are never reclaimed. */
  activeExecutionOwner?: string;
  /** Absolute path to the worktree backing this branch, if one was created. */
  worktree?: string;
  /** The branch this entry was created from; cleanup checks merge status against it. */
  parentBranch: string;
  /** ISO timestamp recording when the entry was created. */
  addedAt: string;
}

/**
 * Reads and parses the per-branch entry files from a card repository's
 * `branches/` directory.
 *
 * The authoritative branch name lives in each file's `name` field, never the
 * filename. A missing `branches/` directory (nothing tracked yet) is treated
 * as no candidates, not an error. A single unreadable or malformed record is
 * contained to itself — it is skipped with a warning naming the file while
 * the remaining healthy records still parse; records whose `name` is not a
 * non-empty string are ignored for the same reason. Directory-level failures
 * still propagate.
 *
 * @param cardRepoPath - Absolute path to the card's git repository.
 * @param logger - Logger for per-record skip diagnostics.
 * @returns Parsed `[branchName, entry]` pairs, or `[]` if `branches/` does not exist.
 */
export async function readBranchEntries(
  cardRepoPath: string,
  logger: ActionContext['logger']
): Promise<Array<[string, BranchEntry]>> {
  const branchesDir = path.join(cardRepoPath, BRANCHES_DIR);
  try {
    const files = (await fs.readdir(branchesDir)).filter((f) => f.endsWith('.json'));
    const parsed: Array<[string, BranchEntry]> = [];
    for (const file of files) {
      const filePath = path.join(branchesDir, file);
      let record: ({ name: string } & BranchEntry) | null;
      try {
        record = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      } catch (error) {
        logger.warn('Skipping unreadable branch record', { file: filePath, error: errorMessage(error) });
        continue;
      }
      if (record === null || typeof record.name !== 'string' || record.name.length === 0) {
        logger.warn('Ignoring branch record without a usable name', { file: filePath });
        continue;
      }
      parsed.push([record.name, record]);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Outcome of a single branch's cleanup attempt, or a single sentinel entry
 * (`branch: '(all)'`) describing why the entire sweep was skipped.
 */
export interface BranchCleanupOutcome {
  /** Card ID the sweep ran for. */
  cardId: string;
  /** Branch name, or `'(all)'` for a sweep-wide skip. */
  branch: string;
  /** What happened to this branch. */
  action: 'cleaned' | 'skipped' | 'error';
  /** Short machine-readable reason for the action. */
  reason: string;
}

/**
 * Durable ownership of one branch, read from the Cards store at the moment a
 * reclamation decision is about to be made.
 *
 * `free` is the only state that permits destruction. `owned` and `unreadable`
 * both protect the checkout: cleanup never guesses that an unproven branch is
 * available.
 */
type BranchOwnership =
  | { state: 'free'; revision: string }
  | { state: 'owned'; owner: string }
  | { state: 'unreadable'; detail: string };

/**
 * Reads the durable active-execution claim for one branch, fresh, at the point
 * of decision.
 *
 * A sweep must never decide from a snapshot taken before it started: a claim
 * that lands while an earlier branch is being checked would otherwise be
 * invisible, and a claimed-but-not-yet-spawned checkout — one with no process
 * in it at all — would be classified as free.
 *
 * Every failure mode resolves to `unreadable`, which callers treat exactly like
 * `owned`: a listing that could not be read, and a branch the store does not
 * know about at all, are both evidence we cannot disprove ownership.
 *
 * @param client - Cards API client used for the durable read.
 * @param cardId - Card the branch belongs to.
 * @param repoRoot - Workspace root qualifying the branch listing.
 * @param branchName - Branch whose ownership is being resolved.
 * @param logger - Logger for diagnostic output.
 * @returns The branch's durable ownership state.
 */
async function readBranchOwnership(
  client: CardsClient,
  cardId: string,
  repoRoot: string,
  branchName: string,
  logger: ActionContext['logger']
): Promise<BranchOwnership> {
  let record: Awaited<ReturnType<CardsClient['getBranches']>>['branches'][number] | undefined;
  try {
    const { branches } = await client.getBranches(cardId, { workspacePath: repoRoot });
    record = branches.find((branch) => branch.name === branchName);
  } catch (error) {
    logger.warn('Cannot read durable branch ownership — treating the branch as claimed', {
      branch: branchName,
      error: errorMessage(error)
    });
    return { state: 'unreadable', detail: 'branch-listing-failed' };
  }
  if (record === undefined) {
    return { state: 'unreadable', detail: 'ownership-ambiguous' };
  }
  if (record.activeExecutionOwner !== undefined) {
    return { state: 'owned', owner: record.activeExecutionOwner };
  }
  return { state: 'free', revision: record.revision };
}

/**
 * Removes branches that are fully merged into their parent branch.
 *
 * For each merged branch the worktree directory is removed, the local branch
 * ref is deleted, and the branch record is conditionally unregistered through
 * the store. Worktree removal failures are logged and do not block branch
 * deletion. However, the branch record is only removed after confirming the
 * git branch was deleted — removing the record while the branch still exists
 * would cause subsequent sessions to lose track of it and create duplicates.
 *
 * Reclamation is decided by durable instance ownership, never by a process
 * scan. Immediately before any destructive step, the branch's active-execution
 * claim is re-read from the store — not taken from the snapshot the sweep
 * started with — so a claim that lands mid-sweep still protects the checkout.
 * A claimed, missing, or unreadable record is skipped: a process scan that
 * happens to find nothing cannot authorize destruction, and neither can the
 * absence of a claim we failed to read. The process scan is retained as a
 * conservative veto and for diagnostics, but it only ever prevents cleanup.
 *
 * The record is then removed with the store's conditional path, naming the
 * exact revision the ownership read returned. A newer registration — a claim
 * that landed after the read — leaves the record `preserved` rather than
 * deleting it from beneath its new owner.
 *
 * Each branch is checked against its own `parentBranch` (the branch it was
 * created from), not the workspace's current HEAD. This ensures branches are
 * only cleaned up when truly merged into their intended target.
 *
 * Before doing anything else, the sweep checks the card's own status: an
 * `active` card must never have its worktree or branch reclaimed out from
 * under it, so the sweep is skipped entirely (no `branches/` read, no git
 * calls) when the card is active. The same fail-closed skip applies when the
 * status is unreadable (missing/corrupt/mid-write `CARD.meta.json`, or a
 * non-string status) — reported with reason `status-unreadable` — since we
 * cannot prove the card is safe to touch. It applies again when the Cards API
 * cannot be discovered at all: without a durable read there is no way to prove
 * any branch is free, so the whole sweep is skipped rather than reclaiming on
 * the strength of an unreadable store.
 *
 * A single branch's failure never aborts the sweep: per-branch faults (a
 * self-referential `parentBranch`, or any git/read error mid-branch) are
 * contained, recorded as an `error` outcome for that branch, and the sweep
 * continues to the next branch, always returning every accumulated outcome.
 * Unreadable or malformed `branches/*.json` records are contained even
 * earlier — skipped with a warning during the entry read ({@link readBranchEntries})
 * so one corrupt record can never wedge the whole card's cleanup. Only an
 * unrecoverable setup failure before any branch mutation (e.g. an
 * unusable `cardRepoPath` / `branches/` directory) propagates as a throw.
 *
 * @param input - Action input containing cardId and workspace paths.
 * @param cardRepoPath - Absolute path to the card's git repository.
 * @param logger - Logger for diagnostic output.
 * @param sessionId - Claude Code session ID set as CARDS_SESSION_ID in the git subprocess environment so the card repo post-commit hook can attribute the commit.
 * @param options - Optional configuration (backoffMaxMs bounds the conservative in-use veto).
 * @returns Per-branch cleanup outcomes, or a single sweep-wide skip outcome.
 */
export async function cleanupMergedBranches(
  input: Pick<ActionInput, 'cardId' | 'repoRoot'>,
  cardRepoPath: string,
  logger: ActionContext['logger'],
  sessionId?: string,
  options?: CleanupOptions
): Promise<BranchCleanupOutcome[]> {
  const cardStatus = await readCardStatus(cardRepoPath);
  if (cardStatus === 'active') {
    logger.info('Skipping branch cleanup — card is active', { cardId: input.cardId });
    return [{ cardId: input.cardId, branch: '(all)', action: 'skipped', reason: 'active' }];
  }
  // Fail closed: a missing, corrupt, or mid-write CARD.meta.json (or a non-string
  // status) reads back as null. We cannot prove the card is inactive, so we must
  // not reclaim its worktree/branch — treat unreadable status exactly like active.
  if (cardStatus === null) {
    logger.warn('Skipping branch cleanup — card status unreadable', { cardId: input.cardId });
    return [{ cardId: input.cardId, branch: '(all)', action: 'skipped', reason: 'status-unreadable' }];
  }

  // Durable ownership is the reclamation authority, so an undiscoverable store
  // is an unreadable authority — not permission to reclaim. Fail closed for the
  // whole card rather than per branch, so an outage costs one failed discovery
  // instead of one failed read per branch.
  const client = await createCardsClient();
  if (client === null) {
    logger.warn('Skipping branch cleanup — durable ownership is unreadable (Cards API discovery failed)', {
      cardId: input.cardId
    });
    return [{ cardId: input.cardId, branch: '(all)', action: 'skipped', reason: 'ownership-unreadable' }];
  }

  const outcomes: BranchCleanupOutcome[] = [];
  let t0 = performance.now();

  const entries = await readBranchEntries(cardRepoPath, logger);
  if (entries.length === 0) {
    logger.debug(`No ${BRANCHES_DIR}/ found, nothing to clean up`);
    return outcomes;
  }

  // Compute existence for each branch via git
  logger.debug(`Read ${BRANCHES_DIR}/`, {
    cardId: input.cardId,
    branchCount: entries.length,
    elapsedMs: Math.round(performance.now() - t0)
  });

  for (const [branchName, branchData] of entries) {
    // A single branch's failure must never abort the whole per-card sweep or
    // discard outcomes already accumulated for earlier branches (a workspace-wide
    // Clean Up Worktrees sweep would otherwise hide real, irreversible deletions
    // behind one card's later error). Contain every per-branch fault here, record
    // it as an 'error' outcome, and move on to the next branch.
    try {
      // Fast path only: this reads the snapshot taken when the sweep started,
      // so it can spare a claimed branch the git probes below, but it can never
      // authorize a reclamation. A claim landing after the snapshot is caught by
      // the fresh ownership read taken at the point of decision.
      if (branchData.activeExecutionOwner !== undefined) {
        outcomes.push({ cardId: input.cardId, branch: branchName, action: 'skipped', reason: 'in-use' });
        continue;
      }
      // Check if branch exists in git
      let branchExists = false;
      try {
        const result = await execFileAsync('git', ['branch', '--list', branchName], { cwd: input.repoRoot });
        branchExists = result.stdout.trim().length > 0;
      } catch (error) {
        logger.debug('git branch --list failed, treating as non-existent', {
          branch: branchName,
          error: errorMessage(error)
        });
      }

      if (!branchExists) {
        outcomes.push({ cardId: input.cardId, branch: branchName, action: 'skipped', reason: 'branch-not-found' });
        continue;
      }

      // Self-referential parentBranch is a corrupt state — `merge-base --is-ancestor X X`
      // trivially succeeds, so cleanup would incorrectly remove unmerged work.
      // Refuse to touch this branch, but keep sweeping the card's other branches.
      if (branchData.parentBranch === branchName) {
        logger.error('Branch has self-referential parentBranch — refusing to clean up', {
          cardId: input.cardId,
          branch: branchName
        });
        outcomes.push({
          cardId: input.cardId,
          branch: branchName,
          action: 'error',
          reason: 'self-referential-parent'
        });
        continue;
      }

      t0 = performance.now();
      try {
        // merge-base --is-ancestor exits non-zero when NOT an ancestor (not merged).
        // Check against the branch's own parentBranch, not the workspace HEAD.
        await execFileAsync('git', ['merge-base', '--is-ancestor', branchName, branchData.parentBranch], {
          cwd: input.repoRoot
        });
      } catch {
        // Expected for unmerged branches — skip cleanup
        logger.debug('Branch not merged, skipping cleanup', {
          branch: branchName,
          elapsedMs: Math.round(performance.now() - t0)
        });
        outcomes.push({ cardId: input.cardId, branch: branchName, action: 'skipped', reason: 'not-merged' });
        continue;
      }
      logger.debug('merge-base check completed (merged)', {
        branch: branchName,
        elapsedMs: Math.round(performance.now() - t0)
      });

      // Branch is merged — but the per-card sweep must never reclaim a worktree
      // that another action on this card is still using. A sibling action's
      // branch sitting at zero commits beyond its parent is trivially an ancestor
      // of that parent, so "merged" alone is too weak a signal to act on.
      //
      // The reclamation authority is durable instance ownership, read here —
      // at the point of decision, after the preliminary merge checks and not
      // from the snapshot this sweep started with — so a claim that landed
      // while an earlier branch was being checked still protects this
      // checkout. A claimed, absent, or unreadable record is skipped: we can
      // only act on ownership we have positively proven absent.
      const ownership = await readBranchOwnership(client, input.cardId, input.repoRoot, branchName, logger);
      if (ownership.state !== 'free') {
        logger.info('Skipping branch cleanup — durable ownership is not proven absent', {
          branch: branchName,
          ownership: ownership.state,
          ...(ownership.state === 'owned' ? { owner: ownership.owner } : { detail: ownership.detail })
        });
        outcomes.push({
          cardId: input.cardId,
          branch: branchName,
          action: 'skipped',
          reason: ownership.state === 'owned' ? 'in-use' : 'ownership-unreadable'
        });
        continue;
      }
      // The revision that proved ownership absent. Every destructive step below
      // is conditional on the record still carrying it; the liveness backoff can
      // run for up to an hour, so the check is refreshed again after that wait.
      let decisionRevision = ownership.revision;

      if (branchData.worktree) {
        // The process scan is retained as a conservative veto and as
        // diagnostics — never as the authorization to reclaim. Ownership has
        // already been proven absent above, so a process found here is either
        // an action that crashed before releasing its claim or work unrelated
        // to any instance; either way, cleanup waits rather than SIGKILLing an
        // agent and deleting its worktree out from under it. Finding *nothing*
        // proves nothing, which is why it cannot authorize reclamation.
        let liveProcesses = await findProcessesInDirectory(branchData.worktree, logger);
        if (liveProcesses.length > 0) {
          const BACKOFF_START_MS = 1000;
          const BACKOFF_MAX_MS = options?.backoffMaxMs ?? 3_600_000; // 1 hour
          let retries = 0;
          const backoffStart = performance.now();

          while (liveProcesses.length > 0) {
            const elapsed = performance.now() - backoffStart;
            if (elapsed >= BACKOFF_MAX_MS) break;

            const delay = Math.min(2 ** retries * BACKOFF_START_MS, BACKOFF_MAX_MS - elapsed);
            logger.info('Worktree in use — retrying with exponential backoff', {
              branch: branchName,
              worktree: branchData.worktree,
              pids: liveProcesses,
              retry: retries + 1,
              delayMs: Math.round(delay),
              elapsedS: Math.round(elapsed / 1000)
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
            liveProcesses = await findProcessesInDirectory(branchData.worktree, logger);
            retries++;
          }

          if (liveProcesses.length > 0) {
            logger.warn('Worktree still in use after backoff retries — skipping cleanup', {
              branch: branchName,
              worktree: branchData.worktree,
              pids: liveProcesses,
              retries,
              elapsedS: Math.round((performance.now() - backoffStart) / 1000)
            });
            outcomes.push({ cardId: input.cardId, branch: branchName, action: 'skipped', reason: 'in-use' });
            continue;
          }

          logger.info('Worktree liveness gate passed after backoff', {
            branch: branchName,
            worktree: branchData.worktree,
            retries,
            elapsedS: Math.round((performance.now() - backoffStart) / 1000)
          });
        }

        // Re-read ownership now that the liveness wait is over — this is the
        // point of decision for the destructive steps that follow, and the wait
        // above is exactly the window in which a sibling action could have
        // claimed the slot. FindProcesses-based liveness is only ever a veto:
        // finding no process proves nothing and cannot authorize removal, so
        // the claim read here remains the sole authority.
        const confirmed = await readBranchOwnership(client, input.cardId, input.repoRoot, branchName, logger);
        if (confirmed.state !== 'free') {
          logger.info('Skipping worktree reclamation — durable ownership is not proven absent', {
            branch: branchName,
            worktree: branchData.worktree,
            ownership: confirmed.state,
            ...(confirmed.state === 'owned' ? { owner: confirmed.owner } : { detail: confirmed.detail })
          });
          outcomes.push({
            cardId: input.cardId,
            branch: branchName,
            action: 'skipped',
            reason: confirmed.state === 'owned' ? 'in-use' : 'ownership-unreadable'
          });
          continue;
        }
        decisionRevision = confirmed.revision;
      }

      // Hold exclusive durable ownership through every destructive step. A crash
      // leaves the claim in place for explicit recovery, never a free checkout.
      const cleanupOwner = `cleanup:${randomUUID()}`;
      const claim = await client.updateBranchOwner(
        input.cardId,
        branchName,
        {
          expectedRevision: decisionRevision,
          expectedOwner: { kind: 'none' },
          replacementOwner: cleanupOwner
        },
        sessionId ? { sessionId } : undefined
      );
      if (claim.outcome !== 'applied' || !claim.revision) {
        outcomes.push({ cardId: input.cardId, branch: branchName, action: 'skipped', reason: 'in-use' });
        continue;
      }
      decisionRevision = claim.revision;

      if (branchData.worktree) {
        t0 = performance.now();
        await tryCleanupStep(
          () => killProcessesInDirectory(branchData.worktree!, logger),
          'Failed to kill processes in worktree',
          branchName,
          logger
        );
        await tryCleanupStep(
          () => execFileAsync('git', ['worktree', 'remove', '--force', branchData.worktree!], { cwd: input.repoRoot }),
          'Failed to remove worktree',
          branchName,
          logger
        );
        logger.debug('Worktree removal completed', {
          branch: branchName,
          elapsedMs: Math.round(performance.now() - t0)
        });
      }

      t0 = performance.now();
      let branchDeleted = false;
      try {
        await execFileAsync('git', ['branch', '-d', branchName], { cwd: input.repoRoot });
        branchDeleted = true;
      } catch (error) {
        logger.warn('Failed to delete branch', { branch: branchName, error: errorMessage(error) });
      }
      logger.debug('Branch deletion completed', {
        branch: branchName,
        branchDeleted,
        elapsedMs: Math.round(performance.now() - t0)
      });

      if (branchDeleted) {
        // Remove the record through the store's own conditional path rather
        // than editing branches/ and committing it directly. A direct commit
        // bypasses the revision CAS entirely: a claim that landed between the
        // ownership read and this point would be deleted along with the record
        // it protects. Naming the revision we read makes that race a no-op —
        // the store preserves a record it can no longer prove is the one we
        // inspected, and the sweep reports it as preserved instead of guessing.
        t0 = performance.now();
        try {
          const removal = await client.removeBranch(input.cardId, branchName, {
            expectedRevision: decisionRevision,
            expectedCleanupOwner: cleanupOwner,
            ...(sessionId ? { sessionId } : {})
          });
          if (removal.outcome === 'removed') {
            logger.info('Cleaned up merged branch', { branch: branchName });
            outcomes.push({ cardId: input.cardId, branch: branchName, action: 'cleaned', reason: 'merged' });
          } else {
            logger.info('Preserved branch record — a newer registration owns it', { branch: branchName });
            outcomes.push({ cardId: input.cardId, branch: branchName, action: 'skipped', reason: 'preserved' });
          }
        } catch (error) {
          logger.warn('Failed to remove branch record', { branch: branchName, error: errorMessage(error) });
          outcomes.push({
            cardId: input.cardId,
            branch: branchName,
            action: 'error',
            reason: 'branch-record-removal-failed'
          });
        }
        logger.debug('Card repo branch removal completed', {
          branch: branchName,
          elapsedMs: Math.round(performance.now() - t0)
        });
      } else {
        logger.info('Skipped branch record removal — git branch still exists', { branch: branchName });
        outcomes.push({ cardId: input.cardId, branch: branchName, action: 'error', reason: 'branch-delete-failed' });
      }
    } catch (error) {
      logger.logError(error, 'Branch cleanup failed — recording error and continuing sweep', {
        cardId: input.cardId,
        branch: branchName
      });
      outcomes.push({ cardId: input.cardId, branch: branchName, action: 'error', reason: 'branch-error' });
    }
  }

  return outcomes;
}

// ============================================================================
// Unified session spawner
// ============================================================================

/**
 * Options for {@link spawnClaudeSession}.
 *
 * Actions provide the variable parts (prompt, session identity, switch-to-
 * interactive support); the helper handles everything else: worktree
 * resolution, marketplace registration, env construction, spawn, lifecycle
 * callbacks, and post-exit branch cleanup.
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
 * marketplace registration, and post-exit cleanup cannot drift between
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
 * 8. Clean up fully-merged branches (background mode only; in interactive
 *    mode the watcher and extension handle cleanup after the action exits)
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

  const client = await createCardsClient(context.logger);
  if (!client) {
    throw new Error('Cards API discovery failed — cannot start session');
  }

  const baseBranch = await resolveBaseBranch(input.repoRoot, client);

  const worktreeResult = await resolveOrCreateWorktree(input, client, baseBranch, context.logger, sessionId);

  const { worktreePath: cwd, branchName, parentBranch, reason, settle } = worktreeResult;
  await context.reportWorktreeAssignment({ branch: branchName, worktreePath: cwd, reason });
  context.logger.info('Using worktree', { cwd, branch: branchName, baseBranch, parentBranch, reason });

  const marketplacePath = resolveMarketplacePath();
  await updateMarketplaceRegistration(marketplacePath, context.logger);

  const args = buildArgs(prompt, sessionId, resume, input.executionMode, input.cardRepoPath, marketplacePath);
  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }
  const isInteractive = input.executionMode === 'interactive';
  const cliExecutable = await resolveCliExecutable();

  const child: ChildProcess = spawnAgentCli(cliExecutable, args, {
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
  });

  // A settle rejection means createWorktree tore the worktree down (the
  // settle-failure cleanup removed it) — the agent must never run in a
  // missing or unprovisioned worktree. Fail the launch loudly: kill the
  // spawned agent and surface the settle error below instead of logging and
  // continuing. If the child already exited when the rejection lands, the
  // kill is a no-op but the throw below still fails the action — a completed
  // agent session in a worktree that was just removed is not a success to
  // report, and the worktree is already cleaned up for the next launch.
  let settleError: unknown;
  if (settle) {
    settle.catch((error: unknown) => {
      settleError = error;
      context.logger.error('Worktree settle failed — aborting launch', { error: errorMessage(error) });
      child.kill('SIGTERM');
    });
  }

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
    context.onSwitchToInteractive(() => {
      context.logger.info('Switching to interactive mode', { sessionId });
      child.kill('SIGTERM');
      return { sessionId };
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

  // Claude's print-mode wait ceiling terminated the session before Cards
  // decided the work was done — the child still exits 0, but this is not a
  // successful completion. Fail through the same channel as the settle-error
  // throw below, unless Cards itself already requested this termination.
  if (ceilingDiagnosticObserved && !cardsTerminationRequested) {
    throw new Error(
      `${input.actionName} action was terminated by Claude's 600s background-task wait ceiling before completing (exit code ${exitCode}); Cards did not request cancellation or shutdown.`
    );
  }

  // Fail the launch loudly when the settle phase rejected: the agent was
  // killed and the worktree is gone, so the action must not report a normal
  // completion (post-exit cleanup has nothing meaningful to do either — the
  // settle-failure cleanup already removed the worktree).
  if (settleError !== undefined) {
    throw settleError instanceof Error ? settleError : new Error(String(settleError));
  }

  context.logger.info(`${input.actionName} action completed`, { sessionId, exitCode });

  // Settle the card's status before the post-exit sweep can read it. The
  // sweep's first gate is the on-disk status, which otherwise races this exit
  // path from a separate process — a sweep that wins the race skips the card
  // as `active` and no later attempt is ever scheduled. See
  // Post-exit cleanup: remove fully-merged branches.
  // In background mode there is no watcher, so we run cleanup inline.
  // In interactive mode we spawn a detached process so the terminal closes
  // immediately — the watcher calls the same cleanupMergedBranches function.
  if (isInteractive) {
    try {
      let candidates: Array<[string, BranchEntry]> = [];
      try {
        candidates = await readBranchEntries(input.cardRepoPath, context.logger);
      } catch (error) {
        context.logger.warn('Failed to read branch entries before spawning watcher (non-fatal)', {
          error: errorMessage(error),
          sessionId
        });
      }
      context.logger.info('Branch-cleanup watcher spawn attempt', {
        cardId: input.cardId,
        sessionId,
        candidateBranches: candidates.map(([name]) => name)
      });

      const { resolveInterimSelfWatcherPath, spawnBranchCleanupWatcher } = await import('./branch-cleanup-watcher.js');
      // TODO(main-711/sdk-protocol Phase 3): pass the resolved installed
      // binary path from `context.reportBranchCleanupRegistration(...)` once
      // it lands, instead of this module's own interim self-invocation path.
      await spawnBranchCleanupWatcher(
        {
          cardId: input.cardId,
          repoRoot: input.repoRoot,
          cardRepoPath: input.cardRepoPath,
          sessionId
        },
        context.logger,
        resolveInterimSelfWatcherPath()
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.warn('Failed to spawn branch-cleanup watcher (non-fatal)', { error: message, sessionId });
    }
  } else {
    const cleanupStart = performance.now();
    try {
      await cleanupMergedBranches(input, input.cardRepoPath, context.logger, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('self-referential parentBranch') || message.includes('data corruption')) {
        throw error;
      }
      context.logger.warn('Post-exit cleanup failed (non-fatal)', { error: message, sessionId });
    }
    context.logger.debug('Post-exit cleanup finished', {
      sessionId,
      elapsedMs: Math.round(performance.now() - cleanupStart)
    });
  }
}

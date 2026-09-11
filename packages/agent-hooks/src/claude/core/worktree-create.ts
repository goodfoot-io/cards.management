/**
 * WorktreeCreate hook that creates a Cards-managed git worktree.
 *
 * Fails closed: any error on the create path is rethrown so the runtime exits
 * non-zero and the harness aborts launch. When the worktree is card-bound, it
 * is registered with the Cards API via `createWorktreeForCard` — discovery
 * failure (no client) throws rather than leaving an unregistered worktree on
 * disk. Unbound worktrees skip the API entirely: the parent branch is recorded
 * as `branch.<name>.cardsParent` git config and the worktree is added to the
 * per-session unbound-candidate set so `cards create` can bind it later. The
 * worktree path is returned only after `settle` resolves, ensuring symlinks and
 * node_modules rerouting are complete before the agent uses the directory.
 *
 * @summary WorktreeCreate hook for Cards-managed worktrees
 * @module worktree-create
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveExtensionPath } from '@cards.management/sdk';
import { resolveWorktreeCardId } from '@cards.management/sdk/adhoc-attribution';
import { resolveCardsParentBranch, writeCardsParentConfig } from '@cards.management/sdk/cards-parent-branch';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { compiledHookScriptPaths } from '@cards.management/sdk/git-hooks';
import { addUnboundCandidate } from '@cards.management/sdk/unbound-worktree-candidates';
import { createWorktree, type EarlyWorktreeResult } from '@cards.management/sdk/worktree';
import { createWorktreeForCard } from '@cards.management/sdk/worktree-for-card';
import { worktreeCreateHook, worktreeCreateOutput } from '@goodfoot/agent-hooks/claude-code';
import { applyDefaultLogFile } from '../../shared/default-log-file.js';

const execFileAsync = promisify(execFile);

/**
 * Resolves the current branch name of the git repo at `cwd`.
 *
 * Mirrors the start point `createWorktree` resolves the new branch from (the
 * source repo's HEAD). Only correct as a *parent* branch when `cwd` is the
 * main working tree — see {@link resolveParentBranch} for the full derivation.
 *
 * @param cwd - Working directory inside the source git repository.
 * @returns The abbreviated current branch name (e.g. `main`).
 */
async function resolveCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  // In a detached-HEAD source repo `--abbrev-ref HEAD` returns the literal
  // "HEAD". Recording that as the parent branch corrupts lineage metadata, so
  // fail closed (the create path aborts launch) rather than write a bogus value.
  if (branch === 'HEAD') {
    throw new Error(
      'WorktreeCreate: source repository is in detached-HEAD state; cannot derive a parent branch for the card-bound worktree'
    );
  }
  return branch;
}

/**
 * Returns `true` when `cwd` sits inside a *linked* git worktree (as opposed to
 * the main working tree).
 *
 * A linked worktree's `--git-dir` (`<repo>/.git/worktrees/<name>`) differs from
 * its `--git-common-dir` (`<repo>/.git`); in the main working tree the two
 * resolve to the same directory.
 *
 * @param cwd - Working directory inside a git repository.
 * @returns `true` when `cwd` is in a linked worktree.
 */
async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    cwd,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir'
  ]);
  const [gitDir, commonDir] = stdout.trim().split('\n');
  return gitDir !== commonDir;
}

/**
 * Derives the `parentBranch` recorded for a new worktree, since the
 * WorktreeCreate hook input carries no base branch.
 *
 * When `cwd` is the **main working tree**, its current branch is the correct
 * parent (failing closed on detached HEAD). When `cwd` is a **linked
 * worktree**, the worktree's own branch is never its own parent — the branch's
 * own lineage parent is resolved via `resolveCardsParentBranch` (durable
 * `branch.<name>.cardsParent` config first, then reflog decoration that skips
 * the worktree's own branch). On a `refuse` result this throws so the create
 * path fails closed rather than recording a bogus parent.
 *
 * @param cwd - Working directory inside the source git repository.
 * @returns The parent branch name (e.g. `main`).
 */
async function resolveParentBranch(cwd: string): Promise<string> {
  if (!(await isLinkedWorktree(cwd))) {
    return resolveCurrentBranch(cwd);
  }
  const result = await resolveCardsParentBranch(cwd);
  if (result.kind === 'refuse') {
    throw new Error(`WorktreeCreate: cannot derive a parent branch from inside a linked worktree: ${result.reason}`);
  }
  return result.parentBranch;
}

export default worktreeCreateHook({}, async (input, { logger }) => {
  // Point hook file logging at <mainRepoRoot>/.cards/logs/claude-code-cards-api-hooks.log,
  // computed from the payload cwd. No-op under an explicit CLAUDE_CODE_HOOKS_LOG_FILE.
  applyDefaultLogFile(input.cwd);

  const start = Date.now();

  // Resolve the pre-bind card association from the same two sources, in the same
  // order, as the EnterWorktree hook (enter-worktree.ts): an explicit CARD_ID in
  // the environment wins, and when it is absent the card id is resolved by
  // walking up from the creation directory for a `.cards/CARD_ID` marker. This
  // lets a nested worktree inherit its parent worktree's binding. The two hooks
  // resolve byte-for-byte the same id so they can never disagree about which
  // card a given worktree belongs to. When neither source yields an id the
  // worktree is created unbound: its parent branch is recorded as git config
  // and it is added to the per-session unbound-candidate set so `cards create`
  // can bind it later.
  const cardId = process.env['CARD_ID']?.trim() || (await resolveWorktreeCardId(input.cwd));

  logger.info('WorktreeCreate', {
    event: 'WorktreeCreate',
    name: input.name,
    cwd: input.cwd,
    cardId: cardId ?? null
  });

  let created: EarlyWorktreeResult;

  if (cardId) {
    const extensionPath = await resolveExtensionPath();
    const compiledScriptPaths = compiledHookScriptPaths(extensionPath);

    // Fail-closed: a card-bound worktree must never exist on disk without a
    // branch record. If the API cannot be discovered, abort launch rather than
    // create an unregistered worktree.
    // retryOnNetworkError is disabled so an unreachable/stale-discovery server
    // surfaces promptly (fail-closed throw) instead of retrying forever after
    // the worktree already exists on disk.
    const client = await createCardsClient(logger, { retryOnNetworkError: false });
    if (client === null) {
      throw new Error('WorktreeCreate: Cards API unavailable; cannot register card-bound worktree');
    }

    // The WorktreeCreate hook input carries no base branch, so derive the
    // parent branch from the source repo: the current HEAD in the main working
    // tree, or the worktree branch's own lineage parent in a linked worktree.
    const parentBranch = await resolveParentBranch(input.cwd);

    created = await createWorktreeForCard(client, input.name, {
      cwd: input.cwd,
      cardId,
      compiledScriptPaths,
      parentBranch,
      sessionId: input.session_id,
      registrationIntent: 'create'
    });
  } else {
    // Derive parentBranch before creating the worktree — it is the only point
    // at which the source repo HEAD is definitively knowable. Fail closed on
    // detached HEAD (and on an unresolvable linked-worktree lineage) for the
    // same reason as the card-bound path.
    const parentBranch = await resolveParentBranch(input.cwd);
    created = await createWorktree(input.name, { cwd: input.cwd });

    // Record the parent branch as durable git config on the new branch, so
    // bind-time `cards create` can recover it via `resolveCardsParentBranch`.
    // Written after the branch exists on disk (createWorktree created it). The
    // new branch name matches input.name (createWorktree names it after the
    // worktree). Fails closed — any write failure aborts launch.
    await writeCardsParentConfig(created.path, input.name, parentBranch);

    // Feed the per-session unbound-candidate set so `cards create` invoked from
    // outside this worktree can discover and bind it. The session is the
    // worktree-creating session; the transcript is recorded for attribution at
    // bind time.
    await addUnboundCandidate(input.session_id, created.path, input.transcript_path);
  }

  const { path: worktreePath, settle } = created;
  const result = await settle;

  logger.info('WorktreeCreate complete', {
    event: 'WorktreeCreate',
    name: input.name,
    worktreePath,
    cardId: cardId ?? null,
    elapsedMs: Date.now() - start,
    result
  });

  return worktreeCreateOutput({ worktreePath });
});

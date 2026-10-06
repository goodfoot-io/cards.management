/**
 * CLI entrypoint for removing Cards-managed git worktrees.
 *
 * Accepts a single worktree path argument. When the worktree is card-bound (a
 * `.cards/CARD_ID` marker is present), its branch record is also unregistered
 * via `removeWorktreeForCard`; a missing client or a failed `removeBranch` is
 * logged to stderr but does not fail the command (fail-open on branch
 * unregister). Unbound worktrees fall back to the bare `removeWorktree`. The
 * command exits 0 when the worktree is removed, even if the branch unregister
 * failed. A slot or a path outside the worktrees root is refused before any
 * of that, with only the refusal on stderr.
 *
 * Exit codes: 0 success, 2 usage or worktree-removal failure.
 *
 * @summary CLI for git worktree removal
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import { assertWorktreeRemovable, removeWorktree } from '@cards.management/sdk/worktree';
import { BranchUnregisterError, removeWorktreeForCard } from '@cards.management/sdk/worktree-for-card';

const execFileAsync = promisify(execFile);

const USAGE = 'Usage: remove-worktree <path>\n';

const args = process.argv.slice(2);
let worktreePath: string | undefined;

for (const arg of args) {
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (worktreePath === undefined) {
    worktreePath = arg;
  } else {
    process.stderr.write(USAGE);
    process.exit(2);
  }
}

if (!worktreePath) {
  process.stderr.write(USAGE);
  process.exit(2);
}

/**
 * Reads the `.cards/CARD_ID` marker from a worktree, returning the trimmed card
 * ID or `undefined` when the marker is absent (an unbound worktree).
 *
 * @param dir - Absolute path to the worktree directory.
 * @returns The card ID, or `undefined` if no marker exists.
 */
async function readWorktreeCardId(dir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, '.cards', 'CARD_ID'), 'utf-8');
    return raw.trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Resolves the registered branch name for a worktree from its current HEAD.
 *
 * Returns `undefined` when HEAD is detached (`--abbrev-ref` yields the literal
 * `"HEAD"`): the branch name cannot then be confidently matched against the
 * registered record, so the caller skips the branch unregister rather than
 * removing the wrong record or claiming success on an unreliable name.
 *
 * @param dir - Absolute path to the worktree directory.
 * @returns The branch name, or `undefined` when HEAD is detached.
 */
async function resolveWorktreeBranch(dir: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  return branch === 'HEAD' ? undefined : branch;
}

async function main(): Promise<void> {
  // Refuse a slot or an out-of-scope path first, so its refusal is all the
  // user reads: no removal warning, branch lookup or Cards API call precedes it.
  await assertWorktreeRemovable(worktreePath!);
  // Resolve the card binding from disk before removal: the marker yields the
  // cardId and HEAD yields the exact registered branch name (spike S2).
  const cardId = await readWorktreeCardId(worktreePath!);
  const branchName = cardId === undefined ? undefined : await resolveWorktreeBranch(worktreePath!);

  if (cardId === undefined || branchName === undefined) {
    // Unbound worktree (no marker) or detached HEAD (branch name unreliable):
    // no branch record can be confidently unregistered. Tear down the worktree
    // from disk; do not silently claim a branch was unregistered.
    if (cardId !== undefined) {
      process.stderr.write(
        'Warning: worktree HEAD is detached; branch record could not be resolved, removing worktree only\n'
      );
    }
    await removeWorktree(worktreePath!);
    return;
  }

  // Fail-open: a missing client or a failed removeBranch must never fail the
  // command. Remove the worktree regardless, logging the orphaned record.
  // retryOnNetworkError is disabled so an unreachable server fails fast after
  // the disk teardown rather than hanging the command forever.
  const client = await createCardsClient(undefined, { retryOnNetworkError: false });
  if (client === null) {
    process.stderr.write('Warning: Cards API unavailable; removing worktree without unregistering branch\n');
    await removeWorktree(worktreePath!);
    return;
  }

  try {
    await removeWorktreeForCard(client, worktreePath!, { cardId, branchName });
  } catch (error) {
    // Classify by phase via error type, not by path existence. A
    // BranchUnregisterError means the worktree was torn down and only the
    // recoverable branch record is orphaned — log and exit 0. Any other error
    // is a teardown failure; rethrow so main()'s catch exits 2.
    if (!(error instanceof BranchUnregisterError)) {
      throw error;
    }
    process.stderr.write(
      `Warning: branch unregister failed; worktree removed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

main()
  .then(() => {
    // Let the event loop drain rather than forcing `process.exit(0)`. The
    // CardsClient request leaves a short-lived keep-alive socket; on Windows a
    // forced exit races libuv tearing that socket (and the git child's process
    // handle) down and trips a fatal libuv assertion (async.c, 0xC0000409). The
    // unref'd timer is a fail-closed backstop that cannot itself keep the loop
    // alive, so the normal path still exits promptly.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 5_000).unref();
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 5_000).unref();
  });

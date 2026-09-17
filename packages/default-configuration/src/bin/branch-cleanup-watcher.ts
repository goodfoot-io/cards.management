/**
 * Thin CLI entry for the installed `branch-cleanup-watcher` binary.
 *
 * The extension's branch-cleanup effect authority
 * (`packages/extension/src/runtime/branchCleanupEffect.ts`) spawns this
 * wrapper directly and passes cleanup parameters as environment variables
 * (`CARD_ID`, `REPO_ROOT`, `CARD_REPO_PATH`, optionally `CARDS_SESSION_ID`) —
 * never over stdin or argv, so no program path or session data travels
 * through a spawned command line. This entry reads them the same way any
 * other action/hook entry point does, then delegates to
 * {@link runBranchCleanupWorker}.
 *
 * @summary Installed-binary CLI entry for the branch-cleanup watcher
 * @module
 */

import { CARDS_ENV_VARS, getCardId, getCardRepoPath, getRepoRoot } from '@cards.management/sdk/config/env';
import { Logger } from '@cards.management/sdk/config/logger';
import { runBranchCleanupWorker } from '../lib/branch-cleanup-watcher.js';

/**
 * Reads {@link BranchCleanupParams} off the environment, runs the worker to
 * completion, and sets the process exit code accordingly.
 */
export async function main(): Promise<void> {
  const logger = new Logger();
  try {
    const sessionId = process.env[CARDS_ENV_VARS.CARDS_SESSION_ID];
    const params = {
      cardId: getCardId(),
      repoRoot: getRepoRoot(),
      cardRepoPath: getCardRepoPath(),
      ...(sessionId ? { sessionId } : {})
    };
    process.exitCode = await runBranchCleanupWorker(params, logger);
  } finally {
    logger.close();
  }
}

if (process.argv[1]?.endsWith('branch-cleanup-watcher.mjs') || process.argv[1]?.endsWith('branch-cleanup-watcher.ts')) {
  main().catch((error) => {
    process.stderr.write(`branch-cleanup-watcher: fatal error: ${String(error)}\n`);
    process.exitCode = 1;
  });
}

/**
 * Provisioning of a freshly added slot checkout for default-configuration:
 * native materialization (ignored-path policy, dependency rerouting, includes)
 * followed by card binding (marker, shared hooks, excludes, parent branch),
 * stopping at the slot lock's shutdown fence between writes.
 * @summary Slot checkout materialization and card binding
 */

import type { CreateWorktreeResult, WorktreeGitRunner } from './worktree.js';

/** Inputs of {@link provisionSlotCheckout}. */
export interface ProvisionSlotCheckoutOptions {
  /** Main repository root that owns the checkout's administrative metadata. */
  readonly repoRoot: string;
  /** Checkout whose ignored paths and `.cards` directory are mirrored. */
  readonly sourceRoot: string;
  readonly cardId: string;
  /** Recorded as `branch.<branch>.cardsParent`. */
  readonly parentBranch: string;
  /** The slot branch checked out at `worktreePath`. */
  readonly branch: string;
  /** The checkout `git worktree add` just created. */
  readonly worktreePath: string;
  /** Installed extension root; hook scripts come from `compiledHookScriptPaths(extensionPath)`. */
  readonly extensionPath: string;
  /** Shared dispatcher directory, `join(resolveGlobalCardsConfigDir(), 'workspace-hooks')`. */
  readonly sharedHooksDir: string;
  /** Bounded git executor. */
  readonly runGit: WorktreeGitRunner;
  /** Throws once the slot lock's fence has closed; called before each write. */
  readonly checkpoint: () => void;
}

/** What provisioning produced. */
export interface ProvisionedSlotCheckout {
  readonly checkout: CreateWorktreeResult;
  /** The branch the checkout has checked out after binding. */
  readonly branchName: string;
}

/**
 * Materializes and binds a fresh slot checkout.
 * @param options - Roots, card identity, hooks, git executor and fence checkpoint.
 * @returns The materialization facts and the bound branch.
 * @throws {ShutdownError} When the fence closed between writes; the creation intent drives rollback.
 */
export async function provisionSlotCheckout(options: ProvisionSlotCheckoutOptions): Promise<ProvisionedSlotCheckout> {
  void options;
  throw new Error('Not Implemented');
}

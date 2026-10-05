/**
 * The SDK operations the slot layer drives but does not own: checkout
 * provisioning (S3, `provisionSlotCheckout`) and verified removal with its
 * residue recovery and occupant probe (S2, `@cards.management/sdk/worktree-removal`).
 *
 * Both are declared here against the plan's signatures and bound through
 * {@link SlotSeams}, so the slot layer compiles and runs before they merge.
 *
 * @summary Provisioning and verified-removal seams of the slot layer
 * @module
 */

import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk/cards-config';
import { compiledHookScriptPaths } from '@cards.management/sdk/git-hooks';
import type { WorktreeGitRunner } from '@cards.management/sdk/worktree';
import { provisionWorktreeCheckout } from '@cards.management/sdk/worktree';
import { provisionCardWorktree } from '@cards.management/sdk/worktree-for-card';

/** Inputs of S3 `provisionSlotCheckout`. */
export interface ProvisionSlotCheckoutOptions {
  /** Main repository root. */
  readonly repoRoot: string;
  /** Workspace the ignored-path policy is read from. */
  readonly sourceRoot: string;
  readonly cardRepoPath: string;
  readonly cardId: string;
  readonly parentBranch: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly extensionPath: string;
  readonly sharedHooksDir: string;
  readonly runGit: WorktreeGitRunner;
  /** Called before each write; throws once the shutdown fence has closed. */
  readonly checkpoint: () => void;
}

/** S3: materializes and binds a fresh slot checkout. */
export type ProvisionSlotCheckout = (options: ProvisionSlotCheckoutOptions) => Promise<void>;

/** A process found inside a slot checkout. */
export interface SlotOccupant {
  readonly pid: number;
  readonly command: string;
}

/** Outcome of moving a quarantined checkout's content away entry by entry. */
export type QuarantinedRemoval =
  | { readonly outcome: 'removed' }
  | {
      readonly outcome: 'preserved';
      readonly reason: 'removal_restored' | 'removal_blocked' | 'containment_unproven' | 'quarantine_stranded';
      readonly detail: string;
    };

/** Outcome of recovering one slot's quarantine residue. */
export type SlotResidueRecovery =
  | { readonly status: 'recovered'; readonly detail: string }
  | { readonly status: 'stranded'; readonly detail: string };

/** S2: verified removal, residue recovery and the occupant probe. */
export interface SlotRemoval {
  /**
   * Moves a slot checkout to `<slot>.deleting-<uuid>` with `git worktree move`.
   * @returns The quarantine path.
   */
  quarantineSlot(options: {
    readonly repoRoot: string;
    readonly slotPath: string;
    readonly runGit: WorktreeGitRunner;
  }): Promise<string>;
  /** Proves the quarantine clean and removes it, or restores it when the slot path is absent. */
  removeQuarantinedSlot(options: {
    readonly repoRoot: string;
    readonly slotPath: string;
    readonly quarantinePath: string;
    readonly runGit: WorktreeGitRunner;
    /** Throws once this holder's lock generation is no longer current, or the fence has closed. */
    readonly requireCurrent: () => void;
  }): Promise<QuarantinedRemoval>;
  /** Finishes or restores one slot's `.deleting-*`/`.held` residue under its already held lock. */
  recoverSlotResidue(options: {
    readonly repoRoot: string;
    readonly slotRoot: string;
    readonly ordinal: number;
    readonly runGit: WorktreeGitRunner;
    readonly checkpoint: () => void;
  }): Promise<SlotResidueRecovery>;
  /** Stops git's fsmonitor daemon for a checkout; not running or unsupported is success. */
  stopSlotFsmonitor(options: { readonly slotPath: string; readonly runGit: WorktreeGitRunner }): Promise<void>;
  /**
   * Finds processes whose cwd or open files are inside the checkout.
   * @throws When the probe itself fails.
   */
  findSlotOccupants(
    slotPath: string
  ): Promise<{ readonly occupants: readonly SlotOccupant[]; readonly unprobed: number }>;
}

/** The SDK operations the slot layer is bound to. */
export interface SlotSeams {
  readonly provisionSlotCheckout: ProvisionSlotCheckout;
  readonly removal: SlotRemoval;
}

/**
 * Directory that holds the shared hook dispatcher every slot checkout points at.
 * @returns `<cards config>/workspace-hooks`.
 */
export function slotSharedHooksDir(): string {
  return join(resolveGlobalCardsConfigDir(), 'workspace-hooks');
}

/**
 * Interim S3 binding: the same two SDK steps the server-side provisioner ran,
 * with the fence checked before each.
 * TODO(S3): replace with `provisionSlotCheckout` from the SDK once it merges.
 * @param options - Provisioning inputs.
 */
export const interimProvisionSlotCheckout: ProvisionSlotCheckout = async (options) => {
  options.checkpoint();
  await provisionWorktreeCheckout({
    sourceRoot: options.sourceRoot,
    repoRoot: options.repoRoot,
    worktreeDir: options.worktreePath,
    ref: options.branch,
    runGit: options.runGit
  });
  options.checkpoint();
  await provisionCardWorktree(options.worktreePath, {
    cardId: options.cardId,
    parentBranch: options.parentBranch,
    compiledScriptPaths: compiledHookScriptPaths(options.extensionPath),
    sharedHooksDir: options.sharedHooksDir,
    runGit: options.runGit
  });
};

/** Thrown by every interim S2 operation. */
export class RemovalUnavailableError extends Error {
  constructor() {
    super('verified slot removal is unavailable: @cards.management/sdk/worktree-removal (S2) is not merged');
    this.name = 'RemovalUnavailableError';
  }
}

/**
 * Interim S2 binding: refuses every removal step, so cleanup preserves each
 * candidate as `cleanup_failed` instead of deleting without verification.
 * TODO(S2): replace with `@cards.management/sdk/worktree-removal` once it merges.
 */
export const interimSlotRemoval: SlotRemoval = {
  quarantineSlot: () => Promise.reject(new RemovalUnavailableError()),
  removeQuarantinedSlot: () => Promise.reject(new RemovalUnavailableError()),
  recoverSlotResidue: () => Promise.reject(new RemovalUnavailableError()),
  stopSlotFsmonitor: () => Promise.reject(new RemovalUnavailableError()),
  findSlotOccupants: () => Promise.reject(new RemovalUnavailableError())
};

/** Production bindings. */
export const defaultSlotSeams: SlotSeams = {
  provisionSlotCheckout: interimProvisionSlotCheckout,
  removal: interimSlotRemoval
};

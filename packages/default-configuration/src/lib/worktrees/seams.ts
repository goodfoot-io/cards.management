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
import type { SlotLock } from '@cards.management/sdk/slot-lock';
import type { WorktreeGitRunner } from '@cards.management/sdk/worktree';
import { provisionWorktreeCheckout } from '@cards.management/sdk/worktree';
import { provisionCardWorktree } from '@cards.management/sdk/worktree-for-card';

/** Inputs of S3 `provisionSlotCheckout` (`@cards.management/sdk/slot-checkout`). */
export interface ProvisionSlotCheckoutOptions {
  /** Main repository root. */
  readonly repoRoot: string;
  /** Workspace the ignored-path policy is read from. */
  readonly sourceRoot: string;
  readonly cardId: string;
  readonly parentBranch: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly extensionPath: string;
  readonly sharedHooksDir: string;
  readonly runGit: WorktreeGitRunner;
  /** Runs before each git call and each write wave; throws once the shutdown fence has closed. */
  readonly checkpoint: () => void;
}

/** What S3 provisioning reports. */
export interface ProvisionedSlotCheckout {
  readonly checkout: string;
  readonly branchName: string;
}

/** S3: materializes and binds a fresh slot checkout. */
export type ProvisionSlotCheckout = (options: ProvisionSlotCheckoutOptions) => Promise<ProvisionedSlotCheckout>;

/** A process found inside a slot checkout. */
export interface SlotOccupant {
  readonly pid: number;
  readonly command: string;
}

/** Options every S2 operation accepts; the slot layer passes the holder's fence check. */
export interface SlotRemovalOptions {
  readonly timeoutMs?: number;
  /** Throws once the shutdown fence has closed; run before each step. */
  readonly checkpoint?: () => void;
}

/** Outcome of `removeQuarantinedSlot`. */
export type QuarantinedRemoval =
  | { readonly status: 'removed' }
  | {
      readonly status: 'refused';
      readonly reason: 'uncommitted_changes' | 'removal_blocked' | 'removal_restored';
      readonly detail: string;
      /** Where the checkout now is: restored to the slot path, or left in quarantine. */
      readonly checkoutPath: string;
    };

/** One slot's quarantine residue, found without a lock. */
export interface SlotResidue {
  readonly ordinal: number;
  readonly slotPath: string;
  readonly quarantines: readonly string[];
  readonly holdings: readonly string[];
}

/** What recovering one piece of residue did. */
export interface SlotResidueReport {
  readonly kind:
    | 'removal_finished'
    | 'moved_back'
    | 'removal_restored'
    | 'quarantine_stranded'
    | 'pruned'
    | 'recovery_failed';
  readonly detail: string;
}

/**
 * S2: verified removal, residue recovery and the occupant probe, as
 * `@cards.management/sdk/worktree-removal` exports them. Declared with method
 * syntax so the SDK's own quarantine type binds without a cast.
 */
export interface SlotRemoval {
  /** Moves a slot checkout into quarantine with `git worktree move`, returning the quarantine. */
  quarantineSlot(repoRoot: string, slotPath: string, options?: SlotRemovalOptions): Promise<unknown>;
  /** Proves the quarantine clean and removes it, or restores it; `requireCurrent` is wired from `lock`. */
  removeQuarantinedSlot(
    target: {
      readonly repoRoot: string;
      readonly slotPath: string;
      readonly quarantine: unknown;
      readonly lock: SlotLock;
    },
    options?: SlotRemovalOptions
  ): Promise<QuarantinedRemoval>;
  /** Lists every slot's residue without a lock, for the pre-check. */
  findSlotResidue(slotRoot: string): Promise<readonly SlotResidue[]>;
  /** Finishes or restores one slot's residue under its already held lock. */
  recoverSlotResidueLocked(
    target: { readonly repoRoot: string; readonly slotPath: string; readonly lock: SlotLock },
    options?: SlotRemovalOptions
  ): Promise<readonly SlotResidueReport[]>;
  /** Stops git's fsmonitor daemon for a checkout; not running or unsupported is success. */
  stopSlotFsmonitor(slotPath: string, options?: SlotRemovalOptions): Promise<void>;
  /**
   * Finds processes whose cwd or open files are inside the checkout.
   * @throws When the probe itself fails (`OccupantProbeError`).
   */
  findSlotOccupants(
    slotPath: string,
    options?: SlotRemovalOptions
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
 * @returns The checkout path and its branch.
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
  return { checkout: options.worktreePath, branchName: options.branch };
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
  findSlotResidue: () => Promise.reject(new RemovalUnavailableError()),
  recoverSlotResidueLocked: () => Promise.reject(new RemovalUnavailableError()),
  stopSlotFsmonitor: () => Promise.reject(new RemovalUnavailableError()),
  findSlotOccupants: () => Promise.reject(new RemovalUnavailableError())
};

/** Production bindings. */
export const defaultSlotSeams: SlotSeams = {
  provisionSlotCheckout: interimProvisionSlotCheckout,
  removal: interimSlotRemoval
};

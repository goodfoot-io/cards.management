/**
 * Slot-level removal for default-configuration: quarantines a slot checkout
 * with `git worktree move`, deletes it through verified checkout removal under
 * the slot's lock fence, recovers removal residue, and reports processes still
 * inside a slot instead of signalling them.
 * @summary Verified slot removal, residue recovery and occupant probing
 */

import type { GitBoundedResult, RunGitBoundedOptions } from './bounded-git.js';
import type { CheckoutWitness } from './checkout-removal.js';
import type { BoundedCommandOptions, BoundedCommandResult } from './process-identity.js';
import type { AcquireSlotLockResult, SlotLock, SlotLockPrevious } from './slot-lock.js';

export {
  CheckoutContentChangedError,
  type CheckoutEntry,
  type CheckoutFilesystem,
  CheckoutRemovalBlockedError,
  type CheckoutRemovalLayout,
  type CheckoutRemovalManifest,
  type CheckoutRemovalOptions,
  type CheckoutRemovalRecovery,
  CheckoutRestoredError,
  type CheckoutWitness,
  type CheckoutWitnessProbe,
  recoverCheckoutRemoval,
  removeQuarantinedCheckout,
  resolveCheckoutWitness,
  snapshotCheckout
} from './checkout-removal.js';

/** Default deadline of each slot git call made here. */
export const SLOT_REMOVAL_GIT_TIMEOUT_MS = 60_000;

/** The git runner slot removal uses; defaults to the process-wide bounded runner. */
export interface SlotRemovalGit {
  /**
   * Runs one git command under a deadline; `-c core.fsmonitor=false` is already in `args`.
   * @param cwd - Working directory for git.
   * @param args - Literal git arguments.
   * @param options - Deadline and lifecycle callback.
   * @returns The completed call.
   */
  run(cwd: string, args: readonly string[], options: RunGitBoundedOptions): Promise<GitBoundedResult>;
}

/** Shared options of the slot git steps. */
export interface SlotRemovalOptions {
  readonly git?: SlotRemovalGit;
  /** Deadline of each git call; defaults to {@link SLOT_REMOVAL_GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Removal witness; defaults to the one {@link resolveCheckoutWitness} picks for the slot. */
  readonly witness?: CheckoutWitness;
  /** Timing seam passed to verified removal. */
  readonly checkpoint?: (entryPath: string) => Promise<void>;
}

/** A slot git call that exited non-zero or timed out. */
export class SlotGitError extends Error {
  readonly args: readonly string[];
  readonly result: GitBoundedResult;
  /**
   * Records the failed call.
   * @param args - The git arguments.
   * @param result - What the call returned.
   */
  constructor(args: readonly string[], result: GitBoundedResult) {
    super(
      `git ${args.join(' ')} ${result.timedOut ? 'timed out' : `exited ${String(result.exitCode)}`}: ${result.stderr.trim()}`
    );
    this.name = 'SlotGitError';
    this.args = args;
    this.result = result;
  }
}

/** The parts of a held slot lock removal needs. */
export type SlotRemovalLock = Pick<SlotLock, 'slotRoot' | 'ordinal' | 'generation' | 'checkpoint'>;

/** Outcome of {@link removeQuarantinedSlot}. */
export type SlotRemovalOutcome =
  | { readonly status: 'removed' }
  | {
      readonly status: 'refused';
      readonly reason: 'uncommitted_changes' | 'removal_blocked' | 'removal_restored';
      readonly detail: string;
      /** Where the checkout now is: the slot path after a move-back, otherwise the quarantine. */
      readonly checkoutPath: string;
    };

/**
 * A fresh quarantine path beside a slot: `<slot>.deleting-<uuid>`.
 * @param slotPath - The slot checkout being quarantined.
 * @returns A sibling path that no other removal will pick.
 * @throws {Error} Always: not implemented yet.
 */
export function quarantinePathFor(slotPath: string): string {
  void slotPath;
  throw new Error('Not Implemented');
}

/**
 * Moves a slot checkout to a fresh quarantine with `git worktree move`.
 * @param repoRoot - Repository owning the checkout's administrative metadata.
 * @param slotPath - The slot checkout.
 * @param options - Git runner and deadline.
 * @returns The quarantine path.
 * @throws {SlotGitError} When git refuses the move.
 * @throws {ShutdownError} When the shutdown fence has closed.
 */
export async function quarantineSlot(
  repoRoot: string,
  slotPath: string,
  options: SlotRemovalOptions = {}
): Promise<string> {
  void repoRoot;
  void slotPath;
  void options;
  throw new Error('Not Implemented');
}

/**
 * Deletes a quarantined slot checkout under its lock, then drops git's record
 * of it. A refusal restores the checkout and moves it back only while the slot
 * path is absent; otherwise it stays at the quarantine as `removal_restored`.
 * @param target - The repository, the slot path, its quarantine and the held lock.
 * @param target.repoRoot - Repository owning the checkout's administrative metadata.
 * @param target.slotPath - Path the checkout returns to on refusal.
 * @param target.quarantine - Where {@link quarantineSlot} moved it.
 * @param target.lock - The slot's held `removal` lock.
 * @param options - Git runner, deadline, witness and timing seam.
 * @returns Removed, or refused with the cleanup reason.
 * @throws {ShutdownError} When the fence closed; the residue is left for recovery.
 * @throws {SlotGitError} When a git step other than the proof failed.
 */
export async function removeQuarantinedSlot(
  target: {
    readonly repoRoot: string;
    readonly slotPath: string;
    readonly quarantine: string;
    readonly lock: SlotRemovalLock;
  },
  options: SlotRemovalOptions = {}
): Promise<SlotRemovalOutcome> {
  void target;
  void options;
  throw new Error('Not Implemented');
}

/**
 * Throws unless the lock's generation is still the maximum and unreleased,
 * and the shutdown fence is open.
 * @param lock - The held lock.
 * @throws {ShutdownError} When the fence has closed.
 * @throws {Error} When a newer generation exists or this one was released.
 */
export async function requireCurrentSlotLock(lock: SlotRemovalLock): Promise<void> {
  void lock;
  throw new Error('Not Implemented');
}

// ============================================================================
// Residue
// ============================================================================

/** Removal residue of one slot: quarantines and their holding areas. */
export interface SlotResidue {
  readonly ordinal: number;
  readonly slotPath: string;
  /** `<slot>.deleting-<uuid>` directories, with or without a holding area. */
  readonly quarantines: readonly string[];
  /** `<slot>.deleting-<uuid>.held` directories. */
  readonly holdings: readonly string[];
}

/** One thing residue recovery did or found. */
export type SlotResidueReport =
  /** A committed removal was finished. */
  | { readonly kind: 'removal_finished'; readonly quarantine: string }
  /** A quarantine was returned to its absent slot path. */
  | { readonly kind: 'moved_back'; readonly quarantine: string; readonly slotPath: string }
  /** Restored content stays at the quarantine, or came back with changed or displaced entries. */
  | {
      readonly kind: 'removal_restored';
      readonly quarantine: string;
      readonly slotPath: string;
      readonly changed: readonly string[];
      readonly displaced: readonly string[];
    }
  /** A lone quarantine could not go back because the slot path exists. */
  | { readonly kind: 'quarantine_stranded'; readonly quarantine: string; readonly slotPath: string }
  /** Git's record of a vanished quarantine was dropped. */
  | { readonly kind: 'pruned'; readonly quarantine: string }
  /** A holding area could not be recovered; its manifest is kept. */
  | { readonly kind: 'recovery_failed'; readonly holding: string; readonly detail: string };

/**
 * Lists the slots of a slot root that carry removal residue, without locking.
 * @param slotRoot - The card's slot root.
 * @returns Residue per ordinal, ascending.
 */
export async function findSlotResidue(slotRoot: string): Promise<readonly SlotResidue[]> {
  void slotRoot;
  throw new Error('Not Implemented');
}

/**
 * Recovers one slot's removal residue under a lock the caller already holds:
 * finishes or restores each quarantine and holding pair, prunes the metadata
 * of vanished quarantines, and moves a lone quarantine back while the slot
 * path is absent or reports it `quarantine_stranded`.
 * @param target - The repository, the slot path and the held lock.
 * @param target.repoRoot - Repository owning the checkouts' administrative metadata.
 * @param target.slotPath - The slot checkout path.
 * @param target.lock - The slot's held lock.
 * @param options - Git runner and deadline.
 * @returns What was done, in order.
 * @throws {ShutdownError} When the fence closed between steps.
 */
export async function recoverSlotResidueLocked(
  target: { readonly repoRoot: string; readonly slotPath: string; readonly lock: SlotRemovalLock },
  options: SlotRemovalOptions = {}
): Promise<readonly SlotResidueReport[]> {
  void target;
  void options;
  throw new Error('Not Implemented');
}

/** Takes one slot's lock around `fn`, as `withSlotLock` bound to the caller's identity. */
export type SlotResidueLocker = <T>(
  ordinal: number,
  purpose: 'removal',
  fn: (lock: SlotLock, previous: SlotLockPrevious) => Promise<T>
) => Promise<
  { readonly status: 'done'; readonly value: T } | Exclude<AcquireSlotLockResult, { readonly status: 'acquired' }>
>;

/** Outcome of residue recovery for one slot. */
export type SlotResidueRecovery =
  | { readonly ordinal: number; readonly status: 'recovered'; readonly reports: readonly SlotResidueReport[] }
  /** The lock was not taken; the slot is left untouched. */
  | {
      readonly ordinal: number;
      readonly status: 'skipped';
      readonly lock: Exclude<AcquireSlotLockResult, { readonly status: 'acquired' }>;
    };

/**
 * Recovers every slot with removal residue, each inside its own `removal`
 * lock; a slot whose lock is not taken is skipped.
 * @param slotRoot - The card's slot root.
 * @param withSlotLock - Takes one slot's lock around a function.
 * @param options - The repository plus git runner and deadline.
 * @param options.repoRoot - Repository owning the checkouts' administrative metadata.
 * @returns One outcome per slot with residue.
 */
export async function recoverSlotResidue(
  slotRoot: string,
  withSlotLock: SlotResidueLocker,
  options: SlotRemovalOptions & { readonly repoRoot: string }
): Promise<readonly SlotResidueRecovery[]> {
  void slotRoot;
  void withSlotLock;
  void options;
  throw new Error('Not Implemented');
}

// ============================================================================
// Occupants
// ============================================================================

/** A process whose cwd or an open file is inside the slot. */
export interface SlotOccupant {
  readonly pid: number;
  readonly command: string;
}

/** Result of {@link findSlotOccupants}. */
export interface SlotOccupantProbe {
  readonly occupants: readonly SlotOccupant[];
  /** Processes skipped because the OS refused to show them (`EACCES`/`EPERM`). */
  readonly unprobed: number;
}

/** The probe could not decide whether the slot is occupied. */
export class OccupantProbeError extends Error {
  /**
   * Records why the probe could not decide.
   * @param message - What failed.
   */
  constructor(message: string) {
    super(message);
    this.name = 'OccupantProbeError';
  }
}

/** The `/proc` reads of the Linux probe. */
export interface ProcReader {
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
}

/** Overrides of {@link findSlotOccupants}. */
export interface OccupantProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly proc?: ProcReader;
  /** Runs `lsof` on macOS. */
  readonly runCommand?: (
    file: string,
    args: readonly string[],
    options: BoundedCommandOptions
  ) => Promise<BoundedCommandResult>;
  /** The `lsof` executable; defaults to `lsof`. */
  readonly lsof?: string;
  readonly timeoutMs?: number;
}

/**
 * Lists processes whose cwd or open files are inside a slot. Never signals.
 * @param slotPath - The slot checkout.
 * @param options - Platform, `/proc` reader and command overrides.
 * @returns The occupants and the count of processes the OS would not show.
 * @throws {OccupantProbeError} When the probe itself failed.
 */
export async function findSlotOccupants(
  slotPath: string,
  options: OccupantProbeOptions = {}
): Promise<SlotOccupantProbe> {
  void slotPath;
  void options;
  throw new Error('Not Implemented');
}

/**
 * Stops the slot's fsmonitor daemon through git's own IPC; "not running" and
 * "unsupported" count as success.
 * @param slotPath - The slot checkout.
 * @param options - Git runner and deadline.
 * @throws {SlotGitError} When git reports any other failure.
 */
export async function stopSlotFsmonitor(slotPath: string, options: SlotRemovalOptions = {}): Promise<void> {
  void slotPath;
  void options;
  throw new Error('Not Implemented');
}

/**
 * Verified deletion of a quarantined checkout through a durable, recoverable
 * holding area: every entry is snapshotted before the caller's cleanliness
 * proof, moved aside only while it still matches that snapshot, and unlinked
 * only after a committed re-verification. Git and the owner fence enter only
 * through callbacks.
 * @summary Hold-verify-unlink checkout removal with manifest-driven recovery
 */

import type * as nodeFs from 'node:fs/promises';

/**
 * What proves an entry unchanged since the snapshot. `ctime` compares the
 * full identity including the change time, which userspace cannot set on
 * Linux and macOS; `hash` compares every regular file's content, for Windows,
 * where any handle with `FILE_WRITE_ATTRIBUTES` can set ChangeTime, and for
 * volumes with no real change time.
 */
export type CheckoutWitness = 'ctime' | 'hash';

/**
 * One checkout entry observed before the cleanliness proof. Paths are
 * root-relative and numeric identity is decimal text so the manifest
 * round-trips exactly.
 */
export interface CheckoutEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file' | 'symlink' | 'special';
  readonly mode: number;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  /** Content hash: every regular file under `hash`, racy files only under `ctime`. */
  readonly sha256?: string;
  readonly target?: string;
}

/** Durable record written before the first entry leaves the checkout. */
export interface CheckoutRemovalManifest {
  readonly version: 1;
  readonly root: string;
  /** Path the checkout returns to when removal is refused or restored. */
  readonly restoreTo: string;
  readonly witness: CheckoutWitness;
  /** Held entry `i` lives at `<holding>/<i>`. */
  readonly entries: readonly CheckoutEntry[];
}

/** Paths for one removal; the holding area is a sibling on the same filesystem. */
export interface CheckoutRemovalLayout {
  readonly root: string;
  readonly holding: string;
  readonly restoreTo: string;
}

/** Filesystem mutations that tests may fail deterministically. */
export type CheckoutFilesystem = Pick<typeof nodeFs, 'rename' | 'rmdir' | 'link' | 'unlink'>;

/** Boundaries for one verified removal. */
export interface CheckoutRemovalOptions {
  /** Proves the snapshotted checkout clean; runs after the snapshot so later writes diverge from it. */
  readonly prove: () => Promise<void>;
  /** Throws when the caller may no longer mutate; awaited before every entry. */
  readonly requireCurrent: () => void | Promise<void>;
  /** Timing seam: called with the holding path once it exists, then before each entry leaves the checkout. */
  readonly checkpoint?: (entryPath: string) => Promise<void>;
  readonly filesystem?: Partial<CheckoutFilesystem>;
  /** Defaults to {@link resolveCheckoutWitness} for the checkout's root. */
  readonly witness?: CheckoutWitness;
}

/** Content diverged before the checkout was dismantled; every entry was restored in place. */
export class CheckoutContentChangedError extends Error {
  readonly changed: readonly string[];
  /**
   * Records which entries diverged.
   * @param message - What diverged.
   * @param changed - Root-relative entries found changed.
   */
  constructor(message: string, changed: readonly string[]) {
    super(changed.length === 0 ? message : `${message}: ${changed.join(', ')}`);
    this.name = 'CheckoutContentChangedError';
    this.changed = changed;
  }
}

/** A filesystem operation, not a content change, stopped removal; every entry was restored in place. */
export class CheckoutRemovalBlockedError extends Error {
  readonly code: string;
  readonly syscall: string;
  readonly path: string;
  /**
   * Records the refused operation.
   * @param code - The refusing errno code.
   * @param syscall - The operation that was refused.
   * @param path - Root-relative entry, or `.` for the root.
   */
  constructor(code: string, syscall: string, path: string) {
    super(`${code} ${syscall} ${path}: checkout restored`);
    this.name = 'CheckoutRemovalBlockedError';
    this.code = code;
    this.syscall = syscall;
    this.path = path;
  }
}

/** Held content diverged after the checkout was dismantled; the manifest restored every entry. */
export class CheckoutRestoredError extends Error {
  readonly changed: readonly string[];
  readonly displaced: readonly string[];
  /**
   * Records what diverged and where conflicting copies were kept.
   * @param holding - The holding area the divergence was found in.
   * @param changed - Root-relative entries whose held content changed.
   * @param displaced - Recovery names kept beside entries recreated meanwhile.
   */
  constructor(holding: string, changed: readonly string[], displaced: readonly string[]) {
    super(
      `Content held at ${holding} changed during removal (${changed.join(', ') || 'none'}); checkout restored` +
        (displaced.length === 0 ? '' : `, conflicting copies kept at ${displaced.join(', ')}`)
    );
    this.name = 'CheckoutRestoredError';
    this.changed = changed;
    this.displaced = displaced;
  }
}

/** What recovery of an interrupted removal did. */
export type CheckoutRemovalRecovery =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'finished'; readonly root: string }
  | {
      readonly kind: 'restored';
      readonly root: string;
      readonly restoreTo: string;
      readonly changed: readonly string[];
      readonly displaced: readonly string[];
    };

/** Filesystem probes {@link resolveCheckoutWitness} reads. */
export interface CheckoutWitnessProbe {
  readonly platform?: NodeJS.Platform;
  /** `statfs` type of the volume, or null when unreadable. */
  readonly statfsType?: (path: string) => Promise<number | null>;
}

/**
 * Chooses the witness for a checkout: `hash` on Windows and on Linux volumes
 * without a real change time (FAT, exFAT, NFS, SMB/CIFS), `ctime` elsewhere.
 * A Linux volume whose type cannot be read is treated as `hash`.
 *
 * Known limitation: macOS always gets `ctime`. Node exposes no
 * `f_fstypename`, and Darwin's numeric `f_type` is not a stable identifier,
 * so an msdos, exFAT, SMB or NFS volume mounted on macOS is not detected; a
 * checkout there relies on that volume's change time, which such volumes may
 * synthesize. Slot roots live under the user's home volume (APFS), where
 * change time is real.
 * @param root - Any path on the checkout's volume.
 * @param probe - Platform and volume-type overrides.
 * @returns The witness removal and recovery must use.
 */
export async function resolveCheckoutWitness(root: string, probe: CheckoutWitnessProbe = {}): Promise<CheckoutWitness> {
  void root;
  void probe;
  throw new Error('Not Implemented');
}

/**
 * Records every entry beneath a checkout without following symbolic links.
 * @param root - Quarantined checkout directory.
 * @param filesystemNow - Current time as stamped by the checkout's own filesystem.
 * @param witness - Under `hash`, every regular file records its content hash.
 * @returns Pre-order entries.
 * @throws {CheckoutRemovalBlockedError} When an entry cannot be read.
 */
export async function snapshotCheckout(
  root: string,
  filesystemNow: bigint,
  witness: CheckoutWitness = 'ctime'
): Promise<CheckoutEntry[]> {
  void root;
  void filesystemNow;
  void witness;
  throw new Error('Not Implemented');
}

/**
 * Deletes a quarantined checkout entry by entry through a durable holding area.
 * @param layout - Quarantine root, its absent holding sibling, and the path a refusal returns to.
 * @param options - Cleanliness proof, owner fence, timing seam, witness and injectable mutations.
 * @throws {CheckoutContentChangedError} When content diverged before the root was removed.
 * @throws {CheckoutRemovalBlockedError} When an operation was refused; the checkout is restored.
 * @throws {CheckoutRestoredError} When held content diverged after the root was removed.
 */
export async function removeQuarantinedCheckout(
  layout: CheckoutRemovalLayout,
  options: CheckoutRemovalOptions
): Promise<void> {
  void layout;
  void options;
  throw new Error('Not Implemented');
}

/**
 * Resolves a holding area left by an interrupted removal.
 * @param holding - Holding area left beside its quarantine root.
 * @param filesystem - Injectable mutations.
 * @returns The resolution; a restored root must still be returned to `restoreTo` by the caller.
 * @throws {Error} When the holding area contains entries its manifest cannot account for.
 */
export async function recoverCheckoutRemoval(
  holding: string,
  filesystem: Partial<CheckoutFilesystem> = {}
): Promise<CheckoutRemovalRecovery> {
  void holding;
  void filesystem;
  throw new Error('Not Implemented');
}

/**
 * Verified deletion of a quarantined checkout through a durable, recoverable
 * holding area: every entry is snapshotted before the caller's cleanliness
 * proof, moved aside only while it still matches that snapshot, and unlinked
 * only after a committed re-verification. Git and the owner fence enter only
 * through callbacks.
 * @summary Hold-verify-unlink checkout removal with manifest-driven recovery
 */

import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants, createReadStream } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
  /** Permission bits of the root, reapplied when restoration recreates it. */
  readonly rootMode: number;
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

/**
 * A filesystem operation, not a content change, stopped removal. Every entry
 * was restored in place, except when the refused operation was the
 * restoration itself (`syscall` is `restore`): then the holding area and its
 * manifest are kept for {@link recoverCheckoutRemoval}.
 */
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
    super(
      `${code} ${syscall} ${path}: ${syscall === 'restore' ? 'holding area kept for recovery' : 'checkout restored'}`
    );
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

// Wider than the coarsest common timestamp granularity (FAT's two seconds).
const RACY_WINDOW_NS = 3_000_000_000n;
const MANIFEST = 'manifest.json';
const COMMITTED = 'committed';
const BOOKKEEPING = new Set([MANIFEST, `${MANIFEST}.tmp`, COMMITTED, `${COMMITTED}.tmp`]);
const BATCH = 64;
// Codes meaning the namespace changed under removal rather than an operation being refused.
const DIVERGENCE_CODES = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR']);
// Linux `statfs` magic numbers of volumes whose change time is synthesized or server-side.
const HASH_VOLUME_TYPES = new Set([
  0x4d44, // MSDOS (FAT)
  0x2011bab0, // exFAT
  0x6969, // NFS
  0x517b, // SMB
  0xff534d42, // CIFS
  0xfe534d42 // SMB2
]);

class Diverged {
  constructor(readonly path: string) {}
}
class Blocked {
  constructor(
    readonly code: string,
    readonly syscall: string,
    readonly path: string
  ) {}
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Sorts a failed filesystem call into a divergence or a refused operation.
 * @param error - What the call threw.
 * @param syscall - The operation, for the blocked report.
 * @param path - Root-relative entry the call acted on.
 * @returns The classification; an error without an errno code is returned unchanged.
 */
const classify = (error: unknown, syscall: string, path: string): unknown => {
  if (error instanceof Diverged || error instanceof Blocked) return error;
  const code = codeOf(error);
  if (code === undefined) return error;
  return DIVERGENCE_CODES.has(code) ? new Diverged(path) : new Blocked(code, syscall, path);
};

/**
 * Runs operations in fixed-size concurrent batches, settling each batch before reporting its first
 * failure, so restoration never races an operation still in flight.
 * @param items - Inputs, in order.
 * @param run - The operation per input.
 */
const batched = async <T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> => {
  for (let index = 0; index < items.length; index += BATCH) {
    const failed = (await Promise.allSettled(items.slice(index, index + BATCH).map(run))).find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }
};

/**
 * Streams a file through SHA-256.
 * @param file - Regular file to read.
 * @returns Lowercase hex digest.
 */
const hashFile = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

const kindOf = (stats: BigIntStats): CheckoutEntry['kind'] =>
  stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : 'special';

/**
 * Reports whether a path exists without following a final symbolic link.
 * @param file - Path to probe.
 * @returns False only for `ENOENT`; every other failure is thrown.
 */
const exists = async (file: string): Promise<boolean> => {
  try {
    await nodeFs.lstat(file);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
};

/**
 * Flushes a directory so renames inside it survive a crash.
 * @param directory - Directory whose entries changed.
 */
const syncDirectory = async (directory: string): Promise<void> => {
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Windows cannot open or flush a directory handle; NTFS journals the rename itself.
  } finally {
    await handle?.close();
  }
};

/**
 * Replaces a file atomically and durably: temporary sibling, fsync, rename, directory fsync.
 * @param file - Destination path.
 * @param data - Complete new content.
 */
const writeDurable = async (file: string, data: string): Promise<void> => {
  const temporary = `${file}.tmp`;
  const handle = await nodeFs.open(temporary, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await nodeFs.rename(temporary, file);
  await syncDirectory(dirname(file));
};

/** What {@link unchanged} compares beyond kind, inode and mode. */
interface IdentityCheck {
  /** Change time to require; omitted when unknown or when the witness cannot trust it. */
  readonly ctimeNs?: string | undefined;
  /** Whether a recorded content hash must also match. */
  readonly hash: boolean;
}

/**
 * Compares a live or held entry with its snapshot identity. Directory identity is not compared
 * because removing children changes it.
 * @param entry - Snapshot identity.
 * @param file - Current location of the entry.
 * @param check - Change time and hash requirements.
 * @returns Whether the entry still holds exactly the snapshotted content; false when it is gone.
 */
const unchanged = async (entry: CheckoutEntry, file: string, check: IdentityCheck): Promise<boolean> => {
  let stats: BigIntStats;
  try {
    stats = await nodeFs.lstat(file, { bigint: true });
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
  if (kindOf(stats) !== entry.kind || String(stats.ino) !== entry.ino || Number(stats.mode) !== entry.mode)
    return false;
  if (entry.kind === 'directory') return true;
  if (check.ctimeNs !== undefined && String(stats.ctimeNs) !== check.ctimeNs) return false;
  if (entry.kind === 'symlink') return (await nodeFs.readlink(file)) === entry.target;
  if (entry.kind === 'special') return true;
  if (String(stats.size) !== entry.size || String(stats.mtimeNs) !== entry.mtimeNs) return false;
  return !check.hash || entry.sha256 === undefined || (await hashFile(file)) === entry.sha256;
};

/**
 * The check a held entry must pass once removal committed, or during recovery.
 * @param witness - The removal's witness.
 * @param ctimeNs - Change time observed right after the entry was held, when known.
 * @returns Full identity plus hash; change time only where the witness trusts it.
 */
const heldCheck = (witness: CheckoutWitness, ctimeNs: string | undefined): IdentityCheck => ({
  ctimeNs: witness === 'ctime' ? ctimeNs : undefined,
  hash: true
});

/**
 * Reads the volume type of a path through `statfs`.
 * @param path - Any path on the volume.
 * @returns The unsigned magic number, or null when `statfs` fails.
 */
const statfsType = async (path: string): Promise<number | null> => {
  try {
    return (await nodeFs.statfs(path)).type >>> 0;
  } catch {
    return null;
  }
};

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
  const platform = probe.platform ?? process.platform;
  if (platform === 'win32') return 'hash';
  if (platform !== 'linux') return 'ctime';
  const type = await (probe.statfsType ?? statfsType)(root);
  return type === null || HASH_VOLUME_TYPES.has(type >>> 0) ? 'hash' : 'ctime';
}

/**
 * Records every entry beneath a checkout without following symbolic links.
 * Under `ctime`, a file modified within the racy window of `filesystemNow`
 * also records its content hash, because a later write inside the same
 * timestamp tick could leave its size and modification time unchanged; under
 * `hash`, every regular file does.
 * @param root - Quarantined checkout directory.
 * @param filesystemNow - Current time as stamped by the checkout's own filesystem.
 * @param witness - Under `hash`, every regular file records its content hash.
 * @returns Pre-order entries.
 * @throws {CheckoutContentChangedError} When an entry vanished while it was being read.
 * @throws {CheckoutRemovalBlockedError} When an entry cannot be read.
 */
export async function snapshotCheckout(
  root: string,
  filesystemNow: bigint,
  witness: CheckoutWitness = 'ctime'
): Promise<CheckoutEntry[]> {
  const entries: CheckoutEntry[] = [];
  const observe = async (path: string): Promise<CheckoutEntry> => {
    const file = join(root, path);
    let syscall = 'lstat';
    try {
      const stats = await nodeFs.lstat(file, { bigint: true });
      const kind = kindOf(stats);
      const hashed = kind === 'file' && (witness === 'hash' || stats.mtimeNs + RACY_WINDOW_NS >= filesystemNow);
      syscall = 'read';
      const sha256 = hashed ? await hashFile(file) : undefined;
      syscall = 'readlink';
      const target = kind === 'symlink' ? await nodeFs.readlink(file) : undefined;
      return {
        path,
        kind,
        mode: Number(stats.mode),
        ino: String(stats.ino),
        size: String(stats.size),
        mtimeNs: String(stats.mtimeNs),
        ctimeNs: String(stats.ctimeNs),
        ...(sha256 === undefined ? {} : { sha256 }),
        ...(target === undefined ? {} : { target })
      };
    } catch (error) {
      throw classify(error, syscall, path);
    }
  };
  const walk = async (relative: string): Promise<void> => {
    let names: string[];
    try {
      names = (await nodeFs.readdir(join(root, relative))).sort();
    } catch (error) {
      throw classify(error, 'scandir', relative === '' ? '.' : relative);
    }
    const observed = await Promise.all(names.map((name) => observe(relative === '' ? name : join(relative, name))));
    for (const entry of observed) {
      entries.push(entry);
      if (entry.kind === 'directory') await walk(entry.path);
    }
  };
  try {
    await walk('');
  } catch (error) {
    if (error instanceof Diverged)
      throw new CheckoutContentChangedError('Checkout changed during snapshot', [error.path]);
    if (error instanceof Blocked) throw new CheckoutRemovalBlockedError(error.code, error.syscall, error.path);
    throw error;
  }
  return entries;
}

/**
 * Places a held entry at its original path without ever replacing whatever now occupies it.
 * @param entry - The entry's snapshot identity.
 * @param held - Where the entry is held.
 * @param target - Its original path.
 * @param fs - Injectable mutations.
 * @returns Whether the path was free; false leaves the held entry where it is.
 */
const placeNoReplace = async (
  entry: CheckoutEntry,
  held: string,
  target: string,
  fs: CheckoutFilesystem
): Promise<boolean> => {
  try {
    if (entry.kind === 'symlink') {
      await nodeFs.symlink(entry.target ?? '', target);
    } else {
      try {
        await fs.link(held, target);
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EEXIST' || code === 'ENOENT' || code === 'ENOTDIR' || entry.kind !== 'file') throw error;
        // Filesystems without hard links still get an exclusive create, with the mode the umask would strip.
        await nodeFs.copyFile(held, target, constants.COPYFILE_EXCL);
        await nodeFs.chmod(target, entry.mode & 0o7777);
        const stats = await nodeFs.lstat(held);
        await nodeFs.utimes(target, stats.atime, stats.mtime);
      }
    }
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  }
  await nodeFs.unlink(held);
  return true;
};

/**
 * Creates a directory, reporting whether this call created it.
 * @param directory - Directory to create.
 * @returns False when it already existed.
 */
const makeDirectory = async (directory: string): Promise<boolean> => {
  try {
    await nodeFs.mkdir(directory);
    return true;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  }
};

/**
 * Returns every held entry to its manifest path, recreating directories, without replacing any entry
 * created meanwhile. A displaced held entry still matching its proven-clean identity is the committed
 * version and is dropped; a divergent one is kept inside the checkout under a recovery name. Recreated
 * directories get their recorded modes last, so a read-only directory still receives its children.
 * @param holding - The holding area.
 * @param manifest - The removal's manifest.
 * @param fs - Injectable mutations.
 * @param ctimes - Change times observed right after each entry was held, by index.
 * @returns Root-relative entries whose held content diverged, and recovery names that were used.
 */
const restoreHeld = async (
  holding: string,
  manifest: CheckoutRemovalManifest,
  fs: CheckoutFilesystem,
  ctimes: ReadonlyMap<number, string>
): Promise<{ changed: string[]; displaced: string[] }> => {
  const changed: string[] = [];
  const displaced: string[] = [];
  const created: Array<{ readonly path: string; readonly mode: number }> = [];
  if (await makeDirectory(manifest.root)) created.push({ path: manifest.root, mode: manifest.rootMode });
  for (const [index, entry] of manifest.entries.entries()) {
    const target = join(manifest.root, entry.path);
    if (entry.kind === 'directory') {
      if (await makeDirectory(target)) created.push({ path: target, mode: entry.mode });
      continue;
    }
    const held = join(holding, String(index));
    if (!(await exists(held))) continue;
    const clean = await unchanged(entry, held, heldCheck(manifest.witness, ctimes.get(index)));
    if (!clean) changed.push(entry.path);
    let placed: boolean;
    try {
      placed = await placeNoReplace(entry, held, target, fs);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT' && codeOf(error) !== 'ENOTDIR') throw error;
      placed = false;
    }
    if (placed) continue;
    if (clean || entry.kind === 'special') {
      await nodeFs.unlink(held);
      continue;
    }
    const suffix = randomUUID().slice(0, 8);
    let alternate = `${target}.cards-recovered-${suffix}`;
    try {
      await nodeFs.rename(held, alternate);
    } catch {
      alternate = join(manifest.root, `cards-recovered-${suffix}-${basename(entry.path)}`);
      await nodeFs.rename(held, alternate);
    }
    displaced.push(alternate);
  }
  for (const directory of created.reverse()) await nodeFs.chmod(directory.path, directory.mode & 0o7777);
  await dismantleHolding(holding);
  return { changed, displaced };
};

/**
 * Restores held entries inside a removal, reporting a refused restoration as blocked.
 * @param holding - The holding area.
 * @param manifest - The removal's manifest.
 * @param fs - Injectable mutations.
 * @param ctimes - Change times observed right after each entry was held.
 * @returns What {@link restoreHeld} found.
 * @throws {CheckoutRemovalBlockedError} When restoration itself was refused; the manifest is kept.
 */
const restoreOrBlock = async (
  holding: string,
  manifest: CheckoutRemovalManifest,
  fs: CheckoutFilesystem,
  ctimes: ReadonlyMap<number, string>
): Promise<{ changed: string[]; displaced: string[] }> => {
  try {
    return await restoreHeld(holding, manifest, fs, ctimes);
  } catch (error) {
    const code = codeOf(error);
    if (code === undefined) throw error;
    throw new CheckoutRemovalBlockedError(code, 'restore', holding);
  }
};

/**
 * Removes the holding area once every held entry has left it.
 * @param holding - The holding area.
 * @throws {Error} When entries other than bookkeeping remain.
 */
const dismantleHolding = async (holding: string): Promise<void> => {
  const remaining = (await nodeFs.readdir(holding)).filter((name) => !BOOKKEEPING.has(name));
  if (remaining.length > 0) throw new Error(`Holding area ${holding} still holds ${remaining.join(', ')}`);
  for (const name of [COMMITTED, `${COMMITTED}.tmp`, MANIFEST, `${MANIFEST}.tmp`])
    await nodeFs.unlink(join(holding, name)).catch((error: unknown) => {
      if (codeOf(error) !== 'ENOENT') throw error;
    });
  await nodeFs.rmdir(holding);
  await syncDirectory(dirname(holding));
};

/**
 * Builds the filesystem with injected mutations over `node:fs/promises`.
 * @param overrides - Mutations to replace.
 * @returns The complete filesystem.
 */
const filesystemWith = (overrides: Partial<CheckoutFilesystem> = {}): CheckoutFilesystem => ({
  rename: nodeFs.rename,
  rmdir: nodeFs.rmdir,
  link: nodeFs.link,
  unlink: nodeFs.unlink,
  ...overrides
});

/**
 * Deletes a quarantined checkout itself instead of handing live content to a recursive delete.
 *
 * Order: create the holding area, snapshot every entry, let the caller prove the checkout clean,
 * write the manifest durably, then move each entry into the holding area. A file is checked against
 * its full identity immediately before it moves, and against size, modification time and inode after.
 * Directories are removed only with `rmdir`, so a writer creating anything inside one is refused.
 * After the root is gone a durable marker, carrying each held entry's post-move change time, commits
 * the removal; every held entry is re-verified, and only then unlinked. Any divergence or failure
 * before that point restores every entry without replacing newer ones.
 *
 * Identity soundness under `ctime`: every write or metadata change updates change time, which
 * userspace cannot forge on Linux or macOS, so the pre-move check proves a non-racy file unchanged
 * since the snapshot; afterwards only descriptors opened earlier reach it, and their writes advance
 * change time past the value persisted in the marker. Racy files compare content hashes as well.
 * Under `hash`, change time is never trusted and every regular file's content is compared before it
 * moves and again once removal committed. Writes through a descriptor after the final verification
 * land in an unlinked file under any deletion scheme.
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
  const fs = filesystemWith(options.filesystem);
  const { root, holding } = layout;
  const witness = options.witness ?? (await resolveCheckoutWitness(root));
  await nodeFs.mkdir(holding);
  let entries: CheckoutEntry[];
  let rootMode: number;
  try {
    await options.checkpoint?.(holding);
    rootMode = (await nodeFs.lstat(root)).mode;
    entries = await snapshotCheckout(root, (await nodeFs.lstat(holding, { bigint: true })).mtimeNs, witness);
    await options.prove();
  } catch (error) {
    await nodeFs.rmdir(holding);
    throw error;
  }
  const manifest: CheckoutRemovalManifest = {
    version: 1,
    root,
    restoreTo: layout.restoreTo,
    rootMode,
    witness,
    entries
  };
  await writeDurable(join(holding, MANIFEST), JSON.stringify(manifest));
  const ctimes = new Map<number, string>();
  const take = async (index: number): Promise<void> => {
    const entry = entries[index] as CheckoutEntry;
    await options.requireCurrent();
    const source = join(root, entry.path);
    await options.checkpoint?.(source);
    if (entry.kind === 'directory') {
      await fs.rmdir(source).catch((error: unknown) => {
        throw classify(error, 'rmdir', entry.path);
      });
      return;
    }
    const before: IdentityCheck =
      witness === 'ctime' ? { ctimeNs: entry.ctimeNs, hash: false } : { ctimeNs: undefined, hash: true };
    const held = join(holding, String(index));
    try {
      if (!(await unchanged(entry, source, before))) throw new Diverged(entry.path);
      await fs.rename(source, held);
      ctimes.set(index, String((await nodeFs.lstat(held, { bigint: true })).ctimeNs));
      if (!(await unchanged(entry, held, { hash: false }))) throw new Diverged(entry.path);
    } catch (error) {
      throw classify(error, ctimes.has(index) ? 'lstat' : 'rename', entry.path);
    }
  };
  try {
    // Files are independent, so they move concurrently; directories follow deepest first, and the
    // Git marker stays until all other content is held so an interrupted checkout stays recognizable.
    const marker = entries.findIndex((entry) => entry.path === '.git');
    const indexes = entries.map((_, index) => index).filter((index) => index !== marker);
    await batched(
      indexes.filter((index) => entries[index]?.kind !== 'directory'),
      take
    );
    for (const index of indexes.reverse()) if (entries[index]?.kind === 'directory') await take(index);
    if (marker !== -1) await take(marker);
    await options.requireCurrent();
    await fs.rmdir(root).catch((error: unknown) => {
      throw classify(error, 'rmdir', '.');
    });
  } catch (error) {
    const { changed } = await restoreOrBlock(holding, manifest, fs, ctimes);
    if (error instanceof Diverged)
      throw new CheckoutContentChangedError('Checkout changed during removal', [...new Set([error.path, ...changed])]);
    if (error instanceof Blocked) throw new CheckoutRemovalBlockedError(error.code, error.syscall, error.path);
    throw error;
  }
  await writeDurable(join(holding, COMMITTED), JSON.stringify({ ctimes: Object.fromEntries(ctimes) }));
  const diverged: string[] = [];
  await batched([...ctimes.keys()], async (index) => {
    const entry = entries[index] as CheckoutEntry;
    if (!(await unchanged(entry, join(holding, String(index)), heldCheck(witness, ctimes.get(index)))))
      diverged.push(entry.path);
  });
  if (diverged.length > 0) {
    const restored = await restoreOrBlock(holding, manifest, fs, ctimes);
    throw new CheckoutRestoredError(holding, [...new Set([...diverged, ...restored.changed])], restored.displaced);
  }
  await batched([...ctimes.keys()], (index) => fs.unlink(join(holding, String(index))));
  await dismantleHolding(holding);
}

/**
 * Reads the post-move change times a committed removal persisted.
 * @param holding - The holding area.
 * @returns Change times by entry index, or null when the removal never committed.
 * @throws {Error} When the marker exists but is unreadable.
 */
const readCommitted = async (holding: string): Promise<Map<number, string> | null> => {
  let text: string;
  try {
    text = await nodeFs.readFile(join(holding, COMMITTED), 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(text) as { ctimes?: unknown };
  if (typeof parsed.ctimes !== 'object' || parsed.ctimes === null)
    throw new Error(`Unreadable commit marker in ${holding}`);
  return new Map(
    Object.entries(parsed.ctimes as Record<string, string>).map(([index, ctime]) => [Number(index), ctime])
  );
};

/**
 * Resolves a holding area left by an interrupted removal: an area without a manifest moved nothing
 * and is discarded; a committed removal whose held entries all still match, including the change
 * times persisted at commit, is finished; anything else is restored entry by entry to the quarantine
 * root named in the manifest.
 * @param holding - Holding area left beside its quarantine root.
 * @param filesystem - Injectable mutations.
 * @returns The resolution; a restored root must still be returned to `restoreTo` by the caller.
 * @throws {Error} When the holding area contains entries its manifest cannot account for.
 */
export async function recoverCheckoutRemoval(
  holding: string,
  filesystem: Partial<CheckoutFilesystem> = {}
): Promise<CheckoutRemovalRecovery> {
  const fs = filesystemWith(filesystem);
  let manifest: CheckoutRemovalManifest;
  try {
    manifest = JSON.parse(await nodeFs.readFile(join(holding, MANIFEST), 'utf8')) as CheckoutRemovalManifest;
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
    await dismantleHolding(holding);
    return { kind: 'cleared' };
  }
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    (manifest.witness !== 'ctime' && manifest.witness !== 'hash')
  )
    throw new Error(`Unreadable manifest in ${holding}`);
  const known = new Set(manifest.entries.map((_, index) => String(index)));
  const unknown = (await nodeFs.readdir(holding)).filter((name) => !BOOKKEEPING.has(name) && !known.has(name));
  if (unknown.length > 0) throw new Error(`Holding area ${holding} holds unrecorded ${unknown.join(', ')}`);
  const ctimes = (await readCommitted(holding)) ?? new Map<number, string>();
  if ((await exists(join(holding, COMMITTED))) && !(await exists(manifest.root))) {
    const held = manifest.entries.flatMap((entry, index) =>
      entry.kind === 'directory' ? [] : [{ entry, index, file: join(holding, String(index)) }]
    );
    let intact = true;
    await batched(held, async ({ entry, index, file }) => {
      if ((await exists(file)) && !(await unchanged(entry, file, heldCheck(manifest.witness, ctimes.get(index)))))
        intact = false;
    });
    if (intact) {
      await batched(held, (item) =>
        fs.unlink(item.file).catch((error: unknown) => {
          if (codeOf(error) !== 'ENOENT') throw error;
        })
      );
      await dismantleHolding(holding);
      return { kind: 'finished', root: manifest.root };
    }
  }
  const { changed, displaced } = await restoreHeld(holding, manifest, fs, ctimes);
  return { kind: 'restored', root: manifest.root, restoreTo: manifest.restoreTo, changed, displaced };
}

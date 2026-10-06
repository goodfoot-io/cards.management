/**
 * Slot-level removal for default-configuration: sets a slot's initialized
 * submodules aside and quarantines its checkout with `git worktree move`,
 * proves it clean and unoccupied under the slot's lock fence, commits the
 * removal by moving the recorded copy into `<slotRoot>/.purge`, and leaves the
 * copy for the next pass's {@link purgeRemovedSlots} to delete against that
 * record. Also recovers removal residue, and reports processes still inside a
 * slot instead of signalling them.
 * @summary Slot removal with a deferred, verified purge, residue recovery and occupant probing
 */

import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { type GitBoundedResult, type RunGitBoundedOptions, runGitBounded, ShutdownError } from './bounded-git.js';
import {
  CheckoutContentChangedError,
  type CheckoutEntry,
  type CheckoutFilesystem,
  type CheckoutRecord,
  CheckoutRemovalBlockedError,
  type CheckoutRemovalRecovery,
  type CheckoutRestoration,
  CheckoutRestoredError,
  type CheckoutWitness,
  dismantleCheckout,
  findCheckoutChanges,
  recordCheckoutParts,
  recoverCheckoutRemoval,
  resolveCheckoutWitness,
  syncDirectory,
  writeDurable
} from './checkout-removal.js';
import { type BoundedCommandOptions, type BoundedCommandResult, runBoundedCommand } from './process-identity.js';
import type { WorktreePurgeSummary } from './protocol/types/worktree-slots.js';
import { type AcquireSlotLockResult, readSlotLockSnapshot, type SlotLock, type SlotLockPrevious } from './slot-lock.js';

export {
  CheckoutContentChangedError,
  type CheckoutDismantleOptions,
  type CheckoutEntry,
  type CheckoutFilesystem,
  type CheckoutRecord,
  CheckoutRemovalBlockedError,
  type CheckoutRemovalLayout,
  type CheckoutRemovalManifest,
  type CheckoutRemovalOptions,
  type CheckoutRemovalRecovery,
  type CheckoutRestoration,
  CheckoutRestoredError,
  type CheckoutWitness,
  type CheckoutWitnessProbe,
  dismantleCheckout,
  findCheckoutChanges,
  recordCheckoutParts,
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

/**
 * A point in {@link removeQuarantinedSlot} after which a crash leaves distinct
 * residue: `recorded` once the removal record is durable and before the
 * commit, `committed` once the copy is under `.purge` and before git's record
 * is dropped, `unregistered` once git's record is dropped.
 */
export type SlotRemovalStep = 'recorded' | 'committed' | 'unregistered';

/** Shared options of the slot git steps. */
export interface SlotRemovalOptions {
  readonly git?: SlotRemovalGit;
  /** Deadline of each git call; defaults to {@link SLOT_REMOVAL_GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Removal witness; defaults to the one {@link resolveCheckoutWitness} picks for the slot. */
  readonly witness?: CheckoutWitness;
  /** Timing seam: awaited at each {@link SlotRemovalStep} of a removal. */
  readonly checkpoint?: (step: SlotRemovalStep) => Promise<void>;
  /** Overrides of the occupant probe the quarantined checkout must pass. */
  readonly occupants?: OccupantProbeOptions;
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

const DEFAULT_GIT: SlotRemovalGit = { run: runGitBounded };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Beside a slot: its quarantine `<n>.deleting-<uuid>` and that quarantine's set-aside submodules. */
const RESIDUE_NAME = new RegExp(`^([1-9]\\d*)\\.deleting-(${UUID})(\\.submodules)?$`);
/** Under `.purge`: a removed copy `<n>.<uuid>`, its removal record and its purge's holding area. */
const COPY_NAME = new RegExp(`^([1-9]\\d*)\\.(${UUID})(\\.json|\\.held)?$`);
/** The slot root's directory of removed copies waiting for a purge. */
export const REMOVED_COPIES_DIR = '.purge';
const SET_ASIDE_SUFFIX = '.submodules';
const SET_ASIDE_RECORD = 'setaside.json';
/** Inside a removed copy: the quarantined checkout, and the submodules set aside from it. */
const CHECKOUT_PART = 'checkout';
const SUBMODULES_PART = 'submodules';

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Reports whether a path exists without following a final symbolic link.
 * @param path - Path to probe.
 * @returns False only for `ENOENT`; every other failure is thrown.
 */
const exists = async (path: string): Promise<boolean> => {
  try {
    await nodeFs.lstat(path);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
};

/**
 * Runs one slot git call with fsmonitor disabled for the call itself.
 * @param cwd - Working directory for git.
 * @param args - Git arguments after the fsmonitor override.
 * @param options - Runner and deadline.
 * @returns The arguments as run and the completed call.
 * @throws {ShutdownError} When the fence closed before or during the call.
 */
const runSlotGit = async (
  cwd: string,
  args: readonly string[],
  options: SlotRemovalOptions
): Promise<{ args: readonly string[]; result: GitBoundedResult }> => {
  const full = ['-c', 'core.fsmonitor=false', ...args];
  const result = await (options.git ?? DEFAULT_GIT).run(cwd, full, {
    timeoutMs: options.timeoutMs ?? SLOT_REMOVAL_GIT_TIMEOUT_MS
  });
  if (result.aborted) throw new ShutdownError(`git ${args.join(' ')} was stopped by shutdown`);
  return { args: full, result };
};

/**
 * Runs one slot git call that must succeed.
 * @param cwd - Working directory for git.
 * @param args - Git arguments after the fsmonitor override.
 * @param options - Runner and deadline.
 * @returns The completed call.
 * @throws {SlotGitError} When git exited non-zero or timed out.
 * @throws {ShutdownError} When the fence closed before or during the call.
 */
const requireSlotGit = async (
  cwd: string,
  args: readonly string[],
  options: SlotRemovalOptions
): Promise<GitBoundedResult> => {
  const { args: full, result } = await runSlotGit(cwd, args, options);
  if (result.timedOut || result.exitCode !== 0) throw new SlotGitError(full, result);
  return result;
};

/**
 * Lists the worktree paths git records for a repository.
 * @param repoRoot - The main repository.
 * @param options - Runner and deadline.
 * @returns Every registered checkout path.
 */
const registeredWorktrees = async (repoRoot: string, options: SlotRemovalOptions): Promise<string[]> =>
  (await requireSlotGit(repoRoot, ['worktree', 'list', '--porcelain'], options)).stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

/** The parts of a held slot lock removal needs. */
export type SlotRemovalLock = Pick<SlotLock, 'slotRoot' | 'ordinal' | 'generation' | 'checkpoint'>;

/**
 * Outcome of {@link removeQuarantinedSlot}. Each carries the
 * {@link processesNotInspected} count of the quarantine's occupant probe, 0
 * when the probe did not run, for the pass's report-level count.
 */
export type SlotRemovalOutcome =
  | {
      readonly status: 'removed';
      /** The removed copy under `.purge`, which the next {@link purgeRemovedSlots} deletes. */
      readonly copy: string;
      readonly processesNotInspected: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'uncommitted_changes' | 'in_use' | 'removal_blocked' | 'removal_restored';
      readonly detail: string;
      /** Where the checkout now is: the slot path after a move-back, otherwise the quarantine. */
      readonly checkoutPath: string;
      readonly processesNotInspected: number;
    };

/**
 * A fresh quarantine path beside a slot: `<slot>.deleting-<uuid>`.
 * @param slotPath - The slot checkout being quarantined.
 * @returns A sibling path that no other removal will pick.
 */
export function quarantinePathFor(slotPath: string): string {
  return `${slotPath}.deleting-${randomUUID()}`;
}

/**
 * Where a quarantine's checkout goes once its removal commits: `<slotRoot>/.purge/<n>.<uuid>`.
 * @param quarantine - A path {@link quarantinePathFor} returned.
 * @returns `<slotRoot>/.purge/<n>.<uuid>` for the quarantine `<slotRoot>/<n>.deleting-<uuid>`.
 * @throws {Error} When the path is not a quarantine.
 */
export function removedCopyPathFor(quarantine: string): string {
  const match = RESIDUE_NAME.exec(basename(quarantine));
  if (match === null || match[3] !== undefined) throw new Error(`${quarantine} is not a slot quarantine`);
  return join(dirname(quarantine), REMOVED_COPIES_DIR, `${match[1]}.${match[2]}`);
}

/** What {@link setAsideSubmodules} wrote first, so the set-aside can always be reversed. */
interface SetAsideRecord {
  readonly version: 1;
  /** The slot's own git directory, whose `modules` holds the submodule repositories. */
  readonly gitDir: string;
  /** Slot-relative paths of the initialized submodules; checkout `i` is held at `<area>/<i>`. */
  readonly paths: readonly string[];
}

/**
 * Moves a slot's initialized top-level submodule checkouts and its
 * `<gitDir>/modules` into a set-aside area, recreating each checkout as the
 * empty directory an uninitialized submodule has. Git refuses to move or remove
 * a worktree with initialized submodules or a `modules` directory, and the
 * modules live in the worktree's own git directory, which removal deletes; set
 * aside, the slot reads as clean and uninitialized, and nothing is lost.
 * Renames only: nothing is deinitialized, which would edit the shared config.
 * @param slotPath - The slot checkout.
 * @param area - The absent set-aside area, `<quarantine>.submodules`.
 * @param options - Git runner and deadline.
 * @returns Whether anything was set aside; the area exists only then.
 * @throws {SlotGitError} When git cannot name the slot's git directory or index.
 */
export async function setAsideSubmodules(
  slotPath: string,
  area: string,
  options: SlotRemovalOptions = {}
): Promise<boolean> {
  const gitDir = (await requireSlotGit(slotPath, ['rev-parse', '--absolute-git-dir'], options)).stdout.trim();
  if (!isAbsolute(gitDir)) throw new Error(`git rev-parse --absolute-git-dir named no directory for ${slotPath}`);
  const paths: string[] = [];
  for (const path of await listGitlinks(slotPath, options))
    if (await exists(join(slotPath, path, '.git'))) paths.push(path);
  const modules = await exists(join(gitDir, 'modules'));
  if (paths.length === 0 && !modules) return false;
  await nodeFs.mkdir(area);
  const record: SetAsideRecord = { version: 1, gitDir, paths };
  await writeDurable(join(area, SET_ASIDE_RECORD), JSON.stringify(record));
  for (const [index, path] of paths.entries()) {
    const checkout = join(slotPath, path);
    const mode = (await nodeFs.lstat(checkout)).mode;
    await nodeFs.rename(checkout, join(area, String(index)));
    // Without the empty directory, status reports the submodule deleted.
    await nodeFs.mkdir(checkout);
    await nodeFs.chmod(checkout, mode & 0o7777);
  }
  if (modules) await nodeFs.rename(join(gitDir, 'modules'), join(area, 'modules'));
  await syncDirectory(area);
  await syncDirectory(dirname(area));
  return true;
}

/**
 * Reverses {@link setAsideSubmodules} into the slot checkout, however far it
 * got: each held checkout replaces the empty directory left in its place, and
 * the modules return to the slot's git directory.
 * @param area - Where {@link setAsideSubmodules} held them, `<quarantine>.submodules`.
 * @param slotPath - The slot checkout, back at its own path.
 * @throws {Error} When something now occupies a place a held part must return to.
 */
export async function restoreSetAsideSubmodules(area: string, slotPath: string): Promise<void> {
  let record: SetAsideRecord;
  try {
    record = JSON.parse(await nodeFs.readFile(join(area, SET_ASIDE_RECORD), 'utf8')) as SetAsideRecord;
  } catch (error) {
    // Interrupted before its record: nothing was moved yet.
    if (codeOf(error) !== 'ENOENT') throw error;
    await nodeFs.unlink(join(area, `${SET_ASIDE_RECORD}.tmp`)).catch((unlinkError: unknown) => {
      if (codeOf(unlinkError) !== 'ENOENT') throw unlinkError;
    });
    await nodeFs.rmdir(area);
    return;
  }
  if (record.version !== 1 || typeof record.gitDir !== 'string' || !Array.isArray(record.paths))
    throw new Error(`Unreadable set-aside record in ${area}`);
  const modules = join(area, 'modules');
  if (await exists(modules)) {
    if (await exists(join(record.gitDir, 'modules')))
      throw new Error(`${join(record.gitDir, 'modules')} exists, so ${modules} cannot return to it`);
    await nodeFs.rename(modules, join(record.gitDir, 'modules'));
  }
  for (const [index, path] of record.paths.entries()) {
    const held = join(area, String(index));
    if (!(await exists(held))) continue;
    const checkout = join(slotPath, path);
    try {
      await nodeFs.rmdir(checkout);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT')
        throw new Error(`${checkout} is not the empty directory the set-aside left, so ${held} cannot return to it`);
    }
    await nodeFs.rename(held, checkout);
  }
  await nodeFs.unlink(join(area, SET_ASIDE_RECORD));
  await nodeFs.rmdir(area);
  await syncDirectory(dirname(area));
}

/**
 * Lists the submodule paths a checkout's index records.
 * @param checkout - Any checkout of the repository, at its current path.
 * @param options - Git runner and deadline.
 * @returns Checkout-relative gitlink paths.
 */
const listGitlinks = async (checkout: string, options: SlotRemovalOptions): Promise<string[]> =>
  (await requireSlotGit(checkout, ['ls-files', '--stage', '-z'], options)).stdout
    .split('\0')
    .filter((record) => record.startsWith('160000 '))
    .map((record) => record.slice(record.indexOf('\t') + 1));

/**
 * Sets the slot's initialized submodules aside, then moves the slot checkout
 * to a fresh quarantine with `git worktree move`. A refused move puts the
 * submodules back.
 * @param repoRoot - Repository owning the checkout's administrative metadata.
 * @param slotPath - The slot checkout.
 * @param options - Git runner and deadline.
 * @returns The quarantine path; its set-aside area, when there is one, is `<quarantine>.submodules`.
 * @throws {SlotGitError} When git refuses the move.
 * @throws {ShutdownError} When the shutdown fence has closed.
 */
export async function quarantineSlot(
  repoRoot: string,
  slotPath: string,
  options: SlotRemovalOptions = {}
): Promise<string> {
  const quarantine = quarantinePathFor(slotPath);
  const area = `${quarantine}${SET_ASIDE_SUFFIX}`;
  const setAside = await setAsideSubmodules(slotPath, area, options);
  try {
    await requireSlotGit(repoRoot, ['worktree', 'move', slotPath, quarantine], options);
  } catch (error) {
    if (setAside) await restoreSetAsideSubmodules(area, slotPath);
    throw error;
  }
  return quarantine;
}

/** The durable record of a committed removal, `<copy>.json`, against which the purge deletes the copy. */
export interface RemovedSlotRecord extends CheckoutRecord {
  readonly version: 1;
  /** Where the checkout was quarantined, which git may still record. */
  readonly quarantine: string;
  readonly slotPath: string;
}

/**
 * Proves a quarantined checkout removable after it was recorded: git shows no
 * change, no uninitialized submodule directory hides a file from git, and no
 * process is proven inside the checkout or its set-aside submodules.
 * @param quarantine - The quarantined checkout.
 * @param probed - Directories the occupant probe must find empty of processes.
 * @param tally - Raised to the largest number of processes a probe could not inspect.
 * @param tally.uninspected - That number so far.
 * @param options - Git runner, deadline and probe overrides.
 * @throws {CheckoutContentChangedError} When the checkout holds changes.
 * @throws {SlotOccupiedError} When a process is proven inside.
 * @throws {OccupantProbeError} When a probe could not decide.
 */
const proveRemovable = async (
  quarantine: string,
  probed: readonly string[],
  tally: { uninspected: number },
  options: SlotRemovalOptions
): Promise<void> => {
  const status = await requireSlotGit(quarantine, ['status', '--porcelain', '--untracked-files=all'], options);
  const changed = status.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
  if (changed.length > 0) throw new CheckoutContentChangedError('Checkout has uncommitted changes', changed);
  // Status never looks inside an uninitialized submodule's directory.
  const hidden: string[] = [];
  for (const path of await listGitlinks(quarantine, options)) {
    const names = await nodeFs.readdir(join(quarantine, path)).catch((error: unknown) => {
      if (codeOf(error) === 'ENOENT') return [];
      throw error;
    });
    hidden.push(...names.map((name) => join(path, name)));
  }
  if (hidden.length > 0)
    throw new CheckoutContentChangedError('Uninitialized submodule directories hold files git does not show', hidden);
  for (const directory of probed) {
    // A process that entered between the caller's probe and the move is inside the quarantine now.
    const probe = await findSlotOccupants(directory, options.occupants);
    tally.uninspected = Math.max(tally.uninspected, processesNotInspected(probe));
    if (slotOccupied(probe)) throw new SlotOccupiedError(probe);
  }
};

/**
 * Deletes an empty copy directory and the record of a removal that did not commit.
 * @param copy - The copy directory.
 */
const discardUncommittedCopy = async (copy: string): Promise<void> => {
  for (const file of [`${copy}.json`, `${copy}.json.tmp`])
    await nodeFs.unlink(file).catch((error: unknown) => {
      if (codeOf(error) !== 'ENOENT') throw error;
    });
  await nodeFs.rmdir(copy).catch((error: unknown) => {
    if (codeOf(error) !== 'ENOENT') throw error;
  });
};

/**
 * Moves a committed removal's set-aside submodules into its copy, where its record expects them.
 * @param area - The set-aside area beside the slot.
 * @param copy - The removed copy.
 * @returns Whether there was a set-aside area to move.
 */
const joinSetAside = async (area: string, copy: string): Promise<boolean> => {
  if (!(await exists(area))) return false;
  await nodeFs.rename(area, join(copy, SUBMODULES_PART));
  await syncDirectory(dirname(area));
  return true;
};

/**
 * Removes a quarantined slot under its lock. It records every entry of the
 * quarantine and of its set-aside submodules, proves them clean and
 * unoccupied, writes the record durably to `<copy>.json`, and commits by
 * renaming the quarantine to `<copy>/checkout`; the set-aside follows to
 * `<copy>/submodules`, and git's record of the vanished quarantine is dropped.
 * Nothing is deleted here: the copy waits for the next pass's
 * {@link purgeRemovedSlots}. A refusal moves the checkout back, then the
 * submodules, only while the slot path is absent; otherwise it stays at the
 * quarantine as `removal_restored`.
 * @param target - The repository, the slot path, its quarantine and the held lock.
 * @param target.repoRoot - Repository owning the checkout's administrative metadata.
 * @param target.slotPath - Path the checkout returns to on refusal.
 * @param target.quarantine - Where {@link quarantineSlot} moved it.
 * @param target.lock - The slot's held `removal` lock.
 * @param options - Git runner, deadline, witness and timing seam.
 * @returns Removed with its copy, or refused with the cleanup reason.
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
  const { repoRoot, slotPath, quarantine, lock } = target;
  const area = `${quarantine}${SET_ASIDE_SUFFIX}`;
  const copy = removedCopyPathFor(quarantine);
  const tally = { uninspected: 0 };
  lock.checkpoint();
  const setAside = await exists(area);
  await nodeFs.mkdir(dirname(copy), { recursive: true });
  await nodeFs.mkdir(copy);
  try {
    const witness = options.witness ?? (await resolveCheckoutWitness(quarantine));
    const parts = [{ name: CHECKOUT_PART, root: quarantine }];
    if (setAside) parts.push({ name: SUBMODULES_PART, root: area });
    const entries = await recordCheckoutParts(parts, (await nodeFs.lstat(copy, { bigint: true })).mtimeNs, witness);
    await proveRemovable(
      quarantine,
      parts.map((part) => part.root),
      tally,
      options
    );
    const record: RemovedSlotRecord = {
      version: 1,
      quarantine,
      slotPath,
      rootMode: (await nodeFs.lstat(copy)).mode,
      witness,
      entries
    };
    await requireCurrentSlotLock(lock);
    await writeDurable(`${copy}.json`, JSON.stringify(record));
    await options.checkpoint?.('recorded');
    lock.checkpoint();
    await nodeFs.rename(quarantine, join(copy, CHECKOUT_PART)).catch((error: unknown) => {
      throw new CheckoutRemovalBlockedError(codeOf(error) ?? String(error), 'rename', '.');
    });
  } catch (error) {
    let reason: 'uncommitted_changes' | 'in_use' | 'removal_blocked';
    if (error instanceof CheckoutContentChangedError) reason = 'uncommitted_changes';
    else if (error instanceof SlotOccupiedError || error instanceof OccupantProbeError) reason = 'in_use';
    else if (error instanceof CheckoutRemovalBlockedError) reason = 'removal_blocked';
    else throw error;
    await discardUncommittedCopy(copy);
    const refused = { status: 'refused', detail: error.message, processesNotInspected: tally.uninspected } as const;
    lock.checkpoint();
    // `git worktree move` into an existing directory nests the checkout inside it.
    if (await exists(slotPath)) return { ...refused, reason: 'removal_restored', checkoutPath: quarantine };
    await requireSlotGit(repoRoot, ['worktree', 'move', quarantine, slotPath], options);
    if (setAside)
      try {
        await restoreSetAsideSubmodules(area, slotPath);
      } catch (restoreError) {
        // Left for residue recovery, which reports it until the slot can take the submodules back.
        const why = restoreError instanceof Error ? restoreError.message : String(restoreError);
        const detail = `${error.message}; its submodules stay set aside at ${area}: ${why}`;
        return { ...refused, detail, reason, checkoutPath: slotPath };
      }
    return { ...refused, reason, checkoutPath: slotPath };
  }
  await syncDirectory(dirname(copy));
  await syncDirectory(dirname(quarantine));
  await options.checkpoint?.('committed');
  await joinSetAside(area, copy);
  lock.checkpoint();
  // The quarantine path no longer exists, so this drops only git's record of it.
  await requireSlotGit(repoRoot, ['worktree', 'remove', quarantine], options);
  await options.checkpoint?.('unregistered');
  return { status: 'removed', copy, processesNotInspected: tally.uninspected };
}

/**
 * Throws unless the lock's generation is still the maximum and unreleased,
 * and the shutdown fence is open.
 * @param lock - The held lock.
 * @throws {ShutdownError} When the fence has closed.
 * @throws {Error} When a newer generation exists or this one was released.
 */
export async function requireCurrentSlotLock(lock: SlotRemovalLock): Promise<void> {
  lock.checkpoint();
  const snapshot = await readSlotLockSnapshot(lock.slotRoot, lock.ordinal);
  const name = `Slot ${String(lock.ordinal)} lock generation ${String(lock.generation)}`;
  if (snapshot === null) throw new Error(`${name} no longer exists`);
  if ('unreadable' in snapshot) throw new Error(`${name} cannot be confirmed: ${snapshot.unreadable}`);
  if (snapshot.generation !== lock.generation)
    throw new Error(`${name} was superseded by generation ${String(snapshot.generation)}`);
  if (snapshot.released !== null) throw new Error(`${name} was released`);
}

// ============================================================================
// Residue
// ============================================================================

/** Removal residue of one slot: quarantines and their set-aside submodules. */
export interface SlotResidue {
  readonly ordinal: number;
  readonly slotPath: string;
  /** `<slot>.deleting-<uuid>` directories. */
  readonly quarantines: readonly string[];
  /** `<slot>.deleting-<uuid>.submodules` directories. */
  readonly setAsides: readonly string[];
}

/** One thing residue recovery did or found. */
export type SlotResidueReport =
  /** A committed removal's set-aside submodules joined its removed copy. */
  | { readonly kind: 'removal_finished'; readonly quarantine: string }
  /** A quarantine was returned to its absent slot path, with its set-aside submodules. */
  | { readonly kind: 'moved_back'; readonly quarantine: string; readonly slotPath: string }
  /** Submodules set aside by a removal interrupted before its quarantine move were put back. */
  | { readonly kind: 'submodules_restored'; readonly setAside: string; readonly slotPath: string }
  /** A lone quarantine could not go back because the slot path exists. */
  | { readonly kind: 'quarantine_stranded'; readonly quarantine: string; readonly slotPath: string }
  /** Git's record of a vanished quarantine was dropped. */
  | { readonly kind: 'pruned'; readonly quarantine: string }
  /** A set-aside area could not be put back; it is kept as it is. */
  | { readonly kind: 'recovery_failed'; readonly holding: string; readonly detail: string };

/**
 * Lists the slots of a slot root that carry removal residue, without locking.
 * @param slotRoot - The card's slot root.
 * @returns Residue per ordinal, ascending.
 */
export async function findSlotResidue(slotRoot: string): Promise<readonly SlotResidue[]> {
  const residue = new Map<number, { quarantines: string[]; setAsides: string[] }>();
  for (const name of (await readdirOrEmpty(slotRoot)).sort()) {
    const match = RESIDUE_NAME.exec(name);
    if (match === null) continue;
    const ordinal = Number(match[1]);
    const slot = residue.get(ordinal) ?? { quarantines: [], setAsides: [] };
    residue.set(ordinal, slot);
    (match[3] === undefined ? slot.quarantines : slot.setAsides).push(join(slotRoot, name));
  }
  return [...residue.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ordinal, { quarantines, setAsides }]) => ({
      ordinal,
      slotPath: join(slotRoot, String(ordinal)),
      quarantines,
      setAsides
    }));
}

/**
 * Lists a directory, treating an absent one as empty.
 * @param directory - Directory to list.
 * @returns Its entry names.
 */
const readdirOrEmpty = async (directory: string): Promise<string[]> => {
  try {
    return await nodeFs.readdir(directory);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }
};

/**
 * Puts set-aside submodules back into the slot, reporting a refusal instead of throwing.
 * @param area - The set-aside area.
 * @param slotPath - The slot checkout.
 * @returns A `recovery_failed` report, or null once restored.
 */
const restoreOrReport = async (area: string, slotPath: string): Promise<SlotResidueReport | null> => {
  try {
    await restoreSetAsideSubmodules(area, slotPath);
    return null;
  } catch (error) {
    return { kind: 'recovery_failed', holding: area, detail: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Recovers one slot's removal residue under a lock the caller already holds.
 * A committed removal (its copy holds the checkout) only has its set-aside
 * submodules joined to the copy. Otherwise a quarantine moves back while the
 * slot path is absent, then its submodules return, or it is reported
 * `quarantine_stranded`; submodules set aside before an interrupted move
 * return to the slot. Git's records of vanished quarantines are pruned.
 * @param target - The repository, the slot path and the held lock.
 * @param target.repoRoot - Repository owning the checkouts' administrative metadata.
 * @param target.slotPath - The slot checkout path.
 * @param target.lock - The slot's held lock.
 * @param options - Git runner and deadline.
 * @returns What was done, in order.
 * @throws {ShutdownError} When the fence closed between steps.
 * @throws {SlotGitError} When a move-back, listing or prune git call failed.
 */
export async function recoverSlotResidueLocked(
  target: { readonly repoRoot: string; readonly slotPath: string; readonly lock: SlotRemovalLock },
  options: SlotRemovalOptions = {}
): Promise<readonly SlotResidueReport[]> {
  const { repoRoot, slotPath, lock } = target;
  const ordinal = basename(slotPath);
  const quarantines = new Set<string>();
  for (const name of await readdirOrEmpty(dirname(slotPath))) {
    const match = RESIDUE_NAME.exec(name);
    if (match?.[1] === ordinal) quarantines.add(join(dirname(slotPath), `${ordinal}.deleting-${match[2]}`));
  }
  const reports: SlotResidueReport[] = [];
  for (const quarantine of [...quarantines].sort()) {
    lock.checkpoint();
    const area = `${quarantine}${SET_ASIDE_SUFFIX}`;
    const copy = removedCopyPathFor(quarantine);
    if (await exists(join(copy, CHECKOUT_PART))) {
      if (await joinSetAside(area, copy)) reports.push({ kind: 'removal_finished', quarantine });
      continue;
    }
    if (await exists(quarantine)) {
      if (await exists(slotPath)) {
        reports.push({ kind: 'quarantine_stranded', quarantine, slotPath });
        continue;
      }
      lock.checkpoint();
      await requireSlotGit(repoRoot, ['worktree', 'move', quarantine, slotPath], options);
      reports.push({ kind: 'moved_back', quarantine, slotPath });
      const failed = (await exists(area)) ? await restoreOrReport(area, slotPath) : null;
      if (failed !== null) reports.push(failed);
    } else if (await exists(area)) {
      // Interrupted between the set-aside and the move, so the checkout never left the slot path.
      const failed = (await exists(slotPath))
        ? await restoreOrReport(area, slotPath)
        : ({
            kind: 'recovery_failed',
            holding: area,
            detail: `${slotPath} is gone, so the submodules set aside at ${area} have nowhere to return`
          } as const);
      reports.push(failed ?? { kind: 'submodules_restored', setAside: area, slotPath });
    }
  }
  lock.checkpoint();
  const quarantineName = new RegExp(`^${ordinal}\\.deleting-${UUID}$`);
  for (const registered of await registeredWorktrees(repoRoot, options)) {
    if (dirname(registered) !== dirname(slotPath) || !quarantineName.test(basename(registered))) continue;
    if (await exists(registered)) continue;
    lock.checkpoint();
    await requireSlotGit(repoRoot, ['worktree', 'remove', registered], options);
    reports.push({ kind: 'pruned', quarantine: registered });
  }
  return reports;
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
 * @returns One outcome per slot with residue, including slots whose quarantine vanished and left only git's record.
 * @throws {ShutdownError} When the fence closed between steps.
 * @throws {SlotGitError} When a git call failed.
 */
export async function recoverSlotResidue(
  slotRoot: string,
  withSlotLock: SlotResidueLocker,
  options: SlotRemovalOptions & { readonly repoRoot: string }
): Promise<readonly SlotResidueRecovery[]> {
  const ordinals = new Set((await findSlotResidue(slotRoot)).map((residue) => residue.ordinal));
  // A quarantine that vanished leaves only git's record behind.
  for (const registered of await registeredWorktrees(options.repoRoot, options)) {
    const match = dirname(registered) === slotRoot ? RESIDUE_NAME.exec(basename(registered)) : null;
    if (match !== null && match[3] === undefined && !(await exists(registered))) ordinals.add(Number(match[1]));
  }
  const recoveries: SlotResidueRecovery[] = [];
  for (const ordinal of [...ordinals].sort((left, right) => left - right)) {
    const slotPath = join(slotRoot, String(ordinal));
    const result = await withSlotLock(ordinal, 'removal', (lock) =>
      recoverSlotResidueLocked({ repoRoot: options.repoRoot, slotPath, lock }, options)
    );
    recoveries.push(
      result.status === 'done'
        ? { ordinal, status: 'recovered', reports: result.value }
        : { ordinal, status: 'skipped', lock: result }
    );
  }
  return recoveries;
}

// ============================================================================
// Purge
// ============================================================================

/** A removed slot copy waiting under its slot root's `.purge`. */
export interface RemovedSlotCopy {
  readonly ordinal: number;
  /** `<slotRoot>/.purge/<n>.<uuid>`; the directory itself may already be gone, leaving its record. */
  readonly copy: string;
}

/**
 * Lists the removed copies of a slot root, without locking. Each one reserves
 * its ordinal: a slot must not be recreated at an ordinal whose copy still
 * waits, since the purge deletes under that ordinal's lock.
 * @param slotRoot - The card's slot root.
 * @returns One per copy, its record or its purge's holding area, by ordinal then name.
 */
export async function findRemovedSlotCopies(slotRoot: string): Promise<readonly RemovedSlotCopy[]> {
  const copies = new Map<string, RemovedSlotCopy>();
  const directory = join(slotRoot, REMOVED_COPIES_DIR);
  for (const name of await readdirOrEmpty(directory)) {
    const match = COPY_NAME.exec(name);
    if (match === null) continue;
    const copy = join(directory, `${match[1]}.${match[2]}`);
    copies.set(copy, { ordinal: Number(match[1]), copy });
  }
  return [...copies.values()].sort(
    (left, right) => left.ordinal - right.ordinal || left.copy.localeCompare(right.copy)
  );
}

/** What {@link purgeRemovedSlots} did with one removed copy. */
export type RemovedCopyPurge = { readonly copy: string; readonly processesNotInspected: number } & (
  | { readonly status: 'purged' }
  /** Left for a later pass: busy, locked or out of budget. */
  | { readonly status: 'pending'; readonly detail: string }
  /** It may hold work, so it is never deleted automatically; the detail says to check it and delete it by hand. */
  | { readonly status: 'kept'; readonly detail: string }
);

/** Options of {@link purgeRemovedSlots}. */
export interface RemovedSlotPurgeOptions extends Omit<SlotRemovalOptions, 'checkpoint' | 'witness'> {
  /** The repository owning the removed checkouts' administrative metadata. */
  readonly repoRoot: string;
  /** Epoch milliseconds after which no further entry is deleted; the rest stays pending. */
  readonly deadline: number;
  /**
   * Copies this pass itself removed. They are left untouched and uncounted, so
   * a removed slot's copy is deleted on the next pass, never the one that
   * removed it.
   */
  readonly skip: ReadonlySet<string>;
  /** Injectable mutations of the dismantle. */
  readonly filesystem?: Partial<CheckoutFilesystem>;
  /** Timing seam passed to the dismantle. */
  readonly checkpoint?: (entryPath: string) => Promise<void>;
}

/** The purge's deadline passed; the copy is left for a later pass. */
class PurgeDeadlineError extends Error {
  constructor() {
    super('The cleanup budget ran out');
    this.name = 'PurgeDeadlineError';
  }
}

/**
 * The detail of a kept copy.
 * @param reason - Why it was kept.
 * @param copy - The removed copy the detail names for deletion by hand.
 * @returns The reason, then the exact path to check and delete by hand.
 */
const keptDetail = (reason: string, copy: string): string =>
  `${reason}. Check its contents, then delete ${copy} by hand`;

/**
 * Reads a copy's removal record, or null when it is absent or unreadable.
 * @param copy - The removed copy, whose record is its `.json` sibling.
 * @returns The parsed record when it is version 1 with entries, a witness and a root mode.
 */
const readRemovedSlotRecord = async (copy: string): Promise<RemovedSlotRecord | null> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await nodeFs.readFile(`${copy}.json`, 'utf8'));
  } catch {
    return null;
  }
  const record = parsed as Partial<RemovedSlotRecord> | null;
  if (
    record?.version !== 1 ||
    !Array.isArray(record.entries) ||
    (record.witness !== 'ctime' && record.witness !== 'hash') ||
    typeof record.rootMode !== 'number'
  )
    return null;
  return record as RemovedSlotRecord;
};

/**
 * Re-records a copy whose entries a refused dismantle restored unchanged, so
 * the restoration's own renames and recreated directories do not read as
 * changes on the next pass. A restoration that found anything changed or
 * displaced keeps the original record, and with it the copy kept; so does
 * every entry it could not re-verify.
 * @param copy - The removed copy, whose `.json` record is rewritten.
 * @param record - Its record.
 * @param restoration - What the restoration found.
 */
const refreshRemovedSlotRecord = async (
  copy: string,
  record: RemovedSlotRecord,
  restoration: CheckoutRestoration
): Promise<void> => {
  if (restoration.changed.length > 0 || restoration.displaced.length > 0) return;
  const entries = record.entries.map((entry, index): CheckoutEntry => restoration.refreshed.get(index) ?? entry);
  await writeDurable(`${copy}.json`, JSON.stringify({ ...record, entries }));
};

/**
 * Removes a file, treating an absent one as removed.
 * @param path - The file.
 */
const unlinkIfPresent = async (path: string): Promise<void> => {
  await nodeFs.unlink(path).catch((error: unknown) => {
    if (codeOf(error) !== 'ENOENT') throw error;
  });
};

/**
 * Purges one removed copy under its ordinal's lock.
 * @param copy - A removed copy under `.purge`, taken under its ordinal lock.
 * @param lock - The ordinal's held lock.
 * @param options - Repository, deadline, git runner and probe overrides.
 * @returns What happened to it, or null when only the leftovers of an uncommitted removal were cleared.
 * @throws {ShutdownError} When the fence closed.
 */
const purgeRemovedCopy = async (
  copy: string,
  lock: SlotRemovalLock,
  options: RemovedSlotPurgeOptions
): Promise<RemovedCopyPurge | null> => {
  const held = `${copy}.held`;
  const pending = (detail: string, processesNotInspected = 0): RemovedCopyPurge => ({
    copy,
    status: 'pending',
    detail,
    processesNotInspected
  });
  const kept = (reason: string, processesNotInspected = 0): RemovedCopyPurge => ({
    copy,
    status: 'kept',
    detail: keptDetail(reason, copy),
    processesNotInspected
  });
  if (Date.now() >= options.deadline) return pending(new PurgeDeadlineError().message);
  lock.checkpoint();
  if (await exists(held)) {
    // An earlier purge of this copy was interrupted mid-dismantle.
    let recovery: CheckoutRemovalRecovery;
    try {
      recovery = await recoverCheckoutRemoval(held, options.filesystem);
    } catch (error) {
      return kept(
        `Its interrupted purge cannot be resolved: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (recovery.kind === 'finished') {
      await unlinkIfPresent(`${copy}.json`);
      await syncDirectory(dirname(copy));
      return { copy, status: 'purged', processesNotInspected: 0 };
    }
    if (recovery.kind === 'restored') {
      if (recovery.changed.length > 0 || recovery.displaced.length > 0)
        return kept(
          `It changed during an interrupted purge: ${[...recovery.changed, ...recovery.displaced].join(', ')}`
        );
      const record = await readRemovedSlotRecord(copy);
      if (record !== null) await refreshRemovedSlotRecord(copy, record, recovery);
      if (recovery.unverified.length > 0)
        return kept(
          `Its purge was interrupted, and these entries cannot be proven unchanged since: ${recovery.unverified.join(', ')}`
        );
    }
  }
  if (!(await exists(join(copy, CHECKOUT_PART)))) {
    if (await exists(copy)) {
      // A removal that never committed; its checkout went back to the slot.
      try {
        await nodeFs.rmdir(copy);
      } catch (error) {
        if (codeOf(error) === 'ENOTEMPTY' || codeOf(error) === 'EEXIST')
          return kept('It holds files but no removed checkout');
        throw error;
      }
    }
    await unlinkIfPresent(`${copy}.json.tmp`);
    await unlinkIfPresent(`${copy}.json`);
    return null;
  }
  // Finish what a removal interrupted after its commit.
  const match = COPY_NAME.exec(basename(copy)) as RegExpExecArray;
  const slotRoot = dirname(dirname(copy));
  const quarantine = join(slotRoot, `${match[1]}.deleting-${match[2]}`);
  await joinSetAside(`${quarantine}${SET_ASIDE_SUFFIX}`, copy);
  if ((await registeredWorktrees(options.repoRoot, options)).includes(quarantine) && !(await exists(quarantine))) {
    lock.checkpoint();
    await requireSlotGit(options.repoRoot, ['worktree', 'remove', quarantine], options);
  }
  const record = await readRemovedSlotRecord(copy);
  if (record === null) return kept('It has no readable removal record');
  let uninspected = 0;
  try {
    const probe = await findSlotOccupants(copy, options.occupants);
    uninspected = processesNotInspected(probe);
    if (slotOccupied(probe)) return pending(`It is ${describeSlotOccupancy(probe)}`, uninspected);
  } catch (error) {
    if (error instanceof OccupantProbeError) return pending(error.message);
    throw error;
  }
  const changes = await findCheckoutChanges(copy, record.entries, record.witness);
  if (changes.length > 0) return kept(`It changed after its removal: ${changes.join(', ')}`, uninspected);
  // Whether a refused dismantle put every entry back as recorded, so the copy can wait for a later pass.
  let restoredIntact = false;
  try {
    await dismantleCheckout({ root: copy, holding: held, restoreTo: copy }, record, {
      requireCurrent: async () => {
        if (Date.now() >= options.deadline) throw new PurgeDeadlineError();
        await requireCurrentSlotLock(lock);
      },
      onRestored: async (restoration) => {
        await refreshRemovedSlotRecord(copy, record, restoration);
        restoredIntact =
          restoration.changed.length === 0 && restoration.displaced.length === 0 && restoration.unverified.length === 0;
      },
      ...(options.filesystem === undefined ? {} : { filesystem: options.filesystem }),
      ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint })
    });
  } catch (error) {
    if (error instanceof ShutdownError) throw error;
    if (error instanceof CheckoutContentChangedError || error instanceof CheckoutRestoredError)
      return kept(`It changed during its purge: ${error.changed.join(', ')}`, uninspected);
    // A refused operation leaves an intact copy for a later pass; a refused restoration leaves it as it is.
    if (error instanceof CheckoutRemovalBlockedError)
      return restoredIntact ? pending(error.message, uninspected) : kept(error.message, uninspected);
    if (error instanceof Error) {
      if (!restoredIntact)
        return kept(`Its purge stopped and could not prove it restored: ${error.message}`, uninspected);
      return pending(error.message, uninspected);
    }
    throw error;
  }
  await unlinkIfPresent(`${copy}.json`);
  await syncDirectory(dirname(copy));
  return { copy, status: 'purged', processesNotInspected: uninspected };
};

/**
 * Deletes the removed slot copies of every card of a repository, deleted
 * cards included, each under its ordinal's `removal` lock. A copy is deleted
 * entry by entry against the record its removal took, after a probe finds no
 * process inside: one that changed since its removal is kept and reported,
 * never deleted, and one that is busy, locked or past the deadline stays
 * pending for a later pass. Copies in `options.skip` are not looked at.
 *
 * Any failure other than shutdown stops the purge and is returned beside the
 * outcomes so far, so the report shows a failed purge instead of an empty one.
 * @param cardsDir - The repository's slot namespace, whose entries are card slot roots.
 * @param lockerFor - Takes a slot lock of the given slot root around a function.
 * @param options - Repository, deadline, copies to skip, git runner and probe overrides.
 * @returns One outcome per copy reached, except leftovers of removals that never committed, which are
 * cleared silently, and the failure that stopped the purge, or null.
 * @throws {ShutdownError} When the fence closed.
 */
export async function purgeRemovedSlots(
  cardsDir: string,
  lockerFor: (slotRoot: string) => SlotResidueLocker,
  options: RemovedSlotPurgeOptions
): Promise<RemovedSlotPurge> {
  const outcomes: RemovedCopyPurge[] = [];
  try {
    await purgeInto(outcomes, cardsDir, lockerFor, options);
  } catch (error) {
    if (error instanceof ShutdownError) throw error;
    return { outcomes, failure: error instanceof Error && error.message !== '' ? error.message : String(error) };
  }
  return { outcomes, failure: null };
}

/**
 * The body of {@link purgeRemovedSlots}, appending each outcome as it is decided.
 * @param outcomes - Receives the outcomes, so those decided before a failure survive it.
 * @param cardsDir - The repository's slot namespace.
 * @param lockerFor - Takes a slot lock of the given slot root around a function.
 * @param options - Repository, deadline, copies to skip, git runner and probe overrides.
 */
const purgeInto = async (
  outcomes: RemovedCopyPurge[],
  cardsDir: string,
  lockerFor: (slotRoot: string) => SlotResidueLocker,
  options: RemovedSlotPurgeOptions
): Promise<void> => {
  for (const card of (await readdirOrEmpty(cardsDir)).sort()) {
    const slotRoot = join(cardsDir, card);
    const byOrdinal = new Map<number, string[]>();
    for (const { ordinal, copy } of await findRemovedSlotCopies(slotRoot))
      if (!options.skip.has(copy)) byOrdinal.set(ordinal, [...(byOrdinal.get(ordinal) ?? []), copy]);
    for (const [ordinal, copies] of byOrdinal) {
      if (Date.now() >= options.deadline) {
        for (const copy of copies)
          outcomes.push({
            copy,
            status: 'pending',
            detail: new PurgeDeadlineError().message,
            processesNotInspected: 0
          });
        continue;
      }
      const result = await lockerFor(slotRoot)(ordinal, 'removal', async (lock) => {
        const purged: RemovedCopyPurge[] = [];
        for (const copy of copies) {
          const outcome = await purgeRemovedCopy(copy, lock, options);
          if (outcome !== null) purged.push(outcome);
        }
        return purged;
      });
      if (result.status === 'done') outcomes.push(...result.value);
      else
        for (const copy of copies)
          outcomes.push({
            copy,
            status: 'pending',
            detail: `Slot ${String(ordinal)} lock is ${result.status}`,
            processesNotInspected: 0
          });
    }
  }
};

/** What {@link purgeRemovedSlots} did. */
export interface RemovedSlotPurge {
  readonly outcomes: readonly RemovedCopyPurge[];
  /** Why the purge stopped early, or null when it went through every copy. */
  readonly failure: string | null;
}

/**
 * Folds a purge into the report's summary.
 * @param purge - What {@link purgeRemovedSlots} returned.
 * @param purge.outcomes - One per copy it reached.
 * @param purge.failure - Why it stopped early, or null.
 * @returns Counts of purged and pending copies, every kept copy with its detail, and the failure.
 */
export function summarizeRemovedSlotPurge({ outcomes, failure }: RemovedSlotPurge): WorktreePurgeSummary {
  return {
    failure,
    purged: outcomes.filter((outcome) => outcome.status === 'purged').length,
    pending: outcomes.filter((outcome) => outcome.status === 'pending').length,
    kept: outcomes.flatMap((outcome) =>
      outcome.status === 'kept' ? [{ path: outcome.copy, detail: outcome.detail }] : []
    )
  };
}

// ============================================================================
// Occupants
// ============================================================================

/** A process whose cwd, root or an open file is inside the slot. */
export interface SlotOccupant {
  readonly pid: number;
  readonly command: string;
}

/** Result of {@link findSlotOccupants}. */
export interface SlotOccupantProbe {
  readonly occupants: readonly SlotOccupant[];
  /**
   * Live processes of the prober's own user (or of any user when the prober is
   * root) whose cwd, root or descriptors the OS would not show, such as a
   * non-dumpable ssh-agent. They never block removal: only a proven occupant
   * keeps a slot. Kept for the report-level count and the logs.
   */
  readonly uninspectable: readonly SlotOccupant[];
  /**
   * Processes owned by other users, which an unprivileged prober cannot inspect.
   * They never block removal either. Reported as a count only.
   */
  readonly otherUsers: number;
}

/**
 * Whether a probe leaves the slot in use: a process whose cwd, root or an open
 * file is proven inside it. A process that could not be inspected never counts.
 * @param probe - The probe result.
 * @returns True when removal must not proceed.
 */
export function slotOccupied(probe: SlotOccupantProbe): boolean {
  return probe.occupants.length > 0;
}

/**
 * How many processes a probe could not inspect, whoever owns them, for the
 * report-level `processesNotInspected` count.
 * @param probe - The probe result.
 * @returns The uninspectable own processes plus the other users' processes.
 */
export function processesNotInspected(probe: SlotOccupantProbe): number {
  return probe.uninspectable.length + probe.otherUsers;
}

/**
 * Describes why a probe leaves a slot in use.
 * @param probe - A probe for which {@link slotOccupied} holds.
 * @returns The proven occupants, by command and pid.
 */
export function describeSlotOccupancy(probe: SlotOccupantProbe): string {
  const name = (process: SlotOccupant): string =>
    `${process.command === '' ? 'process' : process.command} (pid ${String(process.pid)})`;
  return `in use by ${probe.occupants.map(name).join(', ')}`;
}

/** A quarantined slot's occupant probe found it in use, so removal was refused. */
export class SlotOccupiedError extends Error {
  readonly probe: SlotOccupantProbe;
  /**
   * Records the probe that refused removal.
   * @param probe - A probe for which {@link slotOccupied} holds.
   */
  constructor(probe: SlotOccupantProbe) {
    super(`The slot is ${describeSlotOccupancy(probe)}`);
    this.name = 'SlotOccupiedError';
    this.probe = probe;
  }
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
  /** The prober's effective uid; defaults to `process.geteuid()`. */
  readonly uid?: number;
  /** Runs `lsof` and `ps` on macOS. */
  readonly runCommand?: (
    file: string,
    args: readonly string[],
    options: BoundedCommandOptions
  ) => Promise<BoundedCommandResult>;
  /** The `lsof` executable; defaults to `lsof`. */
  readonly lsof?: string;
  /** The `ps` executable; defaults to `ps`. */
  readonly ps?: string;
  readonly timeoutMs?: number;
}

/** Default deadline of each macOS probe command. */
const OCCUPANT_PROBE_TIMEOUT_MS = 10_000;

const HOST_PROC: ProcReader = {
  readdir: (path) => nodeFs.readdir(path),
  readlink: (path) => nodeFs.readlink(path),
  readFile: (path) => nodeFs.readFile(path, 'utf8')
};

const NO_OCCUPANTS: SlotOccupantProbe = { occupants: [], uninspectable: [], otherUsers: 0 };

/**
 * The prober's effective uid.
 * @param options - The probe options.
 * @returns The uid probed processes are compared with.
 * @throws {OccupantProbeError} When the platform reports no uid.
 */
const proberUid = (options: OccupantProbeOptions): number => {
  const uid = options.uid ?? process.geteuid?.();
  if (uid === undefined) throw new OccupantProbeError('the prober has no effective uid');
  return uid;
};

/**
 * Walks `/proc` for processes whose cwd, root or an open descriptor resolves inside the slot.
 * A process the kernel will not show is attributed by the effective uid in its world-readable
 * `status`: another user's is counted, the prober's own (or any, when the prober is root) is
 * listed as uninspectable. A process that exited, or is exiting (state `Z` or `X`), during the
 * scan is gone rather than uninspectable: one mid-exec or mid-exit briefly reads `EACCES`.
 * @param slot - Real path of the slot.
 * @param proc - The `/proc` reader.
 * @param uid - The prober's effective uid.
 * @returns The occupants, the live own processes it could not inspect, and the other users' count.
 * @throws {OccupantProbeError} When `/proc` is unreadable or a read fails unexpectedly.
 */
const probeProc = async (slot: string, proc: ProcReader, uid: number): Promise<SlotOccupantProbe> => {
  const inside = (link: string): boolean => {
    const path = link.endsWith(' (deleted)') ? link.slice(0, -' (deleted)'.length) : link;
    return path === slot || path.startsWith(`${slot}${sep}`);
  };
  let pids: number[];
  try {
    pids = (await proc.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
  } catch (error) {
    throw new OccupantProbeError(`/proc is unreadable: ${codeOf(error) ?? String(error)}`);
  }
  const occupants: SlotOccupant[] = [];
  const uninspectable: SlotOccupant[] = [];
  let otherUsers = 0;
  const unexpected = (path: string, error: unknown): OccupantProbeError =>
    new OccupantProbeError(`Reading ${path} failed: ${codeOf(error) ?? String(error)}`);
  const commandOf = async (base: string): Promise<string> => {
    try {
      return (await proc.readFile(`${base}/comm`)).trim();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') return '';
      throw unexpected(`${base}/comm`, error);
    }
  };
  /**
   * Attributes a process whose links the kernel refused; returns without effect if it exited.
   * @param pid - The hidden process.
   * @param base - Its `/proc` directory.
   */
  const attribute = async (pid: number, base: string): Promise<void> => {
    let status: string;
    try {
      status = await proc.readFile(`${base}/status`);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ESRCH') return;
      // An owner that cannot be read cannot be shown to be another user.
      if (code === 'EACCES' || code === 'EPERM') {
        uninspectable.push({ pid, command: await commandOf(base) });
        return;
      }
      throw unexpected(`${base}/status`, error);
    }
    // A zombie or dying process has no cwd left to be inside the slot.
    if (/^State:\s+[ZX]/m.test(status)) return;
    const owner = /^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1];
    if (owner === undefined) throw new OccupantProbeError(`${base}/status has no Uid line`);
    if (uid !== 0 && Number(owner) !== uid) {
      otherUsers++;
      return;
    }
    uninspectable.push({ pid, command: await commandOf(base) });
  };
  const probe = async (pid: number): Promise<void> => {
    const base = `/proc/${String(pid)}`;
    try {
      let hit = inside(await proc.readlink(`${base}/cwd`)) || inside(await proc.readlink(`${base}/root`));
      if (!hit) {
        for (const fd of await proc.readdir(`${base}/fd`)) {
          let target: string;
          try {
            target = await proc.readlink(`${base}/fd/${fd}`);
          } catch (error) {
            // A descriptor closed between the listing and the read.
            if (codeOf(error) === 'ENOENT') continue;
            throw error;
          }
          if (inside(target)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) occupants.push({ pid, command: await commandOf(base) });
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ESRCH') return;
      if (code === 'EACCES' || code === 'EPERM') return attribute(pid, base);
      if (error instanceof OccupantProbeError) throw error;
      throw unexpected(base, error);
    }
  };
  for (let index = 0; index < pids.length; index += 64) await Promise.all(pids.slice(index, index + 64).map(probe));
  const byPid = (left: SlotOccupant, right: SlotOccupant): number => left.pid - right.pid;
  return { occupants: occupants.sort(byPid), uninspectable: uninspectable.sort(byPid), otherUsers };
};

/**
 * Runs one macOS probe command and rejects any incomplete answer.
 * @param file - The executable.
 * @param args - Its arguments.
 * @param options - Command runner and deadline.
 * @returns The completed result.
 * @throws {OccupantProbeError} When the command is missing, timed out or truncated.
 */
const runProbeCommand = async (
  file: string,
  args: readonly string[],
  options: OccupantProbeOptions
): Promise<BoundedCommandResult> => {
  const result = await (options.runCommand ?? runBoundedCommand)(file, args, {
    timeoutMs: options.timeoutMs ?? OCCUPANT_PROBE_TIMEOUT_MS
  });
  if (result.error !== undefined) throw new OccupantProbeError(`${file} could not run: ${result.error}`);
  if (result.timedOut) throw new OccupantProbeError(`${file} timed out`);
  if (!result.outputComplete) throw new OccupantProbeError(`${file} output was truncated`);
  return result;
};

/**
 * Asks `lsof` for processes with the slot as cwd or root or with files open beneath it, and `ps`
 * for the processes it cannot have inspected. macOS shows a process's descriptors and vnode paths
 * only to its own user or root, and `lsof` drops the rest silently, so every process `ps` lists
 * under another uid is counted as another user's; the prober's own processes are all visible to it.
 * @param slotPath - The slot checkout.
 * @param options - Command runners, executables, deadline and uid.
 * @returns The occupants and the other users' count; nothing of the prober's is hidden.
 * @throws {OccupantProbeError} When `lsof` or `ps` is missing, timed out, truncated or failed.
 */
const probeLsof = async (slotPath: string, options: OccupantProbeOptions): Promise<SlotOccupantProbe> => {
  const uid = proberUid(options);
  const result = await runProbeCommand(options.lsof ?? 'lsof', ['-n', '-P', '-w', '-F', 'pc', '+D', slotPath], options);
  const occupants = new Map<number, string>();
  let current: number | undefined;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) {
      current = Number(line.slice(1));
      occupants.set(current, '');
    } else if (line.startsWith('c') && current !== undefined) occupants.set(current, line.slice(1));
  }
  // lsof exits 1 both for "nothing found" and for errors, so only an empty answer means none.
  if (!(result.exitCode === 1 && occupants.size === 0) && result.exitCode !== 0)
    throw new OccupantProbeError(`lsof exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  let otherUsers = 0;
  if (uid !== 0) {
    const listing = await runProbeCommand(options.ps ?? 'ps', ['-ax', '-o', 'uid='], options);
    if (listing.exitCode !== 0)
      throw new OccupantProbeError(`ps exited ${String(listing.exitCode)}: ${listing.stderr.trim()}`);
    for (const line of listing.stdout.split('\n')) {
      const owner = line.trim();
      if (owner === '') continue;
      if (!/^\d+$/.test(owner)) throw new OccupantProbeError(`ps listed an unreadable uid: ${owner}`);
      if (Number(owner) !== uid) otherUsers++;
    }
  }
  return {
    occupants: [...occupants.entries()]
      .sort(([left], [right]) => left - right)
      .map(([pid, command]) => ({ pid, command })),
    uninspectable: [],
    otherUsers
  };
};

/**
 * Lists processes whose cwd, root or open files are inside a slot. Never signals.
 * @param slotPath - The slot checkout.
 * @param options - Platform, `/proc` reader, uid and command overrides.
 * @returns The occupants, which alone block removal, and what could not be inspected.
 * @throws {OccupantProbeError} When the probe itself failed.
 */
export async function findSlotOccupants(
  slotPath: string,
  options: OccupantProbeOptions = {}
): Promise<SlotOccupantProbe> {
  const platform = options.platform ?? process.platform;
  // Windows refuses to rename or delete an open file, so removal itself reports `removal_blocked`.
  if (platform === 'win32') return NO_OCCUPANTS;
  if (platform !== 'linux') return probeLsof(slotPath, options);
  let slot: string;
  try {
    slot = await nodeFs.realpath(slotPath);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return NO_OCCUPANTS;
    throw new OccupantProbeError(`Resolving ${slotPath} failed: ${codeOf(error) ?? String(error)}`);
  }
  return probeProc(slot, options.proc ?? HOST_PROC, proberUid(options));
}

/**
 * Stops the slot's fsmonitor daemon through git's own IPC; "not running" and
 * "unsupported" count as success.
 * @param slotPath - The slot checkout.
 * @param options - Git runner and deadline.
 * @throws {SlotGitError} When git reports any other failure.
 */
export async function stopSlotFsmonitor(slotPath: string, options: SlotRemovalOptions = {}): Promise<void> {
  const { args, result } = await runSlotGit(slotPath, ['fsmonitor--daemon', 'stop'], options);
  if (result.timedOut) throw new SlotGitError(args, result);
  if (result.exitCode === 0) return;
  if (/not running|not supported|unsupported|is not a git command/i.test(result.stderr)) return;
  throw new SlotGitError(args, result);
}

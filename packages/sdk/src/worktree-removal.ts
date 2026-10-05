/**
 * Slot-level removal for default-configuration: quarantines a slot checkout
 * with `git worktree move`, deletes it through verified checkout removal under
 * the slot's lock fence, recovers removal residue, and reports processes still
 * inside a slot instead of signalling them.
 * @summary Verified slot removal, residue recovery and occupant probing
 */

import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { type GitBoundedResult, type RunGitBoundedOptions, runGitBounded, ShutdownError } from './bounded-git.js';
import {
  CheckoutContentChangedError,
  CheckoutRemovalBlockedError,
  CheckoutRestoredError,
  type CheckoutWitness,
  recoverCheckoutRemoval,
  removeQuarantinedCheckout
} from './checkout-removal.js';
import { type BoundedCommandOptions, type BoundedCommandResult, runBoundedCommand } from './process-identity.js';
import { type AcquireSlotLockResult, readSlotLockSnapshot, type SlotLock, type SlotLockPrevious } from './slot-lock.js';

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

const DEFAULT_GIT: SlotRemovalGit = { run: runGitBounded };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESIDUE_NAME = new RegExp(`^([1-9]\\d*)\\.deleting-(${UUID})(\\.held)?$`);

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
  return `${slotPath}.deleting-${randomUUID()}`;
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
  const quarantine = quarantinePathFor(slotPath);
  await requireSlotGit(repoRoot, ['worktree', 'move', slotPath, quarantine], options);
  return quarantine;
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
  const { repoRoot, slotPath, quarantine, lock } = target;
  lock.checkpoint();
  try {
    await removeQuarantinedCheckout(
      { root: quarantine, holding: `${quarantine}.held`, restoreTo: slotPath },
      {
        prove: async () => {
          const status = await requireSlotGit(quarantine, ['status', '--porcelain', '--untracked-files=all'], options);
          const changed = status.stdout
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => line.slice(3));
          if (changed.length > 0) throw new CheckoutContentChangedError('Checkout has uncommitted changes', changed);
        },
        requireCurrent: () => requireCurrentSlotLock(lock),
        ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
        ...(options.witness === undefined ? {} : { witness: options.witness })
      }
    );
  } catch (error) {
    let reason: 'uncommitted_changes' | 'removal_blocked' | 'removal_restored';
    if (error instanceof CheckoutContentChangedError) reason = 'uncommitted_changes';
    else if (error instanceof CheckoutRemovalBlockedError) reason = 'removal_blocked';
    else if (error instanceof CheckoutRestoredError) reason = 'removal_restored';
    else throw error;
    const detail = error.message;
    // A refused restoration leaves entries held; recovery owns the quarantine from here.
    if (error instanceof CheckoutRemovalBlockedError && error.syscall === 'restore')
      return { status: 'refused', reason, detail, checkoutPath: quarantine };
    lock.checkpoint();
    // `git worktree move` into an existing directory nests the checkout inside it.
    if (await exists(slotPath))
      return { status: 'refused', reason: 'removal_restored', detail, checkoutPath: quarantine };
    await requireSlotGit(repoRoot, ['worktree', 'move', quarantine, slotPath], options);
    return { status: 'refused', reason, detail, checkoutPath: slotPath };
  }
  lock.checkpoint();
  // With the directory gone this drops only git's administrative record.
  await requireSlotGit(repoRoot, ['worktree', 'remove', quarantine], options);
  return { status: 'removed' };
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
  let names: string[];
  try {
    names = await nodeFs.readdir(slotRoot);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  }
  const residue = new Map<number, { quarantines: string[]; holdings: string[] }>();
  for (const name of names.sort()) {
    const match = RESIDUE_NAME.exec(name);
    if (match === null) continue;
    const ordinal = Number(match[1]);
    const slot = residue.get(ordinal) ?? { quarantines: [], holdings: [] };
    residue.set(ordinal, slot);
    (match[3] === undefined ? slot.quarantines : slot.holdings).push(join(slotRoot, name));
  }
  return [...residue.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ordinal, { quarantines, holdings }]) => ({
      ordinal,
      slotPath: join(slotRoot, String(ordinal)),
      quarantines,
      holdings
    }));
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
 * @throws {SlotGitError} When a move-back, listing or prune git call failed.
 */
export async function recoverSlotResidueLocked(
  target: { readonly repoRoot: string; readonly slotPath: string; readonly lock: SlotRemovalLock },
  options: SlotRemovalOptions = {}
): Promise<readonly SlotResidueReport[]> {
  const { repoRoot, slotPath, lock } = target;
  const prefix = `${basename(slotPath)}.deleting-`;
  const quarantineName = new RegExp(`^${prefix.replaceAll('.', '\\.')}${UUID}$`);
  const quarantines = new Set<string>();
  for (const name of await nodeFs.readdir(dirname(slotPath)).catch((error: unknown) => {
    if (codeOf(error) === 'ENOENT') return [];
    throw error;
  })) {
    const quarantine = name.endsWith('.held') ? name.slice(0, -'.held'.length) : name;
    if (quarantineName.test(quarantine)) quarantines.add(join(dirname(slotPath), quarantine));
  }
  const reports: SlotResidueReport[] = [];
  for (const quarantine of [...quarantines].sort()) {
    lock.checkpoint();
    const holding = `${quarantine}.held`;
    let restored: { readonly changed: readonly string[]; readonly displaced: readonly string[] } | null = null;
    if (await exists(holding)) {
      let recovery: Awaited<ReturnType<typeof recoverCheckoutRemoval>>;
      try {
        recovery = await recoverCheckoutRemoval(holding);
      } catch (error) {
        reports.push({
          kind: 'recovery_failed',
          holding,
          detail: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (recovery.kind === 'finished') {
        reports.push({ kind: 'removal_finished', quarantine });
        continue;
      }
      if (recovery.kind === 'restored') restored = recovery;
    }
    if (!(await exists(quarantine))) continue;
    const clean = restored === null || (restored.changed.length === 0 && restored.displaced.length === 0);
    if (await exists(slotPath)) {
      reports.push(
        restored === null
          ? { kind: 'quarantine_stranded', quarantine, slotPath }
          : { kind: 'removal_restored', quarantine, slotPath, ...restored }
      );
      continue;
    }
    lock.checkpoint();
    await requireSlotGit(repoRoot, ['worktree', 'move', quarantine, slotPath], options);
    reports.push(
      clean || restored === null
        ? { kind: 'moved_back', quarantine, slotPath }
        : { kind: 'removal_restored', quarantine, slotPath, ...restored }
    );
  }
  lock.checkpoint();
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
  // A quarantine that vanished without a holding area leaves only git's record behind.
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

/** Default deadline of the macOS `lsof` probe. */
const OCCUPANT_PROBE_TIMEOUT_MS = 10_000;

const HOST_PROC: ProcReader = {
  readdir: (path) => nodeFs.readdir(path),
  readlink: (path) => nodeFs.readlink(path),
  readFile: (path) => nodeFs.readFile(path, 'utf8')
};

/**
 * Walks `/proc` for processes whose cwd or an open descriptor resolves inside the slot.
 * @param slot - Real path of the slot.
 * @param proc - The `/proc` reader.
 * @returns The occupants and the count of processes the kernel would not show.
 * @throws {OccupantProbeError} When `/proc` is unreadable or a read fails unexpectedly.
 */
const probeProc = async (slot: string, proc: ProcReader): Promise<SlotOccupantProbe> => {
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
  let unprobed = 0;
  const probe = async (pid: number): Promise<void> => {
    const base = `/proc/${String(pid)}`;
    try {
      let hit = inside(await proc.readlink(`${base}/cwd`));
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
      if (hit) occupants.push({ pid, command: (await proc.readFile(`${base}/comm`)).trim() });
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ESRCH') return;
      if (code === 'EACCES' || code === 'EPERM') {
        unprobed++;
        return;
      }
      throw new OccupantProbeError(`Reading ${base} failed: ${code ?? String(error)}`);
    }
  };
  for (let index = 0; index < pids.length; index += 64) await Promise.all(pids.slice(index, index + 64).map(probe));
  return { occupants: occupants.sort((left, right) => left.pid - right.pid), unprobed };
};

/**
 * Asks `lsof` for processes with the slot as cwd or with files open beneath it.
 * @param slotPath - The slot checkout.
 * @param options - Command runner, executable and deadline.
 * @returns The occupants; `lsof` reports no hidden processes.
 * @throws {OccupantProbeError} When `lsof` is missing, timed out, truncated or failed.
 */
const probeLsof = async (slotPath: string, options: OccupantProbeOptions): Promise<SlotOccupantProbe> => {
  const result = await (options.runCommand ?? runBoundedCommand)(
    options.lsof ?? 'lsof',
    ['-n', '-P', '-w', '-F', 'pc', '+D', slotPath],
    { timeoutMs: options.timeoutMs ?? OCCUPANT_PROBE_TIMEOUT_MS }
  );
  if (result.error !== undefined) throw new OccupantProbeError(`lsof could not run: ${result.error}`);
  if (result.timedOut) throw new OccupantProbeError('lsof timed out');
  if (!result.outputComplete) throw new OccupantProbeError('lsof output was truncated');
  const occupants = new Map<number, string>();
  let current: number | undefined;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) {
      current = Number(line.slice(1));
      occupants.set(current, '');
    } else if (line.startsWith('c') && current !== undefined) occupants.set(current, line.slice(1));
  }
  // lsof exits 1 both for "nothing found" and for errors, so only an empty answer means none.
  if (result.exitCode === 1 && occupants.size === 0) return { occupants: [], unprobed: 0 };
  if (result.exitCode !== 0)
    throw new OccupantProbeError(`lsof exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  return {
    occupants: [...occupants.entries()]
      .sort(([left], [right]) => left - right)
      .map(([pid, command]) => ({ pid, command })),
    unprobed: 0
  };
};

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
  const platform = options.platform ?? process.platform;
  // Windows refuses to rename or delete an open file, so removal itself reports `removal_blocked`.
  if (platform === 'win32') return { occupants: [], unprobed: 0 };
  if (platform !== 'linux') return probeLsof(slotPath, options);
  let slot: string;
  try {
    slot = await nodeFs.realpath(slotPath);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { occupants: [], unprobed: 0 };
    throw new OccupantProbeError(`Resolving ${slotPath} failed: ${codeOf(error) ?? String(error)}`);
  }
  return probeProc(slot, options.proc ?? HOST_PROC);
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

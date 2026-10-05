/**
 * Per-slot locks: exclusive creation by directory rename, dead-holder
 * detection by process identity and domain, and release behind the runtime's
 * shutdown fence.
 *
 * A lock is a sequence of generation directories `<slotRoot>/.locks/<n>/<g>/`;
 * the highest `g` is the lock's state. A generation is published whole — its
 * immutable `owner.json`, and a carried `creating.json` when the judged
 * generation had one — by renaming a private temp directory into place, and a
 * rename onto a non-empty directory fails, so exactly one acquirer creates each
 * generation. Lower generations are moved to `.gc-<uuid>` before they are
 * emptied, so a generation name never exists as an empty directory. Every
 * later write inside a generation is a temp file renamed over its target.
 *
 * A generation is free once released, or once every recorded holder — the
 * handler, its POSIX process group and its companions — is dead and no
 * unexpired handoff is pending. An unreadable or malformed file is
 * `lock_unknown`, never free.
 *
 * @summary Slot lock generations, holder judgement, companions, handoff and the shutdown-fenced release
 * @module
 */
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { BoundedGitRunner, GitChildEvent } from './bounded-git.js';
import { type ShutdownCoordinator, ShutdownError } from './config/runtime-shutdown.js';
import type { IdentityProbe, ProcessDomain, ProcessIdentityService } from './process-identity.js';

export { ShutdownError };

/** Budget for retrying transient rename errors while the destination is absent. */
export const LOCK_RENAME_BUDGET_MS = 10_000;

/** Age after which an abandoned `.tmp-*` or `.gc-*` entry is swept. */
export const LOCK_SWEEP_AGE_MS = 60 * 60 * 1_000;

/** Lifetime of a handoff offer against acquirers other than its token holder. */
export const HANDOFF_EXPIRY_MS = 5 * 60 * 1_000;

// ============================================================================
// File formats
// ============================================================================

const isoTimestamp = z.iso.datetime({ offset: true });

/** The holder's process domain as recorded in `owner.json`. */
export const slotLockDomainSchema = z.discriminatedUnion('platform', [
  z
    .object({
      platform: z.literal('linux'),
      machineId: z.string().nullable(),
      bootId: z.string().nullable(),
      pidNamespace: z.string().nullable(),
      pidNamespaceInit: z.string().nullable()
    })
    .strict(),
  z
    .object({
      platform: z.literal('darwin'),
      machineId: z.string().nullable(),
      bootSessionUuid: z.string().nullable()
    })
    .strict(),
  z
    .object({
      platform: z.literal('win32'),
      machineId: z.string().nullable(),
      bootTime: z.string().nullable()
    })
    .strict()
]);

/** Purpose a lock is held for. */
export const slotLockPurposeSchema = z.enum(['work', 'removal']);

/** A slot lock's purpose: a session's `work`, or one slot's `removal`. */
export type SlotLockPurpose = z.infer<typeof slotLockPurposeSchema>;

/**
 * `owner.json`: written once, never modified.
 *
 * `holder.startIdentity`, a deciding `domain` part and `holder.processGroupId`
 * are null when the handler could not read them; such an owner is unverified
 * and is judged by PID absence alone.
 */
export const slotLockOwnerSchema = z
  .object({
    version: z.literal(1),
    executionId: z.string().min(1),
    cardId: z.string().min(1),
    purpose: slotLockPurposeSchema,
    domain: slotLockDomainSchema,
    /** Display only; never compared. */
    hostname: z.string(),
    createdAt: isoTimestamp,
    holder: z
      .object({
        pid: z.number().int().positive(),
        startIdentity: z.string().min(1).nullable(),
        processGroupId: z.number().int().positive().nullable()
      })
      .strict()
  })
  .strict();

/** Parsed `owner.json`. */
export type SlotLockOwner = z.infer<typeof slotLockOwnerSchema>;

/** Role of a process recorded after the lock was taken. */
export const slotCompanionRoleSchema = z.enum(['agent', 'git']);

/** A companion's role. */
export type SlotCompanionRole = z.infer<typeof slotCompanionRoleSchema>;

/**
 * One companion. `startIdentity: "pending"` marks a process recorded before its
 * identity was probed; only such an entry carries `writtenAt`.
 */
export const slotCompanionSchema = z.union([
  z
    .object({
      pid: z.number().int().positive(),
      startIdentity: z.literal('pending'),
      writtenAt: isoTimestamp,
      role: slotCompanionRoleSchema
    })
    .strict(),
  z
    .object({
      pid: z.number().int().positive(),
      startIdentity: z
        .string()
        .min(1)
        .refine((value) => value !== 'pending'),
      role: slotCompanionRoleSchema
    })
    .strict()
]);

/** One recorded companion. */
export type SlotCompanion = z.infer<typeof slotCompanionSchema>;

/** `companions.json`. */
export const slotCompanionsSchema = z
  .object({ version: z.literal(1), companions: z.array(slotCompanionSchema) })
  .strict();

/** Parsed `companions.json`. */
export type SlotCompanions = z.infer<typeof slotCompanionsSchema>;

/** `handoff.json`: the switch callback's offer to its successor. */
export const slotHandoffSchema = z.object({ token: z.string().min(1), expiresAt: isoTimestamp }).strict();

/** Parsed `handoff.json`. */
export type SlotHandoff = z.infer<typeof slotHandoffSchema>;

/** `creating.json`: an incomplete create, recreate or reattach. */
export const slotCreationIntentSchema = z
  .object({
    version: z.literal(1),
    op: z.enum(['create', 'recreate', 'reattach']),
    branch: z.string().min(1),
    path: z.string().min(1),
    /** Parent oid the ref is created at; null for `reattach`. */
    createdOid: z.string().min(1).nullable(),
    registeredBefore: z.boolean()
  })
  .strict();

/** Parsed `creating.json`. */
export type SlotCreationIntent = z.infer<typeof slotCreationIntentSchema>;

/** `released.json`: a clean release. */
export const slotReleasedSchema = z.object({ releasedAt: isoTimestamp }).strict();

/** Parsed `released.json`. */
export type SlotReleased = z.infer<typeof slotReleasedSchema>;

// ============================================================================
// Reading and judging
// ============================================================================

/** Every file of one generation, read without a lock. */
export interface SlotGenerationSnapshot {
  readonly generation: number;
  readonly owner: SlotLockOwner;
  readonly companions: readonly SlotCompanion[];
  readonly handoff: SlotHandoff | null;
  readonly creating: SlotCreationIntent | null;
  readonly released: SlotReleased | null;
}

/** The judged generation, captured before GC can collect it. */
export interface SlotLockPrevious {
  /** 0 when the ordinal had no generation. */
  readonly generation: number;
  readonly owner: SlotLockOwner | null;
  readonly companions: readonly SlotCompanion[];
  readonly creating: SlotCreationIntent | null;
}

/** Why a generation could not be judged. */
export interface SlotLockUnknownDetail {
  /** Human-readable reason, printed in the launch output and reports. */
  readonly reason: string;
  /** Whether the recorded owner is unverified. */
  readonly unverifiedOwner: boolean;
}

/** Recorded processes still alive behind a held or unknown generation. */
export interface SlotLockSurvivors {
  readonly holderAlive: boolean;
  readonly groupAlive: boolean | null;
  readonly companions: readonly number[];
}

/** One ordinal's lock state as judged by this process. */
export type SlotLockState =
  | { readonly state: 'free'; readonly ordinal: number; readonly snapshot: SlotGenerationSnapshot | null }
  | {
      readonly state: 'held';
      readonly ordinal: number;
      readonly snapshot: SlotGenerationSnapshot;
      /** Whether an unexpired handoff keeps the generation held. */
      readonly handoffPending: boolean;
      readonly survivors: SlotLockSurvivors;
    }
  | {
      readonly state: 'unknown';
      readonly ordinal: number;
      /** Null when a file could not be read or parsed. */
      readonly snapshot: SlotGenerationSnapshot | null;
      readonly detail: SlotLockUnknownDetail;
    };

/**
 * This process's identity and domain, and the probed identities of candidate
 * holders, gathered once per acquire or cleanup pass.
 */
export interface SlotJudgeContext {
  /** This process's identity; null when unreadable. */
  readonly self: {
    readonly pid: number;
    readonly startIdentity: string | null;
    readonly processGroupId: number | null;
  };
  readonly domain: ProcessDomain;
  /** Whether this process's start identity and every deciding domain part were read. */
  readonly verified: boolean;
  /** Prefetched identities by PID; a PID missing here is probed on demand. */
  readonly identities: ReadonlyMap<number, IdentityProbe>;
  /** Reason this process's own identity was unreadable, for the launch report. */
  readonly unverifiedReason: string | null;
}

/** Options of {@link createSlotJudgeContext}. */
export interface SlotJudgeContextOptions {
  /** Budget of the first batched identity read. */
  readonly timeoutMs: number;
  /** Budget of the single retry after a timed-out first read. */
  readonly retryTimeoutMs: number;
  /** Identity service; defaults to the host's. */
  readonly identity?: ProcessIdentityService;
}

/**
 * Reads this process's identity and domain and probes the candidate PIDs, in
 * one CIM call on Windows after a `kill(pid, 0)` filter.
 * @param pids - Recorded PIDs of the candidates that will be judged.
 * @param options - Budgets and the identity service.
 * @returns The context every judgement of this pass shares.
 */
export async function createSlotJudgeContext(
  pids: readonly number[],
  options: SlotJudgeContextOptions
): Promise<SlotJudgeContext> {
  void pids;
  void options;
  throw new Error('Not Implemented');
}

/** File operations the lock uses; injectable to reproduce scanner errors. */
export interface SlotLockFileSystem {
  readonly readFile: (path: string) => Promise<string>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

/** Everything a lock depends on outside its directory; each part is injectable for tests. */
export interface SlotLockEnvironment {
  /** Identity service; defaults to the host's. */
  readonly identity: ProcessIdentityService;
  /** Shutdown fence and hook registry; defaults to the runtime's. */
  readonly shutdown: Pick<ShutdownCoordinator, 'signal' | 'register'>;
  /** Slot git runner whose in-flight calls the hook aborts; defaults to the host's. */
  readonly git: Pick<BoundedGitRunner, 'abortAll'>;
  /** File operations; default to `node:fs/promises`. */
  readonly fs: SlotLockFileSystem;
  /** Budget for transient rename errors; defaults to {@link LOCK_RENAME_BUDGET_MS}. */
  readonly renameBudgetMs: number;
  /** Budget of one on-demand identity probe. */
  readonly probeTimeoutMs: number;
}

/** Options of a read or acquire. */
export interface SlotLockReadOptions {
  /** Shared judgement context; created for this call when absent. */
  readonly context?: SlotJudgeContext;
  /** Overrides for the lock's environment. */
  readonly environment?: Partial<SlotLockEnvironment>;
}

/**
 * Lists the ordinals that have a lock directory.
 * @param slotRoot - The card's slot root.
 * @returns Ordinals in ascending order; an ordinal reservation is not a discovered slot.
 */
export async function listSlotLockOrdinals(slotRoot: string): Promise<readonly number[]> {
  void slotRoot;
  throw new Error('Not Implemented');
}

/**
 * Reads the maximum generation's files without judging them.
 * @param slotRoot - The card's slot root.
 * @param ordinal - Number of the slot whose `.locks/<n>/` directory is read.
 * @returns The snapshot, null when the ordinal has no generation, or the reason it could not be read.
 */
export async function readSlotLockSnapshot(
  slotRoot: string,
  ordinal: number
): Promise<SlotGenerationSnapshot | null | { readonly unreadable: string }> {
  void slotRoot;
  void ordinal;
  throw new Error('Not Implemented');
}

/**
 * The PIDs a snapshot records: holder and companions.
 * @param snapshot - Generation to read.
 * @returns Every recorded PID once.
 * @throws {Error} Always: not implemented yet.
 */
export function slotLockPids(snapshot: SlotGenerationSnapshot): readonly number[] {
  void snapshot;
  throw new Error('Not Implemented');
}

/**
 * Reads and judges one ordinal's lock without taking it, for preview and the
 * cleanup pre-check.
 * @param slotRoot - The card's slot root.
 * @param ordinal - Number of the slot whose `.locks/<n>/` directory is read.
 * @param options - Judgement context and identity service.
 * @returns The judged state.
 */
export async function readSlotLock(
  slotRoot: string,
  ordinal: number,
  options: SlotLockReadOptions = {}
): Promise<SlotLockState> {
  void slotRoot;
  void ordinal;
  void options;
  throw new Error('Not Implemented');
}

// ============================================================================
// Holding
// ============================================================================

/** What the switch callback returns, and the successor presents. */
export interface SlotHandoffToken {
  readonly generation: number;
  readonly token: string;
}

/** Outcome of recording the agent as a companion. */
export type CompanionRecording =
  /** Recorded with its probed identity, or `pending` when the probe timed out. */
  | { readonly status: 'recorded'; readonly companion: SlotCompanion }
  /** The `ChildProcess` had already emitted `exit` or `error`. */
  | { readonly status: 'exited' }
  /** The probed parent is not this process. */
  | { readonly status: 'not_child'; readonly parentPid: number };

/** A held slot lock. */
export interface SlotLock {
  readonly slotRoot: string;
  readonly ordinal: number;
  readonly generation: number;
  readonly purpose: SlotLockPurpose;
  readonly owner: SlotLockOwner;
  /**
   * Runs one slot operation, counted as in flight for the shutdown hook.
   * @param name - Operation name for logs.
   * @param fn - The operation.
   * @returns What `fn` returned.
   * @throws {ShutdownError} When the fence has closed, before `fn` starts.
   */
  operation<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Stops an operation between steps once the fence has closed.
   * @throws {ShutdownError} When the fence has closed.
   */
  checkpoint(): void;
  /**
   * Records the agent while it is this process's live child.
   * @param child - The spawned agent.
   * @param role - Companion role.
   * @returns Whether it was recorded.
   */
  addCompanion(child: ChildProcess, role: 'agent'): Promise<CompanionRecording>;
  /**
   * The `record` callback for a mutating slot git call: records git as a
   * `pending` companion on Windows, replaces it with its identity, and removes
   * it on exit. Does nothing on POSIX, where git is in the recorded group.
   * @param event - The git child's lifecycle event.
   */
  recordGit(event: GitChildEvent): void;
  /**
   * Removes a companion.
   * @param pid - Companion to remove.
   */
  removeCompanion(pid: number): Promise<void>;
  /**
   * Writes `handoff.json` and sets the switch latch, so no release follows.
   * @returns The token the successor presents.
   */
  offerHandoff(): Promise<SlotHandoffToken>;
  /**
   * Writes `creating.json`.
   * @param intent - The creation in progress.
   */
  writeIntent(intent: SlotCreationIntent): Promise<void>;
  /** Unlinks `creating.json`. */
  clearIntent(): Promise<void>;
  /**
   * Writes `released.json`. Does nothing once the fence has closed or the
   * switch latch is set, except from the lock's own shutdown hook.
   * @returns Whether `released.json` was written.
   */
  release(): Promise<boolean>;
}

/** Options of {@link acquireSlotLock}. */
export interface AcquireSlotLockOptions extends SlotLockReadOptions {
  readonly executionId: string;
  readonly cardId: string;
  readonly purpose: SlotLockPurpose;
  /** The successor's claim on its source's generation. */
  readonly handoff?: SlotHandoffToken;
}

/** Outcome of one acquire. */
export type AcquireSlotLockResult =
  | {
      readonly status: 'acquired';
      readonly lock: SlotLock;
      /** The judged generation, captured before GC. */
      readonly previous: SlotLockPrevious;
      /** Whether this owner recorded its full identity and domain. */
      readonly verified: boolean;
    }
  | {
      readonly status: 'held';
      readonly holder: SlotLockOwner;
      readonly handoffPending: boolean;
      readonly survivors: SlotLockSurvivors;
    }
  /** Another acquirer created the next generation, or a handoff no longer matches. */
  | { readonly status: 'taken'; readonly detail: string }
  | { readonly status: 'unknown'; readonly detail: SlotLockUnknownDetail }
  /** The rename budget ran out on transient errors. */
  | { readonly status: 'unavailable'; readonly detail: string };

/**
 * Acquires one ordinal's lock for this process.
 *
 * A `work` lock registers a shutdown hook that aborts in-flight slot git,
 * keeps the lock on `switch` or while an operation was in flight, waits for
 * companions, and then releases.
 * @param slotRoot - The card's slot root.
 * @param ordinal - Number of the slot whose `.locks/<n>/` directory is read.
 * @param options - Owner fields, purpose, handoff claim and judgement context.
 * @returns The acquired lock, or why it was not acquired.
 */
export async function acquireSlotLock(
  slotRoot: string,
  ordinal: number,
  options: AcquireSlotLockOptions
): Promise<AcquireSlotLockResult> {
  void slotRoot;
  void ordinal;
  void options;
  throw new Error('Not Implemented');
}

/** Outcome of publishing one generation (acquire steps 4 and 5). */
export type PublishGenerationResult =
  | { readonly status: 'published'; readonly generation: number }
  /** The destination existed: another acquirer created it. */
  | { readonly status: 'taken'; readonly generation: number }
  /** A higher generation appeared; ours was released at once. */
  | { readonly status: 'backed_off'; readonly generation: number; readonly higher: number }
  | { readonly status: 'unavailable'; readonly generation: number; readonly detail: string };

/**
 * Publishes generation `judged + 1` whole by renaming a private temp directory
 * holding its files, then verifies no higher generation exists. The building
 * block of {@link acquireSlotLock}, exported for crash-point and stress tests.
 * @param lockDir - The ordinal's `.locks/<n>` directory.
 * @param judged - The generation the caller judged free.
 * @param files - Contents of the new generation.
 * @param files.owner - Its `owner.json`.
 * @param files.creating - The creation intent carried from the judged generation, or null.
 * @param environment - File operations and rename budget.
 * @returns Whether this caller now holds the new maximum.
 */
export async function publishGeneration(
  lockDir: string,
  judged: number,
  files: { readonly owner: SlotLockOwner; readonly creating: SlotCreationIntent | null },
  environment: Partial<Pick<SlotLockEnvironment, 'fs' | 'renameBudgetMs'>> = {}
): Promise<PublishGenerationResult> {
  void lockDir;
  void judged;
  void files;
  void environment;
  throw new Error('Not Implemented');
}

/**
 * Runs `fn` under one ordinal's lock as a single operation, releasing a
 * `removal` lock when `fn` returns with the fence open.
 * @param slotRoot - The card's slot root.
 * @param ordinal - Number of the slot whose `.locks/<n>/` directory is read.
 * @param purpose - `work` for a session, `removal` for one cleanup slot.
 * @param options - Owner fields and judgement context.
 * @param fn - Work done under the lock.
 * @returns What `fn` returned, or the reason the lock was not acquired.
 */
export async function withSlotLock<T>(
  slotRoot: string,
  ordinal: number,
  purpose: SlotLockPurpose,
  options: Omit<AcquireSlotLockOptions, 'purpose' | 'handoff'>,
  fn: (lock: SlotLock, previous: SlotLockPrevious) => Promise<T>
): Promise<
  { readonly status: 'done'; readonly value: T } | Exclude<AcquireSlotLockResult, { readonly status: 'acquired' }>
> {
  void slotRoot;
  void ordinal;
  void purpose;
  void options;
  void fn;
  throw new Error('Not Implemented');
}

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
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { abortAll as abortSlotGit, type BoundedGitRunner, type GitChildEvent } from './bounded-git.js';
import {
  processShutdownCoordinator,
  SHUTDOWN_BUDGET_MS,
  type ShutdownCoordinator,
  ShutdownError,
  type ShutdownReason
} from './config/runtime-shutdown.js';
import {
  compareDomains,
  type IdentityProbe,
  type ProcessDomain,
  type ProcessIdentity,
  type ProcessIdentityService,
  processIdentity
} from './process-identity.js';

export { ShutdownError };

/** Budget for retrying transient rename errors while the destination is absent. */
export const LOCK_RENAME_BUDGET_MS = 10_000;

/** Age after which an abandoned `.tmp-*` or `.gc-*` entry is swept. */
export const LOCK_SWEEP_AGE_MS = 60 * 60 * 1_000;

/** Lifetime of a handoff offer against acquirers other than its token holder. */
export const HANDOFF_EXPIRY_MS = 5 * 60 * 1_000;

/** Grace the shutdown hook gives in-flight slot git before SIGKILL. */
const HOOK_GIT_GRACE_MS = 1_500;

/** Headroom the hook leaves before the shutdown budget ends, so it never writes after exit. */
const HOOK_RELEASE_MARGIN_MS = 200;

/** Budget of one on-demand identity probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Budgets of the batched identity read on the launch path. */
const DEFAULT_CONTEXT_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_RETRY_TIMEOUT_MS = 10_000;

/** Errnos a Windows scanner or indexer causes while it holds a path open. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

const GENERATION_NAME = /^[1-9]\d*$/;

/** Milliseconds between 0001-01-01 and the Unix epoch, for Windows `CreationDate` ticks. */
const TICKS_EPOCH_OFFSET_MS = 62_135_596_800_000n;

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
  const identity = options.identity ?? processIdentity();
  const identities = new Map<number, IdentityProbe>();
  const reasons: string[] = [];
  let self: ProcessIdentity | 'unknown';
  let domain: ProcessDomain;
  if (identity.platform === 'win32') {
    // `kill(pid, 0)` settles every ESRCH PID before the one CIM call.
    const alive: number[] = [];
    for (const pid of new Set(pids)) {
      if (identity.isProcessAbsent(pid)) identities.set(pid, null);
      else alive.push(pid);
    }
    let batch = await identity.identifyMany(alive, { timeoutMs: options.timeoutMs, includeSelf: true });
    if (batch.self === undefined || batch.self === 'unknown') {
      batch = await identity.identifyMany(alive, { timeoutMs: options.retryTimeoutMs, includeSelf: true });
    }
    self = batch.self ?? 'unknown';
    if (self === 'unknown') {
      // No slot is judged from a partial answer: only PID absence decides now.
      reasons.push('own identity batch failed on its retry');
      for (const pid of alive) identities.set(pid, 'unknown');
      domain = { platform: 'win32', machineId: null, bootTime: null };
    } else {
      for (const pid of alive) identities.set(pid, batch.identities.get(pid) ?? 'unknown');
      domain = batch.domain ?? (await identity.currentProcessDomain());
    }
  } else {
    self = await identity.currentProcessIdentity();
    domain = await identity.currentProcessDomain();
    if (self === 'unknown') reasons.push('own start identity unreadable');
  }
  const missing = unreadDecidingParts(domain);
  if (missing.length > 0) reasons.push(`own domain part unreadable: ${missing.join(', ')}`);
  return {
    self: {
      pid: identity.pid,
      startIdentity: self === 'unknown' ? null : self.startIdentity,
      processGroupId: identity.platform === 'win32' ? null : await identity.currentProcessGroupId()
    },
    domain,
    verified: reasons.length === 0,
    identities,
    unverifiedReason: reasons.length === 0 ? null : reasons.join('; ')
  };
}

/**
 * Names the deciding parts of a domain that are null.
 * @param domain - Domain to inspect.
 * @returns The unread boot and namespace parts; Windows has none.
 */
function unreadDecidingParts(domain: ProcessDomain): string[] {
  const parts: Record<string, string | null> =
    domain.platform === 'linux'
      ? { bootId: domain.bootId, pidNamespace: domain.pidNamespace, pidNamespaceInit: domain.pidNamespaceInit }
      : domain.platform === 'darwin'
        ? { bootSessionUuid: domain.bootSessionUuid }
        : {};
  return Object.entries(parts)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
}

/**
 * The boot part of a Linux or macOS domain.
 * @param domain - Domain to read.
 * @returns `bootId` or `bootSessionUuid`; null when unread or on Windows.
 */
function bootPart(domain: ProcessDomain): string | null {
  if (domain.platform === 'linux') return domain.bootId;
  if (domain.platform === 'darwin') return domain.bootSessionUuid;
  return null;
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

const hostFileSystem: SlotLockFileSystem = {
  readFile: (path) => readFile(path, 'utf8'),
  rename
};

/**
 * Fills a lock environment's unset parts with the host's.
 * @param overrides - Parts a caller or test injects.
 * @returns The complete environment.
 */
function resolveEnvironment(overrides: Partial<SlotLockEnvironment> = {}): SlotLockEnvironment {
  return {
    identity: overrides.identity ?? processIdentity(),
    shutdown: overrides.shutdown ?? processShutdownCoordinator(),
    git: overrides.git ?? { abortAll: abortSlotGit },
    fs: overrides.fs ?? hostFileSystem,
    renameBudgetMs: overrides.renameBudgetMs ?? LOCK_RENAME_BUDGET_MS,
    probeTimeoutMs: overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  };
}

/**
 * Builds a judgement context with the launch-path budgets.
 * @param pids - Recorded PIDs to prefetch.
 * @param environment - Supplies the identity service.
 * @returns This process's identity and domain, shared by every judgement of the call.
 */
function defaultContext(pids: readonly number[], environment: SlotLockEnvironment): Promise<SlotJudgeContext> {
  return createSlotJudgeContext(pids, {
    timeoutMs: DEFAULT_CONTEXT_TIMEOUT_MS,
    retryTimeoutMs: DEFAULT_CONTEXT_RETRY_TIMEOUT_MS,
    identity: environment.identity
  });
}

/**
 * Reads an error's errno code.
 * @param error - Anything thrown.
 * @returns Its `code`, when it has a string one.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Describes a thrown value for a report.
 * @param error - Anything thrown.
 * @returns Its errno code, else its message.
 */
function describeError(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Waits without blocking the event loop.
 * @param ms - Delay.
 * @returns After the delay.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

/**
 * Whether a path exists, by `lstat`, so a scanner holding it open cannot hide it.
 * @param path - Path to test.
 * @returns False only on `ENOENT`.
 * @throws On any other `lstat` error.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Creates a file exclusively, writes it and flushes it to disk.
 * @param path - New file.
 * @param content - UTF-8 text.
 */
async function writeFileDurably(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a directory's entries on POSIX. Windows is skipped: a directory
 * fsync needs write access there and fails with `EPERM`, and NTFS journals
 * metadata anyway.
 * @param path - Directory to flush.
 */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replaces `dir/name` atomically: a durable temp file in the same directory,
 * renamed over the target with scanner retries, so the target is never seen
 * half-written.
 * @param dir - Generation directory.
 * @param name - Target file name.
 * @param content - UTF-8 text.
 * @param environment - Rename operation and budget.
 * @param environment.fs - Supplies the rename.
 * @param environment.renameBudgetMs - Budget for transient rename errors.
 * @throws The last rename error once it is not transient or the budget ran out.
 */
async function writeAtomic(
  dir: string,
  name: string,
  content: string,
  environment: Pick<SlotLockEnvironment, 'fs' | 'renameBudgetMs'>
): Promise<void> {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  await writeFileDurably(temp, content);
  try {
    const deadline = Date.now() + environment.renameBudgetMs;
    for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
      try {
        await environment.fs.rename(temp, join(dir, name));
        return;
      } catch (error) {
        if (!TRANSIENT_RENAME_CODES.has(errorCode(error) ?? '') || Date.now() + delay > deadline) throw error;
      }
      await pause(delay);
    }
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Lists a lock directory's generations.
 * @param lockDir - The ordinal's `.locks/<n>` directory.
 * @returns Generation numbers in ascending order; empty when the directory is absent.
 * @throws On any listing error other than `ENOENT`.
 */
async function listGenerations(lockDir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => GENERATION_NAME.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

/** One optional file: its parsed value, null when absent, or why it is unreadable. */
type FileRead<T> = { readonly value: T | null } | { readonly unreadable: string };

/**
 * Reads and validates one lock file; only `ENOENT` means absent.
 * @param fs - Reads the file, injectable to reproduce scanner errors.
 * @param dir - Generation directory.
 * @param name - Lock file to read, such as `owner.json`.
 * @param schema - Schema the parsed JSON must satisfy.
 * @returns The value, null when absent, or the reason it cannot be trusted.
 */
async function readLockFile<S extends z.ZodType>(
  fs: SlotLockFileSystem,
  dir: string,
  name: string,
  schema: S
): Promise<FileRead<z.infer<S>>> {
  let text: string;
  try {
    text = await fs.readFile(join(dir, name));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { value: null };
    return { unreadable: `${name} unreadable (${describeError(error)})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { unreadable: `${name} is not JSON` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { value: parsed.data } : { unreadable: `${name} fails its schema` };
}

/** The maximum generation as read, before any judgement. */
type MaximumRead =
  | { readonly kind: 'none' }
  /** The maximum exists but holds no `owner.json`: free per acquire step 2. */
  | { readonly kind: 'vacant'; readonly generation: number }
  | { readonly kind: 'snapshot'; readonly snapshot: SlotGenerationSnapshot }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Listings to retry when GC moves the listed maximum away under a reader. */
const MAXIMUM_READ_ATTEMPTS = 5;

/**
 * Reads every file of the maximum generation.
 * @param lockDir - The ordinal's `.locks/<n>` directory.
 * @param fs - File operations.
 * @returns What the maximum holds.
 */
async function readMaximum(lockDir: string, fs: SlotLockFileSystem): Promise<MaximumRead> {
  let vanished: number | undefined;
  for (let attempt = 0; attempt < MAXIMUM_READ_ATTEMPTS; attempt++) {
    let generations: number[];
    try {
      generations = await listGenerations(lockDir);
    } catch (error) {
      return { kind: 'unreadable', reason: `lock directory unreadable (${describeError(error)})` };
    }
    const generation = generations.at(-1);
    if (generation === undefined) return { kind: 'none' };
    const dir = join(lockDir, String(generation));
    const [owner, companions, handoff, creating, released] = await Promise.all([
      readLockFile(fs, dir, 'owner.json', slotLockOwnerSchema),
      readLockFile(fs, dir, 'companions.json', slotCompanionsSchema),
      readLockFile(fs, dir, 'handoff.json', slotHandoffSchema),
      readLockFile(fs, dir, 'creating.json', slotCreationIntentSchema),
      readLockFile(fs, dir, 'released.json', slotReleasedSchema)
    ]);
    for (const file of [owner, companions, handoff, creating, released]) {
      if ('unreadable' in file) return { kind: 'unreadable', reason: file.unreadable };
    }
    if (!('value' in owner) || owner.value === null) {
      // Collected by GC after the listing; a maximum that stays ownerless is vacant.
      if (vanished === generation) return { kind: 'vacant', generation };
      vanished = generation;
      continue;
    }
    return {
      kind: 'snapshot',
      snapshot: {
        generation,
        owner: owner.value,
        companions: 'value' in companions ? (companions.value?.companions ?? []) : [],
        handoff: 'value' in handoff ? handoff.value : null,
        creating: 'value' in creating ? creating.value : null,
        released: 'value' in released ? released.value : null
      }
    };
  }
  return { kind: 'unreadable', reason: 'the maximum generation kept moving while it was read' };
}

/**
 * Lists the ordinals that have a lock directory.
 * @param slotRoot - The card's slot root.
 * @returns Ordinals in ascending order; an ordinal reservation is not a discovered slot.
 */
export async function listSlotLockOrdinals(slotRoot: string): Promise<readonly number[]> {
  return listGenerations(join(slotRoot, '.locks'));
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
  const read = await readMaximum(lockDirectory(slotRoot, ordinal), hostFileSystem);
  if (read.kind === 'snapshot') return read.snapshot;
  if (read.kind === 'unreadable') return { unreadable: read.reason };
  return null;
}

/**
 * The PIDs a snapshot records: holder and companions.
 * @param snapshot - Generation to read.
 * @returns Every recorded PID once.
 */
export function slotLockPids(snapshot: SlotGenerationSnapshot): readonly number[] {
  return [...new Set([snapshot.owner.holder.pid, ...snapshot.companions.map((companion) => companion.pid)])];
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
  const environment = resolveEnvironment(options.environment);
  const read = await readMaximum(lockDirectory(slotRoot, ordinal), environment.fs);
  if (read.kind === 'unreadable') {
    return { state: 'unknown', ordinal, snapshot: null, detail: { reason: read.reason, unverifiedOwner: false } };
  }
  if (read.kind !== 'snapshot') return { state: 'free', ordinal, snapshot: null };
  const { snapshot } = read;
  if (snapshot.released !== null) return { state: 'free', ordinal, snapshot };
  const context = options.context ?? (await defaultContext(slotLockPids(snapshot), environment));
  const judgement = await judgeSnapshot(snapshot, context, environment);
  return { ...judgement, ordinal, snapshot };
}

/**
 * The ordinal's lock directory.
 * @param slotRoot - The card's slot root.
 * @param ordinal - Slot ordinal.
 * @returns `<slotRoot>/.locks/<ordinal>`.
 */
function lockDirectory(slotRoot: string, ordinal: number): string {
  return join(slotRoot, '.locks', String(ordinal));
}

/** A generation's judgement, without the ordinal and snapshot it was read from. */
type Judgement =
  | { readonly state: 'free' }
  | { readonly state: 'held'; readonly handoffPending: boolean; readonly survivors: SlotLockSurvivors }
  | { readonly state: 'unknown'; readonly detail: SlotLockUnknownDetail };

/** Whether a generation's recorded processes have all ended. */
type HolderJudgement =
  | { readonly kind: 'dead'; readonly survivors: SlotLockSurvivors }
  | { readonly kind: 'alive'; readonly survivors: SlotLockSurvivors }
  | { readonly kind: 'unknown'; readonly detail: SlotLockUnknownDetail };

/**
 * Judges an unreleased generation: free once every recorded holder is dead and
 * no unexpired handoff is pending, `unknown` when liveness cannot be decided.
 * @param snapshot - The generation's files.
 * @param context - This pass's identities and domain.
 * @param environment - Identity service and probe budget.
 * @returns The judgement.
 */
async function judgeSnapshot(
  snapshot: SlotGenerationSnapshot,
  context: SlotJudgeContext,
  environment: SlotLockEnvironment
): Promise<Judgement> {
  if (snapshot.released !== null) return { state: 'free' };
  const handoffPending = snapshot.handoff !== null && Date.parse(snapshot.handoff.expiresAt) > Date.now();
  let holders: HolderJudgement;
  try {
    holders = await judgeHolders(snapshot, context, environment);
  } catch (error) {
    // A liveness probe that cannot answer is never evidence of death.
    holders = {
      kind: 'unknown',
      detail: {
        reason: `liveness probe failed (${describeError(error)})`,
        unverifiedOwner: isUnverifiedOwner(snapshot.owner)
      }
    };
  }
  if (holders.kind === 'unknown') return { state: 'unknown', detail: holders.detail };
  if (holders.kind === 'dead' && !handoffPending) return { state: 'free' };
  return { state: 'held', handoffPending, survivors: holders.survivors };
}

/**
 * Whether an owner could not record its full identity, domain or POSIX group.
 * @param owner - Recorded owner.
 * @returns True when a reader may judge it only by PID absence.
 */
function isUnverifiedOwner(owner: SlotLockOwner): boolean {
  return (
    owner.holder.startIdentity === null ||
    (owner.domain.platform !== 'win32' && owner.holder.processGroupId === null) ||
    unreadDecidingParts(owner.domain).length > 0
  );
}

/**
 * Decides whether every recorded process of a generation has ended.
 * @param snapshot - The generation's files.
 * @param context - This pass's identities and domain.
 * @param environment - Identity service and probe budget.
 * @returns Dead, alive with its survivors, or unknown with the reason.
 */
async function judgeHolders(
  snapshot: SlotGenerationSnapshot,
  context: SlotJudgeContext,
  environment: SlotLockEnvironment
): Promise<HolderJudgement> {
  const { owner } = snapshot;
  const pgid = owner.holder.processGroupId;
  const dead: HolderJudgement = {
    kind: 'dead',
    survivors: { holderAlive: false, groupAlive: pgid === null ? null : false, companions: [] }
  };
  const ownerUnverified = isUnverifiedOwner(owner);
  const comparison = compareDomains(owner.domain, context.domain);
  if (ownerUnverified || !context.verified || comparison === 'unverified') {
    // Only a provably different boot is decisive without identities [N3].
    const ownBoot = bootPart(context.domain);
    const heldBoot = bootPart(owner.domain);
    if (owner.domain.platform !== context.domain.platform) return dead;
    if (ownBoot !== null && heldBoot !== null && ownBoot !== heldBoot) return dead;
    return judgeByAbsence(snapshot, context, environment.identity, ownerUnverified);
  }
  // A holder recorded in another domain cannot still run: no PID check [K].
  if (comparison === 'other') return dead;
  return judgeByPidRules(snapshot, context, environment);
}

/**
 * The unverified rule: dead only when the holder, every companion and the
 * POSIX group answer `ESRCH`.
 * @param snapshot - The generation's files.
 * @param context - Says why this reader is unverified.
 * @param identity - Liveness probes.
 * @param ownerUnverified - Whether the owner itself is unverified.
 * @returns Dead, or unknown naming what is still alive.
 */
function judgeByAbsence(
  snapshot: SlotGenerationSnapshot,
  context: SlotJudgeContext,
  identity: ProcessIdentityService,
  ownerUnverified: boolean
): HolderJudgement {
  const { holder } = snapshot.owner;
  const holderAlive = !identity.isProcessAbsent(holder.pid);
  const companions = snapshot.companions.filter((companion) => !identity.isProcessAbsent(companion.pid));
  const groupAlive = holder.processGroupId === null ? null : identity.isProcessGroupAlive(holder.processGroupId);
  const survivors = { holderAlive, groupAlive, companions: companions.map((companion) => companion.pid) };
  if (!holderAlive && companions.length === 0 && groupAlive !== true) return { kind: 'dead', survivors };
  const alive = [
    ...(holderAlive ? [`PID ${holder.pid}`] : []),
    ...companions.map((companion) => `companion ${companion.pid}`),
    ...(groupAlive === true ? [`group ${holder.processGroupId}`] : [])
  ].join(', ');
  const why = ownerUnverified ? 'unverified owner' : `unverified reader (${context.unverifiedReason ?? 'domain'})`;
  return { kind: 'unknown', detail: { reason: `${why}, ${alive} alive`, unverifiedOwner: ownerUnverified } };
}

/** One recorded process's state under the PID rules. */
type ProcessState = 'dead' | 'alive' | 'unknown';

/**
 * The PID rules for a holder in this domain: `ESRCH` is dead, a different
 * start identity is a reused PID, and a probe that cannot answer is unknown.
 * @param snapshot - The generation's files.
 * @param context - Prefetched identities.
 * @param environment - Identity service and probe budget.
 * @returns Dead, alive with its survivors, or unknown.
 */
async function judgeByPidRules(
  snapshot: SlotGenerationSnapshot,
  context: SlotJudgeContext,
  environment: SlotLockEnvironment
): Promise<HolderJudgement> {
  const { identity } = environment;
  const { holder } = snapshot.owner;
  const probe = async (pid: number): Promise<IdentityProbe | 'absent'> => {
    if (identity.isProcessAbsent(pid)) return 'absent';
    if (context.identities.has(pid)) return context.identities.get(pid) ?? 'unknown';
    return identity.identify(pid, environment.probeTimeoutMs);
  };
  const stateOf = async (pid: number, matches: (live: ProcessIdentity) => boolean): Promise<ProcessState> => {
    const live = await probe(pid);
    if (live === 'absent' || live === null) return 'dead';
    if (live === 'unknown') return 'unknown';
    return matches(live) ? 'alive' : 'dead';
  };
  const holderState = await stateOf(holder.pid, (live) => live.startIdentity === holder.startIdentity);
  const companionStates = await Promise.all(
    snapshot.companions.map(async (companion) => ({
      pid: companion.pid,
      state: await stateOf(companion.pid, (live) =>
        'writtenAt' in companion
          ? !pendingWasReused(live, companion.writtenAt, holder.pid)
          : live.startIdentity === companion.startIdentity
      )
    }))
  );
  const groupAlive = holder.processGroupId === null ? null : identity.isProcessGroupAlive(holder.processGroupId);
  const survivors = {
    holderAlive: holderState === 'alive',
    groupAlive,
    companions: companionStates.filter((entry) => entry.state === 'alive').map((entry) => entry.pid)
  };
  if (survivors.holderAlive || survivors.companions.length > 0 || groupAlive === true) {
    return { kind: 'alive', survivors };
  }
  const unknown = [
    ...(holderState === 'unknown' ? [holder.pid] : []),
    ...companionStates.filter((entry) => entry.state === 'unknown').map((entry) => entry.pid)
  ];
  if (unknown.length > 0) {
    return {
      kind: 'unknown',
      detail: { reason: `identity probe of PID ${unknown.join(', ')} answered unknown`, unverifiedOwner: false }
    };
  }
  return { kind: 'dead', survivors };
}

/**
 * Parses a Windows `CreationDate` tick count.
 * @param value - A start identity.
 * @returns Its ticks, or null when it is not a tick count.
 */
function windowsTicks(value: string | null): bigint | null {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * Whether a live PID behind a `pending` companion is a different process [H3]:
 * it was created after the entry was written, or its parent is not the
 * handler that spawned the companion. Windows never reparents, so the
 * companion keeps naming the handler as its parent after the handler exits.
 * The handler's own start time is no bound: a backward clock step between the
 * handler's start and the spawn dates the companion before the handler.
 * @param live - The live process behind the companion's PID.
 * @param writtenAt - When the entry was written.
 * @param holderPid - The handler that spawned the companion.
 * @returns True only when the process provably is not the companion.
 */
function pendingWasReused(live: ProcessIdentity, writtenAt: string, holderPid: number): boolean {
  if (live.parentPid !== holderPid) return true;
  const created = windowsTicks(live.startIdentity);
  if (created === null) return false;
  const written = (BigInt(Date.parse(writtenAt)) + TICKS_EPOCH_OFFSET_MS) * 10_000n;
  return created > written;
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
   * switch latch is set, except from the lock's own shutdown hook, and keeps
   * the lock while any process the handler started is still alive, recording
   * each as a companion so a later judge keeps it too.
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
  const environment = resolveEnvironment(options.environment);
  const lockDir = lockDirectory(slotRoot, ordinal);
  const read = await readMaximum(lockDir, environment.fs);
  if (read.kind === 'unreadable') return { status: 'unknown', detail: { reason: read.reason, unverifiedOwner: false } };
  const snapshot = read.kind === 'snapshot' ? read.snapshot : null;
  const context =
    options.context ?? (await defaultContext(snapshot === null ? [] : slotLockPids(snapshot), environment));

  if (options.handoff !== undefined) {
    // A matching token claims a live holder's generation, whatever its expiry [R1].
    const { generation, token } = options.handoff;
    if (
      snapshot === null ||
      snapshot.generation !== generation ||
      snapshot.released !== null ||
      snapshot.handoff?.token !== token
    ) {
      return {
        status: 'taken',
        detail: `handoff_lost: generation ${generation} is no longer the unreleased maximum offering this token`
      };
    }
  } else if (snapshot !== null) {
    const judgement = await judgeSnapshot(snapshot, context, environment);
    if (judgement.state === 'held') {
      return {
        status: 'held',
        holder: snapshot.owner,
        handoffPending: judgement.handoffPending,
        survivors: judgement.survivors
      };
    }
    if (judgement.state === 'unknown') return { status: 'unknown', detail: judgement.detail };
  }

  // Snapshot before GC can collect the judged generation [F12].
  const previous: SlotLockPrevious = {
    generation: snapshot?.generation ?? (read.kind === 'vacant' ? read.generation : 0),
    owner: snapshot?.owner ?? null,
    companions: snapshot?.companions ?? [],
    creating: snapshot?.creating ?? null
  };
  const owner = slotLockOwnerSchema.parse({
    version: 1,
    executionId: options.executionId,
    cardId: options.cardId,
    purpose: options.purpose,
    domain: context.domain,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
    holder: context.self
  } satisfies SlotLockOwner);
  // The carried intent rides inside the published directory [G2].
  const published = await publishGeneration(
    lockDir,
    previous.generation,
    { owner, creating: previous.creating },
    environment
  );
  if (published.status === 'taken') {
    return { status: 'taken', detail: `generation ${published.generation} was created by another acquirer` };
  }
  if (published.status === 'backed_off') {
    return { status: 'taken', detail: `generation ${published.higher} superseded generation ${published.generation}` };
  }
  if (published.status === 'unavailable') return { status: 'unavailable', detail: published.detail };

  await collectGarbage(lockDir, published.generation, environment.fs);
  const lock = holdSlotLock({ slotRoot, ordinal, generation: published.generation, owner, environment });
  return {
    status: 'acquired',
    lock,
    previous,
    verified: context.verified && (owner.domain.platform === 'win32' || owner.holder.processGroupId !== null)
  };
}

/**
 * Collects every generation below the maximum by moving it away before
 * emptying it, and sweeps abandoned `.tmp-*` and `.gc-*` entries. A failure
 * leaves the entry for a later pass.
 * @param lockDir - The ordinal's `.locks/<n>` directory.
 * @param maximum - The generation this acquirer now holds.
 * @param fs - File operations.
 */
async function collectGarbage(lockDir: string, maximum: number, fs: SlotLockFileSystem): Promise<void> {
  let names: string[];
  try {
    names = await readdir(lockDir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    names.map(async (name) => {
      try {
        if (GENERATION_NAME.test(name)) {
          if (Number(name) >= maximum) return;
          // Never empty a generation in place: a stale acquirer could rename onto the empty name.
          const away = join(lockDir, `.gc-${randomUUID()}`);
          await fs.rename(join(lockDir, name), away);
          await rm(away, { recursive: true, force: true });
          return;
        }
        if (!name.startsWith('.tmp-') && !name.startsWith('.gc-')) return;
        const stats = await lstat(join(lockDir, name));
        if (now - stats.mtimeMs > LOCK_SWEEP_AGE_MS) await rm(join(lockDir, name), { recursive: true, force: true });
      } catch {
        // Left for a later pass.
      }
    })
  );
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
  const fs = environment.fs ?? hostFileSystem;
  const renameBudgetMs = environment.renameBudgetMs ?? LOCK_RENAME_BUDGET_MS;
  const generation = judged + 1;
  const target = join(lockDir, String(generation));
  await mkdir(lockDir, { recursive: true });
  const temp = join(lockDir, `.tmp-${randomUUID()}`);
  try {
    await mkdir(temp);
    await writeFileDurably(join(temp, 'owner.json'), JSON.stringify(files.owner));
    if (files.creating !== null) await writeFileDurably(join(temp, 'creating.json'), JSON.stringify(files.creating));
    await syncDirectory(temp);
    const deadline = Date.now() + renameBudgetMs;
    for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
      try {
        await fs.rename(temp, target);
        break;
      } catch (error) {
        const code = errorCode(error);
        // A non-empty destination existed at the rename, even if GC has moved it since.
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return { status: 'taken', generation };
        // Otherwise decided by lstat, not by reading owner.json, which a scanner may hold open.
        if (await pathExists(target)) return { status: 'taken', generation };
        if (!TRANSIENT_RENAME_CODES.has(code ?? '')) throw error;
        if (Date.now() + delay > deadline) {
          return {
            status: 'unavailable',
            generation,
            detail: `publishing generation ${generation} kept failing with ${code} for ${renameBudgetMs} ms`
          };
        }
      }
      await pause(delay);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await syncDirectory(lockDir);
  // Verify: a stale listing may have renamed onto a lower name; the higher generation wins.
  const maximum = (await listGenerations(lockDir)).at(-1) ?? generation;
  if (maximum > generation) {
    try {
      await writeAtomic(target, 'released.json', JSON.stringify({ releasedAt: new Date().toISOString() }), {
        fs,
        renameBudgetMs
      });
    } catch (error) {
      // GC may already have moved our generation away.
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    return { status: 'backed_off', generation, higher: maximum };
  }
  return { status: 'published', generation };
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
  const result = await acquireSlotLock(slotRoot, ordinal, { ...options, purpose });
  if (result.status !== 'acquired') return result;
  const { lock, previous } = result;
  const fence = resolveEnvironment(options.environment).shutdown.signal;
  // Once the fence closed, the lock frees through dead-holder detection [G1].
  const releaseRemoval = async (): Promise<void> => {
    if (purpose === 'removal' && !fence.aborted) await lock.release();
  };
  let value: T;
  try {
    value = await lock.operation(`${purpose} of slot ${ordinal}`, () => fn(lock, previous));
  } catch (error) {
    // The operation's own failure is the one reported; an unreleased lock still frees once this process exits.
    await releaseRemoval().catch(() => undefined);
    throw error;
  }
  await releaseRemoval();
  return { status: 'done', value };
}

/** What {@link holdSlotLock} needs to hold a published generation. */
interface HeldGeneration {
  readonly slotRoot: string;
  readonly ordinal: number;
  readonly generation: number;
  readonly owner: SlotLockOwner;
  readonly environment: SlotLockEnvironment;
}

/**
 * Holds a generation this process published: the fence, companions, handoff,
 * intent and release, and for a `work` lock the shutdown hook.
 * @param held - The published generation and its environment.
 * @returns The handle every slot operation of this generation goes through.
 */
function holdSlotLock(held: HeldGeneration): SlotLock {
  const { slotRoot, ordinal, generation, owner, environment } = held;
  const { identity, shutdown } = environment;
  const dir = join(lockDirectory(slotRoot, ordinal), String(generation));
  const fence = shutdown.signal;
  let inFlight = 0;
  /** An operation that ended after the fence closed was in flight when it closed. */
  let endedAfterFence = false;
  /** Set by the switch callback's handoff; suppresses every release [F10]. */
  let latched = false;
  let released = false;
  let companions: SlotCompanion[] = [];
  /** Exit of each recorded agent, observed through its `ChildProcess` [F4]. */
  const exits = new Map<number, Promise<void>>();
  let writes: Promise<void> = Promise.resolve();

  const persistCompanions = (update: (current: SlotCompanion[]) => SlotCompanion[]): Promise<void> => {
    const write = writes.then(async () => {
      const next = update(companions);
      await writeAtomic(dir, 'companions.json', JSON.stringify({ version: 1, companions: next }), environment);
      companions = next;
    });
    writes = write.catch(() => undefined);
    return write;
  };

  const writeRelease = async (): Promise<boolean> => {
    if (released) return true;
    try {
      await writeAtomic(dir, 'released.json', JSON.stringify({ releasedAt: new Date().toISOString() }), environment);
    } catch (error) {
      // Collected by a successor that already judged this generation free.
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    released = true;
    return true;
  };

  const exitedWithin = async (deadline: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolveExpired) => {
      timer = setTimeout(() => resolveExpired(false), Math.max(deadline - Date.now(), 0));
    });
    try {
      return await Promise.race([Promise.all(exits.values()).then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Records processes found alive at release as companions, so a later judge
   * keeps the lock for as long as any of them runs.
   * @param found - The processes, with the start identity each was seen with.
   */
  const recordSurvivors = async (found: readonly { pid: number; startIdentity: string }[]): Promise<void> => {
    const fresh = found.filter((entry) => !companions.some((companion) => companion.pid === entry.pid));
    if (fresh.length === 0) return;
    await persistCompanions((current) => [
      ...current,
      ...fresh.map((entry): SlotCompanion => ({ pid: entry.pid, startIdentity: entry.startIdentity, role: 'agent' }))
    ]);
  };

  /**
   * Release snapshot [L4]: lists every process other than the handler that
   * could still act in the slot once `released.json` says it is free, and
   * records any it finds as companions. On POSIX that is the handler's
   * process group, which every child joins at fork, including one a hook
   * forked while its git was being stopped; a handler that does not lead its
   * group, such as one run by a `/bin/sh -c` parent, shares it with processes
   * that are not its own, and relies on the git runner's stop report alone. On
   * Windows, which has no groups and never reparents, it is every live
   * descendant of the handler or of a companion, each created after its
   * parent. Fails closed when the roster cannot be read.
   * @param deadline - When the budget for the roster ends.
   * @returns True when no such process is alive.
   */
  const releaseSnapshotClear = async (deadline: number): Promise<boolean> => {
    const roster = await identity.enumerate(Math.max(deadline - Date.now(), 1));
    if (roster === 'unknown') return false;
    const recorded = new Set(companions.map((companion) => companion.pid));
    const counts = (entry: ProcessIdentity): boolean => entry.pid !== identity.pid && !recorded.has(entry.pid);
    const found = new Map<number, ProcessIdentity>();
    if (identity.platform !== 'win32') {
      const group = owner.holder.processGroupId;
      if (group !== null && group === owner.holder.pid) {
        for (const entry of roster) if (counts(entry) && entry.processGroupId === group) found.set(entry.pid, entry);
      }
    } else {
      const parents = new Map<number, string | null>([
        [owner.holder.pid, owner.holder.startIdentity],
        ...companions.map((companion): [number, string | null] => [
          companion.pid,
          companion.startIdentity === 'pending' ? null : companion.startIdentity
        ])
      ]);
      // Walk to a fixed point: a roster is not ordered parent-first.
      for (let grew = true; grew; ) {
        grew = false;
        for (const entry of roster) {
          if (!counts(entry) || found.has(entry.pid) || !parents.has(entry.parentPid)) continue;
          // A child created before its parent names a reused parent PID.
          const parentStart = windowsTicks(parents.get(entry.parentPid) ?? null);
          const created = windowsTicks(entry.startIdentity);
          if (parentStart !== null && created !== null && created <= parentStart) continue;
          found.set(entry.pid, entry);
          parents.set(entry.pid, entry.startIdentity);
          grew = true;
        }
      }
    }
    if (found.size === 0) return true;
    await recordSurvivors([...found.values()]);
    return false;
  };

  if (owner.purpose === 'work') {
    shutdown.register(async (reason: ShutdownReason) => {
      const deadline = Date.now() + SHUTDOWN_BUDGET_MS - HOOK_RELEASE_MARGIN_MS;
      const stopped = await environment.git.abortAll({ graceMs: HOOK_GIT_GRACE_MS });
      if (released || reason === 'switch' || latched) return;
      // A git tree that could not be listed or fully ended may still write in the slot.
      if (!stopped.complete || stopped.survivors.length > 0) {
        await recordSurvivors(stopped.survivors);
        return;
      }
      // The dying handler may still run its current step: never release under it [G1].
      if (inFlight > 0 || endedAfterFence) return;
      await writes;
      if (!(await exitedWithin(deadline))) return;
      // A companion with no observed exit, such as a Windows git entry still recorded, keeps the lock.
      if (companions.some((companion) => !exits.has(companion.pid))) return;
      if (!(await releaseSnapshotClear(deadline))) return;
      await writeRelease();
    });
  }

  return {
    slotRoot,
    ordinal,
    generation,
    purpose: owner.purpose,
    owner,
    async operation<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (fence.aborted) throw new ShutdownError(`Slot operation ${name} refused: shutdown has begun`);
      inFlight++;
      try {
        return await fn();
      } finally {
        inFlight--;
        if (fence.aborted) endedAfterFence = true;
      }
    },
    checkpoint() {
      if (fence.aborted) throw new ShutdownError('Slot operation stopped at a checkpoint: shutdown has begun');
    },
    async addCompanion(child, role) {
      let failed = false;
      const ended = (): boolean =>
        failed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
      if (ended()) return { status: 'exited' };
      const pid = child.pid as number;
      const exit = new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
        child.once('error', () => {
          failed = true;
          resolveExit();
        });
      });
      const probe = await identity.identify(pid, environment.probeTimeoutMs);
      // A Linux probe still reads an exited, unreaped child: only the ChildProcess says it has exited.
      if (ended() || probe === null) return { status: 'exited' };
      let companion: SlotCompanion;
      if (probe === 'unknown') {
        companion = { pid, startIdentity: 'pending', writtenAt: new Date().toISOString(), role };
      } else if (probe.parentPid !== identity.pid) {
        return { status: 'not_child', parentPid: probe.parentPid };
      } else {
        companion = { pid, startIdentity: probe.startIdentity, role };
      }
      exits.set(pid, exit);
      await persistCompanions((current) => [...current.filter((entry) => entry.pid !== pid), companion]);
      return { status: 'recorded', companion };
    },
    recordGit(event) {
      // On POSIX git runs in the recorded group from fork [F2].
      if (identity.platform !== 'win32') return;
      let update: (current: SlotCompanion[]) => SlotCompanion[];
      if (event.kind === 'spawned') {
        const pending: SlotCompanion = {
          pid: event.pid,
          startIdentity: 'pending',
          writtenAt: new Date().toISOString(),
          role: 'git'
        };
        update = (current) => [...current.filter((entry) => entry.pid !== event.pid), pending];
      } else if (event.kind === 'identified') {
        const probed = event.identity;
        if (probed === 'unknown') return;
        update = (current) =>
          current.map(
            (entry): SlotCompanion =>
              entry.pid === event.pid ? { pid: event.pid, startIdentity: probed.startIdentity, role: 'git' } : entry
          );
      } else {
        update = (current) => current.filter((entry) => entry.pid !== event.pid);
      }
      persistCompanions(update).catch((error: unknown) => {
        // A lost record is the accepted crash-only gap [G9]; the intent still drives recovery.
        process.stderr.write(`Slot lock: recording git ${event.pid} failed: ${describeError(error)}\n`);
      });
    },
    async removeCompanion(pid) {
      exits.delete(pid);
      await persistCompanions((current) => current.filter((entry) => entry.pid !== pid));
    },
    async offerHandoff() {
      latched = true;
      const token = randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + HANDOFF_EXPIRY_MS).toISOString();
      await writeAtomic(dir, 'handoff.json', JSON.stringify({ token, expiresAt }), environment);
      return { generation, token };
    },
    async writeIntent(intent) {
      await writeAtomic(dir, 'creating.json', JSON.stringify(slotCreationIntentSchema.parse(intent)), environment);
    },
    async clearIntent() {
      try {
        await unlink(join(dir, 'creating.json'));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    },
    async release() {
      // Once the fence closed only the hook may release [G1].
      if (fence.aborted || latched) return false;
      if (released) return true;
      // A process the handler leaves behind, such as a hook's background child, keeps the lock [L4].
      if (!(await releaseSnapshotClear(Date.now() + environment.probeTimeoutMs))) return false;
      return writeRelease();
    }
  };
}

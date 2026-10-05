/**
 * Fixtures for slot lock tests: an injected process world that answers every
 * identity, liveness and domain question the lock asks, and writers for raw
 * generation directories so each judgement starts from an exact on-disk state.
 * @summary Fake identity service and generation writers for slot lock tests
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShutdownCoordinator, type ShutdownCoordinator } from '../../src/config/runtime-shutdown.js';
import type {
  DarwinProcessDomain,
  IdentifyManyResult,
  IdentityProbe,
  LinuxProcessDomain,
  ProcessDomain,
  ProcessIdentity,
  ProcessIdentityService,
  WindowsProcessDomain
} from '../../src/process-identity.js';
import type {
  SlotCompanion,
  SlotCreationIntent,
  SlotHandoff,
  SlotLockEnvironment,
  SlotLockOwner
} from '../../src/slot-lock.js';

/** A live process in the fake world; `unknown` makes its probe fail. */
export type FakeProcess = Omit<ProcessIdentity, 'pid'> | 'unknown';

/** Mutable process table and call log behind {@link fakeIdentity}. */
export interface FakeWorld {
  platform: NodeJS.Platform;
  pid: number;
  domain: ProcessDomain;
  /** This process's identity; `unknown` when unreadable. */
  self: FakeProcess;
  /** This process's group, read independently of `self`. */
  selfGroup: number | null;
  /** Live processes by PID, this process excluded. */
  processes: Map<number, FakeProcess>;
  /** Live groups with no listed member, such as a member this test cannot list. */
  extraGroups: Set<number>;
  /** Remaining `identifyMany` calls that time out. */
  identifyManyTimeouts: number;
  /** PIDs and groups the lock asked about, in order. */
  readonly calls: { identify: number[]; absent: number[]; groups: number[]; identifyMany: number; enumerate: number };
}

export const LINUX_DOMAIN: LinuxProcessDomain = {
  platform: 'linux',
  machineId: 'machine-1',
  bootId: 'boot-1',
  pidNamespace: '4026531836',
  pidNamespaceInit: '100'
};

export const DARWIN_DOMAIN: DarwinProcessDomain = {
  platform: 'darwin',
  machineId: 'machine-1',
  bootSessionUuid: 'session-1'
};

export const WINDOWS_DOMAIN: WindowsProcessDomain = {
  platform: 'win32',
  machineId: 'guid-1',
  bootTime: '2026-10-05T08:00:00.0000000Z'
};

/** PID of the fake handler. */
export const SELF_PID = 1_000;

/** Process group of the fake handler. */
export const SELF_GROUP = 990;

/**
 * Creates a fake world whose handler is verified and alone.
 * @param overrides - Fields to replace.
 * @returns The world; tests mutate it to start and end processes.
 */
export function fakeWorld(overrides: Partial<Omit<FakeWorld, 'calls'>> = {}): FakeWorld {
  const platform = overrides.platform ?? overrides.domain?.platform ?? 'linux';
  const domain =
    overrides.domain ?? (platform === 'win32' ? WINDOWS_DOMAIN : platform === 'darwin' ? DARWIN_DOMAIN : LINUX_DOMAIN);
  const selfGroup = platform === 'win32' ? null : SELF_GROUP;
  return {
    platform,
    pid: SELF_PID,
    domain,
    self: { parentPid: 1, startIdentity: 'self-start', processGroupId: selfGroup ?? 0 },
    selfGroup,
    processes: new Map(),
    extraGroups: new Set(),
    identifyManyTimeouts: 0,
    ...overrides,
    calls: { identify: [], absent: [], groups: [], identifyMany: 0, enumerate: 0 }
  };
}

function probe(world: FakeWorld, pid: number): IdentityProbe {
  const entry = pid === world.pid ? world.self : world.processes.get(pid);
  if (entry === undefined) return null;
  if (entry === 'unknown') return 'unknown';
  return { pid, ...entry };
}

/**
 * An identity service answering from a fake world.
 * @param world - The process table it reads at call time.
 * @returns The service.
 */
export function fakeIdentity(world: FakeWorld): ProcessIdentityService {
  return {
    get platform() {
      return world.platform;
    },
    get pid() {
      return world.pid;
    },
    async enumerate() {
      world.calls.enumerate++;
      const rows: ProcessIdentity[] = [];
      for (const pid of [world.pid, ...world.processes.keys()]) {
        const identity = probe(world, pid);
        if (identity !== null && identity !== 'unknown') rows.push(identity);
      }
      return rows;
    },
    async identify(pid) {
      world.calls.identify.push(pid);
      if (!world.processes.has(pid) && pid !== world.pid) return null;
      return probe(world, pid);
    },
    async identifyMany(pids, options): Promise<IdentifyManyResult> {
      world.calls.identifyMany++;
      if (world.identifyManyTimeouts > 0) {
        world.identifyManyTimeouts--;
        return {
          identities: new Map(pids.map((pid) => [pid, 'unknown' as const])),
          ...(options.includeSelf ? { self: 'unknown' as const } : {})
        };
      }
      const identities = new Map(pids.map((pid) => [pid, probe(world, pid)]));
      if (!options.includeSelf) return { identities };
      const self = probe(world, world.pid);
      return {
        identities,
        self: self === null ? 'unknown' : self,
        ...(world.domain.platform === 'win32' ? { domain: world.domain } : {})
      };
    },
    isProcessAbsent(pid) {
      world.calls.absent.push(pid);
      return pid !== world.pid && !world.processes.has(pid);
    },
    isProcessGroupAlive(pgid) {
      world.calls.groups.push(pgid);
      if (world.platform === 'win32') return null;
      if (world.extraGroups.has(pgid) || world.selfGroup === pgid) return true;
      for (const entry of world.processes.values()) {
        if (entry !== 'unknown' && entry.processGroupId === pgid) return true;
      }
      return false;
    },
    async currentProcessDomain() {
      return world.domain;
    },
    async currentProcessGroupId() {
      return world.selfGroup;
    },
    async currentProcessIdentity() {
      const self = probe(world, world.pid);
      return self === null ? 'unknown' : self;
    }
  };
}

/** A lock environment over a fake world, with its own shutdown coordinator. */
export interface FakeLockEnvironment {
  readonly environment: Partial<SlotLockEnvironment>;
  readonly shutdown: ShutdownCoordinator;
  readonly exits: number[];
  readonly aborts: number[];
}

/**
 * Builds a lock environment whose shutdown never exits the test process.
 * @param world - The fake world, or null for the host's real identity service.
 * @param extra - Further environment overrides.
 * @returns The environment and its recorded exits and git aborts.
 */
export function lockEnvironment(
  world: FakeWorld | null,
  extra: Partial<SlotLockEnvironment> = {}
): FakeLockEnvironment {
  const exits: number[] = [];
  const aborts: number[] = [];
  const shutdown = createShutdownCoordinator({ exit: (code) => exits.push(code) });
  return {
    shutdown,
    exits,
    aborts,
    environment: {
      ...(world === null ? {} : { identity: fakeIdentity(world) }),
      shutdown,
      git: {
        abortAll: async ({ graceMs }) => {
          aborts.push(graceMs);
        }
      },
      ...extra
    }
  };
}

/**
 * Builds a valid `owner.json` for a holder in the default Linux domain.
 * @param overrides - Fields to replace; `holder` fields merge.
 * @returns An owner held by PID 2000 in group 2000 for `exec-1`.
 */
export function ownerFile(
  overrides: Partial<Omit<SlotLockOwner, 'holder'>> & { holder?: Partial<SlotLockOwner['holder']> } = {}
): SlotLockOwner {
  const { holder, ...rest } = overrides;
  return {
    version: 1,
    executionId: 'exec-1',
    cardId: 'main-734',
    purpose: 'work',
    domain: LINUX_DOMAIN,
    hostname: 'devbox',
    createdAt: '2026-10-05T17:40:12.031Z',
    ...rest,
    holder: { pid: 2_000, startIdentity: 'holder-start', processGroupId: 2_000, ...holder }
  };
}

/** Files of one generation; a string is written as is. */
export interface GenerationFiles {
  readonly owner?: SlotLockOwner | string;
  readonly companions?: readonly SlotCompanion[] | string;
  readonly handoff?: SlotHandoff | string;
  readonly creating?: SlotCreationIntent | string;
  readonly released?: boolean | string;
}

/**
 * Writes one generation directory exactly as given.
 * @param slotRoot - The card's slot root.
 * @param ordinal - Slot ordinal.
 * @param generation - Generation number.
 * @param files - The files to write.
 * @returns The generation directory.
 */
export function writeGeneration(slotRoot: string, ordinal: number, generation: number, files: GenerationFiles): string {
  const dir = join(slotRoot, '.locks', String(ordinal), String(generation));
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  if (files.owner !== undefined) write('owner.json', files.owner);
  if (files.companions !== undefined) {
    write(
      'companions.json',
      typeof files.companions === 'string' ? files.companions : { version: 1, companions: files.companions }
    );
  }
  if (files.handoff !== undefined) write('handoff.json', files.handoff);
  if (files.creating !== undefined) write('creating.json', files.creating);
  if (files.released !== undefined && files.released !== false) {
    write('released.json', files.released === true ? { releasedAt: '2026-10-05T17:41:00.000Z' } : files.released);
  }
  return dir;
}

/** A creation intent for tests. */
export const INTENT: SlotCreationIntent = {
  version: 1,
  op: 'create',
  branch: 'cards/main-734/3',
  path: '/slots/3',
  createdOid: 'a'.repeat(40),
  registeredBefore: false
};

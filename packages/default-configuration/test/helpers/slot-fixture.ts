/**
 * A real workspace repository, a slot root under a temporary worktrees
 * directory, an in-memory Cards client and a slot layer with its own shutdown
 * coordinator, for slot-layer tests. Git and locks are real; only the Cards
 * API and the S3 provisioning step are stand-ins.
 *
 * @summary Real-repository fixture for worktree slot tests
 * @module
 */

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Card, Logger } from '@cards.management/sdk';
import { runGitBounded } from '@cards.management/sdk/bounded-git';
import { resolveSlotRoot } from '@cards.management/sdk/cards-config';
import type {
  AddBranchRequest,
  BranchesResponse,
  BranchInfo,
  ExecutionProcessStatus
} from '@cards.management/sdk/client';
import {
  createShutdownCoordinator,
  type ShutdownCoordinator,
  ShutdownError,
  shutdownSignal
} from '@cards.management/sdk/config';
import type { SlotLock } from '@cards.management/sdk/slot-lock';
import type { SlotActionInput, SlotCleanupContext, SlotClient, SlotLayer } from '../../src/lib/worktrees/index.js';
import { defaultSlotLayer } from '../../src/lib/worktrees/index.js';
import type { ProvisionSlotCheckoutOptions } from '../../src/lib/worktrees/seams.js';
import { interimSlotRemoval } from '../../src/lib/worktrees/seams.js';
import { createSlotGit } from '../../src/lib/worktrees/slot-git.js';

const run = promisify(execFile);

/** Git identity for commits made by fixtures. */
export const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Slot Fixture',
  GIT_AUTHOR_EMAIL: 'slot-fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Slot Fixture',
  GIT_COMMITTER_EMAIL: 'slot-fixture@example.invalid'
} as const;

/** An in-memory Cards client holding one card's registrations, with failure injection. */
export class FakeSlotClient implements SlotClient {
  readonly registrations = new Map<string, BranchInfo>();
  readonly invalidEntries: { name: string; reason: string }[] = [];
  readonly executionStatus = new Map<string, ExecutionProcessStatus>();
  /** Card-level parent branch returned by `getCard`. */
  parentBranch: string | null = 'main';
  /** When set, the next `addBranch` applies its write and then throws, like a lost response. */
  failAfterAddBranch = false;
  /** When set, `getBranches` throws. */
  failGetBranches = false;
  /** Runs before `addBranch` writes; another process's stop point. */
  beforeAddBranch: (() => Promise<void>) | null = null;
  /** Runs after `addBranch` wrote and persisted, before it returns. */
  afterAddBranch: (() => Promise<void>) | null = null;
  /** File every registration write is mirrored to, so another process can read it; null keeps them in memory only. */
  persistPath: string | null = null;
  readonly calls: string[] = [];

  /**
   * Creates the client for one card.
   * @param cardId - The card whose registrations it holds.
   */
  constructor(readonly cardId: string) {}

  /**
   * Returns the card with its parent branch.
   * @param cardId - Card to read.
   * @returns A card carrying only its id, a title and `parentBranch`.
   */
  async getCard(cardId: string): Promise<Card> {
    this.calls.push(`getCard ${cardId}`);
    return { id: cardId, title: 'Slot fixture', parentBranch: this.parentBranch ?? undefined } as unknown as Card;
  }

  /**
   * Lists registrations and invalid entries.
   * @param cardId - Card to read.
   * @returns The registrations, oldest first.
   */
  async getBranches(cardId: string): Promise<BranchesResponse> {
    this.calls.push(`getBranches ${cardId}`);
    if (this.failGetBranches) throw new Error('getBranches failed');
    return {
      branches: [...this.registrations.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
      invalidEntries: [...this.invalidEntries],
      commits: [],
      defaultBranch: 'main',
      mergedCommits: [],
      headBranch: 'main'
    };
  }

  /**
   * Registers a branch; `create` refuses an existing name.
   * @param cardId - Card to write.
   * @param data - The registration.
   * @returns The write outcome.
   */
  async addBranch(cardId: string, data: AddBranchRequest): Promise<{ outcome: 'created' | 'upserted' }> {
    this.calls.push(`addBranch ${cardId} ${data.name}`);
    await this.beforeAddBranch?.();
    const existing = this.registrations.has(data.name);
    if (existing && data.intent === 'create') throw new Error(`Branch ${data.name} already registered`);
    this.registrations.set(data.name, {
      name: data.name,
      ...(data.worktree === undefined ? {} : { worktree: data.worktree }),
      parentBranch: data.parentBranch ?? 'main',
      addedAt: new Date().toISOString()
    });
    await this.save();
    await this.afterAddBranch?.();
    if (this.failAfterAddBranch) {
      this.failAfterAddBranch = false;
      throw new Error('addBranch response lost');
    }
    return { outcome: existing ? 'upserted' : 'created' };
  }

  /**
   * Removes a registration.
   * @param cardId - Card to write.
   * @param name - Branch to unregister.
   * @returns The removal outcome.
   */
  async removeBranch(cardId: string, name: string): Promise<{ outcome: 'removed' | 'preserved' }> {
    this.calls.push(`removeBranch ${cardId} ${name}`);
    this.registrations.delete(name);
    await this.save();
    return { outcome: 'removed' };
  }

  /** Mirrors the registrations to {@link persistPath}, when set. */
  async save(): Promise<void> {
    if (this.persistPath === null) return;
    await writeFile(this.persistPath, JSON.stringify([...this.registrations.values()]));
  }

  /** Replaces the registrations with those mirrored to {@link persistPath}; a missing file means none. */
  async reload(): Promise<void> {
    if (this.persistPath === null) throw new Error('No persist path to reload from');
    const text = await readFile(this.persistPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    });
    this.registrations.clear();
    for (const registration of JSON.parse(text) as BranchInfo[])
      this.registrations.set(registration.name, registration);
  }

  /**
   * Reads an execution's process state.
   * @param executionId - Execution to read.
   * @returns Its status; `terminal` unless set.
   */
  async getExecutionStatus(executionId: string): Promise<ExecutionProcessStatus> {
    this.calls.push(`getExecutionStatus ${executionId}`);
    return this.executionStatus.get(executionId) ?? 'terminal';
  }
}

/**
 * Runs before each slot git call the layer makes; a throw fails that call.
 * @param args - Git arguments, without the fsmonitor override.
 * @param cwd - The call's working directory.
 */
export type SlotGitInterceptor = (args: readonly string[], cwd: string) => Promise<void>;

/**
 * Makes a held lock's generation look like it belongs to a handler that died:
 * its owner's PID and group become those of a detached child that has exited.
 * The lock object itself must not be used afterwards.
 * @param lock - A lock this process holds.
 */
export async function abandonSlotLock(lock: SlotLock): Promise<void> {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await once(child, 'exit');
  const deadPid = child.pid;
  if (deadPid === undefined) throw new Error('No PID for the stand-in holder');
  const ownerPath = join(lock.slotRoot, '.locks', String(lock.ordinal), String(lock.generation), 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { holder: Record<string, unknown> };
  owner.holder = { ...owner.holder, pid: deadPid, processGroupId: deadPid };
  await writeFile(ownerPath, JSON.stringify(owner));
}

/** Interception points of a fixture layer. */
export interface SlotLayerHooks {
  beforeGit: SlotGitInterceptor | null;
  beforeProvision: ((options: ProvisionSlotCheckoutOptions) => Promise<void>) | null;
  /**
   * Observes each slot git call once it settled.
   * @param args - Git arguments, without the fsmonitor override.
   * @param call - How the call went against the shutdown fence.
   * @param call.fencedAtCall - Whether the fence had closed when the call was made.
   * @param call.refused - Whether the call was refused for the closed fence.
   */
  afterGit?: (args: readonly string[], call: { readonly fencedAtCall: boolean; readonly refused: boolean }) => void;
}

/**
 * Builds the slot layer fixtures use: the host layer with git routed through
 * {@link SlotLayerHooks.beforeGit}, provisioning that only records its calls,
 * and the interim removal seam.
 * @param scratch - The fixture's scratch directory.
 * @param hooks - Interception points, read at each call.
 * @param provisioned - Receives every provisioning call.
 * @param shutdown - The coordinator slot locks fence on; the process's own when omitted.
 * @returns A layer whose git, provisioning and removal are the fixture's.
 */
export function createFixtureLayer(
  scratch: string,
  hooks: SlotLayerHooks,
  provisioned: ProvisionSlotCheckoutOptions[],
  shutdown?: ShutdownCoordinator
): SlotLayer {
  return {
    ...defaultSlotLayer(),
    git: createSlotGit({
      run: async (cwd, args, options) => {
        await hooks.beforeGit?.(args.slice(2), cwd);
        const fencedAtCall = (shutdown?.signal ?? shutdownSignal).aborted;
        try {
          const result = await runGitBounded(cwd, args, options);
          hooks.afterGit?.(args.slice(2), { fencedAtCall, refused: false });
          return result;
        } catch (error) {
          hooks.afterGit?.(args.slice(2), { fencedAtCall, refused: error instanceof ShutdownError });
          throw error;
        }
      }
    }),
    seams: {
      provisionSlotCheckout: async (options) => {
        options.checkpoint();
        await hooks.beforeProvision?.(options);
        provisioned.push(options);
        return { checkout: options.worktreePath, branchName: options.branch };
      },
      // TODO(S2): bind the SDK's verified removal once it merges.
      removal: interimSlotRemoval
    },
    ...(shutdown === undefined ? {} : { lockEnvironment: { shutdown } }),
    sharedHooksDir: join(scratch, 'workspace-hooks')
  };
}

/** One test's repositories, client and layer. */
export interface SlotFixture {
  readonly cardId: string;
  /** The temporary directory holding everything the fixture made. */
  readonly scratch: string;
  /** The workspace (main) repository, with one commit on `main`. */
  readonly repoRoot: string;
  readonly slotRoot: string;
  /** The fake client; its registrations are mirrored to `<scratch>/registrations.json`. */
  readonly client: FakeSlotClient;
  /** This test's shutdown coordinator; its exit only records the code. */
  readonly shutdown: ShutdownCoordinator;
  readonly layer: SlotLayer;
  /** Provisioning calls made through the layer's S3 seam. */
  readonly provisioned: ProvisionSlotCheckoutOptions[];
  /** Runs before every provisioning call; a throw fails it. */
  beforeProvision: ((options: ProvisionSlotCheckoutOptions) => Promise<void>) | null;
  /** Runs before every slot git call the layer makes. */
  beforeGit: SlotGitInterceptor | null;
  /**
   * Runs git and returns its trimmed stdout.
   * @param args - Git arguments.
   * @param cwd - Working directory; the workspace repository by default.
   * @returns Trimmed stdout.
   */
  git(args: readonly string[], cwd?: string): Promise<string>;
  /**
   * Action input for one execution of the card.
   * @param executionId - Execution the input belongs to.
   * @param overrides - Fields replacing the defaults.
   * @returns Input naming the card, the workspace repository and a scratch extension path.
   */
  input(executionId: string, overrides?: Partial<SlotActionInput>): SlotActionInput;
  /**
   * Cleanup context for the card.
   * @returns The fake client, a logger, the workspace repository and the fixture's layer.
   */
  cleanupContext(): SlotCleanupContext;
  /** Removes every directory the fixture created and restores the environment. */
  dispose(): Promise<void>;
}

/**
 * Creates a fixture: a repository with one commit on `main`, a temporary
 * `CARDS_WORKTREES_DIR`, a fake client and a layer whose provisioning only
 * records its calls.
 * @param cardId - Card the slots belong to.
 * @returns A ready fixture; call `dispose` after the test.
 */
export async function createSlotFixture(cardId = 'card-1'): Promise<SlotFixture> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'slot-fixture-')));
  const repoRoot = join(scratch, 'repo');
  const previousWorktreesDir = process.env['CARDS_WORKTREES_DIR'];
  process.env['CARDS_WORKTREES_DIR'] = join(scratch, 'worktrees');

  const git = async (args: readonly string[], cwd = repoRoot): Promise<string> => {
    const { stdout } = await run('git', [...args], { cwd, env: { ...process.env, ...FIXTURE_GIT_ENV } });
    return stdout.trim();
  };
  await run('git', ['init', '-q', '-b', 'main', repoRoot]);
  await git(['commit', '-q', '--allow-empty', '-m', 'initial']);

  const client = new FakeSlotClient(cardId);
  const shutdown = createShutdownCoordinator({ exit: () => {} });
  client.persistPath = join(scratch, 'registrations.json');
  const provisioned: ProvisionSlotCheckoutOptions[] = [];
  const hooks: SlotLayerHooks = { beforeGit: null, beforeProvision: null };
  const layer = createFixtureLayer(scratch, hooks, provisioned, shutdown);

  return {
    get beforeGit() {
      return hooks.beforeGit;
    },
    set beforeGit(value) {
      hooks.beforeGit = value;
    },
    get beforeProvision() {
      return hooks.beforeProvision;
    },
    set beforeProvision(value) {
      hooks.beforeProvision = value;
    },
    cardId,
    scratch,
    repoRoot,
    slotRoot: await resolveSlotRoot(repoRoot, cardId),
    client,
    shutdown,
    layer,
    provisioned,
    git,
    input: (executionId, overrides = {}) => ({
      executionId,
      cardId,
      repoRoot,
      extensionPath: join(scratch, 'extension'),
      ...overrides
    }),
    cleanupContext: () => ({
      client,
      logger: new Logger(),
      cardId,
      executionId: 'cleanup-exec',
      workspacePath: repoRoot,
      layer
    }),
    dispose: async () => {
      if (previousWorktreesDir === undefined) delete process.env['CARDS_WORKTREES_DIR'];
      else process.env['CARDS_WORKTREES_DIR'] = previousWorktreesDir;
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

/**
 * `acquireSlot`: picks the checkout an action runs in and holds its `work`
 * lock until the handler exits. Handoff first, then the most recently used
 * free usable slot, then a reattach or recreate, then a new ordinal.
 *
 * @summary Slot acquisition: handoff, LIFO reuse, reattach, recreate, create
 * @module
 */

import { join } from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk';
import { resolveMainRepoRoot, resolveSlotRoot } from '@cards.management/sdk/cards-config';
import type { BranchInfo, CardsClient } from '@cards.management/sdk/client';
import {
  type AcquireSlotLockResult,
  acquireSlotLock,
  createSlotJudgeContext,
  readSlotLock,
  readSlotLockSnapshot,
  ShutdownError,
  type SlotCreationIntent,
  type SlotJudgeContext,
  type SlotLock,
  type SlotLockPrevious,
  slotLockPids
} from '@cards.management/sdk/slot-lock';
import { rankWorktreeSlots } from '@cards.management/sdk/worktree-path-policy';
import { z } from 'zod';
import { judgeUsability, listWorktreeEntries, pathExists, refOid, samePath } from './checkout.js';
import { type DiscoveredSlot, discoverSlots, type SlotPlace, slotBranch, slotOrdinal } from './discovery.js';
import { type CreationContext, rollbackCreation } from './intent.js';
import { defaultSlotLayer, type SlotLayer } from './layer.js';
import { recoverSlot } from './recovery.js';
import { type RegistrationClient, registerSlot } from './registration.js';

/** The client calls acquisition needs. */
export type SlotClient = RegistrationClient & Pick<CardsClient, 'getCard' | 'getExecutionStatus'>;

/** The action input fields acquisition reads. */
export type SlotActionInput = Pick<
  ActionInput,
  'executionId' | 'cardId' | 'repoRoot' | 'extensionPath' | 'switchToInteractiveData'
>;

/** The slot a switched session hands to its interactive successor. */
export interface SlotHandoffData {
  readonly ordinal: number;
  readonly branch: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly token: string;
}

const slotHandoffDataSchema = z.object({
  slot: z.object({
    ordinal: z.number().int().positive(),
    branch: z.string().min(1),
    worktreePath: z.string().min(1),
    generation: z.number().int().positive(),
    token: z.string().min(1)
  })
});

/** A slot acquisition passed over because its lock could not be judged or published. */
export interface SkippedSlot {
  readonly ordinal: number;
  readonly reason: string;
}

/** How the acquired checkout came to be. */
export type SlotAcquisitionOutcome = 'handoff' | 'reused' | 'reattached' | 'recreated' | 'created';

/** A held slot. */
export interface AcquiredSlot {
  readonly lock: SlotLock;
  readonly place: SlotPlace;
  readonly ordinal: number;
  readonly branch: string;
  readonly worktreePath: string;
  readonly parentBranch: string;
  readonly outcome: SlotAcquisitionOutcome;
  /** Slots skipped as unjudgeable or whose lock could not be published, each with its reason. */
  readonly skipped: readonly SkippedSlot[];
  /** Why a presented handoff could not be claimed; null when none was presented or it was claimed. */
  readonly handoffLost: string | null;
}

/** Options of {@link acquireSlot}. */
export interface AcquireSlotOptions {
  readonly client: SlotClient;
  readonly logger: ActionContext['logger'];
  /** Git, seams and lock environment; the host's by default. */
  readonly layer?: SlotLayer;
}

/** How many free slots macOS judges per call before creating a new ordinal. */
const DARWIN_JUDGED_SLOT_CAP = 16;

/** Upper bound on ordinals tried by one create. */
const CREATE_ATTEMPTS = 64;

/**
 * Formats the skipped-slot line of the launch output.
 * @param skipped - Slots skipped as unjudgeable or lock_unavailable.
 * @returns The line, or null when none was skipped.
 */
export function describeSkippedSlots(skipped: readonly SkippedSlot[]): string | null {
  if (skipped.length === 0) return null;
  const list = skipped.map((slot) => `${slot.ordinal} (${slot.reason})`).join(', ');
  return `${skipped.length} ${skipped.length === 1 ? 'slot' : 'slots'} skipped as unjudgeable: ${list}`;
}

/**
 * Describes a lock that was not acquired.
 * @param result - The acquire outcome.
 * @returns A human-readable reason.
 */
function notAcquired(result: Exclude<AcquireSlotLockResult, { status: 'acquired' }>): string {
  switch (result.status) {
    case 'held':
      return `held by execution ${result.holder.executionId} (pid ${result.holder.holder.pid} on ${result.holder.hostname})${result.handoffPending ? ', handoff pending' : ''}`;
    case 'taken':
      return result.detail;
    case 'unknown':
      return result.detail.reason;
    case 'unavailable':
      return result.detail;
  }
}

/**
 * Acquires a slot for this execution and holds its `work` lock. The lock's
 * shutdown hook, registered by the acquire, is the only release.
 * @param input - Action input.
 * @param options - Client, logger and slot layer.
 * @returns The held slot.
 * @throws When no slot can be reused or created, or the shutdown fence closed.
 */
export async function acquireSlot(input: SlotActionInput, options: AcquireSlotOptions): Promise<AcquiredSlot> {
  const layer = options.layer ?? defaultSlotLayer();
  const { client, logger } = options;
  const { git } = layer;
  const place: SlotPlace = {
    cardId: input.cardId,
    repoRoot: await resolveMainRepoRoot(input.repoRoot),
    slotRoot: await resolveSlotRoot(input.repoRoot, input.cardId)
  };
  const { cardId, repoRoot, slotRoot } = place;
  const lockOptions = {
    executionId: input.executionId,
    cardId,
    purpose: 'work' as const,
    ...(layer.lockEnvironment === undefined ? {} : { environment: layer.lockEnvironment })
  };
  const creation: CreationContext = {
    git,
    client,
    place,
    log: (message, fields) => logger.info(message, { cardId, ...fields })
  };
  const skipped: SkippedSlot[] = [];
  let handoffLost: string | null = null;

  const settle = (
    lock: SlotLock,
    slot: { ordinal: number; branch: string; worktreePath: string; parentBranch: string },
    outcome: SlotAcquisitionOutcome
  ): AcquiredSlot => {
    const acquired: AcquiredSlot = { lock, place, ...slot, outcome, skipped, handoffLost };
    logger.info('Slot acquired', {
      cardId,
      ordinal: slot.ordinal,
      branch: slot.branch,
      worktreePath: slot.worktreePath,
      generation: lock.generation,
      outcome,
      ...(handoffLost === null ? {} : { handoffLost })
    });
    const line = describeSkippedSlots(skipped);
    if (line !== null) logger.warn(line, { cardId });
    return acquired;
  };

  /**
   * Recovers what the previous holder of this ordinal left: an interrupted creation, then quarantine residue.
   * @param lock - The ordinal's freshly acquired lock.
   * @param previous - The generation judged before GC.
   * @param slotPath - The slot checkout path.
   * @param residue - Quarantine paths beside the slot.
   * @throws When the slot is left unsettled, so it is neither used nor written into.
   */
  const recoverPrevious = async (
    lock: SlotLock,
    previous: SlotLockPrevious,
    slotPath: string,
    residue: readonly string[]
  ): Promise<void> => {
    const recovery = await recoverSlot(lock, previous, slotPath, residue.length > 0, {
      creation,
      removal: layer.seams.removal
    });
    if (recovery.unsettled !== null)
      throw new Error(`${slotPath} is unsettled (${recovery.unsettled.reason}): ${recovery.unsettled.detail}`);
  };

  /**
   * Runs `check` under a fresh `work` lock of the ordinal, after recovery, as one slot operation.
   * @param ordinal - Slot to lock.
   * @param slotPath - Its checkout path.
   * @param residue - Its quarantine paths.
   * @param judge - Shared judgement context of this call.
   * @param check - Returns a value to keep the lock, or null to decline.
   * @returns The held lock and value, or null after releasing a declined or failed candidate.
   */
  const underLock = async <T>(
    ordinal: number,
    slotPath: string,
    residue: readonly string[],
    judge: SlotJudgeContext | undefined,
    check: (lock: SlotLock) => Promise<T | null>
  ): Promise<{ lock: SlotLock; value: T } | null> => {
    const result = await acquireSlotLock(slotRoot, ordinal, {
      ...lockOptions,
      ...(judge === undefined ? {} : { context: judge })
    });
    if (result.status !== 'acquired') {
      if (result.status === 'unknown') skipped.push({ ordinal, reason: result.detail.reason });
      if (result.status === 'unavailable') skipped.push({ ordinal, reason: `lock_unavailable: ${result.detail}` });
      return null;
    }
    const { lock, previous } = result;
    try {
      const value = await lock.operation(`acquire check of slot ${ordinal}`, async () => {
        await recoverPrevious(lock, previous, slotPath, residue);
        lock.checkpoint();
        return check(lock);
      });
      if (value !== null) return { lock, value };
    } catch (error) {
      if (error instanceof ShutdownError) throw error;
      logger.warn('Slot candidate refused', { cardId, ordinal, error: describe(error) });
    }
    await lock.release();
    return null;
  };

  /**
   * Re-reads the registration of a slot.
   * @param branch - Slot branch.
   * @returns Its valid registration, or null.
   */
  const registrationOf = async (branch: string): Promise<BranchInfo | null> =>
    (await client.getBranches(cardId)).branches.find((entry) => entry.name === branch) ?? null;

  /**
   * Writes the intent, creates the ref when the intent names one, adds and provisions the checkout, runs
   * `afterProvision`, and clears the intent. A failure while the handler lives is rolled back in process.
   * @param lock - The ordinal's held lock.
   * @param intent - The creation to perform.
   * @param parentBranch - Parent branch the checkout is bound to.
   * @param afterProvision - Registration of a new slot; absent for a reattach or recreate.
   */
  const materialize = async (
    lock: SlotLock,
    intent: SlotCreationIntent,
    parentBranch: string,
    afterProvision?: () => Promise<void>
  ): Promise<void> => {
    let registered = false;
    let intentWritten = false;
    try {
      lock.checkpoint();
      await lock.writeIntent(intent);
      intentWritten = true;
      if (intent.createdOid !== null) {
        lock.checkpoint();
        // The empty old value refuses an existing ref: a create never adopts a branch it did not make.
        const created = await git.run(repoRoot, ['update-ref', `refs/heads/${intent.branch}`, intent.createdOid, ''], {
          record: (event) => lock.recordGit(event)
        });
        if (created.exitCode !== 0) {
          await lock.clearIntent();
          throw new RefRefusedError(intent.branch, created.stderr.trim());
        }
      }
      let staleEntry = false;
      for (const entry of await listWorktreeEntries(git, repoRoot)) {
        if (await samePath(entry.path, intent.path)) staleEntry = true;
      }
      lock.checkpoint();
      await git.text(repoRoot, ['worktree', 'add', ...(staleEntry ? ['--force'] : []), intent.path, intent.branch], {
        timeoutMs: layer.checkoutTimeoutMs,
        record: (event) => lock.recordGit(event)
      });
      lock.checkpoint();
      await layer.seams.provisionSlotCheckout({
        repoRoot,
        sourceRoot: input.repoRoot,
        cardId,
        parentBranch,
        branch: intent.branch,
        worktreePath: intent.path,
        extensionPath: input.extensionPath,
        sharedHooksDir: layer.sharedHooksDir,
        runGit: git.provisioningRunner({
          timeoutMs: layer.checkoutTimeoutMs,
          record: (event) => lock.recordGit(event)
        }),
        checkpoint: () => lock.checkpoint()
      });
      if (afterProvision !== undefined) {
        lock.checkpoint();
        await afterProvision();
        registered = true;
      }
      lock.checkpoint();
      await lock.clearIntent();
    } catch (error) {
      // Stopped by the fence: the intent stays for the next holder [G1].
      if (error instanceof ShutdownError || error instanceof RefRefusedError) throw error;
      if (intentWritten)
        await rollbackCreation(lock, intent, registered, creation).catch((rollbackError: unknown) => {
          if (rollbackError instanceof ShutdownError) throw rollbackError;
          logger.error('Slot creation rollback failed; the intent stays for the next holder', {
            cardId,
            branch: intent.branch,
            error: describe(rollbackError)
          });
        });
      throw error;
    }
  };

  // 1. Handoff first [R1].
  const handoff = slotHandoffDataSchema.safeParse(input.switchToInteractiveData);
  if (handoff.success) {
    const offered = handoff.data.slot;
    const result = await acquireSlotLock(slotRoot, offered.ordinal, {
      ...lockOptions,
      handoff: { generation: offered.generation, token: offered.token }
    });
    if (result.status === 'acquired') {
      const { lock } = result;
      try {
        const registration = await lock.operation('handoff check', async () => {
          const found = await registrationOf(offered.branch);
          if (found === null) return 'the slot is no longer registered';
          const usability = await judgeUsability(git, repoRoot, offered.worktreePath, offered.branch);
          return usability.status === 'usable' ? found : `the checkout is ${usability.status.replaceAll('_', ' ')}`;
        });
        if (typeof registration !== 'string')
          return settle(
            lock,
            {
              ordinal: offered.ordinal,
              branch: offered.branch,
              worktreePath: offered.worktreePath,
              parentBranch: registration.parentBranch
            },
            'handoff'
          );
        handoffLost = `handoff_lost: ${registration}`;
      } catch (error) {
        if (error instanceof ShutdownError) throw error;
        handoffLost = `handoff_lost: ${describe(error)}`;
      }
      await lock.release();
    } else {
      const reason = notAcquired(result);
      handoffLost = reason.startsWith('handoff_lost') ? reason : `handoff_lost: ${reason}`;
    }
    logger.warn('Interactive handoff could not be claimed; acquiring a slot normally', { cardId, handoffLost });
  }

  // 2. Discover.
  const inventory = await discoverSlots(git, client, place);
  if (inventory.registrationError !== null)
    throw new Error(`Registrations of card ${cardId} could not be read: ${inventory.registrationError}`);
  const registered = inventory.slots.filter(
    (slot): slot is DiscoveredSlot & { registration: BranchInfo } => slot.registration !== null
  );
  const pids: number[] = [];
  for (const slot of registered) {
    const snapshot = await readSlotLockSnapshot(slotRoot, slot.ordinal);
    if (snapshot !== null && !('unreadable' in snapshot)) pids.push(...slotLockPids(snapshot));
  }
  const judge = await createSlotJudgeContext(pids, {
    timeoutMs: layer.judgeTimeoutMs,
    retryTimeoutMs: layer.judgeRetryTimeoutMs,
    ...(layer.lockEnvironment?.identity === undefined ? {} : { identity: layer.lockEnvironment.identity })
  });
  if (!judge.verified)
    logger.warn('This handler could not read its own process identity; its lock records an unverified owner', {
      cardId,
      reason: judge.unverifiedReason
    });

  // 3. Rank the free registered slots, newest first.
  const free = new Map<string, DiscoveredSlot & { registration: BranchInfo }>();
  const ranking: { branch: string; addedAt: string; lastUsedAt: string | null }[] = [];
  let judged = 0;
  for (const slot of registered) {
    if (layer.platform === 'darwin' && judged >= DARWIN_JUDGED_SLOT_CAP) break;
    const owner = slot.registration.legacyExecutionOwner;
    if (owner !== undefined) {
      const status = await client.getExecutionStatus(owner).catch((error: unknown) => describe(error));
      if (status === 'running') continue;
      if (status !== 'terminal' && status !== 'unknown') {
        skipped.push({ ordinal: slot.ordinal, reason: `legacy owner ${owner} status unreadable: ${status}` });
        continue;
      }
    }
    judged++;
    const state = await readSlotLock(slotRoot, slot.ordinal, {
      context: judge,
      ...(layer.lockEnvironment === undefined ? {} : { environment: layer.lockEnvironment })
    });
    if (state.state === 'held') continue;
    if (state.state === 'unknown') {
      skipped.push({ ordinal: slot.ordinal, reason: state.detail.reason });
      continue;
    }
    free.set(slot.branch, slot);
    const snapshot = state.snapshot;
    ranking.push({
      branch: slot.branch,
      addedAt: slot.registration.addedAt,
      lastUsedAt: snapshot === null ? null : (snapshot.released?.releasedAt ?? snapshot.owner.createdAt)
    });
  }
  const ranked = rankWorktreeSlots(cardId, ranking).map((entry) => free.get(entry.branch)!);

  // 3. Reuse the most recently used free checkout that is still registered and usable.
  const vacated = new Set<number>();
  for (const slot of ranked.filter((candidate) => candidate.directoryExists)) {
    const held = await underLock(slot.ordinal, slot.path, slot.residue, judge, async () => {
      // Recovery may have rolled back the checkout of an interrupted creation: reattach it below.
      if (!(await pathExists(slot.path))) {
        vacated.add(slot.ordinal);
        return null;
      }
      const registration = await registrationOf(slot.branch);
      if (registration === null || (registration.worktree ?? slot.path) !== slot.path) return null;
      const usability = await judgeUsability(git, repoRoot, slot.path, slot.branch);
      if (usability.status === 'usable') return registration;
      logger.info('Slot skipped', { cardId, ordinal: slot.ordinal, reason: usability.status, ...usability });
      return null;
    });
    if (held !== null)
      return settle(
        held.lock,
        {
          ordinal: slot.ordinal,
          branch: slot.branch,
          worktreePath: slot.path,
          parentBranch: held.value.parentBranch
        },
        'reused'
      );
  }

  // 4. Reattach a free slot whose checkout is gone and whose ref remains; failing that, recreate one whose ref is gone.
  for (const op of ['reattach', 'recreate'] as const) {
    for (const slot of ranked.filter((candidate) => !candidate.directoryExists || vacated.has(candidate.ordinal))) {
      const held = await underLock(slot.ordinal, slot.path, slot.residue, judge, async (lock) => {
        const registration = await registrationOf(slot.branch);
        if (registration === null || (registration.worktree ?? slot.path) !== slot.path) return null;
        if (await pathExists(slot.path)) return null;
        const oid = await refOid(git, repoRoot, slot.branch);
        if ((op === 'reattach') !== (oid !== null)) return null;
        const entries = await listWorktreeEntries(git, repoRoot);
        for (const entry of entries) {
          if (entry.branchRef === `refs/heads/${slot.branch}` && !(await samePath(entry.path, slot.path))) return null;
        }
        let createdOid: string | null = null;
        if (op === 'recreate') {
          createdOid = await refOid(git, repoRoot, registration.parentBranch);
          if (createdOid === null) return null;
        }
        await materialize(
          lock,
          { version: 1, op, branch: slot.branch, path: slot.path, createdOid, registeredBefore: true },
          registration.parentBranch
        );
        return registration;
      });
      if (held !== null)
        return settle(
          held.lock,
          {
            ordinal: slot.ordinal,
            branch: slot.branch,
            worktreePath: slot.path,
            parentBranch: held.value.parentBranch
          },
          op === 'reattach' ? 'reattached' : 'recreated'
        );
    }
  }

  // 5. Create the next ordinal [R6].
  const { parentBranch } = await client.getCard(cardId);
  if (typeof parentBranch !== 'string' || parentBranch === '')
    throw new Error(`Card ${cardId} has no parent branch to create a slot from`);
  let ordinal = inventory.highestOrdinal;
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    ordinal++;
    const branch = slotBranch(cardId, ordinal);
    const path = join(slotRoot, String(ordinal));
    if (slotOrdinal(cardId, branch) === null) break;
    if (await pathExists(path)) {
      // Never written into: a directory at the target path is reported and its ordinal skipped [R13].
      const quarantine = inventory.slots.find((slot) => slot.ordinal === ordinal)?.residue ?? [];
      logger.warn('Slot path already exists; skipping its ordinal', {
        cardId,
        ordinal,
        path,
        reason: quarantine.length > 0 ? 'quarantine_stranded' : 'unusable_checkout',
        ...(quarantine.length > 0 ? { quarantine } : {})
      });
      continue;
    }
    const result = await acquireSlotLock(slotRoot, ordinal, { ...lockOptions, context: judge });
    if (result.status === 'unavailable') skipped.push({ ordinal, reason: `lock_unavailable: ${result.detail}` });
    if (result.status !== 'acquired') continue;
    const { lock, previous } = result;
    try {
      const created = await lock.operation(`create of slot ${ordinal}`, async () => {
        await recoverPrevious(lock, previous, path, []);
        if ((await pathExists(path)) || (await registrationOf(branch)) !== null) return false;
        const parentOid = await refOid(git, repoRoot, parentBranch);
        if (parentOid === null) throw new Error(`Parent branch ${parentBranch} of card ${cardId} does not exist`);
        await materialize(
          lock,
          { version: 1, op: 'create', branch, path, createdOid: parentOid, registeredBefore: false },
          parentBranch,
          () => registerSlot(client, cardId, { branch, worktreePath: path, parentBranch })
        );
        return true;
      });
      if (created) return settle(lock, { ordinal, branch, worktreePath: path, parentBranch }, 'created');
    } catch (error) {
      if (error instanceof ShutdownError) throw error;
      if (!(error instanceof RefRefusedError)) {
        // Rolled back in process, or its intent stays for the next holder: either way the ordinal is free again.
        await lock.release();
        throw error;
      }
      logger.info('Slot ref already exists; reserving its ordinal', { cardId, ordinal, detail: error.message });
    }
    await lock.release();
  }
  throw new Error(`No slot could be created for card ${cardId} after ${CREATE_ATTEMPTS} ordinals`);
}

/** `update-ref` refused to create a slot ref that already exists. */
class RefRefusedError extends Error {
  /**
   * Names the refused ref.
   * @param branch - Slot branch.
   * @param stderr - Git's refusal.
   */
  constructor(branch: string, stderr: string) {
    super(`refs/heads/${branch} already exists${stderr === '' ? '' : `: ${stderr}`}`);
    this.name = 'RefRefusedError';
  }
}

/**
 * Formats an error for a log field.
 * @param error - Anything thrown.
 * @returns Its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `worktreeMaintenance` root command against real repositories and real
 * slot locks: each mode's report, the deletion verdict, the command's own
 * execution owning the pass's `removal` locks, a report on a failed pass, and
 * the settings build emitting the command.
 *
 * @summary Worktree maintenance root command tests
 * @module
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commandReportPayloadSchema,
  Logger,
  type WorktreeCleanupPreview,
  worktreeCleanupPreviewSchema
} from '@cards.management/sdk';
import type { CardsClient } from '@cards.management/sdk/client';
import type { WorktreeMaintenanceInput } from '@cards.management/sdk/config';
import { build } from '@cards.management/sdk/config/cli';
import { readSlotLockSnapshot } from '@cards.management/sdk/slot-lock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateAntigravityEntry } from '../scripts/generate-antigravity-entry.mjs';
import { generateOpencodeEntry } from '../scripts/generate-opencode-entry.mjs';
import settingsConfig from '../settings.config.js';
import { type AcquiredSlot, acquireSlot } from '../src/lib/worktrees/index.js';
import worktreeMaintenance, { createWorktreeMaintenance } from '../src/worktree-maintenance.js';
import { createSlotFixture, type SlotFixture } from './helpers/slot-fixture.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

let fx: SlotFixture;

beforeEach(async () => {
  fx = await createSlotFixture();
});

afterEach(async () => {
  await fx.dispose();
});

/**
 * Acquires a slot for one execution.
 * @param executionId - The acquiring execution.
 * @returns The held slot.
 */
function acquire(executionId: string): Promise<AcquiredSlot> {
  return acquireSlot(fx.input(executionId), { client: fx.client, logger: new Logger(), layer: fx.layer });
}

/**
 * Creates one slot per entry, all held at once so each gets its own ordinal,
 * then releases them, as finished sessions leave them.
 * @param work - Per slot, whether to leave an unmerged commit on its branch.
 * @returns The released slots, in ordinal order.
 */
async function finishedSlots<const W extends readonly boolean[]>(
  ...work: W
): Promise<{ readonly [K in keyof W]: AcquiredSlot }> {
  const slots: AcquiredSlot[] = [];
  for (const [index, unmerged] of work.entries()) {
    const slot = await acquire(`exec-${index + 1}`);
    if (unmerged) await fx.git(['commit', '-q', '--allow-empty', '-m', 'work'], slot.worktreePath);
    slots.push(slot);
  }
  for (const slot of slots) await slot.lock.release();
  return slots as unknown as { readonly [K in keyof W]: AcquiredSlot };
}

/** One command run: what it reported, and how often. */
interface Run {
  readonly reports: readonly Record<string, unknown>[];
  readonly report: WorktreeCleanupPreview;
}

/**
 * Runs the command on the fixture's layer as the runtime would, collecting its reports.
 * @param mode - The maintenance mode.
 * @param executionId - The command's own execution.
 * @param budgetMs - The input's budget, as the launcher sets it.
 * @returns The reports, and the last one parsed as a caller parses it, with the SDK's strict preview schema.
 */
async function maintain(
  mode: WorktreeMaintenanceInput['mode'],
  executionId = 'exec-maintenance',
  budgetMs = 60_000
): Promise<Run> {
  const reports: Record<string, unknown>[] = [];
  const { extensionPath } = fx.input(executionId);
  await createWorktreeMaintenance({ layer: fx.layer })(
    { executionId, cardId: fx.cardId, mode, budgetMs, repoRoot: fx.repoRoot, cardRepoPath: fx.scratch, extensionPath },
    {
      logger: new Logger(),
      cwd: fx.repoRoot,
      // The command reaches the client only through the slot layer's registration and status calls.
      client: fx.client as unknown as CardsClient,
      report: (report) => {
        reports.push(commandReportPayloadSchema.parse(report));
      },
      onShutdown: () => () => {}
    }
  );
  const last = reports.at(-1);
  if (last === undefined) throw new Error('The command finished without a report');
  return { reports, report: worktreeCleanupPreviewSchema.parse(last) };
}

describe('worktreeMaintenance preview', () => {
  it('reports every slot without changing any, with the card deletable when all are eligible', async () => {
    const [slot] = await finishedSlots(false);

    const { reports, report } = await maintain('preview');

    expect(reports).toHaveLength(1);
    expect(report).toEqual({
      cardId: fx.cardId,
      canDeleteCard: true,
      decisions: [expect.objectContaining({ branch: slot.branch, reason: 'eligible', outcome: 'eligible' })],
      unknownLocks: { count: 0, unverifiedOwners: 0 },
      // The host's real processes decide how many the probe could not inspect.
      processesNotInspected: expect.any(Number),
      purge: { purged: 0, pending: 0, kept: [] }
    });
    expect(await fx.git(['branch', '--list', slot.branch])).not.toBe('');
    expect(fx.client.registrations.has(slot.branch)).toBe(true);
  });

  it('withholds deletion while a slot would be preserved', async () => {
    const [kept] = await finishedSlots(true);

    const { report } = await maintain('preview');

    expect(report.canDeleteCard).toBe(false);
    expect(report.decisions).toEqual([
      expect.objectContaining({ branch: kept.branch, reason: 'unmerged_commits', outcome: 'preserved' })
    ]);
  });

  it('spares no requester: a running execution’s slot is reported locked', async () => {
    const held = await acquire('exec-running');

    const { report } = await maintain('preview');

    expect(report.canDeleteCard).toBe(false);
    expect(report.decisions[0]).toMatchObject({ branch: held.branch, reason: 'locked', outcome: 'preserved' });
    expect(report.decisions[0]?.detail).toContain('exec-running');
  });
});

describe('worktreeMaintenance cleanup', () => {
  it('removes eligible slots, preserves the rest and withholds deletion for them', async () => {
    const [merged, kept] = await finishedSlots(false, true);

    const { report } = await maintain('cleanup');

    expect(report.canDeleteCard).toBe(false);
    expect(report.decisions).toEqual([
      expect.objectContaining({ branch: merged.branch, reason: 'eligible', outcome: 'removed' }),
      expect.objectContaining({ branch: kept.branch, reason: 'unmerged_commits', outcome: 'preserved' })
    ]);
    expect(await fx.git(['branch', '--list', merged.branch])).toBe('');
    expect(fx.client.registrations.has(merged.branch)).toBe(false);
    expect(fx.client.registrations.has(kept.branch)).toBe(true);
  });

  it('takes each removal lock as the command’s own execution', async () => {
    await finishedSlots(false);
    const owners: string[] = [];
    fx.beforeGit = async (args) => {
      if (args.includes('move')) {
        const snapshot = await readSlotLockSnapshot(fx.slotRoot, 1);
        if (snapshot !== null && !('unreadable' in snapshot)) owners.push(snapshot.owner.executionId);
      }
    };

    const { report } = await maintain('cleanup', 'exec-maintenance-7');

    expect(report.decisions[0]).toMatchObject({ outcome: 'removed' });
    expect(owners).toEqual(['exec-maintenance-7']);
  });

  it('stops starting slots once the input’s budget has run out', async () => {
    const [slot] = await finishedSlots(false);
    // Discovery runs git first, so a slot can only be started after this delay has spent the budget.
    fx.beforeGit = () => new Promise((resolve) => setTimeout(resolve, 50));

    const { report } = await maintain('cleanup', 'exec-maintenance', 20);

    expect(report.decisions).toEqual([
      expect.objectContaining({
        branch: slot.branch,
        reason: 'budget_exhausted',
        outcome: 'preserved',
        detail: expect.stringContaining('the 20 ms budget')
      })
    ]);
    expect(report.canDeleteCard).toBe(false);
    expect(await fx.git(['branch', '--list', slot.branch])).not.toBe('');
  });
});

describe('worktreeMaintenance prepare-delete', () => {
  it('removes every slot and clears the card for deletion', async () => {
    const [first, second] = await finishedSlots(false, false);

    const { report } = await maintain('prepare-delete');

    expect(report.canDeleteCard).toBe(true);
    expect(report.decisions.map((decision) => decision.outcome)).toEqual(['removed', 'removed']);
    expect(fx.client.registrations.has(first.branch)).toBe(false);
    expect(fx.client.registrations.has(second.branch)).toBe(false);
  });

  it('clears a card without slots', async () => {
    const { report } = await maintain('prepare-delete');

    expect(report).toEqual({
      cardId: fx.cardId,
      canDeleteCard: true,
      decisions: [],
      unknownLocks: { count: 0, unverifiedOwners: 0 },
      // No slot, so no probe ran.
      processesNotInspected: 0,
      purge: { purged: 0, pending: 0, kept: [] }
    });
  });

  it('refuses deletion while any slot is preserved', async () => {
    await finishedSlots(true);

    const { report } = await maintain('prepare-delete');

    expect(report.canDeleteCard).toBe(false);
    expect(report.decisions[0]).toMatchObject({ reason: 'unmerged_commits', outcome: 'preserved' });
  });
});

describe('worktreeMaintenance failures', () => {
  it('reports a pass that stopped outside any slot, with its failure and no deletion', async () => {
    await finishedSlots(false);
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') throw new Error('injected discovery failure');
    };

    for (const mode of ['preview', 'cleanup', 'prepare-delete'] as const) {
      const { reports, report } = await maintain(mode);

      expect(reports).toHaveLength(1);
      expect(report.canDeleteCard).toBe(false);
      expect(report.failure).toMatchObject({ stage: 'discovery' });
      expect(report.failure?.message).toContain('injected discovery failure');
    }
  });
});

describe('worktreeMaintenance report contract', () => {
  it('sends reports the SDK preview schema accepts unchanged, for kept, removed and locked slots', async () => {
    const held = await acquire('exec-held');
    const [, kept] = await finishedSlots(false, true);

    const { reports } = await maintain('cleanup');

    const parsed = worktreeCleanupPreviewSchema.safeParse(reports[0]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(reports[0]);
    expect(parsed.data?.decisions.map((decision) => [decision.reason, decision.outcome])).toEqual([
      ['locked', 'preserved'],
      ['eligible', 'removed'],
      ['unmerged_commits', 'preserved']
    ]);
    expect(parsed.data?.decisions[0]).toMatchObject({ branch: held.branch });
    expect(parsed.data?.decisions[2]).toMatchObject({ branch: kept.branch });
    await held.lock.release();
  });

  it('sends a failed pass’s report, failure included, that the SDK preview schema accepts unchanged', async () => {
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') throw new Error('injected discovery failure');
    };

    const { reports } = await maintain('prepare-delete');

    const parsed = worktreeCleanupPreviewSchema.safeParse(reports[0]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(reports[0]);
    expect(parsed.data?.failure).toMatchObject({ stage: 'discovery' });
  });
  it('refuses prepare-delete on an unknown lock with a report the SDK preview schema accepts', async () => {
    const held = await acquire('exec-held');
    const ownerPath = join(fx.slotRoot, '.locks', '1', String(held.lock.generation), 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { holder: Record<string, unknown> };
    owner.holder['startIdentity'] = null;
    await writeFile(ownerPath, JSON.stringify(owner));

    const { reports } = await maintain('prepare-delete');

    const parsed = worktreeCleanupPreviewSchema.safeParse(reports[0]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ canDeleteCard: false, unknownLocks: { count: 1, unverifiedOwners: 1 } });
    await held.lock.release();
  });
});

describe('worktreeMaintenance settings', () => {
  it('is the configuration’s root worktreeMaintenance command', () => {
    expect(settingsConfig.worktreeMaintenance).toBe(worktreeMaintenance);
    expect(worktreeMaintenance.factoryType).toBe('worktree-maintenance');
  });

  it('compiles into the settings’ worktreeMaintenance entry', async () => {
    // As scripts/build.mjs does: the build fails closed on a stream entrypoint that was never generated.
    generateOpencodeEntry(PACKAGE_ROOT);
    generateAntigravityEntry(PACKAGE_ROOT);
    const outdir = await mkdtemp(join(tmpdir(), 'maintenance-settings-'));
    try {
      const result = await build({
        config: join(PACKAGE_ROOT, 'settings.config.ts'),
        outdir,
        loaderFlags: ['.md=text']
      });

      if (!result.success) throw new Error(result.error);
      const settings = JSON.parse(await readFile(result.settingsPath, 'utf8')) as {
        worktreeMaintenance?: { command: { command: string } };
      };
      const bundle = result.compiledHandlers.find((path) => path.includes('worktree-maintenance'));
      expect(bundle).toBeDefined();
      expect(settings.worktreeMaintenance?.command.command).toContain(bundle?.split(/[\\/]/).at(-1));
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  }, 120_000);
});

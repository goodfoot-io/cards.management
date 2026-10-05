/**
 * `openSlotSession` against real locks and real child processes: the agent is
 * spawned and recorded inside one operation, the switch latch suppresses
 * release and cleanup, and the start and end passes never reject.
 *
 * @summary Provider slot session acceptance tests
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Logger } from '@cards.management/sdk';
import { readSlotLockSnapshot, ShutdownError } from '@cards.management/sdk/slot-lock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSlot, openSlotSession, type SlotSession } from '../src/lib/worktrees/index.js';
import { abandonSlotLock, createSlotFixture, type SlotFixture } from './helpers/slot-fixture.js';

let fx: SlotFixture;
const children: ChildProcess[] = [];

beforeEach(async () => {
  fx = await createSlotFixture();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await fx.dispose();
});

/**
 * Opens a session for one execution.
 * @param executionId - Execution acquiring the slot.
 * @returns A session holding a slot's `work` lock.
 */
function open(executionId: string): Promise<SlotSession> {
  return openSlotSession(fx.input(executionId), { client: fx.client, logger: new Logger(), layer: fx.layer });
}

/**
 * Spawns a long-lived stand-in agent this test owns.
 * @returns The child.
 */
function agent(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/**
 * Reads the session slot's current generation.
 * @param session - Session whose slot is read.
 * @returns Every file of the slot's newest generation.
 * @throws When the slot has no readable generation.
 */
async function snapshotOf(session: SlotSession) {
  const snapshot = await readSlotLockSnapshot(fx.slotRoot, session.slot.ordinal);
  if (snapshot === null || 'unreadable' in snapshot) throw new Error('No readable generation');
  return snapshot;
}

describe('openSlotSession', () => {
  it('spawns the agent and records it as a companion in one operation', async () => {
    const session = await open('exec-1');

    const child = await session.spawnAgent(agent);

    expect((await snapshotOf(session)).companions.map((companion) => companion.pid)).toContain(child.pid);
  });

  it('spawns nothing once the shutdown fence has closed', async () => {
    const session = await open('exec-1');
    let spawned = false;
    void fx.shutdown.shutdownAndExit(0, 'cancel');

    await expect(
      session.spawnAgent(() => {
        spawned = true;
        return agent();
      })
    ).rejects.toBeInstanceOf(ShutdownError);
    expect(spawned).toBe(false);
  });

  it('offers a handoff that sets the switch latch and names the slot', async () => {
    const session = await open('exec-1');

    const handoff = await session.offerHandoff('session-1');

    expect(session.switched).toBe(true);
    expect(handoff).toMatchObject({
      sessionId: 'session-1',
      slot: {
        ordinal: session.slot.ordinal,
        branch: session.slot.branch,
        worktreePath: session.slot.worktreePath,
        generation: session.slot.lock.generation
      }
    });
    expect((await snapshotOf(session)).handoff?.token).toBe(handoff.slot.token);
  });

  it('never writes released.json after a switch, from provider code or the shutdown hook', async () => {
    const session = await open('exec-1');
    await session.offerHandoff('session-1');

    expect(await session.slot.lock.release()).toBe(false);
    await fx.shutdown.shutdownAndExit(0, 'switch');

    expect((await snapshotOf(session)).released).toBeNull();
  });

  it('releases through the shutdown hook when no operation is in flight and no switch happened', async () => {
    const session = await open('exec-1');

    await fx.shutdown.shutdownAndExit(0, 'completed');

    expect((await snapshotOf(session)).released).not.toBeNull();
  });

  it('skips the end pass when the session was switched', async () => {
    const session = await open('exec-1');
    session.beginCleanup();
    await session.offerHandoff('session-1');

    expect(await session.finish()).toBeNull();
  });

  it('runs the end pass sparing its own slot', async () => {
    const session = await open('exec-1');
    session.beginCleanup();

    const result = await session.finish();

    expect(result?.decisions.find((decision) => decision.branch === session.slot.branch)).toMatchObject({
      reason: 'requester_slot',
      outcome: 'preserved'
    });
  });

  it('never rejects from the start or end pass when discovery fails', async () => {
    const session = await open('exec-1');
    fx.beforeGit = async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') throw new Error('injected discovery failure');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      session.beginCleanup();
      const result = await session.finish();

      expect(result?.failure).toMatchObject({ stage: 'discovery' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('removes the merged sibling a killed interactive session left, in the start pass', async () => {
    const sibling = await acquireSlot(fx.input('exec-killed'), {
      client: fx.client,
      logger: new Logger(),
      layer: fx.layer
    });
    const session = await open('exec-1');
    // The interactive session was killed without any end-of-session code running.
    await abandonSlotLock(sibling.lock);

    session.beginCleanup();
    await session.finish();

    expect(fx.client.registrations.has(sibling.branch)).toBe(false);
    expect(fx.client.registrations.has(session.slot.branch)).toBe(true);
    expect(session.slot.worktreePath).toBe(join(fx.slotRoot, '2'));
  });
});

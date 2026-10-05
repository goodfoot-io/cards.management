/**
 * The slot lifecycle across real handler processes: a handler killed at each
 * step of a create leaves nothing a start pass and `prepare-delete` cannot
 * settle; the wrapper's `SIGTERM` burst during a reattach never frees the slot
 * while the dying handler's group lives and never lets git start after the
 * fence; a burst before the agent spawn spawns nothing; and the slot layer's
 * shutdown hook runs before the runtime's other hooks and the exit.
 *
 * Each handler is a detached `tsx` child (see `helpers/slot-handler.ts`), so it
 * leads its own process group the way the wrapper's action group does. Only
 * that recorded group is ever signalled.
 *
 * @summary Slot kill, shutdown-race and hook-order tests over real handler processes
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Logger } from '@cards.management/sdk';
import { resolveSlotRoot } from '@cards.management/sdk/cards-config';
import { createShutdownCoordinator, type ShutdownCoordinator } from '@cards.management/sdk/config';
import { readSlotLock, readSlotLockSnapshot } from '@cards.management/sdk/slot-lock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireSlot, cleanupCardSlots, openSlotSession } from '../src/lib/worktrees/index.js';
import {
  createFixtureLayer,
  createSlotFixture,
  FakeSlotClient,
  FIXTURE_GIT_ENV,
  type SlotFixture
} from './helpers/slot-fixture.js';
import type { SlotHandlerConfig, SlotHandlerEvent, SlotHandlerStop } from './helpers/slot-handler.js';

/** `--import=<file URL of the tsx loader>`, valid from any working directory. */
const TSX_IMPORT = `--import=${pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href}`;
const HANDLER_SCRIPT = fileURLToPath(new URL('./helpers/slot-handler.ts', import.meta.url));

/** The wrapper's stop loop: a group `SIGTERM` every 25 ms, then `SIGKILL` at 5 s. */
const BURST_INTERVAL_MS = 25;
const BURST_FORCE_MS = 5_000;

let fx: SlotFixture;
const handlers: RunningHandler[] = [];

beforeEach(async () => {
  fx = await createSlotFixture();
});

afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.killGroup();
  await fx.dispose();
});

/** A handler process the test spawned, and the process group it leads. */
interface RunningHandler {
  readonly child: ChildProcess;
  /** The group id recorded at spawn: the detached child's own PID. */
  readonly pgid: number;
  /** Settles with the child's exit code and signal. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  /** Everything the handler wrote to stderr. */
  readonly stderr: () => string;
  /**
   * Reads the handler's event log.
   * @returns Its events, in order.
   */
  events(): Promise<SlotHandlerEvent[]>;
  /**
   * Waits until the handler logged an event matching the predicate.
   * @param match - Event predicate.
   * @param timeoutMs - Failure deadline.
   * @returns The event.
   */
  waitFor(match: (event: SlotHandlerEvent) => boolean, timeoutMs?: number): Promise<SlotHandlerEvent>;
  /**
   * Signals the recorded group; a group that is already gone is not an error.
   * @param signal - Signal to send.
   */
  signalGroup(signal: NodeJS.Signals): void;
  /** Whether any member of the recorded group is still alive. */
  groupAlive(): boolean;
  /** Sends `SIGKILL` to the group and waits until it is gone. */
  killGroup(): Promise<void>;
}

/**
 * Polls until a condition holds.
 * @param condition - Checked every 20 ms.
 * @param what - Named in the timeout error.
 * @param timeoutMs - Failure deadline.
 * @throws When the condition does not hold within the deadline.
 */
async function waitUntil(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Spawns a handler process for one execution of the fixture's card.
 * @param executionId - Execution whose event log and lock owner the handler writes.
 * @param stopAt - Where it parks; null runs it to completion.
 * @returns Its process, recorded group, exit and event-log readers.
 * @throws When the child has no PID to record as its group.
 */
function startHandler(executionId: string, stopAt: SlotHandlerStop | null): RunningHandler {
  const eventsPath = join(fx.scratch, `${executionId}.events`);
  const config: SlotHandlerConfig = {
    scratch: fx.scratch,
    repoRoot: fx.repoRoot,
    cardId: fx.cardId,
    executionId,
    stopAt,
    eventsPath
  };
  const child = spawn(process.execPath, [TSX_IMPORT, HANDLER_SCRIPT], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ...FIXTURE_GIT_ENV,
      SLOT_HANDLER_CONFIG: JSON.stringify(config),
      SLOT_HANDLER_EVENTS: eventsPath
    }
  });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error('The handler has no PID');
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  );
  const events = async (): Promise<SlotHandlerEvent[]> => {
    const text = await readFile(eventsPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as SlotHandlerEvent);
  };
  const signalGroup = (signal: NodeJS.Signals | 0): void => {
    // Only the group recorded at spawn, which this detached child leads.
    if (!(pgid > 1) || pgid !== child.pid) throw new Error(`Refusing to signal unrecorded group ${pgid}`);
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const groupAlive = (): boolean => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const handler: RunningHandler = {
    child,
    pgid,
    exited,
    stderr: () => stderr,
    events,
    async waitFor(match, timeoutMs = 30_000) {
      let found: SlotHandlerEvent | undefined;
      await waitUntil(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Handler exited early (${child.exitCode ?? child.signalCode}): ${stderr}`);
          found = (await events()).find(match);
          return found !== undefined;
        },
        'a handler event',
        timeoutMs
      );
      return found as SlotHandlerEvent;
    },
    signalGroup,
    groupAlive,
    async killGroup() {
      signalGroup('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await exited;
      await waitUntil(() => !groupAlive(), `group ${pgid} to be gone`);
    }
  };
  handlers.push(handler);
  return handler;
}

/**
 * Sends the wrapper's stop burst to a handler's group until it and its group are gone.
 * @param handler - The handler to stop.
 * @returns When the group is gone.
 */
async function stopLikeTheWrapper(handler: RunningHandler): Promise<void> {
  handler.signalGroup('SIGTERM');
  const burst = setInterval(() => handler.signalGroup('SIGTERM'), BURST_INTERVAL_MS);
  const force = setTimeout(() => handler.signalGroup('SIGKILL'), BURST_FORCE_MS);
  try {
    await handler.exited;
    await waitUntil(() => !handler.groupAlive(), `group ${handler.pgid} to be gone`);
  } finally {
    clearInterval(burst);
    clearTimeout(force);
  }
}

/**
 * Installs a `post-checkout` hook that logs the handler's stop and blocks, so
 * `worktree add` is in flight when the test acts.
 */
async function blockWorktreeAdd(): Promise<void> {
  const hook = join(fx.repoRoot, '.git', 'hooks', 'post-checkout');
  await writeFile(
    hook,
    `#!/bin/sh\nprintf '%s\\n' '{"event":"stopped","step":"worktree-add"}' >> "$SLOT_HANDLER_EVENTS"\nexec sleep 600\n`
  );
  await chmod(hook, 0o755);
}

/** Removes the blocking hook. */
async function unblockWorktreeAdd(): Promise<void> {
  await rm(join(fx.repoRoot, '.git', 'hooks', 'post-checkout'), { force: true });
}

/**
 * Whether a path exists.
 * @param path - Path to test.
 * @returns True when it exists.
 */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

/**
 * Reads a branch's oid.
 * @param branch - Short branch name.
 * @returns The oid, or null when the ref does not exist.
 */
async function oidOf(branch: string): Promise<string | null> {
  return fx.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => null);
}

/**
 * Lists the paths of git's worktree entries.
 * @returns Every entry path, the main checkout included.
 */
async function worktreePaths(): Promise<string[]> {
  return (await fx.git(['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

describe('a handler killed at each create step', () => {
  const steps: readonly { readonly name: string; readonly stop: SlotHandlerStop | 'worktree-add' }[] = [
    { name: 'after the intent write', stop: 'intent' },
    { name: 'after update-ref', stop: 'update-ref' },
    { name: 'during worktree add', stop: 'worktree-add' },
    { name: 'during provisioning', stop: 'provision' },
    { name: 'before addBranch', stop: 'add-branch' }
  ];

  for (const { name, stop } of steps) {
    it(`leaves nothing after a SIGKILL ${name}`, async () => {
      if (stop === 'worktree-add') await blockWorktreeAdd();
      const handler = startHandler('exec-killed', stop === 'worktree-add' ? null : stop);
      await handler.waitFor((event) => event.event === 'stopped' && event.step === stop);

      await handler.killGroup();
      await unblockWorktreeAdd();
      await fx.client.reload();

      const startPass = await cleanupCardSlots(
        { ...fx.cleanupContext(), executionId: 'exec-next' },
        { requester: 'exec-next', mode: 'cleanup' }
      );
      expect(startPass.failure).toBeUndefined();
      expect(startPass.decisions.filter((decision) => decision.outcome === 'failed')).toEqual([]);
      const deletion = await cleanupCardSlots(fx.cleanupContext(), { requester: null, mode: 'prepare-delete' });

      expect(deletion.ok).toBe(true);
      expect(await oidOf('cards/card-1/1')).toBeNull();
      expect(await worktreePaths()).toEqual([fx.repoRoot]);
      expect(await exists(join(fx.slotRoot, '1'))).toBe(false);
      expect(fx.client.registrations.size).toBe(0);
    });
  }

  // TODO(S2): unskip once the SDK's verified removal merges; the finished slot is removed as eligible.
  it.skip('removes the complete clean slot after a SIGKILL between addBranch and the intent clear', async () => {
    const handler = startHandler('exec-killed', 'after-add-branch');
    await handler.waitFor((event) => event.event === 'stopped' && event.step === 'after-add-branch');

    await handler.killGroup();
    await fx.client.reload();
    const deletion = await cleanupCardSlots(fx.cleanupContext(), { requester: null, mode: 'prepare-delete' });

    expect(deletion.ok).toBe(true);
    expect(deletion.decisions).toMatchObject([{ reason: 'eligible', outcome: 'removed' }]);
    expect(await oidOf('cards/card-1/1')).toBeNull();
    expect(await exists(join(fx.slotRoot, '1'))).toBe(false);
    expect(fx.client.registrations.size).toBe(0);
  });
});

describe('the wrapper stop burst racing a competing launch', () => {
  it('keeps a reattaching slot held until the dying group is gone, then the competitor recovers it', async () => {
    const original = await acquireSlot(fx.input('exec-1'), {
      client: fx.client,
      logger: new Logger(),
      layer: fx.layer
    });
    await original.lock.release();
    await fx.git(['worktree', 'remove', '--force', original.worktreePath]);
    const oid = await oidOf(original.branch);
    await blockWorktreeAdd();
    const dying = startHandler('exec-dying', null);
    await dying.waitFor((event) => event.event === 'stopped' && event.step === 'worktree-add');

    const freedWhileAlive: string[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const state = await readSlotLock(fx.slotRoot, original.ordinal);
        if (state.state === 'free' && dying.groupAlive()) freedWhileAlive.push(new Date().toISOString());
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    await stopLikeTheWrapper(dying);
    polling = false;
    await poller;
    await unblockWorktreeAdd();

    expect(freedWhileAlive).toEqual([]);
    const events = await dying.events();
    expect(events).toContainEqual({ event: 'fence' });
    expect(events.filter((event) => event.event === 'git' && event.fencedAtCall && !event.refused)).toEqual([]);
    const left = await readSlotLockSnapshot(fx.slotRoot, original.ordinal);
    if (left === null || 'unreadable' in left) throw new Error('No readable generation');
    expect(left.owner.executionId).toBe('exec-dying');
    expect(left.released).toBeNull();
    expect(left.creating).toMatchObject({ op: 'reattach', branch: original.branch });

    await fx.client.reload();
    const next = await acquireSlot(fx.input('exec-2'), { client: fx.client, logger: new Logger(), layer: fx.layer });

    expect(next).toMatchObject({ ordinal: original.ordinal, outcome: 'reattached' });
    expect(await fx.git(['symbolic-ref', 'HEAD'], next.worktreePath)).toBe(`refs/heads/${original.branch}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await oidOf(original.branch)).toBe(oid);
    expect(await exists(next.worktreePath)).toBe(true);
    await next.lock.release();
  });

  it('spawns no agent when the burst lands between the slot acquisition and the spawn', async () => {
    const dying = startHandler('exec-dying', 'before-spawn');
    const acquired = await dying.waitFor((event) => event.event === 'acquired');
    await dying.waitFor((event) => event.event === 'stopped' && event.step === 'before-spawn');

    await stopLikeTheWrapper(dying);

    const events = await dying.events();
    expect(events).toContainEqual({ event: 'spawn-refused' });
    expect(events.filter((event) => event.event === 'spawned')).toEqual([]);
    await fx.client.reload();
    const next = await acquireSlot(fx.input('exec-2'), { client: fx.client, logger: new Logger(), layer: fx.layer });
    expect(next.ordinal).toBe(acquired.event === 'acquired' ? acquired.ordinal : -1);
    expect(next.outcome).toBe('reused');
    await next.lock.release();
  });

  // TODO(S2): the burst during an end pass's removal, after quarantine and before `update-ref -d`, needs the SDK's verified removal.
  it.skip('keeps a slot under removal held until the dying group is gone', () => {});
});

describe('shutdown hook order', () => {
  it('runs the slot hook before the runtime hooks registered earlier and before the exit on SIGTERM', async () => {
    const handler = startHandler('exec-order', 'after-spawn');
    await handler.waitFor((event) => event.event === 'stopped' && event.step === 'after-spawn');

    handler.signalGroup('SIGTERM');
    const { code } = await handler.exited;

    expect(code).toBe(143);
    expect(await handler.events()).toContainEqual({ event: 'runtime-hook', released: true });
  });

  it('runs the slot hook before the runtime hooks registered earlier and before the exit on a switch', async () => {
    const order: string[] = [];
    const base = createShutdownCoordinator({ exit: () => order.push('exit') });
    const shutdown: ShutdownCoordinator = {
      ...base,
      signal: base.signal,
      register: (hook) =>
        base.register(async (reason) => {
          await hook(reason);
          order.push('slot');
        })
    };
    base.register(async () => {
      order.push('runtime');
    });
    const layer = {
      ...createFixtureLayer(fx.scratch, { beforeGit: null, beforeProvision: null }, [], base),
      lockEnvironment: { shutdown }
    };
    const slot = await acquireSlot(fx.input('exec-1'), { client: fx.client, logger: new Logger(), layer });
    await slot.lock.offerHandoff();

    await base.shutdownAndExit(0, 'switch');

    expect(order).toEqual(['slot', 'runtime', 'exit']);
    const snapshot = await readSlotLockSnapshot(fx.slotRoot, slot.ordinal);
    if (snapshot === null || 'unreadable' in snapshot) throw new Error('No readable generation');
    expect(snapshot.released).toBeNull();
    expect(snapshot.handoff).not.toBeNull();
  });
});

/**
 * What the wrapper's cancel fixture (`packages/cards/server/test/runtime/wrapper/`)
 * leaves, as JSON at the path in `CARDS_SLOT_RACE_STATE`: the slot whose
 * creation the wrapper's stop cut off during `worktree add`.
 */
interface SlotRaceState {
  readonly repoRoot: string;
  readonly slotRoot: string;
  readonly cardId: string;
  readonly ordinal: number;
}

/**
 * Leaves the state the wrapper fixture leaves, with this package's handler:
 * a create cut off by the stop burst during `worktree add`.
 * @returns Path of a state file in the wrapper fixture's shape.
 */
async function leaveRaceState(): Promise<string> {
  await blockWorktreeAdd();
  const cancelled = startHandler('exec-cancelled', null);
  await cancelled.waitFor((event) => event.event === 'stopped' && event.step === 'worktree-add');
  await stopLikeTheWrapper(cancelled);
  await unblockWorktreeAdd();
  const statePath = join(fx.scratch, 'race-state.json');
  const state: SlotRaceState = { repoRoot: fx.repoRoot, slotRoot: fx.slotRoot, cardId: fx.cardId, ordinal: 1 };
  await writeFile(statePath, JSON.stringify(state));
  return statePath;
}

describe('recovery half of the wrapper cancel test', () => {
  it('completes the rollback a cancelled create left and never starts an agent in its partial checkout', async () => {
    const statePath = process.env['CARDS_SLOT_RACE_STATE'] ?? (await leaveRaceState());
    const state = JSON.parse(await readFile(statePath, 'utf8')) as SlotRaceState;
    // The slot root is `<worktrees root>/<repo id>/cards/<card>`; point this process at the same root.
    process.env['CARDS_WORKTREES_DIR'] = dirname(dirname(dirname(state.slotRoot)));
    expect(await resolveSlotRoot(state.repoRoot, state.cardId)).toBe(state.slotRoot);
    const branch = `cards/${state.cardId}/${state.ordinal}`;
    const partial = join(state.slotRoot, String(state.ordinal));

    const left = await readSlotLock(state.slotRoot, state.ordinal);
    expect(left.state).toBe('free');
    expect(left.snapshot?.released ?? null).toBeNull();
    expect(left.snapshot?.creating).toMatchObject({ op: 'create', branch });

    const client = new FakeSlotClient(state.cardId);
    const session = await openSlotSession(
      {
        executionId: 'exec-next',
        cardId: state.cardId,
        repoRoot: state.repoRoot,
        extensionPath: join(fx.scratch, 'extension')
      },
      { client, logger: new Logger(), layer: fx.layer }
    );
    // The unregistered partial slot is reserved, never reused; the new handler's start pass completes its rollback.
    expect(session.slot.outcome).toBe('created');
    expect(session.slot.worktreePath).not.toBe(partial);
    session.beginCleanup();
    const endPass = await session.finish();
    const recovered = await readSlotLockSnapshot(state.slotRoot, state.ordinal);
    if (recovered === null || 'unreadable' in recovered) throw new Error('No readable generation');

    expect(endPass?.failure).toBeUndefined();
    expect(await exists(partial)).toBe(false);
    expect(
      await fx.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], state.repoRoot).catch(() => null)
    ).toBeNull();
    expect(recovered.creating).toBeNull();
    expect(await fx.git(['symbolic-ref', 'HEAD'], session.slot.worktreePath)).toBe(`refs/heads/${session.slot.branch}`);
    await session.slot.lock.release();
  });
});

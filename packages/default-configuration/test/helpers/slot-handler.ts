/**
 * A coding-agent handler reduced to its slot lifecycle, run as its own process
 * by the handler-process tests: it installs the runtime's signal handlers,
 * opens a slot session against a fixture repository, spawns a stand-in agent
 * and completes. A configured stop point parks it mid-lifecycle so the test
 * can kill it or send the wrapper's `SIGTERM` burst. Everything it does is
 * appended to an event log the test reads.
 *
 * Configuration comes as JSON in `SLOT_HANDLER_CONFIG`; see
 * {@link SlotHandlerConfig}.
 *
 * @summary Child handler process for slot kill and shutdown tests
 * @module
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@cards.management/sdk';
import {
  installShutdownSignalHandlers,
  registerShutdownHook,
  ShutdownError,
  shutdownAndExit,
  shutdownSignal
} from '@cards.management/sdk/config';
import { readSlotLockSnapshot } from '@cards.management/sdk/slot-lock';
import { openSlotSession, type SlotSession } from '../../src/lib/worktrees/index.js';
import type { ProvisionSlotCheckoutOptions } from '../../src/lib/worktrees/seams.js';
import { createFixtureLayer, FakeSlotClient, type SlotLayerHooks } from './slot-fixture.js';

/** Where the handler parks. */
export type SlotHandlerStop =
  /** After the creation intent is written, before `update-ref`. */
  | 'intent'
  /** After `update-ref`, before `worktree add`. */
  | 'update-ref'
  /** Inside provisioning. */
  | 'provision'
  /** Before `addBranch` writes. */
  | 'add-branch'
  /** After `addBranch` wrote, before the intent is cleared. */
  | 'after-add-branch'
  /** After the session opened, until the shutdown fence closes; then it tries to spawn the agent. */
  | 'before-spawn'
  /** After the agent spawned. */
  | 'after-spawn';

/** What the handler runs. */
export interface SlotHandlerConfig {
  readonly scratch: string;
  readonly repoRoot: string;
  readonly cardId: string;
  readonly executionId: string;
  readonly stopAt: SlotHandlerStop | null;
  /** The event log, one JSON object per line. */
  readonly eventsPath: string;
}

/** One line of the handler's event log. */
export type SlotHandlerEvent =
  | { readonly event: 'stopped'; readonly step: string }
  | { readonly event: 'acquired'; readonly ordinal: number; readonly generation: number; readonly outcome: string }
  | {
      readonly event: 'git';
      readonly args: readonly string[];
      readonly fencedAtCall: boolean;
      readonly refused: boolean;
    }
  | { readonly event: 'fence' }
  | { readonly event: 'spawned'; readonly pid: number }
  | { readonly event: 'spawn-refused' }
  | { readonly event: 'runtime-hook'; readonly released: boolean }
  | { readonly event: 'completed' };

const config = JSON.parse(process.env['SLOT_HANDLER_CONFIG'] ?? '') as SlotHandlerConfig;

/**
 * Appends one event to the log, synchronously so it survives a kill right after.
 * @param event - What happened, as the test will read it.
 */
function log(event: SlotHandlerEvent): void {
  appendFileSync(config.eventsPath, `${JSON.stringify(event)}\n`);
}

/**
 * Parks the handler at a stop point until it is signalled or killed.
 * @param step - The stop point, logged so the test knows it was reached.
 * @returns Never.
 */
function park(step: string): Promise<never> {
  log({ event: 'stopped', step });
  setInterval(() => {}, 60_000);
  return new Promise<never>(() => {});
}

installShutdownSignalHandlers();
shutdownSignal.addEventListener('abort', () => log({ event: 'fence' }));

const client = new FakeSlotClient(config.cardId);
client.persistPath = join(config.scratch, 'registrations.json');
await client.reload();
if (config.stopAt === 'add-branch') client.beforeAddBranch = () => park('add-branch');
if (config.stopAt === 'after-add-branch') client.afterAddBranch = () => park('after-add-branch');

const hooks: SlotLayerHooks = {
  beforeGit: async (args) => {
    if (config.stopAt === 'intent' && args[0] === 'update-ref') await park('intent');
    if (config.stopAt === 'update-ref' && args[0] === 'worktree' && args[1] === 'add') await park('update-ref');
  },
  beforeProvision: config.stopAt === 'provision' ? () => park('provision') : null,
  afterGit: (args, call) => log({ event: 'git', args, ...call })
};
const provisioned: ProvisionSlotCheckoutOptions[] = [];
const layer = createFixtureLayer(config.scratch, hooks, provisioned);

let session: SlotSession | null = null;
// Registered before the slot layer's hook, so it runs after it: hooks run in reverse order.
registerShutdownHook(async () => {
  if (session === null) return;
  const snapshot = await readSlotLockSnapshot(session.slot.lock.slotRoot, session.slot.ordinal);
  log({
    event: 'runtime-hook',
    released: snapshot !== null && !('unreadable' in snapshot) && snapshot.released !== null
  });
});

session = await openSlotSession(
  {
    executionId: config.executionId,
    cardId: config.cardId,
    repoRoot: config.repoRoot,
    extensionPath: join(config.scratch, 'extension')
  },
  { client, logger: new Logger(), layer }
);
log({
  event: 'acquired',
  ordinal: session.slot.ordinal,
  generation: session.slot.lock.generation,
  outcome: session.slot.outcome
});

if (config.stopAt === 'before-spawn') {
  log({ event: 'stopped', step: 'before-spawn' });
  setInterval(() => {}, 60_000);
  await new Promise<void>((resolve) => shutdownSignal.addEventListener('abort', () => resolve()));
}

try {
  const agent = await session.spawnAgent(() =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  );
  log({ event: 'spawned', pid: agent.pid ?? -1 });
  if (config.stopAt === 'after-spawn') await park('after-spawn');
  agent.kill('SIGTERM');
} catch (error) {
  if (!(error instanceof ShutdownError)) throw error;
  log({ event: 'spawn-refused' });
  // The fence closed: the runtime's shutdown is already exiting the process.
  await new Promise<never>(() => {});
}
log({ event: 'completed' });
await shutdownAndExit(0, 'completed');

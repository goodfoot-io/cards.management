/**
 * The slot lifecycle as a provider sees it: acquire a slot, spawn the agent
 * inside the slot layer's `agent-spawn` operation, hand the slot to an
 * interactive successor on a switch, and finish. Providers never release the
 * lock; the shutdown hook does, and the switch latch suppresses it.
 *
 * @summary Provider-facing slot session: acquire, spawn, handoff, finish
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import type { ActionContext } from '@cards.management/sdk';
import {
  type AcquiredSlot,
  acquireSlot,
  type SlotActionInput,
  type SlotClient,
  type SlotHandoffData
} from './acquire.js';
import type { SlotCleanupResult } from './cleanup.js';
import type { SlotLayer } from './layer.js';

/** What the switch callback returns to the runtime for the successor. */
export interface SwitchToInteractiveData {
  readonly sessionId: string;
  readonly slot: SlotHandoffData;
}

/** A provider's held slot. */
export interface SlotSession {
  readonly slot: AcquiredSlot;
  /**
   * Spawns the agent and records it as a companion, as one slot operation, so
   * the spawn does not start once shutdown has begun and the lock is never
   * released between the spawn and its record [H1].
   * @param spawn - Starts the agent.
   * @returns The agent.
   * @throws {ShutdownError} When shutdown has begun, before anything is spawned.
   */
  spawnAgent(spawn: () => ChildProcess): Promise<ChildProcess>;
  /**
   * Sets the switch latch and writes the handoff the successor presents.
   * @param sessionId - Session the successor resumes.
   * @returns The switch-to-interactive data.
   */
  offerHandoff(sessionId: string): Promise<SwitchToInteractiveData>;
  /** Whether the session was switched to interactive. */
  readonly switched: boolean;
  /**
   * Starts the start pass over the card's other slots, concurrently with the
   * agent's start, with its failure handling attached at once. Its decisions
   * are logged and never change the action's outcome.
   */
  beginCleanup(): void;
  /**
   * Awaits the start pass, then runs the end pass sparing this slot unless
   * the session was switched. Never rejects, and never releases the lock.
   * @returns The end pass's result, or null when the switch latch skipped it.
   */
  finish(): Promise<SlotCleanupResult | null>;
}

/** Options of {@link openSlotSession}. */
export interface OpenSlotSessionOptions {
  readonly client: SlotClient;
  readonly logger: ActionContext['logger'];
  readonly layer?: SlotLayer;
}

/**
 * Acquires a slot for a provider session.
 * @param input - Action input naming the card, workspace and any handoff.
 * @param options - Client, logger and slot layer.
 * @returns The session holding the acquired slot's `work` lock.
 */
export async function openSlotSession(input: SlotActionInput, options: OpenSlotSessionOptions): Promise<SlotSession> {
  const slot = await acquireSlot(input, options);
  const { lock } = slot;
  const { logger } = options;
  let switched = false;
  return {
    slot,
    get switched() {
      return switched;
    },
    spawnAgent: (spawn) =>
      lock.operation('agent-spawn', async () => {
        const child = spawn();
        const recording = await lock.addCompanion(child, 'agent');
        if (recording.status === 'not_child')
          logger.warn('Agent not recorded on the slot lock: its parent is not this handler', {
            pid: child.pid,
            parentPid: recording.parentPid
          });
        return child;
      }),
    async offerHandoff(sessionId) {
      switched = true;
      const { generation, token } = await lock.offerHandoff();
      return {
        sessionId,
        slot: { ordinal: slot.ordinal, branch: slot.branch, worktreePath: slot.worktreePath, generation, token }
      };
    },
    beginCleanup() {
      throw new Error('Not Implemented');
    },
    async finish() {
      throw new Error('Not Implemented');
    }
  };
}

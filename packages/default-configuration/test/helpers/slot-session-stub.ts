/**
 * Stand-in for the slot layer in provider tests, which mock the filesystem
 * and process spawn and so cannot run real slot acquisition. The slot layer's
 * own tests use real repositories and real locks.
 *
 * @summary Provider-test stub of `openSlotSession`
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { vi } from 'vitest';
import type { SlotSession, SwitchToInteractiveData } from '../../src/lib/worktrees/index.js';

/** The slot every stubbed session holds unless a test overrides it. */
export const STUB_SLOT = {
  ordinal: 1,
  branch: 'cards/card-123/1',
  worktreePath: '/test/workspace/.worktrees/cards/card-123/1',
  parentBranch: 'main'
} as const;

let slot: { ordinal: number; branch: string; worktreePath: string; parentBranch: string } = { ...STUB_SLOT };

/**
 * Overrides the stubbed slot for the following sessions.
 * @param overrides - Fields replacing {@link STUB_SLOT}'s.
 */
export function useStubSlot(overrides: Partial<typeof slot>): void {
  slot = { ...STUB_SLOT, ...overrides };
}

/** Handoffs offered by stubbed sessions, newest last. */
export const offeredHandoffs: SwitchToInteractiveData[] = [];

/** Spawn and cleanup-pass calls of stubbed sessions, in order. */
export const slotSessionEvents: Array<'spawn' | 'beginCleanup' | 'finish'> = [];

/** `openSlotSession` stub: holds {@link STUB_SLOT}, spawns directly, and records handoffs. */
export const openSlotSessionStub = vi.fn(async (): Promise<SlotSession> => {
  let switched = false;
  const held = { ...slot };
  return {
    slot: { ...held, outcome: 'reused', skipped: [], handoffLost: null } as unknown as SlotSession['slot'],
    get switched() {
      return switched;
    },
    spawnAgent: async (spawn: () => ChildProcess) => {
      slotSessionEvents.push('spawn');
      return spawn();
    },
    offerHandoff: async (sessionId: string) => {
      switched = true;
      const handoff: SwitchToInteractiveData = {
        sessionId,
        slot: {
          ordinal: held.ordinal,
          branch: held.branch,
          worktreePath: held.worktreePath,
          generation: 1,
          token: 'stub'
        }
      };
      offeredHandoffs.push(handoff);
      return handoff;
    },
    beginCleanup: () => {
      slotSessionEvents.push('beginCleanup');
    },
    finish: async () => {
      slotSessionEvents.push('finish');
      return null;
    }
  };
});

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
import type {
  OpenSlotSessionOptions,
  SlotActionInput,
  SlotSession,
  SwitchToInteractiveData
} from '../../src/lib/worktrees/index.js';

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
export const openSlotSessionStub = vi.fn(
  async (_input: SlotActionInput, _options: OpenSlotSessionOptions): Promise<SlotSession> => {
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
  }
);

/**
 * Reads the card through the client the last stubbed session received, as
 * slot creation does, and reports the URL it requested. The server rejects a
 * card read that names no workspace, so the URL must carry `workspacePath`.
 * @returns The requested card URL.
 */
export async function slotClientCardUrl(): Promise<URL> {
  const options = openSlotSessionStub.mock.lastCall?.[1];
  if (options === undefined) throw new Error('openSlotSession was not called');
  const originalFetch = globalThis.fetch;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'card-123' }), { status: 200 }));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  try {
    await options.client.getCard('card-123');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const [url] = fetch.mock.calls[0] as unknown as [string];
  return new URL(url);
}

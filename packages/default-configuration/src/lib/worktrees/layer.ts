/**
 * The slot layer's outside dependencies in one value: git, the SDK seams, the
 * lock environment and the judgement budgets. Production uses the host's;
 * tests inject a shutdown fence, a runner and seams of their own.
 *
 * @summary Injectable dependencies of slot acquisition and cleanup
 * @module
 */

import { runGitBounded } from '@cards.management/sdk/bounded-git';
import type { SlotLockEnvironment } from '@cards.management/sdk/slot-lock';
import { defaultSlotSeams, type SlotSeams, slotSharedHooksDir } from './seams.js';
import { createSlotGit, type SlotGit } from './slot-git.js';

/** Dependencies of the slot layer. */
export interface SlotLayer {
  readonly git: SlotGit;
  readonly seams: SlotSeams;
  /** Overrides for the slot lock's environment; the host's when absent. */
  readonly lockEnvironment?: Partial<SlotLockEnvironment>;
  /** Shared hook dispatcher directory every slot checkout points at. */
  readonly sharedHooksDir: string;
  readonly platform: NodeJS.Platform;
  /** Budget of the first batched identity read of a pass. */
  readonly judgeTimeoutMs: number;
  /** Budget of its single retry. */
  readonly judgeRetryTimeoutMs: number;
}

/**
 * The host's slot layer: the process-wide bounded runner, the SDK seams and
 * the runtime's shutdown fence.
 * @returns The production layer.
 */
export function defaultSlotLayer(): SlotLayer {
  return {
    git: createSlotGit({ run: runGitBounded }),
    seams: defaultSlotSeams,
    sharedHooksDir: slotSharedHooksDir(),
    platform: process.platform,
    judgeTimeoutMs: 5_000,
    judgeRetryTimeoutMs: 10_000
  };
}

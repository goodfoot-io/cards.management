/**
 * Acceptance checks for the worktree maintenance report contract: the preview
 * default-configuration reports and the extension parses back out of an opaque
 * command report.
 *
 * @summary Checks the cleanup preview schema accepts reported shapes and rejects malformed ones
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  clearsCardDeletion,
  type WorktreeCleanupPreview,
  type WorktreeCleanupReason,
  worktreeCleanupPreviewSchema
} from '../../../src/protocol/index.js';

const PREVIEW = {
  cardId: 'main-1',
  canDeleteCard: false,
  decisions: [
    {
      branch: 'implement/main-1/slot-1',
      worktreePath: '/repo/.worktrees/slot-1',
      reason: 'creation_residue',
      detail: 'non-empty directory left by execution exec-1',
      outcome: 'preserved'
    },
    { branch: 'implement/main-1/slot-2', worktreePath: null, reason: 'missing', detail: '', outcome: 'eligible' }
  ],
  unknownLocks: { count: 2, unverifiedOwners: 1 },
  processesNotInspected: 5
} as const satisfies WorktreeCleanupPreview;

describe('worktreeCleanupPreviewSchema', () => {
  it('names exactly the WorktreeCleanupReason union in its decision reasons', () => {
    expectTypeOf<
      z.output<typeof worktreeCleanupPreviewSchema>['decisions'][number]['reason']
    >().toEqualTypeOf<WorktreeCleanupReason>();
  });

  it('accepts a preview with unknown locks and no failure', () => {
    expect(worktreeCleanupPreviewSchema.parse(PREVIEW)).toEqual(PREVIEW);
  });

  it.each(['discovery', 'self_probe'] as const)('accepts a %s stage failure', (stage) => {
    const preview = { ...PREVIEW, failure: { stage, message: 'probe failed' } };
    expect(worktreeCleanupPreviewSchema.parse(preview)).toEqual(preview);
  });

  it('accepts zero unknown locks and unverified owners equal to the count', () => {
    for (const unknownLocks of [
      { count: 0, unverifiedOwners: 0 },
      { count: 3, unverifiedOwners: 3 }
    ]) {
      expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, unknownLocks }).success).toBe(true);
    }
  });

  it('requires the unknown-lock summary', () => {
    const { unknownLocks: _omitted, ...withoutLocks } = PREVIEW;
    expect(worktreeCleanupPreviewSchema.safeParse(withoutLocks).success).toBe(false);
  });

  it.each([
    ['more unverified owners than locks', { count: 1, unverifiedOwners: 2 }],
    ['a negative count', { count: -1, unverifiedOwners: 0 }],
    ['a negative unverified count', { count: 1, unverifiedOwners: -1 }],
    ['a fractional count', { count: 1.5, unverifiedOwners: 0 }],
    ['an unsafe integer count', { count: Number.MAX_SAFE_INTEGER + 1, unverifiedOwners: 0 }],
    ['a missing unverified count', { count: 1 }],
    ['an extra field', { count: 1, unverifiedOwners: 0, stale: 1 }]
  ])('rejects unknown locks with %s', (_case, unknownLocks) => {
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, unknownLocks }).success).toBe(false);
  });

  it.each([
    ['an unknown stage', { stage: 'judgement', message: 'x' }],
    ['a missing message', { stage: 'discovery' }],
    ['null', null]
  ])('rejects a failure with %s', (_case, failure) => {
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, failure }).success).toBe(false);
  });

  it.each([
    ['an unknown reason', { reason: 'abandoned' }],
    ['an unknown outcome', { outcome: 'skipped' }],
    ['an undefined worktree path', { worktreePath: undefined }]
  ])('rejects a decision with %s', (_case, change) => {
    const decisions = [{ ...PREVIEW.decisions[0], ...change }];
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, decisions }).success).toBe(false);
  });

  describe('canDeleteCard coherence', () => {
    const CLEAR = {
      cardId: 'main-1',
      canDeleteCard: true,
      decisions: [
        {
          branch: 'cards/main-1/1',
          worktreePath: '/repo/cards/main-1/1',
          reason: 'eligible',
          detail: '',
          outcome: 'removed'
        },
        { branch: 'cards/main-1/2', worktreePath: null, reason: 'missing', detail: '', outcome: 'eligible' }
      ],
      unknownLocks: { count: 0, unverifiedOwners: 0 },
      // Uninspected processes never block, so a clear report may still count some.
      processesNotInspected: 3
    } as const satisfies WorktreeCleanupPreview;

    it('accepts a clear report that allows deletion, and the same report refusing it is rejected', () => {
      expect(clearsCardDeletion(CLEAR)).toBe(true);
      expect(worktreeCleanupPreviewSchema.parse(CLEAR)).toEqual(CLEAR);
      expect(worktreeCleanupPreviewSchema.safeParse({ ...CLEAR, canDeleteCard: false }).success).toBe(false);
    });

    it('accepts a report with no slots as clear', () => {
      expect(worktreeCleanupPreviewSchema.safeParse({ ...CLEAR, decisions: [] }).success).toBe(true);
    });

    const violations: readonly (readonly [
      string,
      Partial<Pick<WorktreeCleanupPreview, 'failure' | 'unknownLocks' | 'decisions'>>
    ])[] = [
      ['a stage failure', { failure: { stage: 'discovery', message: 'git failed' } }],
      ['an unknown lock', { unknownLocks: { count: 1, unverifiedOwners: 0 } }],
      ['an unknown lock with an unverified owner', { unknownLocks: { count: 1, unverifiedOwners: 1 } }],
      ...(['preserved', 'failed'] as const).map(
        (outcome) =>
          [
            `a ${outcome} slot`,
            { decisions: [...CLEAR.decisions, { ...CLEAR.decisions[0], reason: 'in_use', outcome }] }
          ] as const
      )
    ];

    it.each(violations)('rejects canDeleteCard true beside %s, and accepts it false', (_case, change) => {
      const report: WorktreeCleanupPreview = { ...CLEAR, ...change };
      expect(clearsCardDeletion(report)).toBe(false);
      expect(worktreeCleanupPreviewSchema.safeParse(report).success).toBe(false);
      expect(worktreeCleanupPreviewSchema.safeParse({ ...report, canDeleteCard: false }).success).toBe(true);
    });
  });

  it('rejects unknown top-level fields and an empty card ID', () => {
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, mode: 'cleanup' }).success).toBe(false);
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, processesNotInspected: -1 }).success).toBe(false);
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, processesNotInspected: 1.5 }).success).toBe(false);
    const { processesNotInspected: _omitted, ...withoutCount } = PREVIEW;
    expect(worktreeCleanupPreviewSchema.safeParse(withoutCount).success).toBe(false);
    expect(worktreeCleanupPreviewSchema.safeParse({ ...PREVIEW, cardId: '' }).success).toBe(false);
  });
});

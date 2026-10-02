/**
 * Preserves historical evidence while exposing bounded cleanup observations.
 * @summary Cleanup wire contract and root-release acceptance checks
 */
import { describe, expect, it } from 'vitest';
import {
  type BestEffortCleanupResultPayload,
  cleanupAllowsClaimRelease,
  cleanupResultPayloadSchema,
  launchOutcomePayloadSchema
} from '../../../src/protocol/types/runtime-messages.js';

const legacy = {
  terminalDecisionId: 'terminal:execution',
  observationId: 'observation',
  trigger: 'root-exit' as const,
  status: 'unknown' as const,
  finalization: 'incomplete' as const
};

function report(rootStatus: BestEffortCleanupResultPayload['rootStatus']): BestEffortCleanupResultPayload {
  return { ...legacy, cleanupMode: 'best-effort', status: 'survivors', rootStatus, survivorPids: [42] };
}

describe('bounded cleanup wire contract', () => {
  it.each(['drained', 'failed', 'unknown'] as const)('preserves %s historical serialized evidence', (status) => {
    const payload = { ...legacy, status, detail: 'historical evidence' };
    const parsed = cleanupResultPayloadSchema.parse(payload);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(payload));
    expect(parsed).not.toHaveProperty('cleanupMode');
    expect(cleanupAllowsClaimRelease(parsed)).toBe(status === 'drained');
  });

  it.each(['not-started', 'exited', 'live', 'unknown'] as const)('uses %s root evidence for release', (rootStatus) => {
    const parsed = cleanupResultPayloadSchema.parse(report(rootStatus));
    expect(cleanupAllowsClaimRelease(parsed)).toBe(rootStatus === 'not-started' || rootStatus === 'exited');
  });

  it('requires both the explicit mode and root observation on a current report', () => {
    const { rootStatus: _root, ...missingRoot } = report('exited');
    const { cleanupMode: _mode, ...missingMode } = report('exited');
    expect(cleanupResultPayloadSchema.safeParse(missingRoot).success).toBe(false);
    expect(cleanupResultPayloadSchema.safeParse(missingMode).success).toBe(false);
    expect(cleanupResultPayloadSchema.safeParse({ ...legacy, rootStatus: 'exited' }).success).toBe(false);
    expect(cleanupResultPayloadSchema.safeParse({ ...report('exited'), unexpected: true }).success).toBe(false);
  });

  it('bounds survivor diagnostics and refuses unsafe process identifiers', () => {
    expect(cleanupResultPayloadSchema.safeParse({ ...report('live'), survivorPids: Array(256).fill(42) }).success).toBe(
      true
    );
    expect(cleanupResultPayloadSchema.safeParse({ ...report('live'), survivorPids: Array(257).fill(42) }).success).toBe(
      false
    );
    for (const pid of [1, -42, 4.2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(cleanupResultPayloadSchema.safeParse({ ...report('live'), survivorPids: [pid] }).success).toBe(false);
    }
  });

  it('accepts observed Windows process identities and unchanged historical Job identities', () => {
    const identity = { processId: 42, bootId: 'windows', startedAtToken: 'creation-ticks' };
    for (const ownership of [{ kind: 'windows-process' }, { kind: 'windows-job', jobId: 'historical-job' }]) {
      const payload = {
        disposition: 'spawned',
        processIdentity: { ...identity, ownership },
        runtimeOwnerIdentity: { ...identity, processId: 43, ownership }
      };
      expect(launchOutcomePayloadSchema.parse(payload)).toEqual(payload);
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { ExecutionRef, OwnershipStamp } from '../../../src/protocol/types/runtime-identity.js';
import { compareOwnership, isAdmittedExecution } from '../../../src/protocol/types/runtime-identity.js';

/**
 * Exercises ownership fencing and execution identity in the types area through focused scenarios.
 * The cases pin generation to a monotonic fence rather than a liveness signal, so a resumed owner
 * with a higher generation wins while a stale connection is refused no matter how current its
 * payload looks, and an equal generation from a different owner fails closed.
 *
 * @summary Tests ownership generation staleness and execution identity in types
 */

const owner = (ownerId: string, generation: number): OwnershipStamp => ({ ownerId, generation });

describe('ownership generation fencing', () => {
  it('treats the first stamp as newer when no ownership is recorded', () => {
    expect(compareOwnership(owner('server-a', 1), undefined)).toBe('newer');
  });

  it('accepts a higher generation from the same owner', () => {
    expect(compareOwnership(owner('server-a', 4), owner('server-a', 3))).toBe('newer');
  });

  it('rejects a lower generation as stale', () => {
    expect(compareOwnership(owner('server-a', 2), owner('server-a', 3))).toBe('stale');
  });

  it('reports an identical stamp as same rather than newer', () => {
    expect(compareOwnership(owner('server-a', 3), owner('server-a', 3))).toBe('same');
  });

  it('lets a different owner bearing a higher generation take over', () => {
    expect(compareOwnership(owner('server-b', 4), owner('server-a', 3))).toBe('newer');
  });

  it('rejects a different owner bearing a lower generation as stale', () => {
    expect(compareOwnership(owner('server-b', 2), owner('server-a', 3))).toBe('stale');
  });

  it('fails closed when two different owners claim the same generation', () => {
    expect(compareOwnership(owner('server-b', 3), owner('server-a', 3))).toBe('conflict');
  });

  it('compares on generation alone, never on owner identity ordering', () => {
    expect(compareOwnership(owner('aaa', 9), owner('zzz', 1))).toBe('newer');
    expect(compareOwnership(owner('zzz', 1), owner('aaa', 9))).toBe('stale');
  });
});

describe('execution reference admission', () => {
  it('narrows a reference carrying an execution ID to an admitted execution', () => {
    const ref: ExecutionRef = { executionId: 'exec-1', launchRequestId: 'launch-1' };
    expect(isAdmittedExecution(ref)).toBe(true);
    if (isAdmittedExecution(ref)) {
      expect(ref.executionId).toBe('exec-1');
    }
  });

  it('treats a pre-admission reference as not yet admitted', () => {
    const ref: ExecutionRef = { executionId: null, launchRequestId: 'launch-1' };
    expect(isAdmittedExecution(ref)).toBe(false);
  });
});

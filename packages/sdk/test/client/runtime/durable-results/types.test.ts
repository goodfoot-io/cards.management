/**
 * Drift guard for {@link DurableResultMessageType}. The union is written out by
 * hand, and `Extract` silently drops a member the protocol no longer has, so
 * these checks pin it to the protocol's `durable-result` delivery class in both
 * directions: at the type level and against the runtime contract table.
 *
 * @summary Checks that the custody message types match the protocol's durable-result class
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DurableResultMessageType } from '../../../../src/client/runtime/durable-results/index.js';
import {
  deliveryClassFor,
  RUNTIME_MESSAGE_CONTRACTS,
  type RuntimeMessageType
} from '../../../../src/protocol/index.js';

const CUSTODY_TYPES = [
  'execution.commandCustody',
  'execution.launchAdmission',
  'execution.launchOutcome',
  'execution.commandEffectResult',
  'execution.commandReport',
  'execution.cleanupResult',
  'watcher.stopResult'
] as const satisfies readonly RuntimeMessageType[];

describe('DurableResultMessageType', () => {
  it('names exactly the listed custody types', () => {
    expectTypeOf<DurableResultMessageType>().toEqualTypeOf<(typeof CUSTODY_TYPES)[number]>();
  });

  it('matches every message type the protocol delivers as a durable result', () => {
    const durable = (Object.keys(RUNTIME_MESSAGE_CONTRACTS) as RuntimeMessageType[]).filter(
      (type) => deliveryClassFor(type) === 'durable-result'
    );
    expect([...durable].sort()).toEqual([...CUSTODY_TYPES].sort());
  });
});

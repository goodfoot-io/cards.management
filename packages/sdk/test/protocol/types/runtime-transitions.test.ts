import { describe, expect, it } from 'vitest';
import {
  CONNECTION_TRANSITIONS,
  EXECUTION_LIFECYCLE_TRANSITIONS,
  findConnectionTransition,
  findLifecycleTransition,
  TERMINAL_LIFECYCLE_STATES
} from '../../../src/protocol/types/runtime-transitions.js';

/**
 * Exercises the lifecycle and connection transition tables in the types area through focused
 * scenarios. The cases pin the two tables as disjoint, keep the strict-drain barrier as the only
 * route into termination, and assert the tables stay unambiguous so a guard set can never select
 * two different destination states.
 *
 * @summary Tests lifecycle and connection transition table lookups in types
 */

describe('lifecycle transition table integrity', () => {
  it('never lets one guard set match two rows for the same state and trigger', () => {
    const ambiguities = EXECUTION_LIFECYCLE_TRANSITIONS.flatMap((row) =>
      EXECUTION_LIFECYCLE_TRANSITIONS.filter(
        (other) =>
          other !== row &&
          other.from === row.from &&
          other.trigger === row.trigger &&
          other.guards.every((guard) => row.guards.includes(guard))
      ).map((other) => `${String(row.from)}--${row.trigger}-->${row.to} vs ${other.to}`)
    );
    expect(ambiguities).toEqual([]);
  });

  it('creates an execution only through the admission-bound launch request', () => {
    const creating = EXECUTION_LIFECYCLE_TRANSITIONS.filter((row) => row.from === null);
    expect(creating).toHaveLength(1);
    expect(creating[0]).toMatchObject({ to: 'admitted', trigger: 'execution.launchRequest' });
    expect(creating[0]?.guards).toContain('admission-bound');
  });

  it('reaches terminating only from draining under a fresh strict drain with its barrier held', () => {
    const intoTerminating = EXECUTION_LIFECYCLE_TRANSITIONS.filter((row) => row.to === 'terminating');
    expect(intoTerminating).toHaveLength(1);
    expect(intoTerminating[0]).toMatchObject({ from: 'draining', trigger: 'execution.agentShutdownCommand' });
    expect(intoTerminating[0]?.guards).toContain('fresh-strict-drain-with-barrier');
  });

  it('leaves a terminal state only by absorbing a replayed result into itself', () => {
    for (const row of EXECUTION_LIFECYCLE_TRANSITIONS) {
      if (row.from !== null && TERMINAL_LIFECYCLE_STATES.includes(row.from)) {
        expect(row.to).toBe(row.from);
        expect(row.guards).toContain('idempotent-finalization');
      }
    }
  });
});

describe('findLifecycleTransition', () => {
  it('admits a new execution when the request was atomically bound', () => {
    expect(findLifecycleTransition(null, 'execution.launchRequest', ['admission-bound'])).toMatchObject({
      to: 'admitted'
    });
  });

  it('refuses a transition whose guards the caller has not established', () => {
    expect(findLifecycleTransition(null, 'execution.launchRequest', [])).toBeUndefined();
  });

  it('refuses a trigger that is not legal from the current state', () => {
    expect(findLifecycleTransition('completed', 'execution.shutdownRequest', ['ownership-current'])).toBeUndefined();
  });

  it('separates a failed launch from a successful one by the guard each states', () => {
    expect(
      findLifecycleTransition('launching', 'execution.launchOutcome', ['ownership-current', 'terminal-exit-nonzero'])
    ).toMatchObject({ to: 'failed' });
    expect(
      findLifecycleTransition('launching', 'execution.launchOutcome', [
        'ownership-current',
        'launch-observed-successful'
      ])
    ).toMatchObject({ to: 'launching' });
  });

  it('routes a cleanup result to completed or failed by the observed exit', () => {
    expect(
      findLifecycleTransition('terminating', 'execution.cleanupComplete', ['ownership-current', 'terminal-exit-zero'])
    ).toMatchObject({ to: 'completed' });
    expect(
      findLifecycleTransition('terminating', 'execution.cleanupComplete', [
        'ownership-current',
        'terminal-exit-nonzero'
      ])
    ).toMatchObject({ to: 'failed' });
  });

  it('will not terminate a draining execution without the strict-drain barrier', () => {
    expect(
      findLifecycleTransition('draining', 'execution.agentShutdownCommand', ['ownership-current'])
    ).toBeUndefined();
    expect(
      findLifecycleTransition('draining', 'execution.agentShutdownCommand', [
        'ownership-current',
        'fresh-strict-drain-with-barrier'
      ])
    ).toMatchObject({ to: 'terminating' });
  });

  it('ignores guards the caller established that the transition does not require', () => {
    expect(
      findLifecycleTransition('draining', 'execution.agentShutdownCommand', [
        'ownership-current',
        'fresh-strict-drain-with-barrier',
        'user-authorized-cancel'
      ])
    ).toMatchObject({ to: 'terminating' });
  });
});

describe('findConnectionTransition', () => {
  it('advances a connection through authentication and reconciliation before it is usable', () => {
    expect(findConnectionTransition('connecting', 'transport-open')).toMatchObject({ to: 'authenticating' });
    expect(findConnectionTransition('authenticating', 'credentials-accepted')).toMatchObject({ to: 'synchronizing' });
    expect(findConnectionTransition('synchronizing', 'reconciliation-complete')).toMatchObject({ to: 'connected' });
  });

  it('fences a connection whose ownership generation has been superseded', () => {
    expect(findConnectionTransition('connected', 'ownership-superseded')).toMatchObject({ to: 'fenced' });
  });

  it('treats fenced as terminal for the connection', () => {
    expect(CONNECTION_TRANSITIONS.filter((row) => row.from === 'fenced')).toEqual([]);
  });

  it('refuses a trigger that is not legal from the current connection state', () => {
    expect(findConnectionTransition('disconnected', 'reconciliation-complete')).toBeUndefined();
  });

  it('keeps connection triggers out of the lifecycle table', () => {
    const lifecycleTriggers = new Set(EXECUTION_LIFECYCLE_TRANSITIONS.map((row) => String(row.trigger)));
    for (const row of CONNECTION_TRANSITIONS) {
      expect(lifecycleTriggers.has(row.trigger)).toBe(false);
    }
  });
});

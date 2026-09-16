/**
 * The explicit transition tables for execution lifecycle and connection state.
 *
 * There are two tables and they never touch. A connection opening or dropping
 * changes only connection state; an execution completing or failing changes
 * only lifecycle state. Keeping them separate as data — rather than as
 * conditionals scattered through handlers — is what makes "disconnected but
 * still running" and "connected but already completed" both representable, and
 * stops a heartbeat loss from being mistaken for a dead agent.
 *
 * Every lifecycle transition names a guard or explicitly declares it has none.
 * A guard is a condition the caller must independently establish before the
 * transition is legal; the table records the requirement so that a handler
 * cannot perform the transition while forgetting the check. The guard that
 * matters most is `terminal-decision-accepted`: it is the only route into
 * `terminating` from `draining`, so a stop command cannot be dispatched before
 * one terminal decision has been atomically written for the execution.
 *
 * @summary Execution lifecycle and connection state transition tables with guards
 * @module
 */

import type { ConnectionState, ExecutionLifecycleState } from './runtime-identity.js';
import type { RuntimeMessageType } from './runtime-messages.js';

/**
 * Conditions a caller must establish before a lifecycle transition is legal.
 *
 * - `ownership-current` — the message's ownership generation is not stale.
 * - `admission-bound` — the caller's original request ID was atomically bound
 *   to this execution with immutable parameters.
 * - `launch-token-claimed` — the authorized launcher claimed the launch token
 *   exactly once, so recovery cannot spawn a second harness.
 * - `terminal-decision-accepted` — one terminal decision is already durably
 *   written for this execution, and the message names that decision ID.
 * - `readiness-superseded` — stored readiness names an older work revision.
 * - `user-authorized-cancel` — explicit user cancellation, which is separately
 *   authorized and may override idle requirements.
 * - `successor-continuation-durable` — the successor identity and its
 *   continuation payload are persisted before the predecessor is stopped.
 * - `launch-observed-successful` — the launcher reported the harness started;
 *   the execution stays `launching` until the runtime registers. This is the
 *   positive counterpart to `terminal-exit-nonzero` on the same trigger, and
 *   exists so the successful edge is selected by a guard it states rather than
 *   by being the less specific of two overlapping rows.
 * - `terminal-exit-zero` / `terminal-exit-nonzero` — the observed process exit.
 * - `idempotent-finalization` — a replayed durable result reaching an execution
 *   already in this state; recorded again without a second effect.
 */
export const LIFECYCLE_GUARDS = [
  'ownership-current',
  'admission-bound',
  'launch-token-claimed',
  'terminal-decision-accepted',
  'readiness-superseded',
  'launch-observed-successful',
  'user-authorized-cancel',
  'successor-continuation-durable',
  'terminal-exit-zero',
  'terminal-exit-nonzero',
  'idempotent-finalization'
] as const;

/** A guard drawn from {@link LIFECYCLE_GUARDS}. */
export type LifecycleGuard = (typeof LIFECYCLE_GUARDS)[number];

/**
 * What triggers a lifecycle transition. Almost every trigger is a protocol
 * message; `recovery` is the exception, covering states reconstructed from the
 * authoritative journal at startup rather than from a live message.
 */
export type LifecycleTrigger = RuntimeMessageType | 'recovery';

/**
 * One legal lifecycle transition. `from` is `null` only for the transition that
 * creates an execution at admission.
 */
export interface LifecycleTransition {
  /** Originating state, or `null` for execution creation. */
  readonly from: ExecutionLifecycleState | null;
  /** Resulting state. */
  readonly to: ExecutionLifecycleState;
  /** Message or internal event that triggers the transition. */
  readonly trigger: LifecycleTrigger;
  /** Conditions the caller must have established; empty when unconditional. */
  readonly guards: readonly LifecycleGuard[];
}

/**
 * Every legal execution lifecycle transition. A transition that is not in this
 * table does not exist; in particular there is no edge out of `completed`,
 * `failed`, or `cancelled` other than the idempotent self-edges that absorb a
 * replayed durable result.
 */
export const EXECUTION_LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = [
  { from: null, to: 'admitted', trigger: 'execution.launchRequest', guards: ['admission-bound'] },
  {
    from: 'admitted',
    to: 'launching',
    trigger: 'execution.executeRequest',
    guards: ['ownership-current', 'launch-token-claimed']
  },
  { from: 'launching', to: 'running', trigger: 'runtime.register', guards: ['ownership-current'] },
  {
    from: 'launching',
    to: 'failed',
    trigger: 'execution.launchOutcome',
    guards: ['ownership-current', 'terminal-exit-nonzero']
  },
  {
    from: 'launching',
    to: 'launching',
    trigger: 'execution.launchOutcome',
    guards: ['ownership-current', 'launch-observed-successful']
  },
  { from: 'running', to: 'running', trigger: 'runtime.resume', guards: ['ownership-current'] },
  {
    from: 'running',
    to: 'draining',
    trigger: 'execution.shutdownRequest',
    guards: ['ownership-current']
  },
  {
    from: 'draining',
    to: 'draining',
    trigger: 'execution.shutdownReadiness',
    guards: ['readiness-superseded']
  },
  {
    from: 'draining',
    to: 'terminating',
    trigger: 'execution.stopCommand',
    guards: ['ownership-current', 'terminal-decision-accepted']
  },
  {
    from: 'running',
    to: 'completed',
    trigger: 'execution.interactiveHandoff',
    guards: ['ownership-current', 'successor-continuation-durable']
  },
  {
    from: 'running',
    to: 'completed',
    trigger: 'execution.cleanupResult',
    guards: ['ownership-current', 'terminal-exit-zero']
  },
  {
    from: 'running',
    to: 'failed',
    trigger: 'execution.cleanupResult',
    guards: ['ownership-current', 'terminal-exit-nonzero']
  },
  {
    from: 'terminating',
    to: 'completed',
    trigger: 'execution.cleanupResult',
    guards: ['ownership-current', 'terminal-exit-zero']
  },
  {
    from: 'terminating',
    to: 'failed',
    trigger: 'execution.cleanupResult',
    guards: ['ownership-current', 'terminal-exit-nonzero']
  },
  {
    from: 'admitted',
    to: 'cancelled',
    trigger: 'execution.cancelRequest',
    guards: ['user-authorized-cancel']
  },
  {
    from: 'launching',
    to: 'cancelled',
    trigger: 'execution.cancelRequest',
    guards: ['user-authorized-cancel']
  },
  {
    from: 'running',
    to: 'cancelled',
    trigger: 'execution.cancelRequest',
    guards: ['user-authorized-cancel']
  },
  {
    from: 'draining',
    to: 'cancelled',
    trigger: 'execution.cancelRequest',
    guards: ['user-authorized-cancel']
  },
  {
    from: 'terminating',
    to: 'cancelled',
    trigger: 'execution.cancelRequest',
    guards: ['user-authorized-cancel']
  },
  {
    from: 'completed',
    to: 'completed',
    trigger: 'execution.cleanupResult',
    guards: ['idempotent-finalization']
  },
  {
    from: 'failed',
    to: 'failed',
    trigger: 'execution.cleanupResult',
    guards: ['idempotent-finalization']
  },
  {
    from: 'cancelled',
    to: 'cancelled',
    trigger: 'execution.cleanupResult',
    guards: ['idempotent-finalization']
  }
];

/** Execution lifecycle states from which no further transition is legal. */
export const TERMINAL_LIFECYCLE_STATES: readonly ExecutionLifecycleState[] = ['completed', 'failed', 'cancelled'];

/** Events that move one connection between states. */
export const CONNECTION_TRIGGERS = [
  'connect-attempt',
  'transport-open',
  'transport-error',
  'credentials-accepted',
  'credentials-rejected',
  'reconciliation-complete',
  'heartbeat-missed',
  'ownership-superseded'
] as const;

/** A connection trigger drawn from {@link CONNECTION_TRIGGERS}. */
export type ConnectionTrigger = (typeof CONNECTION_TRIGGERS)[number];

/** One legal connection state transition. */
export interface ConnectionTransition {
  /** Originating connection state. */
  readonly from: ConnectionState;
  /** Resulting connection state. */
  readonly to: ConnectionState;
  /** Event that triggers the transition. */
  readonly trigger: ConnectionTrigger;
}

/**
 * Every legal connection transition. No entry here names an execution
 * lifecycle state, which is the mechanical expression of the rule that
 * connection state and lifecycle state are orthogonal.
 *
 * `fenced` is terminal for a connection: a superseded generation reconnects as
 * a new connection rather than recovering the old one, so it cannot resume
 * issuing commands under its stale fence.
 */
export const CONNECTION_TRANSITIONS: readonly ConnectionTransition[] = [
  { from: 'disconnected', to: 'connecting', trigger: 'connect-attempt' },
  { from: 'connecting', to: 'authenticating', trigger: 'transport-open' },
  { from: 'connecting', to: 'disconnected', trigger: 'transport-error' },
  { from: 'authenticating', to: 'synchronizing', trigger: 'credentials-accepted' },
  { from: 'authenticating', to: 'disconnected', trigger: 'credentials-rejected' },
  { from: 'authenticating', to: 'disconnected', trigger: 'transport-error' },
  { from: 'authenticating', to: 'fenced', trigger: 'ownership-superseded' },
  { from: 'synchronizing', to: 'connected', trigger: 'reconciliation-complete' },
  { from: 'synchronizing', to: 'disconnected', trigger: 'transport-error' },
  { from: 'synchronizing', to: 'fenced', trigger: 'ownership-superseded' },
  { from: 'connected', to: 'disconnected', trigger: 'transport-error' },
  { from: 'connected', to: 'disconnected', trigger: 'heartbeat-missed' },
  { from: 'connected', to: 'fenced', trigger: 'ownership-superseded' }
];

/**
 * Finds the lifecycle transition that applies given the guards the caller has
 * established.
 *
 * Several transitions can share a `from` and `trigger` and be separated only by
 * their guards — `cleanupResult` from `running` leads to `completed` or
 * `failed` depending on the observed exit. Selection therefore requires the
 * caller's guard set, and a transition matches only when every one of its
 * guards is present.
 *
 * @param from - Current lifecycle state, or `null` when creating an execution.
 * @param trigger - Message or internal event being applied.
 * @param satisfiedGuards - Guards the caller has independently established.
 * @returns The single matching transition, or `undefined` when the trigger is
 *   not legal from this state under these guards.
 * @throws {Error} When more than one transition matches, which indicates an
 *   ambiguous table rather than a caller error.
 */
export function findLifecycleTransition(
  from: ExecutionLifecycleState | null,
  trigger: LifecycleTrigger,
  satisfiedGuards: readonly LifecycleGuard[]
): LifecycleTransition | undefined {
  const matches = EXECUTION_LIFECYCLE_TRANSITIONS.filter(
    (transition) =>
      transition.from === from &&
      transition.trigger === trigger &&
      transition.guards.every((guard) => satisfiedGuards.includes(guard))
  );
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous lifecycle transition table: ${matches.length} rows match ${String(from)} --${trigger}--> under guards [${satisfiedGuards.join(', ')}]`
    );
  }
  return matches[0];
}

/**
 * Finds the connection transition for a trigger.
 *
 * @param from - Current connection state.
 * @param trigger - Event being applied.
 * @returns The resulting connection state, or `undefined` when the trigger is
 *   not legal from this state.
 */
export function findConnectionTransition(
  from: ConnectionState,
  trigger: ConnectionTrigger
): ConnectionTransition | undefined {
  return CONNECTION_TRANSITIONS.find((transition) => transition.from === from && transition.trigger === trigger);
}

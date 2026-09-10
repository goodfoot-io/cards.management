/**
 * Identity primitives for the Cards runtime protocol: who is speaking, about
 * which execution, in which repository scope, and under which ownership fence.
 *
 * Two ideas here are deliberately kept apart because conflating them is the
 * defect the protocol exists to remove. Lifecycle state describes what an
 * execution is doing and survives process death; connection state describes
 * whether a socket happens to be attached right now. A disconnected execution
 * is still running, and a connected one may already be completed. Nothing in
 * this module lets one be derived from the other.
 *
 * Ownership is a monotonic fence rather than a process identity. A new server
 * owner or a resumed client proves precedence by presenting a higher
 * generation, never by presenting a fresh process ID, because a recycled PID
 * proves nothing about which writer is authoritative.
 *
 * @summary Execution, scope, producer, and ownership identity types for the runtime protocol
 * @module
 */

import { z } from 'zod';

/**
 * Roles a connected producer may claim. Authorization is role-based rather
 * than connection-based so that several independent producers (a wrapper, a
 * short-lived agent hook, and the dispatcher) can hold concurrent connections
 * for one execution without impersonating or evicting one another.
 */
export const PRODUCER_ROLES = [
  'server',
  'extension-dispatcher',
  'runtime-wrapper',
  'agent-handler',
  'agent-hook',
  'watcher',
  'cli'
] as const;

/** A producer role drawn from {@link PRODUCER_ROLES}. */
export type ProducerRole = (typeof PRODUCER_ROLES)[number];

/** Zod schema for {@link ProducerRole}. */
export const producerRoleSchema = z.enum(PRODUCER_ROLES);

/**
 * Lifecycle states of an execution. These are durable: they are reconstructed
 * from the authoritative journal after a restart and are never inferred from
 * whether a connection is currently open.
 *
 * `draining` means a shutdown request has been accepted and strict drain
 * authority is being established; it is not permission to terminate.
 * `terminating` means a correlated termination has actually been authorized.
 */
export const EXECUTION_LIFECYCLE_STATES = [
  'admitted',
  'launching',
  'running',
  'draining',
  'terminating',
  'completed',
  'failed',
  'cancelled'
] as const;

/** A durable execution lifecycle state drawn from {@link EXECUTION_LIFECYCLE_STATES}. */
export type ExecutionLifecycleState = (typeof EXECUTION_LIFECYCLE_STATES)[number];

/** Zod schema for {@link ExecutionLifecycleState}. */
export const executionLifecycleStateSchema = z.enum(EXECUTION_LIFECYCLE_STATES);

/**
 * States of one producer connection. These are transient and per-connection.
 * `synchronizing` is the explicit phase in which reconciled snapshots and
 * outstanding message IDs are exchanged; commands must not be delivered until
 * it completes, or a client would act on a command it has already handled.
 * `fenced` is terminal for a connection whose ownership generation has been
 * superseded by a newer one.
 */
export const CONNECTION_STATES = [
  'disconnected',
  'connecting',
  'authenticating',
  'synchronizing',
  'connected',
  'fenced'
] as const;

/** A transient connection state drawn from {@link CONNECTION_STATES}. */
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Zod schema for {@link ConnectionState}. */
export const connectionStateSchema = z.enum(CONNECTION_STATES);

/**
 * Identifies one admitted execution. `executionId` is minted by the admission
 * boundary, not by the caller; `launchRequestId` is the caller-persisted
 * original request ID that was atomically bound to this execution, and is what
 * makes a retry after process exit return the prior admission instead of
 * creating a second harness.
 */
export interface ExecutionIdentity {
  /** Server-minted stable identity for the admitted execution. */
  readonly executionId: string;
  /** Original caller request ID bound to this execution at admission. */
  readonly launchRequestId: string;
}

/** Zod schema for {@link ExecutionIdentity}. */
export const executionIdentitySchema: z.ZodType<ExecutionIdentity> = z
  .object({
    executionId: z.string().min(1),
    launchRequestId: z.string().min(1)
  })
  .strict();

/**
 * How an envelope refers to an execution. `executionId` is `null` on the
 * messages that precede admission — a launch request names only the caller's
 * original request ID, because the execution it will be bound to does not exist
 * yet. Every other message requires an admitted execution, which the
 * authorization table enforces through `requiresAdmittedExecution`.
 */
export interface ExecutionRef {
  /** Admitted execution, or `null` before the admission boundary has run. */
  readonly executionId: string | null;
  /** Caller-persisted original request ID; always present. */
  readonly launchRequestId: string;
}

/** Zod schema for {@link ExecutionRef}. */
export const executionRefSchema: z.ZodType<ExecutionRef> = z
  .object({
    executionId: z.string().min(1).nullable(),
    launchRequestId: z.string().min(1)
  })
  .strict();

/**
 * Narrows an {@link ExecutionRef} to an admitted {@link ExecutionIdentity}.
 *
 * @param ref - Execution reference taken from a validated envelope.
 * @returns True when the reference names an execution that has passed admission.
 */
export function isAdmittedExecution(ref: ExecutionRef): ref is ExecutionIdentity {
  return ref.executionId !== null;
}

/**
 * The repository, workspace, and card an execution belongs to. Scope is carried
 * on every envelope and validated against the scope bound at admission, so a
 * command can never be applied to whichever card happens to match later.
 *
 * `workspacePath` is the normalized absolute path of the workspace or worktree;
 * `repositoryId` is the stable repository identity (for example
 * `github.com/org/repo`) that distinguishes two worktrees of the same project
 * from two unrelated projects at similar paths.
 */
export interface RuntimeScope {
  /** Stable repository identity, for example `github.com/org/repo`. */
  readonly repositoryId: string;
  /** Normalized absolute workspace or worktree path. */
  readonly workspacePath: string;
  /** Card the execution is bound to. */
  readonly cardId: string;
}

/** Zod schema for {@link RuntimeScope}. */
export const runtimeScopeSchema: z.ZodType<RuntimeScope> = z
  .object({
    repositoryId: z.string().min(1),
    workspacePath: z.string().min(1),
    cardId: z.string().min(1)
  })
  .strict();

/**
 * Identifies the producer of a message. `producerId` is stable across
 * reconnects of the same logical producer so that a resumed client fences its
 * own prior connection rather than appearing as a second concurrent producer.
 */
export interface ProducerIdentity {
  /** Stable identity of this producer across reconnects. */
  readonly producerId: string;
  /** Role claimed by the producer, authorized at authentication time. */
  readonly role: ProducerRole;
}

/** Zod schema for {@link ProducerIdentity}. */
export const producerIdentitySchema: z.ZodType<ProducerIdentity> = z
  .object({
    producerId: z.string().min(1),
    role: producerRoleSchema
  })
  .strict();

/**
 * Monotonic ownership fence. `generation` increases every time ownership of an
 * execution's control path is (re)acquired, so precedence is decided by a
 * durable counter rather than by process identity or arrival order.
 */
export interface OwnershipStamp {
  /** Identity of the owner holding this generation. */
  readonly ownerId: string;
  /** Monotonically increasing fence value; higher always wins. */
  readonly generation: number;
}

/** Zod schema for {@link OwnershipStamp}. */
export const ownershipStampSchema: z.ZodType<OwnershipStamp> = z
  .object({
    ownerId: z.string().min(1),
    generation: z.number().int().nonnegative()
  })
  .strict();

/**
 * Result of comparing an incoming ownership stamp against the currently
 * recorded one.
 *
 * `conflict` is reported when two distinct owners present the same generation.
 * That cannot happen if generations were allocated durably, so it is evidence
 * of a corrupt or forked authority and is failed closed rather than resolved by
 * a tiebreak: silently picking a winner would let a split-brain owner issue
 * control mutations.
 */
export type OwnershipComparison = 'newer' | 'same' | 'stale' | 'conflict';

/**
 * Compares an incoming ownership stamp against the current one.
 *
 * Comparison is on `generation` alone; a different `ownerId` bearing a higher
 * generation is the legitimate new owner and must win, because that is exactly
 * what a server restart or client resume looks like. Equal generations from
 * different owners are a `conflict`.
 *
 * @param incoming - Ownership stamp presented on the inbound message.
 * @param current - Ownership stamp already recorded for the execution, or
 *   `undefined` when no ownership has been established yet.
 * @returns How `incoming` relates to `current`; `newer` when no ownership was
 *   previously recorded.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function compareOwnership(incoming: OwnershipStamp, current: OwnershipStamp | undefined): OwnershipComparison {
  void incoming;
  void current;
  throw new Error('Not Implemented');
}

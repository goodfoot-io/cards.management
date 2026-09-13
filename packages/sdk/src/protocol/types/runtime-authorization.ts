/**
 * The per-message authorization and delivery table.
 *
 * One entry per message type states who may send it, in which direction, under
 * what identity requirements, and which delivery class governs its acceptance.
 * The table is data rather than prose so the rules are enforceable in one place
 * and testable without a live transport: a handler asks the table, it does not
 * re-derive the rules.
 *
 * Two decisions in here are load-bearing. Roles are checked against the role
 * established at authentication, not against the role the envelope claims, so a
 * producer cannot escalate by relabelling itself. And `executionRequirement`
 * distinguishes messages that must name an admitted execution from the launch
 * request, which by definition precedes one, and from watcher traffic, which is
 * scoped to a card and has no execution at all.
 *
 * @summary Per-message authorization rules and delivery-class assignments
 * @module
 */

import type { DeliveryClass } from './runtime-delivery.js';
import type { RuntimeEnvelope } from './runtime-envelope.js';
import type { OwnershipStamp, ProducerRole, RuntimeScope } from './runtime-identity.js';
import { compareOwnership, isAdmittedExecution } from './runtime-identity.js';
import { MAX_CONTROL_FRAME_BYTES, type RuntimeMessageType } from './runtime-messages.js';

/** Which way a message travels. */
export type MessageDirection = 'client-to-server' | 'server-to-client';

/**
 * How a message type relates to an execution.
 *
 * - `admitted` — must name an execution that has passed the admission boundary.
 * - `pre-admission` — names a caller request ID with no execution yet.
 * - `none` — card-scoped only; the envelope's execution reference must be null.
 */
export type ExecutionRequirement = 'admitted' | 'pre-admission' | 'none' | 'authenticated-subject';

/** The authorization and delivery rules for one message type. */
export interface MessageContract {
  /** Message type these rules govern. */
  readonly type: RuntimeMessageType;
  /** Direction the message travels. */
  readonly direction: MessageDirection;
  /** Delivery class governing acceptance and replay. */
  readonly deliveryClass: DeliveryClass;
  /** Authenticated roles permitted to send it. */
  readonly allowedRoles: readonly ProducerRole[];
  /** How the message must relate to an execution. */
  readonly executionRequirement: ExecutionRequirement;
  /** The envelope must carry an original caller request ID. */
  readonly requiresRequestId: boolean;
  /** The envelope must name the message that caused it. */
  readonly requiresCausationId: boolean;
  /** The sender's ownership generation must not be stale. */
  readonly requiresOwnershipCurrent: boolean;
  /** Maximum encoded frame size for this message type. */
  readonly maxFrameBytes: number;
}

/** Roles that run inside an execution and speak for it. */
const EXECUTION_PRODUCERS: readonly ProducerRole[] = [
  'runtime-wrapper',
  'agent-handler',
  'agent-hook',
  'extension-dispatcher'
];

/**
 * The authorization and delivery rules for every message type. Every key of the
 * payload catalogue appears exactly once; a message with no entry here cannot
 * be authorized and is therefore rejected.
 */
export const RUNTIME_MESSAGE_CONTRACTS: Readonly<Record<RuntimeMessageType, MessageContract>> = {
  'runtime.register': {
    type: 'runtime.register',
    direction: 'client-to-server',
    deliveryClass: 'reconciled-snapshot',
    allowedRoles: [...EXECUTION_PRODUCERS, 'watcher'],
    executionRequirement: 'authenticated-subject',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.resume': {
    type: 'runtime.resume',
    direction: 'client-to-server',
    deliveryClass: 'reconciled-snapshot',
    allowedRoles: [...EXECUTION_PRODUCERS, 'watcher'],
    executionRequirement: 'authenticated-subject',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.capabilities': {
    type: 'runtime.capabilities',
    direction: 'client-to-server',
    deliveryClass: 'reconciled-snapshot',
    allowedRoles: ['runtime-wrapper', 'agent-handler'],
    executionRequirement: 'admitted',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.liveness': {
    type: 'runtime.liveness',
    direction: 'client-to-server',
    deliveryClass: 'reconciled-snapshot',
    allowedRoles: EXECUTION_PRODUCERS,
    executionRequirement: 'admitted',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.resumeAck': {
    type: 'runtime.resumeAck',
    direction: 'server-to-client',
    deliveryClass: 'reconciled-snapshot',
    allowedRoles: ['server'],
    executionRequirement: 'authenticated-subject',
    requiresRequestId: false,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.accepted': {
    type: 'runtime.accepted',
    direction: 'server-to-client',
    // Not `durable-result`, despite acknowledging one. That class carries
    // `completionEvidence: true`, and an acknowledgment of custody is not evidence that
    // work finished — admitting it there would let a receipt stand as a terminal result.
    // It belongs with `runtime.resumeAck` instead: neither is persisted or replayed by the
    // client, both are mandatory for the server to send, and losing one costs nothing
    // because the resume barrier re-derives the whole accepted set on reconnect.
    //
    // Retire the named record on receipt. Do NOT route this through
    // `evaluateReconciledSnapshot`, which the class otherwise invites: that function keeps
    // the newest revision within a generation, but this payload has no `revision` and each
    // instance names a different message, so "newest" is meaningless here and every receipt
    // after the first would be discarded as stale. `runtime.resumeAck` is the reconciled
    // snapshot of the acknowledgment set — it carries the revisions and the full
    // `acceptedMessageIds`, so it does reconcile by the class's own rules.
    deliveryClass: 'reconciled-snapshot',
    allowedRoles: ['server'],
    executionRequirement: 'authenticated-subject',
    requiresRequestId: false,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.log': {
    type: 'runtime.log',
    direction: 'client-to-server',
    deliveryClass: 'disposable-telemetry',
    allowedRoles: ['runtime-wrapper', 'agent-handler', 'agent-hook', 'watcher', 'cli'],
    executionRequirement: 'admitted',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.commandCustody': {
    type: 'execution.commandCustody',
    direction: 'client-to-server',
    deliveryClass: 'durable-result',
    allowedRoles: ['runtime-wrapper', 'agent-handler', 'watcher'],
    executionRequirement: 'authenticated-subject',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'runtime.heartbeat': {
    type: 'runtime.heartbeat',
    direction: 'client-to-server',
    deliveryClass: 'disposable-telemetry',
    allowedRoles: ['runtime-wrapper', 'agent-handler', 'agent-hook', 'watcher', 'cli'],
    executionRequirement: 'none',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.launchRequest': {
    type: 'execution.launchRequest',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['cli', 'extension-dispatcher', 'server'],
    executionRequirement: 'pre-admission',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.cancelRequest': {
    type: 'execution.cancelRequest',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['cli', 'extension-dispatcher', 'server'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.cancelCommand': {
    type: 'execution.cancelCommand',
    direction: 'server-to-client',
    deliveryClass: 'durable-intent',
    allowedRoles: ['server'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.interactiveHandoff': {
    type: 'execution.interactiveHandoff',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['runtime-wrapper', 'agent-handler'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.switchToInteractiveRequest': {
    type: 'execution.switchToInteractiveRequest',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['extension-dispatcher'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.switchToInteractiveCommand': {
    type: 'execution.switchToInteractiveCommand',
    direction: 'server-to-client',
    deliveryClass: 'durable-intent',
    allowedRoles: ['server'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.shutdownRequest': {
    type: 'execution.shutdownRequest',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['cli', 'agent-hook'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.agentShutdownCommand': {
    type: 'execution.agentShutdownCommand',
    direction: 'server-to-client',
    deliveryClass: 'durable-intent',
    allowedRoles: ['server'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.executeRequest': {
    type: 'execution.executeRequest',
    direction: 'server-to-client',
    deliveryClass: 'durable-intent',
    allowedRoles: ['server'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.shutdownReadiness': {
    type: 'execution.shutdownReadiness',
    direction: 'client-to-server',
    deliveryClass: 'revocable-readiness',
    allowedRoles: ['agent-hook', 'agent-handler'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.workAdmission': {
    type: 'execution.workAdmission',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['agent-hook'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.launchAdmission': {
    type: 'execution.launchAdmission',
    direction: 'server-to-client',
    deliveryClass: 'durable-result',
    allowedRoles: ['server'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.launchOutcome': {
    type: 'execution.launchOutcome',
    direction: 'client-to-server',
    deliveryClass: 'durable-result',
    allowedRoles: ['extension-dispatcher', 'runtime-wrapper'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.agentTermination': {
    type: 'execution.agentTermination',
    direction: 'client-to-server',
    deliveryClass: 'durable-result',
    allowedRoles: ['agent-handler', 'runtime-wrapper'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.commandEffectResult': {
    type: 'execution.commandEffectResult',
    direction: 'client-to-server',
    deliveryClass: 'durable-result',
    allowedRoles: ['agent-handler'],
    executionRequirement: 'admitted',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'execution.cleanupComplete': {
    type: 'execution.cleanupComplete',
    direction: 'client-to-server',
    deliveryClass: 'durable-result',
    allowedRoles: ['runtime-wrapper'],
    executionRequirement: 'admitted',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'watcher.stopRequest': {
    type: 'watcher.stopRequest',
    direction: 'client-to-server',
    deliveryClass: 'durable-intent',
    allowedRoles: ['extension-dispatcher', 'server', 'cli'],
    executionRequirement: 'none',
    requiresRequestId: true,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'watcher.stopCommand': {
    type: 'watcher.stopCommand',
    direction: 'server-to-client',
    deliveryClass: 'durable-intent',
    allowedRoles: ['server'],
    executionRequirement: 'none',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'watcher.stopResult': {
    type: 'watcher.stopResult',
    direction: 'client-to-server',
    deliveryClass: 'durable-result',
    allowedRoles: ['watcher'],
    executionRequirement: 'none',
    requiresRequestId: true,
    requiresCausationId: true,
    requiresOwnershipCurrent: true,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  },
  'watcher.telemetry': {
    type: 'watcher.telemetry',
    direction: 'client-to-server',
    deliveryClass: 'disposable-telemetry',
    allowedRoles: ['watcher'],
    executionRequirement: 'none',
    requiresRequestId: false,
    requiresCausationId: false,
    requiresOwnershipCurrent: false,
    maxFrameBytes: MAX_CONTROL_FRAME_BYTES
  }
};

/** Why a message was not authorized. */
export type AuthorizationRefusalReason =
  | 'unknown-message-type'
  | 'role-not-permitted'
  | 'role-impersonation'
  | 'wrong-direction'
  | 'scope-mismatch'
  | 'execution-not-admitted'
  | 'execution-reference-not-permitted'
  | 'missing-request-id'
  | 'missing-causation-id'
  | 'ownership-stale'
  | 'ownership-conflict'
  | 'frame-too-large';

/** Result of applying the authorization table to one envelope. */
export type AuthorizationOutcome =
  | { readonly authorized: true; readonly contract: MessageContract }
  | { readonly authorized: false; readonly reason: AuthorizationRefusalReason };

/**
 * What the receiver already knows, independent of anything the envelope claims.
 * Every field here is established by the receiver — at authentication, at
 * admission, or from the journal — and is what the envelope's claims are
 * checked against.
 */
export interface AuthorizationContext {
  /** Role established at authentication, not the role the envelope claims. */
  readonly authenticatedRole: ProducerRole;
  /** Producer identity established at authentication. */
  readonly authenticatedProducerId: string;
  /** Direction this connection's peer is permitted to send in. */
  readonly peerDirection: MessageDirection;
  /** Scope bound to the execution at admission, if it is admitted. */
  readonly admittedScope: RuntimeScope | undefined;
  /** Ownership generation currently recorded for the subject. */
  readonly currentOwnership: OwnershipStamp | undefined;
  /** Whether the referenced execution has passed the admission boundary. */
  readonly executionAdmitted: boolean;
  /** Encoded size of the frame this envelope arrived in. */
  readonly frameBytes: number;
}

/**
 * Applies the authorization table to one validated envelope.
 *
 * The envelope is already schema-valid at this point; this decides whether the
 * peer is permitted to send it. Refusal is a closed set so callers can react to
 * a stale ownership fence differently from an impersonation attempt without
 * matching on message text.
 *
 * @param envelope - A validated envelope from {@link parseEnvelope}.
 * @param context - What the receiver independently knows about the peer and the
 *   subject.
 * @returns Authorization with the matched contract, or a refusal naming the
 *   first rule that was not satisfied.
 */
export function authorizeMessage(envelope: RuntimeEnvelope, context: AuthorizationContext): AuthorizationOutcome {
  const contract = RUNTIME_MESSAGE_CONTRACTS[envelope.type] as MessageContract | undefined;
  if (contract === undefined) {
    return { authorized: false, reason: 'unknown-message-type' };
  }
  if (context.frameBytes > contract.maxFrameBytes) {
    return { authorized: false, reason: 'frame-too-large' };
  }
  if (contract.direction !== context.peerDirection) {
    return { authorized: false, reason: 'wrong-direction' };
  }
  // The envelope's claimed identity is checked against what authentication
  // established, never trusted on its own.
  if (
    envelope.producer.role !== context.authenticatedRole ||
    envelope.producer.producerId !== context.authenticatedProducerId
  ) {
    return { authorized: false, reason: 'role-impersonation' };
  }
  if (!contract.allowedRoles.includes(context.authenticatedRole)) {
    return { authorized: false, reason: 'role-not-permitted' };
  }
  if (context.admittedScope !== undefined && !isSameScope(envelope.scope, context.admittedScope)) {
    return { authorized: false, reason: 'scope-mismatch' };
  }

  const execution = envelope.execution;
  if (contract.executionRequirement === 'authenticated-subject') {
    // Registration is bound against the authenticated subject by the server session.
  } else if (contract.executionRequirement === 'none') {
    if (execution !== null) {
      return { authorized: false, reason: 'execution-reference-not-permitted' };
    }
  } else if (execution === null) {
    return { authorized: false, reason: 'execution-reference-not-permitted' };
  } else if (
    contract.executionRequirement === 'admitted' &&
    !(context.executionAdmitted && isAdmittedExecution(execution))
  ) {
    return { authorized: false, reason: 'execution-not-admitted' };
  }

  if (contract.requiresRequestId && envelope.requestId === undefined) {
    return { authorized: false, reason: 'missing-request-id' };
  }
  if (contract.requiresCausationId && envelope.causationId === undefined) {
    return { authorized: false, reason: 'missing-causation-id' };
  }

  if (contract.requiresOwnershipCurrent) {
    const ownership = compareOwnership(envelope.ownership, context.currentOwnership);
    if (ownership === 'stale') {
      return { authorized: false, reason: 'ownership-stale' };
    }
    if (ownership === 'conflict') {
      return { authorized: false, reason: 'ownership-conflict' };
    }
  }

  return { authorized: true, contract };
}

/**
 * Compares two scopes field by field.
 *
 * @param left - Scope claimed by the envelope.
 * @param right - Scope bound at admission.
 * @returns True when every field matches.
 */
function isSameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.workspacePath === right.workspacePath &&
    left.cardId === right.cardId
  );
}

/**
 * Looks up the delivery class governing a message type.
 *
 * @param type - Message type to classify.
 * @returns The delivery class declared for it in the authorization table.
 */
export function deliveryClassFor(type: RuntimeMessageType): DeliveryClass {
  return RUNTIME_MESSAGE_CONTRACTS[type].deliveryClass;
}

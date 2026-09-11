/**
 * The runtime protocol envelope: the fields every message carries regardless of
 * its subject, and the single validated entry point for turning untrusted JSON
 * into a typed message.
 *
 * The envelope exists so that identity, scope, ownership, and deduplication are
 * decided once at the trust boundary rather than re-derived by each handler.
 * Every field on it answers a question that the previous socket transport left
 * to convention: which execution is this about, which repository and card does
 * that execution belong to, who is claiming to speak, under which ownership
 * generation, and is this message a first delivery or a replay.
 *
 * `messageId` is stable across retransmissions of the same logical message.
 * That is what makes replay safe: a producer that never learned whether its
 * durable intent was accepted resends it with the same ID, and the server
 * returns the recorded outcome instead of performing the effect twice.
 *
 * @summary Runtime protocol envelope type, schema, and the validated parse boundary
 * @module
 */

import { z } from 'zod';
import {
  type ExecutionRef,
  executionRefSchema,
  type OwnershipStamp,
  ownershipStampSchema,
  type ProducerIdentity,
  producerIdentitySchema,
  type RuntimeScope,
  runtimeScopeSchema
} from './runtime-identity.js';
import {
  RUNTIME_MESSAGE_PAYLOADS,
  type RuntimeMessageType,
  type RuntimePayload,
  runtimeMessageTypeSchema
} from './runtime-messages.js';
import { assertSupportedProtocolVersion, protocolVersionSchema } from './runtime-version.js';

/**
 * A validated runtime protocol message.
 *
 * @template TType - The message type, which determines the payload type.
 */
export interface RuntimeEnvelope<TType extends RuntimeMessageType = RuntimeMessageType> {
  /** Protocol version; only versions this build implements are accepted. */
  readonly protocolVersion: number;
  /** Stable across retransmissions of the same logical message. */
  readonly messageId: string;
  /**
   * Original caller request ID this message belongs to. Required on messages
   * that participate in admission or in a request/response pair.
   */
  readonly requestId?: string;
  /** `messageId` of the message that caused this one, when this is a response. */
  readonly causationId?: string;
  /** Wall-clock send time in ISO 8601; advisory, never used for ordering. */
  readonly sentAt: string;
  /**
   * Execution this message concerns, or `null` for messages that are scoped to
   * a card rather than an execution — watcher traffic and connection-level
   * heartbeats. The authorization table's `executionRequirement` states which
   * form each message type must take.
   */
  readonly execution: ExecutionRef | null;
  /** Repository, workspace, and card the execution is bound to. */
  readonly scope: RuntimeScope;
  /** Who is speaking and in which role. */
  readonly producer: ProducerIdentity;
  /** Ownership fence under which this message is claimed to be authoritative. */
  readonly ownership: OwnershipStamp;
  /** Message type, which selects the payload schema. */
  readonly type: TType;
  /** Payload validated against the schema registered for `type`. */
  readonly payload: RuntimePayload<TType>;
}

/**
 * Schema for the envelope's type-independent fields. The payload is validated
 * separately against the schema registered for the message type, because a
 * single discriminated union over every payload shape produces error messages
 * that name the wrong branch.
 */
export const envelopeHeaderSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    messageId: z.string().min(1),
    requestId: z.string().min(1).optional(),
    causationId: z.string().min(1).optional(),
    sentAt: z.string().datetime(),
    execution: executionRefSchema.nullable(),
    scope: runtimeScopeSchema,
    producer: producerIdentitySchema,
    ownership: ownershipStampSchema,
    type: runtimeMessageTypeSchema,
    payload: z.unknown()
  })
  .strict();

/** Why an inbound frame was rejected before it could be handled. */
export type EnvelopeRejectionReason =
  | 'unsupported-version'
  | 'malformed-frame'
  | 'unknown-message-type'
  | 'invalid-payload'
  | 'frame-too-large';

/**
 * Error raised when an inbound frame cannot be turned into a valid envelope.
 * The reason is a closed set so that callers can distinguish a version skew
 * from a hostile frame without matching on message text.
 */
export class EnvelopeValidationError extends Error {
  /** Closed-set classification of the failure. */
  readonly reason: EnvelopeRejectionReason;
  /** Message type, when it was readable before validation failed. */
  readonly messageType?: string;

  /**
   * Builds a rejection carrying both its classification and readable detail, so
   * a caller can branch on `reason` while a log line still says what was wrong.
   *
   * @param reason - Closed-set classification of why validation failed.
   * @param detail - Human-readable detail appended to the message.
   * @param messageType - Message type if it was readable, for diagnostics.
   */
  constructor(reason: EnvelopeRejectionReason, detail: string, messageType?: string) {
    super(`Envelope rejected (${reason}): ${detail}`);
    this.name = 'EnvelopeValidationError';
    this.reason = reason;
    this.messageType = messageType;
  }
}

/**
 * Parses and validates one inbound frame into a typed envelope.
 *
 * The version gate runs first and fails closed: an unsupported version is
 * rejected before any payload is interpreted, so a peer speaking a future
 * protocol can never have its fields partially applied.
 *
 * @param raw - Untrusted decoded JSON from one WebSocket frame.
 * @returns The validated envelope with its payload parsed against the schema
 *   registered for its message type.
 * @throws {UnsupportedProtocolVersionError} When the frame declares a protocol
 *   version this build does not implement.
 * @throws {EnvelopeValidationError} When the frame is malformed, names an
 *   unknown message type, or carries a payload the type's schema rejects.
 */
export function parseEnvelope(raw: unknown): RuntimeEnvelope {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EnvelopeValidationError('malformed-frame', 'Frame is not a JSON object');
  }
  const candidate = raw as Record<string, unknown>;

  // The version gate runs before anything else so a future peer's fields are
  // never partially applied on the way to discovering the skew.
  assertSupportedProtocolVersion(candidate['protocolVersion']);

  const declaredType = candidate['type'];
  if (typeof declaredType !== 'string' || !(declaredType in RUNTIME_MESSAGE_PAYLOADS)) {
    throw new EnvelopeValidationError('unknown-message-type', `No contract for type ${JSON.stringify(declaredType)}`);
  }
  const type = declaredType as RuntimeMessageType;

  const header = envelopeHeaderSchema.safeParse(candidate);
  if (!header.success) {
    throw new EnvelopeValidationError('malformed-frame', header.error.issues[0]?.message ?? 'Invalid envelope', type);
  }

  const payload = RUNTIME_MESSAGE_PAYLOADS[type].safeParse(header.data.payload);
  if (!payload.success) {
    throw new EnvelopeValidationError('invalid-payload', payload.error.issues[0]?.message ?? 'Invalid payload', type);
  }

  return { ...header.data, type, payload: payload.data } as RuntimeEnvelope;
}

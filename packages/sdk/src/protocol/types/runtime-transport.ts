/**
 * The wire-visible half of the runtime WebSocket transport: where a client
 * connects, how it presents its credential, how it names its connection slot,
 * and the closed sets of reasons it can be turned away.
 *
 * This contract lives in the SDK rather than the server because both ends
 * consume it. The server decides; the client has to construct the request the
 * server will decide about, and branch on the answer. Verification itself —
 * credential lookup, loopback classification, the durable fencing registry —
 * stays server-side, because it is authority rather than shape.
 *
 * Two fences appear in this file's vocabulary and they are deliberately not the
 * same thing. Execution ownership (`OwnershipStamp`, in the identity module) is
 * per-execution control authority: the right to issue control mutations at all.
 * A {@link ConnectionGeneration} is per-slot and answers a narrower question —
 * of the sockets claiming to be this producer, which one is current. A resumed
 * client fences its own prior socket by taking a higher connection generation
 * without touching execution ownership. Collapsing the two would make an
 * ordinary reconnect indistinguishable from a genuine change of owner.
 *
 * @summary Upgrade path, credential headers, connection slots, and fencing outcomes
 * @module runtime-transport
 */

import { z } from 'zod';
import { type ProducerRole, producerRoleSchema } from './runtime-identity.js';

/**
 * Path the runtime upgrade is served on.
 *
 * Upgrades are routed by exact path match rather than by prefix or fallthrough,
 * so a request for any other path is never silently handled by this transport
 * and a request for this path is never silently handled by the legacy channel.
 */
export const RUNTIME_UPGRADE_PATH = '/internal/runtime';

/**
 * Headers carrying the three fields of a presented role credential.
 *
 * This endpoint is not reachable from a browser, so credentials travel in
 * headers where they stay out of request lines, access logs, and referrers. A
 * credential presented in the query string is refused rather than accepted as a
 * convenience, because accepting it once makes the leaky form permanently
 * viable.
 *
 * The three fields get three headers rather than one delimited value. A packed
 * value invites a split-on-delimiter bug in which a secret containing the
 * delimiter silently truncates into a shorter secret that still compares
 * equal-ish; three headers have no parsing step to get wrong. Separating the
 * secret also lets a log-redaction rule target exactly one header name, since
 * the credential ID is explicitly safe to log and the secret never is.
 */
export const RUNTIME_CREDENTIAL_HEADERS = {
  /** Original caller request ID the presenter claims. */
  requestId: 'x-cards-runtime-request-id',
  /** Credential identifier the presenter claims; safe to log. */
  credentialId: 'x-cards-runtime-credential-id',
  /** Bearer secret; never log this one. */
  secret: 'x-cards-runtime-secret'
} as const;

/**
 * Maximum durable obligations one connection may leave outstanding.
 *
 * Matched to the protocol's own cap on `outstandingMessageIds` so a client that
 * fills its resume payload to the limit is exactly at this bound rather than
 * already over it. A client that tracks this itself never has to discover the
 * budget by being refused.
 */
export const MAX_OUTSTANDING_MESSAGES = 1000;

/** What a connection is attached to. */
export type ConnectionSubject =
  /** An admitted execution; the common case for wrappers, handlers, and hooks. */
  | { readonly kind: 'execution'; readonly executionId: string }
  /** A card, for watcher traffic that outlives any single execution. */
  | { readonly kind: 'card'; readonly cardId: string };

/**
 * Monotonic per-slot counter identifying one connection attempt.
 *
 * Branded so an ownership generation cannot be passed where a connection
 * generation is expected; the two counters advance independently and confusing
 * them would let a reconnect appear to take execution ownership.
 */
export type ConnectionGeneration = number & { readonly __connectionGeneration: unique symbol };

/** The generation a slot holds before any connection has been admitted to it. */
export const INITIAL_CONNECTION_GENERATION = 0 as ConnectionGeneration;

/**
 * Validates a connection generation arriving from the server.
 *
 * Non-negative integers only. A fractional or negative generation cannot have
 * been allocated by the registry, and accepting one would let a client compare
 * it against a real generation and reach a confident wrong answer about which
 * socket is current.
 */
export const connectionGenerationSchema = z.int().nonnegative() as unknown as z.ZodType<ConnectionGeneration>;

/**
 * Identity of one connection slot.
 *
 * The `producerId` is part of the key, and that is the whole of the same-role
 * cardinality rule: two watchers with distinct producer IDs occupy two slots and
 * coexist, while the same producer reconnecting returns to its own slot and
 * fences the socket it left there. Role alone is never the key, or independent
 * hooks sharing a role would evict each other on every connect.
 */
export interface ConnectionSlotKey {
  /** Execution or card this connection serves. */
  readonly subject: ConnectionSubject;
  /** Role established at authentication. */
  readonly role: ProducerRole;
  /** Producer identity, stable across reconnects of the same logical client. */
  readonly producerId: string;
}

/**
 * Why a connection was refused admission to its slot.
 *
 * The two families are not interchangeable. `stale-generation` means a newer
 * connection for this same producer already exists, so retrying is pointless
 * until that one goes away. The ownership refusals mean another server owner
 * holds control, and the client's own reconnection cannot fix it.
 */
export const REGISTRATION_REFUSAL_REASONS = [
  /** A connection at or above this generation already holds the slot. */
  'stale-generation',
  /** The execution has reached a terminal state; it cannot be restored. */
  'execution-terminal',
  /** Registration claimed a scope the credential does not cover. */
  'scope-mismatch',
  /** Control ownership is held at a higher generation by another owner. */
  'ownership-superseded',
  /** Two owners claim the same ownership generation. */
  'ownership-conflict',
  /** The slot's outstanding-obligation budget is already exhausted. */
  'outstanding-limit-exceeded'
] as const;

/** Validates a connection subject arriving from the server. */
export const connectionSubjectSchema: z.ZodType<ConnectionSubject> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execution'), executionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('card'), cardId: z.string().min(1) }).strict()
]);

/** Validates a connection slot key arriving from the server. */
export const connectionSlotKeySchema: z.ZodType<ConnectionSlotKey> = z
  .object({
    subject: connectionSubjectSchema,
    role: producerRoleSchema,
    producerId: z.string().min(1)
  })
  .strict();

/** Why a connection was refused admission to its slot. */
export type RegistrationRefusalReason = (typeof REGISTRATION_REFUSAL_REASONS)[number];

/** Validates a registration refusal reason arriving from the server. */
export const registrationRefusalReasonSchema = z.enum(REGISTRATION_REFUSAL_REASONS);

/**
 * Outcome of registering a connection into its slot.
 *
 * `fencedGeneration` is present when this registration displaced the producer's
 * own prior connection, which is how a client distinguishes "I superseded
 * myself" — an ordinary reconnect, and no cause for alarm — from "I am the first
 * connection in this slot". It is never another producer's generation: a
 * registration only ever fences the slot it is keyed to.
 *
 * The two refusal families are not interchangeable. `stale-generation` means a
 * newer connection for this same producer already exists, so retrying is
 * pointless until that one goes away; the ownership refusals mean another server
 * owner holds control, and the client's own reconnection cannot fix it.
 */
export type RegistrationOutcome =
  | {
      readonly status: 'registered';
      readonly generation: ConnectionGeneration;
      readonly fencedGeneration: ConnectionGeneration | null;
    }
  | { readonly status: 'refused'; readonly reason: RegistrationRefusalReason };

/**
 * Validates a registration outcome arriving from the server.
 *
 * This is the one moved type a client genuinely deserializes off a socket it
 * does not otherwise trust, which is why it is parsed rather than asserted. The
 * union is discriminated on `status` so a refusal can never be read as a
 * registration missing its generation — the shape that would let a fenced client
 * believe it holds a slot.
 *
 * This travels as a bare control frame, deliberately outside the envelope catalogue, and
 * it is the only server-to-client message that does. An envelope carries an ownership
 * stamp and an execution reference the receiver is expected to check, but this frame is
 * what establishes the generation those checks would be made against — a client reading it
 * has not yet been told which generation it holds. Wrapping it in an envelope would make
 * the frame depend on the very fact it exists to deliver, so do not "fix" it into one.
 */
export const registrationOutcomeSchema: z.ZodType<RegistrationOutcome> = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('registered'),
      generation: connectionGenerationSchema,
      fencedGeneration: connectionGenerationSchema.nullable()
    })
    .strict(),
  z.object({ status: z.literal('refused'), reason: registrationRefusalReasonSchema }).strict()
]);

/** Why an inbound frame was refused by the transport, before protocol authorization. */
export const FRAME_REFUSAL_REASONS = [
  /** The frame exceeded the control-frame cap. */
  'frame-too-large',
  /** The frame was not decodable JSON. */
  'malformed-frame',
  /** The sending connection has been fenced by a newer generation. */
  'connection-fenced',
  /** The connection has not finished synchronizing; commands cannot be delivered yet. */
  'not-synchronized',
  /** Accepting the frame would exceed the outstanding-obligation budget. */
  'outstanding-limit-exceeded'
] as const;

/** Why an inbound frame was refused by the transport, before protocol authorization. */
export type FrameRefusalReason = (typeof FRAME_REFUSAL_REASONS)[number];

/** Validates a frame refusal reason arriving from the server. */
export const frameRefusalReasonSchema = z.enum(FRAME_REFUSAL_REASONS);

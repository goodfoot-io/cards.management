/**
 * Protocol version constants and the fail-closed version gate.
 *
 * The runtime protocol does not negotiate. A peer that presents a version this
 * build does not implement is rejected at the handshake, before any payload is
 * interpreted. Negotiating down to a legacy version would mean shipping two
 * live control transports at once, which is precisely the condition that made
 * the previous socket mechanism impossible to reason about during recovery.
 *
 * Rejection is a protocol outcome, not a transport error: the peer is told the
 * versions this build supports so an operator can see a version skew rather
 * than a silent disconnect loop.
 *
 * @summary Supported protocol versions and the non-negotiating version gate
 * @module
 */

import { z } from 'zod';

/** Version emitted on every envelope this build produces. */
export const RUNTIME_PROTOCOL_VERSION = 1;

/**
 * Every version this build can interpret. Adding a version here is a
 * deliberate act that requires the handlers for it to already exist; the set
 * is never widened at runtime by anything a peer sends.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [RUNTIME_PROTOCOL_VERSION];

/** Zod schema accepting only versions in {@link SUPPORTED_PROTOCOL_VERSIONS}. */
export const protocolVersionSchema = z
  .number()
  .int()
  .refine((value) => SUPPORTED_PROTOCOL_VERSIONS.includes(value), {
    message: 'Unsupported runtime protocol version'
  });

/**
 * Error raised when a peer presents a protocol version this build does not
 * implement. Carries both sides of the skew so the condition is diagnosable
 * from a single log line.
 */
export class UnsupportedProtocolVersionError extends Error {
  /** Version the peer presented. */
  readonly received: unknown;
  /** Versions this build implements. */
  readonly supported: readonly number[];

  /**
   * Builds a version-skew rejection whose message names both the version the
   * peer offered and the versions this build implements, so the skew is
   * diagnosable without correlating two log lines.
   *
   * @param received - Version value taken from the inbound envelope, which may
   *   be any JSON value because it has not been validated yet.
   */
  constructor(received: unknown) {
    super(
      `Unsupported runtime protocol version ${JSON.stringify(received)}; this build supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`
    );
    this.name = 'UnsupportedProtocolVersionError';
    this.received = received;
    this.supported = SUPPORTED_PROTOCOL_VERSIONS;
  }
}

/**
 * Asserts that a peer-supplied protocol version is one this build implements.
 *
 * Accepts `unknown` deliberately: the version must be checked before the rest
 * of the envelope is parsed, so at this point it is still untrusted JSON.
 *
 * @param received - Raw `protocolVersion` field from the inbound envelope.
 * @throws {UnsupportedProtocolVersionError} When the value is not a supported
 *   version, including when it is absent or not a number.
 */
export function assertSupportedProtocolVersion(received: unknown): asserts received is number {
  void received;
  throw new Error('Not Implemented');
}

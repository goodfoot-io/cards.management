/**
 * Exact-shape validators for the session bridge in both directions.
 *
 * Both sides validate every inbound message before acting: unknown fields,
 * malformed source identities, non-integer or out-of-range coordinates,
 * oversized batches, and unknown enum values are rejected with an
 * identifier-only reason. Validation proves shape only; generation, session
 * membership, and source authority are checked by the consumer.
 *
 * @summary Session bridge message validators
 * @module stream-store/validate
 */

import type { HostToRendererMessage, MessageValidation, RendererToHostMessage } from './types.js';

/**
 * Validates an untrusted host-to-renderer message.
 * @param _value - Raw `postMessage` data.
 * @returns The typed message, or an identifier-only rejection reason.
 * @throws Error until implemented.
 */
export function validateHostMessage(_value: unknown): MessageValidation<HostToRendererMessage> {
  throw new Error('Not Implemented');
}

/**
 * Validates an untrusted renderer-to-host message.
 * @param _value - Raw `postMessage` data.
 * @returns The typed message, or an identifier-only rejection reason.
 * @throws Error until implemented.
 */
export function validateRendererMessage(_value: unknown): MessageValidation<RendererToHostMessage> {
  throw new Error('Not Implemented');
}

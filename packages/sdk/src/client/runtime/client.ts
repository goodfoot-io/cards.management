import type { RuntimeClient, RuntimeClientOptions } from './types.js';

/**
 * The shared runtime client every producer connects through.
 *
 * It owns the sequence that makes a reconnect safe rather than merely successful:
 * rediscover the endpoint, present the role credential in headers, register or resume,
 * synchronize, and only then deliver new work. Each step is separable and tested on its
 * own; this module is what orders them.
 *
 * Two rules shape the whole design. Durable messages are persisted to the outbox before
 * the caller is told anything succeeded, so a process that dies between send and
 * acknowledgment leaves a record rather than a gap. And a send whose fate is unknown
 * reports uncertainty while keeping its request id and its pending record — never silence,
 * and never a success the server did not give.
 *
 * @summary Discovery, handshake, registration, synchronization, heartbeat, and reconnect
 */

/**
 * Creates a runtime client. The returned client is disconnected until {@link RuntimeClient.connect}.
 *
 * @param options - Identity, credential, outbox, authorities, and discovery.
 * @returns A client bound to those options.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function createRuntimeClient(options: RuntimeClientOptions): RuntimeClient {
  void options;
  throw new Error('Not Implemented');
}

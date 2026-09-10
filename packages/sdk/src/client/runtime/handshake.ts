import type { PresentedCredential } from '../../protocol/types/index.js';
import type { RuntimeConnectTarget } from './types.js';

/**
 * Builds the upgrade request for the runtime route.
 *
 * Two credentials travel here and they are not interchangeable: the rotatable server
 * access token authorizes talking to the API at all, while the role credential proves this
 * process is the admitted execution it claims to be. Rotating the first must leave the
 * second — and the admission identity behind it — untouched.
 *
 * Both go in headers. A credential in a query string survives in access logs, proxy
 * traces, and crash reports, which is why the transport contract names the query keys it
 * refuses rather than leaving the choice to each caller.
 *
 * @summary Constructs the authenticated upgrade URL and headers for the runtime route
 */

/** A prepared upgrade request: where to connect and what to prove on the way in. */
export interface RuntimeHandshakeRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Assembles the upgrade target for one connection attempt.
 *
 * @param target - Freshly discovered host, port, and access token.
 * @param credential - Role credential proving the admitted execution.
 * @returns URL and headers for the WebSocket upgrade.
 * @throws {Error} While this contract is stubbed, until the Phase 3 implementation lands.
 */
export function buildHandshakeRequest(
  target: RuntimeConnectTarget,
  credential: PresentedCredential
): RuntimeHandshakeRequest {
  void target;
  void credential;
  throw new Error('Not Implemented');
}

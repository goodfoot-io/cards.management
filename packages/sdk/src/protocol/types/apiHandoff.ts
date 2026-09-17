/**
 * Browser-safe identity shared by discovery, API handoff, and window consumers.
 *
 * Ownership epochs order server lifetimes; build timestamps express upgrade
 * preference. Neither substitutes for a window connection revision or a panel
 * document generation. Authenticated readiness must echo the exact descriptor
 * identity before a client follows it.
 *
 * @summary Shared identity and validation for API ownership handoff
 */

/** Exact handoff protocol supported by this build; unversioned peers must reload. */
export const CURRENT_API_PROTOCOL_VERSION = 1 as const;

/** Immutable identity minted only after acquiring exclusive API ownership. */
export interface ApiServerIdentity {
  /** Random server-lifetime identifier, independent of bearer credentials. */
  readonly serverInstanceId: string;
  /** Positive durable ownership generation, increasing on each acquisition. */
  readonly ownerEpoch: number;
  /** Explicit wire compatibility version, independent of build ordering. */
  readonly protocolVersion: number;
  /** Non-negative epoch-millisecond build timestamp used for upgrade preference. */
  readonly buildTime: number;
}

/** Authenticated readiness response; draining endpoints cannot admit new work. */
export interface ApiServerReadiness {
  readonly status: 'ready' | 'draining';
  readonly serverIdentity: ApiServerIdentity;
}

/** Targeted takeover request; acceptance is not evidence that ownership released. */
export interface ApiServerHandoffRequest {
  readonly expectedServer: ApiServerIdentity;
  readonly successorBuildTime: number;
}

/** Compatibility verdict for a peer's declared handoff protocol. */
export type ProtocolCompatibility =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'reload-required'; readonly expected: number; readonly actual: number };

/**
 * Validates every identity field without interpreting missing values as defaults.
 *
 * @param value - Parsed descriptor or readiness identity.
 * @returns Whether all fields are valid; version support is checked separately.
 */
export function isApiServerIdentity(value: unknown): value is ApiServerIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['serverInstanceId'] === 'string' &&
    /^[A-Za-z0-9._-]{1,200}$/.test(candidate['serverInstanceId']) &&
    typeof candidate['ownerEpoch'] === 'number' &&
    Number.isSafeInteger(candidate['ownerEpoch']) &&
    candidate['ownerEpoch'] > 0 &&
    typeof candidate['protocolVersion'] === 'number' &&
    Number.isSafeInteger(candidate['protocolVersion']) &&
    candidate['protocolVersion'] > 0 &&
    typeof candidate['buildTime'] === 'number' &&
    Number.isSafeInteger(candidate['buildTime']) &&
    candidate['buildTime'] >= 0
  );
}

/**
 * Compares complete identities without treating two missing identities as equal.
 *
 * @param a - First endpoint identity.
 * @param b - Second endpoint identity.
 * @returns Whether both identities exist and every identity field agrees.
 */
export function apiServerIdentityEquals(a: ApiServerIdentity | undefined, b: ApiServerIdentity | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.serverInstanceId === b.serverInstanceId &&
    a.ownerEpoch === b.ownerEpoch &&
    a.protocolVersion === b.protocolVersion &&
    a.buildTime === b.buildTime
  );
}

/**
 * Requires exact protocol agreement rather than inferring it from build times.
 *
 * @param actual - Protocol advertised by the validated peer.
 * @param expected - Locally supported protocol.
 * @returns A compatible verdict or explicit reload-required metadata.
 */
export function classifyProtocol(
  actual: number,
  expected: number = CURRENT_API_PROTOCOL_VERSION
): ProtocolCompatibility {
  return actual === expected ? { kind: 'compatible' } : { kind: 'reload-required', expected, actual };
}

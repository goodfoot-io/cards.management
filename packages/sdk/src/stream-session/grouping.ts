/**
 * Pure session grouping without filename heuristics or transcript interpretation.
 * @summary Exact session and source tuple grouping
 * @module stream-session/grouping
 */
import type { SessionDescriptor, StreamMeta, StreamSessionRef, StreamSourceRef } from '../protocol/types/stream.js';

/** Source-scoped malformed membership that must remain inspectable. */
export interface SessionGroupingError {
  /** Exact source, when the source identity itself is valid. */
  source: StreamSourceRef | null;
  /** Original metadata retained for inspectable malformed-source errors. */
  record: StreamMeta;
  /** Original list position for malformed source identities. */
  index: number;
  /** Failed metadata contract. */
  reason: 'invalid-source' | 'invalid-binding' | 'duplicate-source';
}

/** Group plus display chronology independent of its stable identity. */
export interface SessionGroup {
  /** Valid or anomalous session membership. */
  descriptor: SessionDescriptor;
  /** Main creation time, otherwise earliest member creation time. */
  createdAt: string;
}

/** Grouping result retains all malformed metadata as separate errors. */
export interface SessionGroupingResult {
  /** Chronological groups with session-key tie breaking. */
  groups: SessionGroup[];
  /** Records that cannot safely join any session. */
  errors: SessionGroupingError[];
}

/**
 * Encodes the exact card/provider/source tuple as a JSON array.
 * @param _source - Source identity.
 * @throws Error until the contract bootstrap is implemented.
 * @returns Unambiguous source key.
 */
export function streamSourceKey(_source: StreamSourceRef): string {
  throw new Error('Not Implemented');
}

/**
 * Encodes the exact card/provider/session tuple as a JSON array.
 * @param _session - Session identity.
 * @throws Error until the contract bootstrap is implemented.
 * @returns Unambiguous session key.
 */
export function streamSessionKey(_session: StreamSessionRef): string {
  throw new Error('Not Implemented');
}

/**
 * Groups metadata, preserving anomalies and sorting members deterministically.
 * @param _cardId - Trusted card scope for the listing.
 * @param _streams - Untrusted metadata records to validate and group.
 * @throws Error until the contract bootstrap is implemented.
 * @returns Session groups and source-scoped metadata errors.
 */
export function groupStreamSessions(_cardId: string, _streams: readonly StreamMeta[]): SessionGroupingResult {
  throw new Error('Not Implemented');
}

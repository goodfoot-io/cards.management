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
 * @returns Unambiguous source key.
 */
export function streamSourceKey(_source: StreamSourceRef): string {
  return JSON.stringify([_source.cardId, _source.streamType, _source.relPath]);
}

/**
 * Encodes the exact card/provider/session tuple as a JSON array.
 * @param _session - Session identity.
 * @returns Unambiguous session key.
 */
export function streamSessionKey(_session: StreamSessionRef): string {
  return JSON.stringify([_session.cardId, _session.streamType, _session.sessionId]);
}

/**
 * Groups metadata, preserving anomalies and sorting members deterministically.
 * @param _cardId - Trusted card scope for the listing.
 * @param _streams - Untrusted metadata records to validate and group.
 * @throws Error if an impossible empty internal group is encountered.
 * @returns Session groups and source-scoped metadata errors.
 */
export function groupStreamSessions(_cardId: string, _streams: readonly StreamMeta[]): SessionGroupingResult {
  const errors: SessionGroupingError[] = [];
  const grouped = new Map<string, StreamMeta[]>();
  const counts = new Map<string, number>();
  for (const record of _streams) {
    const key = streamSourceKey({ cardId: _cardId, streamType: record.streamType, relPath: record.relPath });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  _streams.forEach((record, index) => {
    const source = { cardId: _cardId, streamType: record.streamType, relPath: record.relPath };
    const valid =
      validComponent(_cardId) &&
      validComponent(record.streamType) &&
      validIdentifier(record.relPath) &&
      !record.relPath.includes('\\') &&
      record.relPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
    const reason = !valid
      ? 'invalid-source'
      : counts.get(streamSourceKey(source)) !== 1
        ? 'duplicate-source'
        : !validIdentifier(record.sessionId) ||
            !['main', 'subagent', 'auxiliary'].includes(record.role) ||
            (record.agentId !== undefined && !validIdentifier(record.agentId))
          ? 'invalid-binding'
          : null;
    if (reason) {
      errors.push({ source: valid ? source : null, record: structuredClone(record), index, reason });
      return;
    }
    const key = streamSessionKey({ cardId: _cardId, streamType: record.streamType, sessionId: record.sessionId });
    const records = grouped.get(key) ?? [];
    records.push(record);
    grouped.set(key, records);
  });
  const rank = { main: 0, subagent: 1, auxiliary: 2 };
  const groups = [...grouped.values()].map((records) => {
    const first = records[0];
    if (!first) throw new Error('Empty session group');
    records.sort(
      (a, b) =>
        rank[a.role] - rank[b.role] ||
        compare(
          streamSourceKey({ cardId: _cardId, streamType: a.streamType, relPath: a.relPath }),
          streamSourceKey({ cardId: _cardId, streamType: b.streamType, relPath: b.relPath })
        )
    );
    const mains = records.filter((record) => record.role === 'main');
    const main = mains.length === 1 ? mains[0] : undefined;
    const descriptor: SessionDescriptor = {
      session: { cardId: _cardId, streamType: first.streamType, sessionId: first.sessionId },
      members: records.map((record) => ({
        source: { cardId: _cardId, streamType: record.streamType, relPath: record.relPath },
        role: record.role,
        ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
        ...(record.title === undefined ? {} : { title: record.title })
      })),
      main: main ? { cardId: _cardId, streamType: main.streamType, relPath: main.relPath } : null,
      validity: main ? 'ready' : mains.length === 0 ? 'missing-main' : 'conflicting-main'
    };
    return { descriptor, createdAt: main?.createdAt ?? records.map((record) => record.createdAt).sort()[0] ?? '' };
  });
  groups.sort(
    (a, b) =>
      compare(a.createdAt, b.createdAt) ||
      compare(streamSessionKey(a.descriptor.session), streamSessionKey(b.descriptor.session))
  );
  return { groups, errors };
}

/**
 * Compares keys without environment-dependent locale ordering.
 * @param a - First key.
 * @param b - Second key.
 * @returns Lexical ordering.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Validates logical identifiers without control characters or empty values.
 * @param value - Candidate identifier.
 * @returns Whether the identifier is bounded and safe to display.
 */
function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

/**
 * Validates card/provider identifiers used as single logical path components.
 * @param value - Candidate component.
 * @returns Whether it excludes traversal and path separators.
 */
function validComponent(value: unknown): value is string {
  return validIdentifier(value) && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

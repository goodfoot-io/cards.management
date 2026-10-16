/**
 * Pure multi-source session composition over projected rows and native linkage evidence.
 *
 * Membership comes only from the host-accepted descriptor; nesting comes only from a unique,
 * corroborated delegation whose target identity is observed in exactly one current member.
 * Everything else stays visible as a labeled session-member section or a diagnosed
 * relationship, never guessed from names, filenames or timestamps.
 *
 * @summary Witnessed delegation placement and session-member sections
 * @module streams/lib/session/compose
 */

import type { SessionDescriptor, SessionMember } from '@cards.management/sdk/protocol';
import type { NativeDelegationEvidence, SourceLinkageEvidence } from './linkage';
import type { NativeRecordProvenance, SessionInsertion, SessionRow, TranscriptSourceKey } from './types';

/** One projected source supplied to composition. */
export interface ComposeSource<Payloads extends object = Record<string, unknown>> {
  /** Exact store tuple key. */
  readonly key: TranscriptSourceKey;
  /** Current membership, or null when retained only as unavailable history. */
  readonly member: SessionMember | null;
  /** Projected rows of the currently loaded range. */
  readonly rows: readonly SessionRow<Payloads>[];
  /** Provider evidence for the currently loaded range, or null before content. */
  readonly linkage: SourceLinkageEvidence | null;
}

/** Composition inputs; `nestedRows` exposes provider grouping containers to anchor lookup. */
export interface ComposeInput<Payloads extends object = Record<string, unknown>> {
  readonly descriptor: SessionDescriptor;
  readonly sources: readonly ComposeSource<Payloads>[];
  readonly nestedRows?: (row: SessionRow<Payloads>) => readonly SessionRow<Payloads>[] | undefined;
}

/** Why a relationship was not rendered as witnessed nesting. */
export type RelationshipIssue =
  | 'unresolved-target'
  | 'ambiguous-target'
  | 'duplicate-delegation'
  | 'cyclic-delegation'
  | 'missing-parent-row'
  | 'reference-only'
  | 'native-diagnostic';

/** Identifier-only relationship diagnostic; never transcript text. */
export interface RelationshipDiagnostic {
  /** Stable identity for keyed rendering. */
  readonly id: string;
  readonly issue: RelationshipIssue;
  /** Source whose native records claimed or reported the relationship. */
  readonly sourceKey: TranscriptSourceKey;
  /** Resolved child, when the target identity matched exactly one member. */
  readonly childKey?: TranscriptSourceKey;
  readonly callId?: string;
  /** Absolute native line numbers supporting the claim. */
  readonly lines: readonly number[];
  /** Provider reason code for native diagnostics. */
  readonly reason?: string;
}

/** Placement outcome for one non-main source. */
export interface ComposedChild {
  readonly key: TranscriptSourceKey;
  /** Stable across placement changes, so disclosure and focus follow the moved section. */
  readonly placementId: string;
  /** `witnessed` under a delegation row, `member` as a labeled section, `anomalous` beside diagnostics. */
  readonly status: 'witnessed' | 'member' | 'anomalous' | 'unavailable';
  /** Parent source for witnessed placement. */
  readonly parentKey?: TranscriptSourceKey;
}

/** Deterministic composition result. */
export interface SessionComposition {
  /** Unique main source, or null for missing/conflicting-main groups. */
  readonly mainKey: TranscriptSourceKey | null;
  /** Every non-main source exactly once. */
  readonly children: ReadonlyMap<TranscriptSourceKey, ComposedChild>;
  /** Witnessed insertions by parent source key, in parent row order. */
  readonly witnessed: ReadonlyMap<TranscriptSourceKey, readonly SessionInsertion[]>;
  /** Session-member sections in descriptor order, then retained unavailable sources. */
  readonly sections: readonly TranscriptSourceKey[];
  /** Sources involved in cyclic, duplicate or ambiguous relationships. */
  readonly anomalous: readonly TranscriptSourceKey[];
  readonly diagnostics: readonly RelationshipDiagnostic[];
}

/**
 * Stable child placement identity, independent of where the child is rendered.
 * @param key - Child source key.
 * @returns JSON tuple identity shared by every placement of this child.
 */
export function placementIdentity(key: TranscriptSourceKey): string {
  return JSON.stringify(['session-member', key]);
}

/** An accepted, located delegation edge. */
interface Edge {
  readonly parentKey: TranscriptSourceKey;
  readonly childKey: TranscriptSourceKey;
  readonly delegation: NativeDelegationEvidence;
}

/**
 * Composes one session from projected sources and their linkage evidence.
 * Pure and order-independent: identical loaded content yields identical placement regardless of
 * how it arrived.
 * @param input - Descriptor, projected sources, and optional nested-row access.
 * @returns Placement of every non-main source and identifier-only diagnostics.
 */
export function composeSession<Payloads extends object>(input: ComposeInput<Payloads>): SessionComposition {
  const { descriptor, sources } = input;
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const mainKey = descriptor.main && byKey.has(keyOf(descriptor.main)) ? keyOf(descriptor.main) : null;
  const diagnostics: RelationshipDiagnostic[] = [];
  const diagnose = (entry: Omit<RelationshipDiagnostic, 'id'>): void => {
    diagnostics.push({
      ...entry,
      id: JSON.stringify([entry.issue, entry.sourceKey, entry.callId ?? null, entry.lines, entry.reason ?? null])
    });
  };
  const current = sources.filter((source) => source.member !== null);

  // Native identity observed by each current member's own records; conflicting sources claim none.
  const identities = new Map<string, TranscriptSourceKey[]>();
  for (const source of current) {
    const linkage = source.linkage;
    if (!linkage || linkage.identities.length !== 1) continue;
    if (linkage.diagnostics.some((item) => item.code === 'conflicting-identity')) continue;
    const identity = JSON.stringify(linkage.identities[0]!.identity);
    identities.set(identity, [...(identities.get(identity) ?? []), source.key]);
  }

  const claims = new Map<TranscriptSourceKey, Edge[]>();
  for (const source of current) {
    const linkage = source.linkage;
    if (!linkage) continue;
    for (const item of linkage.diagnostics) {
      if (item.code === 'unsupported-topology' || item.code === 'malformed') continue;
      diagnose({
        issue: 'native-diagnostic',
        sourceKey: source.key,
        lines: lineNumbers(item.occurrences),
        reason: item.reason
      });
    }
    for (const delegation of linkage.delegations) {
      const targets = (identities.get(JSON.stringify(delegation.target)) ?? []).filter((key) => key !== source.key);
      const base = { sourceKey: source.key, callId: delegation.callId, lines: lineNumbers(delegation.evidence) };
      if (delegation.relation === 'reference') {
        diagnose({ ...base, issue: 'reference-only', ...(targets.length === 1 ? { childKey: targets[0] } : {}) });
        continue;
      }
      if (targets.length === 0) {
        diagnose({ ...base, issue: 'unresolved-target' });
        continue;
      }
      if (targets.length > 1) {
        diagnose({ ...base, issue: 'ambiguous-target' });
        continue;
      }
      const childKey = targets[0]!;
      claims.set(childKey, [...(claims.get(childKey) ?? []), { parentKey: source.key, childKey, delegation }]);
    }
  }

  const anomalous = new Set<TranscriptSourceKey>();
  const parents = new Map<TranscriptSourceKey, Edge>();
  for (const [childKey, edges] of claims) {
    if (edges.length > 1) {
      anomalous.add(childKey);
      for (const edge of edges)
        diagnose({
          issue: 'duplicate-delegation',
          sourceKey: edge.parentKey,
          childKey,
          callId: edge.delegation.callId,
          lines: lineNumbers(edge.delegation.evidence)
        });
      continue;
    }
    parents.set(childKey, edges[0]!);
  }

  // A main can never be nested, and any parent chain returning to its start is a cycle.
  for (const childKey of [...parents.keys()]) {
    const cycle = childKey === mainKey ? [childKey] : cycleFrom(childKey, parents);
    if (!cycle) continue;
    for (const key of cycle) {
      const member = parents.get(key);
      if (!member) continue;
      parents.delete(key);
      if (key !== mainKey) anomalous.add(key);
      diagnose({
        issue: 'cyclic-delegation',
        sourceKey: member.parentKey,
        childKey: key,
        callId: member.delegation.callId,
        lines: lineNumbers(member.delegation.evidence)
      });
    }
  }

  const witnessed = new Map<TranscriptSourceKey, SessionInsertion[]>();
  const children = new Map<TranscriptSourceKey, ComposedChild>();
  for (const [childKey, edge] of [...parents].sort(([left], [right]) => compare(left, right))) {
    const parent = byKey.get(edge.parentKey)!;
    const anchor = locate(parent.rows, edge.parentKey, edge.delegation.parent, input.nestedRows);
    if (!anchor) {
      parents.delete(childKey);
      diagnose({
        issue: 'missing-parent-row',
        sourceKey: edge.parentKey,
        childKey,
        callId: edge.delegation.callId,
        lines: lineNumbers(edge.delegation.evidence)
      });
      continue;
    }
    const insertion: SessionInsertion = {
      placementId: placementIdentity(childKey),
      childSourceKey: childKey,
      label: '',
      placement: {
        kind: 'witnessed',
        parentSourceKey: edge.parentKey,
        rowId: anchor.rowId,
        ...(anchor.partId ? { partId: anchor.partId } : {}),
        position: 'after'
      }
    };
    witnessed.set(edge.parentKey, [...(witnessed.get(edge.parentKey) ?? []), insertion]);
    children.set(childKey, {
      key: childKey,
      placementId: insertion.placementId,
      status: 'witnessed',
      parentKey: edge.parentKey
    });
  }
  // A witnessed child under an unplaced (anomalous) parent still renders inside that parent.
  for (const [parentKey, list] of witnessed) {
    const order = new Map(byKey.get(parentKey)!.rows.map((row, index) => [row.id, index]));
    list.sort(
      (left, right) =>
        rowOrder(left, order) - rowOrder(right, order) || compare(left.childSourceKey, right.childSourceKey)
    );
  }

  const sections: TranscriptSourceKey[] = [];
  const anomalousList: TranscriptSourceKey[] = [];
  const memberOrder = descriptor.members.map((member) => keyOf(member.source));
  const retained = sources
    .filter((source) => source.member === null)
    .map((source) => source.key)
    .sort(compare);
  for (const key of [...memberOrder, ...retained]) {
    if (key === mainKey || children.has(key) || !byKey.has(key)) continue;
    const source = byKey.get(key)!;
    const status = source.member === null ? 'unavailable' : anomalous.has(key) ? 'anomalous' : 'member';
    children.set(key, { key, placementId: placementIdentity(key), status });
    if (status === 'anomalous') anomalousList.push(key);
    else sections.push(key);
  }
  diagnostics.sort((left, right) => compare(left.id, right.id));
  return { mainKey, children, witnessed, sections, anomalous: anomalousList, diagnostics };
}

/**
 * Exact tuple key matching the SDK store.
 * @param source - Source identity.
 * @param source.cardId - Owning card.
 * @param source.streamType - Provider stream type.
 * @param source.relPath - Logical source-relative path.
 * @returns JSON tuple key.
 */
function keyOf(source: { cardId: string; streamType: string; relPath: string }): string {
  return JSON.stringify([source.cardId, source.streamType, source.relPath]);
}

/**
 * Code-unit comparison for deterministic order.
 * @param left - First key.
 * @param right - Second key.
 * @returns Sort order.
 */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Sorted unique native line numbers.
 * @param occurrences - Native provenance.
 * @returns Absolute line numbers.
 */
function lineNumbers(occurrences: readonly NativeRecordProvenance[]): number[] {
  return [...new Set(occurrences.map((item) => item.lineNumber))].sort((left, right) => left - right);
}

/**
 * Follows accepted parents from a child and returns the cycle it closes, if any.
 * @param start - Child source key.
 * @param parents - Accepted child-to-parent edges.
 * @returns Cycle members, or null when the chain terminates.
 */
function cycleFrom(start: string, parents: ReadonlyMap<string, Edge>): string[] | null {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = start;
  while (cursor !== undefined && parents.has(cursor)) {
    if (seen.has(cursor)) {
      const index = path.indexOf(cursor);
      return index === 0 ? path : null;
    }
    seen.add(cursor);
    path.push(cursor);
    cursor = parents.get(cursor)!.parentKey;
  }
  return null;
}

/**
 * Finds the top-level row (and part) projecting the native delegation call.
 * @param rows - Parent source rows.
 * @param sourceKey - Parent source key.
 * @param call - Native call occurrence.
 * @param nestedRows - Provider grouping access.
 * @returns Anchor identities, or null when the call is not in the loaded projection.
 */
function locate<Payloads extends object>(
  rows: readonly SessionRow<Payloads>[],
  sourceKey: string,
  call: NativeRecordProvenance,
  nestedRows: ComposeInput<Payloads>['nestedRows']
): { rowId: string; partId?: string } | null {
  const matches = (provenance: readonly NativeRecordProvenance[]): boolean =>
    provenance.some((origin) => origin.sourceKey === sourceKey && origin.lineNumber === call.lineNumber);
  const contains = (row: SessionRow<Payloads>): boolean =>
    matches(row.provenance) ||
    row.parts.some((part) => matches(part.provenance)) ||
    (nestedRows?.(row) ?? []).some(contains);
  for (const row of rows) {
    const part = row.parts.find((item) => matches(item.provenance));
    if (part) return { rowId: row.id, partId: part.id };
    if (contains(row)) return { rowId: row.id };
  }
  return null;
}

/**
 * Parent row order for witnessed insertions.
 * @param insertion - Witnessed insertion.
 * @param order - Row index by identity.
 * @returns Row index.
 */
function rowOrder(insertion: SessionInsertion, order: ReadonlyMap<string, number>): number {
  return insertion.placement.kind === 'witnessed' ? (order.get(insertion.placement.rowId) ?? 0) : 0;
}

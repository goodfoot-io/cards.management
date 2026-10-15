/**
 * Provider-owned native relationship evidence; membership and placement remain caller-owned.
 * @summary Native session linkage contracts
 * @module streams/lib/session/linkage
 */

import type { NativeRecordProvenance, TranscriptGeneration, TranscriptSourceKey } from './types';

/** Qualified native identity, never a filename-derived label or metadata role. */
export type NativeLinkageIdentity =
  | {
      readonly provider: 'claude-code';
      readonly sessionId: string;
      readonly agentId?: string;
      readonly isSidechain: boolean;
    }
  | { readonly provider: 'opencode'; readonly sessionId: string }
  | { readonly provider: 'codex'; readonly threadId: string };

/** Provider limits prevent source-level references from becoming witnessed nesting. */
export type LinkageCapability = 'witnessed-delegation' | 'references-only' | 'main-only';

/** Native records corroborating the current source's own identity. */
export interface NativeSourceIdentityEvidence {
  readonly identity: NativeLinkageIdentity;
  readonly occurrences: readonly NativeRecordProvenance[];
}

/** A native relationship claim awaiting unique authorized target corroboration. */
export interface NativeDelegationEvidence {
  /** Native call occurrence, not a guessed projected row or timestamp. */
  readonly parent: NativeRecordProvenance;
  readonly callId: string;
  /** Must match this source's observed native identity. */
  readonly caller: NativeLinkageIdentity;
  readonly target: NativeLinkageIdentity;
  /** All native call/result occurrences supporting this claim. */
  readonly evidence: readonly NativeRecordProvenance[];
  /** Delegation requires a witnessed structured chain; reference-only capabilities cannot claim it. */
  readonly relation: 'delegation' | 'reference';
}

/** Identifier/reason diagnostics exclude transcript text and payload contents. */
export interface NativeLinkageDiagnostic {
  readonly code: 'malformed' | 'conflicting-identity' | 'unresolved-call' | 'unsupported-topology';
  readonly reason: string;
  readonly occurrences: readonly NativeRecordProvenance[];
}

/** Pure snapshot extraction; no child discovery, placement, or subscription authority. */
export interface SourceLinkageEvidence {
  readonly sourceKey: TranscriptSourceKey;
  readonly generation: TranscriptGeneration;
  readonly provider: 'claude-code' | 'codex' | 'opencode' | 'antigravity';
  readonly capability: LinkageCapability;
  readonly identities: readonly NativeSourceIdentityEvidence[];
  readonly delegations: readonly NativeDelegationEvidence[];
  readonly diagnostics: readonly NativeLinkageDiagnostic[];
}

/** Parsed native record with its unchanged physical source occurrence. */
export interface LinkageRecord {
  readonly value: Readonly<Record<string, unknown>>;
  readonly occurrence: NativeRecordProvenance;
}

/**
 * Narrow unknown native values without trusting provider parser assertions.
 * @param value - Native JSON value.
 * @returns Object fields, or null for arrays, primitives and absent values.
 */
export function linkageObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Accept bounded nonempty native identifiers without control characters; preserve exact bytes.
 * @param value - Native identifier field.
 * @returns Native string, or undefined when unusable.
 */
export function linkageIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || value.trim().length === 0) return undefined;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return undefined;
  }
  return value;
}

/**
 * Decode a snapshot while retaining absolute physical provenance and inert diagnostics.
 * @param source - Caller-authorized complete native range.
 * @param diagnostics - Destination for identifier-free malformed-record reasons.
 * @returns Parsed object records in source order.
 */
export function readLinkageRecords(
  source: import('./types').NativeTranscriptSource,
  diagnostics: NativeLinkageDiagnostic[]
): readonly LinkageRecord[] {
  const records: LinkageRecord[] = [];
  for (const [index, line] of source.lines.entries()) {
    const occurrence = {
      sourceKey: source.sourceKey,
      generation: source.generation,
      lineNumber: source.headLineNumber + index,
      selector: 'record'
    };
    if (!line.trim()) continue;
    let value: Readonly<Record<string, unknown>> | null = null;
    try {
      value = linkageObject(JSON.parse(line));
    } catch {
      /* Malformed native input is data. */
    }
    if (value === null) {
      diagnostics.push({ code: 'malformed', reason: 'invalid-native-record', occurrences: [occurrence] });
      continue;
    }
    records.push({
      value,
      occurrence: {
        ...occurrence,
        ...(linkageIdentifier(value['uuid']) ? { nativeEventId: linkageIdentifier(value['uuid']) } : {})
      }
    });
  }
  return records;
}

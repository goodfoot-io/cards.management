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
  /** Only the captured Claude structured chain qualifies as delegation here. */
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

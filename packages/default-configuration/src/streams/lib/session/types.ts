/**
 * Cards-owned, renderer-internal native source and display contracts.
 *
 * Physical records, semantic events, and visible grouping have separate identities.
 * None of these types are a transport protocol or an authoritative session model.
 *
 * @summary Native transcript provenance and reusable session display types
 * @module streams/lib/session/types
 */

import type { StreamMeta } from '@cards.management/sdk/protocol';

/** Opaque identity qualified by the caller; a filename alone is not globally unique. */
export type TranscriptSourceKey = string;

/** Caller-owned epoch. A changed value explicitly invalidates this source's old state. */
export type TranscriptGeneration = string;

/** Stable opaque identity scoped to source, generation, and semantic or physical selector. */
export type SessionIdentity = string;

/** Complete current contiguous range supplied by the caller, never raw transport chunks. */
export interface NativeTranscriptSource {
  /** Qualified identity independent of which view displays this source. */
  readonly sourceKey: TranscriptSourceKey;
  /** Explicit caller epoch; the renderer never infers authoritative host resets. */
  readonly generation: TranscriptGeneration;
  /** Native complete newline-delimited records, including malformed and empty records. */
  readonly lines: readonly string[];
  /** Absolute one-based coordinate of lines[0]; ignored for an empty range. */
  readonly headLineNumber: number;
  /** Current host metadata, absent before the selected file exists. */
  readonly meta: Readonly<StreamMeta> | null;
  /** Native filename is metadata, never the source identity. */
  readonly filename: string;
  /** Store loading/error state remains distinct from agent interaction readiness. */
  readonly isLoading: boolean;
  readonly error: string | null;
}

/** One physical occurrence, retained even when a provider proves semantic equivalence. */
export interface NativeRecordProvenance {
  readonly sourceKey: TranscriptSourceKey;
  readonly generation: TranscriptGeneration;
  readonly lineNumber: number;
  /** Provider event identifier, when present; it is not assumed unique. */
  readonly nativeEventId?: string;
  /** Deterministic native block/part selector, assigned before filtering or grouping. */
  readonly selector: string;
}

/** Shared leaf identity and all physical occurrences contributing to its content. */
export interface SessionLeaf {
  readonly id: SessionIdentity;
  /** Provider-qualified semantic identity, absent when only physical identity is known. */
  readonly semanticKey?: string;
  readonly provenance: readonly NativeRecordProvenance[];
}

/** Text stays inert until rendered by the shared safe Markdown renderer. */
export interface SessionTextPart extends SessionLeaf {
  readonly kind: 'text' | 'reasoning';
  readonly text: string;
}

/** Raw payload is preserved as text for lazy bounded inspection, never eagerly pretty-printed. */
export interface SessionRawPart extends SessionLeaf {
  readonly kind: 'raw';
  readonly label: string;
  readonly text: string;
  readonly reason: 'unknown' | 'malformed' | 'conflicting-id' | 'detail';
}

/** Source-scoped call identity survives late results and orphan-to-call association. */
export interface SessionToolPart extends SessionLeaf {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly input: string;
  readonly output?: string;
  readonly status: 'pending' | 'running' | 'complete' | 'error' | 'orphan';
}

/** Describes captured media without granting transcript strings executable actions. */
export interface SessionAttachmentPart extends SessionLeaf {
  readonly kind: 'attachment';
  readonly label: string;
  readonly mediaType?: string;
  readonly description: string;
}

/** Provider payloads stay typed through the corresponding rendering registry. */
export type SessionProviderPart<Payloads extends object> = {
  [Kind in keyof Payloads & string]: SessionLeaf & {
    readonly kind: 'provider';
    readonly providerKind: Kind;
    readonly data: Payloads[Kind];
  };
}[keyof Payloads & string];

/** Shared parts plus provider-owned presentation payloads, never vendor message types. */
export type SessionPart<Payloads extends object = Record<string, unknown>> =
  | SessionTextPart
  | SessionRawPart
  | SessionToolPart
  | SessionAttachmentPart
  | SessionProviderPart<Payloads>;

/** Container identity may change on regrouping; leaf IDs own disclosure and focus state. */
export interface SessionRowBase<Payloads extends object> extends SessionLeaf {
  readonly parts: readonly SessionPart<Payloads>[];
  /** Only meaningful turns are navigation anchors; internal updates are not new turns. */
  readonly anchor: 'turn' | 'none';
}

/** Conversation roles do not constrain structural or provider-specific rows. */
export interface SessionMessageRow<Payloads extends object> extends SessionRowBase<Payloads> {
  readonly kind: 'message';
  readonly role: 'user' | 'assistant' | 'developer';
  readonly label?: string;
}

/** Native structure is represented directly, rather than disguised as assistant text. */
export interface SessionStructuralRow<Payloads extends object> extends SessionRowBase<Payloads> {
  readonly kind: 'structural';
  readonly label: string;
  readonly tone: 'info' | 'error' | 'boundary';
}

/** Provider rows preserve typed information that shared row kinds cannot express. */
export type SessionProviderRow<Payloads extends object> = {
  [Kind in keyof Payloads & string]: SessionRowBase<Payloads> & {
    readonly kind: 'provider';
    readonly providerKind: Kind;
    readonly data: Payloads[Kind];
  };
}[keyof Payloads & string];

/** Cards-owned display rows in native source order. */
export type SessionRow<Payloads extends object = Record<string, unknown>> =
  | SessionMessageRow<Payloads>
  | SessionStructuralRow<Payloads>
  | SessionProviderRow<Payloads>;

/** Provider-derived header facts are display information, never interaction authority. */
export interface SessionHeaderFacts {
  readonly provider?: string;
  readonly threadId?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly status?: 'running' | 'done' | 'error';
  readonly agentId?: string;
  readonly title?: string;
}

/** Projection owns one source; content may compose multiple such projections. */
export interface SessionProjection<Payloads extends object = Record<string, unknown>> {
  readonly sourceKey: TranscriptSourceKey;
  readonly generation: TranscriptGeneration;
  readonly rows: readonly SessionRow<Payloads>[];
  readonly header: SessionHeaderFacts;
}

/** Evidence-backed insertion or explicit session section, supplied by the caller. */
export interface SessionInsertion {
  readonly placementId: SessionIdentity;
  readonly childSourceKey: TranscriptSourceKey;
  readonly label: string;
  readonly placement:
    | {
        readonly kind: 'witnessed';
        readonly parentSourceKey: TranscriptSourceKey;
        readonly rowId: SessionIdentity;
        readonly partId?: SessionIdentity;
        readonly position: 'before' | 'after';
      }
    | { readonly kind: 'section'; readonly position: 'start' | 'end' };
}

/** Controlled state lives outside rows and survives regrouping or remounting. */
export interface SessionDisclosureState {
  readonly open: ReadonlyMap<SessionIdentity, boolean>;
  readonly onOpenChange: (id: SessionIdentity, open: boolean) => void;
}

/** A surviving leaf plus pixel offset supports parent-owned position restoration. */
export interface SessionStableAnchor {
  readonly id: SessionIdentity;
  readonly offset: number;
}

/** Layout notifications bracket controlled disclosure and report delayed content sizing. */
export interface SessionLayoutHooks {
  readonly onBeforeLayoutChange?: (id: SessionIdentity) => void;
  readonly onAfterLayoutChange?: (id: SessionIdentity) => void;
  readonly onAnchorElement?: (id: SessionIdentity, element: HTMLElement | null) => void;
  readonly onFocusChange?: (id: SessionIdentity | null) => void;
}

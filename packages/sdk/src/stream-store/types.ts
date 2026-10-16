/**
 * Session-scoped bridge protocol and renderer store state.
 *
 * One renderer iframe displays one host-bound session. The host owns membership
 * and authoritative source reads (via the stream-session controller); the
 * renderer requests exact member sources in `tail` or `full` history mode and
 * merges host-forwarded native lines only within the authoritative source
 * version and routing binding that established them. Every message carries the
 * view generation so a rebuilt or switched view never applies stale traffic.
 *
 * @summary Session bridge messages and stream store state
 * @module stream-store/types
 */

import type {
  SessionDescriptor,
  SessionMember,
  StreamMeta,
  StreamSessionRef,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceVersion
} from '../protocol/types/stream.js';

// ============================================================================
// Bounds
// ============================================================================

/** Trailing complete lines a `tail` history request covers and a tail-mode source retains. */
export const TAIL_HISTORY_LINES = 50;

/** Maximum native lines one `source:append` message may carry. */
export const MAX_APPEND_LINES = 1000;

/** Maximum pending live events buffered per session while sources reconcile. */
export const MAX_PENDING_EVENTS = 1000;

/** Maximum pending live bytes (UTF-8 of native lines) buffered per session while sources reconcile. */
export const MAX_PENDING_BYTES = 1_048_576;

/** Maximum identifier length for generations, request IDs, and layout tokens. */
export const MAX_TOKEN_LENGTH = 256;

/** Largest accepted measured renderer height in CSS pixels. */
export const MAX_LAYOUT_HEIGHT = 100_000;

/** Largest accepted absolute scroll delta per `layout:scroll` message in CSS pixels. */
export const MAX_SCROLL_DELTA = 10_000;

// ============================================================================
// Shared vocabulary
// ============================================================================

/** Host-selected display mode for a stream iframe. */
export type StreamDisplayMode = 'compact' | 'expanded';

/** Requested native history coverage; `full` is never downgraded by a later `tail` request. */
export type StreamHistoryMode = 'tail' | 'full';

/** Authority stamped on every source content and lifecycle message. */
export interface StreamSourceAuthorityStamp {
  /** Exact logical source. */
  source: StreamSourceRef;
  /** Authoritative server incarnation. */
  version: StreamSourceVersion;
  /** Routing identity accepted with the publication. */
  binding: StreamSourceBinding;
}

/** Typed source load failure; identifiers only, never native content or filesystem paths. */
export type StreamSourceLoadError =
  | 'not-found'
  | 'load-error'
  | 'membership-error'
  | 'inconsistent-source'
  | 'resync-overflow'
  | 'rejected-scope';

/** Transport connection state, separate from agent execution state. */
export type StreamConnectionState = 'connected' | 'disconnected' | 'resynchronizing';

/** Invalidation reasons mirrored from the server source authority. */
export type StreamSourceInvalidationReason = 'replaced' | 'removed' | 'binding-changed' | 'server-restarted';

/**
 * Scroll commands a renderer may ask the host to apply to its outer timeline.
 * Deltas are finite and bounded by {@link MAX_SCROLL_DELTA}; keys name the
 * navigation intent, never arbitrary DOM operations.
 */
export type LayoutScrollCommand =
  | { kind: 'delta'; deltaY: number }
  | { kind: 'key'; key: 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'start' | 'end' };

// ============================================================================
// Initialization
// ============================================================================

/**
 * Data set on `window.__STREAM_INIT__` by the host before loading the iframe.
 * Content never travels through init; sources load through subscription.
 */
export interface StreamInitData {
  /** Host-bound session; renderer messages cannot change it. */
  session: StreamSessionRef;
  /** View generation for this iframe load; every message is correlated to it. */
  generation: string;
  /** Initial accepted membership. */
  descriptor: SessionDescriptor;
  /** Positive descriptor revision; later updates must strictly increase it. */
  revision: number;
  /** Host-selected display mode. */
  mode: StreamDisplayMode;
}

// ============================================================================
// Host -> renderer messages
// ============================================================================

/** Accepted membership update; ignored unless `revision` exceeds the current one. */
export interface SessionUpdateMessage {
  type: 'session:update';
  generation: string;
  revision: number;
  descriptor: SessionDescriptor;
}

/**
 * Coherent source snapshot answering the renderer's current subscription.
 * `firstLineNumber + lines.length === totalLineCount + 1`; an empty snapshot
 * uses `firstLineNumber === totalLineCount + 1`.
 */
export interface SourceSnapshotMessage extends StreamSourceAuthorityStamp {
  type: 'source:snapshot';
  generation: string;
  /** Correlates to the renderer's latest `source:subscribe` for this source. */
  requestId: string;
  /** Source metadata from the same accepted read; `lineCount === totalLineCount`. */
  meta: StreamMeta;
  /** Unmodified native lines without newline delimiters. */
  lines: string[];
  /** One-based absolute coordinate of `lines[0]`. */
  firstLineNumber: number;
  /** Complete source line count. */
  totalLineCount: number;
}

/** Typed failure answering the renderer's current subscription. */
export interface SourceErrorMessage {
  type: 'source:error';
  generation: string;
  requestId: string;
  source: StreamSourceRef;
  error: StreamSourceLoadError;
}

/** Contiguous live native lines starting at `firstLineNumber`. */
export interface SourceAppendMessage extends StreamSourceAuthorityStamp {
  type: 'source:append';
  generation: string;
  /** One-based absolute coordinate of `lines[0]`. */
  firstLineNumber: number;
  /** One to {@link MAX_APPEND_LINES} native lines. */
  lines: string[];
}

/** Source lifecycle; `ended` means "refresh membership", not deletion or success. */
export interface SourceLifecycleMessage extends StreamSourceAuthorityStamp {
  type: 'source:lifecycle';
  generation: string;
  state: 'started' | 'resumed' | 'ended';
  /** Complete source line count at the transition. */
  totalLineCount: number;
}

/** Retires the stamped version before any successor content. */
export interface SourceInvalidatedMessage extends StreamSourceAuthorityStamp {
  type: 'source:invalidated';
  generation: string;
  reason: StreamSourceInvalidationReason;
}

/** Transport state from the host; never agent running/idle state. */
export interface ConnectionStateMessage {
  type: 'connection:state';
  generation: string;
  state: StreamConnectionState;
}

/** Theme propagation from the host. */
export interface ThemeChangeMessage {
  type: 'theme:change';
  generation: string;
  themeKind: 1 | 2 | 3;
  cssVariables: Record<string, string>;
}

/** New-token layout handshake sent on each iframe load or retry. */
export interface LayoutHandshakeMessage {
  type: 'layout:handshake';
  generation: string;
  /** Fresh token; `layout:ready`/`layout:size`/`layout:scroll` must echo it. */
  token: string;
}

/** Messages sent from the host to the renderer. */
export type HostToRendererMessage =
  | SessionUpdateMessage
  | SourceSnapshotMessage
  | SourceErrorMessage
  | SourceAppendMessage
  | SourceLifecycleMessage
  | SourceInvalidatedMessage
  | ConnectionStateMessage
  | ThemeChangeMessage
  | LayoutHandshakeMessage;

// ============================================================================
// Renderer -> host messages
// ============================================================================

/** Requests an exact member source; each request supersedes the source's prior request. */
export interface SourceSubscribeMessage {
  type: 'source:subscribe';
  generation: string;
  requestId: string;
  source: StreamSourceRef;
  history: StreamHistoryMode;
}

/** Stops live delivery for an exact member source. */
export interface SourceUnsubscribeMessage {
  type: 'source:unsubscribe';
  generation: string;
  source: StreamSourceRef;
}

/** Explicit user retry: membership refresh plus resynchronization of paused sources. */
export interface SessionResyncMessage {
  type: 'session:resync';
  generation: string;
}

/** Requests the host to close this renderer. */
export interface CloseMessage {
  type: 'close';
  generation: string;
}

/** Requests the host to open a workspace file. */
export interface OpenFileMessage {
  type: 'openFile';
  generation: string;
  path: string;
  line?: number;
}

/** Requests the host to show a commit diff. */
export interface ShowDiffMessage {
  type: 'showDiff';
  generation: string;
  sha: string;
  filePath?: string;
}

/** Renderer acknowledges the current layout handshake. */
export interface LayoutReadyMessage {
  type: 'layout:ready';
  generation: string;
  token: string;
}

/** Measured content height; `revision` strictly increases per token. */
export interface LayoutSizeMessage {
  type: 'layout:size';
  generation: string;
  token: string;
  /** Positive layout revision. */
  revision: number;
  /** Positive integer CSS pixels, at most {@link MAX_LAYOUT_HEIGHT}. */
  height: number;
}

/** Requests the host to scroll the outer timeline. */
export interface LayoutScrollMessage {
  type: 'layout:scroll';
  generation: string;
  token: string;
  command: LayoutScrollCommand;
}

/** Messages sent from the renderer to the host. */
export type RendererToHostMessage =
  | SourceSubscribeMessage
  | SourceUnsubscribeMessage
  | SessionResyncMessage
  | CloseMessage
  | OpenFileMessage
  | ShowDiffMessage
  | LayoutReadyMessage
  | LayoutSizeMessage
  | LayoutScrollMessage;

/** Layout bridge subset of {@link RendererToHostMessage}. */
export type LayoutRendererMessage = LayoutReadyMessage | LayoutSizeMessage | LayoutScrollMessage;

/** Exact-shape validation outcome; `reason` is an identifier-only rejection code. */
export type MessageValidation<T> = { ok: true; message: T } | { ok: false; reason: string };

// ============================================================================
// Store state
// ============================================================================

/** Renderer-visible subscription state for one source. */
export type StreamSourceStatus = 'unsubscribed' | 'loading' | 'ready' | 'resynchronizing' | 'paused' | 'unavailable';

/** One native source within the bound session, keyed by its exact JSON tuple key. */
export interface StreamSourceView {
  /** Exact source identity. */
  source: StreamSourceRef;
  /** Current membership entry, or null when retained only as unavailable history. */
  member: SessionMember | null;
  /** Authority that established `lines`, or null before/after an accepted version. */
  authority: StreamSourceAuthorityStamp | null;
  /** Metadata from the last accepted snapshot or lifecycle update. */
  meta: StreamMeta | null;
  /** Contiguous native lines. */
  lines: string[];
  /** One-based coordinate of `lines[0]`; `totalLineCount + 1` when empty. */
  firstLineNumber: number;
  /** Last known complete source line count. */
  totalLineCount: number;
  /** Whether earlier content exists that is not loaded (`firstLineNumber > 1`). */
  earlierUnloaded: boolean;
  /** Requested coverage. */
  history: StreamHistoryMode;
  /** Explicit subscription state. */
  status: StreamSourceStatus;
  /** Current request correlation, or null when unsubscribed. */
  requestId: string | null;
  /** Local reconciliation epoch; increments on invalidation, removal, and readdition. */
  reconciliationEpoch: number;
  /** Identifier-only failure, or null. */
  error: StreamSourceLoadError | null;
}

/** Renderer store state for one host-bound session. */
export interface StreamStoreState {
  /** Host-bound session. */
  session: StreamSessionRef;
  /** Current view generation. */
  generation: string;
  /** Latest accepted descriptor revision. */
  revision: number;
  /** Latest accepted membership. */
  descriptor: SessionDescriptor;
  /** Host-selected display mode. */
  mode: StreamDisplayMode;
  /** Transport state. */
  connection: StreamConnectionState;
  /** Member and retained sources keyed by exact JSON tuple key. */
  sources: ReadonlyMap<string, StreamSourceView>;
  /** Current layout handshake token, or null before the first handshake. */
  layoutToken: string | null;
}

/** Identifier-only renderer diagnostics. */
export interface StreamStoreDiagnostic {
  code: 'rejected-message' | 'stale-response' | 'source-reset' | 'resync-overflow' | 'inconsistent-source';
  source?: StreamSourceRef;
  requestId?: string;
  reason?: string;
}

/** Transport and identity dependencies for one renderer store. */
export interface StreamStoreOptions {
  /** Host-provided initialization. */
  init: StreamInitData;
  /** Posts a validated message to the host. */
  post(message: RendererToHostMessage): void;
  /** Registers a raw inbound-message listener and returns its removal. */
  listen(listener: (data: unknown) => void): () => void;
  /** Unique request identity factory; defaults to `crypto.randomUUID`. */
  createRequestId?(): string;
  /** Optional identifier-only diagnostic sink. */
  diagnostic?(event: StreamStoreDiagnostic): void;
  /** Applies a validated theme; omitted outside a DOM. */
  applyTheme?(themeKind: 1 | 2 | 3, cssVariables: Record<string, string>): void;
}

/** Renderer-facing store handle with session-correlated actions. */
export interface StreamRendererStore {
  /** Subscribes React/vanilla consumers to state. */
  subscribe(listener: (state: StreamStoreState, previous: StreamStoreState) => void): () => void;
  /** Current immutable state. */
  getState(): StreamStoreState;
  /** Requests an exact current member in the given history mode; `full` upgrades a `tail`. */
  subscribeSource(source: StreamSourceRef, history: StreamHistoryMode): void;
  /** Stops live delivery for a source and cancels its pending request. */
  unsubscribeSource(source: StreamSourceRef): void;
  /** Explicit retry for paused sources and membership. */
  retry(): void;
  /** Requests the host to close the renderer. */
  close(): void;
  /** Requests the host to open a file. */
  openFile(path: string, line?: number): void;
  /** Requests the host to show a diff. */
  showDiff(sha: string, filePath?: string): void;
  /** Posts a layout message correlated with the current generation and handshake token. */
  postLayout(message: LayoutPayload): void;
  /** Removes listeners and suppresses all later traffic. */
  dispose(): void;
}

/** Layout message body without the correlation the store stamps. */
export type LayoutPayload =
  | { type: 'layout:ready' }
  | { type: 'layout:size'; revision: number; height: number }
  | { type: 'layout:scroll'; command: LayoutScrollCommand };

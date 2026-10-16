/**
 * Renderer-independent subscription boundary for authenticated session hosts.
 * @summary Injected native transcript session controller contracts
 * @module stream-session/controller
 */

import type {
  SessionDescriptor,
  StreamMeta,
  StreamSessionRef,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceSnapshot,
  StreamSourceVersion
} from '../protocol/types/stream.js';
import { createController } from './runtime.js';

/** Requested native history coverage; full coverage cannot be downgraded by a delayed tail. */
export type SessionHistoryMode = 'tail' | 'full';

/** Correlation attached to every source operation and response. */
export interface SessionSourceRequest {
  /** Exact trusted source. */
  source: StreamSourceRef;
  /** Requested history coverage. */
  mode: SessionHistoryMode;
  /** Unique operation identity. */
  requestId: string;
  /** Current view generation. */
  generation: string;
}

/** Authenticated host adapter; cancellation is optional but stale completion fencing is mandatory. */
export interface SessionClient {
  /** Lists current metadata for the trusted card. */
  listStreams(cardId: string, signal: AbortSignal): Promise<StreamMeta[]>;
  /** Reads coherent authority-bearing native history; may reject with a classified {@link SessionSourceError}. */
  getStream(source: StreamSourceRef, mode: SessionHistoryMode, signal: AbortSignal): Promise<StreamSourceSnapshot>;
}

/** Authority required on every accepted live source event. */
export interface SessionSourceAuthority {
  /** Exact logical source. */
  source: StreamSourceRef;
  /** Accepted server incarnation. */
  version: StreamSourceVersion;
  /** Routing identity accepted with the publication. */
  binding: StreamSourceBinding;
}

/** Host-adapted stream events; invalidation precedes publication from a new incarnation. */
export type SessionSourceEvent = SessionSourceAuthority &
  (
    | { type: 'append'; lineNumber: number; line: string }
    | { type: 'started' | 'resumed' | 'ended'; totalLineCount: number }
    | { type: 'invalidated'; reason: 'replaced' | 'removed' | 'binding-changed' | 'server-restarted' }
  );

/** External triggers supplied by either private host. */
export type SessionControllerEvent =
  | SessionSourceEvent
  | { type: 'connection'; connected: boolean }
  | { type: 'refresh'; cardId: string; reason: 'commit' | 'focus' | 'retry' };

/** Event subscription installed before any metadata or history request. */
export interface SessionEventSource {
  /** Registers a listener and returns its disposal function. */
  subscribe(listener: (event: SessionControllerEvent) => void): () => void;
}

/** Injectable scheduler allows deterministic timer and reconciliation race tests. */
export interface SessionScheduler {
  /** Schedules recurring 30-second membership reconciliation and returns cancellation. */
  every(milliseconds: number, callback: () => void): () => void;
  /** Schedules one bounded read-retry backoff and returns cancellation. */
  after(milliseconds: number, callback: () => void): () => void;
}

/** Stable source state, including retained unavailable historical content. */
export interface SessionSourceState {
  /** Exact native source. */
  source: StreamSourceRef;
  /** Current accepted authority, absent until a coherent snapshot establishes it. */
  authority: SessionSourceAuthority | null;
  /** Accepted source metadata for provider projection, absent before the first accepted read. */
  meta: StreamMeta | null;
  /** Contiguous native source history. */
  lines: string[];
  /** One-based head coordinate, or totalLineCount + 1 for empty content. */
  firstLineNumber: number;
  /** Complete source line count. */
  totalLineCount: number;
  /** Current eligible membership, distinct from retained historical data. */
  available: boolean;
  /** Whether this source is subscribed. */
  subscribed: boolean;
  /** Current source reconciliation epoch. */
  reconciliationEpoch: number;
  /** Current renderer subscription correlation; automatic refetches retain this identity. */
  requestId: string | null;
  /** Requested history coverage. */
  mode: SessionHistoryMode;
  /** Explicit loading or paused synchronization state. */
  status: 'loading' | 'ready' | 'resynchronizing' | 'paused' | 'unavailable';
  /** Identifier-only failure reason; native content is excluded. */
  error: string | null;
}

/** Defensively copied publication from one controller generation; consumer mutations cannot affect controller state. */
export interface SessionControllerState {
  /** Trusted session scope. */
  session: StreamSessionRef;
  /** Current host-selected view generation. */
  generation: string;
  /** Increasing accepted membership revision. */
  revision: number;
  /** Latest accepted membership, including visible main anomalies. */
  descriptor: SessionDescriptor;
  /** Native source states keyed by exact JSON tuple key. */
  sources: ReadonlyMap<string, SessionSourceState>;
  /** Transport state, never agent execution state. */
  connected: boolean;
}

/** Concise diagnostics that never contain native transcript contents. */
export interface SessionDiagnostic {
  /** Stable failure category. */
  code:
    | 'rejected-scope'
    | 'load-error'
    | 'read-retry'
    | 'source-reset'
    | 'resync-overflow'
    | 'stale-response'
    | 'inconsistent-source';
  /** Trusted session identity. */
  session: StreamSessionRef;
  /** Relevant source, if known. */
  source?: StreamSourceRef;
  /** Correlated operation, if any. */
  requestId?: string;
}

/** Dependencies and lifetime identity fixed when constructing one controller. */
export interface SessionControllerOptions {
  /** Host-bound session; renderer input cannot replace this scope. */
  session: StreamSessionRef;
  /** New token for every switched or rebuilt view. */
  generation: string;
  /** Authenticated source API. */
  client: SessionClient;
  /** Native publication and connection events. */
  events: SessionEventSource;
  /** Host timer adapter. */
  scheduler: SessionScheduler;
  /** Accepted state publication callback. */
  publish(state: SessionControllerState): void;
  /** Optional identifier-only diagnostics callback. */
  diagnostic?(event: SessionDiagnostic): void;
}

/** One host-bound session lifetime, independent of rendering and DOM globals. */
export interface SessionController {
  /** Installs listeners before starting the initial single-flight membership refresh. */
  start(): void;
  /** Requests an exact current member; rejects stale generation or invalid request shape. */
  subscribe(request: SessionSourceRequest): void;
  /** Cancels source work and stops live delivery for an exact current member. */
  unsubscribe(source: StreamSourceRef, generation: string): void;
  /** Requests membership reconciliation; coalesces active reads with a dirty-again flag. */
  refresh(): void;
  /** Returns a defensive copy of the most recent accepted state, including nested metadata and line arrays. */
  getState(): SessionControllerState;
  /** Aborts pending work, invalidates completions, and removes listeners and timers. */
  dispose(): void;
}

/**
 * Creates a bounded, version-fenced native source session controller.
 *
 * Live buffering is bounded to 1,000 events or 1 MiB and history concurrency to
 * four reads. New incarnations require authoritative full snapshots. Each
 * operation is fenced by session, generation, source reconciliation epoch,
 * request identity, and request-start baseline.
 * @param _options - Trusted lifetime scope and injected host dependencies.
 * @throws Error when the trusted session scope or generation is invalid.
 * @returns A controller that performs no work until started.
 */
export function createSessionController(_options: SessionControllerOptions): SessionController {
  return createController(_options);
}

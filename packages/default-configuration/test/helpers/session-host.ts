/**
 * A real SDK session store over a synchronous in-memory host transport, so renderer tests
 * exercise the exact subscribe/snapshot/append protocol the iframe receives.
 * @summary In-memory session host for renderer tests
 * @module test/helpers/session-host
 */

import type {
  SessionDescriptor,
  SessionMember,
  StreamMeta,
  StreamSourceBinding,
  StreamSourceRef
} from '@cards.management/sdk/protocol';
import {
  createStreamStore,
  type HostToRendererMessage,
  type RendererToHostMessage,
  type SourceSubscribeMessage,
  type StreamDisplayMode,
  type StreamRendererStore,
  type StreamViewState
} from '@cards.management/sdk/stream-store';

/** One declared session member. */
export interface HostMember {
  readonly relPath: string;
  readonly role: SessionMember['role'];
  readonly agentId?: string;
}

/** Options for a session host. */
export interface SessionHostOptions {
  readonly streamType: string;
  readonly runtime: string;
  readonly sessionId?: string;
  readonly members: readonly HostMember[];
  readonly mode?: StreamDisplayMode;
  /** View state the host replays from a previous renderer. */
  readonly viewState?: StreamViewState;
}

/** Captured host traffic and helpers to drive the store as the host would. */
export interface SessionHost {
  readonly store: StreamRendererStore;
  readonly sent: RendererToHostMessage[];
  /** Source ref for a member path. */
  ref(relPath: string): StreamSourceRef;
  /** Store key for a member path. */
  key(relPath: string): string;
  /** Subscribe requests the renderer sent for a member path. */
  subscribes(relPath: string): SourceSubscribeMessage[];
  /** Answers the latest subscribe for a member with a coherent snapshot. */
  snapshot(relPath: string, lines: readonly string[], options?: { first?: number; isActive?: boolean }): void;
  /** Delivers a live append continuing at `first`. */
  append(relPath: string, first: number, lines: readonly string[]): void;
  /** Delivers an activity transition at the source's complete line count. */
  lifecycle(relPath: string, state: 'started' | 'resumed' | 'ended', totalLineCount: number): void;
  /** Delivers any host message. */
  deliver(message: HostToRendererMessage): void;
}

/**
 * Creates a store bound to an in-memory host for one session.
 * @param options - Session identity, members and display mode.
 * @returns Host harness.
 */
export function createSessionHost(options: SessionHostOptions): SessionHost {
  const cardId = 'card-1';
  const sessionId = options.sessionId ?? 'session-1';
  const generation = 'gen-1';
  const version = { serverEpoch: 'server-1', sourceEpoch: 'source-1' };
  const sent: RendererToHostMessage[] = [];
  const listeners = new Set<(data: unknown) => void>();
  const ref = (relPath: string): StreamSourceRef => ({ cardId, streamType: options.streamType, relPath });
  const member = (relPath: string): HostMember => {
    const found = options.members.find((candidate) => candidate.relPath === relPath);
    if (!found) throw new Error(`Unknown member ${relPath}`);
    return found;
  };
  const binding = (relPath: string): StreamSourceBinding => {
    const { role, agentId } = member(relPath);
    return { sessionId, role, ...(agentId === undefined ? {} : { agentId }) };
  };
  const meta = (relPath: string, lineCount: number, isActive: boolean): StreamMeta => ({
    version: 1,
    relPath,
    streamType: options.streamType,
    runtime: options.runtime,
    ...binding(relPath),
    sourcePath: `/native/${relPath}`,
    startedAt: '2026-01-01T00:00:00.000Z',
    lineCount,
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive
  });
  const members: SessionMember[] = options.members.map(({ relPath, role, agentId }) => ({
    source: ref(relPath),
    role,
    ...(agentId === undefined ? {} : { agentId })
  }));
  const mains = members.filter((candidate) => candidate.role === 'main');
  const descriptor: SessionDescriptor = {
    session: { cardId, streamType: options.streamType, sessionId },
    members,
    main: mains.length === 1 ? mains[0]!.source : null,
    validity: mains.length === 1 ? 'ready' : mains.length === 0 ? 'missing-main' : 'conflicting-main'
  };
  let counter = 0;
  const store = createStreamStore({
    init: {
      session: descriptor.session,
      generation,
      descriptor,
      revision: 1,
      mode: options.mode ?? 'expanded',
      ...(options.viewState ? { viewState: options.viewState } : {})
    },
    post: (message) => sent.push(structuredClone(message)),
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createRequestId: () => `req-${++counter}`
  });
  const deliver = (message: HostToRendererMessage): void => {
    for (const listener of [...listeners]) listener(structuredClone(message));
  };
  const subscribes = (relPath: string): SourceSubscribeMessage[] =>
    sent.filter(
      (message): message is SourceSubscribeMessage =>
        message.type === 'source:subscribe' && message.source.relPath === relPath
    );
  return {
    store,
    sent,
    ref,
    key: (relPath) => JSON.stringify([cardId, options.streamType, relPath]),
    subscribes,
    snapshot(relPath, lines, { first = 1, isActive = true } = {}) {
      const request = subscribes(relPath).at(-1);
      if (!request) throw new Error(`No subscribe sent for ${relPath}`);
      const total = first + lines.length - 1;
      deliver({
        type: 'source:snapshot',
        generation,
        requestId: request.requestId,
        source: ref(relPath),
        version,
        binding: binding(relPath),
        meta: meta(relPath, total, isActive),
        lines: [...lines],
        firstLineNumber: first,
        totalLineCount: total
      });
    },
    append(relPath, first, lines) {
      deliver({
        type: 'source:append',
        generation,
        source: ref(relPath),
        version,
        binding: binding(relPath),
        firstLineNumber: first,
        lines: [...lines]
      });
    },
    lifecycle(relPath, state, totalLineCount) {
      deliver({
        type: 'source:lifecycle',
        generation,
        source: ref(relPath),
        version,
        binding: binding(relPath),
        state,
        totalLineCount
      });
    },
    deliver
  };
}

/**
 * Shared session, source, and in-memory transport fixtures for stream-store tests.
 * @summary Stream store test fixtures
 */

import type {
  SessionDescriptor,
  SessionMember,
  StreamMeta,
  StreamSessionRef,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceVersion
} from '../../src/protocol/types/stream.js';
import { createStreamStore } from '../../src/stream-store/store.js';
import type {
  HostToRendererMessage,
  RendererToHostMessage,
  SourceAppendMessage,
  SourceSnapshotMessage,
  SourceSubscribeMessage,
  StreamDisplayMode,
  StreamInitData,
  StreamRendererStore,
  StreamStoreDiagnostic,
  StreamViewState
} from '../../src/stream-store/types.js';

export const session: StreamSessionRef = { cardId: 'card-1', streamType: 'claude-code-session', sessionId: 's1' };
export const main: StreamSourceRef = { cardId: 'card-1', streamType: 'claude-code-session', relPath: 's1.jsonl' };
export const child: StreamSourceRef = {
  cardId: 'card-1',
  streamType: 'claude-code-session',
  relPath: 's1/subagents/agent-a.jsonl'
};
export const v1: StreamSourceVersion = { serverEpoch: 'server-1', sourceEpoch: 'source-1' };
export const v2: StreamSourceVersion = { serverEpoch: 'server-1', sourceEpoch: 'source-2' };
export const mainBinding: StreamSourceBinding = { sessionId: 's1', role: 'main' };
export const childBinding: StreamSourceBinding = { sessionId: 's1', role: 'subagent', agentId: 'agent-a' };
export const generation = 'gen-1';

export const mainMember: SessionMember = { source: main, role: 'main' };
export const childMember: SessionMember = { source: child, role: 'subagent', agentId: 'agent-a' };

/**
 * Builds a descriptor for the fixture session.
 * @param members - Ordered members.
 * @returns Descriptor with a main only when exactly one member is main.
 */
export function descriptor(...members: SessionMember[]): SessionDescriptor {
  const mains = members.filter((member) => member.role === 'main');
  return {
    session,
    members,
    main: mains.length === 1 && mains[0] ? mains[0].source : null,
    validity: mains.length === 1 ? 'ready' : mains.length === 0 ? 'missing-main' : 'conflicting-main'
  };
}

/**
 * Builds source metadata consistent with a binding and line count.
 * @param source - Source identity.
 * @param binding - Routing binding.
 * @param lineCount - Complete line count.
 * @returns Stream metadata.
 */
export function meta(source: StreamSourceRef, binding: StreamSourceBinding, lineCount: number): StreamMeta {
  return {
    version: 1,
    relPath: source.relPath,
    streamType: source.streamType,
    runtime: 'claude-code',
    sessionId: binding.sessionId,
    role: binding.role,
    ...(binding.agentId === undefined ? {} : { agentId: binding.agentId }),
    sourcePath: `/native/${source.relPath}`,
    startedAt: '2026-01-01T00:00:00Z',
    lineCount,
    createdAt: '2026-01-01T00:00:00Z',
    isActive: true
  };
}

/**
 * Builds a coherent snapshot message ending at `first + lines.length - 1`.
 * @param options - Snapshot fields.
 * @param options.source - Source identity.
 * @param options.version - Source version.
 * @param options.binding - Routing binding.
 * @param options.requestId - Correlated request.
 * @param options.first - First absolute coordinate.
 * @param options.lines - Native lines.
 * @param options.generation - View generation override.
 * @returns Snapshot message.
 */
export function snapshot(options: {
  source?: StreamSourceRef;
  version?: StreamSourceVersion;
  binding?: StreamSourceBinding;
  requestId: string;
  first?: number;
  lines: string[];
  generation?: string;
}): SourceSnapshotMessage {
  const source = options.source ?? main;
  const binding = options.binding ?? (source === child ? childBinding : mainBinding);
  const first = options.first ?? 1;
  const total = first + options.lines.length - 1;
  return {
    type: 'source:snapshot',
    generation: options.generation ?? generation,
    requestId: options.requestId,
    source,
    version: options.version ?? v1,
    binding,
    meta: meta(source, binding, total),
    lines: options.lines,
    firstLineNumber: first,
    totalLineCount: total
  };
}

/**
 * Builds a live append message.
 * @param first - First absolute coordinate.
 * @param lines - Native lines.
 * @param options - Authority overrides.
 * @param options.source - Source identity.
 * @param options.version - Source version.
 * @param options.binding - Routing binding.
 * @returns Append message.
 */
export function append(
  first: number,
  lines: string[],
  options: { source?: StreamSourceRef; version?: StreamSourceVersion; binding?: StreamSourceBinding } = {}
): SourceAppendMessage {
  const source = options.source ?? main;
  return {
    type: 'source:append',
    generation,
    source,
    version: options.version ?? v1,
    binding: options.binding ?? (source === child ? childBinding : mainBinding),
    firstLineNumber: first,
    lines
  };
}

/** In-memory transport harness around a real store. */
export interface Harness {
  store: StreamRendererStore;
  sent: RendererToHostMessage[];
  diagnostics: StreamStoreDiagnostic[];
  themes: Array<{ themeKind: 1 | 2 | 3; cssVariables: Record<string, string> }>;
  deliver(message: HostToRendererMessage | unknown): void;
  subscribes(source?: StreamSourceRef): SourceSubscribeMessage[];
  lastRequestId(source?: StreamSourceRef): string;
  listeners(): number;
}

/**
 * Creates a store over a synchronous in-memory transport.
 * @param options - Init overrides.
 * @param options.mode - Display mode.
 * @param options.descriptor - Initial membership.
 * @param options.viewState - Restored view state.
 * @returns Harness with captured traffic.
 */
export function harness(
  options: { mode?: StreamDisplayMode; descriptor?: SessionDescriptor; viewState?: StreamViewState } = {}
): Harness {
  const sent: RendererToHostMessage[] = [];
  const diagnostics: StreamStoreDiagnostic[] = [];
  const themes: Harness['themes'] = [];
  const listeners = new Set<(data: unknown) => void>();
  let counter = 0;
  const init: StreamInitData = {
    session,
    generation,
    descriptor: options.descriptor ?? descriptor(mainMember, childMember),
    revision: 1,
    mode: options.mode ?? 'compact',
    ...(options.viewState ? { viewState: options.viewState } : {})
  };
  const store = createStreamStore({
    init,
    post: (message) => sent.push(structuredClone(message)),
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createRequestId: () => `req-${++counter}`,
    diagnostic: (event) => diagnostics.push(event),
    applyTheme: (themeKind, cssVariables) => themes.push({ themeKind, cssVariables })
  });
  const subscribes = (source: StreamSourceRef = main): SourceSubscribeMessage[] =>
    sent.filter(
      (message): message is SourceSubscribeMessage =>
        message.type === 'source:subscribe' && message.source.relPath === source.relPath
    );
  return {
    store,
    sent,
    diagnostics,
    themes,
    deliver: (message) => {
      for (const listener of [...listeners]) listener(structuredClone(message));
    },
    subscribes,
    lastRequestId: (source = main) => {
      const last = subscribes(source).at(-1);
      if (!last) throw new Error('No subscribe sent');
      return last.requestId;
    },
    listeners: () => listeners.size
  };
}

/**
 * JSON source key used by the store's `sources` map.
 * @param source - Source identity.
 * @returns Exact tuple key.
 */
export const key = (source: StreamSourceRef): string =>
  JSON.stringify([source.cardId, source.streamType, source.relPath]);

/**
 * Host half of the session renderer bridge. Owns one session controller for
 * one view generation and projects its accepted state onto the renderer
 * protocol: correlated snapshots answer subscriptions, later growth becomes
 * bounded appends, activity changes become lifecycle messages, and a replaced
 * incarnation is invalidated before any successor content. Renderer messages
 * are validated and checked against the host-bound session's exact membership;
 * renderer-supplied card or session fields never widen that scope.
 * @summary Session host bridge between the controller and one renderer
 * @module stream-bridge/host
 */

import type {
  StreamMeta,
  StreamSessionRef,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceVersion
} from '../protocol/types/stream.js';
import {
  createSessionController,
  type SessionClient,
  type SessionControllerEvent,
  type SessionControllerState,
  type SessionDiagnostic,
  type SessionEventSource,
  type SessionScheduler,
  type SessionSourceState,
  streamSourceKey
} from '../stream-session/index.js';
import {
  type CloseMessage,
  type HostToRendererMessage,
  type LayoutHandshakeMessage,
  type LayoutRendererMessage,
  MAX_APPEND_LINES,
  type OpenFileMessage,
  type ShowDiffMessage,
  type StreamDisplayMode,
  type StreamInitData,
  type StreamSourceInvalidationReason,
  type StreamSourceLoadError,
  type ThemeChangeMessage
} from '../stream-store/types.js';
import { validateHostMessage, validateRendererMessage } from '../stream-store/validate.js';

/** Renderer actions the host performs on the user's behalf after validation. */
export type StreamHostAction = CloseMessage | OpenFileMessage | ShowDiffMessage;

/** Host-originated messages that are not projections of controller state. */
export type StreamHostSignal = ThemeChangeMessage | LayoutHandshakeMessage;

/** Identifier-only bridge diagnostic; never carries native content. */
export interface StreamBridgeDiagnostic {
  /** Controller category, or a bridge-level rejection. */
  code: SessionDiagnostic['code'] | 'rejected-message' | 'stale-generation';
  /** Relevant source, if known. */
  source?: StreamSourceRef;
  /** Correlated request, if known. */
  requestId?: string;
  /** Kebab-case rejection reason, if any. */
  reason?: string;
}

/** Dependencies and lifetime identity for one renderer load. */
export interface StreamHostBridgeOptions {
  /** Host-bound session; the renderer can never change it. */
  session: StreamSessionRef;
  /** New token for every iframe build; all traffic is correlated to it. */
  generation: string;
  /** Display mode embedded in the renderer's initialization. */
  mode: StreamDisplayMode;
  /** Authenticated source API. */
  client: SessionClient;
  /** Native publications, connection, and refresh triggers. */
  events: SessionEventSource;
  /** Host timer adapter for periodic reconciliation. */
  scheduler: SessionScheduler;
  /** Delivers a validated message to the renderer window. */
  post(message: HostToRendererMessage): void;
  /** Called once when the first membership revision is accepted and initialization is available. */
  ready?(init: StreamInitData): void;
  /** Performs a validated renderer action. */
  action?(action: StreamHostAction): void;
  /** Receives validated, generation-matched layout messages. */
  layout?(message: LayoutRendererMessage): void;
  /** Identifier-only diagnostics from the bridge and its controller. */
  diagnostic?(event: StreamBridgeDiagnostic): void;
}

/** One renderer load's host bridge. */
export interface StreamHostBridge {
  /** Starts the controller; listeners are installed before any request. */
  start(): void;
  /** Initialization for the renderer document, or null before the first accepted membership. */
  getInit(): StreamInitData | null;
  /** Marks the renderer window live (its load event) and delivers any state newer than its initialization. */
  attach(): void;
  /** Handles one untrusted message from the renderer window. */
  receive(data: unknown): void;
  /** Posts a theme or layout handshake for this generation; returns whether it was delivered. */
  signal(message: StreamHostSignal): boolean;
  /** Disposes the controller and suppresses all later traffic. */
  dispose(): void;
}

/** Forwarding state for one renderer subscription. */
interface Forwarded {
  /** Trusted member source. */
  source: StreamSourceRef;
  /** Renderer request awaiting or holding an answer; null while a fresh request is expected. */
  requestId: string | null;
  /** Whether `requestId` has been answered with a snapshot. */
  answered: boolean;
  /** Request already answered with an error, so a pause is reported once. */
  errorFor: string | null;
  /** Incarnation of the content the renderer holds. */
  version: StreamSourceVersion | null;
  /** Binding of the content the renderer holds. */
  binding: StreamSourceBinding | null;
  /** Last coordinate the renderer holds. */
  last: number;
  /** Activity last reported to the renderer. */
  active: boolean | null;
}

/** Bound on remembered invalidation reasons awaiting projection. */
const MAX_REASONS = 256;

/** Exact StreamMeta keys the renderer accepts. */
const META_KEYS = [
  'version',
  'relPath',
  'streamType',
  'runtime',
  'sessionId',
  'role',
  'agentId',
  'sourcePath',
  'startedAt',
  'title',
  'taskContent',
  'slug',
  'lineCount',
  'createdAt',
  'isActive'
] as const;

/** Controller error codes the renderer protocol carries unchanged. */
const LOAD_ERRORS: readonly StreamSourceLoadError[] = [
  'not-found',
  'load-error',
  'membership-error',
  'inconsistent-source',
  'resync-overflow',
  'rejected-scope'
];

/**
 * Compares two incarnation tokens.
 * @param a - First version.
 * @param b - Second version.
 * @returns Whether both name the same incarnation.
 */
function sameVersion(a: StreamSourceVersion, b: StreamSourceVersion): boolean {
  return a.serverEpoch === b.serverEpoch && a.sourceEpoch === b.sourceEpoch;
}

/**
 * Compares two routing bindings.
 * @param a - First binding.
 * @param b - Second binding.
 * @returns Whether both route to the same member identity.
 */
function sameBinding(a: StreamSourceBinding, b: StreamSourceBinding): boolean {
  return a.sessionId === b.sessionId && a.role === b.role && a.agentId === b.agentId;
}

/**
 * Copies a binding without materializing an absent agent identity.
 * @param binding - Accepted binding.
 * @returns Exact-shape copy.
 */
function copyBinding(binding: StreamSourceBinding): StreamSourceBinding {
  return {
    sessionId: binding.sessionId,
    role: binding.role,
    ...(binding.agentId === undefined ? {} : { agentId: binding.agentId })
  };
}

/**
 * Projects metadata onto the exact StreamMeta shape, dropping keys the renderer would reject.
 * @param meta - Accepted metadata, possibly carrying server-only keys.
 * @param lineCount - Line count consistent with the projected content.
 * @returns Exact-shape metadata.
 */
function projectMeta(meta: StreamMeta, lineCount: number): StreamMeta {
  const record = meta as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of META_KEYS) if (record[key] !== undefined) projected[key] = record[key];
  projected['lineCount'] = lineCount;
  return projected as unknown as StreamMeta;
}

/**
 * Keys a source incarnation for remembered invalidation reasons.
 * @param source - Exact source.
 * @param version - Invalidated incarnation.
 * @returns Collision-free key.
 */
function incarnationKey(source: StreamSourceRef, version: StreamSourceVersion): string {
  return JSON.stringify([streamSourceKey(source), version.serverEpoch, version.sourceEpoch]);
}

/**
 * Creates the host bridge for one renderer load of one session.
 * @param options - Trusted scope, injected host dependencies, and renderer channel.
 * @returns A bridge that performs no work until started.
 * @throws Error when the session scope or generation is invalid.
 */
export function createStreamHostBridge(options: StreamHostBridgeOptions): StreamHostBridge {
  const session = structuredClone(options.session);
  const generation = options.generation;
  const forwarded = new Map<string, Forwarded>();
  const reasons = new Map<string, StreamSourceInvalidationReason>();
  let latest: SessionControllerState | null = null;
  let live = false;
  let disposed = false;
  let announced = false;
  let sentRevision = 0;
  let connected = true;

  const events: SessionEventSource = {
    subscribe(listener: (event: SessionControllerEvent) => void) {
      return options.events.subscribe((event) => {
        if (event?.type === 'invalidated' && event.source && event.version) {
          reasons.set(incarnationKey(event.source, event.version), event.reason);
          if (reasons.size > MAX_REASONS) {
            const oldest = reasons.keys().next().value;
            if (oldest !== undefined) reasons.delete(oldest);
          }
        }
        listener(event);
      });
    }
  };

  const controller = createSessionController({
    session,
    generation,
    client: options.client,
    events,
    scheduler: options.scheduler,
    publish: (state) => sync(state),
    diagnostic: (event) =>
      options.diagnostic?.({
        code: event.code,
        ...(event.source ? { source: event.source } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {})
      })
  });

  /**
   * Validates and delivers one host message.
   * @param message - Outbound message.
   * @returns Whether it passed validation and was posted.
   */
  function post(message: HostToRendererMessage): boolean {
    if (disposed) return false;
    const result = validateHostMessage(message);
    if (!result.ok) {
      options.diagnostic?.({ code: 'rejected-message', reason: result.reason });
      return false;
    }
    options.post(message);
    return true;
  }

  /**
   * Builds initialization from accepted controller state.
   * @param state - Accepted state with a positive revision.
   * @returns Renderer initialization.
   */
  function initFrom(state: SessionControllerState): StreamInitData {
    return {
      session: structuredClone(session),
      generation,
      descriptor: structuredClone(state.descriptor),
      revision: state.revision,
      mode: options.mode
    };
  }

  /**
   * Resolves an exact current member of the host-bound session.
   * @param source - Untrusted renderer-supplied source.
   * @returns The trusted member source, or undefined outside current membership.
   */
  function member(source: StreamSourceRef): StreamSourceRef | undefined {
    if (source.cardId !== session.cardId || source.streamType !== session.streamType) return undefined;
    const key = streamSourceKey(source);
    return latest?.descriptor.members.find((item) => streamSourceKey(item.source) === key)?.source;
  }

  /**
   * Derives why the renderer's incarnation is no longer current.
   * @param source - Exact source.
   * @param version - Incarnation the renderer holds.
   * @param binding - Binding of that incarnation.
   * @param current - Controller state, if the source is still tracked.
   * @returns Recorded server reason, else a reason inferred from the authority change.
   */
  function reasonFor(
    source: StreamSourceRef,
    version: StreamSourceVersion,
    binding: StreamSourceBinding,
    current: SessionSourceState | undefined
  ): StreamSourceInvalidationReason {
    const key = incarnationKey(source, version);
    const recorded = reasons.get(key);
    if (recorded) {
      reasons.delete(key);
      return recorded;
    }
    if (!current || !member(source)) return 'removed';
    const authority = current.authority;
    if (authority && authority.version.serverEpoch !== version.serverEpoch) return 'server-restarted';
    if (authority && !sameBinding(authority.binding, binding)) return 'binding-changed';
    return 'replaced';
  }

  /**
   * Answers a subscription with the controller's accepted content.
   * @param f - Forwarding state with an unanswered request.
   * @param current - Ready controller state with authority and metadata.
   */
  function answer(f: Forwarded, current: SessionSourceState): void {
    const authority = current.authority;
    if (!f.requestId || !authority || !current.meta) return;
    const total = current.firstLineNumber + current.lines.length - 1;
    const sent = post({
      type: 'source:snapshot',
      generation,
      requestId: f.requestId,
      source: structuredClone(current.source),
      version: { ...authority.version },
      binding: copyBinding(authority.binding),
      meta: projectMeta(current.meta, total),
      lines: [...current.lines],
      firstLineNumber: current.firstLineNumber,
      totalLineCount: total
    });
    if (!sent) {
      fail(f, current.source, 'inconsistent-source');
      return;
    }
    f.answered = true;
    f.version = { ...authority.version };
    f.binding = copyBinding(authority.binding);
    f.last = total;
    f.active = current.meta.isActive;
  }

  /**
   * Reports a typed failure once for the renderer's current request.
   * @param f - Forwarding state.
   * @param source - Exact source.
   * @param error - Renderer-visible failure.
   */
  function fail(f: Forwarded, source: StreamSourceRef, error: StreamSourceLoadError): void {
    if (!f.requestId || f.errorFor === f.requestId) return;
    f.errorFor = f.requestId;
    post({ type: 'source:error', generation, requestId: f.requestId, source: structuredClone(source), error });
  }

  /**
   * Forwards growth of the renderer's incarnation as bounded appends and activity as lifecycle.
   * @param f - Answered forwarding state; its cursor and activity advance in place.
   * @param version - Incarnation the renderer holds.
   * @param binding - Binding of that incarnation.
   * @param current - Controller state of the same incarnation.
   */
  function forward(
    f: Forwarded,
    version: StreamSourceVersion,
    binding: StreamSourceBinding,
    current: SessionSourceState
  ): void {
    const last = current.firstLineNumber + current.lines.length - 1;
    for (let from = Math.max(f.last + 1, current.firstLineNumber); from <= last; from += MAX_APPEND_LINES) {
      const offset = from - current.firstLineNumber;
      post({
        type: 'source:append',
        generation,
        source: structuredClone(current.source),
        version: { ...version },
        binding: copyBinding(binding),
        firstLineNumber: from,
        lines: current.lines.slice(offset, offset + MAX_APPEND_LINES)
      });
    }
    if (last > f.last) f.last = last;
    if (current.meta && current.meta.isActive !== f.active) {
      post({
        type: 'source:lifecycle',
        generation,
        source: structuredClone(current.source),
        version: { ...version },
        binding: copyBinding(binding),
        state: current.meta.isActive ? (f.active === null ? 'started' : 'resumed') : 'ended',
        totalLineCount: f.last
      });
      f.active = current.meta.isActive;
    }
  }

  /**
   * Projects accepted controller state onto the renderer protocol.
   * @param state - Latest accepted controller state.
   */
  function sync(state: SessionControllerState): void {
    if (disposed) return;
    latest = state;
    if (!announced && state.revision >= 1) {
      announced = true;
      options.ready?.(initFrom(state));
    }
    if (!live) return;
    if (state.revision > sentRevision) {
      sentRevision = state.revision;
      post({
        type: 'session:update',
        generation,
        revision: state.revision,
        descriptor: structuredClone(state.descriptor)
      });
    }
    if (state.connected !== connected) {
      connected = state.connected;
      post({ type: 'connection:state', generation, state: connected ? 'connected' : 'disconnected' });
      // The renderer re-requests every wanted source on reconnection.
      if (connected)
        for (const f of forwarded.values()) {
          f.requestId = null;
          f.answered = false;
        }
    }
    for (const [key, f] of forwarded) {
      const current = state.sources.get(key);
      if (f.answered && f.version && f.binding) {
        const authority = current?.authority;
        if (
          !current ||
          current.status === 'unavailable' ||
          !authority ||
          !sameVersion(authority.version, f.version) ||
          !sameBinding(authority.binding, f.binding)
        ) {
          post({
            type: 'source:invalidated',
            generation,
            source: structuredClone(f.source),
            version: { ...f.version },
            binding: copyBinding(f.binding),
            reason: reasonFor(f.source, f.version, f.binding, current)
          });
          // The renderer retires the version and sends a fresh request for the successor.
          f.answered = false;
          f.version = null;
          f.binding = null;
          f.requestId = null;
          continue;
        }
      }
      if (!current) continue;
      if (current.status === 'paused') {
        const error = current.error as StreamSourceLoadError | null;
        fail(f, current.source, error && LOAD_ERRORS.includes(error) ? error : 'load-error');
        continue;
      }
      if (!f.answered) {
        if (current.status === 'ready' && current.available) answer(f, current);
        continue;
      }
      if (f.version && f.binding) forward(f, f.version, f.binding, current);
    }
  }

  /**
   * Handles a validated renderer subscription against exact current membership.
   * @param source - Untrusted renderer source.
   * @param requestId - Renderer correlation.
   * @param history - Requested coverage.
   */
  function subscribe(source: StreamSourceRef, requestId: string, history: 'tail' | 'full'): void {
    const trusted = member(source);
    if (!trusted) {
      options.diagnostic?.({ code: 'rejected-scope', source: structuredClone(source), requestId });
      if (source.cardId === session.cardId && source.streamType === session.streamType)
        post({ type: 'source:error', generation, requestId, source: structuredClone(source), error: 'rejected-scope' });
      return;
    }
    const key = streamSourceKey(trusted);
    const f: Forwarded = forwarded.get(key) ?? {
      source: structuredClone(trusted),
      requestId: null,
      answered: false,
      errorFor: null,
      version: null,
      binding: null,
      last: 0,
      active: null
    };
    f.requestId = requestId;
    f.answered = false;
    f.errorFor = null;
    forwarded.set(key, f);
    controller.subscribe({ source: structuredClone(trusted), mode: history, requestId, generation });
    sync(controller.getState());
  }

  return {
    start() {
      if (!disposed) controller.start();
    },
    getInit() {
      if (!latest || latest.revision < 1) return null;
      if (!live) sentRevision = Math.max(sentRevision, latest.revision);
      return initFrom(latest);
    },
    attach() {
      if (disposed || live) return;
      live = true;
      if (latest) sync(latest);
    },
    receive(data) {
      if (disposed) return;
      const result = validateRendererMessage(data);
      if (!result.ok) {
        options.diagnostic?.({ code: 'rejected-message', reason: result.reason });
        return;
      }
      const message = result.message;
      if (message.generation !== generation) {
        options.diagnostic?.({ code: 'stale-generation' });
        return;
      }
      if (!live) {
        live = true;
        if (latest) sync(latest);
      }
      switch (message.type) {
        case 'source:subscribe':
          subscribe(message.source, message.requestId, message.history);
          return;
        case 'source:unsubscribe': {
          const trusted = member(message.source);
          if (!trusted) {
            options.diagnostic?.({ code: 'rejected-scope', source: structuredClone(message.source) });
            return;
          }
          forwarded.delete(streamSourceKey(trusted));
          controller.unsubscribe(structuredClone(trusted), generation);
          return;
        }
        case 'session:resync':
          controller.refresh();
          return;
        case 'close':
        case 'openFile':
        case 'showDiff':
          options.action?.(message);
          return;
        default:
          options.layout?.(message);
      }
    },
    signal(message) {
      if (disposed || !live || message.generation !== generation) return false;
      return post(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      forwarded.clear();
      reasons.clear();
    }
  };
}

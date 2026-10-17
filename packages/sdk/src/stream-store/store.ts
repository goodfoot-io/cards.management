/**
 * Session-scoped renderer store with version-fenced native source merging.
 *
 * The store mirrors host-accepted membership and source content for exactly
 * one bound session. It merges snapshots and live appends only within the
 * authoritative source version and binding that established them, keeps
 * overlap/gap reconciliation on absolute line coordinates, and fences every
 * response by generation, request ID, and local reconciliation epoch.
 *
 * The store holds no live-event buffer. The host forwards appends only for a
 * request it has answered, and answers each request with the controller's
 * current content, so any append that reaches an awaiting source was posted
 * before the host saw the request and is covered by the answer. Such appends,
 * and any the store cannot place, are dropped; overflow recovery and its
 * backoff belong to the host's session controller alone.
 *
 * Diagnostics stay identifier-only. With `forwardDiagnostics` the store also
 * reports them to the host as rate-limited `renderer:diagnostic` messages, so
 * a renderer-side pause is visible in the host's log.
 *
 * @summary Zustand vanilla store for session renderer state
 * @module stream-store/store
 */

import { createStore } from 'zustand/vanilla';
import type {
  SessionDescriptor,
  SessionMember,
  StreamMeta,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceVersion
} from '../protocol/types/stream.js';
import { createDiagnosticLimiter } from './limit.js';
import type {
  HostToRendererMessage,
  LayoutPayload,
  RendererToHostMessage,
  SourceAppendMessage,
  SourceInvalidatedMessage,
  SourceLifecycleMessage,
  SourceSnapshotMessage,
  SourceStatusMessage,
  StreamHistoryMode,
  StreamInitData,
  StreamRendererStore,
  StreamSourceAuthorityStamp,
  StreamSourceLoadError,
  StreamSourceStatus,
  StreamSourceView,
  StreamStoreDiagnostic,
  StreamStoreOptions,
  StreamStoreState
} from './types.js';
import { DIAGNOSTIC_REASON_PATTERN, TAIL_HISTORY_LINES } from './types.js';
import { validateHostMessage, validateRendererMessage, validateViewState } from './validate.js';

declare global {
  interface Window {
    __STREAM_INIT__?: StreamInitData;
  }
}

/** Retired version tokens retained per source to reject delayed traffic. */
const RETIRED_VERSIONS = 32;

/** Bounded automatic gap repairs before a source pauses for explicit retry. */
const MAX_GAP_REPAIRS = 2;

/** Mutable per-source reconciliation state; published as immutable views. */
interface SourceWork {
  /** Exact source identity. */
  source: StreamSourceRef;
  /** Current membership, or null when retained as unavailable history. */
  member: SessionMember | null;
  /** Accepted authority. */
  authority: StreamSourceAuthorityStamp | null;
  /** Accepted metadata. */
  meta: StreamMeta | null;
  /** Contiguous native lines. */
  lines: string[];
  /** Coordinate of `lines[0]`. */
  first: number;
  /** Known complete line count. */
  total: number;
  /** Requested coverage. */
  history: StreamHistoryMode;
  /** Whether the renderer wants this source delivered. */
  wanted: boolean;
  /** Visible subscription state. */
  status: StreamSourceStatus;
  /** Current request correlation. */
  requestId: string | null;
  /** Whether the current request has not been answered yet. */
  awaiting: boolean;
  /** Local reconciliation epoch. */
  epoch: number;
  /** Visible failure. */
  error: StreamSourceLoadError | null;
  /** Retired version keys. */
  retired: string[];
  /** Same-version conflict awaiting server revalidation. */
  conflict: boolean;
  /** Local content became untrustworthy while awaiting; refetch once the current answer lands. */
  refetchAfterAnswer: boolean;
  /** Consecutive automatic gap repairs. */
  gapRepairs: number;
  /** Published view, regenerated after mutation. */
  view: StreamSourceView | null;
}

/**
 * Encodes the exact source tuple as a JSON array key.
 * @param source - Source identity.
 * @returns Unambiguous key.
 */
function sourceKey(source: StreamSourceRef): string {
  return JSON.stringify([source.cardId, source.streamType, source.relPath]);
}

/**
 * Encodes a version tuple.
 * @param version - Source version.
 * @returns Unambiguous key.
 */
function versionKey(version: StreamSourceVersion): string {
  return JSON.stringify([version.serverEpoch, version.sourceEpoch]);
}

/**
 * Compares versions exactly.
 * @param a - First version.
 * @param b - Second version.
 * @returns Whether both epochs match.
 */
function sameVersion(a: StreamSourceVersion, b: StreamSourceVersion): boolean {
  return a.serverEpoch === b.serverEpoch && a.sourceEpoch === b.sourceEpoch;
}

/**
 * Creates a renderer store over injected transport, independent of DOM globals.
 * @param options - Initialization, transport, and identity dependencies.
 * @returns A started store; the main source is auto-subscribed when present.
 * @throws Error when initialization is malformed.
 */
export function createStreamStore(options: StreamStoreOptions): StreamRendererStore {
  const init = structuredClone(options.init);
  const check = validateHostMessage({
    type: 'session:update',
    generation: init?.generation,
    revision: init?.revision,
    descriptor: init?.descriptor
  });
  if (
    !check.ok ||
    !init.session ||
    JSON.stringify([init.session.cardId, init.session.streamType, init.session.sessionId]) !==
      JSON.stringify([
        init.descriptor.session.cardId,
        init.descriptor.session.streamType,
        init.descriptor.session.sessionId
      ]) ||
    Object.keys(init.session).length !== 3 ||
    (init.mode !== 'compact' && init.mode !== 'expanded') ||
    (init.viewState !== undefined && !validateViewState(init.viewState).ok)
  ) {
    throw new Error('Invalid stream store initialization');
  }
  const session = init.session;
  const generation = init.generation;
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  const works = new Map<string, SourceWork>();
  const dirty = new Set<SourceWork>();
  let disposed = false;
  const limit = createDiagnosticLimiter();
  /** Key of the main already auto-subscribed; a main is auto-subscribed at most once. */
  let autoMain: string | null = null;

  const store = createStore<StreamStoreState>()(() => ({
    session,
    generation,
    revision: init.revision,
    descriptor: init.descriptor,
    mode: init.mode,
    connection: 'connected',
    sources: new Map(),
    layoutToken: null,
    viewState: init.viewState ?? null
  }));

  /**
   * Reports an identifier-only diagnostic.
   * @param code - Diagnostic category.
   * @param work - Related source.
   * @param extra - Optional request or reason.
   * @param extra.requestId - Correlated request.
   * @param extra.reason - Rejection reason code.
   */
  function diagnose(
    code: StreamStoreDiagnostic['code'],
    work?: SourceWork,
    extra: { requestId?: string; reason?: string } = {}
  ): void {
    options.diagnostic?.({ code, ...(work ? { source: { ...work.source } } : {}), ...extra });
    if (options.forwardDiagnostics) report(code, work, extra.reason);
  }

  /**
   * Posts a rate-limited diagnostic to the host. A report that fails validation is dropped
   * silently, since diagnosing it would report again.
   * @param code - Diagnostic category.
   * @param work - Related source.
   * @param reason - Rejection reason; omitted when it is not a kebab-case identifier.
   */
  function report(code: StreamStoreDiagnostic['code'], work?: SourceWork, reason?: string): void {
    if (disposed) return;
    const safe = reason !== undefined && DIAGNOSTIC_REASON_PATTERN.test(reason) ? reason : undefined;
    const count = limit(JSON.stringify([code, work ? sourceKey(work.source) : '', safe ?? '']));
    if (count === 0) return;
    const message: RendererToHostMessage = {
      type: 'renderer:diagnostic',
      generation,
      code,
      ...(work ? { source: { ...work.source } } : {}),
      ...(safe ? { reason: safe } : {}),
      ...(count > 1 ? { count } : {})
    };
    if (validateRendererMessage(message).ok) options.post(message);
  }

  /**
   * Posts a renderer message after exact-shape validation.
   * @param message - Outbound message.
   * @returns Whether the message was posted.
   */
  function post(message: RendererToHostMessage): boolean {
    if (disposed) return false;
    const result = validateRendererMessage(message);
    if (!result.ok) {
      diagnose('rejected-message', undefined, { reason: result.reason });
      return false;
    }
    options.post(message);
    return true;
  }

  /**
   * Marks a source changed for the next publication.
   * @param work - Changed source.
   */
  function touch(work: SourceWork): void {
    work.view = null;
    dirty.add(work);
  }

  /**
   * Publishes a new immutable state, regenerating only changed source views.
   * @param patch - Top-level state fields replaced in the same publication.
   */
  function publish(patch: Partial<StreamStoreState> = {}): void {
    if (disposed) return;
    const sources = new Map<string, StreamSourceView>();
    for (const [key, work] of works) {
      if (!work.view) {
        work.view = Object.freeze({
          source: { ...work.source },
          member: work.member ? structuredClone(work.member) : null,
          authority: work.authority ? structuredClone(work.authority) : null,
          meta: work.meta ? structuredClone(work.meta) : null,
          lines: Object.freeze([...work.lines]) as string[],
          firstLineNumber: work.first,
          totalLineCount: work.total,
          earlierUnloaded: work.first > 1,
          history: work.history,
          status: work.status,
          requestId: work.requestId,
          reconciliationEpoch: work.epoch,
          error: work.error
        });
      }
      sources.set(key, work.view);
    }
    dirty.clear();
    store.setState({ ...patch, sources });
  }

  /**
   * Creates fresh unsubscribed work for a member.
   * @param member - Current member.
   * @returns New source work.
   */
  function createWork(member: SessionMember): SourceWork {
    return {
      source: { ...member.source },
      member: structuredClone(member),
      authority: null,
      meta: null,
      lines: [],
      first: 1,
      total: 0,
      history: 'tail',
      wanted: false,
      status: 'unsubscribed',
      requestId: null,
      awaiting: false,
      epoch: 0,
      error: null,
      retired: [],
      conflict: false,
      refetchAfterAnswer: false,
      gapRepairs: 0,
      view: null
    };
  }

  /**
   * Retires a version so delayed traffic for it is rejected.
   * @param work - Source.
   * @param version - Retired incarnation.
   */
  function retire(work: SourceWork, version: StreamSourceVersion): void {
    const key = versionKey(version);
    if (!work.retired.includes(key)) work.retired.push(key);
    if (work.retired.length > RETIRED_VERSIONS) work.retired.shift();
  }

  /**
   * Issues a fresh correlated request that supersedes any prior one.
   * @param work - Wanted member source.
   * @param history - Coverage to request.
   */
  function request(work: SourceWork, history: StreamHistoryMode): void {
    const requestId = createRequestId();
    work.wanted = true;
    work.history = history;
    work.requestId = requestId;
    work.awaiting = true;
    work.refetchAfterAnswer = false;
    work.status = work.authority ? 'resynchronizing' : 'loading';
    work.error = null;
    touch(work);
    post({ type: 'source:subscribe', generation, requestId, source: { ...work.source }, history });
  }

  /**
   * Single-flight refetch for gaps, conflicts, and unseen versions.
   * @param work - Source needing authoritative content.
   */
  function refetch(work: SourceWork): void {
    work.status = work.authority ? 'resynchronizing' : 'loading';
    touch(work);
    if (work.awaiting) {
      work.refetchAfterAnswer = true;
      return;
    }
    request(work, work.history);
  }

  /**
   * Pauses a source visibly until explicit retry, reconnection, or a host answer to the paused request.
   * @param work - Source.
   * @param error - Visible failure.
   */
  function pause(work: SourceWork, error: StreamSourceLoadError): void {
    diagnose('source-paused', work, { reason: error });
    work.status = 'paused';
    work.error = error;
    work.awaiting = false;
    work.refetchAfterAnswer = false;
    touch(work);
  }

  /**
   * Checks a routing binding against current membership.
   * @param work - Member source.
   * @param binding - Stamped binding.
   * @returns Whether the binding routes to this member of the bound session.
   */
  function bound(work: SourceWork, binding: StreamSourceBinding): boolean {
    return (
      !!work.member &&
      binding.sessionId === session.sessionId &&
      binding.role === work.member.role &&
      binding.agentId === work.member.agentId
    );
  }

  /**
   * Drops authority after a binding contradiction and refetches.
   * @param work - Source whose routing became untrustworthy.
   */
  function rebind(work: SourceWork): void {
    diagnose('rejected-message', work, { reason: 'binding-mismatch' });
    work.authority = null;
    work.epoch++;
    if (work.wanted) request(work, work.history);
    work.status = 'resynchronizing';
    touch(work);
  }

  /**
   * Bounds a tail-history source to its trailing window.
   * @param work - Source to bound.
   */
  function trim(work: SourceWork): void {
    if (work.history !== 'tail' || work.lines.length <= TAIL_HISTORY_LINES) return;
    const drop = work.lines.length - TAIL_HISTORY_LINES;
    work.lines = work.lines.slice(drop);
    work.first += drop;
  }

  /**
   * Merges a same-version range into local content by absolute coordinates.
   * @param work - Source with matching authority.
   * @param first - First coordinate of the incoming range.
   * @param lines - Incoming lines.
   * @returns `conflict` on byte mismatch, `gap` when the ranges cannot join, else `merged`.
   */
  function mergeRange(work: SourceWork, first: number, lines: readonly string[]): 'merged' | 'conflict' | 'gap' {
    const localLast = work.first + work.lines.length - 1;
    const last = first + lines.length - 1;
    if (work.lines.length === 0) {
      work.lines = [...lines];
      work.first = first;
      return 'merged';
    }
    if (lines.length === 0) return 'merged';
    if (first > localLast + 1 || last < work.first - 1) return 'gap';
    for (let coordinate = Math.max(first, work.first); coordinate <= Math.min(last, localLast); coordinate++) {
      if (lines[coordinate - first] !== work.lines[coordinate - work.first]) return 'conflict';
    }
    const before = first < work.first ? lines.slice(0, work.first - first) : [];
    const after = last > localLast ? lines.slice(localLast + 1 - first) : [];
    if (before.length > 0 || after.length > 0) {
      work.lines = [...before, ...work.lines, ...after];
      work.first = Math.min(first, work.first);
    }
    return 'merged';
  }

  /**
   * Records a same-version conflict: first refetch, then pause if it persists.
   * @param work - Inconsistent source.
   */
  function conflict(work: SourceWork): void {
    diagnose('inconsistent-source', work);
    if (work.conflict) {
      pause(work, 'inconsistent-source');
      return;
    }
    work.conflict = true;
    refetch(work);
  }

  /**
   * Handles a forward gap through a bounded single-flight refetch.
   * @param work - Source with missing coordinates.
   */
  function gap(work: SourceWork): void {
    work.gapRepairs++;
    if (work.gapRepairs > MAX_GAP_REPAIRS) {
      diagnose('inconsistent-source', work, { reason: 'gap' });
      pause(work, 'inconsistent-source');
      return;
    }
    refetch(work);
  }

  /**
   * Applies a validated snapshot answering the current request.
   * @param message - Correlated host answer carrying authoritative content.
   */
  function onSnapshot(message: SourceSnapshotMessage): void {
    const work = works.get(sourceKey(message.source));
    if (!work?.member || !work.wanted || message.requestId !== work.requestId) {
      diagnose('stale-response', work, { requestId: message.requestId });
      return;
    }
    if (!bound(work, message.binding)) {
      diagnose('rejected-message', work, { reason: 'binding-mismatch' });
      pause(work, 'rejected-scope');
      publish();
      return;
    }
    if (work.retired.includes(versionKey(message.version))) {
      diagnose('stale-response', work, { requestId: message.requestId });
      return;
    }
    work.awaiting = false;
    const prior = work.authority;
    if (prior && sameVersion(prior.version, message.version)) {
      const outcome = mergeRange(work, message.firstLineNumber, message.lines);
      if (outcome === 'conflict') {
        conflict(work);
        publish();
        return;
      }
      if (outcome === 'gap') {
        if (message.firstLineNumber > work.first + work.lines.length) {
          work.lines = [...message.lines];
          work.first = message.firstLineNumber;
        } else {
          gap(work);
          publish();
          return;
        }
      }
    } else if (prior && message.firstLineNumber !== 1) {
      diagnose('inconsistent-source', work, { reason: 'partial-new-version' });
      pause(work, 'inconsistent-source');
      publish();
      return;
    } else {
      if (prior) {
        retire(work, prior.version);
        diagnose('source-reset', work);
      }
      work.lines = [...message.lines];
      work.first = message.firstLineNumber;
    }
    work.authority = {
      source: { ...message.source },
      version: { ...message.version },
      binding: { ...message.binding }
    };
    work.meta = structuredClone(message.meta);
    work.total = Math.max(message.totalLineCount, work.first + work.lines.length - 1);
    work.meta.lineCount = work.total;
    work.status = 'ready';
    work.error = null;
    work.conflict = false;
    if (work.refetchAfterAnswer) refetch(work);
    else work.gapRepairs = 0;
    trim(work);
    if (work.lines.length === 0) work.first = work.total + 1;
    touch(work);
    publish();
  }

  /**
   * Applies a validated live append.
   * @param message - Live lines stamped with their source version and binding.
   */
  function onAppend(message: SourceAppendMessage): void {
    const work = works.get(sourceKey(message.source));
    if (!work?.member) {
      diagnose('stale-response', work, { reason: 'not-member' });
      return;
    }
    if (!work.wanted || work.status === 'paused') return;
    if (!bound(work, message.binding)) {
      rebind(work);
      publish();
      return;
    }
    if (work.retired.includes(versionKey(message.version))) {
      diagnose('stale-response', work, { reason: 'retired-version' });
      return;
    }
    const authority = work.authority;
    // Posted before the host saw the current request; its answer covers these lines.
    if (!authority || work.awaiting) return;
    if (!sameVersion(authority.version, message.version)) {
      diagnose('source-reset', work, { reason: 'unseen-version' });
      refetch(work);
      publish();
      return;
    }
    const localNext = work.first + work.lines.length;
    if (message.firstLineNumber > localNext) {
      gap(work);
      publish();
      return;
    }
    let incomingFirst = message.firstLineNumber;
    let incoming = message.lines;
    if (incomingFirst < work.first) {
      incoming = incoming.slice(work.first - incomingFirst);
      incomingFirst = work.first;
    }
    if (incoming.length === 0) return;
    const outcome = mergeRange(work, incomingFirst, incoming);
    if (outcome === 'conflict') {
      conflict(work);
      publish();
      return;
    }
    work.total = Math.max(work.total, work.first + work.lines.length - 1);
    if (work.meta) work.meta.lineCount = work.total;
    trim(work);
    touch(work);
    publish();
  }

  /**
   * Applies a validated lifecycle transition.
   * @param message - Activity transition with the source's complete line count.
   */
  function onLifecycle(message: SourceLifecycleMessage): void {
    const work = works.get(sourceKey(message.source));
    if (!work?.member || !work.wanted || work.status === 'paused') return;
    if (!bound(work, message.binding)) {
      rebind(work);
      publish();
      return;
    }
    if (work.retired.includes(versionKey(message.version)) || !work.authority) return;
    if (!sameVersion(work.authority.version, message.version)) {
      diagnose('source-reset', work, { reason: 'unseen-version' });
      refetch(work);
      publish();
      return;
    }
    if (work.meta) work.meta.isActive = message.state !== 'ended';
    if (!work.awaiting && message.totalLineCount > work.first + work.lines.length - 1) gap(work);
    touch(work);
    publish();
  }

  /**
   * Applies the host's freshness for an answered source. It only toggles between `ready` and
   * `resynchronizing` on the current authority, so it never overrides the store's own refetch,
   * pause or connection state, and it never rebinds: a contradicting stamp is dropped.
   * @param message - Host-side freshness stamped with its source version and binding.
   */
  function onStatus(message: SourceStatusMessage): void {
    const work = works.get(sourceKey(message.source));
    if (!work?.member || !work.wanted) {
      diagnose('stale-response', work, { reason: 'not-member' });
      return;
    }
    if (!bound(work, message.binding)) {
      diagnose('rejected-message', work, { reason: 'binding-mismatch' });
      return;
    }
    if (
      work.retired.includes(versionKey(message.version)) ||
      !work.authority ||
      !sameVersion(work.authority.version, message.version)
    ) {
      diagnose('stale-response', work, { reason: 'unseen-version' });
      return;
    }
    if (work.awaiting || store.getState().connection !== 'connected') return;
    const from = message.state === 'ready' ? 'resynchronizing' : 'ready';
    if (work.status !== from) return;
    work.status = message.state;
    touch(work);
    publish();
  }

  /**
   * Retires an invalidated version before successor content.
   * @param message - Invalidation.
   */
  function onInvalidated(message: SourceInvalidatedMessage): void {
    const work = works.get(sourceKey(message.source));
    if (!work) return;
    const current = work.authority && sameVersion(work.authority.version, message.version);
    retire(work, message.version);
    if (!current) return;
    diagnose('source-reset', work, { reason: message.reason });
    work.authority = null;
    work.epoch++;
    work.conflict = false;
    if (work.member && work.wanted) {
      request(work, work.history);
      work.status = 'resynchronizing';
    } else work.status = work.member ? 'unsubscribed' : 'unavailable';
    touch(work);
    publish();
  }

  /**
   * Accepts a strictly newer descriptor for the bound session.
   * @param revision - Descriptor revision.
   * @param descriptor - Validated descriptor.
   */
  function onSessionUpdate(revision: number, descriptor: SessionDescriptor): void {
    const state = store.getState();
    if (
      descriptor.session.cardId !== session.cardId ||
      descriptor.session.streamType !== session.streamType ||
      descriptor.session.sessionId !== session.sessionId
    ) {
      diagnose('rejected-message', undefined, { reason: 'foreign-session' });
      return;
    }
    if (revision <= state.revision) {
      diagnose('stale-response', undefined, { reason: 'stale-revision' });
      return;
    }
    applyMembership(descriptor.members);
    autoSubscribeMain(descriptor.main);
    publish({ revision, descriptor: structuredClone(descriptor) });
  }

  /**
   * Subscribes a newly designated main once, in the display mode's history coverage.
   * @param source - Descriptor main, or null when the session has no unique main.
   */
  function autoSubscribeMain(source: StreamSourceRef | null): void {
    if (!source || sourceKey(source) === autoMain) return;
    const work = works.get(sourceKey(source));
    if (!work?.member) return;
    autoMain = sourceKey(source);
    if (!work.wanted) request(work, init.mode === 'compact' ? 'tail' : 'full');
  }

  /**
   * Reconciles source work with accepted membership.
   * @param members - Current members.
   */
  function applyMembership(members: readonly SessionMember[]): void {
    const current = new Map(members.map((member) => [sourceKey(member.source), member]));
    for (const [key, work] of works) {
      if (current.has(key) || !work.member) continue;
      work.member = null;
      work.status = 'unavailable';
      work.requestId = null;
      work.awaiting = false;
      work.refetchAfterAnswer = false;
      work.epoch++;
      touch(work);
    }
    for (const [key, member] of current) {
      const work = works.get(key);
      if (!work) {
        const created = createWork(member);
        works.set(key, created);
        touch(created);
        continue;
      }
      const readded = !work.member;
      const rebound = !!work.member && (work.member.role !== member.role || work.member.agentId !== member.agentId);
      work.member = structuredClone(member);
      if (readded || rebound) {
        work.authority = null;
        work.epoch++;
        work.conflict = false;
        work.gapRepairs = 0;
        if (work.wanted) {
          request(work, work.history);
          if (rebound) work.status = 'resynchronizing';
        } else work.status = 'unsubscribed';
      }
      touch(work);
    }
  }

  /**
   * Routes one raw inbound message.
   * @param data - Untrusted message data.
   */
  function receive(data: unknown): void {
    if (disposed) return;
    const result = validateHostMessage(data);
    if (!result.ok) {
      diagnose('rejected-message', undefined, { reason: result.reason });
      return;
    }
    const message: HostToRendererMessage = result.message;
    if (message.generation !== generation) {
      diagnose('stale-response', undefined, { reason: 'stale-generation' });
      return;
    }
    if (
      'source' in message &&
      (message.source.cardId !== session.cardId || message.source.streamType !== session.streamType)
    ) {
      diagnose('rejected-message', undefined, { reason: 'foreign-source' });
      return;
    }
    switch (message.type) {
      case 'session:update':
        onSessionUpdate(message.revision, message.descriptor);
        return;
      case 'source:snapshot':
        onSnapshot(message);
        return;
      case 'source:error': {
        const work = works.get(sourceKey(message.source));
        if (!work?.member || !work.wanted || work.requestId !== message.requestId) {
          diagnose('stale-response', work, { requestId: message.requestId });
          return;
        }
        pause(work, message.error);
        publish();
        return;
      }
      case 'source:append':
        onAppend(message);
        return;
      case 'source:lifecycle':
        onLifecycle(message);
        return;
      case 'source:status':
        onStatus(message);
        return;
      case 'source:invalidated':
        onInvalidated(message);
        return;
      case 'connection:state': {
        const previous = store.getState().connection;
        for (const work of works.values()) {
          if (!work.member || !work.wanted) continue;
          if (message.state === 'connected' && previous !== 'connected') {
            // The host lifts every pause on reconnection and answers only fresh requests.
            if (work.status === 'paused') {
              work.gapRepairs = 0;
              work.conflict = false;
            }
            request(work, work.history);
          } else if (message.state !== 'connected' && work.status !== 'paused') {
            work.status = work.authority ? 'resynchronizing' : 'loading';
            touch(work);
          }
        }
        publish({ connection: message.state });
        return;
      }
      case 'theme:change':
        options.applyTheme?.(message.themeKind, message.cssVariables);
        return;
      case 'layout:handshake':
        publish({ layoutToken: message.token });
        return;
    }
  }

  for (const member of init.descriptor.members) works.set(sourceKey(member.source), createWork(member));
  const removeListener = options.listen(receive);
  autoSubscribeMain(init.descriptor.main);
  publish();

  return {
    subscribe: (listener) => store.subscribe(listener),
    getState: () => store.getState(),
    subscribeSource(source, history) {
      if (disposed) return;
      const work = works.get(sourceKey(source));
      if (!work?.member || source.cardId !== session.cardId || source.streamType !== session.streamType) {
        diagnose('rejected-message', work, { reason: 'not-member' });
        return;
      }
      const effective: StreamHistoryMode = work.wanted && work.history === 'full' ? 'full' : history;
      if (work.wanted && work.status !== 'paused' && effective === work.history) return;
      request(work, effective);
      publish();
    },
    unsubscribeSource(source) {
      if (disposed) return;
      const work = works.get(sourceKey(source));
      if (!work?.member || !work.wanted) return;
      work.wanted = false;
      work.requestId = null;
      work.awaiting = false;
      work.refetchAfterAnswer = false;
      work.status = 'unsubscribed';
      work.epoch++;
      touch(work);
      post({ type: 'source:unsubscribe', generation, source: { ...work.source } });
      publish();
    },
    retry() {
      if (disposed) return;
      post({ type: 'session:resync', generation });
      for (const work of works.values()) {
        if (!work.member || !work.wanted || work.status !== 'paused') continue;
        work.gapRepairs = 0;
        work.conflict = false;
        request(work, work.history);
      }
      publish();
    },
    close() {
      post({ type: 'close', generation });
    },
    openFile(path, line) {
      post(line === undefined ? { type: 'openFile', generation, path } : { type: 'openFile', generation, path, line });
    },
    showDiff(sha, filePath) {
      post(
        filePath === undefined ? { type: 'showDiff', generation, sha } : { type: 'showDiff', generation, sha, filePath }
      );
    },
    postLayout(payload: LayoutPayload) {
      const token = store.getState().layoutToken;
      if (disposed || token === null) return;
      post({ ...payload, generation, token } as RendererToHostMessage);
    },
    postViewState(state) {
      post({ type: 'view:state', generation, state: structuredClone(state) });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeListener();
    }
  };
}

/** Memoized iframe store. */
let windowStore: StreamRendererStore | undefined;

/** Maps VS Code theme kind enum to the attribute value used in CSS selectors. */
const THEME_KIND_MAP: Record<1 | 2 | 3, string> = { 1: 'light', 2: 'dark', 3: 'high-contrast' };

/**
 * Returns the iframe's singleton store bound to `window.__STREAM_INIT__` and `window.parent`.
 * Inbound messages are accepted only when their source is the parent window.
 * @returns The memoized window store.
 * @throws Error when the host did not provide valid initialization.
 */
export function getWindowStreamStore(): StreamRendererStore {
  if (windowStore) return windowStore;
  const init = window.__STREAM_INIT__;
  if (!init) throw new Error('Stream store requires window.__STREAM_INIT__ to be set by the host');
  const parent = window.parent;
  windowStore = createStreamStore({
    init,
    post: (message) => parent.postMessage(message, '*'),
    forwardDiagnostics: true,
    listen: (listener) => {
      const handler = (event: MessageEvent): void => {
        if (event.source === parent) listener(event.data);
      };
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
    applyTheme: (themeKind, cssVariables) => {
      const root = document.documentElement;
      root.setAttribute('data-vscode-theme-kind', THEME_KIND_MAP[themeKind]);
      for (const [name, value] of Object.entries(cssVariables)) root.style.setProperty(name, value);
    }
  });
  return windowStore;
}

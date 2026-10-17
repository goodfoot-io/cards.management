/**
 * Bounded session subscription scheduling and authoritative native source merging.
 * @summary Session controller implementation
 * @module stream-session/runtime
 */
import type {
  StreamMeta,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceSnapshot,
  StreamSourceVersion
} from '../protocol/types/stream.js';
import type {
  SessionController,
  SessionControllerEvent,
  SessionControllerOptions,
  SessionControllerState,
  SessionDiagnostic,
  SessionHistoryMode,
  SessionSourceEvent,
  SessionSourceRequest,
  SessionSourceState
} from './controller.js';
import {
  isRetryableSourceFailure,
  SESSION_READ_RETRY_DELAYS_MS,
  SessionSourceError,
  type SessionSourceFailure
} from './errors.js';
import { groupStreamSessions, streamSessionKey, streamSourceKey } from './grouping.js';

/** Upper bound on distinct sources tracked for scope-rejection rate limiting. */
const MAX_SCOPE_REJECTION_KEYS = 64;

/** Private source reconciliation state, never exposed to consumers. */
interface SourceWork {
  /** Accepted display data. */
  state: SessionSourceState;
  /** Current request cancellation. */
  abort?: AbortController;
  /** Current operation serial. */
  serial: number;
  /** Request mode currently occupying a history slot. */
  activeMode?: SessionHistoryMode;
  /** Queue membership. */
  queued: boolean;
  /** Reset requires an authoritative full read. */
  reset: boolean;
  /** Old authority invalidated before replacement is read. */
  rejectedVersion?: StreamSourceVersion;
  /** Recently retired authority tokens reject delayed publications without choosing by arrival order. */
  retired: string[];
  /** Repeated gap repairs are bounded until explicit retry. */
  gapRepairs: number;
  /** Conflicting same-version bytes require explicit server revalidation. */
  conflict: boolean;
  /** Overflow recovery reads scheduled since the source last converged. */
  overflows: number;
  /** Highest live coordinate an overflow discarded that accepted content does not yet cover; 0 when none. */
  lost: number;
  /** Transient native publications awaiting a snapshot. */
  buffer: SessionSourceEvent[];
  /** Consecutive automatic read retries since the last success or budget reset. */
  attempts: number;
  /** Cancels the pending backoff timer, if any. */
  cancelRetry?: () => void;
  /** Paused by a retryable failure (read or overflow recovery), liftable by a live event or refresh. */
  retryable: boolean;
}

/** Request-start identity and coordinates deliberately exclude native history and metadata. */
type SourceRequestBaseline = Pick<
  SessionSourceState,
  'reconciliationEpoch' | 'requestId' | 'firstLineNumber' | 'totalLineCount'
>;

/**
 * Validates nonempty logical identity fields without path controls.
 * @param value - Untrusted identifier.
 * @returns Whether it is a safe logical identifier.
 */
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

/**
 * Validates a logical source-relative path and its card/provider tuple.
 * @param source - Candidate source.
 * @returns Whether all source coordinates are valid.
 */
function validSource(source: StreamSourceRef): boolean {
  return (
    shape(source, ['cardId', 'streamType', 'relPath']) &&
    component(source.cardId) &&
    component(source.streamType) &&
    identifier(source.relPath) &&
    !source.relPath.includes('\\') &&
    source.relPath.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/**
 * Compares server-owned incarnation tokens exactly.
 * @param a - First version.
 * @param b - Second version.
 * @returns Whether both epochs match.
 */
function sameVersion(a: StreamSourceVersion, b: StreamSourceVersion): boolean {
  return a.serverEpoch === b.serverEpoch && a.sourceEpoch === b.sourceEpoch;
}

/**
 * Compares authoritative routing identity including optional agent identity.
 * @param a - First binding.
 * @param b - Second binding.
 * @returns Whether both bindings are identical.
 */
function sameBinding(a: StreamSourceBinding, b: StreamSourceBinding): boolean {
  return a.sessionId === b.sessionId && a.role === b.role && a.agentId === b.agentId;
}

/**
 * Validates complete native line coordinates without accepting nonfinite values.
 * @param value - Candidate coordinate.
 * @returns Whether the coordinate is a nonnegative safe integer.
 */
function count(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Constructs one trusted session lifetime with injected host interfaces.
 * @param options - Dependencies and fixed session identity.
 * @returns A controller whose listeners start before any reads.
 * @throws Error for malformed trusted session identity.
 */
export function createController(options: SessionControllerOptions): SessionController {
  const session = structuredClone(options.session);
  const generation = options.generation;
  if (
    !component(session.cardId) ||
    !component(session.streamType) ||
    !identifier(session.sessionId) ||
    !identifier(generation)
  ) {
    throw new Error('Invalid session scope');
  }
  const sessionKey = streamSessionKey(session);
  const works = new Map<string, SourceWork>();
  const queue: SourceWork[] = [];
  const state: SessionControllerState = {
    session,
    generation,
    revision: 0,
    descriptor: { session, members: [], main: null, validity: 'missing-main' },
    sources: new Map(),
    connected: false
  };
  let started = false;
  let disposed = false;
  let listing = false;
  let listSerial = 0;
  let dirty = false;
  let listAbort: AbortController | undefined;
  let removeEvents: (() => void) | undefined;
  let removeTimer: (() => void) | undefined;
  let active = 0;
  let serial = 0;
  let pending: SessionSourceEvent[] = [];
  let bufferedEvents = 0;
  let bufferedBytes = 0;
  const scopeRejections = new Map<string, number>();

  /** Publishes defensive copies so consumers cannot mutate controller internals. */
  function publish(): void {
    state.sources = new Map([...works].map(([key, work]) => [key, work.state]));
    if (!disposed) options.publish(structuredClone(state));
  }

  /**
   * Rate-limits scope rejections per source so a persistent anomaly cannot flood the log.
   * Admits the 1st, 2nd, 4th, 8th... occurrence; the session is fixed per controller.
   * @param work - Relevant source when known.
   * @returns Whether this occurrence should be reported.
   */
  function admitScopeRejection(work?: SourceWork): boolean {
    const key = work ? streamSourceKey(work.state.source) : '';
    if (!scopeRejections.has(key) && scopeRejections.size >= MAX_SCOPE_REJECTION_KEYS) scopeRejections.clear();
    const seen = (scopeRejections.get(key) ?? 0) + 1;
    scopeRejections.set(key, seen);
    return (seen & (seen - 1)) === 0;
  }

  /**
   * Reports identifier-only diagnostics with no transcript bytes.
   * @param code - Stable reason category.
   * @param work - Relevant source when known.
   * @param requestId - Correlated request when known.
   */
  function diagnose(code: SessionDiagnostic['code'], work?: SourceWork, requestId?: string): void {
    if (code === 'rejected-scope' && !admitScopeRejection(work)) return;
    const correlation = requestId ?? work?.state.requestId;
    options.diagnostic?.(
      structuredClone({
        code,
        session,
        ...(work ? { source: work.state.source } : {}),
        ...(identifier(correlation) ? { requestId: correlation } : {})
      })
    );
  }

  /**
   * Resolves an exact current member, never using path alone.
   * @param source - Untrusted source identity.
   * @returns Work only for this trusted card/provider tuple.
   */
  function find(source: StreamSourceRef): SourceWork | undefined {
    if (!validSource(source) || source.cardId !== session.cardId || source.streamType !== session.streamType)
      return undefined;
    return works.get(streamSourceKey(source));
  }

  /**
   * Checks event binding against current authoritative membership.
   * @param work - Source work.
   * @param binding - Event or snapshot routing identity.
   * @returns Whether the exact member remains in the trusted session.
   */
  function eligible(work: SourceWork, binding: StreamSourceBinding): boolean {
    const member = state.descriptor.members.find(
      (candidate) => streamSourceKey(candidate.source) === streamSourceKey(work.state.source)
    );
    return (
      !!member &&
      binding.sessionId === session.sessionId &&
      binding.role === member.role &&
      binding.agentId === member.agentId
    );
  }

  /**
   * Drops bounded transient buffers without changing acknowledged display content.
   * @param work - Optional source buffer; omission clears all transient buffers.
   */
  function clearBuffer(work?: SourceWork): void {
    if (work) {
      for (const event of work.buffer) {
        bufferedEvents--;
        bufferedBytes -= new TextEncoder().encode(JSON.stringify(event)).length;
      }
      work.buffer = [];
    } else {
      pending = [];
      for (const item of works.values()) item.buffer = [];
      bufferedEvents = 0;
      bufferedBytes = 0;
    }
  }

  /**
   * Invalidates old asynchronous work before source removal or rebinding.
   * @param work - Source being invalidated.
   * @param rejectVersion - Whether its prior incarnation must never be restored.
   */
  function invalidate(work: SourceWork, rejectVersion: boolean): void {
    stopRetry(work);
    work.abort?.abort();
    work.abort = undefined;
    work.serial = ++serial;
    work.state.reconciliationEpoch++;
    work.state.available = false;
    work.state.status = 'unavailable';
    work.reset = true;
    work.lost = 0;
    if (rejectVersion && work.state.authority) {
      work.rejectedVersion = work.state.authority.version;
      retire(work, work.state.authority.version);
    }
    clearBuffer(work);
  }

  /**
   * Chooses the coverage of the next read. A source behind an overflow loss first
   * catches up through a tail window merged onto its accepted prefix; only a gap
   * the window cannot bridge escalates to a full read.
   * @param work - Source about to be read.
   * @returns Requested history coverage.
   */
  function coverage(work: SourceWork): SessionHistoryMode {
    if (work.reset) return 'full';
    return work.lost > 0 && work.state.authority ? 'tail' : work.state.mode;
  }

  /**
   * Enqueues source history while coalescing requests and respecting full upgrades.
   * @param work - Subscribed source.
   */
  function request(work: SourceWork): void {
    if (disposed || !work.state.subscribed || !state.connected || work.state.status === 'paused') return;
    if (
      work.abort &&
      (work.activeMode === 'full' ||
        (!work.reset && (work.state.mode === 'tail' || work.activeMode === coverage(work))))
    )
      return;
    if (work.abort) {
      work.abort.abort();
      work.abort = undefined;
      work.serial = ++serial;
    }
    if (!work.queued) {
      work.queued = true;
      queue.push(work);
    }
    pump();
  }

  /** Starts at most four native historical reads concurrently. */
  function pump(): void {
    while (!disposed && active < 4 && queue.length > 0) {
      const work = queue.shift();
      if (!work) break;
      work.queued = false;
      if (
        !work.state.subscribed ||
        work.state.status === 'paused' ||
        !state.connected ||
        !state.descriptor.members.some(
          (member) => streamSourceKey(member.source) === streamSourceKey(work.state.source)
        )
      )
        continue;
      stopRetry(work);
      const abort = new AbortController();
      const operation = ++serial;
      const epoch = work.state.reconciliationEpoch;
      const mode = coverage(work);
      work.abort = abort;
      work.serial = operation;
      work.activeMode = mode;
      work.state.status = work.state.authority ? 'resynchronizing' : 'loading';
      active++;
      const baseline: SourceRequestBaseline = {
        reconciliationEpoch: work.state.reconciliationEpoch,
        requestId: work.state.requestId,
        firstLineNumber: work.state.firstLineNumber,
        totalLineCount: work.state.totalLineCount
      };
      let result: Promise<StreamSourceSnapshot>;
      try {
        result = options.client.getStream(structuredClone(work.state.source), mode, abort.signal);
      } catch (error) {
        result = Promise.reject(error);
      }
      void result
        .then((snapshot) => {
          if (
            disposed ||
            abort.signal.aborted ||
            work.serial !== operation ||
            work.state.reconciliationEpoch !== epoch ||
            sessionKey !== streamSessionKey(session)
          ) {
            diagnose('stale-response', work);
            return;
          }
          acceptSnapshot(work, snapshot, baseline, mode);
        })
        .catch((error: unknown) => {
          if (disposed || work.serial !== operation || abort.signal.aborted) return;
          readFailed(work, error instanceof SessionSourceError ? error.code : 'load-error');
        })
        .finally(() => {
          active--;
          if (work.serial === operation) {
            work.abort = undefined;
            work.activeMode = undefined;
          }
          pump();
        });
    }
  }

  /**
   * Accepts a coherent snapshot only in the exact current member and operation scope.
   * @param work - Current source reconciliation state.
   * @param snapshot - Authority-bearing native history.
   * @param baseline - Display state at request start.
   * @param mode - Requested coverage.
   */
  function acceptSnapshot(
    work: SourceWork,
    snapshot: StreamSourceSnapshot,
    baseline: SourceRequestBaseline,
    mode: SessionHistoryMode
  ): void {
    const valid =
      shape(snapshot, ['source', 'version', 'binding', 'meta', 'lines', 'firstLineNumber', 'totalLineCount']) &&
      shape(snapshot.version, ['serverEpoch', 'sourceEpoch']) &&
      shape(snapshot.binding, ['sessionId', 'role', 'agentId']) &&
      validSource(snapshot.source) &&
      streamSourceKey(snapshot.source) === streamSourceKey(work.state.source) &&
      snapshot.version &&
      identifier(snapshot.version.serverEpoch) &&
      identifier(snapshot.version.sourceEpoch) &&
      snapshot.binding &&
      eligible(work, snapshot.binding) &&
      count(snapshot.totalLineCount) &&
      count(snapshot.firstLineNumber) &&
      snapshot.firstLineNumber > 0 &&
      Array.isArray(snapshot.lines) &&
      Array.from(snapshot.lines).every((line) => typeof line === 'string' && !line.includes('\n')) &&
      snapshot.firstLineNumber + snapshot.lines.length === snapshot.totalLineCount + 1 &&
      (mode !== 'full' || snapshot.firstLineNumber === 1) &&
      snapshot.meta &&
      snapshot.meta.lineCount === snapshot.totalLineCount &&
      snapshot.meta.streamType === snapshot.source.streamType &&
      snapshot.meta.relPath === snapshot.source.relPath &&
      sameBinding(snapshot.meta, snapshot.binding);
    if (
      !valid ||
      work.retired.includes(versionKey(snapshot.version)) ||
      (work.rejectedVersion && sameVersion(work.rejectedVersion, snapshot.version))
    ) {
      work.state.status = 'paused';
      work.state.available = false;
      work.state.error = 'inconsistent-source';
      diagnose('inconsistent-source', work);
      publish();
      return;
    }
    const prior = work.state.authority;
    const changed =
      !prior || !sameVersion(prior.version, snapshot.version) || !sameBinding(prior.binding, snapshot.binding);
    if (changed && mode !== 'full' && prior) {
      invalidate(work, false);
      work.state.status = 'resynchronizing';
      diagnose('source-reset', work);
      request(work);
      publish();
      return;
    }
    if (work.conflict && !changed) {
      work.state.status = 'paused';
      work.state.available = false;
      work.state.error = 'inconsistent-source';
      diagnose('inconsistent-source', work);
      publish();
      return;
    }
    let lines = [...snapshot.lines];
    let head = snapshot.firstLineNumber;
    if (!changed) {
      const local = work.state;
      const start = Math.min(head, local.firstLineNumber);
      const end = Math.max(snapshot.totalLineCount, local.firstLineNumber + local.lines.length - 1);
      const merged: string[] = [];
      for (let coordinate = start; coordinate <= end; coordinate++) {
        const remote = snapshot.lines[coordinate - head];
        const existing = local.lines[coordinate - local.firstLineNumber];
        if (remote !== undefined && existing !== undefined && remote !== existing) {
          conflict(work);
          return;
        }
        const value = remote ?? existing;
        if (value === undefined) {
          work.abort = undefined;
          work.serial = ++serial;
          if (work.lost > 0) {
            // More was discarded than the catch-up window spans: the same recovery reads in full.
            work.reset = true;
            work.state.status = 'resynchronizing';
            request(work);
            publish();
          } else repairGap(work);
          return;
        }
        merged.push(value);
      }
      lines = merged;
      head = start;
    }
    if (baseline.reconciliationEpoch !== work.state.reconciliationEpoch) {
      diagnose('stale-response', work);
      return;
    }
    if (prior && changed) retire(work, prior.version);
    work.state.authority = structuredClone({
      source: snapshot.source,
      version: snapshot.version,
      binding: snapshot.binding
    });
    work.state.meta = structuredClone(snapshot.meta);
    work.state.lines = lines;
    work.state.firstLineNumber = head;
    work.state.totalLineCount = Math.max(snapshot.totalLineCount, head + lines.length - 1);
    work.state.meta.lineCount = work.state.totalLineCount;
    work.state.available = true;
    work.state.status = 'ready';
    work.state.error = null;
    work.reset = false;
    work.conflict = false;
    work.rejectedVersion = undefined;
    work.attempts = 0;
    work.retryable = false;
    work.abort = undefined;
    if (work.lost > work.state.totalLineCount) {
      // Accepted content advanced but still ends before discarded live lines; post-overflow
      // events stay buffered for replay once a recovery read covers the loss.
      recover(work);
      publish();
      return;
    }
    work.lost = 0;
    const buffered = work.buffer;
    clearBuffer(work);
    for (const event of buffered) acceptEvent(event);
    if (!work.buffer.length && !work.abort) {
      work.gapRepairs = 0;
      work.overflows = 0;
    }
    publish();
  }

  /**
   * Forces server revalidation of conflicting same-version bytes.
   * @param work - Inconsistent source.
   */
  function conflict(work: SourceWork): void {
    work.conflict = true;
    work.state.available = false;
    work.state.status = 'resynchronizing';
    work.abort?.abort();
    work.abort = undefined;
    work.serial = ++serial;
    diagnose('inconsistent-source', work);
    request(work);
    publish();
  }

  /**
   * Bounds transient event memory independently by event count and encoded bytes.
   * @param event - Native event being reconciled.
   * @param work - Known source, or absent during initial metadata discovery.
   */
  function buffer(event: SessionSourceEvent, work?: SourceWork): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (bufferedEvents + 1 > 1000 || bufferedBytes + bytes > 1_048_576) {
      const affected = [...works.values()].filter((item) => item.buffer.length > 0 || item === work);
      for (const item of affected)
        for (const discarded of item === work ? [...item.buffer, event] : item.buffer)
          if (discarded.type === 'append') item.lost = Math.max(item.lost, discarded.lineNumber);
      // Unknown-source events are discarded too; their sources' first reads start after them.
      clearBuffer();
      for (const item of affected) {
        // An in-flight read stays authoritative and is kept: restarting it would race the same
        // appends again. Accepted content is retained, marked stale until a read covers the loss.
        item.state.status = item.state.authority ? 'resynchronizing' : 'loading';
        item.state.error = null;
        diagnose('resync-overflow', item);
        if (!item.abort && !item.queued && !item.cancelRetry && !listing) recover(item);
      }
      if (affected.length) publish();
      else diagnose('resync-overflow');
      return;
    }
    bufferedEvents++;
    bufferedBytes += bytes;
    (work ? work.buffer : pending).push(structuredClone(event));
  }

  /**
   * Validates and routes a native publication against the authoritative session binding.
   * @param event - Host-adapted source event.
   */
  function acceptEvent(event: SessionSourceEvent): void {
    // Every mounted session receives every broadcast event; a well-formed event for another card or
    // stream type is the normal case, not an anomaly, so it is dropped without a diagnostic.
    if (
      !disposed &&
      validSource(event?.source) &&
      (event.source.cardId !== session.cardId || event.source.streamType !== session.streamType)
    )
      return;
    if (
      disposed ||
      !shape(
        event,
        event.type === 'append'
          ? ['type', 'source', 'version', 'binding', 'lineNumber', 'line']
          : event.type === 'invalidated'
            ? ['type', 'source', 'version', 'binding', 'reason']
            : ['type', 'source', 'version', 'binding', 'totalLineCount']
      ) ||
      !shape(event.version, ['serverEpoch', 'sourceEpoch']) ||
      !shape(event.binding, ['sessionId', 'role', 'agentId']) ||
      !validSource(event.source) ||
      event.source.cardId !== session.cardId ||
      event.source.streamType !== session.streamType ||
      !event.version ||
      !identifier(event.version.serverEpoch) ||
      !identifier(event.version.sourceEpoch) ||
      !event.binding ||
      !identifier(event.binding.sessionId) ||
      !['main', 'subagent', 'auxiliary'].includes(event.binding.role) ||
      (event.binding.agentId !== undefined && !identifier(event.binding.agentId)) ||
      (event.type === 'invalidated' &&
        !['replaced', 'removed', 'binding-changed', 'server-restarted'].includes(event.reason)) ||
      (event.type === 'append' &&
        (!count(event.lineNumber) ||
          event.lineNumber < 1 ||
          typeof event.line !== 'string' ||
          event.line.includes('\n'))) ||
      (event.type !== 'append' && event.type !== 'invalidated' && !count(event.totalLineCount))
    ) {
      diagnose('rejected-scope');
      return;
    }
    const work = find(event.source);
    if (work?.retired.includes(versionKey(event.version))) {
      diagnose('stale-response', work);
      return;
    }
    if (!work) {
      if (listing && event.type === 'append') buffer(event);
      if (event.type !== 'append') refresh();
      return;
    }
    if (event.type === 'invalidated') {
      if (
        work.state.authority &&
        (!sameVersion(work.state.authority.version, event.version) ||
          !sameBinding(work.state.authority.binding, event.binding))
      ) {
        diagnose('stale-response', work);
        return;
      }
      invalidate(work, true);
      work.rejectedVersion = structuredClone(event.version);
      retire(work, event.version);
      diagnose('source-reset', work);
      refresh();
      publish();
      return;
    }
    if (!eligible(work, event.binding)) {
      invalidate(work, true);
      diagnose('rejected-scope', work);
      refresh();
      publish();
      return;
    }
    if (event.type !== 'append') {
      if (event.type === 'started' || event.type === 'resumed') {
        if (!resume(work)) work.attempts = 0;
      }
      refresh();
      return;
    }
    if (!work.state.subscribed || work.state.status === 'paused') return;
    if (work.rejectedVersion && sameVersion(work.rejectedVersion, event.version)) return;
    const authority = work.state.authority;
    if (
      authority &&
      (!sameVersion(authority.version, event.version) || !sameBinding(authority.binding, event.binding))
    ) {
      invalidate(work, false);
      work.state.status = 'resynchronizing';
      diagnose('source-reset', work);
      refresh();
      publish();
      return;
    }
    if (!authority || work.abort || listing || work.reset || work.lost > 0) {
      buffer(event, work);
      return;
    }
    if (!work.state.available) return;
    const offset = event.lineNumber - work.state.firstLineNumber;
    if (offset >= 0 && offset < work.state.lines.length) {
      if (work.state.lines[offset] !== event.line) conflict(work);
      return;
    }
    if (event.lineNumber === work.state.firstLineNumber + work.state.lines.length) {
      work.state.lines.push(event.line);
      work.state.totalLineCount = event.lineNumber;
      if (work.state.meta) work.state.meta.lineCount = event.lineNumber;
      publish();
      return;
    }
    buffer(event, work);
    if (!work.abort && !['paused'].includes(work.state.status)) repairGap(work);
  }

  /**
   * Cancels a pending backoff without touching the attempt budget.
   * @param work - Source work.
   */
  function stopRetry(work: SourceWork): void {
    work.cancelRetry?.();
    work.cancelRetry = undefined;
  }

  /**
   * Retries a transient read failure after bounded backoff, or pauses visibly.
   * Non-retryable failures and an exhausted budget pause until a live event,
   * refresh, reconnection, or explicit retry lifts the pause.
   * @param work - Source whose read failed in its current operation.
   * @param code - Identifier-only failure category.
   */
  function readFailed(work: SourceWork, code: SessionSourceFailure): void {
    stopRetry(work);
    const delay = SESSION_READ_RETRY_DELAYS_MS[work.attempts];
    if (isRetryableSourceFailure(code) && delay !== undefined && state.connected) {
      work.attempts++;
      work.state.status = work.state.authority ? 'resynchronizing' : 'loading';
      work.state.error = null;
      const epoch = work.state.reconciliationEpoch;
      const operation = work.serial;
      diagnose('read-retry', work);
      work.cancelRetry = options.scheduler.after(delay, () => {
        work.cancelRetry = undefined;
        if (
          disposed ||
          !work.state.subscribed ||
          work.state.status === 'paused' ||
          work.state.reconciliationEpoch !== epoch ||
          work.serial !== operation ||
          work.abort
        )
          return;
        request(work);
      });
      publish();
      return;
    }
    work.state.status = 'paused';
    work.state.error = code;
    work.retryable = true;
    diagnose('load-error', work);
    publish();
  }

  /**
   * Lifts a read-failure pause with a fresh attempt budget; callers then read or refresh.
   * @param work - Source work.
   * @returns Whether the pause was lifted.
   */
  function resume(work: SourceWork): boolean {
    if (!work.state.subscribed || work.state.status !== 'paused' || !work.retryable) return false;
    work.state.status = 'resynchronizing';
    work.state.error = null;
    work.attempts = 0;
    work.overflows = 0;
    work.retryable = false;
    return true;
  }

  /**
   * Requests bounded full coverage when accepted source coordinates leave a hole.
   * @param work - Source whose acknowledged content must be preserved.
   */
  function repairGap(work: SourceWork): void {
    work.gapRepairs++;
    if (work.gapRepairs > 2) {
      work.state.status = 'paused';
      work.state.error = 'inconsistent-source';
      diagnose('inconsistent-source', work);
      publish();
      return;
    }
    work.reset = true;
    work.state.status = 'resynchronizing';
    request(work);
    publish();
  }

  /**
   * Schedules one bounded recovery read for a source behind an overflow loss, or pauses
   * it retryably once {@link SESSION_READ_RETRY_DELAYS_MS} is exhausted.
   * @param work - Source whose accepted content does not cover discarded live lines.
   */
  function recover(work: SourceWork): void {
    stopRetry(work);
    const delay = SESSION_READ_RETRY_DELAYS_MS[work.overflows];
    if (delay === undefined) {
      work.state.status = 'paused';
      work.state.error = 'resync-overflow';
      work.retryable = true;
      clearBuffer(work);
      return;
    }
    work.overflows++;
    work.state.status = work.state.authority ? 'resynchronizing' : 'loading';
    work.state.error = null;
    const epoch = work.state.reconciliationEpoch;
    work.cancelRetry = options.scheduler.after(delay, () => {
      work.cancelRetry = undefined;
      if (
        disposed ||
        !work.state.subscribed ||
        work.state.status === 'paused' ||
        work.state.reconciliationEpoch !== epoch
      )
        return;
      request(work);
    });
  }

  /** Explicit retries reset bounded repair budgets, then revalidate membership. */
  function retry(): void {
    for (const work of works.values())
      if (work.state.subscribed && work.state.status === 'paused') {
        work.state.status = 'resynchronizing';
        work.state.error = null;
        work.overflows = 0;
        work.gapRepairs = 0;
        work.attempts = 0;
        work.retryable = false;
      }
    refresh();
  }

  /**
   * Retires a bounded recent authority token history for delayed live publications.
   * @param work - Source work.
   * @param version - Retired incarnation.
   */
  function retire(work: SourceWork, version: StreamSourceVersion): void {
    const key = versionKey(version);
    if (!work.retired.includes(key)) work.retired.push(key);
    if (work.retired.length > 32) work.retired.shift();
  }

  /** Reconciles serialized metadata listings, scheduling one dirty-again fetch. */
  function refresh(): void {
    if (!started || disposed) return;
    if (listing) {
      dirty = true;
      return;
    }
    listing = true;
    listAbort = new AbortController();
    const abort = listAbort;
    const operation = ++listSerial;
    let result: Promise<StreamMeta[]>;
    try {
      result = options.client.listStreams(session.cardId, abort.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    void result
      .then((records) => {
        if (disposed || abort.signal.aborted || operation !== listSerial) return;
        const descriptor = groupStreamSessions(session.cardId, records).groups.find(
          (group) => streamSessionKey(group.descriptor.session) === sessionKey
        )?.descriptor ?? { session, members: [], main: null, validity: 'missing-main' as const };
        const keys = new Set(descriptor.members.map((member) => streamSourceKey(member.source)));
        for (const [key, work] of works) {
          const member = descriptor.members.find((item) => streamSourceKey(item.source) === key);
          if (
            !keys.has(key) ||
            (member &&
              work.state.meta &&
              (member.role !== work.state.meta.role || member.agentId !== work.state.meta.agentId))
          )
            invalidate(work, true);
        }
        state.descriptor = descriptor;
        state.revision++;
        for (const member of descriptor.members) {
          const key = streamSourceKey(member.source);
          let work = works.get(key);
          if (!work) {
            work = {
              state: {
                source: member.source,
                authority: null,
                meta: null,
                lines: [],
                firstLineNumber: 1,
                totalLineCount: 0,
                available: true,
                subscribed: false,
                reconciliationEpoch: 0,
                requestId: null,
                mode: 'tail',
                status: 'loading',
                error: null
              },
              serial: 0,
              queued: false,
              retired: [],
              gapRepairs: 0,
              reset: false,
              conflict: false,
              overflows: 0,
              lost: 0,
              buffer: [],
              attempts: 0,
              retryable: false
            };
            works.set(key, work);
          } else if (work.state.available && work.state.meta) {
            const metadata = records.find(
              (record) =>
                record.streamType === member.source.streamType &&
                record.relPath === member.source.relPath &&
                record.sessionId === session.sessionId
            );
            if (metadata) work.state.meta = { ...structuredClone(metadata), lineCount: work.state.totalLineCount };
          }
          if (work.state.subscribed && (!work.state.available || work.state.status === 'resynchronizing'))
            request(work);
        }
        publish();
      })
      .catch(() => {
        if (!disposed && !abort.signal.aborted && operation === listSerial) {
          diagnose('load-error');
          for (const work of works.values())
            if (work.state.subscribed) {
              work.state.status = 'paused';
              work.state.error = 'membership-error';
            }
          publish();
        }
      })
      .finally(() => {
        if (disposed || operation !== listSerial) return;
        listing = false;
        const events = pending;
        pending = [];
        for (const event of events) {
          bufferedEvents--;
          bufferedBytes -= new TextEncoder().encode(JSON.stringify(event)).length;
          acceptEvent(event);
        }
        for (const work of works.values())
          if (!work.abort && work.state.authority && work.buffer.length) {
            const events = work.buffer;
            clearBuffer(work);
            for (const event of events) acceptEvent(event);
          }
        if (dirty) {
          dirty = false;
          refresh();
        }
      });
  }

  /**
   * Receives host events without reading private host or renderer state.
   * @param event - Injected event.
   */
  function onEvent(event: SessionControllerEvent): void {
    if (disposed || !event || typeof event !== 'object') return;
    if (event.type === 'refresh') {
      if (!shape(event, ['type', 'cardId', 'reason']) || !['commit', 'focus', 'retry'].includes(event.reason)) {
        diagnose('rejected-scope');
        return;
      }
      if (event.cardId === session.cardId) {
        if (event.reason === 'retry') retry();
        else {
          for (const work of works.values()) resume(work);
          refresh();
        }
      }
      return;
    }
    if (event.type === 'connection') {
      if (!shape(event, ['type', 'connected']) || typeof event.connected !== 'boolean') {
        diagnose('rejected-scope');
        return;
      }
      state.connected = event.connected;
      if (event.connected) {
        for (const work of works.values())
          if (work.state.subscribed) {
            work.state.status = 'resynchronizing';
            work.state.error = null;
            work.overflows = 0;
            work.attempts = 0;
            work.retryable = false;
          }
        refresh();
      } else {
        listAbort?.abort();
        listSerial++;
        listing = false;
        dirty = false;
        for (const work of works.values()) {
          stopRetry(work);
          work.abort?.abort();
          work.abort = undefined;
          work.serial = ++serial;
          if (work.state.subscribed) work.state.status = 'resynchronizing';
        }
      }
      publish();
      return;
    }
    if (['append', 'started', 'resumed', 'ended', 'invalidated'].includes(event.type)) acceptEvent(event);
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      state.connected = true;
      removeEvents = options.events.subscribe(onEvent);
      removeTimer = options.scheduler.every(30_000, refresh);
      refresh();
    },
    subscribe(requestData: SessionSourceRequest) {
      const work = find(requestData?.source);
      if (
        disposed ||
        !shape(requestData, ['source', 'mode', 'requestId', 'generation']) ||
        !work ||
        requestData.generation !== generation ||
        !identifier(requestData.requestId) ||
        !['tail', 'full'].includes(requestData.mode) ||
        !state.descriptor.members.some(
          (member) => streamSourceKey(member.source) === streamSourceKey(requestData.source)
        )
      ) {
        diagnose('rejected-scope', work, requestData?.requestId);
        return;
      }
      const wasSubscribed = work.state.subscribed;
      const upgrade = requestData.mode === 'full' && work.state.mode !== 'full';
      work.state.subscribed = true;
      work.state.requestId = requestData.requestId;
      if (upgrade) work.state.mode = 'full';
      if (work.state.status === 'paused') {
        work.state.status = 'resynchronizing';
        work.state.error = null;
        work.overflows = 0;
        work.attempts = 0;
        work.retryable = false;
      }
      if (!wasSubscribed || upgrade || work.state.status !== 'ready') request(work);
      publish();
    },
    unsubscribe(source, currentGeneration) {
      const work = find(source);
      if (disposed || currentGeneration !== generation || !work) return;
      work.state.subscribed = false;
      work.state.requestId = null;
      stopRetry(work);
      work.attempts = 0;
      work.overflows = 0;
      work.lost = 0;
      work.retryable = false;
      work.abort?.abort();
      work.abort = undefined;
      work.serial = ++serial;
      work.state.reconciliationEpoch++;
      clearBuffer(work);
      publish();
    },
    refresh: retry,
    getState() {
      return structuredClone(state);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listAbort?.abort();
      removeEvents?.();
      removeTimer?.();
      queue.length = 0;
      clearBuffer();
      removeEvents = undefined;
      removeTimer = undefined;
      listAbort = undefined;
      for (const work of works.values()) {
        stopRetry(work);
        work.abort?.abort();
        work.abort = undefined;
        work.serial = ++serial;
        work.state.reconciliationEpoch++;
        work.state.lines = [];
        work.state.meta = null;
        work.state.authority = null;
        work.state.requestId = null;
        work.state.subscribed = false;
        work.state.available = false;
        work.state.status = 'unavailable';
      }
      works.clear();
      state.sources = new Map();
      state.descriptor = { session, members: [], main: null, validity: 'missing-main' };
      state.connected = false;
    }
  };
}

/**
 * Validates a single logical card/provider path component.
 * @param value - Candidate identifier.
 * @returns Whether it excludes traversal and separators.
 */
function component(value: unknown): value is string {
  return identifier(value) && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\');
}

/**
 * Encodes an authoritative version without delimiter collisions.
 * @param version - Server-owned incarnation.
 * @returns Exact version tuple key.
 */
function versionKey(version: StreamSourceVersion): string {
  return JSON.stringify([version.serverEpoch, version.sourceEpoch]);
}

/**
 * Rejects extra object fields at injected message boundaries.
 * @param value - Candidate object.
 * @param allowed - Exact permitted field names.
 * @returns Whether the object has no unrecognized fields.
 */
function shape(value: unknown, allowed: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

/**
 * WebSocket event subscriber for the Cards V2 real-time API.
 *
 *
 * @summary WebSocket event subscriber for the Cards V2 real-time API
 * @module sdk/EventSubscriber
 */

import type {
  CardJournalEntry,
  CardJournalEventMessage,
  CardReplayMessage,
  CardSnapshotMessage,
  CardSubscribeFailedMessage
} from '../protocol/types/journal.js';
import type {
  CardStalenessEvent,
  CardStalenessState,
  DiscoverResult,
  EventCallback,
  EventMap,
  EventSubscriberLogger,
  EventSubscriberOptions
} from './types/events.js';

/**
 * Calculates exponential backoff delay for reconnection attempts.
 *
 * @param attempt - The current attempt number (0-indexed).
 * @param maxMs - Maximum delay in milliseconds (default 30000).
 * @returns Delay in milliseconds: 1000, 2000, 4000, 8000, 16000, capped at `maxMs`.
 */
export function calculateBackoffMs(attempt: number, maxMs = 30000): number {
  return Math.min(1000 * 2 ** attempt, maxMs);
}

/**
 * True when `value` is a safe integer usable as a journal sequence number.
 *
 * Numeric strings are rejected rather than coerced: a string `seq` that
 * reached `cardSeq` would corrupt gap arithmetic (`"7" + 1 === "71"`), making
 * every subsequent live event look like a gap and looping
 * warn/re-subscribe forever.
 *
 * @param value - Value decoded from an untrusted WebSocket payload.
 * @returns True when `value` is a safe integer number.
 */
function isValidSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * True when `value` carries the fields {@link CardJournalEntry} documents as
 * required: an integer `seq`, a string `type`, and a string `timestamp`.
 *
 * @param value - Value decoded from an untrusted WebSocket payload.
 * @returns True when `value` satisfies the journal-entry shape.
 */
function isWellFormedJournalEntry(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidSeq((value as CardJournalEntry).seq) &&
    typeof (value as CardJournalEntry).type === 'string' &&
    typeof (value as CardJournalEntry).timestamp === 'string'
  );
}

/**
 * Real-time event subscriber with automatic reconnection.
 *
 * Provides a type-safe interface for subscribing to server-sent events over
 * WebSocket. Event handlers persist across reconnects, so listeners only need
 * to be registered once.
 *
 * Before each reconnection attempt, the `discover` function is called to
 * resolve the current server URL and access token, enabling resilient
 * reconnection when the server restarts on a new port.
 *
 * @example
 * ```typescript
 * const events = new EventSubscriber({
 *   wsUrl: 'ws://localhost:3000/events',
 *   accessToken: 'token',
 *   discover: async () => ({ wsUrl: 'ws://localhost:3000/events', accessToken: 'token' })
 * });
 *
 * events.on('cards:metadata', (e) => {
 *   console.log(`Card ${e.cardId} metadata updated`);
 * });
 *
 * await events.connect();
 * ```
 */
export class EventSubscriber {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private callbacks: Map<string, Set<EventCallback<keyof EventMap>>> = new Map();
  private shouldReconnect: boolean = false;
  private connectionChangeCallbacks: Set<(connected: boolean) => void> = new Set();
  private hasConnected: boolean = false;
  private readonly maxReconnectAttempts: number;
  private readonly logger: EventSubscriberLogger;
  private readonly connectionTimeoutMs: number;
  private readonly discoveryTimeoutMs: number;
  /** Cancels the pending handshake without depending on a browser close/open event. */
  private cancelPendingConnect: ((error: Error) => void) | null = null;
  /** Cancels the current rediscovery deadline when the subscriber is retired. */
  private cancelDiscovery: (() => void) | null = null;
  /**
   * Monotonically increasing counter incremented on every manual `connect()` call.
   * Each scheduled reconnect timer captures the generation at scheduling time and
   * bails if the generation has advanced, preventing stale timer callbacks from
   * creating phantom sockets after a manual reconnect supersedes them.
   */
  private connectGeneration: number = 0;
  private reconnectSequence = 0;

  // --- Heartbeat state ---
  /** App-level ping interval timer. Set after a successful connect, cleared on disconnect. */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Number of consecutive pings that received no pong reply.
   * Incremented on each ping send, reset to 0 on each pong received.
   * The socket is closed and reconnection triggered after
   * {@link MISSED_PONG_LIMIT} consecutive misses.
   */
  private missedPongs: number = 0;
  /**
   * Number of consecutive missed pongs that triggers a forced disconnect.
   * Set to 2 so a dead connection is detected within ~60 s (2 × 30 s) even
   * when one pong response is lost due to throttled background timers in
   * VS Code webviews.
   */
  private static readonly MISSED_PONG_LIMIT = 2;
  /** Interval between client-initiated app-level ping messages, in ms. */
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;

  // --- Per-card journal subscribe/replay state ---
  /**
   * Cards the caller has asked to subscribe to via {@link subscribeToCard}.
   * Persists across reconnects (unlike `cardSeq`, which is cleared on
   * {@link unsubscribeFromCard}) so a fresh connection knows which cards to
   * re-subscribe to.
   */
  private readonly subscribedCardIds: Set<string> = new Set();
  /** Last known-good `seq` per card, from a snapshot/replay or an in-order `card:journalEvent`. */
  private readonly cardSeq: Map<string, number> = new Map();
  /** Current staleness state per card, for de-duplicating {@link onStaleness} notifications. */
  private readonly cardStaleness: Map<string, CardStalenessState> = new Map();
  private readonly stalenessCallbacks: Set<(event: CardStalenessEvent) => void> = new Set();

  /**
   * Creates a new EventSubscriber instance.
   *
   * @param options - WebSocket URL, auth token, discover function, and reconnect limits.
   */
  constructor(private readonly options: EventSubscriberOptions) {
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;
    this.logger = options.logger ?? { warn: (message, details) => console.warn(message, details) };
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 5_000;
    for (const duration of [this.connectionTimeoutMs, this.discoveryTimeoutMs]) {
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647) {
        throw new Error('Connection and discovery deadlines must be integer milliseconds between 1 and 2147483647');
      }
    }
  }

  /**
   * Gets the WebSocket URL.
   *
   * Returns the construction-time URL from options. Discovered URLs are transient
   * and are not reflected here.
   *
   * @returns The configured WebSocket endpoint URL.
   */
  getWsUrl(): string {
    return this.options.wsUrl;
  }

  /**
   * Returns whether the subscriber is currently connected.
   *
   * @returns True when the active socket connection is open.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribes to an event type.
   *
   * @param event - Event key from {@link EventMap}.
   * @param callback - Handler invoked for matching events.
   */
  on<K extends keyof EventMap>(event: K, callback: EventCallback<K>): void {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, new Set());
    }
    (this.callbacks.get(event) as Set<EventCallback<K>>).add(callback);
  }

  /**
   * Unsubscribes from an event type.
   *
   * @param event - Event key from {@link EventMap}.
   * @param callback - Previously registered handler.
   */
  off<K extends keyof EventMap>(event: K, callback: EventCallback<K>): void {
    const callbacks = this.callbacks.get(event);
    if (callbacks) {
      (callbacks as Set<EventCallback<K>>).delete(callback);
    }
  }

  /**
   * Subscribes to a card's event journal for seq-aware catch-up and live
   * updates. Sends `card:subscribe` immediately if connected; otherwise the
   * subscription is remembered and sent as soon as a connection opens
   * (including future reconnects — see {@link _resubscribeAllCards}).
   *
   * The first subscribe (or any subscribe after {@link unsubscribeFromCard})
   * omits `sinceSeq`, so the server always replies with a snapshot. A
   * reconnect after that includes the last known-good `seq`, letting the
   * server reply with a replay when the journal still covers the gap.
   *
   * @param cardId - ID of the card whose journal to follow.
   */
  subscribeToCard(cardId: string): void {
    this.subscribedCardIds.add(cardId);
    this._sendCardSubscribe(cardId);
  }

  /**
   * Stops tracking a card: forgets its `seq`/staleness state and sends
   * `card:unsubscribe` if connected. A later {@link subscribeToCard} call for
   * the same card starts fresh (snapshot, not replay).
   *
   * @param cardId - Card to unsubscribe from.
   */
  unsubscribeFromCard(cardId: string): void {
    this.subscribedCardIds.delete(cardId);
    this.cardSeq.delete(cardId);
    this.cardStaleness.delete(cardId);
    if (this.isConnected()) {
      this.send({ type: 'card:unsubscribe', cardId });
    }
  }

  /**
   * Registers a callback invoked whenever a subscribed card's staleness state
   * changes (see {@link CardStalenessState}). Fired at most once per actual
   * state transition (not on every message).
   *
   * @param callback - Function called with the card's new staleness state.
   * @returns Unsubscribe function to remove this callback.
   */
  onStaleness(callback: (event: CardStalenessEvent) => void): () => void {
    this.stalenessCallbacks.add(callback);
    return () => {
      this.stalenessCallbacks.delete(callback);
    };
  }

  /**
   * Sends `card:subscribe` for `cardId` if currently connected, including
   * `sinceSeq` when we have a last known-good `seq` for it. No-ops while
   * disconnected — {@link _resubscribeAllCards} covers the reconnect case.
   *
   * @param cardId - Card to send the subscribe request for.
   */
  private _sendCardSubscribe(cardId: string): void {
    if (!this.isConnected()) return;
    const sinceSeq = this.cardSeq.get(cardId);
    this.send({ type: 'card:subscribe', cardId, ...(sinceSeq !== undefined ? { sinceSeq } : {}) });
  }

  /**
   * Re-sends `card:subscribe` for every card in {@link subscribedCardIds}.
   * Called once per successful connection (initial connect and every
   * reconnect) so a card subscribed before a drop resumes catch-up from its
   * last known-good `seq` rather than silently going stale.
   */
  private _resubscribeAllCards(): void {
    for (const cardId of this.subscribedCardIds) {
      this._sendCardSubscribe(cardId);
    }
  }

  /**
   * Updates staleness state for a card and notifies {@link onStaleness}
   * callbacks, but only on an actual transition — repeated notifications of
   * the same state are suppressed.
   *
   * @param cardId - Card whose staleness state changed.
   * @param state - The new staleness state.
   * @param reason - Present when `state` is `'stale'`.
   */
  private _setCardStaleness(cardId: string, state: CardStalenessState, reason?: string): void {
    const previous = this.cardStaleness.get(cardId);
    this.cardStaleness.set(cardId, state);
    if (previous === state) return;
    // Snapshot before iterating: a callback that calls the onStaleness
    // unsubscribe function for another callback during this dispatch must
    // not cause that callback to be skipped for this notification.
    for (const cb of [...this.stalenessCallbacks]) {
      cb({ cardId, state, reason });
    }
  }

  /**
   * Registers a callback invoked when the connection state changes.
   *
   * Callbacks are only invoked after the first successful connection. This
   * prevents a spurious `false` during the initial connection attempt.
   *
   * @param callback - Function called with `true` on connect, `false` on disconnect.
   * @returns Unsubscribe function to remove this callback.
   */
  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this.connectionChangeCallbacks.add(callback);
    return () => {
      this.connectionChangeCallbacks.delete(callback);
    };
  }

  /**
   * Connects to the WebSocket server and starts listening for events.
   *
   * The access token is always appended as a `?token=` query parameter.
   * Connection failures reject the returned promise. If a newer `connect()`
   * call supersedes this one before its socket opens, the returned promise
   * rejects with an `'Superseded by a newer connect()'` error rather than
   * hanging.
   *
   * Any pending backoff timer is cancelled and the reconnect-attempt counter is
   * reset so the next auto-reconnect sequence (should this call also fail) starts
   * fresh at 1 000 ms rather than continuing from wherever a prior sequence left
   * off.
   *
   * @returns Promise that resolves when the socket opens.
   */
  async connect(): Promise<void> {
    // Advance the generation counter so any stale timer callbacks scheduled
    // before this call will bail out when they fire and find their captured
    // generation no longer matches.
    this.connectGeneration++;
    this.cancelDiscovery?.();

    // Cancel any pending backoff timer so a manual connect() call does not race
    // with a scheduled reconnect that would create a second socket once the
    // timer fires.
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Reset the attempt counter so that if this manual connect also fails,
    // the subsequent auto-reconnect backoff sequence starts fresh at 1000 ms
    // rather than continuing from wherever a prior sequence left off.
    this.reconnectAttempts = 0;

    return this._openSocket(this.options.wsUrl, this.options.accessToken);
  }

  /**
   * Opens a WebSocket to the given URL and token.
   *
   * This is the internal socket-creation path shared by the public {@link connect}
   * and the auto-reconnect scheduler. It does NOT advance the generation counter,
   * cancel pending timers, or reset the attempt counter — callers are responsible
   * for those invariants.
   *
   * @param wsUrl - WebSocket endpoint URL.
   * @param accessToken - Bearer token appended as `?token=`.
   * @returns Promise that resolves when the socket opens.
   */
  private async _openSocket(wsUrl: string, accessToken: string): Promise<void> {
    const url = new URL(wsUrl);
    url.hash = '';
    url.searchParams.set('token', accessToken);

    // A replaced CONNECTING socket may never emit another event. Settle its
    // caller before closing it, and detach it before any synchronous close event.
    this.cancelPendingConnect?.(new Error('Superseded by a newer connect()'));
    this._stopHeartbeat();
    const oldWs = this.ws;
    this.ws = null;
    this.connected = false;
    oldWs?.close();

    const ws = new globalThis.WebSocket(url.toString());
    this.ws = ws;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        if (this.cancelPendingConnect === cancel) this.cancelPendingConnect = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = (error: Error): void => settle(error);
      const fail = (error: Error): void => {
        if (settled) return;
        settle(error);
        if (ws !== this.ws) return;
        this.ws = null;
        // Do not rely on a close event following error/timeout: browser and
        // transport failures can leave that event pending indefinitely.
        try {
          ws.close();
        } finally {
          this._teardownConnection();
        }
      };
      const onOpen = (): void => {
        if (ws !== this.ws) {
          settle(new Error('Superseded by a newer connect()'));
          return;
        }
        this.connected = true;
        this.hasConnected = true;
        this.reconnectAttempts = 0;
        this._startHeartbeat();
        try {
          this._resubscribeAllCards();
        } catch {
          fail(new Error('WebSocket subscription initialization failed'));
          return;
        }
        this.notifyConnectionChange(true);
        settle();
      };
      const onError = (event: Event): void => {
        fail(new Error(`WebSocket connection failed: ${event.type}`));
      };

      this.cancelPendingConnect = cancel;
      deadline = setTimeout(() => {
        fail(new Error('WebSocket connection timed out'));
      }, this.connectionTimeoutMs);
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', () => {
        settle(new Error('WebSocket closed before connection opened'));
        if (ws !== this.ws) return;
        this.ws = null;
        this._teardownConnection();
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        if (ws !== this.ws) return;
        this.handleMessage(event);
      });
    });
  }

  /**
   * Disconnects from the WebSocket server and disables auto-reconnect.
   *
   * Registered callbacks are preserved, so calling {@link connect} again will
   * resume dispatching without re-registering listeners.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.connectGeneration++;
    this.cancelDiscovery?.();
    this.cancelPendingConnect?.(new Error('WebSocket disconnected before connection opened'));

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this._stopHeartbeat();

    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.connected = false;
  }

  /**
   * Sends a JSON-serialized message on the active WebSocket connection.
   *
   * Throws if the subscriber is not currently connected (fail closed).
   *
   * @param data - Arbitrary key-value payload to JSON-serialize and send.
   * @throws Error when the subscriber is not connected.
   */
  send(data: Record<string, unknown>): void {
    if (!this.isConnected()) {
      throw new Error('Cannot send: EventSubscriber is not connected');
    }
    this.ws!.send(JSON.stringify(data));
  }

  /**
   * Keeps diagnostics from becoming an unhandled rejection in a timer callback.
   *
   * @param message - Credential-free diagnostic message.
   * @param details - Optional non-secret diagnostic detail.
   */
  private warn(message: string, details?: unknown): void {
    try {
      this.logger.warn(message, details);
    } catch {
      // Diagnostics are observational; they cannot own connection liveness.
    }
  }

  /**
   * Bounds rediscovery without letting a late result reopen a retired attempt.
   *
   * @returns The endpoint discovered within this attempt's deadline.
   */
  private discoverWithDeadline(): Promise<DiscoverResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: DiscoverResult | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (this.cancelDiscovery === cancel) this.cancelDiscovery = null;
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const cancel = (): void => finish(new Error('WebSocket discovery cancelled'));
      const deadline = setTimeout(() => finish(new Error('WebSocket discovery timed out')), this.discoveryTimeoutMs);
      this.cancelDiscovery = cancel;
      try {
        this.options.discover().then(
          (result) => finish(result),
          () => finish(new Error('WebSocket discovery failed'))
        );
      } catch {
        finish(new Error('WebSocket discovery failed'));
      }
    });
  }

  /**
   * Isolates consumer callbacks so one broken panel cannot stop reconnection.
   *
   * @param connected - Whether the active socket is open.
   */
  private notifyConnectionChange(connected: boolean): void {
    for (const callback of [...this.connectionChangeCallbacks]) {
      try {
        callback(connected);
      } catch {
        this.warn('[EventSubscriber] Connection observer failed');
      }
    }
  }

  /**
   * Schedules a reconnection attempt with exponential backoff.
   *
   * Before connecting, calls `discover()` to resolve the current server URL and
   * access token. If discovery returns an error or throws, the attempt is counted
   * toward `maxReconnectAttempts` and the next attempt is scheduled.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.shouldReconnect = false;
      return;
    }

    const backoffMs = calculateBackoffMs(this.reconnectAttempts++);
    const generation = this.connectGeneration;
    const sequence = ++this.reconnectSequence;
    const current = (): boolean =>
      this.shouldReconnect && this.connectGeneration === generation && this.reconnectSequence === sequence;

    const timer = setTimeout(async () => {
      // A callback already queued when cancelled must not start another discovery.
      if (this.reconnectTimeout !== timer) return;
      clearTimeout(timer);
      this.reconnectTimeout = null;
      if (!current()) return;

      let result: DiscoverResult;
      try {
        result = await this.discoverWithDeadline();
      } catch {
        if (!current()) return;
        this.warn(
          `[EventSubscriber] Discovery threw before reconnect attempt ${this.reconnectAttempts}:`,
          'WebSocket discovery failed or timed out'
        );
        this.scheduleReconnect();
        return;
      }
      if (!current()) return;
      if (
        typeof result !== 'object' ||
        result === null ||
        'error' in result ||
        typeof result.wsUrl !== 'string' ||
        typeof result.accessToken !== 'string'
      ) {
        this.warn(
          `[EventSubscriber] Discovery failed before reconnect attempt ${this.reconnectAttempts}:`,
          'Server discovery unavailable'
        );
        this.scheduleReconnect();
        return;
      }
      try {
        await this._openSocket(result.wsUrl, result.accessToken);
      } catch {
        // A close/error may have already scheduled the next attempt. Sequence,
        // not just connect generation, prevents this older catch from duplicating it.
        if (!current()) return;
        this.warn(`[EventSubscriber] Reconnection attempt ${this.reconnectAttempts} failed`);
        this.scheduleReconnect();
      }
    }, backoffMs);
    this.reconnectTimeout = timer;
  }

  /**
   * Shared disconnect-state transition: marks the connection as down, stops
   * the heartbeat, fires connection-change callbacks, and arms the reconnect
   * scheduler when appropriate.
   *
   * Callers are responsible for cleaning up the socket (close / nullify)
   * before or alongside this call — this method only handles the state and
   * notification side of a disconnect.
   */
  private _teardownConnection(): void {
    this.connected = false;
    this._stopHeartbeat();
    if (this.hasConnected) {
      // Snapshot before iterating: a callback that calls the
      // onConnectionChange unsubscribe function for another callback during
      // this dispatch must not cause that callback to be skipped for this
      // notification.
      this.notifyConnectionChange(false);
    }
    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  /**
   * Starts the app-level heartbeat. Sends `{ type: 'ping' }` every
   * {@link HEARTBEAT_INTERVAL_MS} and tracks missed pongs; closes the socket
   * after {@link MISSED_PONG_LIMIT} consecutive misses to trigger reconnection.
   *
   * Protocol-level pings (sent by the server every 30 s) are invisible to
   * browser JavaScript, so an app-level exchange is required for liveness
   * detection. Two consecutive misses tolerate one lost response (e.g., due
   * to throttled timers in a backgrounded VS Code webview).
   *
   * Defensive: any pre-existing heartbeat interval is stopped first so a second
   * invocation can never leak a timer.
   */
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.missedPongs = 0;
    this.heartbeatInterval = setInterval(() => {
      if (!this.isConnected()) return;
      this.missedPongs++;
      if (this.missedPongs >= EventSubscriber.MISSED_PONG_LIMIT) {
        this.warn(`[EventSubscriber] Missed ${this.missedPongs} pongs — closing connection for reconnect`);
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this._teardownConnection();
        return;
      }
      try {
        this.send({ type: 'ping' });
      } catch (err) {
        // send() throws when not connected — possible race between
        // isConnected() check and a socket close. The missed-pong
        // counter above will trigger reconnect naturally.
        this.warn('[EventSubscriber] heartbeat ping failed:', err);
      }
    }, EventSubscriber.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stops the heartbeat interval timer.
   */
  private _stopHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Whether `type` names a per-card journal message (`card:snapshot`,
   * `card:replay`, `card:subscribeFailed`, `card:journalEvent`) — i.e. one
   * that must be dropped in {@link handleMessage} unless its `cardId` is in
   * {@link subscribedCardIds}.
   *
   * @param type - The message's `type` discriminator.
   * @returns True when `type` is one of the four per-card journal message types.
   */
  private _isCardScopedMessageType(type: string): boolean {
    return (
      type === 'card:snapshot' ||
      type === 'card:replay' ||
      type === 'card:subscribeFailed' ||
      type === 'card:journalEvent'
    );
  }

  /**
   * Runtime shape guard for the card-scoped journal envelopes that drive
   * sequence state (`card:snapshot`, `card:replay`, `card:journalEvent`;
   * other card-scoped types pass untouched). Runs BEFORE any state mutation
   * so a malformed message can neither advance `cardSeq`, flip staleness,
   * nor throw mid-listener (e.g. `.filter` on missing replay `entries`).
   * Non-numeric sequence numbers are rejected outright — a string `seq` that
   * reached `cardSeq` would make `"7" + 1 === "71"` in the gap check and
   * warn/re-subscribe on every live event.
   *
   * Malformed messages are rejected fail-closed: logged once, then dropped
   * without touching `cardSeq`, staleness, or callbacks. Well-formed
   * messages pass unchanged.
   *
   * @param message - Parsed message whose card-scoped `type` and subscribed
   *   string `cardId` have already been verified by {@link handleMessage}.
   * @param message.type - Discriminator naming which journal envelope shape to enforce.
   * @returns True when the message is safe to process.
   */
  private _isValidJournalEnvelope(message: { type: string; [key: string]: unknown }): boolean {
    const reject = (detail: string): boolean => {
      this.warn(
        `[EventSubscriber] Dropping malformed '${message.type}' for card ${String(message['cardId'])}: ${detail}`
      );
      return false;
    };
    switch (message.type) {
      case 'card:snapshot':
        if (!isValidSeq(message['seq'])) {
          return reject('snapshot seq must be an integer');
        }
        return true;
      case 'card:replay': {
        const entries = message['entries'];
        if (!isValidSeq(message['latestSeq'])) {
          return reject('replay latestSeq must be an integer');
        }
        if (!Array.isArray(entries)) {
          return reject('replay entries must be an array');
        }
        for (let i = 0; i < entries.length; i++) {
          if (!isWellFormedJournalEntry(entries[i])) {
            return reject(`replay entry ${i} must carry an integer seq, a string type, and a string timestamp`);
          }
        }
        return true;
      }
      case 'card:journalEvent':
        if (!isValidSeq(message['seq'])) {
          return reject('journalEvent seq must be an integer');
        }
        if (typeof message['entryType'] !== 'string') {
          return reject('journalEvent entryType must be a string');
        }
        if (typeof message['timestamp'] !== 'string') {
          return reject('journalEvent timestamp must be a string');
        }
        return true;
      default:
        return true;
    }
  }

  /**
   * Handles incoming WebSocket messages and dispatches to registered callbacks.
   *
   * Messages are expected to be JSON with a `type` field matching {@link EventMap}.
   * Per-card journal messages ({@link _isCardScopedMessageType}) are dropped
   * unless their `cardId` is in {@link subscribedCardIds} — the server
   * broadcasts these for every card to every client, and this subscriber only
   * asked about the cards passed to {@link subscribeToCard}. Subscribed-card
   * messages that fail envelope shape validation
   * ({@link _isValidJournalEnvelope}) are likewise logged once and dropped,
   * before any state mutation.
   *
   * @param event - Browser WebSocket message event containing the serialized payload.
   */
  private handleMessage(event: MessageEvent): void {
    let message: { type: keyof EventMap; [key: string]: unknown };
    try {
      message = JSON.parse(event.data as string);
    } catch (error) {
      // Parse failures are a distinct path from callback failures: a malformed
      // payload yields no message to dispatch, so log it accurately and stop.
      this.warn('Failed to parse WebSocket message:', error);
      return;
    }

    // Handle app-level pong — reset missed counter so the heartbeat
    // timer doesn't force a disconnect.
    if ((message as { type: string }).type === 'pong') {
      this.missedPongs = 0;
      return;
    }

    // Per-card journal messages name the card they concern via `cardId`. The
    // server broadcasts these to every connected client regardless of
    // subscription, so a message for a card this subscriber never asked for
    // (via subscribeToCard) must be dropped here before any seq tracking,
    // staleness update, or callback dispatch — and, critically, before
    // _handleCardJournalEvent's gap detection could mistake it for a gap and
    // send card:subscribe for a card the caller never requested. Fail closed.
    if (this._isCardScopedMessageType(message.type)) {
      const cardId = (message as { cardId?: unknown }).cardId;
      if (typeof cardId !== 'string' || !this.subscribedCardIds.has(cardId)) {
        return;
      }
      // Shape-validate the envelope BEFORE any handler runs so a malformed
      // message neither mutates seq/staleness state nor throws out of this
      // listener — logged once here, then dropped.
      if (!this._isValidJournalEnvelope(message)) {
        return;
      }
    }

    switch (message.type as string) {
      case 'card:snapshot':
        this._handleCardSnapshot(message as unknown as CardSnapshotMessage);
        break;
      case 'card:replay':
        // Handles its own dispatch (filters out entries already applied via a
        // live card:journalEvent delivered before this replay was assembled)
        // — return rather than falling through to the generic dispatch below.
        this._handleCardReplay(message as unknown as CardReplayMessage);
        return;
      case 'card:subscribeFailed':
        this._handleCardSubscribeFailed(message as unknown as CardSubscribeFailedMessage);
        break;
      case 'card:journalEvent':
        // Handles its own dispatch (only forwards in-order entries) — return
        // rather than falling through to the generic dispatch below.
        this._handleCardJournalEvent(message as unknown as CardJournalEventMessage);
        return;
      default:
        break;
    }

    this._dispatch(message);
  }

  /**
   * Invokes every callback registered for `message.type`, isolating each
   * callback's failures from its siblings.
   *
   * @param message - The parsed message to dispatch.
   * @param message.type - Discriminator selecting which registered callbacks to invoke.
   */
  private _dispatch(message: { type: keyof EventMap }): void {
    const callbacks = this.callbacks.get(message.type);
    if (!callbacks) return;
    // Each typed callback is isolated: an exception in one must not starve
    // sibling callbacks registered for the same event (Set iteration follows
    // registration order). Log the failure against the event type so the
    // diagnostic points at the offending handler, not at JSON parsing.
    // Snapshot before iterating: a callback that calls off() for another
    // callback of the same event during this dispatch must not cause that
    // callback to be skipped for this message.
    for (const callback of [...callbacks]) {
      try {
        (callback as (event: unknown) => void)(message);
      } catch (error) {
        this.warn(`Event callback for '${String(message.type)}' threw:`, error);
      }
    }
  }

  /**
   * Records the snapshot's `seq` as this card's last known-good position and
   * clears any staleness — a snapshot is always a full, trustworthy catch-up.
   *
   * @param message - Server reply carrying the full card state and its `seq`.
   */
  private _handleCardSnapshot(message: CardSnapshotMessage): void {
    this.cardSeq.set(message.cardId, message.seq);
    this._setCardStaleness(message.cardId, 'ok');
  }

  /**
   * Records the replay's `latestSeq` as this card's last known-good position,
   * then dispatches the message with `entries` filtered down to those whose
   * `seq` is strictly greater than the card's previously tracked `seq`.
   *
   * The server registers a resubscribe before it finishes assembling the
   * matching replay, so a live `card:journalEvent` for an entry can be
   * delivered and applied (advancing `cardSeq`) before the replay containing
   * that same entry arrives — without this filter, that entry would be
   * applied a second time. Individual entries are not re-dispatched as
   * separate `card:journalEvent` callbacks here — callers that need
   * per-entry handling read the (filtered) `entries` off the dispatched
   * `card:replay` message itself.
   *
   * @param message - Server reply carrying ordered catch-up deltas.
   */
  private _handleCardReplay(message: CardReplayMessage): void {
    const previousSeq = this.cardSeq.get(message.cardId) ?? 0;
    this.cardSeq.set(message.cardId, message.latestSeq);
    this._setCardStaleness(message.cardId, 'ok');
    const entries = message.entries.filter((entry) => entry.seq > previousSeq);
    this._dispatch(entries.length === message.entries.length ? message : { ...message, entries });
  }

  /**
   * Marks a card stale: the server could not assemble a snapshot for it.
   * Surfaced to callers via {@link onStaleness} so they fail closed rather
   * than trusting whatever local state they had.
   *
   * @param message - Server reply naming the card and the failure reason.
   */
  private _handleCardSubscribeFailed(message: CardSubscribeFailedMessage): void {
    this._setCardStaleness(message.cardId, 'stale', message.reason);
  }

  /**
   * Applies a live journal entry if — and only if — it is the immediate
   * successor of the last known-good `seq` for its card. A gap (or a
   * duplicate/out-of-order entry) means one or more prior entries may have
   * been lost in transit; rather than risk applying an event whose
   * predecessor was dropped, this drops the event and re-subscribes with the
   * last known-good `seq` so the server replays the missing range (or falls
   * back to a snapshot). Fail closed: never dispatch past a detected gap.
   *
   * @param message - Live entry carrying its `seq` and the affected `cardId`.
   */
  private _handleCardJournalEvent(message: CardJournalEventMessage): void {
    const expected = (this.cardSeq.get(message.cardId) ?? 0) + 1;
    if (message.seq !== expected) {
      this.warn(
        `[EventSubscriber] seq gap for card ${message.cardId}: expected ${expected}, got ${message.seq} — re-subscribing`
      );
      this._sendCardSubscribe(message.cardId);
      return;
    }
    this.cardSeq.set(message.cardId, message.seq);
    this._dispatch(message);
  }
}

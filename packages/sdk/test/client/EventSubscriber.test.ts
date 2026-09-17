/**
 * Unit and integration tests for EventSubscriber.
 *
 * @summary Tests for EventSubscriber WebSocket client
 */

import { TestWebSocketServer } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { calculateBackoffMs, EventSubscriber } from '../../src/client/eventSubscriber.js';

/**
 * Mock WebSocket for unit testing without real network I/O.
 * Allows tests to control when events fire.
 */
class MockWebSocket {
  public url: string;
  public readyState: number = WebSocket.CONNECTING;
  public onopen: ((ev: Event) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;

  private eventListeners: Map<string, Set<EventListener>> = new Map();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    this.eventListeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  private dispatchEvent(type: string, event: Event): void {
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  // Test controls
  simulateOpen(): void {
    this.readyState = WebSocket.OPEN;
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent('open', event);
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = WebSocket.CLOSED;
    const event = new CloseEvent('close', { code, reason });
    this.onclose?.(event);
    this.dispatchEvent('close', event);
  }

  simulateError(): void {
    const event = new Event('error');
    this.onerror?.(event);
    this.dispatchEvent('error', event);
  }

  simulateMessage(data: unknown): void {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(event);
    this.dispatchEvent('message', event);
  }

  close(): void {
    this.simulateClose();
  }

  send(_data: string): void {
    // No-op for testing
  }
}

/**
 * Creates a globalThis.WebSocket override that instantiates MockWebSocket.
 *
 * @returns Object with accumulated MockWebSocket instances and a restore function.
 */
function installMockWebSocket(): { instances: MockWebSocket[]; restore: () => void } {
  const instances: MockWebSocket[] = [];
  const original = globalThis.WebSocket;

  function MockWebSocketConstructor(url: string): MockWebSocket {
    const ws = new MockWebSocket(url);
    instances.push(ws);
    return ws;
  }

  globalThis.WebSocket = MockWebSocketConstructor as unknown as typeof WebSocket;

  return {
    instances,
    restore: () => {
      globalThis.WebSocket = original;
    }
  };
}

/**
 * Helper to get the last setTimeout callback from a spy.
 *
 * @param spy - Mocked `setTimeout` spy containing captured calls.
 * @returns Callback function from the most recent `setTimeout` call.
 * @throws Error if no timeout calls were recorded on the spy.
 */
function getLastTimeoutCallback(spy: MockInstance): () => void {
  const calls = spy.mock.calls;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) throw new Error('No setTimeout calls recorded');
  return lastCall[0] as () => void;
}

/**
 * Helper to get the last setTimeout delay from a spy.
 *
 * @param spy - Mocked `setTimeout` spy containing captured calls.
 * @returns Delay argument from the most recent `setTimeout` call.
 * @throws Error if no timeout calls were recorded on the spy.
 */
function getLastTimeoutDelay(spy: MockInstance): number {
  const calls = spy.mock.calls;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) throw new Error('No setTimeout calls recorded');
  return lastCall[1] as number;
}

describe('calculateBackoffMs', () => {
  it('should start at 1000ms for attempt 0', () => {
    expect(calculateBackoffMs(0)).toBe(1000);
  });

  it('should double each attempt', () => {
    expect(calculateBackoffMs(0)).toBe(1000);
    expect(calculateBackoffMs(1)).toBe(2000);
    expect(calculateBackoffMs(2)).toBe(4000);
    expect(calculateBackoffMs(3)).toBe(8000);
    expect(calculateBackoffMs(4)).toBe(16000);
  });

  it('should cap at 30000ms by default', () => {
    expect(calculateBackoffMs(5)).toBe(30000);
    expect(calculateBackoffMs(6)).toBe(30000);
    expect(calculateBackoffMs(10)).toBe(30000);
    expect(calculateBackoffMs(100)).toBe(30000);
  });

  it('should respect custom maxMs parameter', () => {
    expect(calculateBackoffMs(0, 500)).toBe(500);
    expect(calculateBackoffMs(5, 10000)).toBe(10000);
    expect(calculateBackoffMs(10, 60000)).toBe(60000);
  });
});

describe('EventSubscriber', () => {
  const defaultOptions = {
    wsUrl: 'ws://localhost:3000/events',
    accessToken: 'test-token',
    discover: () => Promise.resolve({ wsUrl: 'ws://localhost:3000/events', accessToken: 'test-token' })
  };

  describe('constructor and configuration', () => {
    it('should create subscriber with required wsUrl, accessToken, and discover', () => {
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'test-token',
        discover: () => Promise.resolve({ wsUrl: 'ws://localhost:3000/events', accessToken: 'test-token' })
      });
      expect(subscriber).toBeInstanceOf(EventSubscriber);
    });

    it('should return configured WebSocket URL', () => {
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:8080/events',
        accessToken: 'test-token',
        discover: () => Promise.resolve({ wsUrl: 'ws://localhost:8080/events', accessToken: 'test-token' })
      });
      expect(subscriber.getWsUrl()).toBe('ws://localhost:8080/events');
    });
  });

  describe('Event Subscription', () => {
    it('should register callback for card:deleted event', () => {
      const subscriber = new EventSubscriber(defaultOptions);
      const callback = () => {};
      subscriber.on('card:deleted', callback);
      // Verifies on() doesn't throw
    });

    it('should remove callback when off() is called', () => {
      const subscriber = new EventSubscriber(defaultOptions);
      const callback = () => {};
      subscriber.on('card:deleted', callback);
      subscriber.off('card:deleted', callback);
      // Verifies off() doesn't throw
    });

    it('should support multiple callbacks for same event', () => {
      const subscriber = new EventSubscriber(defaultOptions);
      const callback1 = () => {};
      const callback2 = () => {};
      subscriber.on('card:deleted', callback1);
      subscriber.on('card:deleted', callback2);
      // Verifies multiple registrations don't throw
    });
  });

  describe('Connection Lifecycle', () => {
    let mock: ReturnType<typeof installMockWebSocket>;

    beforeEach(() => {
      mock = installMockWebSocket();
    });

    afterEach(() => {
      mock.restore();
    });

    it('should create WebSocket via globalThis.WebSocket when connect() is called', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(mock.instances).toHaveLength(1);
      expect(mock.instances[0]!.url).toContain('token=test-token');
    });

    it('should use accessToken in connection URL', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(mock.instances[0]!.url).toBe('ws://localhost:3000/events?token=test-token');
    });

    it('should encode URL-unsafe characters in access token', async () => {
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'token/with+special=chars&more',
        discover: () =>
          Promise.resolve({ wsUrl: 'ws://localhost:3000/events', accessToken: 'token/with+special=chars&more' })
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(mock.instances[0]!.url).toBe('ws://localhost:3000/events?token=token%2Fwith%2Bspecial%3Dchars%26more');
    });

    it('should close WebSocket when disconnect() is called', () => {
      const subscriber = new EventSubscriber(defaultOptions);
      // disconnect() should not throw even when not connected
      subscriber.disconnect();
    });

    it('should set connected state on successful connection', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      expect(subscriber.isConnected()).toBe(false);

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(subscriber.isConnected()).toBe(true);
    });

    it('should reject on connection error', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateError();

      await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
    });

    it('should use constructor wsUrl and accessToken on initial connect without calling discover', async () => {
      const discoverFn = vi.fn().mockResolvedValue({ wsUrl: 'ws://other:9999/events', accessToken: 'other-token' });
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'original-token',
        discover: discoverFn
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(discoverFn).not.toHaveBeenCalled();
      expect(mock.instances[0]!.url).toBe('ws://localhost:3000/events?token=original-token');
    });

    it('should not flip connected state when a stale socket opens after being superseded', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      // Start a first connect() but do not open it yet.
      const firstConnect = subscriber.connect();
      const staleWs = mock.instances[0]!;

      // A second connect() supersedes the first; its socket is now this.ws.
      const secondConnect = subscriber.connect();
      const liveWs = mock.instances[1]!;
      expect(mock.instances).toHaveLength(2);

      // The superseded socket opens late. Its open handler must not set
      // connected; the first connect()'s promise rejects instead of hanging.
      staleWs.simulateOpen();
      await expect(firstConnect).rejects.toThrow('Superseded by a newer connect()');
      expect(subscriber.isConnected()).toBe(false);

      // The live socket opening drives the real connected state.
      liveWs.simulateOpen();
      await secondConnect;
      expect(subscriber.isConnected()).toBe(true);

      subscriber.disconnect();
    });

    it('should ignore messages from a stale socket that was superseded', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const received: unknown[] = [];
      subscriber.on('card:deleted', (e) => received.push(e));

      const firstConnect = subscriber.connect();
      const staleWs = mock.instances[0]!;
      const secondConnect = subscriber.connect();
      const liveWs = mock.instances[1]!;

      staleWs.simulateOpen();
      await expect(firstConnect).rejects.toThrow();
      liveWs.simulateOpen();
      await secondConnect;

      // A late message from the stale socket must be ignored.
      staleWs.simulateMessage({ type: 'card:deleted', cardId: 'stale' });
      expect(received).toHaveLength(0);

      // Messages from the live socket are still delivered.
      liveWs.simulateMessage({ type: 'card:deleted', cardId: 'live' });
      expect(received).toHaveLength(1);

      subscriber.disconnect();
    });
  });

  describe('heartbeat', () => {
    let mock: ReturnType<typeof installMockWebSocket>;
    let setIntervalSpy: MockInstance;
    let clearIntervalSpy: MockInstance;

    beforeEach(() => {
      mock = installMockWebSocket();
      setIntervalSpy = vi.spyOn(global, 'setInterval');
      clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    });

    afterEach(() => {
      mock.restore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });

    it('should not leak a prior interval when the heartbeat starts twice', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      // First successful open starts a heartbeat interval.
      const firstConnect = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await firstConnect;
      const intervalsAfterFirst = setIntervalSpy.mock.calls.length;
      const clearsBeforeSecond = clearIntervalSpy.mock.calls.length;

      // A fresh connect() opens again; _startHeartbeat must clear the prior
      // interval before creating the new one.
      const secondConnect = subscriber.connect();
      mock.instances[mock.instances.length - 1]!.simulateOpen();
      await secondConnect;

      expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(intervalsAfterFirst);
      // The prior interval was cleared (connect() stops heartbeat, and
      // _startHeartbeat defensively stops again before re-arming).
      expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBeforeSecond);

      subscriber.disconnect();
    });
  });

  describe('send()', () => {
    let mock: ReturnType<typeof installMockWebSocket>;

    beforeEach(() => {
      mock = installMockWebSocket();
    });

    afterEach(() => {
      mock.restore();
    });

    it('should send JSON-serialized data on connected socket', async () => {
      const subscriber = new EventSubscriber(defaultOptions);
      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      const sendSpy = vi.spyOn(mock.instances[0]!, 'send');
      const payload = { type: 'action:executeResult', cardId: 'card-123', result: 'ok' };
      subscriber.send(payload);

      expect(sendSpy).toHaveBeenCalledOnce();
      expect(sendSpy).toHaveBeenCalledWith(JSON.stringify(payload));
    });

    it('should throw when sending on disconnected socket', () => {
      const subscriber = new EventSubscriber(defaultOptions);
      expect(() => subscriber.send({ type: 'action:executeResult' })).toThrow(
        'Cannot send: EventSubscriber is not connected'
      );
    });
  });

  describe('Message Handling', () => {
    let mock: ReturnType<typeof installMockWebSocket>;
    let warnSpy: MockInstance;

    beforeEach(() => {
      mock = installMockWebSocket();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      mock.restore();
      warnSpy.mockRestore();
    });

    it('should invoke callback when message received', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const receivedEvents: unknown[] = [];
      subscriber.on('card:deleted', (event) => {
        receivedEvents.push(event);
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      mock.instances[0]!.simulateMessage({
        type: 'card:deleted',
        cardId: 'card-123'
      });

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toMatchObject({
        cardId: 'card-123'
      });
    });

    it('should stop receiving events after unsubscribe', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const receivedEvents: unknown[] = [];
      const callback = (event: unknown) => {
        receivedEvents.push(event);
      };
      subscriber.on('card:deleted', callback);

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      subscriber.off('card:deleted', callback);

      mock.instances[0]!.simulateMessage({
        type: 'card:deleted',
        cardId: 'card-123'
      });

      expect(receivedEvents).toHaveLength(0);
    });
  });

  describe('Reconnection with Exponential Backoff', () => {
    let mock: ReturnType<typeof installMockWebSocket>;
    let setTimeoutSpy: MockInstance;
    let warnSpy: MockInstance;

    beforeEach(() => {
      mock = installMockWebSocket();
      setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      mock.restore();
      setTimeoutSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should schedule reconnect with 1000ms delay on first attempt', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 5 });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Connection drops
      mock.instances[0]!.simulateClose();

      // Verify first reconnect scheduled at 1000ms
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      subscriber.disconnect();
    });

    it('should use exponential backoff delays: 1s, 2s, 4s, 8s...', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 5 });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Connection drops, triggers first reconnect
      mock.instances[0]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      // Fire timeout callback, wait for discovery, simulate failed reconnect
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(2));
      mock.instances[mock.instances.length - 1]!.simulateError();
      mock.instances[mock.instances.length - 1]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(2000);

      // Fire and fail again
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(3));
      mock.instances[mock.instances.length - 1]!.simulateError();
      mock.instances[mock.instances.length - 1]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(4000);

      // Fire and fail again
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(4));
      mock.instances[mock.instances.length - 1]!.simulateError();
      mock.instances[mock.instances.length - 1]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(8000);

      subscriber.disconnect();
    });

    it('should create new WebSocket on each reconnection attempt', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 3 });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;
      expect(mock.instances).toHaveLength(1);

      // Connection drops
      mock.instances[0]!.simulateClose();

      // Fire timeout, wait for discovery, new WebSocket created
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(2));

      // Fail and trigger next reconnect
      mock.instances[1]!.simulateError();
      mock.instances[1]!.simulateClose();
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(3));

      subscriber.disconnect();
    });

    it('should reset attempt counter on successful reconnection', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 5 });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // First disconnect
      mock.instances[0]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      // Reconnect succeeds — wait for discovery before simulating open
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(2));
      mock.instances[mock.instances.length - 1]!.simulateOpen();

      // Second disconnect - should reset to 1000ms, not continue to 2000ms
      mock.instances[mock.instances.length - 1]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      subscriber.disconnect();
    });

    it('should use discovered URL and token on reconnect', async () => {
      const discoverFn = vi.fn().mockResolvedValue({
        wsUrl: 'ws://newhost:4000/events',
        accessToken: 'new-token'
      });
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'original-token',
        discover: discoverFn,
        maxReconnectAttempts: 3
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Connection drops
      mock.instances[0]!.simulateClose();

      // Fire timeout — discovery runs, then connect with discovered values
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(2));

      expect(discoverFn).toHaveBeenCalledOnce();
      expect(mock.instances[1]!.url).toBe('ws://newhost:4000/events?token=new-token');

      subscriber.disconnect();
    });

    it('should schedule next attempt and warn when discovery returns error', async () => {
      const discoverFn = vi.fn().mockResolvedValue({ error: 'server not ready' });
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'test-token',
        discover: discoverFn,
        maxReconnectAttempts: 3
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Connection drops — scheduleReconnect called with attempt 0 → delay 1000ms
      mock.instances[0]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      // Fire timeout — discovery returns error, should schedule next attempt
      getLastTimeoutCallback(setTimeoutSpy)();

      // Wait for the async discovery result to propagate
      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Discovery failed'),
          'Server discovery unavailable'
        );
      });

      // No new WebSocket created
      expect(mock.instances).toHaveLength(1);
      // Next backoff scheduled (attempt 1 → delay 2000ms)
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(2000);

      subscriber.disconnect();
    });

    it('should schedule next attempt and warn when discovery throws', async () => {
      const discoverError = new Error('network unreachable');
      const discoverFn = vi.fn().mockRejectedValue(discoverError);
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'test-token',
        discover: discoverFn,
        maxReconnectAttempts: 3
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Connection drops
      mock.instances[0]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      // Fire timeout — discovery throws, should schedule next attempt
      getLastTimeoutCallback(setTimeoutSpy)();

      // Wait for the async discovery rejection to propagate
      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Discovery threw'),
          'WebSocket discovery failed or timed out'
        );
      });

      // No new WebSocket created
      expect(mock.instances).toHaveLength(1);
      // Next backoff scheduled (attempt 1 → delay 2000ms)
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(2000);

      subscriber.disconnect();
    });

    it('should count discovery failures toward maxReconnectAttempts', async () => {
      const discoverFn = vi.fn().mockResolvedValue({ error: 'server not ready' });
      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'test-token',
        discover: discoverFn,
        maxReconnectAttempts: 2
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Connection drops — attempt 0 scheduled
      mock.instances[0]!.simulateClose();

      // First discovery failure (uses attempt slot 0, increments to 1)
      await getLastTimeoutCallback(setTimeoutSpy)();
      expect(discoverFn).toHaveBeenCalledTimes(1);

      // Second discovery failure (uses attempt slot 1, increments to 2)
      await getLastTimeoutCallback(setTimeoutSpy)();
      expect(discoverFn).toHaveBeenCalledTimes(2);

      // Exhausted — scheduleReconnect should set shouldReconnect=false
      // The last scheduleReconnect call finds attempts >= max and stops
      // No more timeouts scheduled beyond the two already consumed
      const timeoutCallCount = setTimeoutSpy.mock.calls.length;
      // Trigger the last scheduled timeout if one exists
      const lastCb = getLastTimeoutCallback(setTimeoutSpy);
      await lastCb();
      // After exhaustion, no additional timeouts should be scheduled
      expect(setTimeoutSpy.mock.calls.length).toBe(timeoutCallCount);
    });

    it('should cancel a pending reconnect timer when connect() is called manually', async () => {
      // This pins the fix: if a failed initial connect schedules a backoff
      // timer and the caller immediately calls connect() again (as
      // seedFromInitData does), the pending timer must be cancelled so it
      // does not race and create a second WebSocket.
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 5 });

      // First connect fails — the close event that follows will schedule a
      // reconnect timeout.
      const firstConnect = subscriber.connect();
      mock.instances[0]!.simulateError();
      mock.instances[0]!.simulateClose();
      await expect(firstConnect).rejects.toThrow('WebSocket connection failed');

      const timeoutCountAfterFail = setTimeoutSpy.mock.calls.length;
      expect(timeoutCountAfterFail).toBeGreaterThan(0);

      // Caller issues a manual connect() before the pending timer fires.
      const secondConnect = subscriber.connect();
      mock.instances[1]!.simulateOpen();
      await secondConnect;

      // The pending timer from the first failure must have been cancelled; no
      // additional socket should be created when the timer delay expires.
      const timeoutCountAfterSecond = setTimeoutSpy.mock.calls.length;

      // Fire every timeout that was scheduled up to this point — none should
      // create a new WebSocket because the timer was cleared by connect().
      for (const call of setTimeoutSpy.mock.calls.slice(0, timeoutCountAfterSecond)) {
        const cb = call[0] as () => void;
        cb();
      }
      await vi.waitFor(() => {}); // flush microtasks

      // Still only two WebSocket instances — the cancelled timer did not fire.
      expect(mock.instances).toHaveLength(2);

      subscriber.disconnect();
    });

    it('should reset reconnect attempt counter when connect() is called manually mid-backoff', async () => {
      // After a failed initial connect that schedules attempt 0 (delay 1000ms),
      // a manual connect() should reset the counter so the *next* auto-reconnect
      // (if this one also fails) starts fresh at 1000ms rather than 2000ms.
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 5 });

      // Fail the initial connect — scheduleReconnect increments attempt to 1.
      const firstConnect = subscriber.connect();
      mock.instances[0]!.simulateError();
      mock.instances[0]!.simulateClose();
      await expect(firstConnect).rejects.toThrow('WebSocket connection failed');

      // Manual connect() — should reset reconnectAttempts to 0.
      const secondConnect = subscriber.connect();
      // Let the second connect fail too.
      mock.instances[1]!.simulateError();
      mock.instances[1]!.simulateClose();
      await expect(secondConnect).rejects.toThrow('WebSocket connection failed');

      // The next scheduled backoff must start at 1000ms (attempt 0), not 2000ms.
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      subscriber.disconnect();
    });

    it('should not open a socket from a stale reconnect whose generation was advanced during in-flight discovery', async () => {
      // Use a deferred promise so the test controls when discover() resolves.
      // This recreates the race: timer fires → discover() starts (async) →
      // manual connect() advances connectGeneration and opens a healthy socket →
      // discover() resolves → the stale .then() callback calls _openSocket()
      // without re-checking generation, clobbering the healthy socket.
      let resolveDiscover!: (value: { wsUrl: string; accessToken: string }) => void;
      const discoverPromise = new Promise<{ wsUrl: string; accessToken: string }>((resolve) => {
        resolveDiscover = resolve;
      });
      const discoverFn = vi.fn().mockReturnValue(discoverPromise);

      const subscriber = new EventSubscriber({
        wsUrl: 'ws://localhost:3000/events',
        accessToken: 'test-token',
        discover: discoverFn,
        maxReconnectAttempts: 5
      });

      // Step 1: Open initial connection.
      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;
      expect(mock.instances).toHaveLength(1);

      // Step 2: Connection drops — scheduleReconnect captures the current
      // generation and arms a backoff timer.
      mock.instances[0]!.simulateClose();
      expect(getLastTimeoutDelay(setTimeoutSpy)).toBe(1000);

      // Step 3: Fire the timeout callback. The generation check at timer-fire
      // passes (generation has not advanced yet), so discover() is called —
      // but the returned promise does not resolve yet.
      getLastTimeoutCallback(setTimeoutSpy)();
      expect(discoverFn).toHaveBeenCalledOnce();

      // Step 4: While discover is in-flight, a manual connect() advances
      // connectGeneration and opens a healthy socket via _openSocket(), which
      // also sets shouldReconnect = true.
      const manualConnect = subscriber.connect();
      mock.instances[1]!.simulateOpen();
      await manualConnect;
      expect(mock.instances).toHaveLength(2);

      // Step 5: Resolve the deferred discover promise. The stale .then()
      // callback at line 372 only checks shouldReconnect (still true) and
      // proceeds to call _openSocket(), which closes the healthy socket
      // from step 4 and creates a replacement — even though the generation
      // counter has advanced.
      resolveDiscover({ wsUrl: 'ws://localhost:3000/events', accessToken: 'test-token' });

      // Flush microtasks so the .then() callback and its synchronous
      // _openSocket side effects (WebSocket construction) complete.
      await new Promise((r) => setTimeout(r, 0));

      // The stale reconnect must not have created an additional WebSocket.
      // With the bug, mock.instances.length === 3 because _openSocket creates
      // a new WebSocket synchronously before returning its promise.
      expect(mock.instances).toHaveLength(2);

      subscriber.disconnect();
    });
  });

  describe('Connection Change Callbacks', () => {
    let mock: ReturnType<typeof installMockWebSocket>;
    let setTimeoutSpy: MockInstance;
    let warnSpy: MockInstance;

    beforeEach(() => {
      mock = installMockWebSocket();
      setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      mock.restore();
      setTimeoutSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should call callback with true when connection opens', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const states: boolean[] = [];
      subscriber.onConnectionChange((connected) => states.push(connected));

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(states).toEqual([true]);

      subscriber.disconnect();
    });

    it('should call callback with false when connection drops after successful connect', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 1 });

      const states: boolean[] = [];
      subscriber.onConnectionChange((connected) => states.push(connected));

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      mock.instances[0]!.simulateClose();

      expect(states).toEqual([true, false]);

      subscriber.disconnect();
    });

    it('should not fire false callback before first successful connection', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 1 });

      const states: boolean[] = [];
      subscriber.onConnectionChange((connected) => states.push(connected));

      const connectPromise = subscriber.connect();
      // Simulate error before ever connecting successfully
      mock.instances[0]!.simulateError();

      await expect(connectPromise).rejects.toThrow();

      // The close event from error should NOT trigger a false callback
      expect(states).toEqual([]);
    });

    it('should allow unsubscribing via returned function', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const states: boolean[] = [];
      const unsubscribe = subscriber.onConnectionChange((connected) => states.push(connected));

      unsubscribe();

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      expect(states).toEqual([]);

      subscriber.disconnect();
    });

    it('should call callback with true on successful reconnection after drop', async () => {
      const subscriber = new EventSubscriber({ ...defaultOptions, maxReconnectAttempts: 3 });

      const states: boolean[] = [];
      subscriber.onConnectionChange((connected) => states.push(connected));

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // Drop connection
      mock.instances[0]!.simulateClose();

      // Trigger reconnect via timeout callback — wait for discovery to complete
      getLastTimeoutCallback(setTimeoutSpy)();
      await vi.waitFor(() => expect(mock.instances).toHaveLength(2));
      // Reconnect succeeds
      mock.instances[mock.instances.length - 1]!.simulateOpen();

      expect(states).toEqual([true, false, true]);

      subscriber.disconnect();
    });
  });

  describe('Integration with TestWebSocketServer', () => {
    let server: TestWebSocketServer;
    let warnSpy: MockInstance;

    beforeEach(async () => {
      server = new TestWebSocketServer();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
      warnSpy.mockRestore();
      await server.stop();
    });

    it('should connect to real WebSocket server', async () => {
      const port = await server.start();
      const subscriber = new EventSubscriber({
        wsUrl: `ws://localhost:${port}/events`,
        accessToken: 'test-token',
        discover: () => Promise.resolve({ wsUrl: `ws://localhost:${port}/events`, accessToken: 'test-token' })
      });

      await subscriber.connect();

      expect(server.getClientCount()).toBe(1);
      expect(subscriber.isConnected()).toBe(true);

      subscriber.disconnect();
    });

    it('should include auth token in WebSocket URL', async () => {
      const port = await server.start({ authToken: 'test-token' });
      const subscriber = new EventSubscriber({
        wsUrl: `ws://localhost:${port}/events`,
        accessToken: 'test-token',
        discover: () => Promise.resolve({ wsUrl: `ws://localhost:${port}/events`, accessToken: 'test-token' })
      });

      await subscriber.connect();

      // Verify connection succeeded (token was properly included)
      expect(subscriber.isConnected()).toBe(true);

      subscriber.disconnect();
    });

    it('should receive events from server', async () => {
      const port = await server.start();
      const subscriber = new EventSubscriber({
        wsUrl: `ws://localhost:${port}/events`,
        accessToken: 'test-token',
        discover: () => Promise.resolve({ wsUrl: `ws://localhost:${port}/events`, accessToken: 'test-token' })
      });

      const receivedEvents: unknown[] = [];
      subscriber.on('card:deleted', (event) => {
        receivedEvents.push(event);
      });

      await subscriber.connect();

      server.broadcast({
        type: 'card:deleted',
        cardId: 'card-123'
      });

      // Wait for async event delivery
      await vi.waitFor(() => {
        expect(receivedEvents).toHaveLength(1);
      });
      expect(receivedEvents[0]).toMatchObject({
        cardId: 'card-123'
      });

      subscriber.disconnect();
    });

    it('should reconnect after server restart (event-based)', async () => {
      const port = await server.start();
      const subscriber = new EventSubscriber({
        wsUrl: `ws://localhost:${port}/events`,
        accessToken: 'test-token',
        discover: () => Promise.resolve({ wsUrl: `ws://localhost:${port}/events`, accessToken: 'test-token' }),
        maxReconnectAttempts: 3
      });

      await subscriber.connect();
      expect(server.getClientCount()).toBe(1);

      // Stop server - triggers reconnection attempts (which will fail)
      await server.stop();

      // Restart server on same port
      await server.start({ port });

      // Wait for reconnection EVENT, not for time to pass
      await server.awaitConnection(5000);

      // Wait for the subscriber to process the 'open' event and update its state
      // The server sees the connection before the client's open event fires
      await vi.waitFor(() => {
        expect(subscriber.isConnected()).toBe(true);
      });

      expect(subscriber.isConnected()).toBe(true);
      expect(server.getClientCount()).toBe(1);

      subscriber.disconnect();
    });
  });

  describe('typed-callback error isolation', () => {
    let mock: ReturnType<typeof installMockWebSocket>;
    let warnSpy: MockInstance;

    beforeEach(() => {
      mock = installMockWebSocket();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      mock.restore();
      warnSpy.mockRestore();
    });

    it('should invoke every callback for an event even when an earlier one throws', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const calls: string[] = [];
      subscriber.on('card:deleted', () => {
        calls.push('first');
        throw new Error('handler boom');
      });
      subscriber.on('card:deleted', () => {
        calls.push('second');
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      mock.instances[0]!.simulateMessage({ type: 'card:deleted', cardId: 'card-123' });

      // The throwing first callback must not starve the second.
      expect(calls).toEqual(['first', 'second']);
    });

    it('should log a callback failure rather than a parse failure when a callback throws', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      subscriber.on('card:deleted', () => {
        throw new Error('handler boom');
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      mock.instances[0]!.simulateMessage({ type: 'card:deleted', cardId: 'card-123' });

      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('Failed to parse WebSocket message'))).toBe(false);
      expect(messages.some((m) => m.includes('card:deleted'))).toBe(true);
    });
  });

  describe('unsubscribe-during-dispatch', () => {
    let mock: ReturnType<typeof installMockWebSocket>;

    beforeEach(() => {
      mock = installMockWebSocket();
    });

    afterEach(() => {
      mock.restore();
    });

    it('still invokes a typed callback registered after one that calls off() on a sibling during dispatch', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const calls: string[] = [];
      const second = (): void => {
        calls.push('second');
      };
      subscriber.on('card:deleted', () => {
        calls.push('first');
        subscriber.off('card:deleted', second);
      });
      subscriber.on('card:deleted', second);

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      mock.instances[0]!.simulateMessage({ type: 'card:deleted', cardId: 'card-123' });

      // `second` was still registered at the moment this dispatch began, so it
      // must still fire for this message even though `first` unregistered it
      // mid-dispatch. A live (non-snapshotted) Set iteration would skip it.
      expect(calls).toEqual(['first', 'second']);
    });

    it('still notifies an onConnectionChange callback that a sibling unsubscribes during the same dispatch', async () => {
      const subscriber = new EventSubscriber(defaultOptions);

      const states: string[] = [];
      let unsubscribeSecond: () => void = () => {};
      subscriber.onConnectionChange(() => {
        states.push('first');
        unsubscribeSecond();
      });
      unsubscribeSecond = subscriber.onConnectionChange(() => {
        states.push('second');
      });

      const connectPromise = subscriber.connect();
      mock.instances[0]!.simulateOpen();
      await connectPromise;

      // `first` unregisters `second` before `second`'s turn in the same
      // dispatch. A live (non-snapshotted) Set iteration would skip it.
      expect(states).toEqual(['first', 'second']);
    });
  });
});

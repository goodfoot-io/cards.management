/**
 * Exercises bounded WebSocket attempts across API handoff and disposal.
 *
 * @summary Regression tests for superseded connects and discovery deadlines
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriber } from '../../src/client/eventSubscriber.js';
import type { DiscoverResult } from '../../src/client/types/events.js';

/** A socket whose opening and close events are controlled by each test. */
class ControlledSocket extends EventTarget {
  static readonly sockets: ControlledSocket[] = [];
  readonly url: string;
  readyState = 0;
  closeCalls = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    ControlledSocket.sockets.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  send(_value: string): void {}
}

const endpoint = { wsUrl: 'ws://localhost:41001/events', accessToken: 'synthetic-a' };

describe('EventSubscriber handoff attempt lifetime', () => {
  let subscriber: EventSubscriber;
  const warn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    ControlledSocket.sockets.length = 0;
    vi.stubGlobal('WebSocket', ControlledSocket);
    warn.mockReset();
  });

  afterEach(() => {
    subscriber?.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function create(options: Partial<ConstructorParameters<typeof EventSubscriber>[0]> = {}): EventSubscriber {
    subscriber = new EventSubscriber({
      ...endpoint,
      discover: async () => endpoint,
      logger: { warn },
      ...options
    });
    return subscriber;
  }

  it('rejects invalid deadline values before creating a timer', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => create({ connectionTimeoutMs: value })).toThrow(/deadline/);
      expect(() => create({ discoveryTimeoutMs: value })).toThrow(/deadline/);
    }
    expect(ControlledSocket.sockets).toHaveLength(0);
  });

  it('settles a superseded pending connect even when its socket never opens', async () => {
    create();
    const first = subscriber.connect().then(
      () => 'opened',
      (error: Error) => error.message
    );
    const next = subscriber.connect();
    ControlledSocket.sockets[1]!.open();
    await next;
    expect(await first).toMatch(/superseded/i);
    expect(subscriber.isConnected()).toBe(true);
    expect(ControlledSocket.sockets[0]!.closeCalls).toBe(1);
  });

  it('rejects a disconnected pending attempt and clears all attempt timers', async () => {
    create();
    const pending = subscriber.connect().then(
      () => 'opened',
      (error: Error) => error.message
    );
    subscriber.disconnect();
    expect(await pending).toMatch(/disconnect/i);
    expect(vi.getTimerCount()).toBe(0);
    expect(subscriber.isConnected()).toBe(false);
  });

  it('rejects a close before open without relying on a subsequent error event', async () => {
    create({ maxReconnectAttempts: 0 });
    const pending = subscriber.connect().then(
      () => 'opened',
      (error: Error) => error.message
    );
    ControlledSocket.sockets[0]!.close();
    expect(await pending).toMatch(/closed/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a socket that sends no open, error, or close event', async () => {
    create({ connectionTimeoutMs: 200, maxReconnectAttempts: 0 });
    const pending = subscriber.connect().then(
      () => 'opened',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatch(/timed out/i);
    expect(ControlledSocket.sockets[0]!.closeCalls).toBe(1);
    expect(subscriber.isConnected()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a throwing connection observer block readiness or recovery', async () => {
    create();
    const healthyObserver = vi.fn();
    subscriber.onConnectionChange(() => {
      throw new Error('observer failed');
    });
    subscriber.onConnectionChange(healthyObserver);
    const pending = subscriber.connect();
    expect(() => ControlledSocket.sockets[0]!.open()).not.toThrow();
    await pending;
    expect(healthyObserver).toHaveBeenLastCalledWith(true);
    expect(() => ControlledSocket.sockets[0]!.close()).not.toThrow();
    expect(healthyObserver).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ControlledSocket.sockets).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it('retries hung discovery and ignores its late obsolete result', async () => {
    let settleFirst!: (value: DiscoverResult) => void;
    const discover = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DiscoverResult>((resolve) => {
            settleFirst = resolve;
          })
      )
      .mockResolvedValue({ wsUrl: 'ws://localhost:41003/events', accessToken: 'synthetic-c' });
    create({ discover, discoveryTimeoutMs: 200 });
    const initial = subscriber.connect();
    ControlledSocket.sockets[0]!.open();
    await initial;
    ControlledSocket.sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(2000);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(ControlledSocket.sockets).toHaveLength(2);
    ControlledSocket.sockets[1]!.open();
    settleFirst({ wsUrl: 'ws://localhost:41002/events', accessToken: 'synthetic-b' });
    await Promise.resolve();
    await Promise.resolve();
    expect(ControlledSocket.sockets).toHaveLength(2);
    expect(new URL(ControlledSocket.sockets[1]!.url).port).toBe('41003');
    expect(subscriber.isConnected()).toBe(true);
  });

  it('cancels discovery deadlines when disposed and never opens a late socket', async () => {
    let settle!: (value: DiscoverResult) => void;
    create({
      discover: () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    });
    const initial = subscriber.connect();
    ControlledSocket.sockets[0]!.open();
    await initial;
    ControlledSocket.sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    subscriber.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    settle({ wsUrl: 'ws://localhost:41002/events', accessToken: 'synthetic-b' });
    await Promise.resolve();
    await Promise.resolve();
    expect(ControlledSocket.sockets).toHaveLength(1);
  });

  it('retries malformed discovery without an unhandled timer rejection', async () => {
    const discover = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(endpoint);
    create({ discover });
    const initial = subscriber.connect();
    ControlledSocket.sockets[0]!.open();
    await initial;
    ControlledSocket.sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(ControlledSocket.sockets).toHaveLength(2);
    ControlledSocket.sockets[1]!.open();
    expect(subscriber.isConnected()).toBe(true);
  });

  it('does not let a failing logger prevent retry or observer isolation', async () => {
    const discover = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(endpoint);
    create({
      discover,
      logger: {
        warn: () => {
          throw new Error('logger failed');
        }
      }
    });
    subscriber.onConnectionChange(() => {
      throw new Error('observer failed');
    });
    const initial = subscriber.connect();
    ControlledSocket.sockets[0]!.open();
    await initial;
    ControlledSocket.sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(discover).toHaveBeenCalledTimes(2);
    ControlledSocket.sockets[1]!.open();
    expect(subscriber.isConnected()).toBe(true);
  });

  it('preserves forwarded query parameters while replacing the authentication parameter', async () => {
    create({
      wsUrl: 'wss://proxy.invalid/forward/events?route=one&token=obsolete#ignored',
      accessToken: 'new & token'
    });
    const pending = subscriber.connect();
    const url = new URL(ControlledSocket.sockets[0]!.url);
    expect(url.searchParams.get('route')).toBe('one');
    expect(url.searchParams.getAll('token')).toEqual(['new & token']);
    expect(url.hash).toBe('');
    ControlledSocket.sockets[0]!.open();
    await pending;
  });
});

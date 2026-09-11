/**
 * Bounded, cancellable retries (main-487): idempotent requests stop after a
 * finite attempt budget instead of retrying forever against a dead server,
 * and the caller's AbortSignal stops further retries immediately — including
 * mid-backoff. Exhaustion and cancellation surface as distinct typed errors.
 *
 * @summary bounded retry and cancellation tests for cardsclient request
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../src/client/cardsClient.js';
import { RequestCancelledError, RetryExhaustedError } from '../src/client/types/errors.js';
import type { HttpClient } from '../src/protocol/index.js';

function makeHttpClient(get: HttpClient['get']): HttpClient {
  return {
    get,
    post: <T>() => Promise.resolve(undefined as T),
    put: <T>() => Promise.resolve(undefined as T),
    patch: <T>() => Promise.resolve(undefined as T),
    delete: <T>() => Promise.resolve(undefined as T)
  };
}

/**
 * Starts the request with a rejection handler attached up front (so no
 * rejection ever goes unhandled) and advances fake timers in 30s steps until
 * it settles.
 *
 * @param start - Starts the request whose rejection should be captured.
 * @param maxSteps - Maximum number of 30s timer advances before giving up.
 * @returns The caught rejection value, or undefined when the request resolved.
 */
async function driveToRejection(start: () => Promise<unknown>, maxSteps: number): Promise<unknown> {
  let caught: unknown;
  const settled = start().catch((error: unknown) => {
    caught = error;
  });
  for (let i = 0; i < maxSteps && caught === undefined; i++) {
    await vi.advanceTimersByTimeAsync(30_000);
  }
  await settled;
  return caught;
}

describe('CardsClient bounded retries (main-487)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with RetryExhaustedError carrying the attempt count when the budget is spent', async () => {
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w', maxAttempts: 3 },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        return Promise.reject(new TypeError('fetch failed'));
      })
    );

    const caught = await driveToRejection(() => client.listCards(), 10);

    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as RetryExhaustedError).attempts).toBe(3);
    expect((caught as RetryExhaustedError).message).toContain('3 attempts');
    expect(caught).not.toBeInstanceOf(RequestCancelledError);
    expect(attempts).toBe(3);
  });

  it('rejects within the configured budget when the server dies mid-session', async () => {
    // Default-fetch path with every attempt failing like a connection-refused
    // would after the server is killed — the request must reject instead of
    // hanging in the old while(true) retry loop.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    try {
      const client = new CardsClient({
        baseUrl: 'http://localhost:0',
        accessToken: 't',
        workspacePath: '/w',
        maxAttempts: 3
      });

      const startedAt = Date.now();
      const caught = await driveToRejection(() => client.listCards(), 20);
      const elapsedMs = Date.now() - startedAt;

      expect(caught).toBeInstanceOf(RetryExhaustedError);
      // Two backoff sleeps (3s + 6s) must have been waited out, and the client
      // must still be done well under the unbounded-forever behavior.
      expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
      expect(elapsedMs).toBeLessThan(60_000);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('bounds retries by default instead of retrying forever', async () => {
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w' },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        return Promise.reject(new TypeError('fetch failed'));
      })
    );

    const caught = await driveToRejection(() => client.listCards(), 40);

    expect(caught).toBeInstanceOf(RetryExhaustedError);
    expect((caught as RetryExhaustedError).attempts).toBe(10);
    expect(attempts).toBe(10);
  });

  it('stops retrying immediately when the caller cancels during a backoff sleep', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const client = new CardsClient(
      {
        baseUrl: 'http://localhost:0',
        accessToken: 't',
        workspacePath: '/w',
        maxAttempts: 10,
        signal: controller.signal
      },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        return Promise.reject(new TypeError('fetch failed'));
      })
    );

    const promise = client.listCards();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(attempts).toBe(1);
  });

  it('rejects as cancelled without attempting when the signal starts aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w', signal: controller.signal },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        return Promise.reject(new TypeError('fetch failed'));
      })
    );

    await expect(client.listCards()).rejects.toBeInstanceOf(RequestCancelledError);
    expect(attempts).toBe(0);
  });
});

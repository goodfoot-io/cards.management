/**
 * Retry policy: network errors retry with exponential backoff; programming
 * bugs (ReferenceError, RangeError, SyntaxError, non-fetch TypeError) surface
 * immediately because retrying produces the identical failure forever.
 *
 * @summary retry policy tests for cardsclient request
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../src/client/cardsClient.js';
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

describe('CardsClient retry policy (main-54)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries fetch network errors until success', async () => {
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w' },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        if (attempts < 4) return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve([] as unknown as T);
      })
    );

    const promise = client.listCards();
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(30_000);

    await expect(promise).resolves.toEqual([]);
    expect(attempts).toBe(4);
  });

  it('does not retry ReferenceError thrown from the request function', async () => {
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w' },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        throw new ReferenceError('foo is not defined');
      })
    );

    const promise = client.listCards();

    await expect(promise).rejects.toBeInstanceOf(ReferenceError);
    expect(attempts).toBe(1);
  });

  it('does not retry programming-style TypeError', async () => {
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w' },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        throw new TypeError("Cannot read properties of undefined (reading 'x')");
      })
    );

    const promise = client.listCards();

    await expect(promise).rejects.toBeInstanceOf(TypeError);
    expect(attempts).toBe(1);
  });

  it('does not retry SyntaxError', async () => {
    let attempts = 0;
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w' },
      makeHttpClient(async <T>(): Promise<T> => {
        attempts++;
        throw new SyntaxError('Unexpected token');
      })
    );

    const promise = client.listCards();

    await expect(promise).rejects.toBeInstanceOf(SyntaxError);
    expect(attempts).toBe(1);
  });
});

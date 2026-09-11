/**
 * Non-idempotent create requests must not be auto-retried on ambiguous-outcome
 * network failures (e.g. request timeouts). A timed-out `createCard` may have
 * already committed server-side; retrying it mints a duplicate empty card.
 *
 * @summary regression test for main-186 duplicate card creation on retry
 */

import { describe, expect, it } from 'vitest';
import { CardsClient } from '../src/client/cardsClient.js';
import { NetworkError } from '../src/client/types/errors.js';
import type { HttpClient } from '../src/protocol/index.js';

/**
 * Builds an `HttpClient` whose `post` rejects with a fetch-style network error
 * on every attempt, counting how many times it was called.
 *
 * @returns The stub `HttpClient` and a getter for the recorded attempt count.
 */
function makeCountingPostClient(): { client: HttpClient; getAttempts: () => number } {
  let attempts = 0;
  const client: HttpClient = {
    get: <T>() => Promise.resolve(undefined as T),
    post: <T>(): Promise<T> => {
      attempts++;
      // Shape mirrors what `AbortSignal.timeout` / `fetch` surface: a
      // non-Response, non-programming-bug error treated as a transport failure.
      return Promise.reject(new TypeError('fetch failed'));
    },
    put: <T>() => Promise.resolve(undefined as T),
    patch: <T>() => Promise.resolve(undefined as T),
    delete: <T>() => Promise.resolve(undefined as T)
  };
  return { client, getAttempts: () => attempts };
}

describe('CardsClient createCard idempotency (main-186)', () => {
  it('does not retry createCard on an ambiguous network failure; surfaces NetworkError once', async () => {
    const { client: httpClient, getAttempts } = makeCountingPostClient();
    const client = new CardsClient(
      { baseUrl: 'http://localhost:0', accessToken: 't', workspacePath: '/w' },
      httpClient
    );

    await expect(client.createCard({ title: 'Repro' })).rejects.toBeInstanceOf(NetworkError);
    expect(getAttempts()).toBe(1);
  });
});

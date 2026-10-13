/**
 * Creation outcomes survive a lost POST response without replaying the mutation.
 * @summary Creation timeout reconciliation and unknown outcome regressions
 */
import { describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../src/client/cardsClient.js';
import type { HttpClient } from '../src/protocol/index.js';

/** Creates a transport with a lost creation response and configurable durable lookup. */
function transport(get: HttpClient['get']): HttpClient {
  return {
    get,
    post: vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  };
}

describe('card creation reconciliation', () => {
  it('returns the durably created card after the POST response is lost, without creating twice', async () => {
    const card = { id: 'main-1', title: 'Late creation' };
    const get = vi.fn().mockResolvedValue({ card });
    const http = transport(get);
    const client = new CardsClient({ baseUrl: 'http://localhost:0', workspacePath: '/w' }, http);
    await expect(client.createCard({ title: card.title })).resolves.toEqual(card);
    expect(http.post).toHaveBeenCalledTimes(1);
    const body = vi.mocked(http.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['creationRequestId']).toMatch(/^[a-f0-9-]{36}$/);
    expect(get.mock.calls[0]?.[0]).toContain(`/cards/creation-requests/${String(body['creationRequestId'])}`);
    expect(get.mock.calls[0]?.[0]).toContain('workspacePath=%2Fw');
  });

  it('reports an unknown outcome with the original lookup key when cancelled after sending', async () => {
    const controller = new AbortController();
    const http = transport(vi.fn());
    http.post = vi.fn(() => {
      controller.abort();
      return Promise.reject(new TypeError('fetch failed'));
    });
    const client = new CardsClient({ baseUrl: 'http://localhost:0', signal: controller.signal }, http);
    const error: unknown = await client.createCard({ title: 'Unknown' }).catch((failure: unknown) => failure);
    const body = vi.mocked(http.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(error).toMatchObject({ name: 'UnknownCreationOutcomeError', creationRequestId: body['creationRequestId'] });
    expect(String(error)).toContain('Do not retry');
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

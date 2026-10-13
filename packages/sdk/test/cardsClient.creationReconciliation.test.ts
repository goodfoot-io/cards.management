/**
 * Creation outcomes survive a lost POST response without replaying the mutation.
 * @summary Creation timeout reconciliation and unknown outcome regressions
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../src/client/cardsClient.js';
import { ApiError, UnknownCreationOutcomeError } from '../src/client/types/errors.js';
import type { HttpClient } from '../src/protocol/index.js';

/**
 * Creates a transport with a lost creation response and configurable durable lookup.
 * @param get - Durable lookup transport.
 * @returns Transport that loses the creation response.
 */
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
  afterEach(() => vi.unstubAllGlobals());
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
  it('keeps looking after an inconclusive result and returns a later committed card', async () => {
    const card = { id: 'main-2', title: 'Delayed commit' };
    const get = vi.fn().mockResolvedValueOnce({ card: null }).mockResolvedValue({ card });
    const http = transport(get);
    const client = new CardsClient({ baseUrl: 'http://localhost:0' }, http);
    await expect(client.createCard({ title: card.title })).resolves.toEqual(card);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]?.[0]).toEqual(get.mock.calls[1]?.[0]);
  });

  it('bounds an unresponsive lookup and retains the original key for manual reconciliation', async () => {
    const http = transport(vi.fn(() => new Promise<never>(() => {})));
    const client = new CardsClient({ baseUrl: 'http://localhost:0' }, http);
    const pending = client.createCard({ title: 'Unknown' });
    await expect(pending).rejects.toBeInstanceOf(UnknownCreationOutcomeError);
    const error: unknown = await pending.catch((failure: unknown) => failure);
    const body = vi.mocked(http.post).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(error).toMatchObject({ creationRequestId: body['creationRequestId'] });
    const card = { id: 'main-3', title: 'Unknown' };
    http.get = vi.fn().mockResolvedValue({ card });
    await expect(client.getCardCreationOutcome('/w', String(body['creationRequestId']))).resolves.toEqual({ card });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit fail-closed admission refusal as a rejection without polling', async () => {
    const http = transport(vi.fn());
    http.post = vi.fn(() =>
      Promise.reject(
        new Response(JSON.stringify({ error: 'Admission timed out', code: 'CARD_CREATION_ADMISSION_TIMEOUT' }), {
          status: 503
        })
      )
    );
    const client = new CardsClient({ baseUrl: 'http://localhost:0' }, http);
    await expect(client.createCard({ title: 'Refused' })).rejects.toBeInstanceOf(ApiError);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('recovers a committed card when a server failure replaced its response', async () => {
    const card = { id: 'main-4', title: 'Committed' };
    const http = transport(vi.fn().mockResolvedValue({ card }));
    http.post = vi.fn(() => Promise.reject(new Response(JSON.stringify({ code: 'INTERNAL_ERROR' }), { status: 500 })));
    const client = new CardsClient({ baseUrl: 'http://localhost:0' }, http);
    await expect(client.createCard({ title: card.title })).resolves.toEqual(card);
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  it('recovers creation when a successful POST response contains malformed JSON', async () => {
    const card = { id: 'main-5', title: 'Malformed response' };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{', { status: 201 }))
      .mockResolvedValue(Response.json({ card }));
    vi.stubGlobal('fetch', fetch);
    const client = new CardsClient({ baseUrl: 'http://localhost:0' });
    await expect(client.createCard({ title: card.title })).resolves.toEqual(card);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty('method', 'POST');
  });

  it('retains the correlation key when malformed POST JSON cannot be reconciled', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{', { status: 201 }))
      .mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', fetch);
    const client = new CardsClient({ baseUrl: 'http://localhost:0' });
    const pending = client.createCard({ title: 'Unrecoverable response' });
    await expect(pending).rejects.toBeInstanceOf(UnknownCreationOutcomeError);
    const error: unknown = await pending.catch((failure: unknown) => failure);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(error).toMatchObject({ creationRequestId: body['creationRequestId'] });
    expect(fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'POST')).toHaveLength(1);
  });
});

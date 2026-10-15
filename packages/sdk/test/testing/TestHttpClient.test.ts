/**
 * Unit tests for TestHttpClient.
 *
 * Why: confirm the stub records request metadata and returns configured
 * responses consistently without network access.
 *
 *
 * @summary Unit tests for TestHttpClient
 * @module sdk/test/testing/TestHttpClient.test
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TestHttpClient } from '../../src/testing/TestHttpClient.js';

describe('TestHttpClient', () => {
  let client: TestHttpClient;

  beforeEach(() => {
    client = new TestHttpClient();
  });

  describe('get()', () => {
    it('records GET request', async () => {
      await client.get('/api/cards');

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        method: 'GET',
        url: '/api/cards'
      });
    });

    it('returns configured response', async () => {
      const expected = { id: '1', title: 'Test Card' };
      client.responses.set('/api/cards/1', expected);

      const result = await client.get<{ id: string; title: string }>('/api/cards/1');

      expect(result).toEqual(expected);
    });

    it('returns empty object when no response configured', async () => {
      const result = await client.get('/api/unknown');

      expect(result).toEqual({});
    });
  });

  describe('post()', () => {
    it('records POST request with body', async () => {
      const body = { title: 'New Card' };
      await client.post('/api/cards', body);

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        method: 'POST',
        url: '/api/cards',
        body
      });
    });

    it('returns configured response', async () => {
      const expected = { id: '1', title: 'New Card' };
      client.responses.set('/api/cards', expected);

      const result = await client.post<{ id: string; title: string }>('/api/cards', { title: 'New Card' });

      expect(result).toEqual(expected);
    });
  });

  describe('put()', () => {
    it('records PUT request with body', async () => {
      const body = { title: 'Updated Card' };
      await client.put('/api/cards/1', body);

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        method: 'PUT',
        url: '/api/cards/1',
        body
      });
    });

    it('returns configured response', async () => {
      const expected = { id: '1', title: 'Updated Card' };
      client.responses.set('/api/cards/1', expected);

      const result = await client.put<{ id: string; title: string }>('/api/cards/1', { title: 'Updated Card' });

      expect(result).toEqual(expected);
    });
  });

  describe('patch()', () => {
    it('records PATCH request with body', async () => {
      const body = { status: 'closed' };
      await client.patch('/api/cards/1', body);

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        method: 'PATCH',
        url: '/api/cards/1',
        body
      });
    });

    it('returns configured response', async () => {
      const expected = { id: '1', status: 'closed' };
      client.responses.set('/api/cards/1', expected);

      const result = await client.patch<{ id: string; status: string }>('/api/cards/1', { status: 'closed' });

      expect(result).toEqual(expected);
    });
  });

  describe('delete()', () => {
    it('records DELETE request', async () => {
      await client.delete('/api/cards/1');

      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toEqual({
        method: 'DELETE',
        url: '/api/cards/1'
      });
    });

    it('returns void', async () => {
      const result = await client.delete('/api/cards/1');

      expect(result).toBeUndefined();
    });
  });

  describe('request recording', () => {
    it('records multiple requests in order', async () => {
      await client.get('/api/cards');
      await client.post('/api/cards', { title: 'New' });
      await client.delete('/api/cards/1');

      expect(client.requests).toHaveLength(3);
      expect(client.requests[0]?.method).toBe('GET');
      expect(client.requests[1]?.method).toBe('POST');
      expect(client.requests[2]?.method).toBe('DELETE');
    });

    it('preserves request bodies for inspection', async () => {
      const body1 = { title: 'Card 1' };
      const body2 = { title: 'Card 2', description: 'Details' };

      await client.post('/api/cards', body1);
      await client.put('/api/cards/1', body2);

      expect(client.requests[0]?.body).toEqual(body1);
      expect(client.requests[1]?.body).toEqual(body2);
    });
  });

  describe('response mocking', () => {
    it('supports different responses for different URLs', async () => {
      client.responses.set('/api/cards', [{ id: '1' }, { id: '2' }]);
      client.responses.set('/api/cards/1', { id: '1', title: 'First' });

      const list = await client.get<Array<{ id: string }>>('/api/cards');
      const single = await client.get<{ id: string; title: string }>('/api/cards/1');

      expect(list).toEqual([{ id: '1' }, { id: '2' }]);
      expect(single).toEqual({ id: '1', title: 'First' });
    });

    it('reuses same response for repeated requests', async () => {
      const response = { id: '1', title: 'Test' };
      client.responses.set('/api/cards/1', response);

      const result1 = await client.get('/api/cards/1');
      const result2 = await client.get('/api/cards/1');

      expect(result1).toEqual(response);
      expect(result2).toEqual(response);
    });
  });

  describe('clearRequests()', () => {
    it('clears all recorded requests', async () => {
      await client.get('/api/cards');
      await client.post('/api/cards', {});

      expect(client.requests).toHaveLength(2);

      client.clearRequests();

      expect(client.requests).toHaveLength(0);
    });
  });

  describe('clearResponses()', () => {
    it('clears all configured responses', async () => {
      client.responses.set('/api/cards', [{ id: '1' }]);

      const result1 = await client.get('/api/cards');
      expect(result1).toEqual([{ id: '1' }]);

      client.clearResponses();

      const result2 = await client.get('/api/cards');
      expect(result2).toEqual({});
    });
  });

  describe('reset()', () => {
    it('clears both requests and responses', async () => {
      client.responses.set('/api/cards', [{ id: '1' }]);
      await client.get('/api/cards');

      expect(client.requests).toHaveLength(1);
      expect(client.responses.size).toBe(1);

      client.reset();

      expect(client.requests).toHaveLength(0);
      expect(client.responses.size).toBe(0);
    });
  });
});

/** @summary HTTP clients preserve remote forwarding path prefixes and routing queries */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CardsClient } from '../../src/client/cardsClient.js';

describe('CardsClient forwarded base URL', () => {
  it('appends API routes without dropping tunnel path or query credentials', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      expect(req.headers.authorization).toBe('Bearer synthetic-api-token');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'main-1' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new CardsClient({
        baseUrl: `http://127.0.0.1:${port}/forward/port/?ticket=synthetic-tunnel`,
        workspacePath: '/work/tree',
        accessToken: 'synthetic-api-token',
        retryOnNetworkError: false
      });
      await client.getCard('main-1');
      const url = new URL(requests[0]!, 'http://test');
      expect(url.pathname).toBe('/forward/port/cards/main-1');
      expect(url.searchParams.get('ticket')).toBe('synthetic-tunnel');
      expect(url.searchParams.get('workspacePath')).toBe('/work/tree');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Read-only CLI recovery returns committed creations and labels absent outcomes inconclusive.
 * @summary CLI creation outcome recovery
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discoverApiInfo = vi.hoisted(() => vi.fn());
vi.mock('@cards.management/sdk/client/discovery', () => ({ discoverApiInfo }));

import { cardCreationOutcome } from '../../src/bin/cards.js';

const requestId = '70eeb270-4a83-4b2d-8be4-c997252e18a7';

describe('CLI creation outcome', () => {
  let server: Server;
  let card: Record<string, unknown> | null;
  let requests: Array<{ method: string | undefined; url: string | undefined }>;

  beforeEach(async () => {
    card = { id: 'main-1', title: 'Recovered' };
    requests = [];
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ card }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    discoverApiInfo.mockResolvedValue({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      accessToken: 't'
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    discoverApiInfo.mockReset();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('prints the recovered card and only reads the original workspace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cardCreationOutcome([requestId, '--workspace-path', '/original']);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ card });
    expect(requests).toEqual([
      { method: 'GET', url: `/cards/creation-requests/${requestId}?workspacePath=%2Foriginal` }
    ]);
  });

  it('prints null with an inconclusive diagnostic instead of suggesting another creation', async () => {
    card = null;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cardCreationOutcome([requestId, '--workspace-path', '/original']);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ card: null });
    expect(error.mock.calls[0]?.[0]).toContain('inconclusive');
    expect(error.mock.calls[0]?.[0]).toContain('Do not retry');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
  });

  it('rejects an invalid key before sending a request', async () => {
    await expect(cardCreationOutcome(['main-1', '--workspace-path', '/original'])).rejects.toThrow('UUID');
    expect(requests).toEqual([]);
  });
});

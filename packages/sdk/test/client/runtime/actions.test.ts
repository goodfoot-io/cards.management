/**
 * Contract checks for durable runtime action launch, retrieval, identity, and uncertainty.
 * @summary Durable runtime action HTTP client contract tests
 * @module
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeActionClient,
  type RuntimeActionClient,
  type RuntimeActionLaunchRequest
} from '../../../src/client/runtime/index.js';

const REQUEST: RuntimeActionLaunchRequest = {
  requestId: 'request-1',
  messageId: 'message-1',
  params: {
    actionId: 'implement',
    environmentName: 'default',
    mode: 'background',
    exitWhenDone: true
  }
};

const EXECUTION = { executionId: 'execution-1', launchRequestId: 'request-1' };

describe('runtime action HTTP client', () => {
  let server: Server | undefined;
  let client: RuntimeActionClient | undefined;
  let requests: Array<{
    readonly method: string | undefined;
    readonly url: string | undefined;
    readonly body: unknown;
  }>;

  afterEach(async () => {
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  async function listen(
    respond: (request: IncomingMessage, response: ServerResponse, body: unknown) => void
  ): Promise<void> {
    requests = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body: unknown = text.length === 0 ? undefined : JSON.parse(text);
        requests.push({ method: request.method, url: request.url, body });
        respond(request, response, body);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    client = createRuntimeActionClient({
      discover: async () => ({ host: '127.0.0.1', port, accessToken: 'access-token' })
    });
  }

  it('posts caller-owned IDs and immutable params with bearer authentication and no principal body', async () => {
    await listen((request, response) => {
      expect(request.headers.authorization).toBe('Bearer access-token');
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ disposition: 'admitted', execution: EXECUTION }));
    });

    await client?.launch('main-672', REQUEST);

    expect(requests).toEqual([{ method: 'POST', url: '/cards/main-672/runtime/actions', body: REQUEST }]);
  });

  it('rejects a public launch response that leaks protected runtime credentials', async () => {
    await listen((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ disposition: 'admitted', execution: EXECUTION, credentials: [{ secret: 'must-not-leak' }] })
      );
    });

    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'invalid-response'
    });
  });

  it('maps admitted and pending replay responses to accepted while preserving both IDs', async () => {
    await listen((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          disposition: 'replayed',
          execution: EXECUTION,
          spawnPhase: 'attempted',
          retrievedOutcome: null
        })
      );
    });

    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'accepted',
      requestId: 'request-1',
      messageId: 'message-1'
    });
  });

  it.each([
    ['spawned', 'accepted'],
    ['failed', 'completed'],
    ['uncertain', 'uncertain']
  ] as const)('maps a %s replay to %s without inventing terminal completion', async (disposition, status) => {
    await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          disposition: 'replayed',
          execution: EXECUTION,
          spawnPhase: 'confirmed',
          retrievedOutcome: { disposition, processBootId: 'boot-1' }
        })
      );
    });

    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status,
      requestId: 'request-1'
    });
  });

  it('maps changed parameters under the same request ID to rejection', async () => {
    await listen((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ disposition: 'rejected', reason: 'parameter-mismatch', execution: EXECUTION }));
    });

    await expect(
      client?.launch('main-672', { ...REQUEST, params: { ...REQUEST.params, actionId: 'review' } })
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'parameter-mismatch',
      requestId: 'request-1',
      messageId: 'message-1'
    });
  });

  it('retrieves a completed result by URL-encoded caller request ID', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'completed',
          execution: EXECUTION,
          retrievedOutcome: { disposition: 'spawned', processBootId: 'boot-1' },
          terminalOutcome: { exitCode: 0, signal: null, lifecycleState: 'completed', statusMutationDeferred: false }
        })
      );
    });

    await expect(client?.retrieve('main/card', 'request/one')).resolves.toMatchObject({ status: 'completed' });
    expect(requests[0]?.url).toBe('/cards/main%2Fcard/runtime/actions/request%2Fone');
  });

  it('refuses to infer terminal completion from a spawned launch without cleanup proof', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'completed',
          execution: EXECUTION,
          retrievedOutcome: { disposition: 'spawned', processBootId: 'boot-1' }
        })
      );
    });

    await expect(client?.retrieve('main-672', 'request-1')).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'invalid-response'
    });
  });

  it('distinguishes authentication rejection, server unavailability, and invalid responses', async () => {
    const statuses = [401, 503, 500, 202];
    await listen((_request, response) => {
      const status = statuses.shift() ?? 500;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 202 ? { disposition: 'admitted' } : { error: 'no' }));
    });

    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'authentication-failed'
    });
    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'server-unavailable'
    });
    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'invalid-response'
    });
    await expect(client?.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'invalid-response'
    });
  });

  it('reports timeout and network failures as uncertainty without changing caller-owned IDs', async () => {
    await listen((_request, _response) => undefined);
    const port = (server?.address() as AddressInfo).port;
    client = createRuntimeActionClient({
      discover: async () => ({ host: '127.0.0.1', port, accessToken: 'access-token' }),
      timeoutMs: 10
    });

    await expect(client.launch('main-672', REQUEST)).resolves.toMatchObject({
      status: 'uncertain',
      requestId: 'request-1',
      messageId: 'message-1',
      reason: 'deadline-expired'
    });

    const networkClient = createRuntimeActionClient({
      discover: async () => ({ host: '127.0.0.1', port: 1, accessToken: 'access-token' })
    });
    await expect(networkClient.launch('main-672', REQUEST)).resolves.toMatchObject({ reason: 'network-error' });
  });

  it('retries after client reconstruction with exactly the same persisted request and message IDs', async () => {
    await listen((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ disposition: 'admitted', execution: EXECUTION }));
    });
    const first = client;
    await first?.launch('main-672', REQUEST);
    const port = (server?.address() as AddressInfo).port;
    const reconstructed = createRuntimeActionClient({
      discover: async () => ({ host: '127.0.0.1', port, accessToken: 'access-token' })
    });

    await reconstructed.launch('main-672', REQUEST);

    expect(requests.map(({ body }) => body)).toEqual([REQUEST, REQUEST]);
  });

  it('scopes the same retry and retrieval IDs to separately encoded card routes', async () => {
    await listen((request, response) => {
      response.writeHead(request.method === 'POST' ? 202 : 404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          request.method === 'POST' ? { disposition: 'admitted', execution: EXECUTION } : { status: 'not-found' }
        )
      );
    });

    await client?.launch('main/672', REQUEST);
    await client?.launch('other card', REQUEST);
    await client?.retrieve('main/672', REQUEST.requestId);
    await client?.retrieve('other card', REQUEST.requestId);

    expect(requests.map(({ url }) => url)).toEqual([
      '/cards/main%2F672/runtime/actions',
      '/cards/other%20card/runtime/actions',
      '/cards/main%2F672/runtime/actions/request-1',
      '/cards/other%20card/runtime/actions/request-1'
    ]);
    expect(requests.slice(0, 2).map(({ body }) => body)).toEqual([REQUEST, REQUEST]);
  });
});

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

  it.skip('posts caller-owned IDs and immutable params with bearer authentication and no principal body', async () => {
    await listen((request, response) => {
      expect(request.headers.authorization).toBe('Bearer access-token');
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ disposition: 'admitted', execution: EXECUTION, credentials: [] }));
    });

    await client?.launch(REQUEST);

    expect(requests).toEqual([{ method: 'POST', url: '/runtime/actions', body: REQUEST }]);
  });

  it.skip('maps admitted and pending replay responses to accepted while preserving both IDs', async () => {
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

    await expect(client?.launch(REQUEST)).resolves.toMatchObject({
      status: 'accepted',
      requestId: 'request-1',
      messageId: 'message-1'
    });
  });

  it.skip('maps a completed replay to completed with its durable launch outcome', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          disposition: 'replayed',
          execution: EXECUTION,
          spawnPhase: 'confirmed',
          retrievedOutcome: { disposition: 'spawned', processBootId: 'boot-1' }
        })
      );
    });

    await expect(client?.launch(REQUEST)).resolves.toMatchObject({ status: 'completed', requestId: 'request-1' });
  });

  it.skip('maps changed parameters under the same request ID to rejection', async () => {
    await listen((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ disposition: 'rejected', reason: 'parameter-mismatch', execution: EXECUTION }));
    });

    await expect(
      client?.launch({ ...REQUEST, params: { ...REQUEST.params, actionId: 'review' } })
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: 'parameter-mismatch',
      requestId: 'request-1',
      messageId: 'message-1'
    });
  });

  it.skip('retrieves a completed result by URL-encoded caller request ID', async () => {
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

    await expect(client?.retrieve('request/one')).resolves.toMatchObject({ status: 'completed' });
    expect(requests[0]?.url).toBe('/runtime/actions/request%2Fone');
  });

  it.skip('distinguishes authentication rejection, server unavailability, and invalid responses', async () => {
    const statuses = [401, 503, 500];
    await listen((_request, response) => {
      const status = statuses.shift() ?? 500;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'no' }));
    });

    await expect(client?.launch(REQUEST)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'authentication-failed'
    });
    await expect(client?.launch(REQUEST)).resolves.toMatchObject({ status: 'uncertain', reason: 'server-unavailable' });
    await expect(client?.launch(REQUEST)).resolves.toMatchObject({ status: 'uncertain', reason: 'invalid-response' });
  });

  it.skip('reports timeout and network failures as uncertainty without changing caller-owned IDs', async () => {
    client = createRuntimeActionClient({
      discover: async () => ({ host: '127.0.0.1', port: 1, accessToken: 'access-token' }),
      timeoutMs: 10
    });

    await expect(client.launch(REQUEST)).resolves.toMatchObject({
      status: 'uncertain',
      requestId: 'request-1',
      messageId: 'message-1'
    });
  });

  it.skip('retries after client reconstruction with exactly the same persisted request and message IDs', async () => {
    await listen((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ disposition: 'admitted', execution: EXECUTION, credentials: [] }));
    });
    const first = client;
    await first?.launch(REQUEST);
    const port = (server?.address() as AddressInfo).port;
    const reconstructed = createRuntimeActionClient({
      discover: async () => ({ host: '127.0.0.1', port, accessToken: 'access-token' })
    });

    await reconstructed.launch(REQUEST);

    expect(requests.map(({ body }) => body)).toEqual([REQUEST, REQUEST]);
  });
});

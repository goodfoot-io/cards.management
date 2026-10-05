/**
 * `CardsClient.runRootCommand` and `getExecutionStatus` against a real local
 * HTTP server: the launch body, polling to a completed report, each failure
 * cause, and the cancel call on deadline and on abort.
 * @summary Root command launch, polling, failure causes and cancellation
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CardsClient } from '../../src/client/cardsClient.js';
import { RootCommandError } from '../../src/client/types/errors.js';

const EXECUTION = { executionId: 'execution-1', launchRequestId: 'request-1' };
const TERMINAL = {
  terminalDecisionId: 'terminal:execution-1',
  observationId: 'obs-1',
  trigger: 'root-exit',
  status: 'drained',
  phase: 'graceful',
  rootExit: { code: 0, signal: null },
  finalization: 'complete'
};
const SPAWNED = { disposition: 'spawned', processBootId: 'boot-1' };

interface Recorded {
  readonly method: string | undefined;
  readonly path: string;
  readonly body: unknown;
}

let server: Server | undefined;
let requests: Recorded[];

afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    server = undefined;
  }
});

/**
 * Starts a server answering every request through `respond`, and a client for it.
 * @param respond - Returns the status and JSON body for one request.
 * @returns A client with retries off.
 */
async function serve(respond: (request: Recorded) => readonly [number, unknown]): Promise<CardsClient> {
  requests = [];
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded = {
        method: request.method,
        path: new URL(request.url ?? '/', 'http://test').pathname,
        body: text.length === 0 ? undefined : JSON.parse(text)
      };
      requests.push(recorded);
      const [status, body] = respond(recorded);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolveListen) => server?.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  return new CardsClient({
    baseUrl: `http://127.0.0.1:${port}`,
    accessToken: 'token',
    retryOnNetworkError: false
  });
}

function isLaunch(request: Recorded): boolean {
  return request.method === 'POST' && request.path === '/cards/main-1/runtime/commands';
}

function isCancel(request: Recorded): boolean {
  return request.method === 'POST' && /^\/cards\/main-1\/runtime\/commands\/[^/]+\/cancel$/.test(request.path);
}

function launchedRequestId(): string {
  const launch = requests.find(isLaunch);
  return (launch?.body as { requestId: string }).requestId;
}

async function rootCommandFailure(promise: Promise<unknown>): Promise<RootCommandError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a RootCommandError');
    },
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(RootCommandError);
  return error as RootCommandError;
}

describe('runRootCommand', () => {
  it('launches with caller-owned IDs, polls past pending, and resolves with the report', async () => {
    let polls = 0;
    const client = await serve((request) => {
      if (isLaunch(request)) {
        const { requestId } = request.body as { requestId: string };
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: requestId } }];
      }
      polls++;
      const execution = { ...EXECUTION, launchRequestId: launchedRequestId() };
      if (polls < 3) return [200, { status: 'pending', execution, retrievedOutcome: null }];
      return [
        200,
        {
          status: 'completed',
          execution,
          retrievedOutcome: SPAWNED,
          terminalOutcome: TERMINAL,
          commandReport: { decisions: [{ branch: 'cards/main-1/2' }] }
        }
      ];
    });

    const completion = await client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'preview' });

    const launch = requests[0];
    expect(launch?.method).toBe('POST');
    expect(launch?.path).toBe('/cards/main-1/runtime/commands');
    expect(launch?.body).toEqual({
      requestId: expect.any(String),
      messageId: expect.any(String),
      command: 'worktreeMaintenance',
      input: { mode: 'preview' }
    });
    const requestId = launchedRequestId();
    expect(requests.slice(1).every((request) => request.path === `/cards/main-1/runtime/actions/${requestId}`)).toBe(
      true
    );
    expect(polls).toBe(3);
    expect(completion).toEqual({
      requestId,
      executionId: 'execution-1',
      report: { decisions: [{ branch: 'cards/main-1/2' }] }
    });
  });

  it('fails with no_report when the command completed without one', async () => {
    const client = await serve((request) => {
      if (isLaunch(request))
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      return [
        200,
        {
          status: 'completed',
          execution: { ...EXECUTION, launchRequestId: launchedRequestId() },
          retrievedOutcome: SPAWNED,
          terminalOutcome: TERMINAL
        }
      ];
    });
    const error = await rootCommandFailure(client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }));
    expect(error.cause).toBe('no_report');
  });

  it('fails with rejected when admission refuses the launch', async () => {
    const client = await serve(() => [409, { disposition: 'rejected', reason: 'scope-mismatch', execution: null }]);
    const error = await rootCommandFailure(client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }));
    expect(error.cause).toBe('rejected');
  });

  it('fails with rejected when the server has no runtime admission', async () => {
    const client = await serve(() => [503, { error: 'runtime admission unavailable' }]);
    const error = await rootCommandFailure(client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }));
    expect(error.cause).toBe('rejected');
    expect(requests).toHaveLength(1);
  });

  it('replays the same launch IDs after a server error, then follows the admission', async () => {
    let launches = 0;
    const client = await serve((request) => {
      if (isLaunch(request)) {
        launches++;
        if (launches === 1) return [500, { error: 'transient' }];
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      }
      return [
        200,
        {
          status: 'completed',
          execution: { ...EXECUTION, launchRequestId: launchedRequestId() },
          retrievedOutcome: SPAWNED,
          terminalOutcome: TERMINAL,
          commandReport: {}
        }
      ];
    });
    await client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'preview' });
    const launchBodies = requests.filter(isLaunch).map((request) => request.body);
    expect(launchBodies).toHaveLength(2);
    expect(launchBodies[1]).toEqual(launchBodies[0]);
  });

  it('fails with uncertain when the durable record is uncertain', async () => {
    const client = await serve((request) => {
      if (isLaunch(request))
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      return [200, { status: 'uncertain', reason: 'spawn-attempt-unconfirmed', execution: null }];
    });
    const error = await rootCommandFailure(client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }));
    expect(error.cause).toBe('uncertain');
  });

  it('fails with unconfigured when the settings lack the command', async () => {
    const client = await serve(() => [
      409,
      { error: 'worktreeMaintenance is not configured', code: 'command_unconfigured' }
    ]);
    const error = await rootCommandFailure(client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }));
    expect(error.cause).toBe('unconfigured');
  });

  it('cancels the command and fails with timeout when the deadline passes [R9]', async () => {
    const client = await serve((request) => {
      if (isLaunch(request))
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      if (isCancel(request)) return [202, { accepted: true }];
      return [
        200,
        { status: 'pending', execution: { ...EXECUTION, launchRequestId: launchedRequestId() }, retrievedOutcome: null }
      ];
    });
    const started = Date.now();
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }, { timeoutMs: 600 })
    );
    expect(error.cause).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
    const cancel = requests.find(isCancel);
    expect(cancel?.path).toBe(`/cards/main-1/runtime/commands/${launchedRequestId()}/cancel`);
  });

  it('cancels the command and fails with cancelled when the signal aborts [R9]', async () => {
    const controller = new AbortController();
    const client = await serve((request) => {
      if (isLaunch(request))
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      if (isCancel(request)) return [202, { accepted: true }];
      return [
        200,
        { status: 'pending', execution: { ...EXECUTION, launchRequestId: launchedRequestId() }, retrievedOutcome: null }
      ];
    });
    setTimeout(() => controller.abort(), 400);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }, { signal: controller.signal })
    );
    expect(error.cause).toBe('cancelled');
    expect(requests.some(isCancel)).toBe(true);
  });

  it('does not launch when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = await serve(() => [500, {}]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup' }, { signal: controller.signal })
    );
    expect(error.cause).toBe('cancelled');
    expect(requests).toEqual([]);
  });
});

describe('getExecutionStatus', () => {
  it.each(['running', 'terminal', 'unknown'] as const)('reads %s from the status route', async (status) => {
    const client = await serve(() => [200, { status }]);
    await expect(client.getExecutionStatus('execution/1')).resolves.toBe(status);
    expect(requests[0]?.path).toBe('/runtime/executions/execution%2F1/status');
  });

  it('rejects a response outside the three states', async () => {
    const client = await serve(() => [200, { status: 'maybe' }]);
    await expect(client.getExecutionStatus('execution-1')).rejects.toThrow();
  });
});

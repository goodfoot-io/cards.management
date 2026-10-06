/**
 * `CardsClient.runRootCommand` and `getExecutionStatus` against a real local
 * HTTP server: the launch body, polling to a completed report, each failure
 * cause, and the cancel call on deadline and on abort.
 * @summary Root command launch, polling, failure causes and cancellation
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../../src/client/cardsClient.js';
import {
  ApiError,
  CardDeleteRefusedError,
  RootCommandError,
  type RootCommandFailureCause
} from '../../src/client/types/errors.js';

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
  readonly query: string;
  readonly body: unknown;
}

let server: Server | undefined;
let requests: Recorded[];

afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    server = undefined;
  }
});

/**
 * Starts a server answering every request through `respond`, and a client for it.
 * @param respond - Returns the status and JSON body for one request; status 0 leaves it unanswered.
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
        query: new URL(request.url ?? '/', 'http://test').search,
        body: text.length === 0 ? undefined : JSON.parse(text)
      };
      requests.push(recorded);
      const [status, body] = respond(recorded);
      if (status === 0) return;
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

    const completion = await client.runRootCommand('main-1', 'worktreeMaintenance', {
      mode: 'preview',
      budgetMs: 60_000
    });

    const launch = requests[0];
    expect(launch?.method).toBe('POST');
    expect(launch?.path).toBe('/cards/main-1/runtime/commands');
    expect(launch?.body).toEqual({
      requestId: expect.any(String),
      messageId: expect.any(String),
      command: 'worktreeMaintenance',
      input: { mode: 'preview', budgetMs: 60_000 }
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
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('no_report');
  });

  it('fails with rejected when admission refuses the launch', async () => {
    const client = await serve(() => [409, { disposition: 'rejected', reason: 'scope-mismatch', execution: null }]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('rejected');
  });

  it('fails with rejected when the server has no runtime admission', async () => {
    const client = await serve(() => [503, { error: 'runtime admission unavailable' }]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
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
    await client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'preview', budgetMs: 60_000 });
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
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('uncertain');
  });

  it('fails with unconfigured when the settings lack the command', async () => {
    const client = await serve(() => [
      409,
      { error: 'worktreeMaintenance is not configured', code: 'command_unconfigured' }
    ]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('unconfigured');
  });

  it.each([
    ['the rejected record', { disposition: 'rejected', reason: 'card_deleting', execution: null }],
    ['an error code', { error: 'card is being deleted', code: 'card_deleting' }]
  ])('fails with rejected when the card is being deleted, carried in %s', async (_form, body) => {
    const client = await serve(() => [409, body]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('rejected');
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
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 }, { timeoutMs: 600 })
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
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { signal: controller.signal }
      )
    );
    expect(error.cause).toBe('cancelled');
    expect(requests.some(isCancel)).toBe(true);
  });

  it('does not launch when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = await serve(() => [500, {}]);
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { signal: controller.signal }
      )
    );
    expect(error.cause).toBe('cancelled');
    expect(requests).toEqual([]);
  });
});

describe('runRootCommand against an unavailable server', () => {
  const ADMITTED = (): readonly [number, unknown] => [
    202,
    { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }
  ];

  /**
   * A port nothing listens on: bound once to reserve a number, then closed.
   * @returns A port number that refuses connections.
   */
  async function closedPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    return port;
  }

  it('backs off against a closed port and ends as unavailable naming the server, not timeout', async () => {
    const port = await closedPort();
    const fetches = vi.spyOn(globalThis, 'fetch');
    const client = new CardsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'token',
      retryOnNetworkError: false
    });
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 3_000 }
      )
    );
    expect(error.cause).toBe('unavailable');
    expect(error.message).toContain(`http://127.0.0.1:${port}`);
    expect(error.message).toContain('no response');
    // Pauses of 0.5, 1 and 2 s fit four launches in 3 s; a flat 250 ms poll would make twelve.
    const launches = fetches.mock.calls.filter(([url]) => String(url).endsWith('/runtime/commands'));
    expect(launches.length).toBeGreaterThanOrEqual(3);
    expect(launches.length).toBeLessThanOrEqual(5);
  });

  it('backs off on a launch that keeps failing with 5xx and ends as unavailable', async () => {
    const client = await serve(() => [500, { error: 'boom' }]);
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 3_000 }
      )
    );
    expect(error.cause).toBe('unavailable');
    expect(error.message).toContain('the launch failed with 500');
    expect(requests.filter(isLaunch).length).toBeLessThanOrEqual(5);
    expect(requests.filter(isLaunch).length).toBeGreaterThanOrEqual(3);
  });

  it('backs off on a retrieval that keeps failing with 5xx after admission and ends as unavailable', async () => {
    const client = await serve((request) => {
      if (isLaunch(request)) return ADMITTED();
      if (isCancel(request)) return [502, { error: 'bad gateway' }];
      return [502, { error: 'bad gateway' }];
    });
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 3_000 }
      )
    );
    expect(error.cause).toBe('unavailable');
    expect(error.message).toContain('the retrieval failed with 502');
    const retrievals = requests.filter((request) => request.method === 'GET');
    expect(retrievals.length).toBeLessThanOrEqual(5);
    expect(requests.filter(isLaunch)).toHaveLength(1);
    expect(requests.some(isCancel)).toBe(true);
  });

  it('keeps the server error as the cause when the deadline cuts off the last retrieval', async () => {
    let retrievals = 0;
    const client = await serve((request) => {
      if (isLaunch(request)) return ADMITTED();
      if (isCancel(request)) return [202, { status: 'cancel-requested' }];
      retrievals++;
      // The first retrieval fails; the next hangs until the deadline aborts it.
      return retrievals === 1 ? [502, { error: 'bad gateway' }] : [0, null];
    });
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 1_500 }
      )
    );
    expect(retrievals).toBe(2);
    expect(error.cause).toBe('unavailable');
    expect(error.message).toContain('the retrieval failed with 502');
  });

  it('ends as unavailable once the outage outlasts its 30 s allowance, well before a longer deadline', async () => {
    const client = await serve(() => [504, { error: 'gateway timeout' }]);
    const started = Date.now();
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 120_000 }
      )
    );
    expect(error.cause).toBe('unavailable');
    expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
    expect(Date.now() - started).toBeLessThan(40_000);
    // 0.5 + 1 + 2 + 4 s, then 4 s apart: about ten launches in 30 s, not 120.
    expect(requests.filter(isLaunch).length).toBeLessThanOrEqual(12);
  }, 60_000);

  it('recovers when the server answers again, so a brief outage costs only the backoff', async () => {
    let launches = 0;
    const client = await serve((request) => {
      if (isLaunch(request)) {
        launches++;
        return launches < 3 ? [500, { error: 'restarting' }] : ADMITTED();
      }
      return [
        200,
        {
          status: 'completed',
          execution: { ...EXECUTION, launchRequestId: launchedRequestId() },
          retrievedOutcome: SPAWNED,
          terminalOutcome: TERMINAL,
          commandReport: { ok: true }
        }
      ];
    });
    const result = await client.runRootCommand(
      'main-1',
      'worktreeMaintenance',
      { mode: 'preview', budgetMs: 60_000 },
      { timeoutMs: 10_000 }
    );
    expect(result.report).toEqual({ ok: true });
    expect(launches).toBe(3);
  });
});

describe('runRootCommand precise causes', () => {
  it.each([
    ['card_not_found', 'Card main-1 not found', 'main-1'],
    ['workspace_not_found', 'No workspace for this repository', 'No workspace for this repository']
  ] as const)('ends as %s when the launch answers its typed 404', async (code, message, detail) => {
    const client = await serve(() => [404, { code, error: message }]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe(code);
    expect(error.message).toContain(detail);
    expect(requests.filter(isLaunch)).toHaveLength(1);
    expect(requests.filter(isCancel)).toHaveLength(0);
  });

  it('ends as invalid_response on an untyped launch 404, cancelling what it cannot rule out', async () => {
    const client = await serve(() => [404, { error: 'Not Found' }]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('invalid_response');
    expect(requests.filter(isCancel)).toHaveLength(1);
  });

  it('ends as rejected naming the server reason on a 409 it does not recognize', async () => {
    const client = await serve(() => [409, { code: 'scope_conflict', error: 'another launch holds this scope' }]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('rejected');
    expect(error.message).toContain('another launch holds this scope');
    expect(requests.filter(isLaunch)).toHaveLength(1);
  });

  it('ends as invalid_response on a launch body outside the contract', async () => {
    const client = await serve(() => [200, { disposition: 'teleported' }]);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect(error.cause).toBe('invalid_response');
    expect(requests.filter(isLaunch)).toHaveLength(1);
    expect(requests.filter(isCancel)).toHaveLength(1);
  });

  it.each([
    'card_not_found',
    'workspace_not_found'
  ] as const)('ends as %s at once when retrieval answers its typed 404, instead of polling to the deadline', async (code) => {
    const client = await serve((request) => {
      if (isLaunch(request))
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      return [404, { code, error: 'gone' }];
    });
    const started = Date.now();
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 60_000 }
      )
    );
    expect(error.cause).toBe(code);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1);
  });

  it('ends as invalid_response at once when retrieval answers outside the contract, instead of polling to the deadline', async () => {
    const client = await serve((request) => {
      if (isLaunch(request))
        return [202, { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }];
      return [200, { status: 'completed', report: 'not the shape' }];
    });
    const started = Date.now();
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 60_000 }
      )
    );
    expect(error.cause).toBe('invalid_response');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1);
    expect(requests.filter(isCancel)).toHaveLength(1);
  });
});

describe('runRootCommand failure scope', () => {
  type Answer = readonly [number, unknown];
  const admitted = (): Answer => [
    202,
    { disposition: 'admitted', execution: { ...EXECUTION, launchRequestId: launchedRequestId() } }
  ];
  const launchAnswers =
    (answer: Answer): Respond =>
    (): Answer =>
      answer;
  type Respond = (request: Recorded) => Answer;
  type Row = readonly [string, RootCommandFailureCause, Respond];
  const retrievalAnswers =
    (answer: Answer): Respond =>
    (request) =>
      isLaunch(request) ? admitted() : isCancel(request) ? [202, { status: 'cancel-requested' }] : answer;

  it.each<Row>([
    ['unconfigured', 'unconfigured', launchAnswers([409, { code: 'command_unconfigured', error: 'none' }])],
    ['a 400 launch refusal', 'rejected', launchAnswers([400, { error: 'bad params' }])],
    ['a 401 launch refusal', 'rejected', launchAnswers([401, { error: 'unauthorized' }])],
    ['a 403 launch refusal', 'rejected', launchAnswers([403, { error: 'forbidden' }])],
    ['a 503 launch refusal', 'rejected', launchAnswers([503, { error: 'no admission' }])],
    ['a 401 retrieval refusal', 'rejected', retrievalAnswers([401, { error: 'unauthorized' }])],
    [
      'workspace_not_found',
      'workspace_not_found',
      launchAnswers([404, { code: 'workspace_not_found', error: 'none' }])
    ],
    ...(['storage-unavailable', 'journal-unreadable', 'journal-corrupt'] as const).flatMap((reason): Row[] => [
      [
        `launch uncertainty ${reason}`,
        'uncertain',
        launchAnswers([503, { disposition: 'unavailable', reason, execution: null }])
      ],
      [
        `admission uncertainty ${reason}`,
        'uncertain',
        retrievalAnswers([503, { status: 'uncertain', reason, execution: null }])
      ]
    ])
  ])('marks %s as workspace scope', async (_case, cause, respond) => {
    const client = await serve(respond);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect([error.cause, error.scope]).toEqual([cause, 'workspace']);
  });

  it('marks an outage as workspace scope', async () => {
    const client = await serve(() => [502, { error: 'bad gateway' }]);
    const error = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { timeoutMs: 1_500 }
      )
    );
    expect([error.cause, error.scope]).toEqual(['unavailable', 'workspace']);
  });

  it.each<Row>([
    ['card_deleting by code', 'rejected', launchAnswers([409, { code: 'card_deleting', error: 'deleting' }])],
    [
      'card_deleting by record',
      'rejected',
      launchAnswers([409, { disposition: 'rejected', reason: 'card_deleting', execution: null }])
    ],
    ...(['parameter-mismatch', 'scope-mismatch', 'retired', 'revoked', 'retention-exhausted'] as const).map(
      (reason): Row => [
        `launch rejection ${reason}`,
        'rejected',
        launchAnswers([409, { disposition: 'rejected', reason, execution: null }])
      ]
    ),
    [
      'admission rejection',
      'rejected',
      retrievalAnswers([200, { status: 'rejected', reason: 'revoked', execution: null }])
    ],
    [
      'spawn-attempt-unconfirmed',
      'uncertain',
      retrievalAnswers([200, { status: 'uncertain', reason: 'spawn-attempt-unconfirmed', execution: null }])
    ],
    ['a launch with no durable record', 'uncertain', retrievalAnswers([404, { status: 'not-found' }])],
    ['card_not_found', 'card_not_found', launchAnswers([404, { code: 'card_not_found', error: 'none' }])],
    ['an unrecognized 409', 'rejected', launchAnswers([409, { code: 'scope_conflict', error: 'held' }])],
    ['an invalid response', 'invalid_response', launchAnswers([200, { disposition: 'teleported' }])],
    [
      'a completion without a report',
      'no_report',
      (request: Recorded): Answer =>
        retrievalAnswers([
          200,
          {
            status: 'completed',
            execution: { ...EXECUTION, launchRequestId: launchedRequestId() },
            retrievedOutcome: SPAWNED,
            terminalOutcome: TERMINAL
          }
        ])(request)
    ]
  ])('marks %s as card scope', async (_case, cause, respond) => {
    const client = await serve(respond);
    const error = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 })
    );
    expect([error.cause, error.scope]).toEqual([cause, 'card']);
  });

  it('marks a timeout and a cancellation as card scope', async () => {
    const pending = (request: Recorded): Answer =>
      isLaunch(request)
        ? admitted()
        : isCancel(request)
          ? [202, { status: 'cancel-requested' }]
          : [
              200,
              {
                status: 'pending',
                execution: { ...EXECUTION, launchRequestId: launchedRequestId() },
                retrievedOutcome: null
              }
            ];
    const client = await serve(pending);
    const timedOut = await rootCommandFailure(
      client.runRootCommand('main-1', 'worktreeMaintenance', { mode: 'cleanup', budgetMs: 60_000 }, { timeoutMs: 300 })
    );
    expect([timedOut.cause, timedOut.scope]).toEqual(['timeout', 'card']);
    const cancelled = await rootCommandFailure(
      client.runRootCommand(
        'main-1',
        'worktreeMaintenance',
        { mode: 'cleanup', budgetMs: 60_000 },
        { signal: AbortSignal.abort() }
      )
    );
    expect([cancelled.cause, cancelled.scope]).toEqual(['cancelled', 'card']);
  });
});

describe('deleteCard', () => {
  it('sends preparedBy encoded, and it decodes intact', async () => {
    const client = await serve(() => [204, null]);
    await client.deleteCard('main-1', { preparedBy: 'req/1 &x' });
    expect(
      requests.map((request) => [request.method, request.path, new URLSearchParams(request.query).get('preparedBy')])
    ).toEqual([['DELETE', '/cards/main-1', 'req/1 &x']]);
  });

  it.each([
    [409, 'running_execution', 'The card has running executions (exec-1, exec-2); stop them first'],
    [409, 'card_changed', 'exec-2 changed the card after the prepare-delete run']
  ] as const)('throws CardDeleteRefusedError carrying the executions on %i %s', async (status, code, message) => {
    const client = await serve(() => [status, { code, error: message, executions: ['exec-1', 'exec-2'] }]);
    const error = await client.deleteCard('main-1', { preparedBy: 'req-1' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CardDeleteRefusedError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code, executions: ['exec-1', 'exec-2'], message });
  });

  it.each([
    ['invalid_prepared_by', 'req-9 is not a prepare-delete run'],
    ['prepared_by_required', 'Cite a passing prepare-delete run as preparedBy']
  ] as const)('throws CardDeleteRefusedError with no executions on 400 %s', async (code, message) => {
    const client = await serve(() => [400, { code, error: message }]);
    const error = await client.deleteCard('main-1', { preparedBy: 'req-9' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CardDeleteRefusedError);
    expect(error).toMatchObject({ code, executions: [], message });
  });

  it.each([
    [
      'a running_execution list that is not all strings',
      409,
      { code: 'running_execution', error: 'busy', executions: [7] }
    ],
    ['a card_changed body without executions', 409, { code: 'card_changed', error: 'changed' }],
    ['an invalid_prepared_by body with executions', 400, { code: 'invalid_prepared_by', error: 'bad', executions: [] }],
    ['a prepared_by_required body with executions', 400, { code: 'prepared_by_required', error: 'bad', executions: [] }]
  ] as const)('throws a plain ApiError for %s', async (_case, status, body) => {
    const client = await serve(() => [status, body]);
    const error = await client.deleteCard('main-1', { preparedBy: 'req-1' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(CardDeleteRefusedError);
  });

  it('does not report a 503 as a delete refusal', async () => {
    const client = await serve(() => [503, { code: 'runtime_unavailable', error: 'runtime admission is unavailable' }]);
    const error = await client.deleteCard('main-1', { preparedBy: 'req-1' }).catch((failure: unknown) => failure);
    expect(error).not.toBeInstanceOf(CardDeleteRefusedError);
    expect(error).toBeInstanceOf(Error);
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

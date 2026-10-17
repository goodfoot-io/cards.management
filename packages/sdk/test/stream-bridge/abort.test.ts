/**
 * Session read cancellation end to end: the real session controller, the real
 * Cards session adapter and the real {@link CardsClient} against a real local
 * HTTP server that holds stream reads open until the test answers them.
 *
 * The non-signal-aware client is the shape a host gets when it drops the read
 * options (a `(cardId, streamType, relPath, tail)` lambda): its fetch never
 * cancels, so only the controller's own slot release and fencing protect it.
 * @summary Superseded session read cancellation and slot release
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../../src/client/cardsClient.js';
import { NetworkError, RequestCancelledError } from '../../src/client/types/errors.js';
import type { StreamSourceBinding, StreamSourceRef, StreamSourceSnapshot } from '../../src/protocol/index.js';
import { type CardsStreamClient, createCardsSessionClient } from '../../src/stream-bridge/index.js';
import {
  createSessionController,
  type SessionController,
  type SessionControllerEvent,
  type SessionDiagnostic,
  SessionSourceError,
  type SessionSourceState,
  streamSourceKey
} from '../../src/stream-session/index.js';
import { TAIL_HISTORY_LINES } from '../../src/stream-store/index.js';
import { main, mainBinding, meta, session, v1 } from '../stream-store/fixtures.js';

/** One stream read the server received. */
interface Exchange {
  relPath: string;
  tail: number | undefined;
  /** The client closed the connection before an answer. */
  closed: boolean;
  /** The server answered. */
  answered: boolean;
  /** Answers from the server's current content; a no-op once closed or answered. */
  answer(lines?: string[]): void;
}

/** A local Cards server whose stream reads are held until answered. */
interface Local {
  url: string;
  exchanges: Exchange[];
  /** Reads currently open: neither answered nor closed by the client. */
  open(): Exchange[];
  close(): Promise<void>;
}

/** Session members: one main and five subagents. */
const members: Array<{ source: StreamSourceRef; binding: StreamSourceBinding }> = [
  { source: main, binding: mainBinding },
  ...Array.from({ length: 5 }, (_, index) => ({
    source: { ...main, relPath: `s1/subagents/agent-${index}.jsonl` },
    binding: { sessionId: 's1', role: 'subagent' as const, agentId: `agent-${index}` }
  }))
];

const servers: Local[] = [];
afterEach(async () => {
  for (const local of servers.splice(0)) await local.close();
});

/**
 * Starts a local Cards server over in-memory transcripts.
 * @param content - Native lines per relPath, read at answer time.
 * @param options - Server behaviour.
 * @param options.port - Port to bind; 0 picks a free one.
 * @param options.hold - Holds reads until answered (default); false answers at once.
 * @param options.destroy - Destroys every stream read's socket, like a dropped connection.
 * @returns Server controls.
 */
async function serve(
  content: Map<string, string[]>,
  options: { port?: number; hold?: boolean; destroy?: boolean } = {}
): Promise<Local> {
  const exchanges: Exchange[] = [];
  const prefix = `/cards/${session.cardId}/streams`;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://local');
    if (url.pathname === prefix) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          members
            .filter(({ source }) => content.has(source.relPath))
            .map(({ source, binding }) => meta(source, binding, content.get(source.relPath)?.length ?? 0))
        )
      );
      return;
    }
    const relPath = url.pathname
      .slice(`${prefix}/${session.streamType}/`.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    const tailParam = url.searchParams.get('tail');
    const exchange: Exchange = {
      relPath,
      tail: tailParam === null ? undefined : Number(tailParam),
      closed: false,
      answered: false,
      answer(lines) {
        if (exchange.closed || exchange.answered) return;
        exchange.answered = true;
        const member = members.find(({ source }) => source.relPath === relPath);
        if (!member) throw new Error(`unknown source ${relPath}`);
        const all = lines ?? content.get(relPath) ?? [];
        const first = exchange.tail === undefined ? 1 : Math.max(1, all.length - exchange.tail + 1);
        const snapshot: StreamSourceSnapshot = {
          source: member.source,
          version: v1,
          binding: member.binding,
          meta: meta(member.source, member.binding, all.length),
          lines: all.slice(first - 1),
          firstLineNumber: first,
          totalLineCount: all.length
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(snapshot));
      }
    };
    response.on('close', () => {
      if (!exchange.answered) exchange.closed = true;
    });
    exchanges.push(exchange);
    if (options.destroy) request.socket.destroy();
    else if (options.hold === false) exchange.answer();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed = false;
  const local = {
    url: `http://127.0.0.1:${port}`,
    exchanges,
    open: () => exchanges.filter((exchange) => !exchange.closed && !exchange.answered),
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  servers.push(local);
  return local;
}

/**
 * Builds the Cards stream client a host hands the adapter.
 * @param url - Server base URL.
 * @param aware - Whether read options (signal, retry policy) reach the client.
 * @returns Stream client over a real CardsClient.
 */
function cardsClient(url: string, aware: boolean): CardsStreamClient {
  const cards = new CardsClient({ baseUrl: url, accessToken: 'token' });
  if (aware) return cards;
  return {
    listStreams: (cardId) => cards.listStreams(cardId),
    getStream: (cardId, streamType, relPath, tail) => cards.getStream(cardId, streamType, relPath, tail)
  };
}

/** A real controller over a real Cards client and its diagnostics. */
interface Session {
  controller: SessionController;
  diagnostics: SessionDiagnostic[];
  emit(event: SessionControllerEvent): void;
  state(source: StreamSourceRef): SessionSourceState | undefined;
}

/**
 * Starts a controller and subscribes the given members once membership is listed.
 * @param client - Cards stream client.
 * @param subscribed - Members to subscribe in tail mode.
 * @returns Running session.
 */
async function start(client: CardsStreamClient, subscribed: StreamSourceRef[]): Promise<Session> {
  const diagnostics: SessionDiagnostic[] = [];
  let listener: ((event: SessionControllerEvent) => void) | undefined;
  const controller = createSessionController({
    session,
    generation: 'view-1',
    client: createCardsSessionClient(client),
    events: {
      subscribe(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      }
    },
    scheduler: {
      every(milliseconds, callback) {
        const timer = setInterval(callback, milliseconds);
        return () => clearInterval(timer);
      },
      after(milliseconds, callback) {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      }
    },
    publish: () => undefined,
    diagnostic: (event) => diagnostics.push(event)
  });
  disposers.push(() => controller.dispose());
  controller.start();
  await vi.waitFor(() => expect(controller.getState().revision).toBeGreaterThan(0), { timeout: 2000 });
  for (const [index, source] of subscribed.entries())
    controller.subscribe({ source, mode: 'tail', requestId: `r${index + 1}`, generation: 'view-1' });
  return {
    controller,
    diagnostics,
    emit: (event) => listener?.(event),
    state: (source) => controller.getState().sources.get(streamSourceKey(source))
  };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/**
 * Transcripts for the first `count` members.
 * @param count - Members listed by the server.
 * @returns Lines per relPath.
 */
function transcripts(count: number): Map<string, string[]> {
  return new Map(members.slice(0, count).map(({ source }) => [source.relPath, [`${source.relPath}:1`]]));
}

const wait = { timeout: 2000, interval: 5 };

describe('Cards stream reads honour the caller signal', () => {
  it('cancels the HTTP request when a session read is aborted through the adapter', async () => {
    const local = await serve(transcripts(1));
    const adapter = createCardsSessionClient(cardsClient(local.url, true));
    const abort = new AbortController();
    const read = adapter.getStream(main, 'tail', abort.signal);
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(1), wait);
    expect(local.exchanges[0]).toMatchObject({ relPath: main.relPath, tail: TAIL_HISTORY_LINES });
    abort.abort();
    await expect(read).rejects.toBeInstanceOf(SessionSourceError);
    await vi.waitFor(() => expect(local.exchanges[0]?.closed).toBe(true), wait);
  });

  it('stops retrying the moment the signal fires during a network-error backoff', async () => {
    const local = await serve(transcripts(1), { destroy: true });
    const cards = new CardsClient({ baseUrl: local.url, accessToken: 'token' });
    const abort = new AbortController();
    const read = cards.getStream(session.cardId, session.streamType, main.relPath, undefined, {
      signal: abort.signal
    });
    // The first attempt fails at the socket; the client is now waiting out its 3 s backoff.
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(1), wait);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const aborted = Date.now();
    abort.abort();
    await expect(read).rejects.toBeInstanceOf(RequestCancelledError);
    expect(Date.now() - aborted).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 3300));
    expect(local.exchanges).toHaveLength(1);
  });

  it('surfaces the first network failure of a session read for the controller to retry', async () => {
    const local = await serve(transcripts(1), { destroy: true });
    const cards = new CardsClient({ baseUrl: local.url, accessToken: 'token' });
    const started = Date.now();
    await expect(
      cards.getStream(session.cardId, session.streamType, main.relPath, undefined, {
        signal: new AbortController().signal,
        retryOnNetworkError: false
      })
    ).rejects.toBeInstanceOf(NetworkError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe.each([
  ['a signal-aware client', true],
  ['a non-signal-aware client', false]
])('session read slots with %s', (_name, aware) => {
  it('frees an aborted read slot at once for the next waiting member', async () => {
    const local = await serve(transcripts(5));
    const test = await start(
      cardsClient(local.url, aware),
      members.slice(0, 5).map(({ source }) => source)
    );
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(4), wait);
    const first = local.exchanges[0];
    expect(first?.relPath).toBe(main.relPath);
    test.controller.unsubscribe(main, 'view-1');
    // The fifth member starts while the other three stay held.
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(5), wait);
    expect(local.exchanges[4]?.relPath).toBe(members[4]?.source.relPath);
    if (aware) await vi.waitFor(() => expect(first?.closed).toBe(true), wait);
    else expect(first?.closed).toBe(false);
    expect(test.diagnostics.filter((event) => event.code === 'read-aborted')).toHaveLength(1);
    for (const exchange of local.exchanges.slice(1)) exchange.answer();
    for (const { source } of members.slice(1, 5))
      await vi.waitFor(() => expect(test.state(source)).toMatchObject({ status: 'ready' }), wait);
  });

  it("ignores a superseded read's late response", async () => {
    const content = transcripts(1);
    const local = await serve(content);
    const test = await start(cardsClient(local.url, aware), [main]);
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(1), wait);
    // An upgrade supersedes the held tail read; the full read starts without waiting for it.
    test.controller.subscribe({ source: main, mode: 'full', requestId: 'r2', generation: 'view-1' });
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(2), wait);
    expect(local.exchanges.map((exchange) => exchange.tail)).toEqual([TAIL_HISTORY_LINES, undefined]);
    content.set(main.relPath, ['a', 'b', 'c']);
    local.exchanges[1]?.answer();
    await vi.waitFor(() => expect(test.state(main)).toMatchObject({ status: 'ready', lines: ['a', 'b', 'c'] }), wait);
    // The late answer carries different bytes for the same coordinates and must not apply.
    local.exchanges[0]?.answer(['zz', 'b', 'c']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.state(main)).toMatchObject({ status: 'ready', lines: ['a', 'b', 'c'], error: null });
    if (aware) expect(local.exchanges[0]?.closed).toBe(true);
    expect(test.diagnostics.map((event) => event.code)).not.toContain('inconsistent-source');
  });

  it('never lets superseded reads in an overflow burst delay the newest reads beyond the four-slot cap', async () => {
    const content = transcripts(4);
    const local = await serve(content);
    const sources = members.slice(0, 4).map(({ source }) => source);
    const test = await start(cardsClient(local.url, aware), sources);
    await vi.waitFor(() => expect(local.exchanges).toHaveLength(4), wait);
    const rounds = 5;
    for (let round = 1; round <= rounds; round++) {
      // A live burst overflows the controller buffer while every read is held.
      for (let index = 0; index < 1001; index++) {
        const member = members[index % 4];
        if (!member) throw new Error('missing member');
        const { source, binding } = member;
        const lines = content.get(source.relPath) ?? [];
        lines.push(`${source.relPath}:${lines.length + 1}`);
        test.emit({
          type: 'append',
          source,
          version: v1,
          binding,
          lineNumber: lines.length,
          line: lines.at(-1) ?? ''
        });
      }
      // Each section is re-requested, superseding its held read.
      sources.forEach((source, index) => {
        test.controller.unsubscribe(source, 'view-1');
        test.controller.subscribe({ source, mode: 'tail', requestId: `r${round}-${index}`, generation: 'view-1' });
      });
      await vi.waitFor(() => expect(local.exchanges).toHaveLength(4 * (round + 1)), wait);
    }
    // Only the newest four are live on the controller; the superseded ones are closed or ignored.
    const newest = local.exchanges.slice(-4);
    if (aware) expect(local.open()).toEqual(newest);
    else expect(local.open()).toHaveLength(4 * (rounds + 1));
    for (const exchange of newest) exchange.answer();
    for (const source of sources) {
      await vi.waitFor(() => expect(test.state(source)).toMatchObject({ status: 'ready' }), wait);
      const all = content.get(source.relPath) ?? [];
      expect(test.state(source)?.totalLineCount).toBe(all.length);
    }
    const aborted = test.diagnostics.filter((event) => event.code === 'read-aborted');
    // Rate-limited per source: 20 aborts across four sources report at most 1, 2, 4 per source.
    expect(aborted.length).toBeLessThanOrEqual(12);
    expect(aborted.reduce((total, event) => total + (event.count ?? 1), 0)).toBeLessThanOrEqual(4 * rounds);
  });

  it('converges after reconnecting to a restarted server, with abandoned reads holding no slot', async () => {
    const content = transcripts(6);
    const first = await serve(content);
    const port = Number(new URL(first.url).port);
    const test = await start(
      cardsClient(first.url, aware),
      members.map(({ source }) => source)
    );
    await vi.waitFor(() => expect(first.exchanges).toHaveLength(4), wait);
    test.emit({ type: 'connection', connected: false });
    // The server goes away with four reads in flight and two members still queued.
    await first.close();
    const second = await serve(content, { port, hold: false });
    const reconnected = Date.now();
    test.emit({ type: 'connection', connected: true });
    for (const { source } of members)
      await vi.waitFor(() => expect(test.state(source)).toMatchObject({ status: 'ready', error: null }), wait);
    // Well inside the Cards client's 3 s network backoff an abandoned read would wait out.
    expect(Date.now() - reconnected).toBeLessThan(2000);
    expect(second.exchanges.length).toBeGreaterThanOrEqual(6);
  });
});

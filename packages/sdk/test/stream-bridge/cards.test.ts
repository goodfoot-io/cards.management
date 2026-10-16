/**
 * Cards client adaptation (tail query, failure classification) and domain
 * event mapping onto session controller events.
 * @summary Cards session client and domain event adapter checks
 */
import { describe, expect, it } from 'vitest';
import { CardsClient } from '../../src/client/cardsClient.js';
import { ApiError } from '../../src/client/types/errors.js';
import type { DomainEvent } from '../../src/protocol/index.js';
import { createCardsSessionClient, sessionEventFromDomainEvent } from '../../src/stream-bridge/index.js';
import { SessionSourceError } from '../../src/stream-session/index.js';
import { TAIL_HISTORY_LINES } from '../../src/stream-store/index.js';
import { TestHttpClient } from '../../src/testing/index.js';
import { child, childBinding, main, mainBinding, meta, v1 } from '../stream-store/fixtures.js';

const signal = new AbortController().signal;
const base = 'http://localhost:3000/cards/card-1/streams/claude-code-session/s1.jsonl';

/**
 * Builds a session client over a recorded HTTP client.
 * @returns Adapter and its HTTP recorder.
 */
function http(): { http: TestHttpClient; client: ReturnType<typeof createCardsSessionClient> } {
  const recorder = new TestHttpClient();
  const cards = new CardsClient({ baseUrl: 'http://localhost:3000', accessToken: 'token' }, recorder);
  return { http: recorder, client: createCardsSessionClient(cards) };
}

/**
 * Rejects every read with the given failure.
 * @param failure - Rejection value.
 * @returns Adapter whose reads always fail.
 */
function failing(failure: unknown): ReturnType<typeof createCardsSessionClient> {
  return createCardsSessionClient({
    listStreams: () => Promise.resolve([]),
    getStream: () => Promise.reject(failure)
  });
}

describe('createCardsSessionClient', () => {
  it('requests the bounded tail for tail reads and the full source otherwise', async () => {
    const { http: recorder, client } = http();
    await client.getStream(main, 'tail', signal);
    await client.getStream(main, 'full', signal);
    expect(recorder.requests.map((request) => request.url)).toEqual([`${base}?tail=${TAIL_HISTORY_LINES}`, base]);
  });

  it('lists through the card stream listing', async () => {
    const { http: recorder, client } = http();
    recorder.responses.set('http://localhost:3000/cards/card-1/streams', [meta(main, mainBinding, 1)]);
    expect(await client.listStreams('card-1', signal)).toEqual([meta(main, mainBinding, 1)]);
  });

  it.each([
    [new ApiError('gone', 'NOT_FOUND'), 'not-found'],
    [new ApiError('bad scope', 'VALIDATION_ERROR'), 'rejected-scope'],
    [new ApiError('changed during read', 'STREAM_SOURCE_INCOHERENT'), 'inconsistent-source'],
    [new ApiError('reads unavailable', 'STREAM_SOURCE_UNAVAILABLE'), 'load-error'],
    [new ApiError('metadata unbound', 'STREAM_SOURCE_UNBOUND'), 'rejected-scope'],
    [new ApiError('publication failed', 'STREAM_SOURCE_PUBLICATION'), 'load-error'],
    [new ApiError('inherited key', 'constructor'), 'load-error'],
    [new ApiError('boom', 'INTERNAL_ERROR'), 'load-error'],
    [new Error('native path /secret'), 'load-error']
  ] as const)('classifies %s as %s without its message', async (failure, code) => {
    const error = await failing(failure)
      .getStream(main, 'tail', signal)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SessionSourceError);
    expect((error as SessionSourceError).code).toBe(code);
    expect((error as SessionSourceError).message).not.toContain(failure.message);
  });
});

describe('sessionEventFromDomainEvent', () => {
  it('maps every stream publication with its version and exact binding', () => {
    const events: DomainEvent[] = [
      {
        type: 'stream:line',
        cardId: 'card-1',
        ...pick(child),
        lineNumber: 4,
        line: 'x',
        version: v1,
        binding: childBinding
      },
      { type: 'stream:started', cardId: 'card-1', meta: meta(main, mainBinding, 2), version: v1, binding: mainBinding },
      {
        type: 'stream:resumed',
        cardId: 'card-1',
        meta: meta(main, mainBinding, 5),
        previousLineCount: 3,
        version: v1,
        binding: mainBinding
      },
      { type: 'stream:ended', cardId: 'card-1', ...pick(main), lineCount: 7, version: v1, binding: mainBinding },
      {
        type: 'stream:invalidated',
        cardId: 'card-1',
        ...pick(main),
        version: v1,
        binding: mainBinding,
        reason: 'server-restarted'
      }
    ];
    expect(events.map(sessionEventFromDomainEvent)).toEqual([
      { type: 'append', source: child, version: v1, binding: childBinding, lineNumber: 4, line: 'x' },
      { type: 'started', source: main, version: v1, binding: mainBinding, totalLineCount: 2 },
      { type: 'resumed', source: main, version: v1, binding: mainBinding, totalLineCount: 5 },
      { type: 'ended', source: main, version: v1, binding: mainBinding, totalLineCount: 7 },
      { type: 'invalidated', source: main, version: v1, binding: mainBinding, reason: 'server-restarted' }
    ]);
    const mapped = sessionEventFromDomainEvent({
      type: 'stream:ended',
      cardId: 'card-1',
      ...pick(main),
      lineCount: 1,
      version: v1,
      binding: { ...mainBinding, agentId: undefined }
    });
    expect(mapped && 'binding' in mapped ? Object.keys(mapped.binding) : []).toEqual(['sessionId', 'role']);
  });

  it('turns card commits into membership refreshes and ignores unrelated events', () => {
    const commit = { type: 'card:commit', cardId: 'card-1', commit: {} } as unknown as DomainEvent;
    expect(sessionEventFromDomainEvent(commit)).toEqual({ type: 'refresh', cardId: 'card-1', reason: 'commit' });
    const error: DomainEvent = {
      type: 'stream:error',
      cardId: 'card-1',
      relPath: 's1.jsonl',
      lineNumber: 1,
      error: 'x'
    };
    expect(sessionEventFromDomainEvent(error)).toBeNull();
  });
});

/**
 * Extracts the provider and path fields of a source.
 * @param source - Source identity.
 * @param source.streamType - Provider stream type.
 * @param source.relPath - Source-relative path.
 * @returns Event location fields.
 */
function pick(source: { streamType: string; relPath: string }): { streamType: string; relPath: string } {
  return { streamType: source.streamType, relPath: source.relPath };
}

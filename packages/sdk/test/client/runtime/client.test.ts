import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboundMessage, RuntimeClient, RuntimeClientOptions } from '../../../src/client/runtime/index.js';
import { createRuntimeClient } from '../../../src/client/runtime/index.js';
import { MAX_CONTROL_FRAME_BYTES, RUNTIME_CREDENTIAL_HEADERS } from '../../../src/protocol/types/index.js';
import { FakeRuntimeServer } from './fakeServer.js';
import { MemoryOutbox, makeAcceptingAuthorities, makeCredential, makeIdentity, makeRecordInput } from './index.js';

/**
 * End-to-end behaviour of the runtime client against a real socket.
 *
 * The cases here are chosen around what goes wrong rather than what goes right. A client
 * that connects and sends on a healthy server is easy; the ones that matter are the client
 * whose connection died between sending and hearing back, the one whose registration was
 * fenced by its own successor, and the one asked to send before it knows what the server
 * already has. Each of those, done wrong, either duplicates a real effect or silently
 * loses a durable obligation.
 *
 * @summary Tests discovery, handshake, synchronization, send outcomes, and reconnect
 */

let server: FakeRuntimeServer | null = null;
let client: RuntimeClient | null = null;

afterEach(async () => {
  await client?.close();
  await server?.stop();
  client = null;
  server = null;
});

const optionsFor = (
  target: FakeRuntimeServer,
  overrides: Partial<RuntimeClientOptions> = {}
): RuntimeClientOptions => ({
  identity: makeIdentity(),
  credential: makeCredential(),
  outbox: new MemoryOutbox(),
  authorities: makeAcceptingAuthorities(),
  discover: async () => ({ host: '127.0.0.1', port: target.port, accessToken: 'token-1' }),
  onMessage: () => undefined,
  ...overrides
});

const intent = (messageId: string): OutboundMessage<'execution.cancelRequest'> => ({
  type: 'execution.cancelRequest',
  payload: { reason: 'user', overridesIdleRequirement: false },
  messageId,
  requestId: 'req-1',
  execution: { executionId: 'exec-1', launchRequestId: 'req-1' }
});

describe('connecting', () => {
  it('presents the role credential in headers on the upgrade', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));
    await client.connect();

    const headers = server.handshakes[0];
    expect(headers?.[RUNTIME_CREDENTIAL_HEADERS.credentialId]).toBe('cred-1');
    expect(headers?.[RUNTIME_CREDENTIAL_HEADERS.secret]).toBe('secret-1');
  });

  it('reports connected with the generation the server assigned', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));
    const result = await client.connect();

    expect(result.status).toBe('connected');
    expect(client.state).toBe('connected');
  });

  it('treats a first connection in the slot as not resumed', async () => {
    server = await FakeRuntimeServer.start({
      registration: { status: 'registered', generation: 1, fencedGeneration: null } as never
    });
    client = createRuntimeClient(optionsFor(server));
    const result = await client.connect();

    expect(result).toMatchObject({ status: 'connected', resumed: false });
  });

  it('treats displacing its own earlier connection as a resume', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));
    await client.connect();
    server.dropConnections();
    server.rescript({ registration: { status: 'registered', generation: 2, fencedGeneration: 1 } as never });
    const result = await client.connect();

    expect(result).toMatchObject({ status: 'connected', resumed: true });
    expect(server.received.map(({ type }) => type)).toEqual(['runtime.register', 'runtime.resume']);
  });

  it('surfaces a registration refusal with the server reason rather than a generic failure', async () => {
    server = await FakeRuntimeServer.start({
      registration: { status: 'refused', reason: 'ownership-superseded' }
    });
    client = createRuntimeClient(optionsFor(server));

    await expect(client.connect()).resolves.toEqual({ status: 'refused', reason: 'ownership-superseded' });
  });

  it('reports unavailable rather than throwing when discovery finds no endpoint', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server, { discover: async () => null }));
    const result = await client.connect();

    expect(result.status).toBe('unavailable');
  });

  it('rediscovers the endpoint on every attempt instead of reusing a remembered address', async () => {
    server = await FakeRuntimeServer.start();
    let calls = 0;
    const target = server;
    client = createRuntimeClient(
      optionsFor(server, {
        discover: async () => {
          calls += 1;
          return { host: '127.0.0.1', port: target.port, accessToken: `token-${calls}` };
        }
      })
    );

    await client.connect();
    server.dropConnections();
    await client.connect();

    expect(calls).toBeGreaterThan(1);
    expect(server.handshakes.at(-1)?.['authorization']).toBe('Bearer token-2');
  });

  it('does not retry under a generation the server already fenced', async () => {
    server = await FakeRuntimeServer.start({
      registration: { status: 'refused', reason: 'stale-generation' }
    });
    client = createRuntimeClient(optionsFor(server));
    await client.connect();

    expect(client.state).toBe('fenced');
    expect(server.handshakes).toHaveLength(1);
  });
});

describe('synchronization before new work', () => {
  it('opens with a register or resume frame before anything else', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));
    await client.connect();

    expect(server.received[0]?.type).toMatch(/^runtime\.(register|resume)$/);
  });

  it('reports the server work revision rather than a locally assumed one', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'resume-me' }));
    server = await FakeRuntimeServer.start({ workRevision: 12 });
    client = createRuntimeClient(optionsFor(server, { outbox }));
    const result = await client.connect();

    expect(result).toMatchObject({ synchronization: { workRevision: 12 } });
  });

  it('refuses to send before the barrier has been cleared', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));

    await expect(client.send(intent('msg-early'))).resolves.toMatchObject({
      status: 'rejected',
      reason: 'not-synchronized'
    });
  });

  it('replays an obligation the server did not confirm', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'unconfirmed' }));
    server = await FakeRuntimeServer.start({ acceptedMessageIds: [] });
    client = createRuntimeClient(optionsFor(server, { outbox }));
    const result = await client.connect();

    expect(result).toMatchObject({ synchronization: { pendingMessageIds: ['unconfirmed'] } });
  });

  it('retires an obligation the server confirmed instead of sending it again', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue(makeRecordInput({ messageId: 'already-there' }));
    server = await FakeRuntimeServer.start({ acceptedMessageIds: ['already-there'] });
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();

    expect(outbox.stored).toHaveLength(0);
  });
});

describe('sending', () => {
  it('persists a durable intent before reporting anything to the caller', async () => {
    const outbox = new MemoryOutbox();
    outbox.failWrites = true;
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();

    const outcome = await client.send(intent('msg-1'));
    expect(outcome.status).not.toBe('accepted');
    expect(server.received.some((envelope) => envelope.messageId === 'msg-1')).toBe(false);
  });

  it('reports acceptance only once the server has durably taken the message', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));
    await client.connect();

    await expect(client.send(intent('msg-1'))).resolves.toEqual({ status: 'accepted', messageId: 'msg-1' });
  });

  it('retires the outbox record once acceptance arrives', async () => {
    const outbox = new MemoryOutbox();
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();
    await client.send(intent('msg-1'));

    expect(outbox.stored.some((record) => record.messageId === 'msg-1')).toBe(false);
  });

  it('answers a resend of the same message id without duplicating the record', async () => {
    const outbox = new MemoryOutbox();
    server = await FakeRuntimeServer.start({ withholdAcceptance: true });
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();

    await client.send({ ...intent('msg-1'), deadlineMs: 50 });
    await client.send({ ...intent('msg-1'), deadlineMs: 50 });

    expect(outbox.stored.filter((record) => record.messageId === 'msg-1')).toHaveLength(1);
  });

  it('reports uncertainty and keeps the record when the deadline expires', async () => {
    const outbox = new MemoryOutbox();
    server = await FakeRuntimeServer.start({ withholdAcceptance: true });
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();

    const outcome = await client.send({ ...intent('msg-1'), deadlineMs: 50 });

    expect(outcome).toMatchObject({ status: 'uncertain', reason: 'deadline-expired', requestId: 'req-1' });
    expect(outbox.stored.some((record) => record.messageId === 'msg-1')).toBe(true);
  });

  it('reports uncertainty rather than failure when the connection dies mid-flight', async () => {
    const outbox = new MemoryOutbox();
    server = await FakeRuntimeServer.start({ withholdAcceptance: true });
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();

    const pending = client.send({ ...intent('msg-1'), deadlineMs: 5_000 });
    server.dropConnections();

    await expect(pending).resolves.toMatchObject({ status: 'uncertain', reason: 'connection-lost' });
    expect(outbox.stored.some((record) => record.messageId === 'msg-1')).toBe(true);
  });

  it('never reports a deadline expiry as a rejection, since the server may still have it', async () => {
    server = await FakeRuntimeServer.start({ withholdAcceptance: true });
    client = createRuntimeClient(optionsFor(server));
    await client.connect();

    const outcome = await client.send({ ...intent('msg-1'), deadlineMs: 50 });
    expect(outcome.status).not.toBe('rejected');
  });

  it('rejects a frame larger than the control-frame cap without sending it', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));
    await client.connect();
    const before = server.received.length;

    const outcome = await client.send({
      ...intent('msg-huge'),
      requestId: 'x'.repeat(MAX_CONTROL_FRAME_BYTES)
    });

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'frame-too-large' });
    expect(server.received).toHaveLength(before);
  });

  it('does not persist disposable telemetry to the durable outbox', async () => {
    const outbox = new MemoryOutbox();
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server, { outbox }));
    await client.connect();

    await client.send({
      type: 'runtime.heartbeat',
      payload: { sentAt: '2026-01-01T00:00:00.000Z' },
      messageId: 'hb-1',
      execution: { executionId: 'exec-1', launchRequestId: 'req-1' }
    });

    expect(outbox.stored).toHaveLength(0);
  });
});

describe('closing', () => {
  it('closes under its current generation so a successor is not evicted', async () => {
    server = await FakeRuntimeServer.start({
      registration: { status: 'registered', generation: 4, fencedGeneration: 3 } as never
    });
    client = createRuntimeClient(optionsFor(server));
    await client.connect();
    const generation = client.generation;
    await client.close();

    expect(generation).toBe(4);
    expect(client.state).toBe('disconnected');
  });

  it('is safe to close a client that never connected', async () => {
    server = await FakeRuntimeServer.start();
    client = createRuntimeClient(optionsFor(server));

    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('inbound commands and owned lifecycle', () => {
  it.skip('delivers a typed server command only after registration and synchronization', async () => {
    server = await FakeRuntimeServer.start();
    const delivered: string[] = [];
    client = createRuntimeClient(
      optionsFor(server, { onMessage: (envelope) => void delivered.push(envelope.messageId) })
    );

    await client.connect();
    expect(delivered).toEqual([]);
    server.sendCommand('command-1');
    await vi.waitFor(() => expect(delivered).toEqual(['command-1']));
  });

  it.skip('does not expose registration, resume acknowledgments, or receipts as commands', async () => {
    server = await FakeRuntimeServer.start();
    const delivered: string[] = [];
    client = createRuntimeClient(
      optionsFor(server, { onMessage: (envelope) => void delivered.push(envelope.messageId) })
    );

    await client.connect();
    server.acknowledge('not-pending');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivered).toEqual([]);
  });

  it.skip('fences stale-socket commands and deduplicates a replayed command messageId', async () => {
    server = await FakeRuntimeServer.start();
    const delivered: string[] = [];
    client = createRuntimeClient(
      optionsFor(server, { onMessage: (envelope) => void delivered.push(envelope.messageId) })
    );
    await client.connect();
    server.rescript({ registration: { status: 'registered', generation: 2, fencedGeneration: 1 } as never });
    await client.connect();

    server.sendCommand('stale-command', 0);
    server.sendCommand('command-1', 1);
    server.sendCommand('command-1', 1);
    await vi.waitFor(() => expect(delivered).toEqual(['command-1']));
  });

  it.skip('rediscovers and reconnects after transport loss until explicitly stopped', async () => {
    server = await FakeRuntimeServer.start();
    let discoveries = 0;
    client = createRuntimeClient(
      optionsFor(server, {
        discover: async () => {
          discoveries += 1;
          return { host: '127.0.0.1', port: server?.port ?? 0, accessToken: `token-${discoveries}` };
        },
        backoff: { initialMs: 1, capMs: 2, jitter: () => 0 }
      })
    );

    await client.start();
    server.dropConnections();
    await vi.waitFor(() => expect(discoveries).toBeGreaterThan(1));
    await client.stop();
    const stoppedAt = discoveries;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(discoveries).toBe(stoppedAt);
  });
});

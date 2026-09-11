import type { IncomingHttpHeaders } from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { ConnectionGeneration, RegistrationOutcome, RuntimeEnvelope } from '../../../src/protocol/types/index.js';
import { RUNTIME_PROTOCOL_VERSION } from '../../../src/protocol/types/index.js';
import { TEST_EXECUTION, TEST_OWNERSHIP, TEST_SCOPE } from './index.js';

/**
 * A real WebSocket server standing in for the runtime route.
 *
 * It is a real server rather than a stubbed socket because the things most worth testing
 * here happen at the transport boundary — which headers actually arrived on the upgrade,
 * what a client does when a connection dies mid-flight — and neither is observable through
 * a mock that the client politely calls.
 *
 * The server is scriptable rather than correct: it replays whatever registration outcome
 * and acknowledgments a test tells it to, including sequences a correct server would never
 * produce, because the client's behaviour under those is the subject.
 *
 * @summary Scriptable WebSocket server for runtime client tests
 * @module
 */

/** How the fake server should behave for one test. */
export interface FakeRuntimeServerScript {
  /** Registration outcome sent after the client presents its opening envelope. */
  readonly registration?: RegistrationOutcome;
  /** Work revision reported in the synchronization reply. */
  readonly workRevision?: number;
  /** Message ids the server claims it already accepted. */
  readonly acceptedMessageIds?: readonly string[];
  /** Reject the upgrade outright, as a forged or revoked credential would be. */
  readonly refuseUpgrade?: boolean;
  /** Withhold the synchronization reply, leaving the barrier unmet. */
  readonly withholdResumeAck?: boolean;
  /** Never acknowledge client messages, so sends stay outstanding. */
  readonly withholdAcceptance?: boolean;
}

/** A running fake runtime server. */
export class FakeRuntimeServer {
  private readonly server: WebSocketServer;
  private readonly sockets = new Set<WsSocket>();
  private readonly connections: WsSocket[] = [];
  private script: FakeRuntimeServerScript;

  /** Upgrade request headers, one entry per connection attempt. */
  public readonly handshakes: IncomingHttpHeaders[] = [];

  /** Envelopes received from clients, in arrival order. */
  public readonly received: RuntimeEnvelope[] = [];

  private constructor(server: WebSocketServer, script: FakeRuntimeServerScript) {
    this.server = server;
    this.script = script;
  }

  /**
   * Starts a server on an ephemeral loopback port.
   *
   * @param script - Behaviour for this test.
   * @returns The running server, ready to accept upgrades.
   */
  static async start(script: FakeRuntimeServerScript = {}): Promise<FakeRuntimeServer> {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const fake = new FakeRuntimeServer(server, script);
    server.on('connection', (socket, request) => fake.onConnection(socket, request.headers));
    return fake;
  }

  /**
   * Port the server is listening on.
   *
   * @returns The ephemeral loopback port.
   */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake server is not listening on a port');
    }
    return address.port;
  }

  /**
   * Replaces the script, so a reconnect can be answered differently from the first attempt.
   *
   * @param script - Behaviour for subsequent connections.
   */
  rescript(script: FakeRuntimeServerScript): void {
    this.script = script;
  }

  /** Drops every open connection without a close handshake, as a crashed server would. */
  dropConnections(): void {
    for (const socket of this.sockets) {
      socket.terminate();
    }
    this.sockets.clear();
  }

  /**
   * Sends a durable receipt for one message id.
   *
   * @param messageId - The client message being acknowledged.
   */
  acknowledge(messageId: string): void {
    for (const socket of this.sockets) {
      socket.send(
        JSON.stringify(
          this.envelope('runtime.accepted', {
            acknowledgedMessageId: messageId,
            acknowledgedAt: '2026-01-01T00:00:02.000Z'
          })
        )
      );
    }
  }

  /**
   * Sends one valid server command on a selected connection generation.
   * @param messageId - Stable command identity.
   * @param connectionIndex - Zero-based accepted socket index, defaulting to the newest.
   */
  sendCommand(messageId: string, connectionIndex = this.connections.length - 1): void {
    this.connections[connectionIndex]?.send(
      JSON.stringify({
        ...this.envelope('execution.cancelCommand', {
          reason: 'user',
          overridesIdleRequirement: false
        }),
        messageId,
        requestId: 'req-1'
      })
    );
  }

  /** Stops the server and releases the port. */
  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private envelope(
    type: 'runtime.accepted' | 'runtime.resumeAck' | 'execution.cancelCommand',
    payload: unknown
  ): Record<string, unknown> {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      messageId: `srv-${this.received.length}-${type}`,
      causationId: 'caused-by',
      sentAt: '2026-01-01T00:00:02.000Z',
      execution: TEST_EXECUTION,
      scope: TEST_SCOPE,
      producer: { producerId: 'server-a', role: 'server' },
      ownership: TEST_OWNERSHIP,
      type,
      payload
    };
  }

  private onConnection(socket: WsSocket, headers: IncomingHttpHeaders): void {
    this.handshakes.push(headers);
    if (this.script.refuseUpgrade === true) {
      socket.close(1008, 'credential refused');
      return;
    }
    this.sockets.add(socket);
    this.connections.push(socket);

    socket.on('message', (raw: Buffer) => {
      const envelope = JSON.parse(raw.toString()) as RuntimeEnvelope;
      this.received.push(envelope);

      if (envelope.type === 'runtime.register' || envelope.type === 'runtime.resume') {
        const registration: RegistrationOutcome = this.script.registration ?? {
          status: 'registered',
          generation: 1 as ConnectionGeneration,
          fencedGeneration: null
        };
        socket.send(JSON.stringify(registration));
        if (envelope.type === 'runtime.resume' && this.script.withholdResumeAck !== true) {
          socket.send(
            JSON.stringify(
              this.envelope('runtime.resumeAck', {
                revision: 1,
                workRevision: this.script.workRevision ?? 0,
                acceptedMessageIds: this.script.acceptedMessageIds ?? []
              })
            )
          );
        }
        return;
      }

      if (this.script.withholdAcceptance !== true) {
        socket.send(
          JSON.stringify(
            this.envelope('runtime.accepted', {
              acknowledgedMessageId: envelope.messageId,
              acknowledgedAt: '2026-01-01T00:00:02.000Z'
            })
          )
        );
      }
    });

    socket.on('close', () => this.sockets.delete(socket));
  }
}

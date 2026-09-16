import type {
  ConnectionGeneration,
  ConnectionState,
  RegistrationOutcome,
  RuntimeEnvelope,
  RuntimeMessageType
} from '../../protocol/types/index.js';
import {
  authorizeMessage,
  deliveryClassFor,
  parseEnvelope,
  RUNTIME_MESSAGE_CONTRACTS,
  RUNTIME_PROTOCOL_VERSION,
  registrationOutcomeSchema
} from '../../protocol/types/index.js';
import { DEFAULT_BACKOFF_POLICY, nextBackoffDelayMs } from './backoff.js';
import { buildHandshakeRequest } from './handshake.js';
import { DEFAULT_HEARTBEAT_POLICY } from './heartbeat.js';
import type { ClientOutbox } from './outbox/index.js';
import { reconcileOutboxOnStartup } from './outbox/index.js';
import { collectOutstandingMessageIds, synchronize } from './synchronization.js';
import type {
  ConnectResult,
  OutboundMessage,
  RuntimeClient,
  RuntimeClientOptions,
  RuntimeInboundMessageType,
  SendOutcome,
  SynchronizationReport
} from './types.js';

/**
 * The shared runtime client every producer connects through.
 *
 * It owns the sequence that makes a reconnect safe rather than merely successful:
 * rediscover the endpoint, present the role credential in headers, register or resume,
 * synchronize, and only then deliver new work. Each step is separable and tested on its
 * own; this module is what orders them.
 *
 * Two rules shape the whole design. Durable messages are persisted to the outbox before
 * the caller is told anything succeeded, so a process that dies between send and
 * acknowledgment leaves a record rather than a gap. And a send whose fate is unknown
 * reports uncertainty while keeping its request id and its pending record — never silence,
 * and never a success the server did not give.
 *
 * @summary Discovery, handshake, registration, synchronization, heartbeat, and reconnect
 */

/**
 * A view of the outbox holding only records this client does not speak for.
 *
 * Startup reconciliation and the resume barrier both want to settle a pending record, and
 * only one of them is entitled to. For this execution's own obligations the server's
 * `acceptedMessageIds` is the answer, and handing them to a recovery authority first would
 * retire an obligation nobody has yet accepted. What is left — records written by an
 * execution that has since exited — is what recovery exists for, so that is all it sees.
 *
 * @param outbox - The store shared by every execution under this outbox root.
 * @param executionId - The execution this client speaks for.
 * @returns The same store, with this execution's records hidden from `scanAll`.
 */
function orphansOf(outbox: ClientOutbox, executionId: string): ClientOutbox {
  return {
    enqueue: (input) => outbox.enqueue(input),
    scan: (scope) => outbox.scan(scope),
    scanAll: async () => {
      const result = await outbox.scanAll();
      return { ...result, records: result.records.filter((record) => record.executionId !== executionId) };
    },
    refFor: (record) => outbox.refFor(record),
    retire: (ref, ack) => outbox.retire(ref, ack)
  };
}

/** Delivery classes whose messages must survive this process dying. */
const DURABLE_CLASSES = new Set(['durable-intent', 'durable-result']);

/**
 * Node's `WebSocket` accepts a non-standard `headers` option that the browser one does not.
 * The runtime route requires credentials in headers rather than the URL, and `ws` is only a
 * devDependency here, so this option is what lets the rule hold with no new dependency.
 * Verified against Node 24; do not "fix" it into a spec-compliant two-argument call.
 */
type NodeWebSocketInit = { readonly headers: Readonly<Record<string, string>> };

type SocketFactory = new (url: string, init: NodeWebSocketInit) => WebSocket;

interface PendingFrame {
  readonly socket: WebSocket;
  readonly matches: (envelope: RuntimeEnvelope) => boolean;
  readonly settle: (envelope: RuntimeEnvelope) => void;
  readonly close: () => void;
}

class RuntimeClientImpl implements RuntimeClient {
  private readonly options: RuntimeClientOptions;
  private socket: WebSocket | null = null;
  private currentState: ConnectionState = 'disconnected';
  private currentGeneration: ConnectionGeneration | null = null;
  private synchronization: SynchronizationReport | null = null;
  private hasRecovered = false;
  private readonly waiters = new Set<PendingFrame>();
  private readonly deliveredMessageIds = new Set<string>();
  private readonly queuedInbound = new Map<WebSocket, RuntimeEnvelope<RuntimeInboundMessageType>[]>();
  private connectInFlight: Promise<ConnectResult> | null = null;
  private connectAbort: AbortController | null = null;
  private lifecycleAbort: AbortController | null = null;
  private lifecyclePromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInboundAt = 0;
  private heartbeatSentAt: number | null = null;

  constructor(options: RuntimeClientOptions) {
    this.options = options;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get generation(): ConnectionGeneration | null {
    return this.currentGeneration;
  }

  async connect(): Promise<ConnectResult> {
    if (this.connectInFlight !== null) return this.connectInFlight;
    const controller = new AbortController();
    this.connectAbort = controller;
    const attempt = this.performConnect(controller.signal);
    this.connectInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connectInFlight === attempt) this.connectInFlight = null;
      if (this.connectAbort === controller) this.connectAbort = null;
    }
  }

  private async performConnect(signal: AbortSignal): Promise<ConnectResult> {
    if (this.currentState === 'fenced') {
      return { status: 'unavailable', detail: 'connection is fenced under this generation' };
    }
    this.currentState = 'connecting';

    const target = await Promise.race([
      this.options.discover(),
      new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))
    ]);
    if (target === null) {
      this.currentState = 'disconnected';
      return { status: 'unavailable', detail: 'no runtime endpoint was discovered' };
    }

    const request = buildHandshakeRequest(target, this.options.credential);
    const Socket = globalThis.WebSocket as unknown as SocketFactory;
    const socket = new Socket(request.url, { headers: request.headers });
    signal.addEventListener('abort', () => socket.close(), { once: true });
    const previousSocket = this.socket;
    this.socket = socket;
    if (previousSocket !== null && previousSocket.readyState <= 1) previousSocket.close(1000, 'superseded locally');
    this.currentState = 'authenticating';

    const outstanding = await collectOutstandingMessageIds(this.options.outbox, this.executionId());
    const resumed = this.currentGeneration !== null || outstanding.length > 0;
    const opening = this.openingMessage(resumed, outstanding);
    const resumeAcknowledgment = resumed
      ? this.waitForFrame(socket, (envelope) => envelope.type === 'runtime.resumeAck', undefined)
      : null;
    const registration = await this.openAndRegister(socket, opening);
    if (registration === null) {
      this.currentState = 'disconnected';
      return { status: 'unavailable', detail: 'the connection closed before registration' };
    }
    if (registration.status === 'refused') {
      this.currentState = 'fenced';
      this.closeSocket();
      return { status: 'refused', reason: registration.reason };
    }

    this.currentGeneration = registration.generation;
    this.currentState = 'synchronizing';

    const synchronization = await this.runBarrier(resumeAcknowledgment);
    if (synchronization === null) {
      this.currentState = 'disconnected';
      return { status: 'unavailable', detail: 'the connection closed during synchronization' };
    }

    this.synchronization = synchronization;
    this.currentState = 'connected';
    await this.redrainOwnOutbox();
    this.flushInbound(socket);
    return { status: 'connected', generation: registration.generation, resumed, synchronization };
  }

  async start(): Promise<ConnectResult> {
    if (this.lifecycleAbort !== null) {
      return this.connectedResult();
    }
    const controller = new AbortController();
    this.lifecycleAbort = controller;
    const first = await this.connect();
    if (controller.signal.aborted) return first;
    if (first.status === 'connected') this.startHeartbeat(this.socket);
    this.lifecyclePromise = this.maintainConnections(controller.signal);
    return first;
  }

  async stop(): Promise<void> {
    const controller = this.lifecycleAbort;
    this.lifecycleAbort = null;
    controller?.abort();
    this.connectAbort?.abort();
    this.stopHeartbeat();
    this.closeSocket();
    await this.lifecyclePromise;
    this.lifecyclePromise = null;
    this.synchronization = null;
    if (this.currentState !== 'fenced') this.currentState = 'disconnected';
  }

  async send<TType extends RuntimeMessageType>(message: OutboundMessage<TType>): Promise<SendOutcome> {
    const socket = this.socket;
    if (this.currentState !== 'connected' || socket === null || this.synchronization === null) {
      return { status: 'rejected', messageId: message.messageId, reason: 'not-synchronized' };
    }

    const envelope = this.envelopeFor(message);
    const frame = JSON.stringify(envelope);
    if (frame.length > RUNTIME_MESSAGE_CONTRACTS[message.type].maxFrameBytes) {
      return { status: 'rejected', messageId: message.messageId, reason: 'frame-too-large' };
    }

    const deliveryClass = deliveryClassFor(message.type);
    const durable = DURABLE_CLASSES.has(deliveryClass);
    if (durable) {
      const persisted = await this.persist(message, envelope, deliveryClass);
      if (persisted !== null) {
        return persisted;
      }
    }

    socket.send(frame);
    if (!durable) {
      return { status: 'accepted', messageId: message.messageId };
    }

    return this.awaitAcceptance(message);
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState <= 1) {
      // Closing under the generation we hold; a late close from a fenced socket must not
      // evict the successor that displaced it, which is why the socket is dropped first.
      socket.close(1000, `generation:${String(this.currentGeneration ?? 0)}`);
    }
  }

  private envelopeFor<TType extends RuntimeMessageType>(message: OutboundMessage<TType>): RuntimeEnvelope<TType> {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      messageId: message.messageId,
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
      ...(message.causationId === undefined ? {} : { causationId: message.causationId }),
      sentAt: (this.options.now?.() ?? new Date()).toISOString(),
      execution: message.execution,
      scope: this.options.identity.scope,
      producer: this.options.identity.producer,
      ownership: this.options.identity.ownership,
      type: message.type,
      payload: message.payload
    };
  }

  private async persist<TType extends RuntimeMessageType>(
    message: OutboundMessage<TType>,
    envelope: RuntimeEnvelope<TType>,
    deliveryClass: string
  ): Promise<SendOutcome | null> {
    const executionId = message.execution?.executionId ?? this.executionId();
    try {
      await this.options.outbox.enqueue({
        messageId: message.messageId,
        executionId,
        requestId: message.requestId ?? message.messageId,
        role: this.options.identity.producer.role,
        deliveryClass: deliveryClass as 'durable-intent' | 'durable-result',
        envelope
      });
      return null;
    } catch {
      // The record is what makes a send recoverable. Without it the message must not reach
      // the wire at all, or a crash leaves an effect the client has no memory of requesting.
      return {
        status: 'uncertain',
        messageId: message.messageId,
        reason: 'storage-unavailable',
        requestId: message.requestId
      };
    }
  }

  private async awaitAcceptance<TType extends RuntimeMessageType>(
    message: OutboundMessage<TType>
  ): Promise<SendOutcome> {
    const socket = this.socket;
    if (socket === null) {
      return {
        status: 'uncertain',
        messageId: message.messageId,
        reason: 'connection-lost',
        requestId: message.requestId
      };
    }
    const accepted = await this.waitForFrame(
      socket,
      (envelope) =>
        envelope.type === 'runtime.accepted' &&
        (envelope.payload as { acknowledgedMessageId?: string }).acknowledgedMessageId === message.messageId,
      message.deadlineMs
    );

    if (accepted === 'timeout') {
      return {
        status: 'uncertain',
        messageId: message.messageId,
        reason: 'deadline-expired',
        requestId: message.requestId
      };
    }
    if (accepted === 'closed') {
      return {
        status: 'uncertain',
        messageId: message.messageId,
        reason: 'connection-lost',
        requestId: message.requestId
      };
    }

    await this.retire(message);
    const payload = accepted.payload as {
      workAdmission?:
        | { status: 'admitted'; workRevision: number }
        | { status: 'rejected'; reason: 'drainBarrierHeld'; barrierHolderId: string };
    };
    return {
      status: 'accepted',
      messageId: message.messageId,
      ...(payload.workAdmission ? { workAdmission: payload.workAdmission } : {})
    };
  }

  private async retire<TType extends RuntimeMessageType>(message: OutboundMessage<TType>): Promise<void> {
    const { records } = await this.options.outbox.scanAll();
    const record = records.find((candidate) => candidate.messageId === message.messageId);
    if (record === undefined) {
      return;
    }
    await this.options.outbox.retire(this.options.outbox.refFor(record), {
      messageId: message.messageId,
      acknowledgedAt: (this.options.now?.() ?? new Date()).toISOString()
    });
  }

  private async openAndRegister(
    socket: WebSocket,
    opening: OutboundMessage<'runtime.register'> | OutboundMessage<'runtime.resume'>
  ): Promise<RegistrationOutcome | null> {
    const opened =
      socket.readyState === WebSocket.OPEN
        ? true
        : socket.readyState >= WebSocket.CLOSING
          ? false
          : await new Promise<boolean>((resolve) => {
              socket.addEventListener('open', () => resolve(true), { once: true });
              socket.addEventListener('error', () => resolve(false), { once: true });
              socket.addEventListener('close', () => resolve(false), { once: true });
            });
    if (!opened) {
      return null;
    }

    this.attachFrameRouter(socket);
    const registration = new Promise<RegistrationOutcome | null>((resolve) => {
      const onMessage = (event: MessageEvent): void => {
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = registrationOutcomeSchema.safeParse(value);
        if (parsed.success) {
          socket.removeEventListener('message', onMessage);
          resolve(parsed.data);
        }
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', () => resolve(null), { once: true });
    });

    socket.send(JSON.stringify(this.envelopeFor(opening)));
    const outcome = await registration;
    return outcome;
  }

  private attachFrameRouter(socket: WebSocket): void {
    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = String(event.data);
      let envelope: RuntimeEnvelope;
      try {
        envelope = parseEnvelope(JSON.parse(frame));
      } catch {
        return;
      }
      const authorization = authorizeMessage(envelope, {
        authenticatedRole: 'server',
        authenticatedProducerId: envelope.producer.producerId,
        peerDirection: 'server-to-client',
        admittedScope: this.options.identity.scope,
        currentOwnership: this.options.identity.ownership,
        executionAdmitted: true,
        frameBytes: Buffer.byteLength(frame, 'utf8')
      });
      if (!authorization.authorized || socket !== this.socket) return;
      this.lastInboundAt = Date.now();
      this.heartbeatSentAt = null;
      for (const waiter of [...this.waiters]) {
        if (waiter.socket === socket && waiter.matches(envelope)) {
          this.waiters.delete(waiter);
          waiter.settle(envelope);
        }
      }
      if (this.isInboundCommand(envelope)) {
        if (this.currentState === 'connected') this.deliverInbound(socket, envelope);
        else this.queuedInbound.set(socket, [...(this.queuedInbound.get(socket) ?? []), envelope]);
      }
    });
    socket.addEventListener('close', () => {
      for (const waiter of [...this.waiters]) {
        if (waiter.socket === socket) {
          this.waiters.delete(waiter);
          waiter.close();
        }
      }
      if (this.currentState === 'connected') {
        this.currentState = 'disconnected';
      }
      this.queuedInbound.delete(socket);
      if (socket === this.socket) this.stopHeartbeat();
    });
  }

  private async waitForFrame(
    socket: WebSocket,
    matches: (envelope: RuntimeEnvelope) => boolean,
    deadlineMs: number | undefined
  ): Promise<RuntimeEnvelope | 'timeout' | 'closed'> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: PendingFrame = {
        socket,
        matches,
        settle: (envelope) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          resolve(envelope);
        },
        close: () => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          resolve('closed');
        }
      };
      this.waiters.add(waiter);
      if (deadlineMs !== undefined) {
        timer = setTimeout(() => {
          this.waiters.delete(waiter);
          resolve('timeout');
        }, deadlineMs);
      }
    });
  }

  private openingMessage(
    resumed: boolean,
    outstanding: readonly string[]
  ): OutboundMessage<'runtime.register'> | OutboundMessage<'runtime.resume'> {
    const executionId = this.executionId();
    const execution =
      this.options.identity.subject.kind === 'card'
        ? null
        : { executionId, launchRequestId: this.options.credential.requestId };
    const base = {
      revision: 0,
      capabilities: this.options.capabilities,
      lifecycleState: 'running',
      workRevision: 0
    } as const;

    return resumed
      ? {
          type: 'runtime.resume',
          payload: { ...base, outstandingMessageIds: [...outstanding] },
          messageId: `resume-${String(this.currentGeneration ?? 0)}`,
          execution
        }
      : {
          type: 'runtime.register',
          payload: base,
          messageId: `register-${String(this.currentGeneration ?? 0)}`,
          execution
        };
  }

  private async runBarrier(
    resumeAcknowledgment: Promise<RuntimeEnvelope | 'timeout' | 'closed'> | null
  ): Promise<SynchronizationReport | null> {
    const executionId = this.executionId();
    const acknowledgment = resumeAcknowledgment === null ? null : await resumeAcknowledgment;
    if (acknowledgment === 'timeout' || acknowledgment === 'closed') {
      return null;
    }

    const payload =
      acknowledgment === null
        ? { workRevision: 0, acceptedMessageIds: [] as readonly string[] }
        : (acknowledgment.payload as { workRevision: number; acceptedMessageIds: readonly string[] });
    const report = await synchronize({
      outbox: this.options.outbox,
      authorities: this.options.authorities,
      executionId,
      acknowledgment: { workRevision: payload.workRevision, acceptedMessageIds: payload.acceptedMessageIds },
      recoverOrphans: false
    });

    if (this.hasRecovered) {
      return report;
    }
    this.hasRecovered = true;
    const reconciliation = await reconcileOutboxOnStartup(
      orphansOf(this.options.outbox, executionId),
      this.options.authorities
    );
    return { ...report, reconciliation };
  }

  private connectedResult(): ConnectResult {
    if (this.currentState === 'connected' && this.currentGeneration !== null && this.synchronization !== null) {
      return {
        status: 'connected',
        generation: this.currentGeneration,
        resumed: true,
        synchronization: this.synchronization
      };
    }
    return { status: 'unavailable', detail: 'runtime client lifecycle is already started' };
  }

  private async maintainConnections(signal: AbortSignal): Promise<void> {
    let retry = 0;
    while (!signal.aborted && this.currentState !== 'fenced') {
      const socket = this.socket;
      if (this.currentState === 'connected' && socket !== null) {
        retry = 0;
        await this.waitForSocketClose(socket, signal);
        if (signal.aborted) return;
      }
      await this.delay(nextBackoffDelayMs(retry, this.options.backoff ?? DEFAULT_BACKOFF_POLICY), signal);
      if (signal.aborted) return;
      retry += 1;
      const result = await this.connect();
      if (signal.aborted) return;
      if (result.status === 'connected') {
        retry = 0;
        this.startHeartbeat(this.socket);
      } else if (result.status === 'refused') {
        return;
      }
    }
  }

  private waitForSocketClose(socket: WebSocket, signal: AbortSignal): Promise<void> {
    if (socket !== this.socket || socket.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        socket.removeEventListener('close', done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      socket.addEventListener('close', done, { once: true });
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, milliseconds);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private startHeartbeat(socket: WebSocket | null): void {
    this.stopHeartbeat();
    if (socket === null || this.lifecycleAbort === null) return;
    const policy = this.options.heartbeat ?? DEFAULT_HEARTBEAT_POLICY;
    this.lastInboundAt = Date.now();
    const tick = (): void => {
      if (this.lifecycleAbort === null || socket !== this.socket || this.currentState !== 'connected') return;
      const now = Date.now();
      if (this.heartbeatSentAt !== null && now - this.heartbeatSentAt >= policy.intervalMs * policy.missedLimit) {
        socket.close(4000, 'heartbeat-expired');
        return;
      }
      if (this.heartbeatSentAt === null && now - this.lastInboundAt >= policy.intervalMs) {
        this.heartbeatSentAt = now;
        socket.send(
          JSON.stringify(
            this.envelopeFor({
              type: 'runtime.heartbeat',
              payload: { sentAt: new Date(now).toISOString() },
              messageId: `heartbeat-${now}`,
              execution: null
            })
          )
        );
      }
      this.heartbeatTimer = setTimeout(tick, policy.intervalMs);
    };
    this.heartbeatTimer = setTimeout(tick, policy.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatSentAt = null;
  }

  private isInboundCommand(envelope: RuntimeEnvelope): envelope is RuntimeEnvelope<RuntimeInboundMessageType> {
    return (
      envelope.type === 'execution.cancelCommand' ||
      envelope.type === 'execution.switchToInteractiveCommand' ||
      envelope.type === 'execution.stopCommand' ||
      envelope.type === 'execution.branchCleanupEffect' ||
      envelope.type === 'execution.executeRequest' ||
      envelope.type === 'watcher.stopCommand'
    );
  }

  private deliverInbound(socket: WebSocket, envelope: RuntimeEnvelope<RuntimeInboundMessageType>): void {
    if (socket !== this.socket || this.deliveredMessageIds.has(envelope.messageId)) return;
    this.deliveredMessageIds.add(envelope.messageId);
    void Promise.resolve(this.options.onMessage(envelope)).catch(() => {
      this.deliveredMessageIds.delete(envelope.messageId);
    });
  }

  private flushInbound(socket: WebSocket): void {
    const queued = this.queuedInbound.get(socket) ?? [];
    this.queuedInbound.delete(socket);
    for (const envelope of queued) this.deliverInbound(socket, envelope);
  }

  private executionId(): string {
    const subject = this.options.identity.subject;
    return subject.kind === 'execution' ? subject.executionId : subject.cardId;
  }

  /** Replays this producer's still-unaccepted durable obligations after every synchronization barrier. */
  private async redrainOwnOutbox(): Promise<void> {
    const role = this.options.identity.producer.role;
    const scan = await this.options.outbox.scan({ executionId: this.executionId(), role });
    for (const record of scan.records) {
      const envelope = record.envelope;
      const result = await this.send({
        type: envelope.type,
        payload: envelope.payload,
        messageId: envelope.messageId,
        requestId: envelope.requestId,
        causationId: envelope.causationId,
        execution: envelope.execution,
        deadlineMs: 5_000
      } as OutboundMessage);
      if (result.status !== 'accepted') return;
    }
  }
}

/**
 * Creates a runtime client. The returned client is disconnected until {@link RuntimeClient.connect}.
 *
 * @param options - Identity, credential, outbox, authorities, and discovery.
 * @returns A client bound to those options.
 */
export function createRuntimeClient(options: RuntimeClientOptions): RuntimeClient {
  return new RuntimeClientImpl(options);
}

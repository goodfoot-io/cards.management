import type {
  AdmissionRejectionReason,
  AdmissionUncertaintyReason,
  ConnectionGeneration,
  ConnectionState,
  ConnectionSubject,
  ExecutionRef,
  FrameRefusalReason,
  OwnershipStamp,
  PresentedCredential,
  ProducerIdentity,
  RegistrationRefusalReason,
  RuntimeCapabilities,
  RuntimeEnvelope,
  RuntimeMessageType,
  RuntimePayload,
  RuntimeScope
} from '../../protocol/types/index.js';
import type { ClientOutbox, ReconciliationAuthorities, ReconciliationReport } from './outbox/index.js';

/**
 * Public contract of the SDK runtime client: what a producer supplies to open an
 * authenticated runtime connection, and what it gets back when it sends.
 *
 * The outcome vocabulary here is deliberately borrowed rather than invented. A caller
 * that already understands `RetrievedAdmission` understands a send outcome, because both
 * answer the same question — did the server durably take this, is it still open, or is it
 * refused — and a second vocabulary for that question would only invite the two to drift.
 *
 * @summary Types for the runtime client's connection, send, and synchronization surface
 */

/** Network location and API credential for one connection attempt. */
export interface RuntimeConnectTarget {
  readonly host: string;
  readonly port: number;
  /** Rotatable server access token. Rotation must not invalidate the role credential. */
  readonly accessToken: string;
}

/**
 * Rediscovers the endpoint before every attempt.
 *
 * Endpoint addresses are deliberately never persisted, so a resume after the server
 * moved or rotated its token succeeds without any stored address becoming wrong.
 */
export type RuntimeDiscovery = () => Promise<RuntimeConnectTarget | null>;

/** Stable identity this client presents on every frame it produces. */
export interface RuntimeClientIdentity {
  readonly subject: ConnectionSubject;
  readonly scope: RuntimeScope;
  readonly producer: ProducerIdentity;
  readonly ownership: OwnershipStamp;
}

/** Server commands delivered to an authenticated producer after its synchronization barrier. */
export type RuntimeInboundMessageType = Extract<
  RuntimeMessageType,
  | 'execution.cancelCommand'
  | 'execution.switchToInteractiveCommand'
  | 'execution.stopCommand'
  | 'execution.branchCleanupEffect'
  | 'execution.executeRequest'
  | 'watcher.stopCommand'
>;

/** Handles one authorized, generation-current server command. Durable commands remain caller-acknowledged. */
export type RuntimeInboundHandler = (envelope: RuntimeEnvelope<RuntimeInboundMessageType>) => void | Promise<void>;

/** Reconnect timing: exponential growth from `initialMs`, clamped at `capMs`, then jittered. */
export interface BackoffPolicy {
  readonly initialMs: number;
  readonly capMs: number;
  /** Returns a value in `[0, span)`. Injectable so tests can pin the draw. */
  readonly jitter: (span: number) => number;
}

/** Heartbeat cadence and how many missed intervals end the connection. */
export interface HeartbeatPolicy {
  readonly intervalMs: number;
  readonly missedLimit: number;
}

/** Everything the client needs to run; no ambient state, so tests construct it whole. */
export interface RuntimeClientOptions {
  readonly identity: RuntimeClientIdentity;
  /** Proves the admitted execution. Presented in headers, never in the URL. */
  readonly credential: PresentedCredential;
  readonly outbox: ClientOutbox;
  readonly authorities: ReconciliationAuthorities;
  /** Exact behavior implemented by this concrete producer adapter. */
  readonly capabilities: RuntimeCapabilities;
  readonly discover: RuntimeDiscovery;
  /** Receives commands only after registration and synchronization complete. */
  readonly onMessage: RuntimeInboundHandler;
  readonly backoff?: BackoffPolicy;
  readonly heartbeat?: HeartbeatPolicy;
  readonly now?: () => Date;
}

/**
 * What the client learned when it re-established the shared view of the world.
 *
 * This exists as a distinct result rather than a side effect because the caller is not
 * allowed to send new work until it has one: queued local intent that overtakes
 * reconciliation would be acting on a revision the server has already moved past.
 */
export interface SynchronizationReport {
  /** Durable obligations the client still holds and must replay. */
  readonly pendingMessageIds: readonly string[];
  /** Obligations the server confirmed it already accepted; these retire locally. */
  readonly acceptedMessageIds: readonly string[];
  /** Result of draining crash-surviving records before any new traffic. */
  readonly reconciliation: ReconciliationReport;
}

/** Outcome of establishing a connection. */
export type ConnectResult =
  | {
      readonly status: 'connected';
      readonly generation: ConnectionGeneration;
      /**
       * True when registration displaced this client's own earlier connection —
       * `RegistrationOutcome.fencedGeneration` was non-null. A resume keeps the outbox;
       * a first connection in the slot has nothing to resume.
       */
      readonly resumed: boolean;
      readonly synchronization: SynchronizationReport;
    }
  | { readonly status: 'refused'; readonly reason: RegistrationRefusalReason }
  | { readonly status: 'unavailable'; readonly detail: string };

/** A message the caller asks the client to deliver. */
export interface OutboundMessage<TType extends RuntimeMessageType = RuntimeMessageType> {
  readonly type: TType;
  readonly payload: RuntimePayload<TType>;
  /**
   * Caller-owned idempotency key, stable across process restarts. A CLI that dies and
   * retries reuses this id, which is what lets the server answer from its record instead
   * of performing the effect twice.
   */
  readonly messageId: string;
  readonly requestId?: string;
  readonly causationId?: string;
  /** Original envelope timestamp when replaying a durable outbox record. */
  readonly sentAt?: string;
  readonly execution: ExecutionRef | null;
  /** Bounded wait for durable acceptance. Expiry is never agent termination. */
  readonly deadlineMs?: number;
}

/** Why a send was refused outright. Drawn from the admission and transport vocabularies. */
export type SendRejectionReason = AdmissionRejectionReason | RegistrationRefusalReason | FrameRefusalReason;

/**
 * Why a send's fate is unknown.
 *
 * `deadline-expired` and `connection-lost` are client-side conditions with no server
 * vocabulary to borrow: the server never observed the first, and cannot report the second.
 * Both keep the request id and the pending outbox record, so an uncertain send is always
 * retryable rather than lost.
 */
export type SendUncertaintyReason = AdmissionUncertaintyReason | 'deadline-expired' | 'connection-lost';

/**
 * What the caller learns about a send.
 *
 * `accepted` means durably taken by the server — for a CLI or hook this, not agent
 * termination, is what a success exit code reports.
 */
export type SendOutcome =
  | {
      readonly status: 'accepted';
      readonly messageId: string;
    }
  | { readonly status: 'completed'; readonly messageId: string; readonly payload: unknown }
  | { readonly status: 'rejected'; readonly messageId: string; readonly reason: SendRejectionReason }
  | {
      readonly status: 'uncertain';
      readonly messageId: string;
      readonly reason: SendUncertaintyReason;
      /** Retained so a retry reuses the original identity rather than opening a new one. */
      readonly requestId: string | undefined;
    };

/**
 * An authenticated runtime connection.
 *
 * Connection state and execution lifecycle state stay separate on purpose: a
 * disconnected execution is still running, and nothing here may imply otherwise.
 */
export interface RuntimeClient {
  /** Transient transport state, never the execution's lifecycle state. */
  readonly state: ConnectionState;
  /** Current generation once registered; `null` before the first successful registration. */
  readonly generation: ConnectionGeneration | null;
  connect(): Promise<ConnectResult>;
  /** Starts owned reconnect and heartbeat work; resolves after the first attempt completes. */
  start(): Promise<ConnectResult>;
  /** Stops retry/heartbeat work and closes only this client's transport. */
  stop(): Promise<void>;
  send<TType extends RuntimeMessageType>(message: OutboundMessage<TType>): Promise<SendOutcome>;
  /** Closes under the current generation so a late close cannot evict a successor. */
  close(): Promise<void>;
}

/**
 * Public surface of the SDK runtime client.
 *
 * The outbox and durable-result stores are deliberately not re-exported here. They are
 * separate subpaths because they touch the filesystem and have their own lifecycles —
 * recovery storage outlives any one connection, and folding them into this barrel would
 * make that look like part of the transport.
 *
 * @summary Barrel for the runtime client's connection, handshake, and synchronization API
 * @module
 */

export type {
  RuntimeActionClient,
  RuntimeActionClientOptions,
  RuntimeActionHttpRejectionReason,
  RuntimeActionLaunchRequest,
  RuntimeActionLaunchResponse,
  RuntimeActionLaunchResult,
  RuntimeActionRetrievalResult,
  RuntimeActionTransportUncertaintyReason
} from './actions.js';
export { createRuntimeActionClient } from './actions.js';
export { DEFAULT_BACKOFF_POLICY, nextBackoffDelayMs } from './backoff.js';
export { createRuntimeClient } from './client.js';
export {
  type LoadedRuntimeCredential,
  loadRuntimeCredential,
  readRuntimeCredentialFile,
  writeRuntimeCredentialFile
} from './credential-file.js';
export { buildHandshakeRequest, type RuntimeHandshakeRequest } from './handshake.js';
export {
  DEFAULT_HEARTBEAT_POLICY,
  evaluateHeartbeat,
  type HeartbeatDecision,
  type HeartbeatState
} from './heartbeat.js';
export {
  collectOutstandingMessageIds,
  type ResumeAcknowledgment,
  type SynchronizationInput,
  synchronize
} from './synchronization.js';
export type {
  BackoffPolicy,
  ConnectResult,
  HeartbeatPolicy,
  OutboundMessage,
  RuntimeClient,
  RuntimeClientIdentity,
  RuntimeClientOptions,
  RuntimeConnectTarget,
  RuntimeDiscovery,
  SendOutcome,
  SendRejectionReason,
  SendUncertaintyReason,
  SynchronizationReport
} from './types.js';

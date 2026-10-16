/**
 * Public native-source session identities, grouping, and subscription control.
 * @summary Renderer-independent session subscription boundary
 * @module stream-session
 */
export type {
  SessionDescriptor,
  SessionMember,
  StreamSessionRef,
  StreamSourceBinding,
  StreamSourceRef,
  StreamSourceSnapshot,
  StreamSourceVersion
} from '../protocol/types/stream.js';
export type {
  SessionClient,
  SessionController,
  SessionControllerEvent,
  SessionControllerOptions,
  SessionControllerState,
  SessionDiagnostic,
  SessionEventSource,
  SessionHistoryMode,
  SessionScheduler,
  SessionSourceAuthority,
  SessionSourceEvent,
  SessionSourceRequest,
  SessionSourceState
} from './controller.js';
export { createSessionController } from './controller.js';
export type { SessionSourceFailure } from './errors.js';
export { SessionSourceError } from './errors.js';
export type { SessionGroup, SessionGroupingError, SessionGroupingResult } from './grouping.js';
export { groupStreamSessions, streamSessionKey, streamSourceKey } from './grouping.js';

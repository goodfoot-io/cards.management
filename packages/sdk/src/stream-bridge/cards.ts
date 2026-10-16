/**
 * Adapters from the Cards HTTP client and its domain events to the session
 * controller's injected interfaces, shared by both private hosts.
 * @summary Cards client and domain event session adapters
 * @module stream-bridge/cards
 */

import { ApiError } from '../client/types/errors.js';
import type { DomainEvent } from '../protocol/types/events.js';
import type { StreamMeta, StreamSourceBinding, StreamSourceSnapshot } from '../protocol/types/stream.js';
import {
  type SessionClient,
  type SessionControllerEvent,
  SessionSourceError,
  type SessionSourceFailure
} from '../stream-session/index.js';
import { TAIL_HISTORY_LINES } from '../stream-store/types.js';

/** The subset of the Cards client a session needs. */
export interface CardsStreamClient {
  /** Lists stream metadata for a card. */
  listStreams(cardId: string): Promise<StreamMeta[]>;
  /** Reads one coherent source snapshot, optionally only its trailing lines. */
  getStream(cardId: string, streamType: string, relPath: string, tail?: number): Promise<StreamSourceSnapshot>;
}

/**
 * Server error codes with a session meaning. Incoherent and unavailable reads
 * are transient under churn and retried by the controller; a missing source or
 * an unbound sidecar waits for a new live event or refresh.
 */
const FAILURES: Readonly<Record<string, SessionSourceFailure>> = {
  NOT_FOUND: 'not-found',
  VALIDATION_ERROR: 'rejected-scope',
  STREAM_SOURCE_UNBOUND: 'rejected-scope',
  STREAM_SOURCE_INCOHERENT: 'inconsistent-source',
  STREAM_SOURCE_UNAVAILABLE: 'load-error'
};

/**
 * Classifies a read rejection without exposing its message.
 * @param error - Rejection from the HTTP client.
 * @returns Identifier-only failure category; unrecognized failures are `load-error`.
 */
function classify(error: unknown): SessionSourceFailure {
  if (error instanceof ApiError && Object.hasOwn(FAILURES, error.code)) return FAILURES[error.code] ?? 'load-error';
  return 'load-error';
}

/**
 * Adapts a Cards client to the session controller. Tail reads request
 * {@link TAIL_HISTORY_LINES} trailing lines; full reads omit the tail. The
 * client cannot abort, so the controller's fencing suppresses stale results.
 * @param client - Authenticated Cards client.
 * @returns Session client whose read failures are classified {@link SessionSourceError}s.
 */
export function createCardsSessionClient(client: CardsStreamClient): SessionClient {
  return {
    listStreams: (cardId) => client.listStreams(cardId),
    async getStream(source, mode) {
      try {
        return await client.getStream(
          source.cardId,
          source.streamType,
          source.relPath,
          mode === 'tail' ? TAIL_HISTORY_LINES : undefined
        );
      } catch (error) {
        throw new SessionSourceError(classify(error));
      }
    }
  };
}

/**
 * Copies a binding without materializing an absent agent identity.
 * @param binding - Event binding.
 * @returns Exact-shape copy.
 */
function copyBinding(binding: StreamSourceBinding): StreamSourceBinding {
  return {
    sessionId: binding.sessionId,
    role: binding.role,
    ...(binding.agentId === undefined ? {} : { agentId: binding.agentId })
  };
}

/**
 * Maps a server domain event onto a session controller event. Stream events
 * keep their server version and binding, card commits trigger membership
 * refresh, and every other event is irrelevant to sessions.
 * @param event - Domain event from the server event stream.
 * @returns Controller event, or null when the event does not concern sessions.
 */
export function sessionEventFromDomainEvent(event: DomainEvent): SessionControllerEvent | null {
  switch (event.type) {
    case 'stream:line':
      return {
        type: 'append',
        source: { cardId: event.cardId, streamType: event.streamType, relPath: event.relPath },
        version: { ...event.version },
        binding: copyBinding(event.binding),
        lineNumber: event.lineNumber,
        line: event.line
      };
    case 'stream:started':
    case 'stream:resumed':
      return {
        type: event.type === 'stream:started' ? 'started' : 'resumed',
        source: { cardId: event.cardId, streamType: event.meta.streamType, relPath: event.meta.relPath },
        version: { ...event.version },
        binding: copyBinding(event.binding),
        totalLineCount: event.meta.lineCount
      };
    case 'stream:ended':
      return {
        type: 'ended',
        source: { cardId: event.cardId, streamType: event.streamType, relPath: event.relPath },
        version: { ...event.version },
        binding: copyBinding(event.binding),
        totalLineCount: event.lineCount
      };
    case 'stream:invalidated':
      return {
        type: 'invalidated',
        source: { cardId: event.cardId, streamType: event.streamType, relPath: event.relPath },
        version: { ...event.version },
        binding: copyBinding(event.binding),
        reason: event.reason
      };
    case 'card:commit':
      return { type: 'refresh', cardId: event.cardId, reason: 'commit' };
    default:
      return null;
  }
}

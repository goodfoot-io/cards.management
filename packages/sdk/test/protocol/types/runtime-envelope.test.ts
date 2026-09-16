import { describe, expect, it } from 'vitest';
import { EnvelopeValidationError, parseEnvelope } from '../../../src/protocol/types/runtime-envelope.js';
import { MAX_CONTROL_FRAME_BYTES, RUNTIME_MESSAGE_TYPES } from '../../../src/protocol/types/runtime-messages.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  UnsupportedProtocolVersionError
} from '../../../src/protocol/types/runtime-version.js';

/**
 * Exercises inbound frame validation in the types area through focused scenarios.
 * The cases pin the version gate ahead of every other check, so a peer speaking a protocol this
 * build does not implement is refused before any of its fields are interpreted, and they pin each
 * rejection to a closed-set reason a caller can branch on without matching message text.
 *
 * @summary Tests envelope parsing and rejection classification in types
 */

const validFrame = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  messageId: 'msg-1',
  sentAt: '2026-01-01T00:00:00.000Z',
  execution: { executionId: 'exec-1', launchRequestId: 'launch-1' },
  scope: { repositoryId: 'github.com/org/repo', workspacePath: '/w', cardId: 'main-1' },
  producer: { producerId: 'wrapper-1', role: 'runtime-wrapper' },
  ownership: { ownerId: 'server-a', generation: 1 },
  type: 'runtime.heartbeat',
  payload: { sentAt: '2026-01-01T00:00:00.000Z' },
  ...overrides
});

const rejectionReason = (frame: unknown): string => {
  try {
    parseEnvelope(frame);
  } catch (error) {
    if (error instanceof EnvelopeValidationError) {
      return error.reason;
    }
    return error instanceof Error ? error.name : 'unknown';
  }
  return 'accepted';
};

describe('parseEnvelope', () => {
  it('accepts a well-formed frame and returns it typed', () => {
    const envelope = parseEnvelope(validFrame());
    expect(envelope.type).toBe('runtime.heartbeat');
    expect(envelope.messageId).toBe('msg-1');
    expect(envelope.protocolVersion).toBe(RUNTIME_PROTOCOL_VERSION);
  });

  it('rejects an unsupported version before interpreting anything else', () => {
    const frame = validFrame({ protocolVersion: RUNTIME_PROTOCOL_VERSION + 1, type: 'not.a.message', payload: null });
    expect(() => parseEnvelope(frame)).toThrow(UnsupportedProtocolVersionError);
  });

  it('rejects a frame that is not a JSON object', () => {
    expect(rejectionReason('a string')).toBe('malformed-frame');
    expect(rejectionReason(null)).toBe('malformed-frame');
    expect(rejectionReason([])).toBe('malformed-frame');
  });

  it('rejects a message type that has no contract', () => {
    expect(rejectionReason(validFrame({ type: 'execution.somethingInvented' }))).toBe('unknown-message-type');
  });

  it('rejects a payload the registered schema refuses', () => {
    expect(rejectionReason(validFrame({ payload: { sentAt: 42 } }))).toBe('invalid-payload');
  });

  it('rejects a header missing a required field', () => {
    const frame = validFrame();
    delete frame['messageId'];
    expect(rejectionReason(frame)).toBe('malformed-frame');
  });

  it('rejects unknown header fields rather than ignoring them', () => {
    expect(rejectionReason(validFrame({ smuggled: true }))).toBe('malformed-frame');
  });

  it('names the message type on a payload rejection for diagnosis', () => {
    try {
      parseEnvelope(validFrame({ payload: { sentAt: 42 } }));
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeValidationError);
      expect((error as EnvelopeValidationError).messageType).toBe('runtime.heartbeat');
    }
  });

  it('registers a payload schema for every message type in the catalogue', () => {
    expect(RUNTIME_MESSAGE_TYPES.length).toBeGreaterThan(0);
    expect(MAX_CONTROL_FRAME_BYTES).toBeGreaterThan(0);
  });

  it('requires platform-session binding on strict-idle shutdown readiness', () => {
    const frame = validFrame({
      type: 'execution.shutdownReadiness',
      producer: { producerId: 'hook-1', role: 'agent-hook' },
      payload: {
        shutdownRequestId: 'shutdown-1',
        workRevision: 3,
        observedIdleAt: '2026-01-01T00:00:00.000Z'
      }
    });
    expect(rejectionReason(frame)).toBe('invalid-payload');
    (frame['payload'] as Record<string, unknown>)['platformSessionId'] = 'session-1';
    expect(rejectionReason(frame)).toBe('accepted');
  });

  it('requires terminal-decision correlation on a cleanup result', () => {
    const frame = validFrame({
      type: 'execution.cleanupResult',
      causationId: 'command-1',
      payload: { observationId: 'obs-1', trigger: 'command', status: 'drained', finalization: 'complete' }
    });
    expect(rejectionReason(frame)).toBe('invalid-payload');
    (frame['payload'] as Record<string, unknown>)['terminalDecisionId'] = 'terminal:execution-1';
    expect(rejectionReason(frame)).toBe('accepted');
  });

  it('keeps every caller-selected launch parameter in the immutable payload', () => {
    const frame = validFrame({
      type: 'execution.launchRequest',
      producer: { producerId: 'dispatcher-1', role: 'extension-dispatcher' },
      payload: {
        actionId: 'launch',
        environmentName: 'default',
        mode: 'background',
        exitWhenDone: true,
        selectedAgent: 'antigravity-cli',
        model: 'gemini-3-pro',
        effort: 'high',
        variableGroupIds: ['secrets', 'deployment']
      }
    });
    expect(parseEnvelope(frame).payload).toEqual(frame['payload']);
  });

  it('keeps the complete admitted launch contract in an execution request', () => {
    const frame = validFrame({
      type: 'execution.executeRequest',
      producer: { producerId: 'server-1', role: 'server' },
      payload: {
        actionId: 'launch',
        environmentName: 'default',
        mode: 'interactive',
        exitWhenDone: false,
        selectedAgent: 'claude-code-cli',
        model: 'deepseek-chat',
        effort: 'high',
        variableGroupIds: ['deepseek'],
        continuation: '{"session":"next"}'
      }
    });
    expect(parseEnvelope(frame).payload).toEqual(frame['payload']);
  });

  it('defines interactive switching as a request distinct from the continuation result', () => {
    expect(
      parseEnvelope(
        validFrame({
          type: 'execution.switchToInteractiveRequest',
          producer: { producerId: 'dispatcher-1', role: 'extension-dispatcher' },
          payload: {}
        })
      ).type
    ).toBe('execution.switchToInteractiveRequest');
    expect(
      rejectionReason(validFrame({ type: 'execution.switchToInteractiveRequest', payload: { continuation: {} } }))
    ).toBe('invalid-payload');
  });
});

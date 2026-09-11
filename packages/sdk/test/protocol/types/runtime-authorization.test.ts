import { describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '../../../src/protocol/types/runtime-authorization.js';
import {
  authorizeMessage,
  deliveryClassFor,
  RUNTIME_MESSAGE_CONTRACTS
} from '../../../src/protocol/types/runtime-authorization.js';
import { DELIVERY_CLASS_POLICIES } from '../../../src/protocol/types/runtime-delivery.js';
import type { RuntimeEnvelope } from '../../../src/protocol/types/runtime-envelope.js';
import { MAX_CONTROL_FRAME_BYTES, RUNTIME_MESSAGE_TYPES } from '../../../src/protocol/types/runtime-messages.js';
import { RUNTIME_PROTOCOL_VERSION } from '../../../src/protocol/types/runtime-version.js';

/**
 * Exercises the per-message authorization table in the types area through focused scenarios.
 * The cases check the envelope's claims against what authentication and admission independently
 * established, so a peer cannot widen its own permissions by asserting a role, a scope, or an
 * ownership generation it was not granted.
 *
 * @summary Tests per-message authorization and refusal classification in types
 */

const scope = { repositoryId: 'github.com/org/repo', workspacePath: '/w', cardId: 'main-1' };

const envelopeOf = (overrides: Partial<RuntimeEnvelope> = {}): RuntimeEnvelope =>
  ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    messageId: 'msg-1',
    sentAt: '2026-01-01T00:00:00.000Z',
    execution: { executionId: 'exec-1', launchRequestId: 'launch-1' },
    scope,
    producer: { producerId: 'wrapper-1', role: 'runtime-wrapper' },
    ownership: { ownerId: 'server-a', generation: 2 },
    type: 'runtime.register',
    payload: {},
    ...overrides
  }) as RuntimeEnvelope;

const contextOf = (overrides: Partial<AuthorizationContext> = {}): AuthorizationContext => ({
  authenticatedRole: 'runtime-wrapper',
  authenticatedProducerId: 'wrapper-1',
  peerDirection: 'client-to-server',
  admittedScope: scope,
  currentOwnership: { ownerId: 'server-a', generation: 2 },
  executionAdmitted: true,
  frameBytes: 512,
  ...overrides
});

const refusal = (envelope: RuntimeEnvelope, context: AuthorizationContext): string => {
  const outcome = authorizeMessage(envelope, context);
  return outcome.authorized ? 'authorized' : outcome.reason;
};

describe('authorization table integrity', () => {
  it('covers every message type in the catalogue exactly once', () => {
    expect(Object.keys(RUNTIME_MESSAGE_CONTRACTS).sort()).toEqual([...RUNTIME_MESSAGE_TYPES].sort());
  });

  it('declares each contract under its own key', () => {
    for (const [type, contract] of Object.entries(RUNTIME_MESSAGE_CONTRACTS)) {
      expect(contract.type).toBe(type);
      expect(contract.maxFrameBytes).toBeGreaterThan(0);
      expect(contract.allowedRoles.length).toBeGreaterThan(0);
      expect(deliveryClassFor(contract.type)).toBe(contract.deliveryClass);
    }
  });

  it('never lets a card-scoped message carry an execution requirement it cannot meet', () => {
    for (const contract of Object.values(RUNTIME_MESSAGE_CONTRACTS)) {
      expect(['admitted', 'pre-admission', 'authenticated-subject', 'none']).toContain(contract.executionRequirement);
    }
  });
});

describe('authorizeMessage', () => {
  it('permits only the extension dispatcher to request an interactive switch', () => {
    const envelope = envelopeOf({
      type: 'execution.switchToInteractiveRequest',
      requestId: 'switch-1',
      payload: {},
      producer: { producerId: 'dispatcher-1', role: 'extension-dispatcher' }
    });
    expect(
      refusal(
        envelope,
        contextOf({ authenticatedRole: 'extension-dispatcher', authenticatedProducerId: 'dispatcher-1' })
      )
    ).toBe('authorized');
    expect(
      refusal(
        envelopeOf({ type: 'execution.switchToInteractiveRequest', requestId: 'switch-1', payload: {} }),
        contextOf()
      )
    ).toBe('role-not-permitted');
  });

  it('authorizes a message that satisfies every rule and returns its contract', () => {
    const outcome = authorizeMessage(envelopeOf(), contextOf());
    expect(outcome.authorized).toBe(true);
    if (outcome.authorized) {
      expect(outcome.contract.type).toBe('runtime.register');
    }
  });

  it('refuses a frame larger than the type permits', () => {
    expect(refusal(envelopeOf(), contextOf({ frameBytes: MAX_CONTROL_FRAME_BYTES + 1 }))).toBe('frame-too-large');
  });

  it('refuses a message travelling against its declared direction', () => {
    expect(refusal(envelopeOf(), contextOf({ peerDirection: 'server-to-client' }))).toBe('wrong-direction');
  });

  it('refuses an envelope claiming a role authentication did not grant', () => {
    const envelope = envelopeOf({ producer: { producerId: 'wrapper-1', role: 'server' } });
    expect(refusal(envelope, contextOf())).toBe('role-impersonation');
  });

  it('refuses an envelope claiming another producer identity', () => {
    const envelope = envelopeOf({ producer: { producerId: 'someone-else', role: 'runtime-wrapper' } });
    expect(refusal(envelope, contextOf())).toBe('role-impersonation');
  });

  it('refuses an authenticated role the message type does not permit', () => {
    const envelope = envelopeOf({
      type: 'execution.agentTermination',
      producer: { producerId: 'watcher-1', role: 'watcher' }
    });
    const context = contextOf({ authenticatedRole: 'watcher', authenticatedProducerId: 'watcher-1' });
    expect(refusal(envelope, context)).toBe('role-not-permitted');
  });

  it('refuses a message whose scope differs from the one bound at admission', () => {
    const envelope = envelopeOf({ scope: { ...scope, cardId: 'main-999' } });
    expect(refusal(envelope, contextOf())).toBe('scope-mismatch');
  });

  it('refuses a message for an execution that has not passed admission', () => {
    expect(refusal(envelopeOf({ type: 'execution.agentTermination' }), contextOf({ executionAdmitted: false }))).toBe(
      'execution-not-admitted'
    );
  });

  it('refuses a message requiring an admitted execution that names none', () => {
    const envelope = envelopeOf({
      type: 'execution.agentTermination',
      execution: { executionId: null, launchRequestId: 'launch-1' }
    });
    expect(refusal(envelope, contextOf())).toBe('execution-not-admitted');
  });

  it('refuses a stale ownership generation', () => {
    const envelope = envelopeOf({ ownership: { ownerId: 'server-a', generation: 1 } });
    expect(refusal(envelope, contextOf())).toBe('ownership-stale');
  });

  it('refuses two owners claiming the same generation rather than picking one', () => {
    const envelope = envelopeOf({ ownership: { ownerId: 'server-b', generation: 2 } });
    expect(refusal(envelope, contextOf())).toBe('ownership-conflict');
  });

  it('accepts a newer ownership generation from a different owner as a legitimate takeover', () => {
    const envelope = envelopeOf({ ownership: { ownerId: 'server-b', generation: 3 } });
    expect(refusal(envelope, contextOf())).toBe('authorized');
  });
});

describe('acknowledgment messages', () => {
  it('treats command custody as a durable client receipt bound to current ownership', () => {
    const contract = RUNTIME_MESSAGE_CONTRACTS['execution.commandCustody'];
    expect(contract).toMatchObject({
      direction: 'client-to-server',
      deliveryClass: 'durable-result',
      requiresCausationId: true,
      requiresOwnershipCurrent: true
    });
    expect(contract.allowedRoles).not.toContain('server');
  });

  it('lets only the server acknowledge, so a peer cannot forge a receipt', () => {
    for (const type of ['runtime.resumeAck', 'runtime.accepted'] as const) {
      expect(RUNTIME_MESSAGE_CONTRACTS[type].allowedRoles).toEqual(['server']);
      expect(RUNTIME_MESSAGE_CONTRACTS[type].direction).toBe('server-to-client');
    }
  });

  it('keeps both acknowledgments out of the completion-evidence classes', () => {
    for (const type of ['runtime.accepted', 'runtime.resumeAck'] as const) {
      expect(deliveryClassFor(type)).toBe('reconciled-snapshot');
      expect(DELIVERY_CLASS_POLICIES[deliveryClassFor(type)].completionEvidence).toBe(false);
    }
  });

  it('requires a causation id so a receipt names what it acknowledges', () => {
    expect(RUNTIME_MESSAGE_CONTRACTS['runtime.accepted'].requiresCausationId).toBe(true);
    expect(RUNTIME_MESSAGE_CONTRACTS['runtime.resumeAck'].requiresCausationId).toBe(true);
  });
});

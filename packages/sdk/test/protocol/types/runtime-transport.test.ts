/**
 * Checks for the transport contract's wire-parse boundary.
 *
 * These schemas exist because a client deserializes a registration outcome off a
 * socket it does not otherwise trust. The assertions therefore concentrate on
 * the shapes that would be dangerous to accept rather than merely wrong: a
 * refusal that could be read as a registration, and a generation that could be
 * compared against a real one and yield a confident wrong answer.
 *
 * @summary Registration outcomes, generations, and slot keys parse fail-closed
 * @module test/protocol/types/runtime-transport
 */

import { describe, expect, it } from 'vitest';
import {
  connectionGenerationSchema,
  connectionSlotKeySchema,
  FRAME_REFUSAL_REASONS,
  frameRefusalReasonSchema,
  REGISTRATION_REFUSAL_REASONS,
  registrationOutcomeSchema
} from '../../../src/protocol/index.js';

describe('registrationOutcomeSchema', () => {
  it('parses a first registration, which fences nothing', () => {
    const parsed = registrationOutcomeSchema.parse({
      status: 'registered',
      generation: 1,
      fencedGeneration: null
    });
    expect(parsed).toEqual({ status: 'registered', generation: 1, fencedGeneration: null });
  });

  it('parses a reconnect that fenced the producer’s own prior generation', () => {
    const parsed = registrationOutcomeSchema.parse({
      status: 'registered',
      generation: 4,
      fencedGeneration: 3
    });
    expect(parsed).toEqual({ status: 'registered', generation: 4, fencedGeneration: 3 });
  });

  it('parses every refusal reason the registry can return', () => {
    for (const reason of REGISTRATION_REFUSAL_REASONS) {
      expect(registrationOutcomeSchema.parse({ status: 'refused', reason })).toEqual({
        status: 'refused',
        reason
      });
    }
  });

  it('refuses a registration missing its generation', () => {
    // The shape that would let a client believe it holds a slot without knowing
    // which generation it holds it at, and so acknowledge another's work.
    expect(registrationOutcomeSchema.safeParse({ status: 'registered', fencedGeneration: null }).success).toBe(false);
  });

  it('refuses a refusal carrying an unknown reason', () => {
    expect(registrationOutcomeSchema.safeParse({ status: 'refused', reason: 'vibes' }).success).toBe(false);
  });

  it('refuses an outcome with no recognizable status', () => {
    expect(registrationOutcomeSchema.safeParse({ status: 'maybe', generation: 1 }).success).toBe(false);
  });

  it('refuses extra fields rather than narrowing them away', () => {
    // A field this end does not know about means the two ends disagree about
    // what an outcome is; silently dropping it resolves that in the sender's
    // favour.
    expect(
      registrationOutcomeSchema.safeParse({
        status: 'refused',
        reason: 'stale-generation',
        retryAfterMs: 500
      }).success
    ).toBe(false);
  });
});

describe('connectionGenerationSchema', () => {
  it('accepts the initial generation', () => {
    expect(connectionGenerationSchema.parse(0)).toBe(0);
  });

  it('refuses a negative generation', () => {
    expect(connectionGenerationSchema.safeParse(-1).success).toBe(false);
  });

  it('refuses a fractional generation', () => {
    // A fraction cannot have been allocated by the registry, and comparing one
    // against a real generation yields a confident wrong answer about currency.
    expect(connectionGenerationSchema.safeParse(2.5).success).toBe(false);
  });

  it('refuses a numeric string', () => {
    expect(connectionGenerationSchema.safeParse('3').success).toBe(false);
  });
});

describe('connectionSlotKeySchema', () => {
  it('parses an execution-scoped slot', () => {
    const slot = {
      subject: { kind: 'execution', executionId: 'e-1' },
      role: 'runtime-wrapper',
      producerId: 'p-1'
    };
    expect(connectionSlotKeySchema.parse(slot)).toEqual(slot);
  });

  it('parses a card-scoped slot', () => {
    const slot = { subject: { kind: 'card', cardId: 'main-1' }, role: 'watcher', producerId: 'w-1' };
    expect(connectionSlotKeySchema.parse(slot)).toEqual(slot);
  });

  it('refuses a subject mixing both kinds of identifier', () => {
    expect(
      connectionSlotKeySchema.safeParse({
        subject: { kind: 'execution', executionId: 'e-1', cardId: 'main-1' },
        role: 'watcher',
        producerId: 'w-1'
      }).success
    ).toBe(false);
  });

  it('refuses an empty producer ID', () => {
    // Producer ID is half the slot key; an empty one would collapse every
    // producer sharing a role into one slot, evicting each other on connect.
    expect(
      connectionSlotKeySchema.safeParse({
        subject: { kind: 'card', cardId: 'main-1' },
        role: 'watcher',
        producerId: ''
      }).success
    ).toBe(false);
  });
});

describe('frameRefusalReasonSchema', () => {
  it('parses every reason the transport can return', () => {
    for (const reason of FRAME_REFUSAL_REASONS) {
      expect(frameRefusalReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it('refuses an unknown reason', () => {
    expect(frameRefusalReasonSchema.safeParse('too-spicy').success).toBe(false);
  });
});

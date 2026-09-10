import { describe, expect, it } from 'vitest';
import {
  assertSupportedProtocolVersion,
  protocolVersionSchema,
  RUNTIME_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsupportedProtocolVersionError
} from '../../../src/protocol/types/runtime-version.js';

/**
 * Exercises the runtime protocol version gate in the types area through focused scenarios.
 * The cases pin the decision to reject unsupported versions outright rather than negotiate a
 * legacy one, so a peer running a different build is refused at the handshake instead of
 * silently interoperating on a shape neither side fully implements.
 *
 * @summary Tests runtime protocol version rejection in types
 */

describe('runtime protocol version', () => {
  it('declares exactly the versions this build implements', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(RUNTIME_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toHaveLength(1);
  });

  it('accepts the version this build speaks', () => {
    expect(() => assertSupportedProtocolVersion(RUNTIME_PROTOCOL_VERSION)).not.toThrow();
  });

  it('rejects an older version instead of negotiating down to it', () => {
    expect(() => assertSupportedProtocolVersion(RUNTIME_PROTOCOL_VERSION - 1)).toThrow(UnsupportedProtocolVersionError);
  });

  it('rejects a newer version instead of optimistically accepting it', () => {
    expect(() => assertSupportedProtocolVersion(RUNTIME_PROTOCOL_VERSION + 1)).toThrow(UnsupportedProtocolVersionError);
  });

  it('names both the offered and the supported versions on rejection', () => {
    let caught: unknown;
    try {
      assertSupportedProtocolVersion(99);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedProtocolVersionError);
    const rejection = caught as UnsupportedProtocolVersionError;
    expect(rejection.received).toBe(99);
    expect(rejection.supported).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    expect(rejection.message).toContain('99');
  });

  it('rejects non-integer and non-numeric version values', () => {
    for (const value of [1.5, '1', null, undefined, {}, [], Number.NaN]) {
      expect(() => assertSupportedProtocolVersion(value)).toThrow(UnsupportedProtocolVersionError);
    }
  });

  it('narrows the value to a number once the assertion passes', () => {
    const received: unknown = RUNTIME_PROTOCOL_VERSION;
    assertSupportedProtocolVersion(received);
    expect(received.toFixed(0)).toBe(String(RUNTIME_PROTOCOL_VERSION));
  });

  it('rejects unsupported versions through the schema as well as the assertion', () => {
    expect(protocolVersionSchema.safeParse(RUNTIME_PROTOCOL_VERSION).success).toBe(true);
    expect(protocolVersionSchema.safeParse(RUNTIME_PROTOCOL_VERSION + 1).success).toBe(false);
    expect(protocolVersionSchema.safeParse('1').success).toBe(false);
  });
});

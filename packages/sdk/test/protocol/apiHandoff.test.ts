/**
 * Pins fail-closed API identity validation independently of platform or network.
 *
 * @summary API handoff identity and compatibility tests
 */
import { describe, expect, it } from 'vitest';
import {
  apiServerIdentityEquals,
  CURRENT_API_PROTOCOL_VERSION,
  classifyProtocol,
  isApiServerIdentity
} from '../../src/protocol/types/apiHandoff.js';

const identity = {
  serverInstanceId: 'server-0123456789',
  ownerEpoch: 1,
  protocolVersion: CURRENT_API_PROTOCOL_VERSION,
  buildTime: 1789670000000
};

describe('API handoff identity', () => {
  it('accepts a complete identity, including an unbuilt zero timestamp', () => {
    expect(isApiServerIdentity(identity)).toBe(true);
    expect(isApiServerIdentity({ ...identity, buildTime: 0 })).toBe(true);
  });

  it('refuses missing, partial, and malformed descriptors', () => {
    for (const value of [undefined, null, [], {}, 'server', { buildTime: identity.buildTime }]) {
      expect(isApiServerIdentity(value)).toBe(false);
    }
    for (const field of Object.keys(identity)) {
      expect(isApiServerIdentity({ ...identity, [field]: undefined })).toBe(false);
    }
    for (const serverInstanceId of ['', 'contains whitespace', '\n', 'a'.repeat(201), 7]) {
      expect(isApiServerIdentity({ ...identity, serverInstanceId })).toBe(false);
    }
  });

  it('rejects unsafe, non-integer, zero and negative epochs or protocol versions', () => {
    for (const value of [0, -1, 1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(isApiServerIdentity({ ...identity, ownerEpoch: value })).toBe(false);
      expect(isApiServerIdentity({ ...identity, protocolVersion: value })).toBe(false);
    }
    for (const buildTime of [-1, 1.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isApiServerIdentity({ ...identity, buildTime })).toBe(false);
    }
  });

  it('compares epoch, instance, protocol, and build as separate identity fields', () => {
    expect(apiServerIdentityEquals(identity, { ...identity })).toBe(true);
    expect(apiServerIdentityEquals(undefined, undefined)).toBe(false);
    expect(apiServerIdentityEquals(identity, undefined)).toBe(false);
    expect(apiServerIdentityEquals(identity, { ...identity, serverInstanceId: 'other' })).toBe(false);
    for (const field of ['ownerEpoch', 'protocolVersion', 'buildTime'] as const) {
      expect(apiServerIdentityEquals(identity, { ...identity, [field]: identity[field] + 1 })).toBe(false);
    }
  });

  it('does not infer compatibility from a newer version', () => {
    expect(classifyProtocol(CURRENT_API_PROTOCOL_VERSION)).toEqual({ kind: 'compatible' });
    expect(classifyProtocol(CURRENT_API_PROTOCOL_VERSION + 1)).toEqual({
      kind: 'reload-required',
      expected: CURRENT_API_PROTOCOL_VERSION,
      actual: CURRENT_API_PROTOCOL_VERSION + 1
    });
  });
});

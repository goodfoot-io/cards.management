import { describe, expect, it } from 'vitest';
import { buildHandshakeRequest } from '../../../src/client/runtime/index.js';
import { RUNTIME_CREDENTIAL_HEADERS, RUNTIME_UPGRADE_PATH } from '../../../src/protocol/types/index.js';
import { makeCredential, makeTarget } from './index.js';

/**
 * Pins where credentials travel and where they must never travel.
 *
 * A secret in a query string is not merely inelegant — it is copied into access logs, proxy
 * traces, and crash reports by machinery nobody in this codebase controls, and it stays
 * there after the credential is revoked. The negative assertions below are the point of
 * this file; the positive ones just prove the request still works.
 *
 * @summary Tests upgrade URL and credential header construction
 */

describe('handshake request', () => {
  it('targets the runtime upgrade path on the discovered endpoint', () => {
    const request = buildHandshakeRequest(makeTarget({ host: '127.0.0.1', port: 4321 }), makeCredential());
    expect(request.url).toBe(`ws://127.0.0.1:4321${RUNTIME_UPGRADE_PATH}`);
  });

  it('carries the role credential in the three contract headers', () => {
    const request = buildHandshakeRequest(
      makeTarget(),
      makeCredential({ requestId: 'req-9', credentialId: 'cred-9', secret: 'shh' })
    );
    expect(request.headers[RUNTIME_CREDENTIAL_HEADERS.requestId]).toBe('req-9');
    expect(request.headers[RUNTIME_CREDENTIAL_HEADERS.credentialId]).toBe('cred-9');
    expect(request.headers[RUNTIME_CREDENTIAL_HEADERS.secret]).toBe('shh');
  });

  it('carries the rotatable access token separately from the role credential', () => {
    const request = buildHandshakeRequest(makeTarget({ accessToken: 'token-9' }), makeCredential());
    expect(request.headers['Authorization']).toBe('Bearer token-9');
  });

  it('puts no credential material in the URL at all', () => {
    const request = buildHandshakeRequest(makeTarget({ accessToken: 'token-9' }), makeCredential({ secret: 'shh' }));
    expect(request.url).not.toContain('shh');
    expect(request.url).not.toContain('token-9');
    expect(request.url).not.toContain('cred-1');
  });

  it('produces a URL with no query string whatsoever', () => {
    const request = buildHandshakeRequest(makeTarget(), makeCredential());
    expect(new URL(request.url).search).toBe('');
  });

  it('rebuilds against a rotated endpoint and token rather than a remembered one', () => {
    const credential = makeCredential();
    const first = buildHandshakeRequest(makeTarget({ port: 1111, accessToken: 'old' }), credential);
    const second = buildHandshakeRequest(makeTarget({ port: 2222, accessToken: 'new' }), credential);
    expect(first.url).not.toBe(second.url);
    expect(second.headers['Authorization']).toBe('Bearer new');
    expect(second.headers[RUNTIME_CREDENTIAL_HEADERS.credentialId]).toBe(
      first.headers[RUNTIME_CREDENTIAL_HEADERS.credentialId]
    );
  });
});

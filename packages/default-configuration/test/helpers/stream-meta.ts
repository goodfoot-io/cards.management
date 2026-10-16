/**
 * Complete sidecar metadata for renderer tests that only vary liveness, counts or identity.
 * @summary StreamMeta test factory
 * @module test/helpers/stream-meta
 */

import type { StreamMeta } from '@cards.management/sdk/protocol';

/**
 * Builds a complete main-role sidecar with the given overrides.
 * @param overrides - Fields under test.
 * @returns Complete metadata.
 */
export function streamMeta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return {
    version: 1,
    relPath: 'session.jsonl',
    streamType: 'claude-code-session',
    runtime: 'claude-code',
    sessionId: 'session',
    role: 'main',
    sourcePath: 'session.jsonl',
    startedAt: '2026-01-01T00:00:00.000Z',
    lineCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    isActive: false,
    ...overrides
  };
}

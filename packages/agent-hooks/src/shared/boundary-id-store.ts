/**
 * Owner-protected persistence for retry-stable platform boundary identities.
 * @summary Durable platform boundary identity store
 * @module boundary-id-store
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import type { StableBoundaryIdStore } from './work-authority.js';

/** Default maximum number of live boundary identities retained. */
export const DEFAULT_BOUNDARY_ID_LIMIT = 10_000;

function assertOwnerOnlyDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const status = lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`Boundary identity root is unsafe: ${root}`);
  if (process.platform !== 'win32') {
    if ((status.mode & 0o077) !== 0) throw new Error(`Boundary identity root is not owner-only: ${root}`);
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
      throw new Error(`Boundary identity root has the wrong owner: ${root}`);
    }
  }
}

function readRecord(path: string, key: string): { messageId: string; requestId: string } {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Boundary identity record is unsafe: ${path}`);
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
    throw new Error(`Boundary identity record is not owner-only: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Boundary identity record is corrupt: ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (record['key'] !== key || typeof record['messageId'] !== 'string' || typeof record['requestId'] !== 'string') {
    throw new Error(`Boundary identity record is corrupt: ${path}`);
  }
  return { messageId: record['messageId'], requestId: record['requestId'] };
}

/**
 * Creates a bounded, non-evicting boundary identity store.
 * @param root - Owner-only directory containing durable records.
 * @param limit - Maximum live records; exhaustion rejects rather than evicts.
 * @returns Stable boundary identity store.
 * @throws When the root is unsafe, unavailable, corrupt, or exhausted.
 */
export function createFileBoundaryIdStore(root: string, limit = DEFAULT_BOUNDARY_ID_LIMIT): StableBoundaryIdStore {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Boundary identity limit must be positive');
  assertOwnerOnlyDirectory(root);
  return {
    async getOrCreate(input) {
      assertOwnerOnlyDirectory(root);
      const key = JSON.stringify([input.platformSessionId, input.hostBoundaryId]);
      const name = `${createHash('sha256').update(key).digest('hex')}.json`;
      const path = `${root}/${name}`;
      try {
        return readRecord(path, key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (readdirSync(root).filter((entry) => entry.endsWith('.json')).length >= limit) {
        throw new Error('Boundary identity store capacity exhausted');
      }
      const identity = { messageId: randomUUID(), requestId: randomUUID() };
      let descriptor: number;
      try {
        descriptor = openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readRecord(path, key);
        throw error;
      }
      try {
        writeFileSync(descriptor, `${JSON.stringify({ key, ...identity })}\n`, 'utf8');
        fsyncSync(descriptor);
        if (process.platform !== 'win32' && (fstatSync(descriptor).mode & 0o077) !== 0) {
          throw new Error(`Boundary identity record is not owner-only: ${path}`);
        }
      } finally {
        closeSync(descriptor);
      }
      return identity;
    }
  };
}

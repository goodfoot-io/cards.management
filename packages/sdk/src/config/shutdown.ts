/**
 * Durable handoff between the `cards shutdown` subprocess and a later Codex
 * Stop hook.
 *
 * @summary Pending Codex shutdown request storage and readiness delivery
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';

/** Versioned pending request persisted for a Codex session. */
export interface PendingShutdownRequest {
  version: 1;
  requestId: string;
  messageId: string;
  outcome: 'success' | 'blocked' | 'error';
  message?: string;
}

/** Readiness message sent back to the action dispatcher after strict drain. */
export interface ShutdownReadyMessage {
  type: 'shutdownReady';
  requestId: string;
}

function pendingShutdownPath(sessionId: string): string {
  return join(
    resolveGlobalCardsConfigDir(),
    'card-repo-commits',
    `${encodeURIComponent(sessionId)}.shutdown-request.json`
  );
}

function journalPath(): string {
  return join(resolveGlobalCardsConfigDir(), 'card-repo-commits', 'shutdown-requests.ndjson');
}

/**
 * Append one lifecycle record to the durable shutdown-request journal.
 *
 * The marker file itself is intentionally consumed by a later Stop hook, so
 * presence/absence at inspection time is not evidence. The journal is what
 * makes the marker's lifecycle — created, cleared, and by which request
 * identity — traceable after the fact.
 *
 * @param event - Lifecycle transition being recorded.
 * @param sessionId - Session the pending request belongs to.
 * @param request - The correlated request identity and parameters.
 */
function appendShutdownJournal(event: 'created' | 'cleared', sessionId: string, request: PendingShutdownRequest): void {
  const record = {
    at: new Date().toISOString(),
    event,
    sessionId,
    requestId: request.requestId,
    messageId: request.messageId
  };
  mkdirSync(join(resolveGlobalCardsConfigDir(), 'card-repo-commits'), { recursive: true, mode: 0o700 });
  appendFileSync(journalPath(), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Atomically persist the request that a later Stop hook must acknowledge.
 *
 * @param sessionId - Codex session that will receive a later Stop event.
 * @param request - Versioned correlated request with stable identities only.
 */
export function writePendingShutdownRequest(sessionId: string, request: PendingShutdownRequest): void {
  const destination = pendingShutdownPath(sessionId);
  mkdirSync(join(resolveGlobalCardsConfigDir(), 'card-repo-commits'), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(request)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, destination);
  appendShutdownJournal('created', sessionId, request);
}

/**
 * Read and validate the pending request for a session.
 *
 * @param sessionId - Codex session to inspect.
 * @returns The pending request, or undefined when none exists.
 * @throws When storage cannot be read or contains an invalid record.
 */
export function readPendingShutdownRequest(sessionId: string): PendingShutdownRequest | undefined {
  let raw: string;
  try {
    raw = readFileSync(pendingShutdownPath(sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as Partial<PendingShutdownRequest>;
  if (
    value.version !== 1 ||
    typeof value.requestId !== 'string' ||
    typeof value.messageId !== 'string' ||
    !['success', 'blocked', 'error'].includes(String(value.outcome)) ||
    (value.message !== undefined && typeof value.message !== 'string')
  ) {
    throw new Error(`Invalid pending shutdown request for session ${sessionId}`);
  }
  return value as PendingShutdownRequest;
}

/**
 * Remove a request only when it still has the acknowledged opaque ID.
 *
 * @param sessionId - Codex session whose request was acknowledged.
 * @param requestId - Opaque ID that must still own the marker.
 */
export function clearPendingShutdownRequest(sessionId: string, requestId: string): void {
  const pending = readPendingShutdownRequest(sessionId);
  if (pending?.requestId === requestId) {
    rmSync(pendingShutdownPath(sessionId), { force: true });
    appendShutdownJournal('cleared', sessionId, pending);
  }
}

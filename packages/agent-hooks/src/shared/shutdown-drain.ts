/**
 * Shared shutdown drain-acknowledgement logic for Claude runtime hooks.
 *
 * Correlates a pending `cards shutdown` request against a strict, fail-closed
 * idle check (tracked subagents plus the launcher-owned process tree) and only
 * then submits current-revision readiness to the authenticated runtime
 * authority. Extracted so both the `Stop` hook
 * (`stop-shutdown-drain.ts`, fires after a turn completes) and the
 * `Notification(idle_prompt)` hook (`notification-shutdown-drain.ts`, fires
 * even before a session's first turn) can attempt the same drain without
 * duplicating the fail-open/fail-closed semantics.
 *
 * @summary Shared shutdown drain-acknowledgement logic for Claude runtime hooks
 * @module shutdown-drain
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk/cards-config';
import {
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential
} from '@cards.management/sdk/client/runtime/bootstrap';
import { createFileClientOutbox, resolveOutboxRoot } from '@cards.management/sdk/client/runtime/outbox-store';
import { clearPendingShutdownRequest, readPendingShutdownRequest } from '@cards.management/sdk/config';
import type { Logger } from '@goodfoot/agent-hooks/claude-code';
import { isSessionIdle } from './session-idle.js';

async function discoverRuntimeTarget(): Promise<{ host: string; port: number; accessToken: string } | null> {
  try {
    const raw = await readFile(
      process.env['CARDS_DISCOVERY_PATH'] ?? join(resolveGlobalCardsConfigDir(), 'cards-api.json'),
      'utf8'
    );
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value['host'] === 'string' &&
      typeof value['port'] === 'number' &&
      typeof value['accessToken'] === 'string'
      ? { host: value['host'], port: value['port'], accessToken: value['accessToken'] }
      : null;
  } catch {
    return null;
  }
}

/**
 * Delivers readiness for an already-proved idle session over authenticated runtime transport.
 * @param sessionId - Authenticated platform session that established idleness.
 * @param pendingRequest - Durable shutdown correlation and stable message identity.
 */
export async function deliverShutdownReadiness(
  sessionId: string,
  pendingRequest: NonNullable<ReturnType<typeof readPendingShutdownRequest>>
): Promise<void> {
  const info = await discoverRuntimeTarget();
  if (!info) throw new Error('runtime endpoint unavailable');
  const loaded = loadRuntimeCredential('agent-hook');
  const client = createRuntimeClientFromCredentialFile({
    role: 'agent-hook',
    capabilities: { switchToInteractive: false, agentShutdown: false, strictDrainBarrier: true },
    outbox: createFileClientOutbox({ root: resolveOutboxRoot(resolveGlobalCardsConfigDir()) }),
    discover: async () => ({ host: info.host, port: info.port, accessToken: info.accessToken }),
    onMessage: () => undefined
  });
  try {
    const connected = await client.connect();
    if (connected.status !== 'connected') throw new Error(`runtime connection ${connected.status}`);
    const readiness = await client.send({
      type: 'execution.shutdownReadiness',
      payload: {
        shutdownRequestId: pendingRequest.requestId,
        workRevision: connected.synchronization.workRevision,
        platformSessionId: sessionId,
        observedIdleAt: new Date().toISOString()
      },
      messageId: `${pendingRequest.messageId}:readiness`,
      requestId: pendingRequest.requestId,
      execution: loaded.execution,
      deadlineMs: 5_000
    });
    if (readiness.status !== 'accepted') throw new Error('readiness acceptance unconfirmed');
  } finally {
    await client.close();
  }
}

/**
 * Attempts to acknowledge a pending shutdown request for the given session.
 *
 * Fail-open on infra issues unrelated to idleness (missing/unreadable
 * pending-request marker, runtime readiness rejection); fail-closed on the
 * idle determination itself (never assumes idle on error).
 *
 * @param sessionId - The session to check and, if idle, drain.
 * @param logger - Hook logger for warn/error diagnostics on fail-open paths.
 * @param sourceLabel - Log-message prefix identifying the calling hook.
 */
export async function attemptShutdownDrain(sessionId: string, logger: Logger, sourceLabel: string): Promise<void> {
  let pendingRequest: ReturnType<typeof readPendingShutdownRequest>;
  try {
    pendingRequest = readPendingShutdownRequest(sessionId);
  } catch (error) {
    logger.warn(`${sourceLabel}: failed to read pending shutdown request`, {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!pendingRequest) {
    return;
  }

  let idle: boolean;
  try {
    idle = await isSessionIdle(sessionId, { strict: true });
  } catch (error) {
    logger.warn(`${sourceLabel}: strict idle authority failed`, {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!idle) {
    return;
  }

  try {
    await deliverShutdownReadiness(sessionId, pendingRequest);
    clearPendingShutdownRequest(sessionId, pendingRequest.requestId);
  } catch (error) {
    logger.warn(`${sourceLabel}: failed to acknowledge shutdown readiness`, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Durable runtime authority for platform work boundaries.
 *
 * Work admission and revision observation are deliberately separate. A real
 * turn or child-task boundary must call {@link admitWorkBoundary}; shutdown
 * readiness may call {@link observeWorkRevision} only after strict drain.
 *
 * @summary Durable runtime authority for platform work boundaries
 * @module work-authority
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk/cards-config';
import type { RuntimeClient } from '@cards.management/sdk/client/runtime';
import {
  createRuntimeClientFromCredentialFile,
  loadRuntimeCredential
} from '@cards.management/sdk/client/runtime/bootstrap';
import { createFileClientOutbox, resolveOutboxRoot } from '@cards.management/sdk/client/runtime/outbox-store';
import type { ExecutionRef, IssuedRoleCredential } from '@cards.management/sdk/protocol';
import { createFileBoundaryIdStore } from './boundary-id-store.js';

/** The only boundaries that may advance the server-owned work revision. */
export type WorkBoundaryCause = 'turn' | 'childTask';

/** Stable identity for one platform boundary. */
export interface WorkBoundary {
  readonly cause: WorkBoundaryCause;
  readonly messageId: string;
  readonly requestId: string;
}

/** Server-owned revision returned after durable admission. */
export interface AdmittedWorkBoundary {
  readonly workRevision: number;
}

/** Durable, platform-native identities for retry-safe boundary admission. */
export interface StableBoundaryIdStore {
  /** Returns the same identity when the same host boundary is retried. */
  getOrCreate(input: { readonly platformSessionId: string; readonly hostBoundaryId: string }): Promise<{
    readonly messageId: string;
    readonly requestId: string;
  }>;
}

/** Port consumed by platform handlers; tests inject a recorder through this seam. */
export interface WorkAuthority {
  /** Admits work and resolves only after durable server acceptance. */
  admit(boundary: WorkBoundary): Promise<AdmittedWorkBoundary>;
  /** Observes synchronization state without changing the work revision. */
  observeRevision(): Promise<number>;
}

/** Explicit protected inputs for constructing the production runtime adapter. */
export interface WorkAuthorityAdapterInput {
  readonly client: RuntimeClient;
  readonly credential: IssuedRoleCredential;
  readonly execution: ExecutionRef;
  readonly boundaryIds: StableBoundaryIdStore;
}

/** Inputs shared by shipped entries after protected credential loading. */
export interface ProtectedWorkAuthorityInput {
  readonly client: RuntimeClient;
  readonly loadedCredential: ReturnType<typeof loadRuntimeCredential>;
  readonly boundaryStoreRoot: string;
  readonly boundaryLimit?: number;
}

/**
 * Constructs the production authority from already-loaded protected inputs.
 * @param input - Authenticated client, protected credential, and owner-only store root.
 * @returns Production work authority.
 */
export function createProtectedWorkAuthority(input: ProtectedWorkAuthorityInput): WorkAuthority {
  return createWorkAuthorityAdapter({
    client: input.client,
    credential: input.loadedCredential.credential,
    execution: input.loadedCredential.execution,
    boundaryIds: createFileBoundaryIdStore(input.boundaryStoreRoot, input.boundaryLimit)
  });
}

/**
 * Constructs the production hook authority from protected runtime state.
 * @returns Credential-bound authority shared by shipped hook entrypoints.
 * @throws When discovery, credentials, or boundary storage are unavailable or unsafe.
 */
export function createHookWorkAuthority(): WorkAuthority {
  const configRoot = resolveGlobalCardsConfigDir();
  const discoveryPath = process.env['CARDS_DISCOVERY_PATH'] ?? join(configRoot, 'cards-api.json');
  const loadedCredential = loadRuntimeCredential('agent-hook');
  const client = createRuntimeClientFromCredentialFile({
    role: 'agent-hook',
    capabilities: { switchToInteractive: false, agentShutdown: false, strictDrainBarrier: true },
    outbox: createFileClientOutbox({ root: resolveOutboxRoot(configRoot) }),
    discover: async () => {
      const value = JSON.parse(readFileSync(discoveryPath, 'utf8')) as Record<string, unknown>;
      if (
        typeof value['host'] !== 'string' ||
        typeof value['port'] !== 'number' ||
        typeof value['accessToken'] !== 'string'
      ) {
        throw new Error('Runtime discovery is invalid');
      }
      return { host: value['host'], port: value['port'], accessToken: value['accessToken'] };
    },
    onMessage: () => undefined
  });
  return createProtectedWorkAuthority({
    client,
    loadedCredential,
    boundaryStoreRoot: join(configRoot, 'runtime', 'boundary-identities')
  });
}

/**
 * Constructs the authenticated runtime adapter used by platform handlers.
 *
 * The adapter owns the connection lifecycle of the client it is given: each
 * operation opens the runtime connection it needs and closes it before
 * resolving. Short-lived hook processes wire a fresh client into a fresh
 * adapter per invocation, so a connection left open after the operation would
 * hold the process's event loop open forever — the hook would finish its work
 * and then hang as an orphan until killed (card main-707).
 *
 * @param _input - Protected credential, execution identity, runtime client,
 *   and durable boundary identity store. Nothing is read from module globals.
 * @returns A port whose admission is fail-closed and whose observation never
 *   creates work.
 */
export function createWorkAuthorityAdapter(_input: WorkAuthorityAdapterInput): WorkAuthority {
  const { boundaryIds, client, execution } = _input;
  const connect = async (): Promise<number> => {
    const connected = await client.connect();
    if (connected.status !== 'connected') throw new Error(`runtime connection ${connected.status}`);
    return connected.synchronization.workRevision;
  };
  const close = async (): Promise<void> => {
    try {
      await client.close();
    } catch {
      // A refused close must not mask the operation's own outcome; the
      // lifecycle teardown below is best-effort by design.
    }
  };
  return {
    async admit(boundary) {
      try {
        const executionId = execution.executionId;
        if (executionId === null) throw new Error('Execution is not admitted');
        const identity = await boundaryIds.getOrCreate({
          platformSessionId: executionId,
          hostBoundaryId: boundary.requestId
        });
        await connect();
        const outcome = await client.send({
          type: 'execution.workAdmission',
          payload: { cause: boundary.cause },
          messageId: identity.messageId,
          requestId: identity.requestId,
          execution,
          deadlineMs: 5_000
        });
        if (outcome.status !== 'accepted' || outcome.workAdmission === undefined) {
          throw new Error(`work admission ${outcome.status}`);
        }
        if (outcome.workAdmission.status === 'rejected') {
          throw new Error(`drain barrier held by ${outcome.workAdmission.barrierHolderId}`);
        }
        return { workRevision: outcome.workAdmission.workRevision };
      } finally {
        await close();
      }
    },
    async observeRevision() {
      try {
        return await connect();
      } finally {
        await close();
      }
    }
  };
}

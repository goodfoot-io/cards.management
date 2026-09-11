/**
 * Authenticated HTTP client contract for durable runtime action launch and retrieval.
 * @summary Durable runtime action HTTP client
 * @module
 */

import { z } from 'zod';
import type {
  AdmissionRejectionReason,
  AdmissionUncertaintyReason,
  AdmittedLaunchCredentials,
  BoundExecution,
  ClientLaunchAdmission,
  ImmutableActionParams,
  LaunchOutcome,
  OriginalCallerRequestId,
  ReplayedLaunchAdmission,
  RetrievedAdmission
} from '../../protocol/types/index.js';
import { executionIdentitySchema, producerRoleSchema, RUNTIME_MESSAGE_PAYLOADS } from '../../protocol/types/index.js';
import type { RuntimeDiscovery } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HTTP_REJECTIONS = new Set<RuntimeActionHttpRejectionReason>([
  'authentication-failed',
  'invalid-request',
  'not-found'
]);
const TRANSPORT_UNCERTAINTIES = new Set<RuntimeActionTransportUncertaintyReason>([
  'discovery-unavailable',
  'network-error',
  'deadline-expired',
  'server-unavailable',
  'invalid-response'
]);

function isHttpRejection(value: unknown): value is RuntimeActionHttpRejectionReason {
  return typeof value === 'string' && HTTP_REJECTIONS.has(value as RuntimeActionHttpRejectionReason);
}

function isTransportUncertainty(value: unknown): value is RuntimeActionTransportUncertaintyReason {
  return typeof value === 'string' && TRANSPORT_UNCERTAINTIES.has(value as RuntimeActionTransportUncertaintyReason);
}

const rejectionReasonSchema = z.enum([
  'parameter-mismatch',
  'scope-mismatch',
  'retired',
  'revoked',
  'retention-exhausted'
]);
const uncertaintyReasonSchema = z.enum([
  'spawn-attempt-unconfirmed',
  'journal-corrupt',
  'journal-unreadable',
  'storage-unavailable'
]);
const credentialSchema = z
  .object({
    credentialId: z.string().min(1),
    requestId: z.string().min(1),
    executionId: z.string().min(1),
    role: producerRoleSchema,
    producerId: z.string().min(1),
    secret: z.string().min(1),
    issuedAt: z.number()
  })
  .strict();
const admittedSchema = z
  .object({
    disposition: z.literal('admitted'),
    execution: executionIdentitySchema,
    credentials: z.array(credentialSchema)
  })
  .strict();
const replayedSchema = z
  .object({
    disposition: z.literal('replayed'),
    execution: executionIdentitySchema,
    spawnPhase: z.enum(['not-attempted', 'attempted', 'confirmed']),
    retrievedOutcome: RUNTIME_MESSAGE_PAYLOADS['execution.launchOutcome'].nullable()
  })
  .strict();
const launchResponseSchema = z.discriminatedUnion('disposition', [
  admittedSchema,
  replayedSchema,
  z
    .object({
      disposition: z.literal('rejected'),
      reason: rejectionReasonSchema,
      execution: executionIdentitySchema.nullable()
    })
    .strict(),
  z
    .object({
      disposition: z.literal('unavailable'),
      reason: uncertaintyReasonSchema,
      execution: executionIdentitySchema.nullable()
    })
    .strict()
]);
const retrievalResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      execution: executionIdentitySchema,
      spawnPhase: z.enum(['not-attempted', 'attempted', 'confirmed'])
    })
    .strict(),
  z
    .object({
      status: z.literal('pending'),
      execution: executionIdentitySchema,
      retrievedOutcome: RUNTIME_MESSAGE_PAYLOADS['execution.launchOutcome'].nullable()
    })
    .strict(),
  z
    .object({
      status: z.literal('completed'),
      execution: executionIdentitySchema,
      retrievedOutcome: RUNTIME_MESSAGE_PAYLOADS['execution.launchOutcome']
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      reason: rejectionReasonSchema,
      execution: executionIdentitySchema.nullable()
    })
    .strict(),
  z
    .object({
      status: z.literal('uncertain'),
      reason: uncertaintyReasonSchema,
      execution: executionIdentitySchema.nullable()
    })
    .strict(),
  z.object({ status: z.literal('not-found') }).strict()
]);

/** Caller-owned immutable launch request sent to the durable runtime action route. */
export interface RuntimeActionLaunchRequest {
  readonly requestId: OriginalCallerRequestId;
  readonly messageId: string;
  readonly params: ImmutableActionParams;
}

/** Client configuration for discovered authenticated runtime action requests. */
export interface RuntimeActionClientOptions {
  readonly discover: RuntimeDiscovery;
  /** Bounds one HTTP attempt; expiry leaves the caller-owned IDs reusable. */
  readonly timeoutMs?: number;
}

/** HTTP-level failures that settle a request without granting retry permission. */
export type RuntimeActionHttpRejectionReason = 'authentication-failed' | 'invalid-request' | 'not-found';

/** Failures for which the durable server outcome is unknown. */
export type RuntimeActionTransportUncertaintyReason =
  | 'discovery-unavailable'
  | 'network-error'
  | 'deadline-expired'
  | 'server-unavailable'
  | 'invalid-response';

/** Stable result of a durable launch request. */
export type RuntimeActionLaunchResult =
  | {
      readonly status: 'accepted';
      readonly requestId: OriginalCallerRequestId;
      readonly messageId: string;
      readonly admission: AdmittedLaunchCredentials | ReplayedLaunchAdmission;
    }
  | {
      readonly status: 'completed';
      readonly requestId: OriginalCallerRequestId;
      readonly messageId: string;
      readonly execution: BoundExecution;
      readonly outcome: LaunchOutcome;
    }
  | {
      readonly status: 'rejected';
      readonly requestId: OriginalCallerRequestId;
      readonly messageId: string;
      readonly reason: AdmissionRejectionReason | RuntimeActionHttpRejectionReason;
    }
  | {
      readonly status: 'uncertain';
      readonly requestId: OriginalCallerRequestId;
      readonly messageId: string;
      readonly reason: AdmissionUncertaintyReason | RuntimeActionTransportUncertaintyReason;
    };

/** Stable result of retrieving a durable launch by its caller-owned request ID. */
export type RuntimeActionRetrievalResult =
  | {
      readonly status: 'accepted';
      readonly requestId: OriginalCallerRequestId;
      readonly admission: Extract<RetrievedAdmission, { readonly status: 'accepted' | 'pending' }>;
    }
  | {
      readonly status: 'completed';
      readonly requestId: OriginalCallerRequestId;
      readonly execution: BoundExecution;
      readonly outcome: LaunchOutcome;
    }
  | {
      readonly status: 'rejected';
      readonly requestId: OriginalCallerRequestId;
      readonly reason: AdmissionRejectionReason | RuntimeActionHttpRejectionReason;
    }
  | {
      readonly status: 'uncertain';
      readonly requestId: OriginalCallerRequestId;
      readonly reason: AdmissionUncertaintyReason | RuntimeActionTransportUncertaintyReason;
    };

/** Typed durable action launch and retrieval client. */
export interface RuntimeActionClient {
  launch(cardId: string, request: RuntimeActionLaunchRequest): Promise<RuntimeActionLaunchResult>;
  retrieve(cardId: string, requestId: OriginalCallerRequestId): Promise<RuntimeActionRetrievalResult>;
}

/**
 * Creates a client for the authenticated durable runtime action routes.
 * @param options - Discovery and per-attempt timeout policy.
 * @returns A client that preserves caller-owned request and message identities.
 */
export function createRuntimeActionClient(options: RuntimeActionClientOptions): RuntimeActionClient {
  const transport = async (
    path: string,
    init: RequestInit
  ): Promise<unknown | RuntimeActionTransportUncertaintyReason | RuntimeActionHttpRejectionReason> => {
    const target = await options.discover();
    if (target === null) return 'discovery-unavailable';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(`http://${target.host}:${target.port}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${target.accessToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) return 'authentication-failed';
      if (response.status === 400) return 'invalid-request';

      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return 'invalid-response';
      if (response.body === null) return 'invalid-response';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return 'invalid-response';
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return response.status === 503 ? 'server-unavailable' : 'invalid-response';
      }
      if (response.status === 503 && typeof body === 'object' && body !== null && 'error' in body) {
        return 'server-unavailable';
      }
      if ((response.status < 200 || response.status >= 300) && ![404, 409, 503].includes(response.status)) {
        return 'invalid-response';
      }
      return body;
    } catch (error) {
      return controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
        ? 'deadline-expired'
        : 'network-error';
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async launch(cardId, request): Promise<RuntimeActionLaunchResult> {
      const value = await transport(`/cards/${encodeURIComponent(cardId)}/runtime/actions`, {
        method: 'POST',
        body: JSON.stringify(request)
      });
      if (isHttpRejection(value)) {
        return { status: 'rejected', requestId: request.requestId, messageId: request.messageId, reason: value };
      }
      if (isTransportUncertainty(value)) {
        return { status: 'uncertain', requestId: request.requestId, messageId: request.messageId, reason: value };
      }
      const parsed = launchResponseSchema.safeParse(value);
      if (!parsed.success) {
        return {
          status: 'uncertain',
          requestId: request.requestId,
          messageId: request.messageId,
          reason: 'invalid-response'
        };
      }
      const response = parsed.data as ClientLaunchAdmission;
      if (response.disposition === 'rejected') {
        return {
          status: 'rejected',
          requestId: request.requestId,
          messageId: request.messageId,
          reason: response.reason
        };
      }
      if (response.disposition === 'unavailable') {
        return {
          status: 'uncertain',
          requestId: request.requestId,
          messageId: request.messageId,
          reason: response.reason
        };
      }
      if (response.disposition === 'replayed' && response.retrievedOutcome !== null) {
        return {
          status: 'completed',
          requestId: request.requestId,
          messageId: request.messageId,
          execution: response.execution,
          outcome: response.retrievedOutcome
        };
      }
      return { status: 'accepted', requestId: request.requestId, messageId: request.messageId, admission: response };
    },
    async retrieve(cardId, requestId): Promise<RuntimeActionRetrievalResult> {
      const value = await transport(
        `/cards/${encodeURIComponent(cardId)}/runtime/actions/${encodeURIComponent(requestId)}`,
        { method: 'GET' }
      );
      if (isHttpRejection(value)) return { status: 'rejected', requestId, reason: value };
      if (isTransportUncertainty(value)) {
        return { status: 'uncertain', requestId, reason: value };
      }
      const parsed = retrievalResponseSchema.safeParse(value);
      if (!parsed.success) return { status: 'uncertain', requestId, reason: 'invalid-response' };
      const response = parsed.data as RetrievedAdmission;
      if (response.status === 'not-found') return { status: 'rejected', requestId, reason: 'not-found' };
      if (response.status === 'rejected') return { status: 'rejected', requestId, reason: response.reason };
      if (response.status === 'uncertain') return { status: 'uncertain', requestId, reason: response.reason };
      if (response.status === 'completed') {
        return { status: 'completed', requestId, execution: response.execution, outcome: response.retrievedOutcome };
      }
      return { status: 'accepted', requestId, admission: response };
    }
  };
}

/** Server response accepted by the launch mapping implementation. */
export type RuntimeActionLaunchResponse = ClientLaunchAdmission;

/**
 * Authenticated HTTP client contract for durable runtime action launch and retrieval.
 * @summary Durable runtime action HTTP client
 * @module
 */
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
import type { RuntimeDiscovery } from './types.js';

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
  launch(request: RuntimeActionLaunchRequest): Promise<RuntimeActionLaunchResult>;
  retrieve(requestId: OriginalCallerRequestId): Promise<RuntimeActionRetrievalResult>;
}

/**
 * Creates a client for the authenticated durable runtime action routes.
 * @param _options - Discovery and per-attempt timeout policy.
 * @returns A client that preserves caller-owned request and message identities.
 * @throws Until the Phase 3 implementation is supplied.
 */
export function createRuntimeActionClient(_options: RuntimeActionClientOptions): RuntimeActionClient {
  return {
    launch(_request): Promise<RuntimeActionLaunchResult> {
      throw new Error('Not Implemented');
    },
    retrieve(_requestId): Promise<RuntimeActionRetrievalResult> {
      throw new Error('Not Implemented');
    }
  };
}

/** Server response accepted by the launch mapping implementation. */
export type RuntimeActionLaunchResponse = ClientLaunchAdmission;

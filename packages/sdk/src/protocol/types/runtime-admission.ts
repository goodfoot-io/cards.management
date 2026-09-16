/**
 * Wire-visible vocabulary for launch admission: what a client sends to be
 * admitted, what it receives back, and what a resumed process presents to prove
 * it is the execution that was admitted.
 *
 * These types live in the SDK for the same reason the envelope contract does.
 * The server owns the *authority* — the journal, the secret hashes, the decision
 * — but it cannot own the *vocabulary*, because the CLI, the agent hooks, and
 * the SDK client all have to construct and interpret these values, and none of
 * them may depend on the server package. Only the shapes that cross that line
 * are here; everything durable or secret-bearing stays server-side.
 *
 * The division that matters is credentials. {@link IssuedRoleCredential} is
 * here because the launched process receives one and must be able to read it.
 * Its durable counterpart, which holds a hash rather than a secret, is not:
 * nothing outside the server has any business modelling what the journal keeps.
 * Likewise the opaque handle that authorizes a spawn is absent by design — it is
 * unforgeable precisely because no code outside the admission module can name
 * its shape, and exporting it here would give that shape away.
 *
 * @summary Client-visible launch admission, retrieval, and role-credential types
 * @module
 */

import type { ExecutionIdentity, ProducerRole, RuntimeScope } from './runtime-identity.js';
import type { RuntimePayload } from './runtime-messages.js';

/**
 * The original caller request ID: minted once at a launch ingress (CLI, UI, or
 * HTTP), persisted by the caller before sending, and reused verbatim on every
 * retry of that same intent. A new intentional action mints a new one.
 *
 * This is the only key the admission authority accepts. Retries are recognised
 * by it, outcomes are retrieved by it, and retirement is recorded against it.
 */
export type OriginalCallerRequestId = string;

/**
 * The scope an admission is bound to: the runtime scope plus the role the
 * caller was authorized as. Bound once, at admission, and compared on every
 * replay — an ID authorizes work in one place, under one role.
 */
export interface AdmissionScope extends RuntimeScope {
  /** Producer role the caller was authorized as when the request was minted. */
  readonly producerRole: ProducerRole;
}

/**
 * Immutable action parameters bound to an admission: the payload of
 * `execution.launchRequest`, unchanged. Once admitted these can never change
 * under the same request ID; a differing replay is rejected before it reaches a
 * dispatcher.
 */
export type ImmutableActionParams = RuntimePayload<'execution.launchRequest'>;

/**
 * The single execution an admission is bound to. Its `launchRequestId` is
 * precisely the original caller request ID the admission keys on, so the journal
 * and the wire name an execution the same way.
 */
export type BoundExecution = ExecutionIdentity;

/**
 * Recorded result of the launch attempt: the payload of
 * `execution.launchOutcome`, unchanged.
 */
export type LaunchOutcome = RuntimePayload<'execution.launchOutcome'>;

/**
 * Where the spawn stands relative to the durable record. Written before the
 * dispatcher is called (`attempted`) and again after it returns (`confirmed`),
 * which is what makes the crash window observable rather than silently
 * ambiguous.
 */
export type SpawnPhase = 'not-attempted' | 'attempted' | 'confirmed';

/** Why a launch was refused. Every reason is a deliberate fail-closed answer. */
export type AdmissionRejectionReason =
  | 'parameter-mismatch'
  | 'scope-mismatch'
  | 'retired'
  | 'revoked'
  | 'retention-exhausted';

/**
 * Why the authority cannot answer definitively. A client must never treat any
 * of these as permission to launch — they mean the answer is unknown, not that
 * the answer is no.
 */
export type AdmissionUncertaintyReason =
  | 'spawn-attempt-unconfirmed'
  | 'journal-corrupt'
  | 'journal-unreadable'
  | 'storage-unavailable';

/** A launch asking to be admitted. */
export interface LaunchAdmissionRequest {
  /** Original caller request ID, minted at the ingress and reused on every retry. */
  readonly requestId: OriginalCallerRequestId;
  /**
   * `messageId` of the launch request envelope this admission is being asked for.
   *
   * Recorded with the admission so the server can later tell a reconnecting
   * client that this exact message is durably held and its outbox copy may be
   * dropped. It has to come from the caller: an ID the server invented would
   * match nothing the client is holding, and so could retire nothing.
   *
   * The first one wins. The protocol keeps a `messageId` stable across
   * retransmissions of the same logical message, so a retrying caller presents
   * the one already recorded; a caller presenting a different one under an
   * already-admitted request ID is making a duplicate launch attempt, which
   * admission answers as a replay.
   */
  readonly messageId: string;
  /** Scope the caller was authorized in. */
  readonly scope: AdmissionScope;
  /** Immutable action parameters; a changed replay under this ID is rejected. */
  readonly params: ImmutableActionParams;
  /**
   * Roles that will speak for this execution and therefore need a credential
   * minted before the spawn. One credential is issued per role, so independent
   * concurrent producers coexist without sharing an identity.
   */
  readonly credentialRoles: readonly ProducerRole[];
}

/**
 * The half of a role credential handed to the process being launched, returned
 * exactly once at admission. The secret is not recoverable afterwards — the
 * journal keeps only its hash.
 *
 * This, not a rediscovered host and port, is what proves a resumed execution is
 * the execution that was admitted. Anything that can read the discovery file
 * learns the host and port; only the admitted process is given this.
 */
export interface IssuedRoleCredential {
  /** Opaque public identifier, safe to log and to carry in a header. */
  readonly credentialId: string;
  /** Original caller request ID this credential belongs to. */
  readonly requestId: OriginalCallerRequestId;
  /** Execution the credential speaks for. */
  readonly executionId: string;
  /** Role this credential authenticates as. */
  readonly role: ProducerRole;
  /** Producer identity the transport will attribute messages to. */
  readonly producerId: string;
  /** The bearer secret. Never written to the journal and never reissued. */
  readonly secret: string;
  /** Epoch milliseconds the credential was issued. */
  readonly issuedAt: number;
}

/**
 * What a connecting process presents at registration or resume. The request ID
 * is part of the presentation so the admission can be located directly, without
 * a second durable index from credential to request that could disagree with the
 * record it indexes.
 */
export interface PresentedCredential {
  /** Original caller request ID the presenter claims. */
  readonly requestId: OriginalCallerRequestId;
  /** Credential identifier the presenter claims. */
  readonly credentialId: string;
  /** Bearer secret being presented. */
  readonly secret: string;
}

/**
 * Why a presented credential was refused. Every reason is a fail-closed answer,
 * and they are deliberately distinguishable: a client that presented a stale
 * credential should retry differently from one whose admission was revoked.
 */
export type CredentialRefusalReason =
  | 'unknown-request'
  | 'unknown-credential'
  | 'secret-mismatch'
  | 'credential-revoked'
  | 'admission-revoked'
  | 'admission-retired'
  | 'admission-unreadable';

/**
 * A fresh admission, from the client's point of view: this launch was admitted
 * now, and these are the credentials its process must be given.
 *
 * Server-side this branch is widened with the opaque handle that authorizes the
 * spawn. That handle is intentionally not part of the client shape.
 */
export interface AdmittedLaunchCredentials {
  readonly disposition: 'admitted';
  readonly execution: BoundExecution;
  /** Issued exactly once. The secrets are not recoverable after this. */
  readonly credentials: readonly IssuedRoleCredential[];
}

/**
 * A retry of a request whose admission already stands and whose spawn is no
 * longer owed. The execution identity is the one bound originally — it never
 * changes across retries of the same request ID.
 */
export interface ReplayedLaunchAdmission {
  readonly disposition: 'replayed';
  readonly execution: BoundExecution;
  readonly spawnPhase: SpawnPhase;
  readonly retrievedOutcome: LaunchOutcome | null;
}

/**
 * The two ways a launch does not proceed. They are kept apart because they
 * demand opposite client behaviour: `rejected` is a settled no and retrying it
 * unchanged is pointless, while `unavailable` means the authority could not be
 * consulted and the request may still be outstanding.
 */
export type LaunchAdmissionRefusal =
  | {
      readonly disposition: 'rejected';
      readonly reason: AdmissionRejectionReason;
      readonly execution: BoundExecution | null;
    }
  | {
      readonly disposition: 'unavailable';
      readonly reason: AdmissionUncertaintyReason;
      readonly execution: BoundExecution | null;
    };

/**
 * What a client receives from a launch admission request. The server's own
 * result type is assignable to this: it is the same union with the spawn handle
 * added to the admitted branch.
 */
export type ClientLaunchAdmission = AdmittedLaunchCredentials | ReplayedLaunchAdmission | LaunchAdmissionRefusal;

/**
 * What retrieval reports for an original caller request ID. Valid across an API
 * or executor restart, because every field is read from the durable record
 * rather than from process memory.
 *
 * There is no unauthorized status. A caller whose scope does not match the one
 * bound at admission is told `not-found`, because distinguishing the two would
 * disclose that an execution exists to someone not entitled to know it.
 */
export type RetrievedAdmission =
  | {
      readonly status: 'accepted';
      readonly execution: BoundExecution;
      readonly spawnPhase: SpawnPhase;
    }
  | {
      readonly status: 'pending';
      readonly execution: BoundExecution;
      readonly retrievedOutcome: LaunchOutcome | null;
    }
  | {
      readonly status: 'completed';
      readonly execution: BoundExecution;
      readonly retrievedOutcome: LaunchOutcome;
      /** Custodied cleanup proof which, unlike a successful spawn, is terminal. */
      readonly terminalOutcome?: RuntimePayload<'execution.cleanupResult'>;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AdmissionRejectionReason;
      readonly execution: BoundExecution | null;
    }
  | {
      readonly status: 'uncertain';
      readonly reason: AdmissionUncertaintyReason;
      readonly execution: BoundExecution | null;
    }
  | { readonly status: 'not-found' };

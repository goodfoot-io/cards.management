/**
 * The runtime protocol message catalogue: every message type and its validated
 * payload schema.
 *
 * Each entry here replaces something that previously travelled over a per-action
 * or per-watcher local socket with hand-rolled field checks. Payloads are Zod
 * schemas rather than interfaces alone so that validation happens at the trust
 * boundary once, and every downstream handler receives a parsed value it can
 * rely on. Every object schema is `.strict()`: an unexpected field is a version
 * skew or an impersonation attempt, not something to silently ignore.
 *
 * Message names are namespaced by subject (`runtime.`, `execution.`,
 * `watcher.`) and suffixed `Request`/`Command`/`Result` so that direction is
 * legible at the call site. A `Request` travels toward the server, a `Command`
 * travels toward an execution's client, and a `Result` reports a terminal fact.
 *
 * @summary Message type union and validated payload schemas for the runtime protocol
 * @module
 */

import { z } from 'zod';
import { connectionStateSchema, executionLifecycleStateSchema } from './runtime-identity.js';

/**
 * Maximum size of a single control frame. Payloads that can legitimately exceed
 * this (interactive handoff continuations, large transcripts) carry a reference
 * to an authenticated payload facility rather than inlining their content, so
 * that the control path stays bounded and one large message cannot stall
 * liveness for every other producer on the connection.
 */
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

// --- Shared payload fragments ---

/**
 * A reference to content held outside the control frame. `digest` is required
 * so that a consumer can verify integrity; the reference is resolved through an
 * authenticated facility and never by treating `locator` as a filesystem path
 * supplied by the peer.
 */
export const payloadReferenceSchema = z
  .object({
    locator: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    digest: z.string().min(1)
  })
  .strict();

/** Content that is either small enough to inline or carried by reference. */
export const inlineOrReferencedSchema = z.union([
  z.object({ kind: z.literal('inline'), value: z.string() }).strict(),
  z.object({ kind: z.literal('reference'), reference: payloadReferenceSchema }).strict()
]);

/**
 * Monotonic counter that invalidates readiness evidence. A new turn or newly
 * owned child work advances it, including while the client is disconnected, so
 * that readiness observed before the advance cannot authorize a termination
 * after it.
 */
export const workRevisionSchema = z.number().int().nonnegative();

// --- Reconciled snapshot payloads ---

/** Capabilities a client advertises; absent flags are treated as unsupported. */
export const capabilitiesSchema = z
  .object({
    switchToInteractive: z.boolean(),
    agentShutdown: z.boolean(),
    strictDrainBarrier: z.boolean()
  })
  .strict();

/** Exact runtime commands and safety semantics implemented by one producer adapter. */
export type RuntimeCapabilities = z.infer<typeof capabilitiesSchema>;

/**
 * Snapshot revision carried by every reconciled-snapshot message. Acceptance
 * compares the envelope's ownership generation first and this revision second.
 */
export const snapshotRevisionSchema = z.number().int().nonnegative();

/** Payload of `runtime.register`. */
export const registerPayloadSchema = z
  .object({
    revision: snapshotRevisionSchema,
    capabilities: capabilitiesSchema,
    lifecycleState: executionLifecycleStateSchema,
    workRevision: workRevisionSchema,
    processBootId: z.string().min(1).optional()
  })
  .strict();

/**
 * Payload of `runtime.resume`. `outstandingMessageIds` are durable obligations
 * the client still holds; the server replies with which have already been
 * accepted so the client can retire exactly those and replay the rest.
 */
export const resumePayloadSchema = z
  .object({
    revision: snapshotRevisionSchema,
    capabilities: capabilitiesSchema,
    lifecycleState: executionLifecycleStateSchema,
    workRevision: workRevisionSchema,
    outstandingMessageIds: z.array(z.string().min(1)).max(1000)
  })
  .strict();

/** Payload of `runtime.capabilities`. */
export const capabilitiesPayloadSchema = z
  .object({
    revision: snapshotRevisionSchema,
    capabilities: capabilitiesSchema
  })
  .strict();

/** Payload of `runtime.liveness`. */
export const livenessPayloadSchema = z
  .object({
    revision: snapshotRevisionSchema,
    connectionState: connectionStateSchema,
    workRevision: workRevisionSchema
  })
  .strict();

// --- Durable intent payloads ---

/** Execution modes an admitted launch may request. */
export const executionModeSchema = z.enum(['background', 'interactive']);

/**
 * Payload of `execution.launchRequest`. The parameters are immutable once bound
 * to an admission: reusing the envelope's `requestId` with different parameters
 * is rejected rather than admitted as a second launch.
 */
export const launchRequestPayloadSchema = z
  .object({
    actionId: z.string().min(1),
    environmentName: z.string().min(1),
    mode: executionModeSchema,
    exitWhenDone: z.boolean(),
    selectedAgent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    variableGroupIds: z.array(z.string().min(1)).optional(),
    /** Serialized continuation admitted with an interactive handoff successor. */
    continuation: z.string().min(1).optional()
  })
  .strict();

/** Payload of `execution.cancelRequest` and `execution.cancelCommand`. */
export const cancelPayloadSchema = z
  .object({
    reason: z.enum(['user', 'api', 'superseded']),
    /** Explicit user cancellation is separately authorized and may override idle requirements. */
    overridesIdleRequirement: z.boolean()
  })
  .strict();

/**
 * Payload of `execution.interactiveHandoff`. The authority deterministically
 * admits the successor from this correlated, durable continuation.
 */
export const interactiveHandoffPayloadSchema = z
  .object({
    continuation: inlineOrReferencedSchema
  })
  .strict();

/** Payload of `execution.switchToInteractiveCommand`. */
export const switchToInteractiveCommandPayloadSchema = z.object({}).strict();

/** Extension-authored request to begin a durable interactive handoff. */
export const switchToInteractiveRequestPayloadSchema = z.object({}).strict();

/** Outcome a shutdown requester reports for the work it is finishing. */
export const shutdownOutcomeSchema = z.enum(['success', 'blocked', 'error']);

/** Payload of `execution.shutdownRequest`. */
export const shutdownRequestPayloadSchema = z
  .object({
    outcome: shutdownOutcomeSchema,
    message: z.string().max(4096).optional()
  })
  .strict();

/** Why an execution reached its one terminal decision. */
export const terminalDecisionReasonSchema = z.enum([
  'completion',
  'cancel',
  'terminal-close',
  'natural-exit',
  'startup-failure'
]);

/**
 * The single terminal decision recorded on an execution record.
 *
 * It is atomically first-written: whichever intent arrives first wins, and a
 * later one attaches evidence rather than replacing the accepted reason. That
 * is what makes a root exit racing a recorded completion reportable without
 * either observation overwriting the other.
 *
 * `decisionId` is derived from the execution alone ({@link terminalDecisionId}),
 * so a wrapper that observed a local exit while disconnected names the same
 * decision the server would, and the two reconcile on replay instead of
 * creating a second terminal record.
 */
export const terminalDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    /** `messageId` of the intent or local observation that produced this decision. */
    originMessageId: z.string().min(1),
    reason: terminalDecisionReasonSchema,
    /** Work outcome reported by an explicit requester; absent for observed ends. */
    outcome: shutdownOutcomeSchema.optional(),
    message: z.string().max(4096).optional(),
    acceptedAt: z.string().datetime()
  })
  .strict();

/** One execution's accepted terminal decision. */
export type TerminalDecision = z.infer<typeof terminalDecisionSchema>;

/**
 * Derives the deterministic decision ID for an execution.
 *
 * @param executionId - Admitted execution the decision belongs to.
 * @returns The canonical `terminal:<executionId>` decision identifier.
 */
export function terminalDecisionId(executionId: string): string {
  return `terminal:${executionId}`;
}

/** Terminal reasons that dispatch a stop command to a live wrapper. */
export const stopCommandReasonSchema = z.enum(['completion', 'cancel', 'terminal-close']);

/**
 * Payload of `execution.stopCommand`, sent only to the current wrapper of an
 * accepted terminal decision. Execution scope and ownership generation ride in
 * the envelope, so a stale wrapper's delivery is refused by the fence rather
 * than by anything in this payload.
 */
export const stopCommandPayloadSchema = z
  .object({
    terminalDecisionId: z.string().min(1),
    reason: stopCommandReasonSchema
  })
  .strict();

/** Payload of `execution.executeRequest`; identical to the admitted immutable launch parameters. */
export const executeRequestPayloadSchema = launchRequestPayloadSchema;

/** Payload of `watcher.stopRequest` and `watcher.stopCommand`. */
export const watcherStopPayloadSchema = z
  .object({
    watcherId: z.string().min(1)
  })
  .strict();

// --- Revocable readiness payload ---

/**
 * Payload of `execution.shutdownReadiness`. Readiness is evidence about a
 * specific `workRevision` under a specific shutdown request; acknowledgment
 * confirms durable receipt only. Authorizing termination additionally requires
 * that the revision has not advanced and that a fresh strict drain is held
 * across the effect.
 */
export const shutdownReadinessPayloadSchema = z
  .object({
    shutdownRequestId: z.string().min(1),
    workRevision: workRevisionSchema,
    /** Platform session whose authenticated hook established strict idleness. */
    platformSessionId: z.string().min(1),
    observedIdleAt: z.string().datetime()
  })
  .strict();

/** Requests server-owned admission of a new turn or owned child task. */
export const workAdmissionPayloadSchema = z.object({ cause: z.enum(['turn', 'childTask']) }).strict();

// --- Durable result payloads ---

/** Payload of `execution.launchAdmission`. */
export const launchAdmissionPayloadSchema = z
  .object({
    disposition: z.enum(['admitted', 'replayed', 'rejected', 'retired']),
    admittedAt: z.string().datetime(),
    rejectionReason: z.string().max(1024).optional()
  })
  .strict();

/** Payload of `execution.launchOutcome`. */
export const launchOutcomePayloadSchema = z
  .object({
    disposition: z.enum(['spawned', 'failed', 'uncertain']),
    processBootId: z.string().min(1).optional(),
    processIdentity: z
      .object({
        processId: z.number().int().positive(),
        bootId: z.string().min(1),
        startedAtToken: z.string().min(1),
        ownership: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('posix-process-group'), groupId: z.number().int().positive() }).strict(),
          z.object({ kind: z.literal('windows-job'), jobId: z.string().min(1) }).strict()
        ])
      })
      .strict()
      .optional(),
    runtimeOwnerIdentity: z
      .object({
        processId: z.number().int().positive(),
        bootId: z.string().min(1),
        startedAtToken: z.string().min(1),
        ownership: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('posix-process-group'), groupId: z.number().int().positive() }).strict(),
          z.object({ kind: z.literal('windows-job'), jobId: z.string().min(1) }).strict()
        ])
      })
      .strict()
      .optional(),
    message: z.string().max(4096).optional()
  })
  .strict();

/** Durable worktree settlement reported by the admitted agent handler. */
export const worktreeAssignmentResultPayloadSchema = z
  .object({
    branch: z.string().min(1),
    worktreePath: z.string().min(1),
    reason: z.enum(['reused', 'reattached', 'allocated'])
  })
  .strict();

/** What began the wrapper's one bounded cleanup operation. */
export const cleanupTriggerSchema = z.enum(['command', 'root-exit', 'spawn-error', 'terminal-close']);

/**
 * How far containment got. `unknown` is never an error path to be smoothed
 * over: a failed identity check, an uninterruptible member, or a lost anchor
 * all land here, and nothing downstream may read it as drained.
 */
export const cleanupStatusSchema = z.enum(['drained', 'failed', 'unknown']);

/** Which half of the cleanup interval the recorded status was reached in. */
export const cleanupPhaseSchema = z.enum(['graceful', 'forced']);

/** Whether required stream finalization produced evidence within its own window. */
export const cleanupFinalizationSchema = z.enum(['complete', 'incomplete', 'not-required']);

/**
 * Payload of `execution.cleanupResult`: the wrapper's single durable report for
 * one ended execution, replacing the separate termination and cleanup records.
 *
 * `status` and `finalization` are deliberately independent. A process boundary
 * can be provably drained while a transcript flush never closed, and that
 * combination has to stay visible rather than collapsing into one verdict —
 * the worktree may be released on the first, but the action result still says
 * the second did not finish.
 */
export const cleanupResultPayloadSchema = z
  .object({
    terminalDecisionId: z.string().min(1),
    /** Wrapper-local observation this report settles; stable across replay. */
    observationId: z.string().min(1),
    trigger: cleanupTriggerSchema,
    status: cleanupStatusSchema,
    phase: cleanupPhaseSchema.optional(),
    rootExit: z
      .object({
        code: z.number().int().nullable(),
        signal: z.string().min(1).nullable()
      })
      .strict()
      .optional(),
    finalization: cleanupFinalizationSchema,
    detail: z.string().max(4096).optional()
  })
  .strict();

/**
 * Payload of `execution.branchCleanupRegistration`, sent by the provider while
 * it still holds its session-specific inputs. It carries nothing else on
 * purpose: `cardId`, `repoRoot`, and `cardRepoPath` are derived by the server
 * from the admitted execution and its reservation, so no path supplied by a
 * producer can steer the maintenance worker.
 */
export const branchCleanupRegistrationPayloadSchema = z
  .object({
    sessionId: z.string().min(1).optional()
  })
  .strict();

/**
 * Payload of `execution.branchCleanupEffect`, journaled by the server only
 * after a `cleanupResult` with accepted `status: 'drained'`, and implemented by
 * the extension authority outside the ended wrapper session.
 *
 * Every path here is server-derived from the admitted execution, never echoed
 * from the registration, and the effect names no program: the extension
 * resolves its packaged worker entrypoint from its own installation.
 */
export const branchCleanupEffectPayloadSchema = z
  .object({
    terminalDecisionId: z.string().min(1),
    cardId: z.string().min(1),
    repoRoot: z.string().min(1),
    cardRepoPath: z.string().min(1),
    /** Session the registration named, carried through for marker correlation. */
    sessionId: z.string().min(1).optional()
  })
  .strict();

/** Durable, fail-closed report for an agent-handler command whose effect cannot be reconciled after restart. */
export const commandEffectResultPayloadSchema = z
  .object({
    commandMessageId: z.string().min(1),
    controlRequestId: z.string().min(1),
    commandType: z.enum(['execution.cancelCommand', 'execution.switchToInteractiveCommand']),
    disposition: z.literal('in-doubt'),
    observedAt: z.string().datetime(),
    reason: z.literal('handler-restarted-during-effect')
  })
  .strict();

/**
 * Payload of `watcher.stopResult`. `already-stopped` and `stopped` are both
 * successful outcomes so that a replayed stop intent resolves rather than
 * looking like a failure; `timed-out` means the watcher never acknowledged and
 * the intent stays outstanding.
 */
export const watcherStopResultPayloadSchema = z
  .object({
    watcherId: z.string().min(1),
    disposition: z.enum(['stopped', 'already-stopped', 'timed-out'])
  })
  .strict();

// --- Disposable telemetry payloads ---

/** Severity levels accepted on `runtime.log`. */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);

/** Payload of `runtime.log`. */
export const logPayloadSchema = z
  .object({
    level: logLevelSchema,
    message: z.string().max(8192)
  })
  .strict();

/** Payload of `runtime.heartbeat`. */
export const heartbeatPayloadSchema = z
  .object({
    sentAt: z.string().datetime()
  })
  .strict();

/**
 * Payload of `watcher.telemetry`. The `watching`, `status`, and `error` events
 * the stream-sync watcher emits are all classified here: their only consumer
 * drives a health indicator, and none of them is evidence that any durable work
 * completed. Dropping one degrades a health display and nothing else.
 */
export const watcherTelemetryPayloadSchema = z
  .object({
    watcherId: z.string().min(1),
    event: z.discriminatedUnion('type', [
      z.object({ type: z.literal('watching') }).strict(),
      z
        .object({
          type: z.literal('status'),
          files: z
            .array(
              z
                .object({
                  relPath: z.string().min(1),
                  role: z.string().min(1),
                  failed: z.boolean().optional()
                })
                .strict()
            )
            .max(500)
        })
        .strict(),
      z
        .object({
          type: z.literal('error'),
          message: z.string().max(4096),
          relPath: z.string().min(1).optional()
        })
        .strict()
    ])
  })
  .strict();

// --- Acknowledgment payloads ---

/**
 * Payload of `runtime.resumeAck`, the server's half of the resume barrier.
 *
 * `runtime.resume` states which durable obligations the client still holds; this states
 * which of them the server already accepted. The client retires exactly those and replays
 * exactly the rest, which is why the barrier has to complete before any new command goes
 * out — until it does, the client cannot tell a lost message from a delivered one, and
 * guessing either way is a duplicated effect or a silent loss.
 */
export const resumeAckPayloadSchema = z
  .object({
    revision: snapshotRevisionSchema,
    workRevision: workRevisionSchema,
    acceptedMessageIds: z.array(z.string().min(1)).max(1000)
  })
  .strict();

/**
 * Payload of `runtime.accepted`, the server's receipt for one client message.
 *
 * This is what lets a producer retire an outbox record. It is deliberately its own message
 * rather than a field on some other reply: the record exists precisely because the process
 * may die before the receipt arrives, so the receipt cannot be tied to the liveness of the
 * request that produced it.
 *
 * The receipt itself is not durable, which is why it is classed as a reconciled snapshot
 * rather than a durable result. Losing one in flight costs nothing: the obligation stays in
 * the outbox and the next resume barrier reports it in `acceptedMessageIds`. What must never
 * happen is the reverse — a receipt read as evidence that work completed.
 */
export const acceptedPayloadSchema = z
  .object({
    acknowledgedMessageId: z.string().min(1),
    acknowledgedAt: z.string().datetime(),
    workAdmission: z
      .discriminatedUnion('status', [
        z.object({ status: z.literal('admitted'), workRevision: workRevisionSchema }).strict(),
        z
          .object({
            status: z.literal('rejected'),
            reason: z.literal('drainBarrierHeld'),
            barrierHolderId: z.string().min(1)
          })
          .strict()
      ])
      .optional()
  })
  .strict();

/** Durable proof that a runtime producer fsynced a server command into its effect journal. */
export const commandCustodyPayloadSchema = z
  .object({
    commandMessageId: z.string().min(1)
  })
  .strict();

// --- Catalogue ---

/**
 * Every message type in the protocol, mapped to its payload schema. This map is
 * the single place a new message is introduced; the authorization table and the
 * envelope parser both derive from it, so a message cannot exist without a
 * declared payload schema and an authorization entry.
 */
export const RUNTIME_MESSAGE_PAYLOADS = {
  'runtime.register': registerPayloadSchema,
  'runtime.resume': resumePayloadSchema,
  'runtime.capabilities': capabilitiesPayloadSchema,
  'runtime.liveness': livenessPayloadSchema,
  'runtime.resumeAck': resumeAckPayloadSchema,
  'runtime.accepted': acceptedPayloadSchema,
  'execution.commandCustody': commandCustodyPayloadSchema,
  'runtime.log': logPayloadSchema,
  'runtime.heartbeat': heartbeatPayloadSchema,
  'execution.launchRequest': launchRequestPayloadSchema,
  'execution.cancelRequest': cancelPayloadSchema,
  'execution.cancelCommand': cancelPayloadSchema,
  'execution.interactiveHandoff': interactiveHandoffPayloadSchema,
  'execution.switchToInteractiveRequest': switchToInteractiveRequestPayloadSchema,
  'execution.switchToInteractiveCommand': switchToInteractiveCommandPayloadSchema,
  'execution.shutdownRequest': shutdownRequestPayloadSchema,
  'execution.stopCommand': stopCommandPayloadSchema,
  'execution.executeRequest': executeRequestPayloadSchema,
  'execution.shutdownReadiness': shutdownReadinessPayloadSchema,
  'execution.workAdmission': workAdmissionPayloadSchema,
  'execution.launchAdmission': launchAdmissionPayloadSchema,
  'execution.launchOutcome': launchOutcomePayloadSchema,
  'execution.worktreeAssignmentResult': worktreeAssignmentResultPayloadSchema,
  'execution.commandEffectResult': commandEffectResultPayloadSchema,
  'execution.cleanupResult': cleanupResultPayloadSchema,
  'execution.branchCleanupRegistration': branchCleanupRegistrationPayloadSchema,
  'execution.branchCleanupEffect': branchCleanupEffectPayloadSchema,
  'watcher.stopRequest': watcherStopPayloadSchema,
  'watcher.stopCommand': watcherStopPayloadSchema,
  'watcher.stopResult': watcherStopResultPayloadSchema,
  'watcher.telemetry': watcherTelemetryPayloadSchema
} as const;

/** Every message type the runtime protocol defines. */
export type RuntimeMessageType = keyof typeof RUNTIME_MESSAGE_PAYLOADS;

/** All message types as a runtime-iterable list. */
export const RUNTIME_MESSAGE_TYPES = Object.keys(RUNTIME_MESSAGE_PAYLOADS) as RuntimeMessageType[];

/** Zod schema for {@link RuntimeMessageType}. */
export const runtimeMessageTypeSchema = z.enum(RUNTIME_MESSAGE_TYPES as [RuntimeMessageType, ...RuntimeMessageType[]]);

/** Parsed payload type for a given message type. */
export type RuntimePayload<TType extends RuntimeMessageType> = z.infer<(typeof RUNTIME_MESSAGE_PAYLOADS)[TType]>;

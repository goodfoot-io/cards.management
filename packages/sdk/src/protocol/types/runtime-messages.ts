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
    selectedAgent: z.string().min(1).optional()
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
 * Payload of `execution.interactiveHandoff`. The successor identity is
 * preallocated by the server and persisted with the continuation before
 * readiness is acknowledged, so a crash mid-handoff resolves to one successor
 * rather than none or two.
 */
export const interactiveHandoffPayloadSchema = z
  .object({
    successorExecutionId: z.string().min(1),
    continuation: inlineOrReferencedSchema
  })
  .strict();

/** Payload of `execution.switchToInteractiveCommand`. */
export const switchToInteractiveCommandPayloadSchema = z.object({}).strict();

/** Outcome a shutdown requester reports for the work it is finishing. */
export const shutdownOutcomeSchema = z.enum(['success', 'blocked', 'error']);

/** Payload of `execution.shutdownRequest`. */
export const shutdownRequestPayloadSchema = z
  .object({
    outcome: shutdownOutcomeSchema,
    message: z.string().max(4096).optional()
  })
  .strict();

/** Payload of `execution.agentShutdownCommand`. */
export const agentShutdownCommandPayloadSchema = z
  .object({
    shutdownRequestId: z.string().min(1),
    /** Work revision the drain authority was established for. */
    workRevision: workRevisionSchema
  })
  .strict();

/** Payload of `execution.executeRequest`. */
export const executeRequestPayloadSchema = z
  .object({
    actionId: z.string().min(1),
    environmentName: z.string().min(1),
    mode: executionModeSchema,
    exitWhenDone: z.boolean(),
    selectedAgent: z.string().min(1).optional()
  })
  .strict();

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
    message: z.string().max(4096).optional()
  })
  .strict();

/** How an agent's termination actually resolved. */
export const terminationResultSchema = z.enum(['graceful', 'forced', 'failed']);

/** Payload of `execution.agentTermination`. */
export const agentTerminationPayloadSchema = z
  .object({
    shutdownRequestId: z.string().min(1),
    /** Exact shutdown command completed by the wrapper handler. */
    commandMessageId: z.string().min(1),
    result: terminationResultSchema,
    message: z.string().max(4096).optional()
  })
  .strict();

/**
 * Payload of `execution.cleanupComplete`. `statusMutationDeferred` is true when
 * an offline finisher could not verify fresh execution authority: the terminal
 * result is still recorded durably, but the card status mutation is left to a
 * writer that can prove no newer execution supersedes it.
 */
export const cleanupCompletePayloadSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    lifecycleState: executionLifecycleStateSchema,
    statusMutationDeferred: z.boolean(),
    stderr: z.string().max(16384).optional()
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
    acknowledgedAt: z.string().datetime()
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
  'execution.switchToInteractiveCommand': switchToInteractiveCommandPayloadSchema,
  'execution.shutdownRequest': shutdownRequestPayloadSchema,
  'execution.agentShutdownCommand': agentShutdownCommandPayloadSchema,
  'execution.executeRequest': executeRequestPayloadSchema,
  'execution.shutdownReadiness': shutdownReadinessPayloadSchema,
  'execution.launchAdmission': launchAdmissionPayloadSchema,
  'execution.launchOutcome': launchOutcomePayloadSchema,
  'execution.agentTermination': agentTerminationPayloadSchema,
  'execution.cleanupComplete': cleanupCompletePayloadSchema,
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

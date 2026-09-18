/**
 * Post-barrier delivery of one live producer's durable outbox records.
 * @summary Role-scoped runtime client outbox drain
 * @module
 */

import type { ProducerRole, RuntimeMessageType } from '../../protocol/index.js';
import { type ClientOutbox, type DrainReport, drainOwnRecords, type OutboxRecord } from './outbox/index.js';
import type { OutboundMessage, RuntimeClient } from './types.js';

/** Inputs for one deterministic post-synchronization drain pass. */
export interface RuntimeClientDrainOptions {
  readonly client: RuntimeClient;
  readonly outbox: ClientOutbox;
  readonly executionId: string;
  readonly role: ProducerRole;
  readonly deadlineMs?: number;
  readonly now?: () => Date;
}

function outbound(record: OutboxRecord, deadlineMs: number | undefined): OutboundMessage<RuntimeMessageType> {
  const envelope = record.envelope;
  return {
    type: envelope.type,
    payload: envelope.payload,
    messageId: envelope.messageId,
    requestId: envelope.requestId,
    causationId: envelope.causationId,
    sentAt: envelope.sentAt,
    execution: envelope.execution,
    deadlineMs
  } as OutboundMessage<RuntimeMessageType>;
}

/**
 * Resends this connected producer's own records and retires only exact server acknowledgments.
 * @param options - Connected client, its outbox, and authenticated execution-role scope.
 * @returns The existing role-scoped drain report.
 */
export async function drainRuntimeClientOutbox(options: RuntimeClientDrainOptions): Promise<DrainReport> {
  const scan = await options.outbox.scan({ executionId: options.executionId, role: options.role });
  const records = new Map(scan.records.map((record) => [record.messageId, record]));
  return drainOwnRecords(
    options.outbox,
    { executionId: options.executionId, role: options.role },
    {
      settle: async (ref) => {
        const record = records.get(ref.messageId);
        if (record === undefined) return null;
        const result = await options.client.send(outbound(record, options.deadlineMs));
        if (result.status !== 'accepted' || result.messageId !== ref.messageId) return null;
        return { messageId: ref.messageId, acknowledgedAt: (options.now?.() ?? new Date()).toISOString() };
      }
    }
  );
}

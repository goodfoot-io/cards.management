/**
 * Read paths over the durable-result custody store.
 *
 * These exist so the server can answer a client asking "did you get it?" without
 * the client having to keep asking by resending. A resume barrier builds its
 * acknowledgment from what this store actually holds, which means the answer is
 * grounded in a file on disk rather than in an in-memory table that a restart
 * would have emptied.
 *
 * Both functions are reads in the sense that they change nothing, but
 * {@link describeDurableResult} is not merely data: a
 * {@link JournalAcknowledgment} is what retires an outbox record, so returning
 * one hands the caller the capability to retire the matching record. That is the
 * intended behaviour rather than a leak — if custody genuinely exists then
 * retirement genuinely is authorised, and the function answers `null` in exactly
 * the cases where it is not. It does mean this surface should not be handed to
 * anything that ought not to be able to retire.
 *
 * @summary Custody lookups backing server-side acknowledgment
 * @module runtime/durable-results/read
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JournalAcknowledgment, OutboxCorruption } from '../outbox/index.js';
import { custodyRecordsDir, readResultCustody, validateDurableResultCustodyRecord } from './store.js';
import { DURABLE_RESULT_SCHEMA_VERSION, type DurableResultCustodyRecord } from './types.js';

/**
 * What the globally keyed custody store holds for one execution.
 *
 * Corruption is reported beside the message IDs rather than folded into them,
 * because the two directions of error are not equally safe. A message ID left
 * out of `messageIds` costs a retransmission: the client still holds its copy and
 * sends again. A message ID wrongly included tells a client to let go of the only
 * copy of an obligation this store cannot actually produce. So an unparseable
 * file is always excluded — and reported here, because a silent exclusion would
 * make the safe behaviour an invisible one.
 */
export interface DurableResultInventory {
  /** Messages this store can prove custody of, in stable order. */
  readonly messageIds: readonly string[];
  /** Files that could not be trusted, and were therefore left out. */
  readonly corrupt: readonly OutboxCorruption[];
}

/**
 * Describes the custody this store holds for one message.
 *
 * The acknowledgment reports `custodiedAt` as the time of acceptance rather than
 * the time of this lookup. The obligation became safe to retire when the copy was
 * written, possibly several restarts ago, and stamping the present moment would
 * claim an acceptance that did not happen then.
 *
 * @param root - Absolute custody root, from `resolveDurableResultRoot`.
 * @param executionId - Execution the result belongs to.
 * @param messageId - Stable message identity.
 * @returns An acknowledgment when custody is held and readable, `null` otherwise.
 */
export async function describeDurableResult(
  root: string,
  executionId: string,
  messageId: string
): Promise<JournalAcknowledgment | null> {
  let held: DurableResultCustodyRecord | null;
  try {
    held = await readResultCustody(root, executionId, messageId);
  } catch {
    // A custody record that will not parse is a custody that cannot be proven,
    // which is the same thing to a caller as not holding it at all. Throwing
    // would be worse than useless here: this answer feeds an acknowledgment for
    // a whole batch, and one unreadable file must not poison the rest of it. The
    // file is still reported by listDurableResults, which is where corruption is
    // meant to be visible.
    return null;
  }
  if (held === null) {
    return null;
  }
  return { messageId: held.messageId, acknowledgedAt: held.custodiedAt };
}

function parseCustody(text: string, filePath: string): DurableResultCustodyRecord | OutboxCorruption {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { path: filePath, detail: `unparseable: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { path: filePath, detail: 'not a JSON object' };
  }
  const candidate = parsed as Partial<DurableResultCustodyRecord>;
  if (candidate.schemaVersion !== DURABLE_RESULT_SCHEMA_VERSION) {
    return { path: filePath, detail: `unknown schema version: ${String(candidate.schemaVersion)}` };
  }
  if (typeof candidate.messageId !== 'string') {
    return { path: filePath, detail: 'missing or non-string field: messageId' };
  }
  return (
    validateDurableResultCustodyRecord(parsed) ?? {
      path: filePath,
      detail: 'custody record is incomplete or its canonical identity does not match'
    }
  );
}

/**
 * Lists everything this store holds for one execution.
 *
 * The message IDs come out of the files rather than out of their names, because
 * the names are digests and a digest does not reverse. That the custody record
 * self-describes is what makes this listing possible at all.
 *
 * @param root - Absolute custody root, from `resolveDurableResultRoot`.
 * @param executionId - Execution whose custody is being listed.
 * @returns Message IDs held, plus any files that could not be trusted.
 */
export async function listDurableResults(root: string, executionId: string): Promise<DurableResultInventory> {
  const dir = custodyRecordsDir(root);

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messageIds: [], corrupt: [] };
    }
    throw error;
  }

  const messageIds: string[] = [];
  const corrupt: OutboxCorruption[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(dir, name);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      corrupt.push({ path: filePath, detail: `unreadable: ${(error as Error).message}` });
      continue;
    }
    const parsed = parseCustody(text, filePath);
    if ('schemaVersion' in parsed) {
      if (parsed.executionId === executionId) messageIds.push(parsed.messageId);
    } else {
      corrupt.push(parsed);
    }
  }
  return { messageIds, corrupt };
}

/** Both custody lookups, bound to one root. */
export interface DurableResultReader {
  /**
   * Describes the custody held for one message.
   *
   * @param executionId - Execution the result belongs to.
   * @param messageId - Stable message identity.
   * @returns An acknowledgment when custody is held, `null` otherwise.
   */
  describe(executionId: string, messageId: string): Promise<JournalAcknowledgment | null>;

  /**
   * Lists everything held for one execution.
   *
   * @param executionId - Execution whose custody is being listed.
   * @returns Message IDs held, plus any files that could not be trusted.
   */
  list(executionId: string): Promise<DurableResultInventory>;
}

/**
 * Binds both lookups to one custody root.
 *
 * Preferred over the free functions for anything that reads the store more than
 * once: the root is resolved by configuration exactly once, at construction, and
 * cannot drift between calls.
 *
 * @param root - Absolute custody root, from `resolveDurableResultRoot`.
 * @returns A reader over that root.
 */
export function createDurableResultReader(root: string): DurableResultReader {
  return {
    describe: (executionId, messageId) => describeDurableResult(root, executionId, messageId),
    list: (executionId) => listDurableResults(root, executionId)
  };
}

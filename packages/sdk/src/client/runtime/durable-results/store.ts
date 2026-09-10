/**
 * Durable custody store for terminal results recovered from an exited producer.
 *
 * This is the party that answers `accepted` when startup reconciliation offers it
 * a `durable-result` record, and the answer is only honest because this module
 * writes and flushes its own copy of the envelope first. Reconciliation deletes
 * the producer's copy on the strength of that answer, so an implementation that
 * merely recognised a record — read the journal, matched an execution, returned
 * yes — would leave the obligation held by nobody at all. Custody, not
 * recognition, is the contract.
 *
 * The layout is deliberately flatter than the outbox's:
 *
 * ```text
 * <root>/<sha256(executionId)>/<sha256(messageId)>.json
 * ```
 *
 * There is no role segment. The outbox needs one because a live producer must be
 * able to drain its own obligations without ever listing another role's; nothing
 * drains this store, so a role directory would buy nothing and would let the same
 * message land twice under two roles.
 *
 * Both identifiers are hashed before they reach a path join, for the same reason
 * as in the outbox: they originate with callers, and a caller-supplied string in
 * a path is a traversal waiting to happen.
 *
 * The write path goes one step further than the outbox's, and the extra step is
 * the point of the module. The outbox flushes the file and links it; this store
 * also flushes the *directory* after linking. A file's contents surviving a power
 * loss is no use if the directory entry naming it does not, and this copy is the
 * last one — the producer's is about to be unlinked on the strength of this
 * write. The outbox can afford to skip it because its records are the redundant
 * copy by construction.
 *
 * @summary File-per-message custody store for recovered terminal results
 * @module runtime/durable-results/store
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OutboxRecord, OutcomeAcceptance, RecoveredResultCustodian } from '../outbox/index.js';
import { DURABLE_RESULT_SCHEMA_VERSION, type DurableResultCustodyRecord } from './types.js';

/**
 * Resolves the custody root inside the protected Cards runtime directory.
 *
 * Sits beside the outbox and the admission journal under one directory the
 * card-cache reset and rebuild paths never name. It is emphatically not under any
 * card repository's git dir: a terminal result must not become staged content, or
 * be lost when a worktree is discarded, and the outbox exists precisely to get
 * obligations out of card repositories in the first place.
 *
 * @param globalConfigDir - Cards global configuration directory.
 * @param edhId - Extension development host ID, when running under one.
 * @returns Absolute path of the custody root.
 */
export function resolveDurableResultRoot(globalConfigDir: string, edhId?: string): string {
  return edhId
    ? path.join(globalConfigDir, 'edh', edhId, 'runtime', 'durable-results')
    : path.join(globalConfigDir, 'runtime', 'durable-results');
}

/** Construction options for {@link createFileResultCustodian}. */
export interface FileResultCustodianOptions {
  /** Absolute custody root, from {@link resolveDurableResultRoot}. Never caller-supplied. */
  readonly root: string;
  /** Clock source, injected so custody timestamps are deterministic in tests. */
  readonly now?: () => Date;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Computes the one path a custody record may occupy.
 *
 * @param root - Absolute custody root.
 * @param executionId - Execution the result belongs to.
 * @param messageId - Stable message identity.
 * @returns Absolute path of the custody file.
 */
function custodyPath(root: string, executionId: string, messageId: string): string {
  return path.join(root, digest(executionId), `${digest(messageId)}.json`);
}

/**
 * Flushes a directory entry so a linked file survives power loss.
 *
 * Opening a directory for read and syncing it is the portable way to do this.
 * Some platforms refuse the open or the sync outright; that is not a failure of
 * the write, so it is swallowed rather than turned into a refusal that would
 * strand a perfectly good record.
 *
 * @param dir - Directory whose entries must be durable.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close();
  }
}

/**
 * Writes one custody record atomically, idempotent on its message ID.
 *
 * Returns whether this call created the copy or found one already there. Both are
 * custody: a reconciliation pass that crashed after writing and before retiring
 * must be able to run again and reach the same conclusion.
 *
 * @param root - Absolute custody root.
 * @param record - The recovered result to take custody of.
 * @param now - Clock supplying the custody timestamp.
 * @returns `created` on first write, `exists` when this message is already held.
 */
export async function takeResultCustody(
  root: string,
  record: OutboxRecord,
  now: () => Date
): Promise<'created' | 'exists'> {
  const target = custodyPath(root, record.executionId, record.messageId);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  const custody: DurableResultCustodyRecord = {
    schemaVersion: DURABLE_RESULT_SCHEMA_VERSION,
    messageId: record.messageId,
    executionId: record.executionId,
    requestId: record.requestId,
    envelope: record.envelope,
    custodiedAt: now().toISOString()
  };

  const temp = path.join(dir, `.tmp-${randomUUID()}`);
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(custody, null, 2)}\n`, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  let outcome: 'created' | 'exists';
  try {
    await fs.link(temp, target);
    outcome = 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    outcome = 'exists';
  } finally {
    await fs.rm(temp, { force: true });
  }

  await syncDirectory(dir);
  return outcome;
}

/**
 * Reads back one custody record, for callers that must confirm a copy exists.
 *
 * @param root - Absolute custody root.
 * @param executionId - Execution the result belongs to.
 * @param messageId - Stable message identity.
 * @returns The stored record, or `null` when nothing is held for that message.
 */
export async function readResultCustody(
  root: string,
  executionId: string,
  messageId: string
): Promise<DurableResultCustodyRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(custodyPath(root, executionId, messageId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const parsed = JSON.parse(text) as DurableResultCustodyRecord;
  return parsed.schemaVersion === DURABLE_RESULT_SCHEMA_VERSION ? parsed : null;
}

/**
 * Builds the custodian reconciliation routes recovered results to.
 *
 * Every failure becomes `authority-unavailable` rather than an exception. A
 * custodian that throws would abort the whole reconciliation pass and strand
 * every record after it; a custodian that reports unavailability leaves this one
 * record on disk, keeps `ok` false, and lets the pass continue.
 *
 * @param options - Root directory and optional clock.
 * @returns A custodian that takes durable custody before acknowledging.
 */
export function createFileResultCustodian(options: FileResultCustodianOptions): RecoveredResultCustodian {
  const { root } = options;
  const now = options.now ?? ((): Date => new Date());

  return {
    takeCustody: async (record: OutboxRecord): Promise<OutcomeAcceptance> => {
      // Checked even though the router already routed on it. This function's
      // answer authorises deleting the only other copy, and a misrouted intent
      // getting waved through here would be silent.
      if (record.deliveryClass !== 'durable-result') {
        return {
          kind: 'authority-unavailable',
          detail: `custodian holds durable results only, was offered '${String(record.deliveryClass)}'`
        };
      }

      try {
        await takeResultCustody(root, record, now);
      } catch (error) {
        return { kind: 'authority-unavailable', detail: `custody write failed: ${(error as Error).message}` };
      }

      return {
        kind: 'accepted',
        acknowledgment: { messageId: record.messageId, acknowledgedAt: now().toISOString() }
      };
    }
  };
}

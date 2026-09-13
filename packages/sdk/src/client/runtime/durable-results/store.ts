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
 * <root>/records/<sha256(messageId)>.json
 * ```
 *
 * There is no role segment. The outbox needs one because a live producer must be
 * able to drain its own obligations without ever listing another role's; nothing
 * drains this store, so a role directory would buy nothing and would let the same
 * message land twice under two roles.
 *
 * The globally unique message ID is hashed before it reaches a path join. Keeping
 * one global target per message is also what makes execution or scope drift on a
 * replay observable as a conflict rather than a second accepted copy.
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
import {
  deliveryClassFor,
  parseEnvelope,
  RUNTIME_MESSAGE_CONTRACTS,
  type RuntimeEnvelope
} from '../../../protocol/index.js';
import type { OutboxRecord, OutcomeAcceptance, RecoveredResultCustodian } from '../outbox/index.js';
import {
  DURABLE_RESULT_SCHEMA_VERSION,
  type DurableResultCustodyInput,
  type DurableResultCustodyOutcome,
  type DurableResultCustodyRecord
} from './types.js';

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
 * Computes the directory holding globally message-keyed custody records.
 *
 * @param root - Absolute custody root.
 * @returns Absolute path of the custody records directory.
 */
export function custodyRecordsDir(root: string): string {
  return path.join(root, 'records');
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
  void executionId;
  return path.join(custodyRecordsDir(root), `${digest(messageId)}.json`);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('undefined has no canonical JSON representation');
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(',')}}`;
}

function fingerprint(requestId: string, envelope: RuntimeEnvelope, canonicalEnvelope: string): string {
  return digest(
    canonicalJson({
      requestId,
      executionId: envelope.execution?.executionId,
      scope: envelope.scope,
      envelope: JSON.parse(canonicalEnvelope)
    })
  );
}

/**
 * Strictly validates persisted custody and recomputes its canonical identity.
 *
 * @param raw - Parsed but untrusted storage content.
 * @returns The verified record, or null when any persisted evidence is incomplete or inconsistent.
 */
export function validateDurableResultCustodyRecord(raw: unknown): DurableResultCustodyRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Partial<DurableResultCustodyRecord>;
  if (
    record.schemaVersion !== DURABLE_RESULT_SCHEMA_VERSION ||
    typeof record.messageId !== 'string' ||
    typeof record.executionId !== 'string' ||
    typeof record.requestId !== 'string' ||
    typeof record.fingerprint !== 'string' ||
    typeof record.canonicalEnvelope !== 'string' ||
    typeof record.custodiedAt !== 'string' ||
    record.envelope === undefined
  )
    return null;
  let envelope: RuntimeEnvelope;
  try {
    envelope = parseEnvelope(record.envelope);
  } catch {
    return null;
  }
  if (
    canonicalJson(envelope) !== record.canonicalEnvelope ||
    envelope.messageId !== record.messageId ||
    envelope.execution?.executionId !== record.executionId ||
    fingerprint(record.requestId, envelope, record.canonicalEnvelope) !== record.fingerprint
  )
    return null;
  return record as DurableResultCustodyRecord;
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes one custody record atomically, comparing the complete immutable identity on replay.
 *
 * Returns whether this call created the copy or found one already there. Both are
 * custody: a reconciliation pass that crashed after writing and before retiring
 * must be able to run again and reach the same conclusion.
 *
 * @param root - Absolute custody root.
 * @param input - Validated result envelope plus server-resolved original request ID.
 * @param now - Clock supplying the custody timestamp.
 * @returns Created or matching custody with acknowledgment, conflict, or unavailable.
 */
export async function takeResultCustody(
  root: string,
  input: DurableResultCustodyInput,
  now: () => Date
): Promise<DurableResultCustodyOutcome> {
  let envelope: RuntimeEnvelope;
  let canonicalEnvelope: string;
  try {
    const candidate = input.envelope as RuntimeEnvelope;
    const candidateContract = RUNTIME_MESSAGE_CONTRACTS[candidate.type];
    const candidateCanonical = canonicalJson(input.envelope);
    if (
      candidateContract !== undefined &&
      Buffer.byteLength(candidateCanonical, 'utf8') > candidateContract.maxFrameBytes
    ) {
      return {
        status: 'unavailable',
        detail: `canonical envelope exceeds ${candidateContract.maxFrameBytes}-byte protocol bound`
      };
    }
    envelope = parseEnvelope(input.envelope);
    canonicalEnvelope = canonicalJson(envelope);
  } catch (error) {
    return { status: 'unavailable', detail: `invalid durable-result envelope: ${(error as Error).message}` };
  }
  const contract = RUNTIME_MESSAGE_CONTRACTS[envelope.type];
  if (deliveryClassFor(envelope.type) !== 'durable-result') {
    return { status: 'unavailable', detail: `message type '${envelope.type}' is not durable-result` };
  }
  if (Buffer.byteLength(canonicalEnvelope, 'utf8') > contract.maxFrameBytes) {
    return {
      status: 'unavailable',
      detail: `canonical envelope exceeds ${contract.maxFrameBytes}-byte protocol bound`
    };
  }
  const executionId = envelope.execution?.executionId;
  if (typeof executionId !== 'string' || input.requestId.length === 0) {
    return { status: 'unavailable', detail: 'durable result lacks authoritative request or execution identity' };
  }
  if (
    envelope.execution?.launchRequestId !== input.requestId ||
    (envelope.requestId !== undefined && envelope.requestId !== input.requestId)
  ) {
    return { status: 'conflict', detail: 'envelope request identity conflicts with authoritative request' };
  }

  const identityFingerprint = fingerprint(input.requestId, envelope, canonicalEnvelope);
  const target = custodyPath(root, executionId, envelope.messageId);
  const dir = path.dirname(target);
  const custody: DurableResultCustodyRecord = {
    schemaVersion: DURABLE_RESULT_SCHEMA_VERSION,
    messageId: envelope.messageId,
    executionId,
    requestId: input.requestId,
    fingerprint: identityFingerprint,
    canonicalEnvelope,
    envelope,
    custodiedAt: now().toISOString()
  };

  try {
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.tmp-${randomUUID()}`);
    let linked = false;
    try {
      const handle = await fs.open(temp, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(custody, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temp, target);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
    if (linked) {
      await syncDirectory(dir);
      return {
        status: 'created',
        acknowledgment: { messageId: envelope.messageId, acknowledgedAt: custody.custodiedAt }
      };
    }
    const existing = await readCustodyByMessage(root, envelope.messageId);
    if (existing === null) return { status: 'unavailable', detail: 'existing custody record is corrupt or incomplete' };
    if (existing.fingerprint !== identityFingerprint || existing.canonicalEnvelope !== canonicalEnvelope) {
      return { status: 'conflict', detail: 'messageId is already held for different immutable content or identity' };
    }
    return {
      status: 'matching',
      acknowledgment: { messageId: existing.messageId, acknowledgedAt: existing.custodiedAt }
    };
  } catch (error) {
    return { status: 'unavailable', detail: `custody storage unavailable: ${(error as Error).message}` };
  }
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
  const record = await readCustodyByMessage(root, messageId);
  return record?.executionId === executionId ? record : null;
}

/**
 * Lists custody records for one execution; unreadable records make the inspection fail closed.
 * @param root - Protected durable-result custody root.
 * @param executionId - Exact execution to inspect.
 * @returns Every valid custody record belonging to the execution.
 */
export async function listResultCustodyForExecution(
  root: string,
  executionId: string
): Promise<readonly DurableResultCustodyRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(custodyRecordsDir(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: DurableResultCustodyRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const parsed = await readCustodyByMessagePath(path.join(custodyRecordsDir(root), name));
    if (parsed === null) throw new Error(`Unreadable durable result custody record: ${name}`);
    if (parsed.executionId === executionId) records.push(parsed);
  }
  return records;
}

async function readCustodyByMessagePath(file: string): Promise<DurableResultCustodyRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    return validateDurableResultCustodyRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

async function readCustodyByMessage(root: string, messageId: string): Promise<DurableResultCustodyRecord | null> {
  let text: string;
  try {
    text = await fs.readFile(custodyPath(root, '', messageId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = validateDurableResultCustodyRecord(parsed);
  return record;
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
        const outcome = await takeResultCustody(
          root,
          { requestId: record.requestId, envelope: record.envelope as DurableResultCustodyInput['envelope'] },
          now
        );
        if (outcome.status === 'created' || outcome.status === 'matching') {
          return { kind: 'accepted', acknowledgment: outcome.acknowledgment };
        }
        const detail = 'detail' in outcome ? outcome.detail : 'custody returned no acknowledgment';
        return {
          kind: outcome.status === 'conflict' ? 'not-admitted' : 'authority-unavailable',
          detail
        };
      } catch (error) {
        return { kind: 'authority-unavailable', detail: `custody write failed: ${(error as Error).message}` };
      }
    }
  };
}

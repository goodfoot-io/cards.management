/**
 * File-backed implementation of the client outbox.
 *
 * The storage model is one file per message, laid out so that both consumers get
 * what they need from a directory listing alone:
 *
 * ```text
 * <root>/<sha256(executionId)>/<role>/<sha256(messageId)>.json
 * ```
 *
 * A wrapper draining its own obligations reads exactly one directory, so a busy
 * store never makes a role-scoped drain proportional to everyone else's traffic.
 * Server startup, which must see everything, walks the two levels above it. The
 * role is a path segment rather than a field to filter on because that is what
 * makes the scoping structural: a caller cannot accidentally list another role's
 * records, since it never opens that directory.
 *
 * Both identifiers are hashed before they reach a path join. Execution IDs and
 * message IDs originate with callers, and a caller-supplied string in a path is
 * a traversal waiting to happen. The role is not hashed — it is drawn from a
 * closed set this module validates against, so it is safe as a readable segment,
 * and a readable segment is worth a lot when an operator is looking at the store.
 *
 * Creation goes through a temp file and `link()`, never `rename()`. Both are
 * atomic, but they fail differently under a race, and the difference matters:
 * `rename()` silently replaces, so two producers writing the same message ID
 * would leave the second one believing it created something new. `link()` fails
 * with `EEXIST`, which is the honest answer and the one idempotency needs.
 *
 * @summary File-per-message outbox store, its layout, and its atomic write path
 * @module runtime/outbox/store
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PRODUCER_ROLES, type ProducerRole } from '../../../protocol/index.js';
import {
  type ClientOutbox,
  type EnqueueResult,
  type JournalAcknowledgment,
  OUTBOX_DELIVERY_CLASSES,
  OUTBOX_SCHEMA_VERSION,
  type OutboxCorruption,
  type OutboxDrainScope,
  type OutboxRecord,
  type OutboxRecordInput,
  type OutboxRecordRef,
  type OutboxScanResult,
  type RetirementResult
} from './types.js';

/**
 * Resolves the outbox root inside the protected Cards runtime directory.
 *
 * Mirrors the admission journal's layout so that runtime authority and producer
 * recovery storage sit side by side under one directory the card-cache reset and
 * rebuild paths never name.
 *
 * @param globalConfigDir - Cards global configuration directory.
 * @param edhId - Extension development host ID, when running under one.
 * @returns Absolute path of the outbox root.
 */
export function resolveOutboxRoot(globalConfigDir: string, edhId?: string): string {
  return edhId
    ? path.join(globalConfigDir, 'edh', edhId, 'runtime', 'outbox')
    : path.join(globalConfigDir, 'runtime', 'outbox');
}

/** Construction options for {@link createFileClientOutbox}. */
export interface FileClientOutboxOptions {
  /** Absolute outbox root, from {@link resolveOutboxRoot}. Never caller-supplied. */
  readonly root: string;
  /** Clock source, injected so enqueue timestamps are deterministic in tests. */
  readonly now?: () => Date;
}

/**
 * Builds a file-backed outbox over one root directory.
 *
 * @param options - Root directory and optional clock.
 * @returns The store, ready to enqueue, scan, and retire.
 */
export function createFileClientOutbox(options: FileClientOutboxOptions): ClientOutbox {
  const { root } = options;
  const now = options.now ?? ((): Date => new Date());
  return {
    enqueue: (input) => enqueueRecord(root, input, now),
    scan: (scope) => scanScope(root, scope),
    scanAll: () => scanAllRecords(root),
    refFor: (record) => refFor(root, record),
    retire: (ref, ack) => retireRecord(root, ref, ack)
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertKnownRole(role: ProducerRole): void {
  if (!PRODUCER_ROLES.includes(role)) {
    throw new Error(`Unknown producer role: ${String(role)}`);
  }
}

/**
 * Computes the one path a record may occupy.
 *
 * Both caller-supplied identifiers become digests here, which is the only place
 * they are allowed to influence a path at all.
 *
 * @param root - Absolute outbox root.
 * @param executionId - Execution the record belongs to.
 * @param role - Producing role, validated against the closed set.
 * @param messageId - Stable message identity.
 * @returns Absolute path of the record file.
 */
function recordPath(root: string, executionId: string, role: ProducerRole, messageId: string): string {
  assertKnownRole(role);
  return path.join(root, digest(executionId), role, `${digest(messageId)}.json`);
}

/**
 * Writes one record atomically, idempotent on its message ID.
 *
 * @param root - Absolute outbox root.
 * @param input - The obligation to persist.
 * @param now - Clock supplying the enqueue timestamp.
 * @returns `created` on first write, `exists` when the message ID is already stored.
 * @throws {Error} When the role is outside the protocol's closed set, or the
 *   delivery class is one the outbox refuses to retain.
 */
export async function enqueueRecord(root: string, input: OutboxRecordInput, now: () => Date): Promise<EnqueueResult> {
  assertKnownRole(input.role);
  if (!OUTBOX_DELIVERY_CLASSES.includes(input.deliveryClass)) {
    throw new Error(`Outbox refuses delivery class: ${String(input.deliveryClass)}`);
  }

  const target = recordPath(root, input.executionId, input.role, input.messageId);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });

  const record: OutboxRecord = {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    messageId: input.messageId,
    executionId: input.executionId,
    requestId: input.requestId,
    role: input.role,
    deliveryClass: input.deliveryClass,
    envelope: input.envelope,
    enqueuedAt: now().toISOString()
  };

  // Written under a name `scan` never lists, so a reader cannot observe a
  // partially written file even before the link makes it visible.
  const temp = path.join(dir, `.tmp-${randomUUID()}`);
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.link(temp, target);
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return 'exists';
    }
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function parseRecord(text: string, filePath: string): OutboxRecord | OutboxCorruption {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { path: filePath, detail: `unparseable: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { path: filePath, detail: 'not a JSON object' };
  }
  const candidate = parsed as Partial<OutboxRecord>;
  if (candidate.schemaVersion !== OUTBOX_SCHEMA_VERSION) {
    return { path: filePath, detail: `unknown schema version: ${String(candidate.schemaVersion)}` };
  }
  for (const field of ['messageId', 'executionId', 'requestId', 'role', 'deliveryClass', 'enqueuedAt'] as const) {
    if (typeof candidate[field] !== 'string') {
      return { path: filePath, detail: `missing or non-string field: ${field}` };
    }
  }
  if (candidate.envelope === undefined || candidate.envelope === null) {
    return { path: filePath, detail: 'missing field: envelope' };
  }
  return candidate as OutboxRecord;
}

async function readDirectory(dir: string): Promise<OutboxScanResult> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], corrupt: [] };
    }
    throw error;
  }

  const records: OutboxRecord[] = [];
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
    const parsed = parseRecord(text, filePath);
    if ('schemaVersion' in parsed) {
      records.push(parsed);
    } else {
      corrupt.push(parsed);
    }
  }
  return { records, corrupt };
}

/**
 * Lists the records belonging to one execution-and-role scope.
 *
 * @param root - Absolute outbox root.
 * @param scope - Execution and authenticated role of the caller.
 * @returns Readable records plus any corruption found while scanning.
 * @throws {Error} When the role is outside the protocol's closed set.
 */
export async function scanScope(root: string, scope: OutboxDrainScope): Promise<OutboxScanResult> {
  assertKnownRole(scope.role);
  return readDirectory(path.join(root, digest(scope.executionId), scope.role));
}

/**
 * Lists every record in the store, for startup reconciliation.
 *
 * @param root - Absolute outbox root.
 * @returns Every readable record plus any corruption found while scanning.
 */
export async function scanAllRecords(root: string): Promise<OutboxScanResult> {
  let executions: string[];
  try {
    executions = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], corrupt: [] };
    }
    throw error;
  }

  const records: OutboxRecord[] = [];
  const corrupt: OutboxCorruption[] = [];
  for (const execution of executions.sort()) {
    for (const role of PRODUCER_ROLES) {
      const found = await readDirectory(path.join(root, execution, role));
      records.push(...found.records);
      corrupt.push(...found.corrupt);
    }
  }
  return { records, corrupt };
}

/**
 * Deletes one record against an acknowledgment naming it.
 *
 * The path is recomputed from the reference's identifiers rather than trusted as
 * given. A reference travels through callers, and honouring a `path` field
 * verbatim would make this function an arbitrary-unlink primitive; recomputing
 * means a fabricated path can only ever name the record it claims to be.
 *
 * @param root - Absolute outbox root.
 * @param ref - The record to retire.
 * @param ack - Journal acknowledgment that must name the same message.
 * @returns Whether the record was retired, already gone, or refused.
 */
export async function retireRecord(
  root: string,
  ref: OutboxRecordRef,
  ack: JournalAcknowledgment
): Promise<RetirementResult> {
  if (ack.messageId !== ref.messageId) {
    return {
      kind: 'refused',
      detail: `acknowledgment names ${ack.messageId}, record is ${ref.messageId}`
    };
  }

  let target: string;
  try {
    target = recordPath(root, ref.executionId, ref.role, ref.messageId);
  } catch (error) {
    return { kind: 'refused', detail: (error as Error).message };
  }

  try {
    await fs.unlink(target);
    return { kind: 'retired' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'already-retired' };
    }
    throw error;
  }
}

/**
 * Builds the reference naming where one record lives.
 *
 * @param root - Absolute outbox root.
 * @param record - The record to describe.
 * @returns A reference carrying its identifiers and its computed path.
 */
export function refFor(root: string, record: OutboxRecord): OutboxRecordRef {
  return {
    messageId: record.messageId,
    executionId: record.executionId,
    role: record.role,
    path: recordPath(root, record.executionId, record.role, record.messageId)
  };
}

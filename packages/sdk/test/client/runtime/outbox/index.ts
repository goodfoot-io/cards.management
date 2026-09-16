/**
 * Shared fixtures for the client outbox suites: temporary roots, a deterministic
 * clock, canonical record builders, and the two ports the module is built
 * against.
 *
 * The acceptor and the delivery are real in-memory implementations rather than
 * mocks, because what these suites assert is how the outbox reacts to each
 * *answer* a journal can give — accepted, refused, or unavailable. A scripted
 * fake that returns those answers is the subject of the test, not a stand-in for
 * one.
 *
 * @summary Fixtures for client outbox tests
 * @module test/runtime/outbox
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  DrainDelivery,
  JournalAcknowledgment,
  OutboxRecord,
  OutboxRecordInput,
  OutboxRecordRef,
  OutcomeAcceptance,
  ReconciliationAuthorities
} from '../../../../src/client/runtime/outbox/index.js';
import { RUNTIME_PROTOCOL_VERSION } from '../../../../src/protocol/index.js';

/**
 * Creates an empty outbox root under the OS temp directory.
 *
 * @returns Absolute path of a fresh directory the caller must remove.
 */
export function makeOutboxRoot(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'outbox-'));
}

/** Options for {@link makeRecordInput}, all defaulted to a canonical result. */
export interface RecordInputOverrides {
  readonly messageId?: string;
  readonly executionId?: string;
  readonly requestId?: string;
  readonly role?: OutboxRecordInput['role'];
  readonly deliveryClass?: OutboxRecordInput['deliveryClass'];
}

/**
 * Builds a valid record input carrying a real `execution.cleanupResult` envelope.
 *
 * @param overrides - Fields to vary; everything else is canonical.
 * @returns A record input the store will accept.
 */
export function makeRecordInput(overrides: RecordInputOverrides = {}): OutboxRecordInput {
  const messageId = overrides.messageId ?? 'msg-1';
  const executionId = overrides.executionId ?? 'exec-1';
  const requestId = overrides.requestId ?? 'req-1';
  return {
    messageId,
    executionId,
    requestId,
    role: overrides.role ?? 'runtime-wrapper',
    deliveryClass: overrides.deliveryClass ?? 'durable-result',
    envelope: {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      messageId,
      sentAt: '2026-09-10T12:00:00.000Z',
      execution: { executionId, launchRequestId: requestId },
      scope: { repositoryId: 'github.com/org/repo', workspacePath: '/workspace', cardId: 'main-1' },
      producer: { producerId: 'wrapper-1', role: 'runtime-wrapper' },
      ownership: { ownerId: 'wrapper-1', generation: 1 },
      type: 'execution.cleanupResult',
      payload: {
        terminalDecisionId: 'terminal:exec-1',
        observationId: 'obs-1',
        trigger: 'root-exit',
        status: 'drained',
        phase: 'graceful',
        rootExit: { code: 0, signal: null },
        finalization: 'complete'
      }
    }
  };
}

/**
 * Builds a record input carrying a real `execution.launchRequest` envelope.
 *
 * This is the one durable intent reconciliation may retire on a validator's
 * word, because admission's own record of the request is already a durable copy.
 *
 * @param overrides - Fields to vary; everything else is canonical.
 * @returns A launch-intent record input the store will accept.
 */
export function makeLaunchIntentInput(overrides: RecordInputOverrides = {}): OutboxRecordInput {
  const base = makeRecordInput({ ...overrides, deliveryClass: 'durable-intent' });
  return {
    ...base,
    envelope: {
      ...base.envelope,
      type: 'execution.launchRequest',
      payload: {
        actionId: 'action-1',
        environmentName: 'default',
        mode: 'background',
        exitWhenDone: true
      }
    }
  };
}

/**
 * Builds a record input carrying a durable intent nothing durably holds yet.
 *
 * `execution.cancelRequest` stands in for the whole unowned bucket — cancels,
 * shutdown requests, watcher stops — whose custodian milestone 3 builds.
 *
 * @param overrides - Fields to vary; everything else is canonical.
 * @returns An unowned-intent record input the store will accept.
 */
export function makeUnownedIntentInput(overrides: RecordInputOverrides = {}): OutboxRecordInput {
  const base = makeRecordInput({ ...overrides, deliveryClass: 'durable-intent' });
  return {
    ...base,
    envelope: {
      ...base.envelope,
      type: 'execution.cancelRequest',
      payload: { reason: 'user', overridesIdleRequirement: false }
    }
  };
}

/**
 * Builds an acknowledgment naming one message.
 *
 * @param messageId - Message the journal is said to have accepted.
 * @returns An acknowledgment the store will accept for that message.
 */
export function ackFor(messageId: string): JournalAcknowledgment {
  return { messageId, acknowledgedAt: '2026-09-10T12:00:01.000Z' };
}

/**
 * Authorities that answer every record the same way, recording which port ran.
 *
 * Keeping the two offer logs separate is the point: routing is the behaviour
 * under test, so a check has to be able to say not just what was decided but
 * which authority was asked.
 *
 * @param answer - Builds the answer for one record.
 * @returns The authorities plus the records each port was offered, in order.
 */
export function scriptedAuthorities(answer: (record: OutboxRecord) => OutcomeAcceptance): {
  authorities: ReconciliationAuthorities;
  custodied: OutboxRecord[];
  validated: OutboxRecord[];
} {
  const custodied: OutboxRecord[] = [];
  const validated: OutboxRecord[] = [];
  return {
    custodied,
    validated,
    authorities: {
      resultCustodian: {
        takeCustody: (record) => {
          custodied.push(record);
          return Promise.resolve(answer(record));
        }
      },
      launchIntentValidator: {
        validateRecoveredObligation: (record) => {
          validated.push(record);
          return Promise.resolve(answer(record));
        }
      }
    }
  };
}

/**
 * A delivery that acknowledges only the messages named.
 *
 * @param acknowledged - Message IDs the journal durably accepts.
 * @returns A delivery plus the refs it was asked to settle, in order.
 */
export function scriptedDelivery(acknowledged: readonly string[]): {
  delivery: DrainDelivery;
  settled: OutboxRecordRef[];
} {
  const settled: OutboxRecordRef[] = [];
  return {
    settled,
    delivery: {
      settle: (ref) => {
        settled.push(ref);
        return Promise.resolve(acknowledged.includes(ref.messageId) ? ackFor(ref.messageId) : null);
      }
    }
  };
}

/**
 * Counts every record file under a root, whatever its execution or role.
 *
 * @param root - Absolute outbox root.
 * @returns Number of `.json` files present.
 */
export function countRecordFiles(root: string): number {
  return listRecordFiles(root).length;
}

/**
 * Lists every record file under a root, for asserting what survived.
 *
 * @param root - Absolute outbox root.
 * @returns Absolute paths of every `.json` file present, sorted.
 */
export function listRecordFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json')) {
        found.push(full);
      }
    }
  };
  if (fs.existsSync(root)) {
    walk(root);
  }
  return found.sort();
}

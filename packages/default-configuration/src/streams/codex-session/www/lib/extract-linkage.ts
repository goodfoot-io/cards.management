/**
 * Explicit Codex cross-thread events remain references pending captured qualification.
 * Only session metadata establishes source identity; inherited caller history cannot do so.
 * @summary Codex native linkage extraction
 * @module streams/codex-session/www/lib/extract-linkage
 */

import {
  type LinkageRecord,
  linkageIdentifier,
  linkageObject,
  type NativeDelegationEvidence,
  type NativeLinkageDiagnostic,
  readLinkageRecords,
  type SourceLinkageEvidence
} from '../../../lib/session/linkage';
import type { NativeRecordProvenance, NativeTranscriptSource } from '../../../lib/session/types';

/**
 * Extract explicit native sender/new-thread references without discovery or tool-output guessing.
 * @param source - Caller-authorized available native rollout range.
 * @returns Source-qualified references; absent native identity leaves links unresolved.
 */
export function extractCodexLinkage(source: NativeTranscriptSource): SourceLinkageEvidence {
  const diagnostics: NativeLinkageDiagnostic[] = [];
  const records = readLinkageRecords(source, diagnostics);
  const observed = new Map<string, NativeRecordProvenance[]>();
  for (const record of records) {
    const payload = linkageObject(record.value['payload']);
    const threadId = linkageIdentifier(payload?.['id']);
    if (record.value['type'] !== 'session_meta' || !threadId) continue;
    const occurrences = observed.get(threadId) ?? [];
    occurrences.push(record.occurrence);
    observed.set(threadId, occurrences);
  }
  const identities = [...observed].map(([threadId, occurrences]) => ({
    identity: { provider: 'codex' as const, threadId },
    occurrences
  }));
  const delegations: NativeDelegationEvidence[] = [];
  if (identities.length !== 1) {
    if (identities.length > 1)
      diagnostics.push({
        code: 'conflicting-identity',
        reason: 'multiple-native-source-identities',
        occurrences: identities.flatMap((item) => item.occurrences)
      });
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      provider: 'codex',
      capability: 'references-only',
      identities,
      delegations,
      diagnostics
    };
  }
  const caller = identities[0]!.identity;
  const calls = new Map<string, LinkageRecord[]>();
  for (const record of records) {
    const payload = linkageObject(record.value['payload']);
    const callId = linkageIdentifier(payload?.['call_id']);
    if (
      record.value['type'] !== 'event_msg' ||
      payload?.['type'] !== 'collab_agent_spawn_end' ||
      !callId ||
      payload['sender_thread_id'] !== caller.threadId ||
      !linkageIdentifier(payload['new_thread_id'])
    )
      continue;
    const occurrences = calls.get(callId) ?? [];
    occurrences.push(record);
    calls.set(callId, occurrences);
  }
  for (const [callId, occurrences] of calls) {
    const targets = new Set(occurrences.map((item) => linkageObject(item.value['payload'])?.['new_thread_id']));
    if (targets.size !== 1) {
      diagnostics.push({
        code: 'unresolved-call',
        reason: 'conflicting-native-spawn-targets',
        occurrences: occurrences.map((item) => item.occurrence)
      });
      continue;
    }
    const threadId = linkageIdentifier([...targets][0])!;
    const evidence = occurrences.map((item) => ({ ...item.occurrence, selector: 'payload' }));
    delegations.push({
      parent: evidence[0]!,
      callId,
      caller,
      target: { provider: 'codex', threadId },
      evidence,
      relation: 'reference'
    });
  }
  return {
    sourceKey: source.sourceKey,
    generation: source.generation,
    provider: 'codex',
    capability: 'references-only',
    identities,
    delegations,
    diagnostics
  };
}

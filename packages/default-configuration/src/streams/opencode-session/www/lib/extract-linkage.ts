/**
 * Native task-part caller/target metadata supplies source-level OpenCode references.
 * Exported root metadata never establishes an immediate delegation parent.
 * @summary OpenCode native linkage extraction
 * @module streams/opencode-session/www/lib/extract-linkage
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
 * Fold native task parts and expose only qualified references, never witnessed nesting.
 * @param source - Caller-authorized available native exporter range.
 * @returns Current native identities and references with physical provenance.
 */
export function extractOpencodeLinkage(source: NativeTranscriptSource): SourceLinkageEvidence {
  const diagnostics: NativeLinkageDiagnostic[] = [];
  const records = readLinkageRecords(source, diagnostics);
  const observed = new Map<string, NativeRecordProvenance[]>();
  const parts = new Map<string, LinkageRecord[]>();
  for (const record of records) {
    const sessionId = linkageIdentifier(record.value['sessionId']);
    if (
      record.value['v'] !== 1 ||
      !sessionId ||
      !['meta', 'message', 'part', 'idle'].includes(String(record.value['type']))
    )
      continue;
    const occurrences = observed.get(sessionId) ?? [];
    occurrences.push(record.occurrence);
    observed.set(sessionId, occurrences);
    const data = linkageObject(record.value['data']);
    const partId = linkageIdentifier(data?.['id']);
    const messageId = linkageIdentifier(data?.['messageID']);
    if (record.value['type'] !== 'part' || !partId || !messageId) continue;
    const key = JSON.stringify([sessionId, messageId, partId]);
    const updates = parts.get(key) ?? [];
    updates.push(record);
    parts.set(key, updates);
  }
  const identities = [...observed].map(([sessionId, occurrences]) => ({
    identity: { provider: 'opencode' as const, sessionId },
    occurrences
  }));
  const delegations: NativeDelegationEvidence[] = [];
  if (identities.length !== 1) {
    if (identities.length > 1)
      diagnostics.push({
        code: 'conflicting-identity',
        reason: 'multiple-native-source-identities',
        occurrences: records.map((item) => item.occurrence)
      });
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      provider: 'opencode',
      capability: 'references-only',
      identities,
      delegations,
      diagnostics
    };
  }
  const caller = identities[0]!.identity;
  for (const updates of parts.values()) {
    const latest = updates.at(-1)!;
    const data = linkageObject(latest.value['data']);
    const state = linkageObject(data?.['state']);
    const metadata = linkageObject(state?.['metadata']);
    const callId = linkageIdentifier(data?.['callID']);
    const target = linkageIdentifier(metadata?.['sessionId']);
    if (
      data?.['type'] !== 'tool' ||
      data['tool'] !== 'task' ||
      !callId ||
      !target ||
      (state?.['status'] !== 'running' && state?.['status'] !== 'completed')
    )
      continue;
    if (data['sessionID'] !== caller.sessionId || metadata?.['parentSessionId'] !== caller.sessionId) {
      diagnostics.push({
        code: 'conflicting-identity',
        reason: 'task-caller-disagrees-with-native-source',
        occurrences: [latest.occurrence]
      });
      continue;
    }
    const nativeCalls = new Set(
      updates.map((item) => linkageIdentifier(linkageObject(item.value['data'])?.['callID'])).filter(Boolean)
    );
    if (nativeCalls.size !== 1) {
      diagnostics.push({
        code: 'unresolved-call',
        reason: 'conflicting-native-part-call-identity',
        occurrences: updates.map((item) => item.occurrence)
      });
      continue;
    }
    const selector = `part:${JSON.stringify([data['messageID'], data['id']])}`;
    const evidence = updates.map((item) => ({ ...item.occurrence, selector }));
    delegations.push({
      parent: evidence[0]!,
      callId,
      caller,
      target: { provider: 'opencode', sessionId: target },
      evidence,
      relation: 'reference'
    });
  }
  return {
    sourceKey: source.sourceKey,
    generation: source.generation,
    provider: 'opencode',
    capability: 'references-only',
    identities,
    delegations,
    diagnostics
  };
}

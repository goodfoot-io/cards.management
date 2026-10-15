/**
 * Claude structured Agent calls/results provide witnessed relationship evidence.
 * Native child identity remains independently corroborated by the composer.
 * @summary Claude native linkage extraction
 * @module streams/claude-code-session/www/lib/extract-linkage
 */

import {
  type LinkageRecord,
  linkageIdentifier,
  linkageObject,
  type NativeDelegationEvidence,
  type NativeLinkageDiagnostic,
  type NativeLinkageIdentity,
  readLinkageRecords,
  type SourceLinkageEvidence
} from '../../../lib/session/linkage';
import type { NativeRecordProvenance, NativeTranscriptSource } from '../../../lib/session/types';

interface ClaudeCall {
  readonly record: LinkageRecord;
  readonly isAgent: boolean;
  readonly occurrence: NativeRecordProvenance;
}

/**
 * Inspect one available native range for unique, source-qualified Agent call/result chains.
 * @param source - Caller-authorized current source range and metadata.
 * @returns Native identity and relationship evidence, without target acquisition.
 */
export function extractClaudeLinkage(source: NativeTranscriptSource): SourceLinkageEvidence {
  const diagnostics: NativeLinkageDiagnostic[] = [];
  const records = readLinkageRecords(source, diagnostics);
  const observed = new Map<string, { identity: NativeLinkageIdentity; occurrences: NativeRecordProvenance[] }>();
  for (const record of records) {
    const sessionId = linkageIdentifier(record.value['sessionId']);
    if (!sessionId) continue;
    const agentId = linkageIdentifier(record.value['agentId']);
    const sidechain = record.value['isSidechain'];
    if (
      (record.value['agentId'] !== undefined && !agentId) ||
      (agentId && sidechain !== true) ||
      (!agentId && sidechain === true) ||
      (sidechain !== undefined && typeof sidechain !== 'boolean')
    ) {
      diagnostics.push({
        code: 'conflicting-identity',
        reason: 'incomplete-native-agent-identity',
        occurrences: [record.occurrence]
      });
      continue;
    }
    const identity: NativeLinkageIdentity = {
      provider: 'claude-code',
      sessionId,
      ...(agentId ? { agentId } : {}),
      isSidechain: sidechain === true
    };
    const key = JSON.stringify(identity);
    const entry = observed.get(key) ?? { identity, occurrences: [] };
    entry.occurrences.push(record.occurrence);
    observed.set(key, entry);
  }
  const identities = [...observed.values()];
  const delegations: NativeDelegationEvidence[] = [];
  if (identities.length !== 1 || diagnostics.some((item) => item.code === 'conflicting-identity')) {
    if (identities.length > 1)
      diagnostics.push({
        code: 'conflicting-identity',
        reason: 'multiple-native-source-identities',
        occurrences: identities.flatMap((item) => item.occurrences)
      });
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      provider: 'claude-code',
      capability: 'witnessed-delegation',
      identities,
      delegations,
      diagnostics
    };
  }
  const caller = identities[0]!.identity;
  const calls = new Map<string, ClaudeCall[]>();
  const results = new Map<string, LinkageRecord[]>();
  const seen = new Map<string, { encoded: string; occurrences: NativeRecordProvenance[] }>();
  let conflictingEvent = false;
  for (const record of records) {
    const uuid = linkageIdentifier(record.value['uuid']);
    if (uuid) {
      const encoded = JSON.stringify(record.value);
      const previous = seen.get(uuid);
      if (previous !== undefined) {
        if (previous.encoded !== encoded) conflictingEvent = true;
        else previous.occurrences.push(record.occurrence);
        continue;
      }
      seen.set(uuid, { encoded, occurrences: [record.occurrence] });
    }
    const message = linkageObject(record.value['message']);
    const content = message?.['content'];
    if (!Array.isArray(content)) continue;
    const blocks = content.map(linkageObject);
    if (record.value['type'] === 'assistant') {
      for (const [index, block] of blocks.entries()) {
        const callId = linkageIdentifier(block?.['id']);
        if (block?.['type'] !== 'tool_use' || !callId) continue;
        // A call without native identity on its own record cannot borrow a different event's caller.
        if (record.value['sessionId'] !== (caller.provider === 'claude-code' ? caller.sessionId : undefined)) continue;
        const entries = calls.get(callId) ?? [];
        entries.push({
          record,
          isAgent: block['name'] === 'Agent',
          occurrence: { ...record.occurrence, selector: `message.content[${index}]` }
        });
        calls.set(callId, entries);
      }
    }
    if (record.value['type'] === 'user') {
      const toolResults = blocks.filter((block) => block?.['type'] === 'tool_result');
      for (const toolResult of toolResults) {
        const callId = linkageIdentifier(toolResult?.['tool_use_id']);
        if (!callId) continue;
        const entries = results.get(callId) ?? [];
        entries.push(record);
        results.set(callId, entries);
      }
    }
  }
  if (conflictingEvent) {
    diagnostics.push({ code: 'conflicting-identity', reason: 'conflicting-native-event-id', occurrences: [] });
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      provider: 'claude-code',
      capability: 'witnessed-delegation',
      identities,
      delegations,
      diagnostics
    };
  }
  for (const [callId, entries] of calls) {
    const matching = results.get(callId) ?? [];
    const call = entries[0];
    const result = matching[0];
    const output = linkageObject(result?.value['toolUseResult']);
    const agentId = linkageIdentifier(output?.['agentId']);
    const resultContent = linkageObject(result?.value['message'])?.['content'];
    const resultBlocks = Array.isArray(resultContent)
      ? resultContent.map(linkageObject).filter((block) => block?.['type'] === 'tool_result')
      : [];
    if (
      entries.length !== 1 ||
      matching.length !== 1 ||
      !call ||
      !call.isAgent ||
      !result ||
      resultBlocks.length !== 1 ||
      resultBlocks[0]?.['is_error'] === true ||
      !agentId ||
      (output?.['status'] !== 'completed' && output?.['status'] !== 'async_launched') ||
      caller.provider !== 'claude-code' ||
      result.occurrence.lineNumber <= call.occurrence.lineNumber
    ) {
      diagnostics.push({
        code: 'unresolved-call',
        reason: 'missing-or-ambiguous-structured-agent-result',
        occurrences: entries.map((item) => item.occurrence)
      });
      continue;
    }
    delegations.push({
      parent: call.occurrence,
      callId,
      caller,
      target: { provider: 'claude-code', sessionId: caller.sessionId, agentId, isSidechain: true },
      evidence: [
        ...(seen.get(linkageIdentifier(call.record.value['uuid']) ?? '')?.occurrences ?? [call.occurrence]).map(
          (item) => ({
            ...item,
            selector: call.occurrence.selector
          })
        ),
        ...(seen.get(linkageIdentifier(result.value['uuid']) ?? '')?.occurrences ?? [result.occurrence]).map(
          (item) => ({
            ...item,
            selector: 'toolUseResult.agentId'
          })
        )
      ].sort((left, right) => left.lineNumber - right.lineNumber),
      relation: 'delegation'
    });
  }
  return {
    sourceKey: source.sourceKey,
    generation: source.generation,
    provider: 'claude-code',
    capability: 'witnessed-delegation',
    identities,
    delegations,
    diagnostics
  };
}

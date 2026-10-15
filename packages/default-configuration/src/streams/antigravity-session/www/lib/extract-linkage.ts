/**
 * Antigravity materialization carries no witnessed child topology.
 * Native payload hints never authorize fabricated delegation relationships.
 * @summary Antigravity main-only linkage extraction
 * @module streams/antigravity-session/www/lib/extract-linkage
 */

import {
  type NativeLinkageDiagnostic,
  readLinkageRecords,
  type SourceLinkageEvidence
} from '../../../lib/session/linkage';
import type { NativeTranscriptSource } from '../../../lib/session/types';

/**
 * Preserve the explicit main-only limit while reporting malformed native records.
 * @param source - Caller-authorized current source range and metadata.
 * @returns Empty identity/relationship evidence with a bounded capability diagnostic.
 */
export function extractAntigravityLinkage(source: NativeTranscriptSource): SourceLinkageEvidence {
  const diagnostics: NativeLinkageDiagnostic[] = [];
  readLinkageRecords(source, diagnostics);
  diagnostics.push({ code: 'unsupported-topology', reason: 'native-materialization-is-main-only', occurrences: [] });
  return {
    sourceKey: source.sourceKey,
    generation: source.generation,
    provider: 'antigravity',
    capability: 'main-only',
    identities: [],
    delegations: [],
    diagnostics
  };
}

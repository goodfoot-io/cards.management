/**
 * Extracts antigravity relationship evidence from unmodified native source records.
 * Capability is bounded to main-only; no membership or placement is inferred.
 * @summary Antigravity native linkage extraction
 * @module streams/antigravity-session/www/lib/extract-linkage
 */

import type { SourceLinkageEvidence } from '../../../lib/session/linkage';
import type { NativeTranscriptSource } from '../../../lib/session/types';

/**
 * Inspect one complete available native range with absolute provenance coordinates.
 * @param _source - Caller-authorized current source range and metadata.
 * @throws {Error} Until native evidence extraction is implemented.
 * @returns Native identity and relationship evidence, without target acquisition.
 */
export function extractAntigravityLinkage(_source: NativeTranscriptSource): SourceLinkageEvidence {
  throw new Error('Not Implemented');
}

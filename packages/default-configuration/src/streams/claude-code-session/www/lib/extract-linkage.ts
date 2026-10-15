/**
 * Extracts claude-code relationship evidence from unmodified native source records.
 * Capability is bounded to witnessed-delegation; no membership or placement is inferred.
 * @summary Claude native linkage extraction
 * @module streams/claude-code-session/www/lib/extract-linkage
 */

import type { SourceLinkageEvidence } from '../../../lib/session/linkage';
import type { NativeTranscriptSource } from '../../../lib/session/types';

/**
 * Inspect one complete available native range with absolute provenance coordinates.
 * @param _source - Caller-authorized current source range and metadata.
 * @throws {Error} Until native evidence extraction is implemented.
 * @returns Native identity and relationship evidence, without target acquisition.
 */
export function extractClaudeLinkage(_source: NativeTranscriptSource): SourceLinkageEvidence {
  throw new Error('Not Implemented');
}

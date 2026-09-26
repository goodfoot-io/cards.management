/**
 * Codex native records projected into Cards-owned semantic transcript rows.
 * The placeholder keeps the provider contract type-checkable before its reducer is implemented.
 * @summary Codex incremental native transcript projector
 * @module streams/codex-session/www/lib/project-session
 */

import type { NativeTranscriptProjector } from '../../../lib/session/projection';
import type { NativeTranscriptSource, SessionPart, SessionProjection, SessionRow } from '../../../lib/session/types';
import { type CodexRolloutLine, parseCodexLine } from './parser';

/** A retained native event line for lazy tool inspection. */
export interface CodexNativeDetail {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

/** Complete tool call, result, and severity facts presented by the Codex renderer. */
export interface CodexToolData {
  readonly callId: string;
  readonly name: string;
  readonly argsLabel: string;
  readonly argumentsText: string;
  readonly prettyPrinted: boolean;
  readonly outputText?: string;
  readonly outputImageCount?: number;
  readonly status: 'pending' | 'complete' | 'error' | 'orphan';
  readonly errorLabel?: string;
  readonly details: readonly CodexNativeDetail[];
}

/** Provider-owned payloads that keep Codex display details typed and inspectable. */
export interface CodexPayloads {
  imageNote: { readonly count: number };
  eventActivity: { readonly label: string; readonly detailText?: string };
  turnTime: { readonly text: string };
  sessionStart: {
    readonly summary: string;
    readonly entries: readonly { readonly label: string; readonly text: string; readonly imageCount?: number }[];
  };
  tool: CodexToolData;
  boundary: { readonly kind: 'turn' | 'compaction'; readonly tooltip?: string };
}

export type CodexPart = SessionPart<CodexPayloads>;
export type CodexRow = SessionRow<CodexPayloads>;

/** Source-local placeholder state for the fixture-first Codex contract. */
export interface CodexProjectionState {
  readonly source: Pick<NativeTranscriptSource, 'sourceKey' | 'generation'>;
}

/** Native Codex projection contract; implementation follows the fixture bootstrap. */
export const codexSessionProjector: NativeTranscriptProjector<CodexProjectionState, CodexRolloutLine, CodexPayloads> = {
  providerId: 'codex',
  createState(source) {
    return { source: { sourceKey: source.sourceKey, generation: source.generation } };
  },
  parseRecord(record) {
    return parseCodexLine(record.text);
  },
  reduce() {
    throw new Error('Codex native projection is not implemented');
  },
  project(_state, source): SessionProjection<CodexPayloads> {
    return {
      sourceKey: source.sourceKey,
      generation: source.generation,
      rows: [],
      header: {}
    };
  }
};

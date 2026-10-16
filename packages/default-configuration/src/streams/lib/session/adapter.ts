/**
 * Provider seam for the consolidated session renderer.
 *
 * A provider supplies parsing, linkage evidence and presentation only. Membership, history
 * subscription, placement, windowing and the layout bridge stay in the shared renderer so
 * every provider gets the same honest grouping and card-detail behavior.
 *
 * @summary Provider adapter contract for consolidated session rendering
 * @module streams/lib/session/adapter
 */

import type { ComponentType } from 'react';
import type { SessionHeaderProps } from '../SessionHeader';
import type { SourceLinkageEvidence } from './linkage';
import type { NativeTranscriptProjector } from './projection';
import type { SessionContentProps, SessionProviderRegistry } from './SessionContent';
import type { NativeTranscriptSource, SessionProjection, SessionRow } from './types';

/** Compact summary card input; the summary never claims facts about unloaded history. */
export interface SessionSummaryProps {
  readonly source: NativeTranscriptSource;
  /** Absolute coordinates of the loaded range and the source's known total. */
  readonly coverage: { readonly first: number; readonly last: number; readonly total: number };
  /** Whether earlier native records exist that are not loaded. */
  readonly earlierUnloaded: boolean;
}

/** Everything one provider contributes to consolidated rendering. */
export interface SessionProviderAdapter<Payloads extends object = Record<string, unknown>> {
  /** Linkage provider; also selects the honest capability label. */
  readonly provider: SourceLinkageEvidence['provider'];
  /** Human agent name for labels and announcements. */
  readonly agentName: string;
  // biome-ignore lint/suspicious/noExplicitAny: provider parse/reduce state is opaque to the shared renderer.
  readonly projector: NativeTranscriptProjector<any, any, Payloads>;
  /** Pure native linkage extraction over the loaded range. */
  readonly extractLinkage: (source: NativeTranscriptSource) => SourceLinkageEvidence;
  readonly providerParts?: SessionProviderRegistry<Payloads>;
  readonly providerRows?: SessionProviderRegistry<Payloads>;
  readonly renderTool?: SessionContentProps<Payloads>['renderTool'];
  /** Rows nested inside provider grouping containers, for delegation anchor lookup. */
  readonly nestedRows?: (row: SessionRow<Payloads>) => readonly SessionRow<Payloads>[] | undefined;
  /** Every disclosure identity the provider's presentation may control for these rows. */
  readonly disclosureIds: (rows: readonly SessionRow<Payloads>[]) => ReadonlySet<string>;
  /** Leaf adoption by an owner (Claude hooks under tools); a newly adopted open leaf reveals its owner. */
  readonly adoptions?: (rows: readonly SessionRow<Payloads>[]) => ReadonlyMap<string, string>;
  /** Header facts for one projected source. */
  readonly header: (projection: SessionProjection<Payloads>) => SessionHeaderProps;
  /** Empty-transcript copy. */
  readonly emptyText: string;
  /** Provider compact card for the main source. */
  readonly Summary: ComponentType<SessionSummaryProps>;
}

/**
 * Scope note for a summary folded from a trailing window.
 * @param props - Summary input.
 * @returns Visible note, or undefined when the whole source is loaded.
 */
export function summaryCoverage(props: SessionSummaryProps): string | undefined {
  if (!props.earlierUnloaded) return undefined;
  const { first, last, total } = props.coverage;
  return `Summary of lines ${first}–${last} of ${total}; earlier content not loaded.`;
}

/**
 * Compact micro-card view for the opencode-session stream renderer.
 *
 * Receives the session's main source from the session renderer and folds its
 * loaded range via {@link reconcileFolded} by absolute coordinates, so a trimmed
 * tail keeps folding new records while a new incarnation, gap or newly loaded
 * earlier history rebuilds. Empty-session closing belongs to the session
 * renderer. The folded state is adapted into a provider-neutral `CompactCardModel` via
 * {@link opencodeToCompactCardModel} and rendered through the shared
 * `CompactCard` component — the DOM/CSS for the card live there, not here.
 *
 * Status is liveness-only — `RUNNING` or `ENDED` — plus an honest error dot
 * when a tool call failed.
 *
 * @summary Compact OpenCode session card: folds state, adapts it, renders the shared CompactCard
 * @module streams/opencode-session/www/components/compact/OpencodeCompactView
 */

import type React from 'react';
import { CompactCard } from '../../../../lib/CompactCard';
import { type SessionSummaryProps, summaryCoverage } from '../../../../lib/session/adapter';
import { useAbsoluteFold } from '../../../../lib/session/use-absolute-fold';
import { opencodeToCompactCardModel } from '../../lib/adapt-compact-model';
import { buildFoldedState, reconcileFolded } from '../../lib/compact-state';

/**
 * Compact session card for the session's main source. Folds the loaded range into a
 * `FoldedState` by absolute coordinates, so a trimmed tail keeps folding new records, and
 * labels the summary's scope while earlier content is unloaded.
 * @param props - Main source snapshot and its loaded coverage.
 * @returns Rendered compact card.
 */
export function OpencodeCompactView(props: SessionSummaryProps): React.ReactElement {
  const { source } = props;
  const isActive = source.meta?.isActive ?? false;
  const role = source.meta?.role;
  const agentId = source.meta?.agentId;
  const folded = useAbsoluteFold(
    source,
    (lines) => buildFoldedState(lines, isActive, role, agentId),
    (prev, lines) => reconcileFolded(prev, lines, isActive, role, agentId)
  );
  return (
    <CompactCard model={{ ...opencodeToCompactCardModel(folded.state, isActive), coverage: summaryCoverage(props) }} />
  );
}

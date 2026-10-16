/**
 * Compact micro-card view for the codex-session stream renderer.
 *
 * Receives the session's main source from the session renderer and folds its
 * loaded range via {@link reconcileFolded} by absolute coordinates, so a trimmed
 * tail keeps folding new records while a new incarnation, gap or newly loaded
 * earlier history rebuilds. Empty-session closing belongs to the session
 * renderer. The folded state is adapted into a provider-neutral `CompactCardModel` via
 * {@link codexToCompactCardModel} and rendered through the shared `CompactCard`
 * component — the DOM/CSS for the card live there, not here.
 *
 * Status is liveness-only — `RUNNING` or `ENDED` — and never an asserted
 * outcome: the Codex rollout carries no honest success signal, so this view
 * fabricates none.
 *
 * @summary Compact Codex session card: folds state, adapts it, renders the shared CompactCard
 * @module streams/codex-session/www/components/compact/CodexCompactView
 */

import type React from 'react';
import { CompactCard } from '../../../../lib/CompactCard';
import { type SessionSummaryProps, summaryCoverage } from '../../../../lib/session/adapter';
import { useAbsoluteFold } from '../../../../lib/session/use-absolute-fold';
import { codexToCompactCardModel } from '../../lib/adapt-compact-model';
import { buildFoldedState, reconcileFolded } from '../../lib/compact-state';

/**
 * Compact session card for the session's main source. Folds the loaded range into a
 * `FoldedState` by absolute coordinates, so a trimmed tail keeps folding new records, and
 * labels the summary's scope while earlier content is unloaded.
 * @param props - Main source snapshot and its loaded coverage.
 * @returns Rendered compact card.
 */
export function CodexCompactView(props: SessionSummaryProps): React.ReactElement {
  const { source } = props;
  const isActive = source.meta?.isActive ?? false;
  const folded = useAbsoluteFold(
    source,
    (lines) => buildFoldedState(lines, isActive),
    (prev, lines) => reconcileFolded(prev, lines, isActive)
  );
  return (
    <CompactCard model={{ ...codexToCompactCardModel(folded.state, isActive), coverage: summaryCoverage(props) }} />
  );
}

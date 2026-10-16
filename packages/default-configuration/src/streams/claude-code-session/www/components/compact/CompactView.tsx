/**
 * Compact micro-card view for the claude-code-session stream renderer.
 *
 * Folds the session's main source into {@link CompactState}, adapts it into the
 * provider-neutral `CompactCardModel` via {@link claudeToCompactCardModel},
 * and renders it through the shared `CompactCard` component — the actual DOM
 * and CSS for the three-row card (liveness dot + status + timing, the
 * sanitized headline recap, and the de-duplicated metrics row, reflowing at a
 * wide viewport into recap+metrics / latest-tail panels) live there, not here.
 * Status is liveness-only (`RUNNING`/`ENDED`, with an error tint) — never an
 * asserted outcome. The session renderer owns empty-session closing.
 *
 * @summary Compact session card: folds state, adapts it, renders the shared CompactCard
 * @module components/compact/CompactView
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { CompactCard } from '../../../../lib/CompactCard';
import { formatDate, formatDuration } from '../../../../lib/compact-facts';
import { type SessionSummaryProps, summaryCoverage } from '../../../../lib/session/adapter';
import { useAbsoluteFold } from '../../../../lib/session/use-absolute-fold';
import { claudeToCompactCardModel } from './adapt-compact-model';
import type { CompactState } from './compact-state';
import { buildState, reconcileFolded } from './compact-state';

/**
 * Compact session card for the session's main source. Folds the loaded range into
 * {@link CompactState}, adapts it into a `CompactCardModel`, and ticks a live elapsed timer
 * while the stream is active. Timing derived from a trailing window would misstate the
 * session, so it is omitted while earlier content is unloaded.
 * @param props - Main source snapshot and its loaded coverage.
 * @returns Rendered compact card.
 */
export function CompactView(props: SessionSummaryProps): React.ReactElement {
  const { source, earlierUnloaded } = props;
  const role = source.meta?.role;
  const agentId = source.meta?.agentId;
  const isActive = source.meta?.isActive ?? false;
  const folded = useAbsoluteFold(
    source,
    (lines) => ({ state: buildState(lines, role, agentId), lineCount: lines.length }),
    (prev, lines) => reconcileFolded(prev, lines, role, agentId)
  );
  // `now` drives the live elapsed timer; it only advances while the stream is
  // active, so an ended card never re-renders on a timer.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const compactState: CompactState = folded.state;
  const { firstTimestamp, lastTimestamp } = compactState;
  const elapsedMs = isActive ? Math.max(0, now - firstTimestamp) : Math.max(0, lastTimestamp - firstTimestamp);
  const elapsedStr = firstTimestamp > 0 && !earlierUnloaded ? formatDuration(elapsedMs) : '';
  const dateStr = earlierUnloaded ? '' : formatDate(firstTimestamp);

  const model = claudeToCompactCardModel(compactState, isActive, elapsedStr, dateStr);
  return <CompactCard model={{ ...model, coverage: summaryCoverage(props) }} />;
}

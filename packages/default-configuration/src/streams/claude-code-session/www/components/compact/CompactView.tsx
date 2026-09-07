/**
 * Compact micro-card view for the claude-code-session stream renderer.
 *
 * Folds the primary stream into {@link CompactState}, adapts it into the
 * provider-neutral `CompactCardModel` via {@link claudeToCompactCardModel},
 * and renders it through the shared `CompactCard` component — the actual DOM
 * and CSS for the three-row card (liveness dot + status + timing, the
 * sanitized headline recap, and the de-duplicated metrics row, reflowing at a
 * wide viewport into recap+metrics / latest-tail panels) live there, not here.
 * Status is liveness-only (`RUNNING`/`ENDED`, with an error tint) — never an
 * asserted outcome. Streams whose primary file has no lines ask the host to
 * close the renderer so blank boxes don't show in the card detail.
 *
 * @summary Compact session card: folds state, adapts it, renders the shared CompactCard
 * @module components/compact/CompactView
 */

import { close, streamStore } from '@cards.management/sdk/stream-store';
import type React from 'react';
import { useEffect, useState } from 'react';
import { CompactCard } from '../../../../lib/CompactCard';
import { formatDate, formatDuration } from '../../../../lib/compact-facts';
import { claudeToCompactCardModel } from './adapt-compact-model';
import type { CompactState, FoldedState } from './compact-state';
import { buildState, reconcileFolded } from './compact-state';

/**
 * Reads the primary stream file's lines and sidecar identity fields from the store.
 * @returns The primary file's lines, liveness, and sidecar `role`/`agentId`.
 */
function readPrimary(): { lines: string[]; isActive: boolean; role: string | undefined; agentId: string | undefined } {
  const s = streamStore.getState();
  const file = s.files.get(s.primary);
  return {
    lines: file ? file.lines : [],
    isActive: file?.meta.isActive ?? false,
    role: file?.meta.role,
    agentId: file?.meta.agentId
  };
}

/**
 * Compact session card. Folds the primary stream into {@link CompactState},
 * adapts it into a `CompactCardModel`, and ticks a live elapsed timer while
 * the stream is active. Closes the renderer when the primary file has zero lines.
 * @returns Rendered compact card, or null when there is nothing to show.
 */
export function CompactView(): React.ReactElement | null {
  const [folded, setFolded] = useState<FoldedState>(() => {
    const { lines, role, agentId } = readPrimary();
    return { state: buildState(lines, role, agentId), lineCount: lines.length };
  });
  const [isActive, setIsActive] = useState<boolean>(() => readPrimary().isActive);
  // `now` drives the live elapsed timer; it only advances while the stream is
  // active (the interval below is cleared once ended), so an ended card never
  // re-renders on a timer.
  const [now, setNow] = useState<number>(() => Date.now());

  // Reconcile the folded state against the store, then subscribe for updates.
  // The first reconcile folds any lines that arrived between the initial render
  // and this effect — the empty-on-boot primary's `subscribe:response` delivers
  // the whole transcript and can land in exactly this window. Without folding it
  // here, an already-ended session (no further lines to come) would render as a
  // blank "ENDED" card. `reconcileFolded` keeps the watermark inside `folded`,
  // so a no-op reconcile returns the same reference and skips a re-render.
  useEffect(() => {
    const sync = (): void => {
      const { lines, role, isActive: active, agentId } = readPrimary();
      setIsActive(active);
      setFolded((prev) => reconcileFolded(prev, lines, role, agentId));
    };
    sync();
    return streamStore.subscribe(sync);
  }, []);

  const compactState: CompactState = folded.state;

  // Tick the live elapsed timer ~1s, but only while the stream is active. The
  // interval is cleared on unmount and whenever `isActive` flips to false, so an
  // ended card never churns re-renders.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Close a settled stream whose primary file has zero lines so the host doesn't
  // render a blank box for it. A live (active) stream is never closed for
  // emptiness: it is mid-flight and its backlog is still arriving out of band via
  // the async `subscribe:response` backfill (the host boots the iframe with no
  // lines and the server seeds `stream:started` with lineCount:0), so closing on
  // the seed would collapse the live transcript pane the instant it opens.
  useEffect(() => {
    const checkEmpty = (): void => {
      const state = streamStore.getState();
      const file = state.files.get(state.primary);
      if (file && file.meta.lineCount === 0 && !file.meta.isActive) close();
    };
    checkEmpty();
    return streamStore.subscribe(checkEmpty);
  }, []);

  const { firstTimestamp, lastTimestamp } = compactState;
  const elapsedMs = isActive ? Math.max(0, now - firstTimestamp) : Math.max(0, lastTimestamp - firstTimestamp);
  const elapsedStr = firstTimestamp > 0 ? formatDuration(elapsedMs) : '';
  const dateStr = formatDate(firstTimestamp);

  const model = claudeToCompactCardModel(compactState, isActive, elapsedStr, dateStr);
  return <CompactCard model={model} />;
}

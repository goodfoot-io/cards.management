/**
 * Incremental compact folding over absolute native coordinates.
 *
 * A tail subscription keeps a bounded trailing window, so its array length stops growing while
 * new records keep arriving. Provider compact folds track a positional watermark; this adapter
 * presents them a coordinate-aligned array (holes before the loaded range) so the watermark is
 * an absolute line count, and rebuilds from the loaded range on a new incarnation, a gap, or
 * newly loaded earlier history.
 *
 * @summary Watermark folding that survives tail trimming
 * @module streams/lib/session/use-absolute-fold
 */

import { useRef } from 'react';
import type { NativeTranscriptSource } from './types';

/** Minimal provider fold shape: a positional line watermark. */
export interface WatermarkFold {
  readonly lineCount: number;
}

/** Cached fold and the coordinate it is based at. */
interface FoldCache<F> {
  readonly source: NativeTranscriptSource;
  readonly generation: string;
  readonly base: number;
  readonly first: number;
  readonly folded: F;
}

/**
 * Folds one source incrementally by absolute coordinates.
 * @param previous - Prior cache, or null.
 * @param source - Current native snapshot.
 * @param build - Builds a fold from dense lines.
 * @param reconcile - Folds lines past the watermark of a coordinate-aligned array.
 * @returns Next cache.
 */
export function foldAbsolute<F extends WatermarkFold>(
  previous: FoldCache<F> | null,
  source: NativeTranscriptSource,
  build: (lines: string[]) => F,
  reconcile: (prev: F, lines: string[]) => F
): FoldCache<F> {
  const head = source.headLineNumber;
  const rebase =
    !previous ||
    previous.generation !== source.generation ||
    head < previous.first ||
    head > previous.base + previous.folded.lineCount;
  if (rebase)
    return { source, generation: source.generation, base: head, first: head, folded: build([...source.lines]) };
  const aligned = (new Array(head - previous.base) as string[]).concat(source.lines);
  return { ...previous, source, folded: reconcile(previous.folded, aligned) };
}

/**
 * Hook form of {@link foldAbsolute}; idempotent per immutable snapshot.
 * @param source - Current native snapshot.
 * @param build - Builds a fold from dense lines.
 * @param reconcile - Folds past the watermark.
 * @returns Current fold.
 */
export function useAbsoluteFold<F extends WatermarkFold>(
  source: NativeTranscriptSource,
  build: (lines: string[]) => F,
  reconcile: (prev: F, lines: string[]) => F
): F {
  const cache = useRef<FoldCache<F> | null>(null);
  if (cache.current?.source !== source) cache.current = foldAbsolute(cache.current, source, build, reconcile);
  return cache.current.folded;
}

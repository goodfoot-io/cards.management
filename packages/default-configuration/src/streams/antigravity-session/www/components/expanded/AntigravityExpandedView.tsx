/**
 * Antigravity expanded mode binds a coherent native SDK snapshot to its own projector.
 * Compact rendering keeps its existing fold and summary path.
 * @summary Antigravity native source subscription and semantic viewport
 * @module streams/antigravity-session/www/components/expanded/AntigravityExpandedView
 */

import { streamStore } from '@cards.management/sdk/stream-store';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { createTranscriptProjection, type TranscriptProjectionController } from '../../../../lib/session/projection';
import type { NativeTranscriptSource, SessionDisclosureState, SessionProjection } from '../../../../lib/session/types';
import { useTranscriptSource } from '../../../../lib/session/use-transcript-source';
import { useStreamStore } from '../../hooks/useStreamStore';
import { type AntigravityPayloads, type AntigravityRow, antigravitySessionProjector } from '../../lib/project-session';
import { AntigravitySessionView } from './AntigravitySessionView';

/**
 * Collects stable disclosure owners from current semantic rows.
 * @param rows - Projected source rows.
 * @returns All top-level and leaf identities still present in this generation.
 */
function disclosureIds(rows: readonly AntigravityRow[]): Set<string> {
  return new Set(rows.flatMap((row) => [row.id, ...row.parts.map((part) => part.id)]));
}

/**
 * Adapts one supplied native source without importing or rediscovering the SDK store.
 * @param root0 - Caller-qualified source snapshot.
 * @param root0.source - Native lines, metadata, and caller-supplied generation.
 * @returns Expanded Antigravity session presentation.
 */
export function AntigravitySourceView({ source }: { source: NativeTranscriptSource }): ReactElement {
  const controller = useRef<TranscriptProjectionController<AntigravityPayloads> | null>(null);
  const [projection, setProjection] = useState<SessionProjection<AntigravityPayloads> | null>(null);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    const next = createTranscriptProjection(antigravitySessionProjector, source.sourceKey);
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, [source.sourceKey]);

  useEffect(() => {
    const next = controller.current!.update(source).projection;
    setProjection(next);
    const ids = disclosureIds(next.rows);
    setOpen((previous) => {
      if ([...previous.keys()].every((id) => ids.has(id))) return previous;
      return new Map([...previous].filter(([id]) => ids.has(id)));
    });
  }, [source]);

  const disclosures: SessionDisclosureState = {
    open,
    onOpenChange: (id, value) => setOpen((previous) => new Map(previous).set(id, value))
  };

  return <AntigravitySessionView source={source} projection={projection} disclosures={disclosures} />;
}

/**
 * Selects the current main stream using the shared native subscription adapter.
 * @returns Expanded Antigravity session view bound to the existing host/store path.
 */
export function AntigravityExpandedView(): ReactElement {
  const scope = useId();
  const filename = useStreamStore((state) => state.primary);
  const source = useTranscriptSource(streamStore, {
    filename,
    sourceKey: JSON.stringify(['antigravity-expanded', scope, filename]),
    generation: 'native-store'
  });
  return <AntigravitySourceView key={source.sourceKey} source={source} />;
}

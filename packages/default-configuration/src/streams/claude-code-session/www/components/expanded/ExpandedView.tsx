/**
 * Claude expanded rendering adapts coherent native snapshots to the shared session seam.
 * The current SDK supplies no reset authority; generation is explicit and never inferred from length.
 * @summary Claude native source, projection, controlled content and viewport
 * @module components/expanded/ExpandedView
 */
import { streamStore } from '@cards.management/sdk/stream-store';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { SessionHeader } from '../../../../lib/SessionHeader';
import { createTranscriptProjection, type TranscriptProjectionController } from '../../../../lib/session/projection';
import { SessionViewport } from '../../../../lib/session/SessionViewport';
import type { NativeTranscriptSource, SessionProjection } from '../../../../lib/session/types';
import { useTranscriptSource } from '../../../../lib/session/use-transcript-source';
import { useStreamStore } from '../../hooks/useStreamStore';
import { type ClaudePayloads, claudeSessionProjector } from '../../lib/project-session';
import { CLAUDE_PARTS, claudeDisclosureIds } from './ClaudePresentation';

/**
 * Native source rendering is reusable without importing the store or discovering related sessions.
 * @param root0 - Typed presentation inputs.
 * @param root0.source - Caller-qualified native source snapshot and explicit generation.
 * @returns Expanded Claude content backed by the supplied native source.
 */
export function ClaudeSourceView({ source }: { source: NativeTranscriptSource }): ReactElement {
  const controller = useRef<TranscriptProjectionController<ClaudePayloads> | null>(null);
  const [projection, setProjection] = useState<SessionProjection<ClaudePayloads> | null>(null);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    const next = createTranscriptProjection(claudeSessionProjector, source.sourceKey);
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, [source.sourceKey]);
  useEffect(() => {
    const next = controller.current!.update(source).projection;
    setProjection(next);
    const ids = claudeDisclosureIds(next.rows);
    setOpen((previous) =>
      [...previous.keys()].every((id) => ids.has(id)) ? previous : new Map([...previous].filter(([id]) => ids.has(id)))
    );
  }, [source]);
  const current =
    projection?.sourceKey === source.sourceKey && projection.generation === source.generation ? projection : null;
  const header = current?.header;
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <SessionHeader
        model={header?.model ?? ''}
        cwd={header?.cwd ?? ''}
        status={header?.status === 'done' ? 'success' : (header?.status ?? 'running')}
        agentId={header?.agentId}
      />
      {source.error ? (
        <div className="session-tone--error" role="status">
          {source.error}
        </div>
      ) : null}
      <div className="flex-1 min-h-0">
        <SessionViewport
          rows={current?.rows ?? []}
          providerParts={CLAUDE_PARTS}
          providerRows={CLAUDE_PARTS}
          disclosures={{ open, onOpenChange: (id, value) => setOpen((previous) => new Map(previous).set(id, value)) }}
          emptyContent={<p className="session-muted">{source.isLoading ? 'Loading transcript…' : 'No output yet.'}</p>}
        />
      </div>
    </div>
  );
}
/**
 * Expanded owner supplies an iframe-scoped identity while compact mode remains on its existing fold.
 * @returns Expanded Claude owner subscribed to the selected native file.
 */
export function ExpandedView(): ReactElement {
  const scope = useId();
  const filename = useStreamStore((state) => state.primary);
  const source = useTranscriptSource(streamStore, {
    filename,
    sourceKey: JSON.stringify(['claude-expanded', scope, filename]),
    generation: 'native-store'
  });
  return <ClaudeSourceView key={source.sourceKey} source={source} />;
}

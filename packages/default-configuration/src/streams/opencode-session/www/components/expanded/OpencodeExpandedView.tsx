/**
 * OpenCode expanded view projects the provider's own native transcript into Cards session rows.
 * @summary OpenCode source, projection, controlled content, and viewport
 * @module streams/opencode-session/www/components/expanded/OpencodeExpandedView
 */

import { streamStore } from '@cards.management/sdk/stream-store';
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { SessionHeader } from '../../../../lib/SessionHeader';
import { createTranscriptProjection, type TranscriptProjectionController } from '../../../../lib/session/projection';
import type { SessionContentProps } from '../../../../lib/session/SessionContent';
import { SessionViewport } from '../../../../lib/session/SessionViewport';
import type { NativeTranscriptSource, SessionProjection } from '../../../../lib/session/types';
import { useTranscriptSource } from '../../../../lib/session/use-transcript-source';
import { useStreamStore } from '../../hooks/useStreamStore';
import { type OpencodePayloads, opencodeSessionProjector } from '../../lib/project-session';
import {
  OPENCODE_PRESENTATION,
  OpenCodeTool,
  opencodeDisclosureIds,
  opencodeHeaderDisplay
} from './OpencodePresentation';

const EMPTY_ROWS = [] as const;
const renderOpenCodeTool: NonNullable<SessionContentProps<OpencodePayloads>['renderTool']> = (part, context) => (
  <OpenCodeTool part={part} leaf={part} context={context} />
);

/** Renders one supplied OpenCode native snapshot without owning transport or reset detection.
 * @param root0 - Native snapshot supplied by the active source binding.
 * @param root0.source - Caller-qualified source, explicit generation, and complete current line range.
 * @returns Expanded OpenCode session content.
 */
export function OpencodeSourceView({ source }: { source: NativeTranscriptSource }): ReactElement {
  const controller = useRef<TranscriptProjectionController<OpencodePayloads> | null>(null);
  const [projection, setProjection] = useState<SessionProjection<OpencodePayloads> | null>(null);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    const next = createTranscriptProjection(opencodeSessionProjector, source.sourceKey, {
      includeInvalidatedIds: false
    });
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, [source.sourceKey]);

  useEffect(() => {
    const update = controller.current!.update(source);
    setProjection(update.projection);
    if (update.kind === 'metadata' || update.kind === 'unchanged') return;
    setOpen((previous) => {
      if (previous.size === 0) return previous;
      if (update.kind === 'initial' || update.kind === 'reset') return new Map();
      const ids = opencodeDisclosureIds(update.projection.rows);
      if ([...previous.keys()].every((id) => ids.has(id))) return previous;
      return new Map([...previous].filter(([id]) => ids.has(id)));
    });
  }, [source]);

  const onOpenChange = useCallback((id: string, value: boolean) => {
    setOpen((previous) => new Map(previous).set(id, value));
  }, []);
  const disclosures = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
  const emptyContent = useMemo(
    () => <p className="session-muted">{source.isLoading ? 'Loading transcript…' : 'No output yet.'}</p>,
    [source.isLoading]
  );

  const current =
    projection?.sourceKey === source.sourceKey && projection.generation === source.generation ? projection : null;
  const rows = current?.rows ?? EMPTY_ROWS;
  const header = current?.header;
  const identity = opencodeHeaderDisplay(rows);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <SessionHeader
        model={header?.model ?? ''}
        cwd={header?.cwd ?? ''}
        status={header?.status === 'done' ? 'success' : (header?.status ?? 'running')}
        provider={identity.provider}
        threadId={identity.sessionId}
      />
      {source.error ? (
        <div className="session-tone--error" role="status">
          {source.error}
        </div>
      ) : null}
      <div className="flex-1 min-h-0">
        <SessionViewport
          rows={rows}
          providerParts={OPENCODE_PRESENTATION}
          providerRows={OPENCODE_PRESENTATION}
          renderTool={renderOpenCodeTool}
          disclosures={disclosures}
          emptyContent={emptyContent}
          agentName="OpenCode"
          sessionStatus={header?.status}
        />
      </div>
    </div>
  );
}

/** Binds the active SDK file to this expanded view with caller-owned source identity and generation.
 * @returns Expanded OpenCode view bound to the selected native source.
 */
export function OpencodeExpandedView(): ReactElement {
  const scope = useId();
  const filename = useStreamStore((state) => state.primary);
  const source = useTranscriptSource(streamStore, {
    filename,
    sourceKey: JSON.stringify(['opencode-expanded', scope, filename]),
    generation: 'native-store'
  });
  return <OpencodeSourceView key={source.sourceKey} source={source} />;
}

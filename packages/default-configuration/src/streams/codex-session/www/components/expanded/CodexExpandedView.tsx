/**
 * Expanded Codex view projects the native rollout through Cards session primitives.
 * The compact view keeps its existing bounded fold and the SDK remains the sole source store.
 * @summary Expanded Codex native source, projection, and viewport
 * @module components/expanded/CodexExpandedView
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionHeader } from '../../../../lib/SessionHeader';
import { createTranscriptProjection, type TranscriptProjectionController } from '../../../../lib/session/projection';
import { SessionViewport } from '../../../../lib/session/SessionViewport';
import type { NativeTranscriptSource, SessionProjection } from '../../../../lib/session/types';
import { type CodexPayloads, type CodexRow, codexSessionProjector } from '../../lib/project-session';
import { CODEX_PARTS, CODEX_ROWS } from './CodexPresentation';

/**
 * Collects row and part ids so controlled disclosures survive source appends.
 * @param rows - Current semantic rows from Codex's projection.
 * @returns Every current row and part identity.
 */
export function codexDisclosureIds(rows: readonly CodexRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.id);
    for (const part of row.parts) {
      ids.add(part.id);
      if (part.kind === 'provider' && part.providerKind === 'tool') {
        for (const detail of part.data.details) ids.add(detail.id);
      }
    }
    if (row.kind === 'provider' && row.providerKind === 'tool') {
      for (const detail of row.data.details) ids.add(detail.id);
    }
  }
  return ids;
}

const EMPTY_ROWS = [] as const;

/**
 * Renders one caller-supplied Codex native snapshot without discovering another source.
 * @param root0 - Source props.
 * @param root0.source - Caller-qualified Codex native snapshot.
 * @returns Expanded Codex session content and header.
 */
export function CodexSourceView({ source }: { source: NativeTranscriptSource }): React.ReactElement {
  const controller = useRef<TranscriptProjectionController<CodexPayloads> | null>(null);
  const [projection, setProjection] = useState<SessionProjection<CodexPayloads> | null>(null);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    const next = createTranscriptProjection(codexSessionProjector, source.sourceKey, { includeInvalidatedIds: false });
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
      const ids = codexDisclosureIds(update.projection.rows as CodexRow[]);
      if ([...previous.keys()].every((id) => ids.has(id))) return previous;
      return new Map([...previous].filter(([id]) => ids.has(id)));
    });
  }, [source]);

  const onOpenChange = useCallback((id: string, value: boolean) => {
    setOpen((previous) => new Map(previous).set(id, value));
  }, []);
  const disclosures = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
  const emptyContent = useMemo(
    () => (
      <p className="session-muted">{source.isLoading ? 'Loading transcript…' : 'No Codex session activity yet.'}</p>
    ),
    [source.isLoading]
  );

  const current =
    projection?.sourceKey === source.sourceKey && projection.generation === source.generation ? projection : null;
  const header = current?.header;
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <SessionHeader
        model={header?.model ?? ''}
        cwd={header?.cwd ?? ''}
        status={header?.status === 'done' ? 'success' : (header?.status ?? 'running')}
        provider={header?.provider}
        threadId={header?.threadId}
      />
      {source.error ? (
        <div className="session-tone--error" role="status">
          {source.error}
        </div>
      ) : null}
      <div className="flex-1 min-h-0">
        <SessionViewport
          rows={current?.rows ?? EMPTY_ROWS}
          providerParts={CODEX_PARTS}
          providerRows={CODEX_ROWS}
          disclosures={disclosures}
          emptyContent={emptyContent}
          ariaLabel="Codex session transcript"
          agentName="Codex"
          sessionStatus={header?.status}
        />
      </div>
    </div>
  );
}

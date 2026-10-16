/**
 * Claude expanded rendering adapts coherent native snapshots to the shared session seam.
 * The current SDK supplies no reset authority; generation is explicit and never inferred from length.
 * @summary Claude native source, projection, controlled content and viewport
 * @module components/expanded/ExpandedView
 */
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionHeader } from '../../../../lib/SessionHeader';
import { createTranscriptProjection, type TranscriptProjectionController } from '../../../../lib/session/projection';
import { SessionViewport } from '../../../../lib/session/SessionViewport';
import type { NativeTranscriptSource, SessionProjection } from '../../../../lib/session/types';
import { type ClaudePayloads, type ClaudeRow, claudeSessionProjector } from '../../lib/project-session';
import { CLAUDE_PARTS, claudeDisclosureIds } from './ClaudePresentation';

const EMPTY_ROWS = [] as const;

/**
 * Records hook adoption independently of mutable disclosure choices.
 * @param rows - Native projected rows, including render-only grouping containers.
 * @returns The enclosing tool identity for each adopted hook.
 */
export function hookToolOwners(rows: readonly ClaudeRow[]): Map<string, string> {
  const owners = new Map<string, string>();
  const visit = (row: ClaudeRow): void => {
    for (const part of row.parts) {
      if (part.kind === 'provider' && part.providerKind === 'tool')
        for (const hook of part.data.hooks) owners.set(hook.id, part.id);
    }
    if (row.kind === 'provider' && row.providerKind === 'group') row.data.rows.forEach(visit);
  };
  rows.forEach(visit);
  return owners;
}

/**
 * Native source rendering is reusable without importing the store or discovering related sessions.
 * @param root0 - Typed presentation inputs.
 * @param root0.source - Caller-qualified native source snapshot and explicit generation.
 * @returns Expanded Claude content backed by the supplied native source.
 */
export function ClaudeSourceView({ source }: { source: NativeTranscriptSource }): ReactElement {
  const controller = useRef<TranscriptProjectionController<ClaudePayloads> | null>(null);
  const [projection, setProjection] = useState<SessionProjection<ClaudePayloads> | null>(null);
  const hookOwners = useRef(new Map<string, string>());
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    const next = createTranscriptProjection(claudeSessionProjector, source.sourceKey, { includeInvalidatedIds: false });
    controller.current = next;
    hookOwners.current = new Map();
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, [source.sourceKey]);
  useEffect(() => {
    const next = controller.current!.update(source).projection;
    setProjection(next);
    const ids = claudeDisclosureIds(next.rows);
    const owners = hookToolOwners(next.rows);
    const adoptions = [...owners].filter(([hookId, toolId]) => hookOwners.current.get(hookId) !== toolId);
    hookOwners.current = owners;
    setOpen((previous) => {
      const revealed = adoptions.filter(([hookId, toolId]) => previous.get(hookId) && !previous.get(toolId));
      if (!revealed.length && [...previous.keys()].every((id) => ids.has(id))) return previous;
      const retained = new Map([...previous].filter(([id]) => ids.has(id)));
      // Reveal an inspected leaf only on its adoption transition. Later user collapses remain authoritative.
      for (const [, toolId] of revealed) retained.set(toolId, true);
      return retained;
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
          rows={current?.rows ?? EMPTY_ROWS}
          providerParts={CLAUDE_PARTS}
          providerRows={CLAUDE_PARTS}
          disclosures={disclosures}
          emptyContent={emptyContent}
          agentName="Claude Code"
          sessionStatus={header?.status}
        />
      </div>
    </div>
  );
}

/**
 * Consolidated session renderer shared by every provider.
 *
 * Expanded mode keeps the scroll-owning MessageScroller viewport with its follow/hold intent.
 * Card-detail (compact) mode renders normal-flow content whose height the parent timeline
 * adopts: a bounded main preview with collapsed member sections, explicit paging controls with
 * rendered-range labels, and a layout bridge that never scrolls or clips inside the iframe.
 *
 * @summary Session composition, presentation and card-detail windowing
 * @module streams/lib/session/SessionRenderer
 */

import type { StreamStoreState } from '@cards.management/sdk/stream-store';
import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SessionHeader } from '../SessionHeader';
import type { SessionProviderAdapter } from './adapter';
import type { RelationshipDiagnostic } from './compose';
import { createLayoutBridge, type LayoutBridge } from './layout-bridge';
import { SessionContent, SessionDisclosure, type SessionRenderContext } from './SessionContent';
import { SessionViewport } from './SessionViewport';
import { useRendererStore } from './store-context';
import type { SessionInsertion, SessionLayoutHooks, SessionRow } from './types';
import {
  RELATIONSHIPS_SECTION_ID,
  type SessionModel,
  type SessionSourceModel,
  useSessionModel
} from './use-session-model';
import { type SectionWindow, useViewStateReporting } from './view-state';
import './session-renderer.css';

/** Rows in the initial card-detail preview of a section. */
export const PREVIEW_ROWS = 3;
/** Rows added by each explicit paging action. */
export const PAGE_ROWS = 20;
/** Most rows mounted per section in card detail. */
export const MAX_WINDOW_ROWS = 100;
/** Measured height above which card detail narrows its windows, below the bridge ceiling. */
export const HEIGHT_BUDGET = 60_000;

/** Shared context for nested child sections, so memoized rows never rerender for child updates. */
interface RendererContextValue {
  // biome-ignore lint/suspicious/noExplicitAny: provider payloads are erased below the composition seam.
  readonly model: SessionModel<any>;
  // biome-ignore lint/suspicious/noExplicitAny: provider payloads are erased below the composition seam.
  readonly adapter: SessionProviderAdapter<any>;
  readonly compact: boolean;
  readonly windows: ReadonlyMap<string, SectionWindow>;
  readonly setWindow: (key: string, window: SectionWindow) => void;
}

const RendererContext = createContext<RendererContextValue | null>(null);

/**
 * Reads the renderer context.
 * @returns Context value.
 * @throws {Error} When rendered outside a SessionRenderer.
 */
function useRenderer(): RendererContextValue {
  const value = useContext(RendererContext);
  if (!value) throw new Error('Session sections require a SessionRenderer');
  return value;
}

/**
 * Renders the store's session for one provider in the host-selected mode.
 * @param root0 - Renderer props.
 * @param root0.adapter - Provider seam.
 * @returns Expanded or card-detail session.
 */
export function SessionRenderer<Payloads extends object>({
  adapter
}: {
  adapter: SessionProviderAdapter<Payloads>;
}): ReactElement {
  const store = useRendererStore();
  const model = useSessionModel(adapter);
  const compact = model.state.mode === 'compact';
  const [windows, setWindows] = useState<ReadonlyMap<string, SectionWindow>>(() => model.restored.windows);
  const setWindow = useCallback((key: string, window: SectionWindow) => {
    setWindows((previous) => new Map(previous).set(key, window));
  }, []);
  const value = useMemo<RendererContextValue>(
    () => ({ model, adapter, compact, windows, setWindow }),
    [model, adapter, compact, windows, setWindow]
  );
  useCloseEmptySession(model.state, compact);
  // Ranges for sources that left the session are never reported back, so dead keys cannot accumulate.
  const viewState = useMemo(
    () => ({
      open: model.disclosures.open,
      full: new Set([...model.full].filter((key) => model.sources.has(key))),
      windows: new Map([...windows].filter(([key]) => model.sources.has(key)))
    }),
    [model.disclosures.open, model.full, model.sources, windows]
  );
  useViewStateReporting(store, viewState);
  return (
    <RendererContext.Provider value={value}>
      {compact ? <CompactSession /> : <ExpandedSession />}
    </RendererContext.Provider>
  );
}

/**
 * Asks the host to close a card-detail renderer only for a settled session with no records.
 * @param state - Current store state.
 * @param compact - Whether the renderer is in card detail.
 */
function useCloseEmptySession(state: StreamStoreState, compact: boolean): void {
  const store = useRendererStore();
  const closed = useRef(false);
  useEffect(() => {
    if (closed.current || !compact || state.descriptor.members.length === 0) return;
    const views = state.descriptor.members.map((member) =>
      state.sources.get(JSON.stringify([member.source.cardId, member.source.streamType, member.source.relPath]))
    );
    const settled = views.every(
      (view) => view?.status === 'ready' && view.totalLineCount === 0 && view.meta && !view.meta.isActive
    );
    if (!settled) return;
    closed.current = true;
    store.close();
  }, [store, compact, state]);
}

/**
 * Stable insertion renderer; content comes from context so row memoization holds.
 * @param insertion - Placement to render.
 * @param context - Parent render context.
 * @returns Relationship section or child section.
 */
const renderInsertion = (insertion: SessionInsertion, context: SessionRenderContext): ReactNode =>
  insertion.placementId === RELATIONSHIPS_SECTION_ID ? (
    <RelationshipsSection context={context} />
  ) : (
    <ChildSection childKey={insertion.childSourceKey} context={context} />
  );

/**
 * Session-level notices: grouping validity, capability limits and the main source's state.
 * @returns Notices, or null.
 */
function SessionNotices(): ReactElement | null {
  const { model, adapter } = useRenderer();
  const { descriptor } = model.state;
  const main = model.composition.mainKey ? model.sources.get(model.composition.mainKey) : undefined;
  const notices: ReactElement[] = [];
  if (descriptor.validity === 'missing-main')
    notices.push(
      <Notice key="validity" tone="error">
        No main transcript is available for this session; its members are listed below.
      </Notice>
    );
  if (descriptor.validity === 'conflicting-main')
    notices.push(
      <Notice key="validity" tone="error">
        More than one source claims to be this session’s main transcript; each is listed below.
      </Notice>
    );
  if (main?.entry.source.error) notices.push(<SourceError key="main-error" source={main} />);
  const capability = main?.linkage?.capability;
  if (model.composition.sections.length > 0 && capability && capability !== 'witnessed-delegation')
    notices.push(
      <Notice key="capability" tone="info">
        {capability === 'main-only'
          ? `${adapter.agentName} transcripts record no delegation; other session members are listed separately.`
          : `${adapter.agentName} transcripts reference other sessions without witnessed delegation; members are listed separately.`}
      </Notice>
    );
  if (notices.length === 0) return null;
  return <div className="session-notices">{notices}</div>;
}

/**
 * One session-level notice.
 * @param root0 - Notice props.
 * @param root0.tone - Visual tone.
 * @param root0.children - Notice text.
 * @returns Notice paragraph.
 */
function Notice({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }): ReactElement {
  return (
    <p className={`session-notice session-tone--${tone}`} role="status">
      {children}
    </p>
  );
}

/**
 * A source's visible failure; a paused source offers Retry, which asks the host to resynchronize.
 * @param root0 - Notice props.
 * @param root0.source - Projected source with an error.
 * @returns Error notice with its Retry action when the source is paused.
 */
function SourceError({ source }: { source: SessionSourceModel<object> }): ReactElement {
  const store = useRendererStore();
  return (
    <div className="session-source-error">
      <p className="session-notice session-tone--error" role="status">
        {source.entry.source.error}
      </p>
      {source.entry.view.status === 'paused' ? (
        <button
          type="button"
          className="session-retry"
          aria-label={`Retry ${source.title}`}
          onClick={() => store.retry()}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Whether a source shows retained content that the host is still resynchronizing.
 * @param source - Projected source.
 * @returns True while retained lines are not yet current.
 */
function isStale(source: SessionSourceModel<object> | undefined): boolean {
  return source?.entry.view.status === 'resynchronizing' && source.entry.view.lines.length > 0;
}

/**
 * Expanded panel: header, notices and the scroll-owning viewport.
 * @returns Header, notices and a follow-capable viewport over the main source.
 */
function ExpandedSession(): ReactElement {
  const { model, adapter } = useRenderer();
  const mainKey = model.composition.mainKey;
  const main = mainKey ? model.sources.get(mainKey) : undefined;
  const header = main?.projection.header;
  const emptyContent = useMemo(
    () => (
      <p className="session-muted">
        {main?.entry.source.isLoading !== false ? 'Loading transcript…' : adapter.emptyText}
      </p>
    ),
    [main?.entry.source.isLoading, adapter.emptyText]
  );
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      {main ? <SessionHeader {...adapter.header(main.projection)} /> : null}
      <SessionNotices />
      <div
        className="flex-1 min-h-0 session-source-content"
        data-stale={isStale(main) || undefined}
        aria-busy={isStale(main) || undefined}
      >
        <SessionViewport
          rows={main?.projection.rows ?? NO_ROWS}
          insertions={model.insertions.get(mainKey ?? '')}
          renderInsertion={renderInsertion}
          providerParts={adapter.providerParts}
          providerRows={adapter.providerRows}
          renderTool={adapter.renderTool}
          disclosures={model.disclosures}
          emptyContent={main ? emptyContent : NO_MAIN}
          ariaLabel={`${adapter.agentName} session transcript`}
          agentName={adapter.agentName}
          sessionStatus={header?.status}
        />
      </div>
    </div>
  );
}

const NO_ROWS: readonly SessionRow[] = [];
const NO_MAIN = <p className="session-muted">No main transcript.</p>;

/**
 * Card-detail session: summary card, notices and windowed normal-flow content.
 * @returns Card-detail session.
 */
function CompactSession(): ReactElement {
  const { model, adapter } = useRenderer();
  const store = useRendererStore();
  const root = useRef<HTMLDivElement>(null);
  const bridge = useRef<LayoutBridge | null>(null);
  const handshaken = useRef<string | null>(null);
  const [hooks, setHooks] = useState<SessionLayoutHooks>({});
  const [overHeight, setOverHeight] = useState(0);
  useLayoutEffect(() => {
    const next = createLayoutBridge({
      root: root.current!,
      post: (payload) => store.postLayout(payload),
      onHeight: (height) => setOverHeight((previous) => (height > HEIGHT_BUDGET ? previous + 1 : previous))
    });
    bridge.current = next;
    handshaken.current = null;
    setHooks(next.hooks);
    return () => {
      next.dispose();
      bridge.current = null;
    };
  }, [store]);
  const token = model.state.layoutToken;
  // Each bridge answers each token once, including a token that arrived before this bridge mounted.
  useLayoutEffect(() => {
    if (!token || !bridge.current || handshaken.current === token) return;
    handshaken.current = token;
    bridge.current.handshake();
  }, [token]);
  const mainKey = model.composition.mainKey;
  const main = mainKey ? model.sources.get(mainKey) : undefined;
  const Summary = adapter.Summary;
  return (
    <div ref={root} className="session-compact">
      {main ? (
        <Summary
          source={main.entry.source}
          earlierUnloaded={main.entry.view.earlierUnloaded}
          coverage={{
            first: main.entry.view.firstLineNumber,
            last: main.entry.view.firstLineNumber + main.entry.view.lines.length - 1,
            total: main.entry.view.totalLineCount
          }}
        />
      ) : null}
      <SessionNotices />
      <WindowedSection
        sourceKey={mainKey ?? ''}
        source={main}
        insertions={model.insertions.get(mainKey ?? '') ?? NO_INSERTIONS}
        disclosures={model.disclosures}
        layout={hooks}
        overHeight={overHeight}
        label="Conversation"
        stale={isStale(main)}
      />
    </div>
  );
}

const NO_INSERTIONS: readonly SessionInsertion[] = [];

/**
 * Bounded window over one source's rows with explicit paging and an honest range label.
 * Witnessed insertions anchored outside the window move to the window edge, so a member is
 * never hidden or duplicated by paging.
 * @param root0 - Section props.
 * @param root0.sourceKey - Source key, also the window key.
 * @param root0.source - Projected source, absent for missing-main sessions.
 * @param root0.insertions - Insertions rendered within this source.
 * @param root0.disclosures - Session disclosure state.
 * @param root0.layout - Layout bridge hooks.
 * @param root0.overHeight - Count of over-budget height reports, narrowing the window.
 * @param root0.label - Accessible section label.
 * @param root0.stale - Whether retained content is still resynchronizing.
 * @returns Windowed content with its controls.
 */
function WindowedSection({
  sourceKey,
  source,
  insertions,
  disclosures,
  layout,
  overHeight,
  label,
  stale = false
}: {
  sourceKey: string;
  source: SessionSourceModel<object> | undefined;
  insertions: readonly SessionInsertion[];
  disclosures: SessionRenderContext['disclosures'];
  layout: SessionLayoutHooks;
  overHeight: number;
  label: string;
  stale?: boolean;
}): ReactElement {
  const { model, adapter, windows, setWindow } = useRenderer();
  const rows = source?.projection.rows ?? NO_ROWS;
  const window = windows.get(sourceKey) ?? { startLine: null, count: PREVIEW_ROWS };
  const narrowed = useRef(overHeight);
  const [tooTall, setTooTall] = useState(false);
  // Oversized measurements halve the mounted window, keeping the next page under the ceiling;
  // a single entry that is still too tall is replaced by an explicit notice.
  useEffect(() => {
    if (overHeight <= narrowed.current) return;
    narrowed.current = overHeight;
    if (window.count > 1) setWindow(sourceKey, { ...window, count: Math.max(1, Math.floor(window.count / 2)) });
    else setTooTall(true);
  }, [overHeight, window, sourceKey, setWindow]);
  const page = (next: SectionWindow): void => {
    setTooTall(false);
    setWindow(sourceKey, next);
  };
  const range = windowRange(rows, window);
  const visible = useMemo(() => rows.slice(range.start, range.end), [rows, range.start, range.end]);
  const placed = useMemo(
    () => edgeInsertions(insertions, rows, { start: range.start, end: range.end }),
    [insertions, rows, range.start, range.end]
  );
  const view = source?.entry.view;
  const earlier = range.start > 0 || Boolean(view?.earlierUnloaded);
  const showEarlier = (): void => {
    if (range.start === 0) {
      if (view?.earlierUnloaded) model.loadFull(sourceKey);
      return;
    }
    const start = Math.max(0, range.start - PAGE_ROWS);
    page({ startLine: rowLine(rows[start]!), count: window.startLine === null ? MAX_WINDOW_ROWS : window.count });
  };
  const showNewer = (): void => {
    const start = Math.min(rows.length - 1, range.start + PAGE_ROWS);
    page({ startLine: rowLine(rows[start]!), count: window.count });
  };
  const showConversation = (): void => {
    const start = Math.max(0, rows.length - PAGE_ROWS);
    page({ startLine: rows[start] ? rowLine(rows[start]) : null, count: MAX_WINDOW_ROWS });
  };
  const loading = view?.history === 'full' && view.earlierUnloaded && view.status !== 'ready';
  return (
    <section
      className="session-window session-source-content"
      aria-label={label}
      data-stale={stale || undefined}
      aria-busy={stale || undefined}
    >
      <div className="session-window-controls">
        <span className="session-muted session-window-range">{rangeLabel(range, rows.length, view)}</span>
        {earlier ? (
          <button type="button" onClick={showEarlier} disabled={loading}>
            {loading ? 'Loading earlier…' : 'Show earlier'}
          </button>
        ) : null}
        {window.startLine === null && rows.length > range.end - range.start ? (
          <button type="button" onClick={showConversation}>
            Show conversation
          </button>
        ) : null}
      </div>
      {tooTall ? (
        <p className="session-notice session-tone--info" role="status">
          This entry is too tall to show in the card. Open the session to inspect it in full.
        </p>
      ) : (
        <SessionContent
          rows={visible}
          insertions={placed}
          renderInsertion={renderInsertion}
          providerParts={adapter.providerParts}
          providerRows={adapter.providerRows}
          renderTool={adapter.renderTool}
          disclosures={disclosures}
          layout={layout}
          emptyContent={
            source ? (
              <p className="session-muted">
                {source.entry.source.isLoading ? 'Loading transcript…' : adapter.emptyText}
              </p>
            ) : (
              NO_MAIN
            )
          }
        />
      )}
      {range.end < rows.length && window.startLine !== null ? (
        <div className="session-window-controls">
          <button type="button" onClick={showNewer}>
            Show newer ({rows.length - range.end})
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * First absolute native line a row projects, so windows survive rebuilds and earlier loads.
 * @param row - Projected row.
 * @returns Absolute line number, or 1 for a row without native provenance.
 */
function rowLine(row: SessionRow): number {
  return Math.max(1, row.provenance[0]?.lineNumber ?? 1);
}

/**
 * Resolves a window to row indices: the first row at or after the window's native start line;
 * a start beyond the loaded rows shows the live end.
 * @param rows - Section rows.
 * @param window - Window state.
 * @returns Half-open index range.
 */
export function windowRange(rows: readonly SessionRow[], window: SectionWindow): { start: number; end: number } {
  const startLine = window.startLine;
  const found = startLine === null ? -1 : rows.findIndex((row) => rowLine(row) >= startLine);
  if (found < 0) {
    const start = Math.max(0, rows.length - window.count);
    return { start, end: rows.length };
  }
  return { start: found, end: Math.min(rows.length, found + window.count) };
}

/**
 * Visible range label naming mounted rows and unloaded native history.
 * @param range - Mounted range.
 * @param range.start - First mounted row index.
 * @param range.end - Index after the last mounted row.
 * @param total - Loaded row count.
 * @param view - Source view.
 * @returns Label text.
 */
function rangeLabel(
  range: { start: number; end: number },
  total: number,
  view: SessionSourceModel<object>['entry']['view'] | undefined
): string {
  const shown =
    total === 0 ? 'No entries loaded' : `Showing entries ${range.start + 1}–${range.end} of ${total} loaded`;
  return view?.earlierUnloaded ? `${shown}; earlier content not loaded` : shown;
}

/**
 * Moves witnessed insertions whose anchor row is outside the window to the nearest edge.
 * @param insertions - Source insertions.
 * @param rows - All section rows.
 * @param range - Mounted range.
 * @param range.start - First mounted row index.
 * @param range.end - Index after the last mounted row.
 * @returns Insertions valid for the mounted rows.
 */
export function edgeInsertions(
  insertions: readonly SessionInsertion[],
  rows: readonly SessionRow[],
  range: { start: number; end: number }
): readonly SessionInsertion[] {
  if (range.start === 0 && range.end === rows.length) return insertions;
  const index = new Map(rows.map((row, position) => [row.id, position]));
  let changed = false;
  const placed = insertions.map((entry): SessionInsertion => {
    if (entry.placement.kind !== 'witnessed') return entry;
    const position = index.get(entry.placement.rowId) ?? -1;
    if (position >= range.start && position < range.end) return entry;
    changed = true;
    return { ...entry, placement: { kind: 'section', position: position < range.start ? 'start' : 'end' } };
  });
  return changed ? placed : insertions;
}

/**
 * One child source rendered inside its disclosure: identity, state, and its own content.
 * @param root0 - Section props.
 * @param root0.childKey - Child source key.
 * @param root0.context - Parent render context.
 * @returns Child content.
 */
function ChildSection({ childKey, context }: { childKey: string; context: SessionRenderContext }): ReactElement {
  const { model, adapter, compact } = useRenderer();
  const source = model.sources.get(childKey);
  if (!source) return <p className="session-muted">This source is no longer available.</p>;
  const view = source.entry.view;
  const insertions = model.insertions.get(childKey) ?? NO_INSERTIONS;
  const loadingEarlier = view.earlierUnloaded && view.history === 'full' && view.status !== 'ready';
  return (
    <div
      className="session-child session-source-content"
      data-session-child={childKey}
      data-stale={isStale(source) || undefined}
      aria-busy={isStale(source) || undefined}
    >
      <SessionHeader {...adapter.header(source.projection)} />
      {source.entry.source.error ? <SourceError source={source} /> : null}
      {compact ? (
        <WindowedSection
          sourceKey={childKey}
          source={source}
          insertions={insertions}
          disclosures={context.disclosures}
          layout={context.layout}
          overHeight={0}
          label={source.title}
        />
      ) : (
        <>
          {view.earlierUnloaded ? (
            <div className="session-window-controls">
              <span className="session-muted">Earlier content not loaded.</span>
              <button type="button" onClick={() => model.loadFull(childKey)} disabled={loadingEarlier}>
                {loadingEarlier ? 'Loading earlier…' : 'Show earlier'}
              </button>
            </div>
          ) : null}
          <SessionContent
            rows={source.projection.rows}
            insertions={insertions}
            renderInsertion={renderInsertion}
            providerParts={adapter.providerParts}
            providerRows={adapter.providerRows}
            renderTool={adapter.renderTool}
            disclosures={context.disclosures}
            layout={context.layout}
            emptyContent={
              <p className="session-muted">
                {source.entry.source.isLoading ? 'Loading transcript…' : adapter.emptyText}
              </p>
            }
          />
        </>
      )}
    </div>
  );
}

/** Diagnostic copy; identifiers and line numbers only, never transcript text. */
const ISSUE_TEXT: Record<RelationshipDiagnostic['issue'], string> = {
  'unresolved-target': 'Delegation target is not a member of this session',
  'ambiguous-target': 'Delegation target matches more than one member',
  'duplicate-delegation': 'More than one delegation claims this member',
  'cyclic-delegation': 'Delegations form a cycle',
  'missing-parent-row': 'Delegation call is outside the loaded transcript',
  'reference-only': 'Referenced session without witnessed delegation',
  'native-diagnostic': 'Native linkage diagnostic'
};

/**
 * Session-level section for anomalous members and relationship diagnostics.
 * @param root0 - Section props.
 * @param root0.context - Parent render context.
 * @returns Diagnostics and anomalous member disclosures.
 */
function RelationshipsSection({ context }: { context: SessionRenderContext }): ReactElement {
  const { model } = useRenderer();
  const { composition } = model;
  return (
    <div className="session-relationships">
      {composition.anomalous.map((key) => (
        <SessionDisclosure
          key={key}
          id={composition.children.get(key)!.placementId}
          label={anomalousLabel(model, key)}
          context={context}
        >
          <ChildSection childKey={key} context={context} />
        </SessionDisclosure>
      ))}
      {composition.diagnostics.length > 0 ? (
        <ul className="session-diagnostics">
          {composition.diagnostics.map((item) => (
            <li key={item.id}>
              {ISSUE_TEXT[item.issue]}
              {item.reason ? ` (${item.reason})` : ''}
              {item.childKey ? ` · ${model.sources.get(item.childKey)?.title ?? 'unknown member'}` : ''}
              {item.callId ? ` · call ${item.callId}` : ''}
              {` · ${model.sources.get(item.sourceKey)?.title ?? 'source'}`}
              {item.lines.length ? ` line ${item.lines.join(', ')}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Label for an anomalous member.
 * @param model - Session model.
 * @param key - Member key.
 * @returns Label text.
 */
function anomalousLabel(model: SessionModel<object>, key: string): string {
  const source = model.sources.get(key);
  const role = source?.role === 'auxiliary' ? 'Auxiliary' : 'Subagent';
  return `${role}: ${source?.title ?? 'unknown member'} · relationship unresolved`;
}

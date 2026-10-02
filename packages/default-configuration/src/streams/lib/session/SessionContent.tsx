/**
 * Render-only content contracts shared by expanded viewports and future parent bridges.
 *
 * Content never discovers sources, subscribes to transport, or owns a scroll container.
 *
 * @summary Controlled session rows, provider registries, and child insertion hooks
 * @module streams/lib/session/SessionContent
 */

import {
  type ComponentProps,
  type ComponentType,
  createContext,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { renderMarkdownNodes } from '../markdown';
import './session.css';
import { InspectionPages, LeafViewState, useLeafViewState, useOwnedLeafViewState } from './leaf-view-state';
import type {
  SessionDisclosureState,
  SessionInsertion,
  SessionLayoutHooks,
  SessionLeaf,
  SessionPart,
  SessionRow,
  SessionToolPart
} from './types';

/** Provider renderers receive the same controlled disclosure and layout hooks as shared parts. */
export interface SessionRenderContext {
  readonly disclosures: SessionDisclosureState;
  readonly layout: SessionLayoutHooks;
}

/** A typed provider payload coupled to its original identity and physical provenance. */
export interface ProviderPresentationProps<Payload> extends SessionRenderContext {
  readonly leaf: SessionLeaf;
  readonly data: Payload;
}

/**
 * Provider presentation declares every controlled map key read by rendering and event callbacks.
 * Each mounted row receives the full immutable map from its last relevant committed render,
 * including for nested child content. Declare every key that can affect rendering or a callback;
 * map iteration, size, or arbitrary dependent child content requires an undefined declaration.
 * Selectors depend only on immutable leaf/payload data and include closed descendants' keys.
 */
export interface SessionProviderPresentation<Payload> {
  readonly render: (props: ProviderPresentationProps<Payload>) => ReactNode;
  /** Exact keys, or undefined for map-wide iteration, size, or arbitrary child content. */
  readonly disclosureKeys: (leaf: SessionLeaf, data: Payload) => readonly string[] | undefined;
}

/** Mapped keys preserve provider payload types across rendering and dependency declarations. */
export type SessionProviderRegistry<Payloads extends object> = {
  readonly [Kind in keyof Payloads & string]: SessionProviderPresentation<Payloads[Kind]>;
};

/** Caller supplies already-projected rows and already-validated composition descriptors. */
export interface SessionContentProps<Payloads extends object = Record<string, unknown>> {
  readonly rows: readonly SessionRow<Payloads>[];
  readonly disclosures: SessionDisclosureState;
  readonly providerParts?: SessionProviderRegistry<Payloads>;
  readonly providerRows?: SessionProviderRegistry<Payloads>;
  /** Optional provider presentation of shared tool data with controlled leaf state. */
  readonly renderTool?: (part: SessionToolPart, context: SessionRenderContext) => ReactNode;
  readonly insertions?: readonly SessionInsertion[];
  /** Child content is supplied by the caller; this function must not create a nested viewport. */
  readonly renderInsertion?: (insertion: SessionInsertion, context: SessionRenderContext) => ReactNode;
  readonly layout?: SessionLayoutHooks;
  readonly emptyContent?: ReactNode;
  readonly className?: string;
}

/**
 * Renders native semantic rows with stable leaf keys and controlled disclosures.
 * Missing witnessed anchors are omitted rather than guessed; explicit sections remain valid.
 * Raw oversized content is inspected in bounded pages with an explicit amount-shown label.
 * @param props - Render-only content and provider presentation hooks.
 * @returns Content suitable for an owning viewport or outer page.
 */
export function SessionContent<Payloads extends object>(props: SessionContentProps<Payloads>): ReactElement {
  const state = useContext(LeafViewState);
  return state ? <SessionContentBody {...props} /> : <SessionContentOwner {...props} />;
}

/**
 * Owns inspection state once for the entire expanded content tree.
 * @param props - Content and controlled disclosure identities.
 * @returns Content with shared leaf inspection ownership.
 */
function SessionContentOwner<Payloads extends object>(props: SessionContentProps<Payloads>): ReactElement {
  const state = useOwnedLeafViewState(props.rows, props.disclosures);
  return (
    <LeafViewState.Provider value={state}>
      <SessionContentBody {...props} />
    </LeafViewState.Provider>
  );
}

/**
 * Renders content using the enclosing view's inspection state and local framing.
 * @param props - Render-only content and provider presentation hooks.
 * @returns The framed rows and nested render-only content.
 */
function SessionContentBody<Payloads extends object>(props: SessionContentProps<Payloads>): ReactElement {
  const {
    rows,
    disclosures,
    providerParts,
    providerRows,
    renderTool,
    insertions = EMPTY_INSERTIONS,
    renderInsertion,
    layout = {},
    emptyContent,
    className
  } = props;
  const batches = useMemo(() => presentationBatches(rows), [rows]);
  const frames = useContext(SessionFrames);
  const Root = frames?.Root ?? 'div';
  const Row = frames?.Row ?? 'div';
  // The full immutable map remains available to nested content. Declarations govern memoization,
  // including event-only reads; each mounted row retains one coherent render/event snapshot.
  const context = useMemo<SessionRenderContext>(() => ({ disclosures, layout }), [disclosures, layout]);
  const { root: rootElement, pages, elements } = useLeafViewState();
  const latestLayout = useRef({ layout, rows });
  latestLayout.current = { layout, rows };
  useEffect(() => {
    if (!rootElement.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const current = latestLayout.current;
      const id = current.rows[0]?.parts[0]?.id ?? current.rows[0]?.id;
      if (id) current.layout.onAfterLayoutChange?.(id);
    });
    observer.observe(rootElement.current);
    return () => observer.disconnect();
  }, [rootElement]);
  const insertion = (entry: SessionInsertion): ReactNode => (
    <SessionDisclosure key={entry.placementId} id={entry.placementId} label={entry.label} context={context}>
      {renderInsertion?.(entry, context)}
    </SessionDisclosure>
  );
  const sections = (position: 'start' | 'end'): ReactNode =>
    insertions
      .filter((entry) => entry.placement.kind === 'section' && entry.placement.position === position)
      .map(insertion);
  const witnessed = (row: SessionRow<Payloads>, position: 'before' | 'after', partId?: string): ReactNode =>
    insertions
      .filter((entry) => {
        const target = entry.placement;
        return (
          target.kind === 'witnessed' &&
          target.rowId === row.id &&
          target.partId === partId &&
          target.position === position &&
          row.provenance.some((origin) => origin.sourceKey === target.parentSourceKey)
        );
      })
      .map(insertion);
  return (
    <SessionFrames.Provider value={null}>
      <InspectionPages.Provider value={pages}>
        <Root ref={rootElement} className={`session-content ${className ?? ''}`}>
          {sections('start')}
          {rows.length === 0 ? (emptyContent ?? <p className="session-muted">No output yet.</p>) : null}
          {batches.map((batch) => (
            <MemoSessionBatch
              key={batch.id}
              rows={batch.rows}
              context={context}
              open={disclosures.open}
              providerParts={providerParts}
              providerRows={providerRows}
              renderTool={renderTool}
              insertions={insertions}
              renderInsertion={renderInsertion}
            >
              {() => (
                <Row className="session-batch" data-session-id={batch.id}>
                  {batch.rows.map((row) => (
                    <MemoSessionRow
                      key={row.id}
                      row={row}
                      context={context}
                      open={disclosures.open}
                      providerParts={providerParts}
                      providerRows={providerRows}
                      renderTool={renderTool}
                      insertions={insertions}
                      renderInsertion={renderInsertion}
                    >
                      {() => (
                        <Row
                          data-session-id={row.id}
                          data-session-turn={row.anchor === 'turn' ? 'true' : undefined}
                          className={`session-row session-row--${row.kind}`}
                        >
                          {witnessed(row, 'before')}
                          {row.kind === 'provider' && providerRows?.[row.providerKind] ? (
                            providerRows[row.providerKind].render({ leaf: row, data: row.data, ...context })
                          ) : row.kind === 'message' ? (
                            <div className="session-label">{row.label ?? row.role}</div>
                          ) : row.kind === 'structural' ? (
                            <div className={`session-label session-tone--${row.tone}`}>{row.label}</div>
                          ) : (
                            <ProviderFallback leaf={row} data={row.data} context={context} />
                          )}
                          {row.parts.map((part) => (
                            <SessionLeafFrame
                              key={part.id}
                              leaf={part}
                              context={context}
                              onElement={(element) => {
                                if (element) elements.set(part.id, element);
                                else elements.delete(part.id);
                              }}
                            >
                              {witnessed(row, 'before', part.id)}
                              <SessionPartView
                                part={part}
                                context={context}
                                registry={providerParts}
                                renderTool={renderTool}
                              />
                              {witnessed(row, 'after', part.id)}
                            </SessionLeafFrame>
                          ))}
                          {witnessed(row, 'after')}
                        </Row>
                      )}
                    </MemoSessionRow>
                  ))}
                </Row>
              )}
            </MemoSessionBatch>
          ))}
          {sections('end')}
        </Root>
      </InspectionPages.Provider>
    </SessionFrames.Provider>
  );
}

/** Internal structural slots let the viewport supply MessageScroller's direct-child wrappers. */
export const SessionFrames = createContext<{
  Root: ComponentType<ComponentProps<'div'>>;
  Row: ComponentType<ComponentProps<'div'>>;
} | null>(null);

/** Registers stable leaf geometry independently of group container identity.
 * @param root0 - Stable leaf registration props.
 * @param root0.leaf - Identity and provenance of this leaf.
 * @param root0.context - Controlled disclosure and layout hooks.
 * @param root0.children - Already projected leaf presentation.
 * @param root0.onElement - Receives the current leaf element or its removal.
 * @returns Rendered session presentation.
 */
function SessionLeafFrame({
  leaf,
  context,
  children,
  onElement
}: {
  leaf: SessionLeaf;
  context: SessionRenderContext;
  children: ReactNode;
  onElement: (element: HTMLElement | null) => void;
}): ReactElement {
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef({ onElement, context });
  latest.current = { onElement, context };
  useLayoutEffect(() => {
    const node = element.current;
    latest.current.onElement(node);
    latest.current.context.layout.onAnchorElement?.(leaf.id, node);
    return () => {
      latest.current.onElement(null);
      latest.current.context.layout.onAnchorElement?.(leaf.id, null);
    };
  }, [leaf.id]);
  return (
    <div
      ref={element}
      data-session-id={leaf.id}
      className="session-part"
      onFocus={() => {
        context.layout.onFocusChange?.(leaf.id);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) context.layout.onFocusChange?.(null);
      }}
    >
      {children}
    </div>
  );
}

/** Controlled native button disclosure; closed bodies do no expensive rendering.
 * @param root0 - Controlled disclosure props.
 * @param root0.id - Stable leaf or placement identity.
 * @param root0.label - Accessible disclosure label.
 * @param root0.context - Controlled open state and layout hooks.
 * @param root0.children - Lazy body mounted only when open.
 * @returns Rendered session presentation.
 */
export function SessionDisclosure({
  id,
  label,
  context,
  children
}: {
  id: string;
  label: string;
  context: SessionRenderContext;
  children: ReactNode;
}): ReactElement {
  const bodyId = useId();
  const open = context.disclosures.open.get(id) ?? false;
  const latest = useRef(context.layout);
  latest.current = context.layout;
  const previousOpen = useRef(open);
  useLayoutEffect(() => {
    if (previousOpen.current !== open) latest.current.onAfterLayoutChange?.(id);
    previousOpen.current = open;
  }, [id, open]);
  return (
    <div className="session-disclosure" data-session-disclosure={id}>
      <button
        type="button"
        className="session-disclosure-button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          context.layout.onBeforeLayoutChange?.(id);
          context.disclosures.onOpenChange(id, !open);
        }}
      >
        <span aria-hidden="true" className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
        <span>{label}</span>
      </button>
      {open ? (
        <div id={bodyId} className="session-disclosure-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A fixed character window keeps even multi-megabyte details fully inspectable with bounded DOM.
 * @param root0 - Paged inspection props.
 * @param root0.text - Complete retained text.
 * @param root0.id - Leaf owning the layout change.
 * @param root0.context - Layout notification hooks.
 * @param root0.slot - Independent inspection region within a leaf.
 * @returns Rendered session presentation.
 */
export function BoundedText({
  text,
  id,
  context,
  slot = 'content'
}: {
  text: string;
  id: string;
  context: SessionRenderContext;
  slot?: string;
}): ReactElement {
  const pages = useContext(InspectionPages);
  const [page, setPage] = useState(() => pages?.get(id)?.get(slot) ?? 0);
  const size = 4096;
  const lastPage = Math.max(0, Math.ceil(text.length / size) - 1);
  const current = Math.min(page, lastPage);
  let start = current * size;
  let end = Math.min(start + size, text.length);
  // Keep a UTF-16 surrogate pair on the preceding page instead of splitting its glyph.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start)) && /[\uD800-\uDBFF]/.test(text.charAt(start - 1)))
    start++;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end)) && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)))
    end++;
  const change = (next: number): void => {
    context.layout.onBeforeLayoutChange?.(id);
    if (pages) {
      let leaf = pages.get(id);
      if (!leaf) {
        leaf = new Map();
        pages.set(id, leaf);
      }
      leaf.set(slot, next);
    }
    setPage(next);
  };
  useLayoutEffect(() => {
    void current; // Page navigation changes layout even when text identity stays the same.
    context.layout.onAfterLayoutChange?.(id);
  }, [context.layout, current, id]);
  return (
    <div>
      {text.length > size ? (
        <div className="session-inspection-controls">
          <span>
            Characters {start + 1}–{end} of {text.length}
          </span>
          <button type="button" disabled={current === 0} onClick={() => change(current - 1)}>
            Previous
          </button>
          <button type="button" disabled={current === lastPage} onClick={() => change(current + 1)}>
            Next
          </button>
        </div>
      ) : null}
      <pre className="session-raw">{text.slice(start, end)}</pre>
    </div>
  );
}

/** Memoized Markdown avoids reparsing stable historical text during appends.
 * @param root0 - Safe Markdown props.
 * @param root0.text - Native textual content.
 * @param root0.id - Stable key prefix.
 * @returns Rendered session presentation.
 */
function Markdown({ text, id }: { text: string; id: string }): ReactElement {
  const content = useMemo(() => renderMarkdownNodes(text, id), [text, id]);
  return <div className="session-markdown">{content}</div>;
}

/** Unknown provider payloads remain inspectable if a consumer omits its typed renderer.
 * @param root0 - Unsupported provider presentation props.
 * @param root0.leaf - Stable payload identity.
 * @param root0.data - Retained provider payload.
 * @param root0.context - Controlled disclosure and layout hooks.
 * @returns Rendered session presentation.
 */
function ProviderFallback({
  leaf,
  data,
  context
}: {
  leaf: SessionLeaf;
  data: unknown;
  context: SessionRenderContext;
}): ReactElement {
  return (
    <SessionDisclosure id={leaf.id} label="Unsupported provider content" context={context}>
      <UnknownPayload data={data} id={leaf.id} context={context} />
    </SessionDisclosure>
  );
}

/** Serialization is lazy and memoized rather than repeated for closed details or every append.
 * @param root0 - Lazy payload inspection props.
 * @param root0.data - Native provider payload to inspect.
 * @param root0.id - Stable payload identity.
 * @param root0.context - Layout notification hooks.
 * @returns Rendered session presentation.
 */
function UnknownPayload({
  data,
  id,
  context
}: {
  data: unknown;
  id: string;
  context: SessionRenderContext;
}): ReactElement {
  const text = useMemo(() => (typeof data === 'string' ? data : (JSON.stringify(data) ?? String(data))), [data]);
  return <BoundedText text={text} id={id} context={context} />;
}

/** Shared rendering keeps tool state and provider payloads outside any conversation runtime.
 * @param root0 - Typed leaf rendering props.
 * @param root0.part - Cards-owned shared or provider part.
 * @param root0.context - Controlled disclosure and layout hooks.
 * @param root0.registry - Typed provider-specific part renderers.
 * @param root0.renderTool - Optional shared-tool presentation override.
 * @returns Rendered session presentation.
 */
function SessionPartView<Payloads extends object>({
  part,
  context,
  registry,
  renderTool
}: {
  part: SessionPart<Payloads>;
  context: SessionRenderContext;
  registry?: SessionProviderRegistry<Payloads>;
  renderTool?: SessionContentProps<Payloads>['renderTool'];
}): ReactNode {
  switch (part.kind) {
    case 'text':
      return part.text.length > 65536 ? (
        <BoundedText text={part.text} id={part.id} context={context} />
      ) : (
        <Markdown text={part.text} id={part.id} />
      );
    case 'reasoning':
      return (
        <SessionDisclosure id={part.id} label="Reasoning" context={context}>
          <BoundedText text={part.text} id={part.id} context={context} />
        </SessionDisclosure>
      );
    case 'raw':
      return (
        <SessionDisclosure id={part.id} label={part.label} context={context}>
          <BoundedText text={part.text} id={part.id} context={context} />
        </SessionDisclosure>
      );
    case 'attachment':
      return (
        <div className="session-attachment">
          <span className="session-label">{part.label}</span>
          <span>{part.description}</span>
        </div>
      );
    case 'provider':
      return registry?.[part.providerKind] ? (
        registry[part.providerKind].render({ leaf: part, data: part.data, ...context })
      ) : (
        <ProviderFallback leaf={part} data={part.data} context={context} />
      );
    case 'tool':
      return renderTool ? (
        renderTool(part, context)
      ) : (
        <SessionDisclosure id={part.id} label={`${part.name} · ${part.status}`} context={context}>
          <div className="session-label">Input</div>
          <BoundedText text={part.input} id={part.id} context={context} slot="input" />
          {part.output !== undefined ? (
            <>
              <div className="session-label">Output</div>
              <BoundedText text={part.output} id={part.id} context={context} slot="output" />
            </>
          ) : null}
        </SessionDisclosure>
      );
  }
}

const EMPTY_INSERTIONS: readonly SessionInsertion[] = [];

/** Props affecting one immutable row; the render closure is evaluated only when those inputs change. */
interface MemoSessionRowProps {
  readonly row: SessionRow;
  readonly context: SessionRenderContext;
  readonly open: ReadonlyMap<string, boolean>;
  readonly providerParts?: object;
  readonly providerRows?: object;
  readonly renderTool?: unknown;
  readonly insertions: readonly SessionInsertion[];
  readonly renderInsertion?: unknown;
  readonly children: () => ReactElement;
}

/**
 * Collects controlled dependencies declared by custom presentation and shared primitives.
 * @param row - Immutable row being compared.
 * @param presentation - Presentation registries and composition inputs.
 * @returns Exact keys, or undefined when this row owns arbitrary map-wide content.
 */
function rowDisclosureKeys(
  row: SessionRow,
  presentation: Pick<MemoSessionRowProps, 'providerParts' | 'providerRows' | 'renderTool' | 'insertions'>
): readonly string[] | undefined {
  const ids = [row.id, ...row.parts.map((part) => part.id)];
  const providerKeys = (registry: object | undefined, leaf: SessionLeaf, kind: string, data: unknown): boolean => {
    const entry = (registry as Record<string, SessionProviderPresentation<unknown>> | undefined)?.[kind];
    if (!entry) return true;
    const keys = entry.disclosureKeys(leaf, data);
    if (keys === undefined) return false;
    ids.push(...keys);
    return true;
  };
  if (row.kind === 'provider' && !providerKeys(presentation.providerRows, row, row.providerKind, row.data))
    return undefined;
  for (const part of row.parts) {
    if (part.kind === 'tool' && presentation.renderTool) return undefined;
    if (part.kind === 'provider' && !providerKeys(presentation.providerParts, part, part.providerKind, part.data))
      return undefined;
  }
  // A witnessed insertion can mount arbitrary child state; only its owning row is map-wide.
  if (
    presentation.insertions.some((entry) => {
      const placement = entry.placement;
      return (
        placement.kind === 'witnessed' &&
        placement.rowId === row.id &&
        row.provenance.some((origin) => origin.sourceKey === placement.parentSourceKey)
      );
    })
  )
    return undefined;
  return ids;
}

/**
 * Compares declared values and membership without conflating absent and explicit false.
 * @param row - Immutable row being compared.
 * @param presentation - Current custom presentation and composition inputs.
 * @param previous - Previous immutable controlled map.
 * @param next - Next immutable controlled map.
 * @returns Whether this row's complete declared state remains unchanged.
 */
function sameRowDisclosures(
  row: SessionRow,
  presentation: Pick<MemoSessionRowProps, 'providerParts' | 'providerRows' | 'renderTool' | 'insertions'>,
  previous: ReadonlyMap<string, boolean>,
  next: ReadonlyMap<string, boolean>
): boolean {
  if (previous === next) return true;
  const keys = rowDisclosureKeys(row, presentation);
  return keys?.every((id) => previous.get(id) === next.get(id) && previous.has(id) === next.has(id)) ?? false;
}

/**
 * Callback changes also invalidate immutable row snapshots so events never retain obsolete handlers.
 * @param previous - Prior render/event context.
 * @param next - Next render/event context.
 * @returns Whether all non-map callbacks are unchanged.
 */
function sameContextCallbacks(previous: SessionRenderContext, next: SessionRenderContext): boolean {
  return (
    previous.disclosures.onOpenChange === next.disclosures.onOpenChange &&
    previous.layout.onBeforeLayoutChange === next.layout.onBeforeLayoutChange &&
    previous.layout.onAfterLayoutChange === next.layout.onAfterLayoutChange &&
    previous.layout.onAnchorElement === next.layout.onAnchorElement &&
    previous.layout.onFocusChange === next.layout.onFocusChange
  );
}

/** Render immutable historical rows only when content or their disclosure state actually changes. */
const MemoSessionRow = memo(
  function MemoSessionRow(props: MemoSessionRowProps): ReactElement {
    return props.children();
  },
  (previous, next) => {
    if (
      previous.row !== next.row ||
      !sameContextCallbacks(previous.context, next.context) ||
      previous.providerParts !== next.providerParts ||
      previous.providerRows !== next.providerRows ||
      previous.renderTool !== next.renderTool ||
      previous.insertions !== next.insertions ||
      previous.renderInsertion !== next.renderInsertion
    )
      return false;
    return sameRowDisclosures(next.row, next, previous.open, next.open);
  }
);

/**
 * Physical buckets preserve native order and mounted leaf keys across append and prepend.
 * @param rows - Immutable display rows in native source order.
 * @returns Contiguous groups with stable source/coordinate keys.
 */
function presentationBatches<Payloads extends object>(
  rows: readonly SessionRow<Payloads>[]
): { id: string; rows: SessionRow<Payloads>[] }[] {
  const batches: { id: string; rows: SessionRow<Payloads>[] }[] = [];
  const occurrences = new Map<string, number>();
  let previousKey: string | undefined;
  for (const row of rows) {
    const origin = row.provenance[0];
    const key = origin
      ? JSON.stringify([origin.sourceKey, origin.generation, Math.floor((origin.lineNumber - 1) / 128)])
      : row.id;
    if (key === previousKey) batches[batches.length - 1]!.rows.push(row);
    else {
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      batches.push({ id: JSON.stringify([key, occurrence]), rows: [row] });
      previousKey = key;
    }
  }
  return batches;
}

/** Memoized native-coordinate groups keep unchanged history out of React reconciliation. */
const MemoSessionBatch = memo(
  function MemoSessionBatch(
    props: Omit<MemoSessionRowProps, 'row' | 'children'> & { rows: readonly SessionRow[]; children: () => ReactNode }
  ): ReactNode {
    return props.children();
  },
  (previous, next) => {
    if (
      previous.rows.length !== next.rows.length ||
      !sameContextCallbacks(previous.context, next.context) ||
      previous.rows.some((row, index) => row !== next.rows[index]) ||
      previous.providerParts !== next.providerParts ||
      previous.providerRows !== next.providerRows ||
      previous.renderTool !== next.renderTool ||
      previous.insertions !== next.insertions ||
      previous.renderInsertion !== next.renderInsertion
    )
      return false;
    return next.rows.every((row) => sameRowDisclosures(row, next, previous.open, next.open));
  }
);

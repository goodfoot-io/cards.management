/**
 * One session's projected sources, composition and controlled disclosure state.
 *
 * Projection runs synchronously from immutable store snapshots through one cached controller
 * per source, so a full replay and any incremental arrival order converge on the same rows and
 * the same placement in the same render. Host history subscription is explicit: members load a
 * bounded tail until a reader opens them or asks for earlier content.
 *
 * @summary Session-scoped projection, composition and disclosure model
 * @module streams/lib/session/use-session-model
 */

import { isGeneratedSubagentTitle, type SessionMember } from '@cards.management/sdk/protocol';
import type { StreamStoreState } from '@cards.management/sdk/stream-store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionProviderAdapter } from './adapter';
import { composeSession, type SessionComposition } from './compose';
import type { SourceLinkageEvidence } from './linkage';
import { createTranscriptProjection, type TranscriptProjectionController } from './projection';
import { useRendererStore } from './store-context';
import type {
  NativeTranscriptSource,
  SessionDisclosureState,
  SessionHeaderFacts,
  SessionInsertion,
  SessionProjection
} from './types';
import { type SessionSourceEntry, useSessionSources } from './use-transcript-source';
import { decodeViewState, type RestoredViewState } from './view-state';

/** Placement identity of the session-level relationship diagnostics section. */
export const RELATIONSHIPS_SECTION_ID = JSON.stringify(['session-relationships']);

/** One projected source with its presentation facts. */
export interface SessionSourceModel<Payloads extends object> {
  readonly entry: SessionSourceEntry;
  readonly projection: SessionProjection<Payloads>;
  readonly linkage: SourceLinkageEvidence | null;
  /** Accepted role, or null for retained unavailable history. */
  readonly role: SessionMember['role'] | null;
  /** Human label built only from host membership, metadata and native header facts. */
  readonly title: string;
}

/** Renderable session state. */
export interface SessionModel<Payloads extends object> {
  readonly state: StreamStoreState;
  readonly sources: ReadonlyMap<string, SessionSourceModel<Payloads>>;
  readonly composition: SessionComposition;
  /** Insertions rendered inside each parent source; the main also carries session sections. */
  readonly insertions: ReadonlyMap<string, readonly SessionInsertion[]>;
  readonly disclosures: SessionDisclosureState;
  /** Requests complete history for a source; `full` upgrades an existing tail subscription. */
  readonly loadFull: (key: string) => void;
  /** View state replayed by the host at initialization. */
  readonly restored: RestoredViewState;
  /** Sources the reader asked to load with full history, for view-state reporting. */
  readonly full: ReadonlySet<string>;
}

/** Cached per-source projection lifecycle. */
interface ProjectionCache<Payloads extends object> {
  readonly controller: TranscriptProjectionController<Payloads>;
  source: NativeTranscriptSource | null;
  projection: SessionProjection<Payloads> | null;
  linkage: SourceLinkageEvidence | null;
}

const NO_INSERTIONS: readonly SessionInsertion[] = [];

/**
 * Builds the renderable model for the store's session.
 * @param adapter - Provider parsing, linkage and presentation seam.
 * @returns Projected sources, composition, insertions and disclosure state.
 */
export function useSessionModel<Payloads extends object>(
  adapter: SessionProviderAdapter<Payloads>
): SessionModel<Payloads> {
  const store = useRendererStore();
  const snapshot = useSessionSources(store);
  const caches = useRef(new Map<string, ProjectionCache<Payloads>>());

  const sources = useMemo(() => {
    const projected: { entry: SessionSourceEntry; cache: ProjectionCache<Payloads> }[] = [];
    for (const entry of snapshot.entries) {
      let cache = caches.current.get(entry.key);
      if (!cache) {
        cache = {
          controller: createTranscriptProjection(adapter.projector, entry.key, { includeInvalidatedIds: false }),
          source: null,
          projection: null,
          linkage: null
        };
        caches.current.set(entry.key, cache);
      }
      // Idempotent per immutable snapshot, so StrictMode double rendering cannot double-apply.
      if (cache.source !== entry.source) {
        cache.projection = cache.controller.update(entry.source).projection;
        cache.linkage = entry.source.lines.length > 0 ? adapter.extractLinkage(entry.source) : null;
        cache.source = entry.source;
      }
      projected.push({ entry, cache });
    }
    const titles = distinctTitles(
      projected.map(({ entry, cache }) => sourceTitle(entry, cache.projection!.header)),
      projected.map(({ entry }) => entry)
    );
    const next = new Map<string, SessionSourceModel<Payloads>>();
    projected.forEach(({ entry, cache }, index) => {
      next.set(entry.key, {
        entry,
        projection: cache.projection!,
        linkage: cache.linkage,
        role: entry.view.member?.role ?? null,
        title: titles[index]!
      });
    });
    return next;
  }, [snapshot, adapter]);

  // Retired keys release their parse caches after commit; live keys keep theirs.
  useEffect(() => {
    for (const [key, cache] of caches.current) {
      if (sources.has(key)) continue;
      cache.controller.dispose();
      caches.current.delete(key);
    }
  }, [sources]);
  useEffect(
    () => () => {
      for (const cache of caches.current.values()) cache.controller.dispose();
      caches.current.clear();
    },
    []
  );

  const composition = useComposition(snapshot.state, sources, adapter);
  const insertions = useStableInsertions(composition, sources);

  const restored = useMemo(() => decodeViewState(store.getState().viewState), [store]);
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => restored.open);
  const [full, setFull] = useState<ReadonlySet<string>>(() => restored.full);
  const loadFull = useCallback(
    (key: string) => {
      const view = store.getState().sources.get(key);
      if (!view?.member) return;
      setFull((previous) => (previous.has(key) ? previous : new Set(previous).add(key)));
      if (view.history !== 'full' || view.status === 'unsubscribed') store.subscribeSource(view.source, 'full');
    },
    [store]
  );
  const onOpenChange = useCallback(
    (id: string, value: boolean) => {
      setOpen((previous) => new Map(previous).set(id, value));
      // Opening a member section is an explicit request for its complete history.
      if (value) {
        const key = childKeyOfPlacement(id);
        if (key) loadFull(key);
      }
    },
    [loadFull]
  );
  const disclosures = useMemo<SessionDisclosureState>(() => ({ open, onOpenChange }), [open, onOpenChange]);
  useDisclosureReconciliation(sources, composition, adapter, setOpen, restored);
  useMemberSubscriptions(snapshot.state, composition, open, full);

  return { state: snapshot.state, sources, composition, insertions, disclosures, loadFull, restored, full };
}

/**
 * Child source key encoded in a placement identity, if the identity is one.
 * @param id - Disclosure identity.
 * @returns Child source key or null.
 */
function childKeyOfPlacement(id: string): string | null {
  if (!id.startsWith('["session-member",')) return null;
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) && parsed[0] === 'session-member' && typeof parsed[1] === 'string' ? parsed[1] : null;
  } catch {
    return null;
  }
}

/**
 * Whether a source's projection covers its whole native history.
 * @param entry - Store entry.
 * @returns True once the source is ready from its first native line.
 */
function complete(entry: SessionSourceEntry): boolean {
  return entry.view.status === 'ready' && !entry.view.earlierUnloaded;
}

/**
 * Whether a restored disclosure id that no current projection produces can never reappear, so
 * replayed view state cannot accumulate dead ids. An id stays pending only while the source that
 * would produce it is still a member whose current incarnation is not fully loaded.
 * @param id - Restored disclosure identity not produced by any current projection.
 * @param entries - Current store entries by source key.
 * @returns True when the id is definitively absent.
 */
export function restoredIdAbsent(id: string, entries: ReadonlyMap<string, SessionSourceEntry>): boolean {
  const placed = childKeyOfPlacement(id);
  if (placed !== null) return !entries.get(placed)?.view.member;
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    parsed = null;
  }
  // Projection identities lead with their source key and generation.
  if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
    const entry = entries.get(parsed[0]);
    if (!entry?.view.member || complete(entry)) return true;
    return entry.view.status === 'ready' && entry.source.generation !== parsed[1];
  }
  // An id without a recognizable owner settles once every source is fully loaded.
  return [...entries.values()].every(complete);
}

/** Longest task text, in code points, a title carries before it is cut with an ellipsis. */
const TASK_TITLE_LIMIT = 48;

/**
 * Display title from accepted membership and native facts only; never invents an agent name.
 * A custom title wins; the card-scoped placeholder subagent title is not an identity and is
 * skipped. Without a title the native agent identity names the source, followed by its task text.
 * @param entry - Store entry carrying the accepted membership.
 * @param header - Native header facts of the current projection.
 * @returns Human-readable title.
 */
function sourceTitle(entry: SessionSourceEntry, header: SessionHeaderFacts): string {
  const member = entry.view.member;
  const meta = entry.view.meta;
  const cardId = entry.view.source.cardId;
  const custom = [member?.title, meta?.title, header.title].find(
    (title): title is string => title !== undefined && title.trim() !== '' && !isGeneratedSubagentTitle(title, cardId)
  );
  if (custom !== undefined) return custom;
  const identity = nativeIdentity(entry);
  const task = taskSummary(meta?.taskContent);
  return task === null ? identity : `${identity} — ${task}`;
}

/**
 * Native identity of a source: its provider agent id, else its native filename.
 * @param entry - Store entry.
 * @returns Identity text.
 */
function nativeIdentity(entry: SessionSourceEntry): string {
  const { member, meta, source } = entry.view;
  return member?.agentId ?? meta?.agentId ?? source.relPath.split('/').at(-1) ?? source.relPath;
}

/**
 * Single-line, bounded form of a source's native task text.
 * @param text - Task text from the sidecar, if any.
 * @returns Summary, or null when there is no task text.
 */
function taskSummary(text: string | undefined): string | null {
  // Control characters (including line breaks) collapse with other whitespace into single spaces.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const flat = text?.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return null;
  const points = [...flat];
  return points.length > TASK_TITLE_LIMIT ? `${points.slice(0, TASK_TITLE_LIMIT).join('').trimEnd()}…` : flat;
}

/**
 * Makes titles unique within the session: a title shared by several sources gains each one's
 * native identity, or its source path when the identity is already part of the title.
 * @param titles - Candidate titles, index-aligned with `entries`.
 * @param entries - Store entries.
 * @returns Titles no two sources share.
 */
function distinctTitles(titles: readonly string[], entries: readonly SessionSourceEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
  return titles.map((title, index) => {
    if (counts.get(title) === 1) return title;
    const entry = entries[index]!;
    const identity = nativeIdentity(entry);
    return title.includes(identity) ? `${title} (${entry.view.source.relPath})` : `${title} (${identity})`;
  });
}

/**
 * Recomposes only when membership, rows or evidence change.
 * @param state - Current store state.
 * @param sources - Projected sources.
 * @param adapter - Provider seam.
 * @returns Deterministic composition.
 */
function useComposition<Payloads extends object>(
  state: StreamStoreState,
  sources: ReadonlyMap<string, SessionSourceModel<Payloads>>,
  adapter: SessionProviderAdapter<Payloads>
): SessionComposition {
  return useMemo(
    () =>
      composeSession({
        descriptor: state.descriptor,
        sources: [...sources.values()].map((source) => ({
          key: source.entry.key,
          member: source.entry.view.member,
          rows: source.projection.rows,
          linkage: source.linkage
        })),
        nestedRows: adapter.nestedRows
      }),
    [state.descriptor, sources, adapter]
  );
}

/**
 * Per-parent insertions whose array identities survive unchanged placement, so memoized rows
 * outside a moved placement never rerender.
 * @param composition - Current composition.
 * @param sources - Projected sources, for labels.
 * @returns Insertions by parent key.
 */
function useStableInsertions<Payloads extends object>(
  composition: SessionComposition,
  sources: ReadonlyMap<string, SessionSourceModel<Payloads>>
): ReadonlyMap<string, readonly SessionInsertion[]> {
  const previous = useRef(new Map<string, { signature: string; list: readonly SessionInsertion[] }>());
  return useMemo(() => {
    const raw = new Map<string, SessionInsertion[]>();
    for (const [parent, list] of composition.witnessed)
      raw.set(
        parent,
        list.map((entry) => ({ ...entry, label: childLabel(sources.get(entry.childSourceKey), 'witnessed') }))
      );
    const sessionKey = composition.mainKey ?? '';
    const sections = [...(raw.get(sessionKey) ?? [])];
    for (const key of composition.sections) {
      const child = composition.children.get(key)!;
      sections.push({
        placementId: child.placementId,
        childSourceKey: key,
        label: childLabel(sources.get(key), child.status),
        placement: { kind: 'section', position: 'end' }
      });
    }
    if (composition.anomalous.length > 0 || composition.diagnostics.length > 0)
      sections.push({
        placementId: RELATIONSHIPS_SECTION_ID,
        childSourceKey: '',
        label: relationshipsLabel(composition),
        placement: { kind: 'section', position: 'end' }
      });
    raw.set(sessionKey, sections);
    const next = new Map<string, { signature: string; list: readonly SessionInsertion[] }>();
    for (const [parent, list] of raw) {
      const signature = JSON.stringify(list);
      const prior = previous.current.get(parent);
      next.set(parent, prior?.signature === signature ? prior : { signature, list });
    }
    previous.current = next;
    return new Map([...next].map(([parent, { list }]) => [parent, list.length ? list : NO_INSERTIONS]));
  }, [composition, sources]);
}

/**
 * Accessible disclosure label naming role, title and placement honesty.
 * @param source - Child source model.
 * @param status - Placement status.
 * @returns Label text.
 */
function childLabel<Payloads extends object>(source: SessionSourceModel<Payloads> | undefined, status: string): string {
  if (!source) return 'Session member';
  const role = source.role === 'auxiliary' ? 'Auxiliary' : source.role === 'main' ? 'Main' : 'Subagent';
  const state = source.projection.header.status;
  const activity =
    state === 'running' ? ' · running' : state === 'error' ? ' · error' : state === 'done' ? ' · ended' : '';
  const loaded = source.entry.view.earlierUnloaded ? ' · earlier content not loaded' : '';
  const placement =
    status === 'witnessed'
      ? ''
      : status === 'unavailable'
        ? ' · no longer a session member'
        : status === 'anomalous'
          ? ' · relationship unresolved'
          : ' · session member, no witnessed delegation';
  return `${role}: ${source.title}${activity}${placement}${loaded}`;
}

/**
 * Label of the relationship diagnostics section.
 * @param composition - Current composition.
 * @returns Label text.
 */
function relationshipsLabel(composition: SessionComposition): string {
  const count = composition.diagnostics.length;
  return `Session relationships: ${count} ${count === 1 ? 'diagnostic' : 'diagnostics'}`;
}

/**
 * Prunes disclosure state for vanished identities and reveals owners of newly adopted open leaves.
 * @param sources - Projected sources.
 * @param composition - Current composition.
 * @param adapter - Provider seam.
 * @param setOpen - Disclosure state setter.
 * @param restored - Replayed view state; its choices survive until their leaves first load.
 */
function useDisclosureReconciliation<Payloads extends object>(
  sources: ReadonlyMap<string, SessionSourceModel<Payloads>>,
  composition: SessionComposition,
  adapter: SessionProviderAdapter<Payloads>,
  setOpen: (update: (previous: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => void,
  restored: RestoredViewState
): void {
  const owners = useRef(new Map<string, string>());
  // Restored leaves may not be loaded yet after a rebuild; each stays until it appears or is definitively absent.
  const pending = useRef<Set<string> | null>(null);
  pending.current ??= new Set(restored.open.keys());
  useEffect(() => {
    const ids = new Set<string>([RELATIONSHIPS_SECTION_ID]);
    const nextOwners = new Map<string, string>();
    for (const source of sources.values()) {
      for (const id of adapter.disclosureIds(source.projection.rows)) ids.add(id);
      for (const [leaf, owner] of adapter.adoptions?.(source.projection.rows) ?? []) nextOwners.set(leaf, owner);
    }
    for (const child of composition.children.values()) ids.add(child.placementId);
    const awaiting = pending.current!;
    const entries = new Map([...sources].map(([key, source]) => [key, source.entry]));
    for (const id of awaiting) if (ids.has(id) || restoredIdAbsent(id, entries)) awaiting.delete(id);
    for (const id of awaiting) ids.add(id);
    const adopted = [...nextOwners].filter(([leaf, owner]) => owners.current.get(leaf) !== owner);
    owners.current = nextOwners;
    setOpen((previous) => {
      // Reveal an inspected leaf only on its adoption transition; later user collapses remain authoritative.
      const revealed = adopted.filter(([leaf, owner]) => previous.get(leaf) && !previous.get(owner));
      if (!revealed.length && [...previous.keys()].every((id) => ids.has(id))) return previous;
      const retained = new Map([...previous].filter(([id]) => ids.has(id)));
      for (const [, owner] of revealed) retained.set(owner, true);
      return retained;
    });
  }, [sources, composition, adapter, setOpen]);
}

/**
 * Subscribes members the store does not auto-subscribe: every non-main member loads a bounded
 * tail (enough for its own native identity), and opened sections load in full.
 * @param state - Current store state.
 * @param composition - Current composition.
 * @param open - Current disclosure state.
 * @param full - Sources the reader asked to load in full, including restored requests.
 */
function useMemberSubscriptions(
  state: StreamStoreState,
  composition: SessionComposition,
  open: ReadonlyMap<string, boolean>,
  full: ReadonlySet<string>
): void {
  const store = useRendererStore();
  useEffect(() => {
    for (const member of state.descriptor.members) {
      const key = JSON.stringify([member.source.cardId, member.source.streamType, member.source.relPath]);
      const view = state.sources.get(key);
      const placement = composition.children.get(key)?.placementId;
      const wantsFull = full.has(key) || Boolean(placement && open.get(placement));
      if (key === composition.mainKey) {
        // The store subscribes the main itself; a restored full-history request upgrades it once.
        if (wantsFull && view && view.history !== 'full' && view.status !== 'unsubscribed')
          store.subscribeSource(member.source, 'full');
        continue;
      }
      if (view && view.status !== 'unsubscribed') continue;
      store.subscribeSource(member.source, wantsFull ? 'full' : 'tail');
    }
  }, [store, state.descriptor, state.sources, composition, open, full]);
}

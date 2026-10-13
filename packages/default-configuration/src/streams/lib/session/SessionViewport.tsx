/**
 * Expanded-mode scrolling wrapper; transcript semantics remain in provider projections.
 *
 * @summary MessageScroller viewport with explicit follow intent and stable anchor hooks
 * @module streams/lib/session/SessionViewport
 */

import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
import {
  type ComponentProps,
  memo,
  type ReactElement,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { createCompletionAnnouncer } from './announcements';
import { SessionContent, type SessionContentProps, SessionFrames } from './SessionContent';
import type { SessionHeaderFacts, SessionIdentity, SessionStableAnchor } from './types';

/** Follow changes express reader intent rather than transcript liveness. */
export type SessionFollowIntent = 'hold' | 'follow';

/** Exposes explicit navigation and stable geometry without leaking a vendor scroller API. */
export interface SessionViewportHandle {
  /** Resume following and navigate to the latest meaningful turn. */
  followLatest(): void;
  /** Hold current reading position without changing transcript or disclosure state. */
  hold(): void;
  /** Navigate to an existing stable leaf and enter hold mode. */
  navigateTo(id: SessionIdentity): void;
  /** Capture the first visible surviving leaf and pixel offset. */
  captureAnchor(): SessionStableAnchor | null;
  /** Restore a surviving leaf; returns false when no matching element exists. */
  restoreAnchor(anchor: SessionStableAnchor): boolean;
}

/** Expanded-only owner of scrolling; content itself is independently reusable. */
export interface SessionViewportProps<Payloads extends object = Record<string, unknown>>
  extends SessionContentProps<Payloads> {
  /** Initial history follows the live end when the newest turn fits, otherwise holds at that turn's start. */
  readonly viewportRef?: Ref<SessionViewportHandle>;
  readonly onFollowIntentChange?: (intent: SessionFollowIntent) => void;
  readonly ariaLabel?: string;
  /** Names the agent in completion announcements, such as "New reply from Codex". */
  readonly agentName?: string;
  /** Provider session status; a running session that ends is announced once. */
  readonly sessionStatus?: SessionHeaderFacts['status'];
}

/**
 * Wraps content with MessageScroller, explicit live-end navigation, and anchor restoration.
 * Incoming anchors cannot move a held viewport. Selection, focus, keyboard navigation,
 * and scrolling away enter hold; scrolling back to the live end resumes following;
 * disclosures preserve the current follow intent.
 * @param props - Content plus expanded viewport navigation hooks.
 * @returns Expanded transcript viewport.
 */
function SessionViewportImplementation<Payloads extends object>(props: SessionViewportProps<Payloads>): ReactElement {
  const [intent, setIntent] = useState<SessionFollowIntent>('hold');
  const intentRef = useRef(intent);
  const updateIntent = useCallback(
    (next: SessionFollowIntent): void => {
      if (next === intentRef.current) return;
      intentRef.current = next;
      setIntent(next);
      props.onFollowIntentChange?.(next);
    },
    [props.onFollowIntentChange]
  );
  return (
    <MessageScroller.Provider autoScroll={intent === 'follow'} defaultScrollPosition="end" scrollPreviousItemPeek={0}>
      <ViewportBody {...props} intent={intent} setIntent={updateIntent} />
    </MessageScroller.Provider>
  );
}

/** Parent source updates can project asynchronously; skip stale-content passes until rows change. */
export const SessionViewport = memo(SessionViewportImplementation) as typeof SessionViewportImplementation;

/** Direct child frames preserve the primitive's geometry contract without coupling content to it.
 * @param props - Render-only content container attributes.
 * @returns Rendered session presentation.
 */
function ScrollerContent(props: ComponentProps<'div'>): ReactElement {
  return (
    <MessageScroller.Content
      {...props}
      role="region"
      aria-label="Transcript content"
      aria-live="off"
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        // Let the target activate normally, but do not let MessageScroller interpret it as scrolling.
        if (
          event.key === ' ' &&
          (event.target as HTMLElement).closest(
            'button, input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"]'
          )
        )
          event.stopPropagation();
      }}
    />
  );
}

/** Incoming anchors are commands in this primitive, so Cards never marks unsolicited rows as anchors.
 * @param props - Stable row attributes and children.
 * @returns Rendered session presentation.
 */
function ScrollerRow(props: ComponentProps<'div'>): ReactElement {
  const id = (props as { 'data-session-id'?: string })['data-session-id'];
  return <MessageScroller.Item {...props} messageId={id} scrollAnchor={false} />;
}

const FRAMES = { Root: ScrollerContent, Row: ScrollerRow };

/** Owns geometry restoration, follow intent, and accessible explicit navigation controls.
 * @param root0 - Expanded content and navigation props.
 * @param root0.intent - Current reader follow intent.
 * @param root0.setIntent - Changes reader intent.
 * @param root0.viewportRef - Receives the Cards navigation handle.
 * @param root0.onFollowIntentChange - Consumed by the outer wrapper.
 * @param root0.ariaLabel - Accessible viewport label.
 * @param root0.layout - Optional outer layout bridge.
 * @param root0.agentName - Agent named in completion announcements.
 * @param root0.sessionStatus - Provider session status for the ended announcement.
 * @returns Rendered session presentation.
 */
function ViewportBody<Payloads extends object>({
  intent,
  setIntent,
  viewportRef,
  onFollowIntentChange: _onFollowIntentChange,
  ariaLabel,
  layout,
  agentName,
  sessionStatus,
  ...content
}: SessionViewportProps<Payloads> & {
  intent: SessionFollowIntent;
  setIntent: (intent: SessionFollowIntent) => void;
}): ReactElement {
  const scroller = useMessageScroller();
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<SessionStableAnchor | null>(null);
  const settlingLayout = useRef(false);
  const settlementFrame = useRef<number | null>(null);
  const settlementElement = useRef<{ id: SessionIdentity; element: HTMLElement } | null>(null);
  const opened = useRef(false);
  /** The last scrollTop this viewport observed or wrote; any other value came from the reader. */
  const knownTop = useRef<number | null>(null);
  const latest = useRef({ intent, layout });
  latest.current = { intent, layout };
  const captureAnchor = useCallback((): SessionStableAnchor | null => {
    const root = viewport.current;
    if (!root) return null;
    knownTop.current = root.scrollTop;
    const bounds = root.getBoundingClientRect();
    const children = Array.from(root.querySelector('.session-content')?.children ?? []).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !element.hasAttribute('data-message-scroller-spacer')
    );
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (children[middle]!.getBoundingClientRect().bottom <= bounds.top) low = middle + 1;
      else high = middle;
    }
    const row = children[low];
    if (!row) return null;
    const candidates = [
      ...row.querySelectorAll<HTMLElement>('.session-part[data-session-id]'),
      ...row.querySelectorAll<HTMLElement>('.session-row[data-session-id]'),
      row
    ];
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const id = element.dataset['sessionId'];
      if (id && rect.bottom > bounds.top && rect.top < bounds.bottom) return { id, offset: rect.top - bounds.top };
    }
    return null;
  }, []);
  const find = useCallback((id: SessionIdentity): HTMLElement | undefined => {
    const root = viewport.current;
    if (!root) return undefined;
    const cached = settlementElement.current;
    if (cached?.id === id && cached.element.dataset['sessionId'] === id && root.contains(cached.element))
      return cached.element;
    const element = root.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`) ?? undefined;
    settlementElement.current = element ? { id, element } : null;
    return element;
  }, []);
  const atLiveEnd = useCallback((): boolean => {
    const root = viewport.current;
    const last = Array.from(root?.querySelector('.session-content')?.children ?? [])
      .filter((element) => !element.hasAttribute('data-message-scroller-spacer'))
      .at(-1);
    if (!root || !last) return false;
    // MessageScroller's alignment spacer can extend scrollHeight, so measure the last real row instead.
    const padding = Number.parseFloat(getComputedStyle(root).paddingBottom) || 0;
    return last.getBoundingClientRect().bottom + padding - root.getBoundingClientRect().bottom <= 1;
  }, []);
  const restoreAnchor = useCallback(
    (saved: SessionStableAnchor): boolean => {
      const root = viewport.current;
      const target = find(saved.id);
      if (!root || !target) return false;
      const delta = target.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
      if (Math.abs(delta) > 1) root.scrollTop += delta;
      knownTop.current = root.scrollTop;
      return true;
    },
    [find]
  );
  const cancelSettlement = useCallback((): void => {
    if (settlementFrame.current !== null) cancelAnimationFrame(settlementFrame.current);
    settlementFrame.current = null;
    settlementElement.current = null;
    settlingLayout.current = false;
  }, []);
  useEffect(() => cancelSettlement, [cancelSettlement]);
  const readerMoved = useCallback((): boolean => {
    const root = viewport.current;
    if (!root || knownTop.current === null || Math.abs(root.scrollTop - knownTop.current) <= 1) return false;
    // Shrinking content clamps scrollTop to the new maximum; that is layout, not the reader.
    return !(root.scrollTop < knownTop.current && root.scrollHeight - root.clientHeight - root.scrollTop <= 1);
  }, []);
  /** A scrollbar drag, held arrow key or find-in-page scroll fires no wheel, key or pointer event first. */
  const yieldToReader = useCallback((): void => {
    cancelSettlement();
    anchor.current = captureAnchor();
    const selection = document.getSelection();
    const selecting = selection && !selection.isCollapsed && viewport.current?.contains(selection.anchorNode);
    if (latest.current.intent === 'hold' && !selecting && atLiveEnd()) setIntent('follow');
  }, [cancelSettlement, captureAnchor, atLiveEnd, setIntent]);
  const restoreThroughLayout = useCallback(
    (saved: SessionStableAnchor): void => {
      restoreAnchor(saved);
      settlingLayout.current = true;
      if (settlementFrame.current !== null) cancelAnimationFrame(settlementFrame.current);
      // Deferred row sizing and scroller effects must settle before scroll events can replace this anchor.
      settlementFrame.current = requestAnimationFrame(() => {
        if (readerMoved()) return yieldToReader();
        restoreAnchor(saved);
        settlementFrame.current = requestAnimationFrame(() => {
          if (readerMoved()) return yieldToReader();
          restoreAnchor(saved);
          settlementFrame.current = null;
          settlementElement.current = null;
          settlingLayout.current = false;
          anchor.current = captureAnchor();
        });
      });
    },
    [captureAnchor, restoreAnchor, readerMoved, yieldToReader]
  );
  const hold = useCallback((): void => {
    cancelSettlement();
    setIntent('hold');
    anchor.current = captureAnchor();
  }, [captureAnchor, setIntent, cancelSettlement]);
  const followLatest = useCallback((): void => {
    cancelSettlement();
    setIntent('follow');
    scroller.scrollToEnd({ behavior: 'instant' });
    anchor.current = captureAnchor();
  }, [captureAnchor, scroller, setIntent, cancelSettlement]);
  const navigateTo = useCallback(
    (id: SessionIdentity): void => {
      const root = viewport.current;
      const target = find(id);
      if (!root || !target) return;
      cancelSettlement();
      setIntent('hold');
      if (!scroller.scrollToMessage(id, { align: 'start', behavior: 'instant' }))
        root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
      anchor.current = { id, offset: target.getBoundingClientRect().top - root.getBoundingClientRect().top };
      restoreThroughLayout(anchor.current);
    },
    [find, scroller, setIntent, cancelSettlement, restoreThroughLayout]
  );
  useImperativeHandle(viewportRef, () => ({ followLatest, hold, navigateTo, captureAnchor, restoreAnchor }), [
    followLatest,
    hold,
    navigateTo,
    captureAnchor,
    restoreAnchor
  ]);
  const settle = useCallback((): void => {
    const saved = anchor.current;
    if (latest.current.intent === 'hold' && saved && find(saved.id)) {
      if (readerMoved()) yieldToReader();
      else restoreThroughLayout(saved);
      return;
    }
    anchor.current = captureAnchor();
  }, [captureAnchor, find, restoreThroughLayout, readerMoved, yieldToReader]);
  useLayoutEffect(() => {
    if (!opened.current && content.rows.length > 0) {
      opened.current = true;
      cancelSettlement();
      const turn = [...content.rows].reverse().find((row) => row.anchor === 'turn') ?? content.rows.at(-1);
      const root = viewport.current;
      const target = Array.from(root?.querySelectorAll<HTMLElement>('.session-row[data-session-id]') ?? [])
        .reverse()
        .find((element) => element.dataset['sessionId'] === turn?.id);
      // Aligning a short tail to the start would pad it with an empty spacer; the end already shows the whole turn.
      if (
        !root ||
        !turn ||
        !target ||
        root.scrollHeight - (target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop) <=
          root.clientHeight
      ) {
        followLatest();
        return;
      }
      scroller.scrollToMessage(turn.id, { align: 'start', behavior: 'instant' });
      anchor.current = captureAnchor();
    } else settle();
  }, [content.rows, scroller, captureAnchor, settle, cancelSettlement, followLatest]);
  useEffect(() => {
    const root = viewport.current;
    const child = root?.querySelector('.session-content');
    if (!root || !child || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(settle);
    observer.observe(root);
    observer.observe(child);
    return () => observer.disconnect();
  }, [settle]);
  useEffect(() => {
    const selectionChanged = (): void => {
      if (settlingLayout.current) return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && viewport.current?.contains(selection.anchorNode)) hold();
    };
    document.addEventListener('selectionchange', selectionChanged);
    return () => document.removeEventListener('selectionchange', selectionChanged);
  }, [hold]);
  const [announcement, setAnnouncement] = useState({ text: '', repeat: false });
  const { rows, providerParts, providerRows } = content;
  const announce = useMemo(
    () => createCompletionAnnouncer(agentName ?? 'the agent', providerParts, providerRows),
    [agentName, providerParts, providerRows]
  );
  useEffect(() => {
    const text = announce(rows, sessionStatus);
    // A repeated message must still change the region's text, or assistive technology stays silent.
    if (text) setAnnouncement((current) => ({ text, repeat: current.text === text && !current.repeat }));
  }, [announce, rows, sessionStatus]);
  const combinedLayout = useMemo(
    () => ({
      ...layout,
      onBeforeLayoutChange: (id: SessionIdentity): void => {
        if (!settlingLayout.current) anchor.current = captureAnchor();
        layout?.onBeforeLayoutChange?.(id);
      },
      onAfterLayoutChange: (id: SessionIdentity): void => {
        settle();
        layout?.onAfterLayoutChange?.(id);
      }
    }),
    [layout, captureAnchor, settle]
  );
  return (
    <MessageScroller.Root className="session-root">
      <MessageScroller.Viewport
        ref={viewport}
        className="session-viewport"
        aria-label={ariaLabel ?? 'Session transcript'}
        preserveScrollOnPrepend={false}
        onWheel={hold}
        onTouchMove={hold}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', ' '].includes(event.key)) hold();
        }}
        onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest('button')) hold();
        }}
        onFocus={(event) => {
          if (!(event.target as HTMLElement).closest('[data-session-disclosure]')) hold();
        }}
        onScroll={() => {
          if (settlingLayout.current && !readerMoved()) return;
          yieldToReader();
        }}
      >
        <SessionFrames.Provider value={FRAMES}>
          <SessionContent {...content} layout={combinedLayout} />
        </SessionFrames.Provider>
      </MessageScroller.Viewport>
      <div className="session-controls">
        <span className="session-muted" role="status" aria-live="polite">
          {intent === 'follow' ? 'Following latest' : 'Reading history'}
        </span>
        <button type="button" onClick={intent === 'follow' ? hold : followLatest}>
          {intent === 'follow' ? 'Hold position' : 'Return to latest'}
        </button>
      </div>
      <div className="session-announcer" aria-live="polite" aria-atomic="true" data-session-announcer>
        {announcement.text + (announcement.repeat ? '\u00a0' : '')}
      </div>
    </MessageScroller.Root>
  );
}

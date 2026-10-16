/**
 * Card-detail layout bridge: measured height, outer-timeline scrolling and anchor compensation.
 *
 * In card detail the parent timeline owns scrolling, so the renderer never scrolls or clips its
 * own content. It reports the measured content height (never anything derived from the iframe
 * viewport, which the host sizes from these reports), forwards wheel and scroll keys as bounded
 * commands, and, before each size, reports how far the reader's anchored leaf moved so the host
 * can keep it in place.
 *
 * @summary Generation-correlated layout reporting for normal-flow session content
 * @module streams/lib/session/layout-bridge
 */

import {
  type LayoutPayload,
  type LayoutScrollCommand,
  MAX_LAYOUT_HEIGHT,
  MAX_SCROLL_DELTA
} from '@cards.management/sdk/stream-store';
import type { SessionIdentity, SessionLayoutHooks } from './types';

/** Line height used for line-mode wheel deltas, matching Chromium's scroll step. */
const WHEEL_LINE_PX = 16;

/** Bridge dependencies; the DOM is passed in so tests drive a real document. */
export interface LayoutBridgeOptions {
  /** Normal-flow content root whose border-box height is reported. */
  readonly root: HTMLElement;
  /** Posts a layout payload; the store stamps generation and token. */
  readonly post: (payload: LayoutPayload) => void;
  /** Called with each reported height so callers can window oversized content. */
  readonly onHeight?: (height: number) => void;
}

/** Live bridge with session layout hooks for SessionContent. */
export interface LayoutBridge {
  readonly hooks: SessionLayoutHooks;
  /** Starts a handshake epoch: posts ready, then a size for the new token. */
  handshake(): void;
  /** Measures and reports immediately (used for hidden windows and tests). */
  flush(): void;
  /** Removes every observer, listener and scheduled frame. */
  dispose(): void;
}

/** Element positions captured at the previous report, in document order. */
interface AnchorSnapshot {
  readonly id: SessionIdentity;
  readonly element: HTMLElement;
  readonly top: number;
}

/**
 * Short, control-free anchor key accepted by the bridge validator.
 * @param id - Stable leaf or disclosure identity.
 * @returns Deterministic opaque key.
 */
export function anchorKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `leaf-${hash.toString(16).padStart(8, '0')}-${id.length}`;
}

/**
 * Converts a wheel event into a bounded outer-scroll command.
 * @param event - Native wheel input.
 * @param event.deltaY - Vertical delta.
 * @param event.deltaMode - Pixel, line or page mode.
 * @returns Scroll command, or null when there is no vertical movement.
 */
export function wheelCommand(event: { deltaY: number; deltaMode: number }): LayoutScrollCommand | null {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return null;
  if (event.deltaMode === 2) return { kind: 'key', key: event.deltaY > 0 ? 'page-down' : 'page-up' };
  const pixels = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
  return { kind: 'delta', deltaY: Math.max(-MAX_SCROLL_DELTA, Math.min(MAX_SCROLL_DELTA, pixels)) };
}

/** Targets that keep their own keyboard semantics. */
const INTERACTIVE =
  'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="textbox"], [role="slider"], [role="tab"]';

/**
 * Maps a scroll key to an outer-timeline command, preserving editing, selection and controls.
 * @param event - Native key input and its target.
 * @param event.key - Key name.
 * @param event.shiftKey - Shift modifier (selection extension).
 * @param event.altKey - Alt modifier.
 * @param event.ctrlKey - Control modifier.
 * @param event.metaKey - Meta modifier.
 * @param event.target - Element that received the key.
 * @returns Scroll command, or null when the key belongs to the target.
 */
export function keyCommand(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}): LayoutScrollCommand | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(INTERACTIVE)) return null;
  const key = (() => {
    switch (event.key) {
      case 'ArrowUp':
        return 'line-up';
      case 'ArrowDown':
        return 'line-down';
      case 'PageUp':
        return 'page-up';
      case 'PageDown':
        return 'page-down';
      case 'Home':
        return 'start';
      case 'End':
        return 'end';
      case ' ':
        return event.shiftKey ? 'page-up' : 'page-down';
      default:
        return null;
    }
  })();
  // Shift with arrows, Home or End extends a text selection rather than scrolling.
  if (!key || (event.shiftKey && event.key !== ' ')) return null;
  return { kind: 'key', key };
}

/**
 * Creates the bridge over a real document.
 * @param options - Root element, poster and height listener.
 * @returns Live bridge.
 */
export function createLayoutBridge(options: LayoutBridgeOptions): LayoutBridge {
  const { root, post } = options;
  const view = root.ownerDocument.defaultView!;
  const document = root.ownerDocument;
  const anchors = new Map<SessionIdentity, HTMLElement>();
  const visible = new Set<SessionIdentity>();
  const identities = new WeakMap<Element, SessionIdentity>();
  let revision = 0;
  let ready = false;
  let disposed = false;
  let frame: number | null = null;
  let lastHeight = 0;
  /** Disclosure control the reader just activated; it stays the anchor while visible. */
  let pinned: AnchorSnapshot | null = null;
  let snapshot: AnchorSnapshot[] = [];

  const intersection =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          for (const entry of entries) {
            // A reader scrolling the activated control out of view releases it as the anchor.
            if (pinned?.element === entry.target && !entry.isIntersecting) pinned = null;
            const id = identities.get(entry.target);
            if (!id || anchors.get(id) !== entry.target) continue;
            if (entry.isIntersecting) visible.add(id);
            else visible.delete(id);
          }
          if (pinned && !pinned.element.isConnected) pinned = null;
        });

  /**
   * Document-relative top; the iframe document itself never scrolls.
   * @param element - Measured element.
   * @returns Top in CSS pixels.
   */
  const topOf = (element: HTMLElement): number => element.getBoundingClientRect().top + view.scrollY;

  /**
   * Captures the anchor candidates for the next report: the pinned control, else the topmost
   * visible leaf, followed by every registered leaf ordered by distance from it.
   * @returns Ordered candidates.
   */
  const capture = (): AnchorSnapshot[] => {
    const entries = [...anchors].filter(([, element]) => element.isConnected);
    entries.sort(([, left], [, right]) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    const tops = entries.map(([id, element], order) => ({ id, element, top: topOf(element), order }));
    const primary = tops
      .filter((entry) => visible.has(entry.id))
      .reduce<(typeof tops)[number] | undefined>(
        (best, entry) => (!best || entry.top < best.top ? entry : best),
        undefined
      );
    if (!primary) return pinned ? [pinned] : [];
    // Deterministic fallback: nearest neighbors first, the following leaf before the preceding one.
    const ordered = [...tops].sort(
      (left, right) =>
        Math.abs(left.order - primary.order) - Math.abs(right.order - primary.order) || right.order - left.order
    );
    return pinned ? [pinned, ...ordered] : ordered;
  };

  const report = (): void => {
    frame = null;
    if (disposed || !ready) return;
    const height = Math.max(1, Math.min(MAX_LAYOUT_HEIGHT, Math.ceil(root.getBoundingClientRect().height)));
    options.onHeight?.(height);
    if (height === lastHeight && revision > 0) {
      snapshot = capture();
      return;
    }
    revision++;
    // The previous anchor, or the nearest surviving neighbor when its row disappeared.
    const survivor = snapshot.find((entry) => entry.element.isConnected);
    if (survivor) {
      const delta = Math.round(topOf(survivor.element) - survivor.top);
      if (delta !== 0 && Math.abs(delta) <= MAX_LAYOUT_HEIGHT)
        post({ type: 'layout:anchor', revision, key: anchorKey(survivor.id), delta });
    }
    lastHeight = height;
    post({ type: 'layout:size', revision, height });
    if (pinned) pinned = { ...pinned, top: topOf(pinned.element) };
    snapshot = capture();
  };

  const schedule = (): void => {
    if (disposed || !ready) return;
    // rAF is suspended while hidden; a hidden measurement is accepted immediately.
    if (document.visibilityState === 'hidden') {
      if (frame !== null) view.cancelAnimationFrame(frame);
      report();
      return;
    }
    if (frame === null) frame = view.requestAnimationFrame(report);
  };

  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  resize?.observe(root);

  const onWheel = (event: WheelEvent): void => {
    if (!ready || event.ctrlKey || event.defaultPrevented) return;
    const command = wheelCommand(event);
    if (!command) return;
    event.preventDefault();
    post({ type: 'layout:scroll', command });
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!ready || event.defaultPrevented) return;
    const command = keyCommand(event);
    if (!command) return;
    event.preventDefault();
    post({ type: 'layout:scroll', command });
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden' && frame !== null) {
      view.cancelAnimationFrame(frame);
      report();
    }
  };
  view.addEventListener('wheel', onWheel, { passive: false });
  view.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);

  const hooks: SessionLayoutHooks = {
    onBeforeLayoutChange(id) {
      const control = document.querySelector<HTMLElement>(
        `[data-session-disclosure="${CSS.escape(id)}"] > .session-disclosure-button`
      );
      if (!control) return;
      if (pinned) intersection?.unobserve(pinned.element);
      pinned = { id, element: control, top: topOf(control) };
      snapshot = [pinned, ...snapshot.filter((entry) => entry.element !== control)];
      intersection?.observe(control);
    },
    onAfterLayoutChange() {
      schedule();
    },
    onAnchorElement(id, element) {
      const previous = anchors.get(id);
      if (previous && previous !== element && previous !== pinned?.element) intersection?.unobserve(previous);
      if (element) {
        anchors.set(id, element);
        identities.set(element, id);
        intersection?.observe(element);
      } else {
        anchors.delete(id);
        visible.delete(id);
      }
    }
  };

  return {
    hooks,
    handshake() {
      if (disposed) return;
      ready = true;
      lastHeight = 0;
      post({ type: 'layout:ready' });
      report();
    },
    flush() {
      if (frame !== null) view.cancelAnimationFrame(frame);
      report();
    },
    dispose() {
      disposed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      resize?.disconnect();
      intersection?.disconnect();
      view.removeEventListener('wheel', onWheel);
      view.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

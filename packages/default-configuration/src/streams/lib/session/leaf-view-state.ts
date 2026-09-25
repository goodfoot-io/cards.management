/**
 * Inspection bookmarks belong to stable leaves, independently of their current row grouping.
 * @summary Renderer-local paging, focus and selection preservation
 * @module streams/lib/session/leaf-view-state
 */
import { createContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { SessionRow } from './types';

/** Per-leaf inspection slots separate tool input and output without exposing view state to providers. */
export const InspectionPages = createContext<Map<string, Map<string, number>> | null>(null);

/** A descendant address survives a row remount while retaining the exact control or text node. */
interface Bookmark {
  readonly id: string;
  readonly path: readonly number[];
  readonly node: Node;
}

/**
 * Addresses a descendant within its stable leaf, excluding nested content owners.
 * @param root - Owning render-only content element.
 * @param node - Focused element or selection endpoint.
 * @returns A leaf-relative node address, when owned by this content.
 */
function bookmark(root: HTMLElement | null, node: Node | null): Bookmark | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const leaf = element?.closest<HTMLElement>('.session-part[data-session-id]');
  if (!node || !leaf || leaf.closest('.session-content') !== root) return null;
  const path: number[] = [];
  let child = node;
  while (child !== leaf) {
    const parent = child.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, child));
    child = parent;
  }
  return { id: leaf.dataset['sessionId']!, path, node };
}

/**
 * Resolves only the same descendant kind; never substitutes the first focusable control.
 * @param entry - Previously captured leaf-relative address.
 * @param elements - Currently mounted leaf elements.
 * @returns The surviving descendant, or null when its structure changed.
 */
function resolve(entry: Bookmark, elements: Map<string, HTMLElement>): Node | null {
  let node: Node | undefined = elements.get(entry.id);
  for (const index of entry.path) node = node?.childNodes[index];
  if (!node || node.nodeName !== entry.node.nodeName) return null;
  // A changed leaf may reuse a DOM position for different content. Only restore its surviving descendant.
  if (node.textContent !== entry.node.textContent) return null;
  return node;
}

/**
 * Keeps bounded inspection and DOM bookmarks at the content owner across row remounts.
 * Selection restoration is limited to surviving leaf descendants and cannot claim outside content.
 * @param rows - Current projected rows with stable leaf identities.
 * @returns Private state and registration handles for this content owner.
 */
export function useLeafViewState(rows: readonly SessionRow[]) {
  const root = useRef<HTMLDivElement>(null);
  const pages = useRef(new Map<string, Map<string, number>>());
  const elements = useRef(new Map<string, HTMLElement>());
  const focus = useRef<Bookmark | null>(null);
  const selection = useRef<{
    anchor: Bookmark;
    anchorOffset: number;
    focus: Bookmark;
    focusOffset: number;
  } | null>(null);

  useEffect(() => {
    const captureSelection = (): void => {
      const current = document.getSelection();
      const anchor = bookmark(root.current, current?.anchorNode ?? null);
      const end = bookmark(root.current, current?.focusNode ?? null);
      selection.current =
        current && !current.isCollapsed && anchor && end
          ? { anchor, anchorOffset: current.anchorOffset, focus: end, focusOffset: current.focusOffset }
          : null;
    };
    const captureFocus = (event: FocusEvent): void => {
      focus.current = bookmark(root.current, event.target as Node);
    };
    document.addEventListener('selectionchange', captureSelection);
    document.addEventListener('focusin', captureFocus);
    return () => {
      document.removeEventListener('selectionchange', captureSelection);
      document.removeEventListener('focusin', captureFocus);
    };
  }, []);

  useLayoutEffect(() => {
    const previous = focus.current;
    if (previous && !previous.node.isConnected && document.activeElement === document.body) {
      const control = resolve(previous, elements.current);
      focus.current = null;
      if (control instanceof HTMLElement) control.focus({ preventScroll: true });
    }
    const saved = selection.current;
    if (saved && (!saved.anchor.node.isConnected || !saved.focus.node.isConnected)) {
      selection.current = null;
      const anchor = resolve(saved.anchor, elements.current);
      const end = resolve(saved.focus, elements.current);
      const length = (node: Node): number =>
        node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length;
      if (anchor && end && saved.anchorOffset <= length(anchor) && saved.focusOffset <= length(end)) {
        document.getSelection()?.setBaseAndExtent(anchor, saved.anchorOffset, end, saved.focusOffset);
      }
    }
  });
  useEffect(() => {
    const retained = new Set(rows.flatMap((row) => [row.id, ...row.parts.map((part) => part.id)]));
    for (const id of pages.current.keys()) if (!retained.has(id)) pages.current.delete(id);
    if (focus.current && !retained.has(focus.current.id)) focus.current = null;
    if (selection.current && (!retained.has(selection.current.anchor.id) || !retained.has(selection.current.focus.id)))
      selection.current = null;
  }, [rows]);
  return { root, pages: pages.current, elements: elements.current };
}

/**
 * Expanded-mode scrolling wrapper; transcript semantics remain in provider projections.
 *
 * @summary MessageScroller viewport with explicit follow intent and stable anchor hooks
 * @module streams/lib/session/SessionViewport
 */

import type { ReactElement, Ref } from 'react';
import type { SessionContentProps } from './SessionContent';
import type { SessionIdentity, SessionStableAnchor } from './types';

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
  /** Initial history opens at the newest meaningful turn in hold mode. */
  readonly viewportRef?: Ref<SessionViewportHandle>;
  readonly onFollowIntentChange?: (intent: SessionFollowIntent) => void;
  readonly ariaLabel?: string;
}

/**
 * Wraps content with MessageScroller, explicit live-end navigation, and anchor restoration.
 * Incoming anchors cannot move a held viewport. Selection, focus, keyboard navigation,
 * and scrolling away enter hold; disclosures preserve the current follow intent.
 * @param props - Content plus expanded viewport navigation hooks.
 * @throws Until the contract implementation is completed.
 * @returns Expanded transcript viewport.
 */
export function SessionViewport<Payloads extends object>(props: SessionViewportProps<Payloads>): ReactElement {
  void props;
  throw new Error('Not Implemented');
}

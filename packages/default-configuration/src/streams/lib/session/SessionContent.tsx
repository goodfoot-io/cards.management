/**
 * Render-only content contracts shared by expanded viewports and future parent bridges.
 *
 * Content never discovers sources, subscribes to transport, or owns a scroll container.
 *
 * @summary Controlled session rows, provider registries, and child insertion hooks
 * @module streams/lib/session/SessionContent
 */

import type { ReactElement, ReactNode } from 'react';
import type {
  SessionDisclosureState,
  SessionInsertion,
  SessionLayoutHooks,
  SessionLeaf,
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

/** Mapped keys preserve each provider payload type without casting through vendor messages. */
export type SessionProviderRegistry<Payloads extends object> = {
  readonly [Kind in keyof Payloads & string]: (props: ProviderPresentationProps<Payloads[Kind]>) => ReactNode;
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
 * @throws Until the contract implementation is completed.
 * @returns Content suitable for an owning viewport or outer page.
 */
export function SessionContent<Payloads extends object>(props: SessionContentProps<Payloads>): ReactElement {
  void props;
  throw new Error('Not Implemented');
}

/**
 * Derives the quiet live-region policy's completion announcements from successive projections.
 * Only meaningful completed changes speak: a new assistant reply, a tool that completed or failed,
 * or a session that ended. History loads, prepends, resets and individual native lines stay silent.
 * @summary Coalesced screen-reader announcements for completed session changes
 * @module streams/lib/session/announcements
 */

import type { SessionProviderRegistry } from './SessionContent';
import type { SessionHeaderFacts, SessionPart, SessionRow, SessionToolPart } from './types';

/** Tool progress a provider payload reports, so shared code never reads provider data shapes. */
export interface SessionToolProgress {
  readonly name: string;
  readonly status: SessionToolPart['status'];
}

/** The completion-relevant facts of one projection, compared against the next. */
export interface SessionCompletionFacts {
  /** Each row's newest native line; only a row carrying lines newer than every previous line changed live. */
  readonly rows: ReadonlyMap<string, number>;
  readonly lastLine: number;
  readonly replies: ReadonlySet<string>;
  readonly tools: ReadonlyMap<string, SessionToolProgress & { readonly row: string }>;
  readonly status: SessionHeaderFacts['status'];
}

const finished = (status: SessionToolPart['status'] | undefined): boolean =>
  status === 'complete' || status === 'error';

/** Collects replies and tool progress from top-level rows and their parts.
 * @param rows - Current projected rows.
 * @param status - Current provider session status.
 * @param providerParts - Provider part registry declaring tool progress.
 * @param providerRows - Provider row registry declaring tool progress.
 * @returns Facts for the next comparison.
 */
export function completionFacts<Payloads extends object>(
  rows: readonly SessionRow<Payloads>[],
  status: SessionHeaderFacts['status'],
  providerParts?: SessionProviderRegistry<Payloads>,
  providerRows?: SessionProviderRegistry<Payloads>
): SessionCompletionFacts {
  const lines = new Map<string, number>();
  let lastLine = 0;
  const replies = new Set<string>();
  const tools = new Map<string, SessionToolProgress & { row: string }>();
  const progress = (
    registry: SessionProviderRegistry<Payloads> | undefined,
    leaf: SessionRow<Payloads> | SessionPart<Payloads>
  ): SessionToolProgress | undefined => {
    if (leaf.kind === 'tool') return { name: leaf.name, status: leaf.status };
    if (leaf.kind !== 'provider') return undefined;
    const entry = registry?.[leaf.providerKind as keyof Payloads & string];
    return entry?.progress?.(leaf.data as never);
  };
  for (const row of rows) {
    let newest = 0;
    for (const leaf of [row, ...row.parts])
      for (const origin of leaf.provenance) newest = Math.max(newest, origin.lineNumber);
    lines.set(row.id, newest);
    lastLine = Math.max(lastLine, newest);
    if (row.kind === 'message' && row.role === 'assistant' && row.parts.some((part) => part.kind === 'text'))
      replies.add(row.id);
    const own = progress(providerRows, row);
    if (own) tools.set(row.id, { ...own, row: row.id });
    for (const part of row.parts) {
      const found = progress(providerParts, part);
      if (found) tools.set(part.id, { ...found, row: row.id });
    }
  }
  return { rows: lines, lastLine, replies, tools, status };
}

/** Coalesces every completion between two projections into at most one polite message.
 * @param previous - Facts from the last announced projection.
 * @param next - Facts from the current projection.
 * @param agent - Provider-facing agent name for reply announcements.
 * @returns One announcement, or undefined when nothing meaningful completed.
 */
export function completionAnnouncement(
  previous: SessionCompletionFacts,
  next: SessionCompletionFacts,
  agent: string
): string | undefined {
  // A first load or a reset shares no rows with what was shown; neither is a completion.
  if (![...next.rows.keys()].some((id) => previous.rows.has(id))) return undefined;
  // Prepended history and regrouped rows carry only native lines the reader was already shown.
  const live = (row: string): boolean => (next.rows.get(row) ?? 0) > previous.lastLine;
  const messages: string[] = [];
  if ([...next.replies].some((id) => !previous.replies.has(id) && live(id))) messages.push(`New reply from ${agent}`);
  for (const [id, tool] of next.tools) {
    const before = previous.tools.get(id);
    if (finished(tool.status) && (before ? !finished(before.status) : live(tool.row)))
      messages.push(`${tool.name} ${tool.status === 'error' ? 'failed' : 'completed'}`);
  }
  if (previous.status === 'running' && next.status === 'done') messages.push('Session ended');
  if (previous.status === 'running' && next.status === 'error') messages.push('Session ended with an error');
  const unique = [...new Set(messages)];
  if (unique.length === 0) return undefined;
  return unique.length <= 3
    ? unique.join('. ')
    : `${unique.slice(0, 2).join('. ')}, and ${unique.length - 2} more updates`;
}

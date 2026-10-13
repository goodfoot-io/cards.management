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

/** Completion-relevant facts of one row, derived once per row object. */
interface RowFacts {
  readonly row: object;
  /** Newest native line; only a row carrying lines newer than everything shown before changed live. */
  readonly newest: number;
  readonly reply: boolean;
  readonly tools: readonly (readonly [string, SessionToolProgress])[];
}

/** Announces completions for successive projections of one transcript.
 * @param rows - Current projected rows.
 * @param status - Current provider session status.
 * @returns One polite message, or undefined when nothing meaningful completed.
 */
export type SessionCompletionAnnouncer = <Payloads extends object>(
  rows: readonly SessionRow<Payloads>[],
  status: SessionHeaderFacts['status']
) => string | undefined;

const finished = (status: SessionToolPart['status'] | undefined): boolean =>
  status === 'complete' || status === 'error';

/** Creates the announcer that remembers what the reader was shown, re-deriving only changed rows.
 * Providers keep unchanged row objects across appends, so an update costs one identity check per
 * unchanged row rather than a walk over every part, provenance entry and provider declaration.
 * @param agent - Provider-facing agent name for reply announcements.
 * @param providerParts - Provider part registry declaring tool progress and streamed completion.
 * @param providerRows - Provider row registry declaring tool progress.
 * @returns Stateful announcer for one transcript and one pair of registries.
 */
export function createCompletionAnnouncer<Payloads extends object>(
  agent: string,
  providerParts?: SessionProviderRegistry<Payloads>,
  providerRows?: SessionProviderRegistry<Payloads>
): SessionCompletionAnnouncer {
  // A provider that declares streamed completion leaves every reply unfinished until one of its parts says otherwise.
  const streamed = Object.values(providerParts ?? {}).some(
    (declaration) => typeof (declaration as { finished?: unknown }).finished === 'function'
  );
  const entry = (
    registry: SessionProviderRegistry<Payloads> | undefined,
    leaf: SessionRow<Payloads> | SessionPart<Payloads>
  ) => (leaf.kind === 'provider' ? registry?.[leaf.providerKind as keyof Payloads & string] : undefined);
  const progress = (
    registry: SessionProviderRegistry<Payloads> | undefined,
    leaf: SessionRow<Payloads> | SessionPart<Payloads>
  ): SessionToolProgress | undefined => {
    if (leaf.kind === 'tool') return { name: leaf.name, status: leaf.status };
    return leaf.kind === 'provider' ? entry(registry, leaf)?.progress?.(leaf.data as never) : undefined;
  };
  const derive = (row: SessionRow<Payloads>): RowFacts => {
    let newest = 0;
    for (const leaf of [row, ...row.parts])
      for (const origin of leaf.provenance) newest = Math.max(newest, origin.lineNumber);
    const declared = row.parts.flatMap((part) => {
      const declares = entry(providerParts, part)?.finished;
      return part.kind === 'provider' && declares ? [declares(part.data as never)] : [];
    });
    // A streamed reply speaks once its provider marks the message finished, not on its first text.
    const done = streamed ? declared.length > 0 && declared.every(Boolean) : true;
    const tools: [string, SessionToolProgress][] = [];
    const own = progress(providerRows, row);
    if (own) tools.push([row.id, own]);
    for (const part of row.parts) {
      const found = progress(providerParts, part);
      if (found) tools.push([part.id, found]);
    }
    const reply =
      row.kind === 'message' && row.role === 'assistant' && done && row.parts.some((part) => part.kind === 'text');
    return { row, newest, reply, tools };
  };
  const shown = new Map<string, RowFacts>();
  const toolStatus = new Map<string, SessionToolPart['status']>();
  let lastLine = 0;
  let lastStatus: SessionHeaderFacts['status'] | undefined;
  return ((rows: readonly SessionRow<Payloads>[], status: SessionHeaderFacts['status']) => {
    const previousLine = lastLine;
    const previousStatus = lastStatus;
    const changed: [RowFacts, RowFacts | undefined][] = [];
    let shared = 0;
    let changedLine = 0;
    for (const row of rows) {
      const before = shown.get(row.id);
      if (before) shared++;
      if (before?.row === row) continue;
      const facts = derive(row);
      shown.set(row.id, facts);
      changedLine = Math.max(changedLine, facts.newest);
      changed.push([facts, before]);
    }
    // Removed rows are rare (regrouping, reset); prune only when the shown set outgrew the projection.
    if (shown.size > rows.length) {
      const present = new Set(rows.map((row) => row.id));
      for (const id of shown.keys()) if (!present.has(id)) shown.delete(id);
    }
    lastStatus = status;
    const learn = () => {
      for (const [facts] of changed) for (const [id, tool] of facts.tools) toolStatus.set(id, tool.status);
    };
    // A first load or a reset shares no rows with what was shown; neither is a completion.
    if (shared === 0) {
      toolStatus.clear();
      lastLine = changedLine;
      learn();
      return undefined;
    }
    lastLine = Math.max(lastLine, changedLine);
    const messages: string[] = [];
    for (const [facts, before] of changed) {
      // Prepended history and regrouped rows carry only native lines the reader was already shown.
      const live = facts.newest > previousLine;
      if (facts.reply && !before?.reply && live) messages.push(`New reply from ${agent}`);
      for (const [id, tool] of facts.tools) {
        const known = toolStatus.get(id);
        if (finished(tool.status) && (known ? !finished(known) : live))
          messages.push(`${tool.name} ${tool.status === 'error' ? 'failed' : 'completed'}`);
      }
    }
    learn();
    if (previousStatus === 'running' && status === 'done') messages.push('Session ended');
    if (previousStatus === 'running' && status === 'error') messages.push('Session ended with an error');
    const unique = [...new Set(messages)];
    if (unique.length === 0) return undefined;
    return unique.length <= 3
      ? unique.join('. ')
      : `${unique.slice(0, 2).join('. ')}, and ${unique.length - 2} more updates`;
  }) as SessionCompletionAnnouncer;
}

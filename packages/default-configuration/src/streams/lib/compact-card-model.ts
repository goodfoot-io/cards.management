/**
 * Provider-neutral model for the compact stream card.
 *
 * Both stream renderers (claude-code-session, codex-session) produce a
 * `CompactCardModel` from their own provider-specific compact state via a thin
 * adapter, and the shared `CompactCard` component renders it. This is the
 * normalized presentational contract that lets one component and one CSS file
 * serve both providers instead of two independently-maintained compact views.
 *
 * The model is pure data — no JSX, no React nodes — so it is trivially testable
 * and the component owns all rendering (fact separators, the tail slice, the
 * subagent-label conditional).
 *
 * @summary Shared compact-card presentational model
 * @module streams/lib/compact-card-model
 */

/**
 * Content-emphasis class for one tail line, driving its brightness/color.
 *
 * Historically Claude's `roleClass`: `milestone` (human-relevant text and the
 * `Agent`/`SendMessage` tool calls) reads bright, `plumbing` (ordinary tool
 * calls) reads dim, `error` reads red. Codex has no severity signal yet, so
 * every Codex tail line maps to `neutral` until a later phase adds real
 * classification (shell exit / patch failure).
 */
export type TailSeverity = 'milestone' | 'plumbing' | 'error' | 'neutral';

/** Label color class for a tail line's leading label span. */
export type TailLabelClass = 'tool' | 'asst' | 'user';

/** One tail line in the compact card's latest-activity panel. */
export interface TailLineModel {
  /**
   * Source label shown in the leading `.lbl` span — a tool name, `Assistant`,
   * `User`, or `Error` for Claude; the event kind for Codex today.
   */
  label: string;
  /**
   * Optional label color class. Claude supplies `tool`/`asst`/`user`; Codex
   * omits it (the component/CSS default applies) until Codex label coloring
   * exists.
   */
  labelClass?: TailLabelClass;
  /** Line content, rendered as a single clipped line in the `.txt` span. */
  text: string;
  /** Drives the line's content brightness/color via the `.line.{severity}` class. */
  severity: TailSeverity;
}

/**
 * One metrics-row fact: either a bold value with a trailing label (count and
 * token facts) or a bare plain string (the model-name fact) — never both.
 */
export type FactModel =
  | {
      /** Stable React key, unique within its row (the fact's noun/role). */
      key: string;
      /** Discriminant: a bold value plus a trailing label. */
      kind: 'value';
      /** The emphasized value, rendered bold (e.g. a count or formatted token total). */
      bold: string;
      /** The trailing label (e.g. `turns`, `out`, `in`). */
      label: string;
    }
  | {
      /** Stable React key, unique within its row. */
      key: string;
      /** Discriminant: a bare plain string with no emphasis. */
      kind: 'plain';
      /** The plain text (e.g. the model name). */
      text: string;
    };

/**
 * The normalized props both renderers produce and the shared `CompactCard`
 * renders. Absent data is omitted (optional fields, empty facts, empty
 * strings) rather than faked — a missing metric never renders as `0`.
 */
export interface CompactCardModel {
  /** Liveness dot class. `error` only when the source reported an error. */
  dotClass: 'running' | 'ended' | 'error';
  /** Liveness word. Never a fabricated success/failure. */
  statusWord: 'Running' | 'Ended';
  /**
   * Subagent label (Claude-only). Omitted — never `''` — when the stream is
   * not a subagent stream or the renderer has no subagent concept (Codex).
   */
  subagentLabel?: string;
  /** Row-1 right-aligned meta text for the narrow/stacked layout. */
  metaStacked: string;
  /**
   * Row-1 right-aligned meta text for the wide/split layout. `''` renders
   * nothing; the component must not fall back to `metaStacked`.
   */
  metaSplit: string;
  /** Row-2 recap headline. `''` renders nothing. */
  headline: string;
  /** Row-3 facts for the stacked layout, already filtered of zero/absent entries. */
  stackedFacts: FactModel[];
  /** Row-3 facts for the split layout, already filtered of zero/absent entries. */
  splitFacts: FactModel[];
  /**
   * Rolling tail buffer, newest last. The component slices to its own visible
   * count so the cap stays a single source of truth.
   */
  tail: TailLineModel[];
  /**
   * Scope note shown when the summary folds only a loaded trailing window, so counts and
   * recaps never read as whole-session facts.
   */
  coverage?: string;
}

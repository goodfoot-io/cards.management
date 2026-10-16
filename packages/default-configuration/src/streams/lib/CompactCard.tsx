/**
 * Shared compact-card presentational component.
 *
 * Renders a provider-neutral {@link CompactCardModel} produced by each stream
 * renderer's own thin adapter (`claudeToCompactCardModel`,
 * `codexToCompactCardModel`). This is the "one true" compact-card DOM
 * structure and class list, styled entirely by `compact-card.css` — the
 * component owns the fact separators, the ended-only duration fact's no-label
 * rendering, the tail slice, and the subagent-label conditional, so neither
 * renderer maintains its own copy of this markup.
 *
 * @summary Shared compact-card component
 * @module streams/lib/CompactCard
 */

import type React from 'react';
import type { CompactCardModel, FactModel, TailLineModel } from './compact-card-model';

/** Number of trailing tail lines the split right panel displays. */
const VISIBLE_LINES = 3;

/**
 * Codicon glyph for each liveness state — `running` spins in place, `ended`
 * shows a filled circle, `error` shows the standard error glyph. Rendered
 * inside the existing 6x6px `.dot` footprint (size/color set entirely by
 * compact-card.css) so the host's fixed compact-card box is unaffected.
 */
const DOT_ICON: Record<CompactCardModel['dotClass'], string> = {
  running: 'codicon-sync codicon-modifier-spin',
  ended: 'codicon-circle-filled',
  error: 'codicon-error'
};

interface CompactCardProps {
  /** The provider-neutral model to render. */
  model: CompactCardModel;
}

/**
 * Renders one fact: a bold value with a trailing label, or — when the label
 * is `''` (the ended-only duration fact) — the bold value alone with no
 * trailing space, or a bare plain string.
 * @param fact - The fact to render.
 * @returns The rendered fact node.
 */
function renderFact(fact: FactModel): React.ReactNode {
  if (fact.kind === 'plain') return fact.text;
  if (!fact.label) return <b>{fact.bold}</b>;
  return (
    <>
      <b>{fact.bold}</b> {fact.label}
    </>
  );
}

/**
 * Interleaves facts with `·` separators. The model has already filtered out
 * zero/absent entries, so every fact in `facts` renders.
 * @param facts - Facts to render, already filtered of omitted entries.
 * @returns The separator-joined row content.
 */
function renderFacts(facts: FactModel[]): React.ReactElement {
  return (
    <>
      {facts.map((fact, i) => (
        <span key={fact.key}>
          {i > 0 && <span className="sep">·</span>}
          {renderFact(fact)}
        </span>
      ))}
    </>
  );
}

/**
 * Renders one tail line: a source label plus its content, tinted by severity.
 * The label color class is omitted (no trailing space in `className`) when
 * the line carries none.
 * @param line - The tail line to render.
 * @param key - Stable React key.
 * @returns The rendered tail line.
 */
function renderTailLine(line: TailLineModel, key: string): React.ReactElement {
  const lblClass = line.labelClass ? `lbl ${line.labelClass}` : 'lbl';
  return (
    <div className={`line ${line.severity}`} key={key}>
      <span className={lblClass}>{line.label}</span>
      <span className="txt">{line.text}</span>
    </div>
  );
}

/**
 * Shared compact-card component. Renders the fixed three-row stacked card
 * that reflows (via CSS) into a two-panel split layout — recap + metrics on
 * the left, the latest tail lines on the right — for a {@link CompactCardModel}.
 * @param root0 - The component props.
 * @param root0.model - The provider-neutral model to render.
 * @returns The rendered compact card.
 */
export function CompactCard({ model }: CompactCardProps): React.ReactElement {
  const visibleTail = model.tail.slice(-VISIBLE_LINES);
  return (
    <div className="compact-container">
      <div className="split-row font-vscode-editor">
        <div className="panel panel-left">
          <div className="body">
            <div className="row-head">
              <span className={`dot ${model.dotClass}`}>
                <span className={`codicon ${DOT_ICON[model.dotClass]}`} />
              </span>
              <span className="status">{model.statusWord}</span>
              {model.subagentLabel && (
                <span className="subagent-label" title={`Subagent: ${model.subagentLabel}`}>
                  {model.subagentLabel}
                </span>
              )}
              <span className="meta-right">
                <span className="meta-stacked">{model.metaStacked}</span>
                <span className="meta-split">{model.metaSplit}</span>
              </span>
            </div>
            <div className="headline">{model.headline}</div>
            <div className="metrics metrics-stacked">{renderFacts(model.stackedFacts)}</div>
            <div className="metrics metrics-split">{renderFacts(model.splitFacts)}</div>
            {model.coverage && <div className="coverage">{model.coverage}</div>}
          </div>
        </div>
        <div className="panel panel-right">
          {visibleTail.map((line, i) => renderTailLine(line, `${i}:${line.severity}:${line.label}:${line.text}`))}
        </div>
      </div>
    </div>
  );
}

/**
 * Shared fallback renderer for stream content with no dedicated component.
 *
 * Collapsed-by-default disclosure row for unrecognized/unparseable content:
 * one line (severity codicon + label + chevron) that expands in place to the
 * raw JSON via the shared `JsonBlock`. Its chevron row keeps unrecognized
 * content (e.g. a newer message type from a provider) scannable instead of dominating
 * the viewport with expanded JSON. Content is never dropped — only its
 * default visibility changes. Severity conveys honestly: most unrecognized
 * content is merely unclassified, not an error, so `info` is the default —
 * only genuine tool/session errors should pass `severity="error"`.
 *
 * @summary Severity-aware collapsed-by-default raw/unknown-content disclosure row
 * @module streams/lib/RawFallback
 */

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { JsonBlock } from './JsonBlock';

/** Severity of the unrecognized/fallback content — drives icon + color only. */
export type RawFallbackSeverity = 'info' | 'warning' | 'error';

interface RawFallbackProps {
  /** The value to display as pretty-printed JSON (or a raw string). */
  data: unknown;
  /** Label shown in the collapsed row. Defaults to "Raw data" when omitted. */
  label?: string;
  /** Severity of the fallback content. Defaults to `info` — unrecognized is not the same as erroneous. */
  severity?: RawFallbackSeverity;
}

const SEVERITY_ICON: Record<RawFallbackSeverity, string> = {
  info: 'codicon-info',
  warning: 'codicon-warning',
  error: 'codicon-error'
};

const SEVERITY_COLOR: Record<RawFallbackSeverity, string> = {
  info: 'var(--stream-fg-muted)',
  warning: 'var(--stream-severity-warning-fg)',
  error: 'var(--stream-severity-error-fg)'
};

/**
 * Renders unrecognized/fallback content as a collapsed-by-default,
 * severity-aware disclosure row that expands to a labeled JSON block.
 * @param root0 - The component props.
 * @param root0.data - The value to display.
 * @param root0.label - Label shown in the collapsed row.
 * @param root0.severity - Severity of the fallback content.
 * @returns Rendered fallback disclosure element.
 */
export function RawFallback({ data, label, severity = 'info' }: RawFallbackProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const color = SEVERITY_COLOR[severity];
  const displayLabel = label ?? 'Raw data';

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && bodyRef.current) {
        const el = bodyRef.current;
        el.style.opacity = '0';
        requestAnimationFrame(() => {
          el.style.opacity = '1';
        });
      }
      return next;
    });
  }, []);

  return (
    <div className="session-raw-fallback">
      <button
        type="button"
        aria-expanded={open}
        onClick={handleToggle}
        className="session-raw-fallback__toggle"
        style={{ color }}
      >
        <span
          className="codicon codicon-chevron-right cc-chevron session-raw-fallback__chevron"
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        />
        <span className={`codicon ${SEVERITY_ICON[severity]} session-raw-fallback__icon`} />
        <span className="session-raw-fallback__label">{displayLabel}</span>
      </button>
      <div
        ref={bodyRef}
        className="cc-accordion-body session-raw-fallback__body"
        style={{ display: open ? 'block' : 'none', opacity: open ? 1 : 0, borderLeft: `2px solid ${color}` }}
      >
        <JsonBlock value={data} />
      </div>
    </div>
  );
}

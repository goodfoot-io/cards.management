/**
 * Single hook row shared by nested and orphan hook presentations.
 *
 * Renders one `hook_*` attachment as a glyph + summary line with an in-place
 * expandable body when the hook carries one — used both inside a tool's
 * {@link HookSection} (nested) and as a standalone {@link OrphanHookRow}
 * (when no tool was rendered for the hook). Factoring the row into one
 * component keeps both paths at parity: an orphan `hook_blocking_error`
 * reveals the same `blockingError.blockingError` + `command` body a nested one
 * does, and the escalation styling is identical.
 *
 * Body content is never dumped as an opaque string: `hook_system_message` and
 * `hook_additional_context` are prose meant to be read, so they always render
 * through {@link renderMarkdownNodes}; the run-hook types (`hook_success` /
 * `hook_non_blocking_error` / `hook_blocking_error`) auto-detect their body —
 * a JSON-shaped payload renders via the shared {@link JsonBlock}, a
 * markdown-shaped one through {@link renderMarkdownNodes}, otherwise plain
 * pre-wrapped text. A structured `hookSpecificOutput` object, when present, is
 * always shown as its own key/value table via the shared
 * {@link ToolInputTable} — never folded into the free-text body or dropped.
 *
 * Glyph and summary derive from the pure {@link classifyAttachment} classifier.
 * Color rides the glyph only: `!` (non-blocking) uses the warning severity
 * token, `✗` (blocking) uses the error severity token; `✓`/`○` stay neutral. A
 * `hook_blocking_error` escalates the whole row to the error-severity variant
 * with a left border. Bodies expand in place via a plain disclosure (no
 * nested accordion), holding the two-level nesting cap.
 *
 * Text-tag hooks (`context` / `message`) render the tag as a styled glyph and
 * drop the duplicated leading `{tag} · ` from the summary so the row reads the
 * tag once.
 *
 * @summary Shared single hook row (glyph + summary + in-place structured body) for nested and orphan use
 * @module components/accordions/HookRow
 */

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { ToolInputTable } from '../../../../lib/accordions';
import { JsonBlock } from '../../../../lib/JsonBlock';
import { looksLikeMarkdown, renderMarkdownNodes } from '../../../../lib/markdown';
import { type AttachmentGlyphSeverity, classifyAttachment } from '../../lib/classify-attachment';
import type {
  AttachmentPayload,
  HookAdditionalContextAttachment,
  HookBlockingErrorAttachment,
  HookNonBlockingErrorAttachment,
  HookSuccessAttachment,
  HookSystemMessageAttachment
} from '../../lib/parse-session';

/** Glyphs that are short text tags rather than symbols. */
const TEXT_TAG_GLYPHS = new Set<string>(['context', 'message']);

/** Hook kinds whose body is always prose meant to be read, never plain dump. */
const ALWAYS_MARKDOWN_KINDS = new Set<string>(['hook_system_message', 'hook_additional_context']);

/**
 * Maps a classifier glyph severity to its shared design-token color.
 * Only `warning` and `error` carry color; neutral glyphs inherit foreground.
 * @param severity - Glyph severity from the classifier descriptor.
 * @returns A CSS color value, or undefined for neutral.
 */
function glyphColor(severity: AttachmentGlyphSeverity): string | undefined {
  if (severity === 'warning') return 'var(--stream-severity-warning-fg)';
  if (severity === 'error') return 'var(--stream-severity-error-fg)';
  return undefined;
}

/**
 * Extracts the expandable body text for a hook payload, if any.
 * Reads only the fields relevant per subtype: stdout/stderr/content for run
 * hooks, the nested blockingError string plus its command for blocking errors.
 * @param hook - A hook attachment payload.
 * @returns Joined body text, or null when the hook has no body.
 */
export function hookBodyText(hook: AttachmentPayload): string | null {
  switch (hook.type) {
    case 'hook_success': {
      const h = hook as HookSuccessAttachment;
      const parts = [h.stdout, h.stderr, h.content].filter((p): p is string => typeof p === 'string' && p.length > 0);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'hook_non_blocking_error': {
      const h = hook as HookNonBlockingErrorAttachment;
      const parts = [h.stderr, h.stdout].filter((p): p is string => typeof p === 'string' && p.length > 0);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'hook_additional_context': {
      const h = hook as HookAdditionalContextAttachment;
      const content = h.content;
      return Array.isArray(content) && content.length > 0 ? content.join('\n') : null;
    }
    case 'hook_system_message': {
      const h = hook as HookSystemMessageAttachment;
      return typeof h.content === 'string' && h.content.length > 0 ? h.content : null;
    }
    case 'hook_blocking_error': {
      const h = hook as HookBlockingErrorAttachment;
      const reason = h.blockingError?.blockingError;
      const command = h.blockingError?.command;
      const parts = [reason, command].filter((p): p is string => typeof p === 'string' && p.length > 0);
      return parts.length > 0 ? parts.join('\n\n') : null;
    }
    default:
      return null;
  }
}

/**
 * Reads a hook payload's structured `hookSpecificOutput` object, if any.
 * @param hook - A hook attachment payload.
 * @returns The object, or undefined when absent/not a plain object.
 */
function hookSpecificOutputOf(hook: AttachmentPayload): Record<string, unknown> | undefined {
  const value = (hook as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Sentinel returned by {@link tryParseJson} when `text` does not parse as JSON. */
const NOT_JSON = Symbol('not-json');

/**
 * Attempts to parse `text` as JSON. A parse failure is an expected, common
 * outcome here (most hook bodies are plain shell output, not JSON), so it
 * resolves to the {@link NOT_JSON} sentinel rather than throwing or logging.
 * @param text - Candidate text to parse.
 * @returns The parsed value, or {@link NOT_JSON} when `text` is not valid JSON.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/**
 * Renders a hook's free-text body, auto-detecting JSON vs. markdown vs. plain
 * text — except `hook_system_message`/`hook_additional_context`, whose body is
 * always prose meant to be read and so always renders through
 * {@link renderMarkdownNodes}.
 * @param kind - The classifier `descriptor.kind` for this hook.
 * @param body - The extracted body text.
 * @returns The rendered body element.
 */
function renderHookBody(kind: string, body: string): React.ReactElement {
  const trimmed = body.trim();
  if (!ALWAYS_MARKDOWN_KINDS.has(kind) && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    const parsed = tryParseJson(trimmed);
    if (parsed !== NOT_JSON) return <JsonBlock value={parsed} />;
  }
  if (ALWAYS_MARKDOWN_KINDS.has(kind) || looksLikeMarkdown(body)) {
    return (
      <div
        className="cc-text session-markdown pb-1.5 break-words overflow-wrap-anywhere min-w-0 max-w-full"
        style={{ fontSize: 'var(--stream-text-code)' }}
      >
        {renderMarkdownNodes(body, 'hook-body')}
      </div>
    );
  }
  return (
    <div
      className="whitespace-pre-wrap break-words pb-1.5 font-vscode-editor"
      style={{ color: 'var(--stream-fg)', fontSize: 'var(--stream-text-code)' }}
    >
      {body}
    </div>
  );
}

interface HookRowProps {
  /** The hook attachment to render as a single row. */
  hook: AttachmentPayload;
}

/**
 * Renders a single hook row: glyph + summary, with an in-place expandable body
 * when the hook carries one. A `hook_blocking_error` escalates the row to the
 * error-severity variant with a left border. Plain disclosure (no nested
 * accordion) keeps the two-level cap. Shared by {@link HookSection} (nested)
 * and {@link OrphanHookRow} (standalone) so both stay at parity.
 * @param root0 - The component props.
 * @param root0.hook - The hook attachment to render.
 * @returns Rendered hook row element.
 */
export function HookRow({ hook }: HookRowProps): React.ReactElement {
  const descriptor = classifyAttachment(hook);
  const body = hookBodyText(hook);
  const hookSpecificOutput = hookSpecificOutputOf(hook);
  const hasHookSpecificOutput = hookSpecificOutput !== undefined && Object.keys(hookSpecificOutput).length > 0;
  const hasBody = body !== null || hasHookSpecificOutput;
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => {
    if (!hasBody) return;
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
  }, [hasBody]);

  const isBlocking = descriptor.kind === 'hook_blocking_error';
  const isTextTag = descriptor.glyph !== undefined && TEXT_TAG_GLYPHS.has(descriptor.glyph);

  // A text-tag hook (`context` / `message`) carries its tag word as the glyph;
  // its summary is `"{tag} · {hookName}"`. Render the tag once by stripping the
  // duplicated `"{tag} · "` prefix from the summary, leaving just the hook name.
  const summaryText =
    isTextTag && descriptor.glyph && descriptor.summary.startsWith(`${descriptor.glyph} · `)
      ? descriptor.summary.slice(descriptor.glyph.length + 3)
      : descriptor.summary;

  const color = glyphColor(descriptor.glyphSeverity);
  const glyphNode = descriptor.glyph ? (
    <span className="shrink-0" style={color ? { color } : undefined}>
      {descriptor.glyph}
    </span>
  ) : null;

  const headerRow = (
    <span className="flex items-center gap-2 flex-1 overflow-hidden">
      {glyphNode}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{summaryText}</span>
    </span>
  );

  const wrapperStyle: React.CSSProperties = isBlocking
    ? { color: 'var(--stream-severity-error-fg)', borderLeft: '2px solid var(--stream-severity-error-fg)' }
    : { color: 'var(--stream-fg)' };

  if (!hasBody) {
    return (
      <div className="flex items-center gap-2 w-full font-vscode text-[11px] py-0.5 px-2" style={wrapperStyle}>
        {headerRow}
      </div>
    );
  }

  return (
    <div className="px-2" style={isBlocking ? wrapperStyle : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={handleToggle}
        className="flex items-center gap-2 w-full text-left bg-transparent border-none font-vscode text-[11px] cursor-pointer py-0.5"
        style={isBlocking ? { color: 'var(--stream-severity-error-fg)' } : { color: 'var(--stream-fg)' }}
      >
        {headerRow}
        <span
          className="codicon codicon-chevron-right cc-chevron shrink-0"
          style={{
            color: 'var(--stream-fg-muted)',
            fontSize: 'var(--stream-text-label)',
            transform: open ? 'rotate(90deg)' : undefined
          }}
        />
      </button>
      <div
        ref={bodyRef}
        className="cc-accordion-body"
        style={{ display: open ? 'block' : 'none', opacity: open ? 1 : 0, transition: 'opacity 0.1s ease' }}
      >
        {body !== null && renderHookBody(descriptor.kind, body)}
        {hasHookSpecificOutput && (
          <div>
            <div className="stream-block-label font-vscode-editor">Hook-specific output</div>
            <ToolInputTable input={hookSpecificOutput} />
          </div>
        )}
      </div>
    </div>
  );
}

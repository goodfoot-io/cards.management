/**
 * Tool result section inside a tool accordion body.
 *
 * Shows a "RESULT" label followed by the result content. Markdown results
 * (e.g. skill instructions) are rendered as formatted HTML; plain text results
 * are shown as pre-wrapped text. No clipping — full content is always visible
 * when the accordion is open.
 *
 * @summary Tool result label with markdown-aware full content display
 * @module components/accordions/ToolResult
 */

import type React from 'react';
import { looksLikeMarkdown, renderMarkdownNodes } from '../markdown';

interface ToolResultProps {
  /** Result string to display. */
  result: string;
}

/**
 * Renders the result section of a tool accordion.
 * @param root0 - The component props.
 * @param root0.result - Result string to display.
 * @returns Rendered tool result section element.
 */
export function ToolResult({ result }: ToolResultProps): React.ReactElement {
  const isMarkdown = looksLikeMarkdown(result);

  return (
    <div
      style={{
        borderTop: '0.5px solid var(--stream-border-subtle)',
        background: 'var(--stream-surface-muted)'
      }}
    >
      <div className="stream-block-label font-vscode-editor">Result</div>
      {isMarkdown ? (
        <div
          className="cc-text session-markdown pb-2 break-words overflow-wrap-anywhere min-w-0 max-w-full"
          style={{ fontSize: 'var(--stream-text-code)' }}
        >
          {renderMarkdownNodes(result, 'tool-result')}
        </div>
      ) : (
        <div
          className="text-vscode-foreground font-vscode-editor whitespace-pre-wrap break-words pb-1.5"
          style={{ fontSize: 'var(--stream-text-code)' }}
        >
          {result}
        </div>
      )}
    </div>
  );
}

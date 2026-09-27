/**
 * File-oriented attachment row.
 *
 * Renders the file-lifecycle attachments in two shapes driven by the
 * descriptor's `expandable` flag:
 *
 * - **Expandable** (`file`, `edited_text_file`, `queued_command`) — a
 *   content-tier summary that opens to the file content, the edit snippet, or
 *   the full queued prompt via the shared {@link ExpandableRow} primitive. The
 *   `edited_text_file` glyph rides the git-modified hue. The body auto-detects
 *   its shape: JSON-looking text renders via the shared {@link JsonBlock},
 *   markdown-shaped text via {@link renderMarkdownNodes}, otherwise plain
 *   pre-wrapped text — so a `.md` memory/file read or a JSON file's content
 *   never shows as an unformatted blob.
 * - **Leaf** (`compact_file_reference`, `opened_file_in_ide`,
 *   `selected_lines_in_ide`) — a rule-6 `·` bullet line whose linkified path
 *   uses `textLink-foreground` with a hover underline and no body.
 *
 * The linkified path is `descriptor.linkPath`; the presenter never re-derives
 * it. Color appears only on the glyph and link per the plan — the shared
 * `--stream-*` tokens where one exists, a literal `var(--vscode-…, #fallback)`
 * for the two colors with no token equivalent (link, git-modified hue).
 *
 * @summary File-lifecycle row (file / edited / queued / IDE-reference leaves)
 * @module components/expanded/messages/attachment/FileRow
 */

import type React from 'react';
import { ExpandableRow } from '../../../../../../lib/accordions';
import { JsonBlock } from '../../../../../../lib/JsonBlock';
import { looksLikeMarkdown, renderMarkdownNodes } from '../../../../../../lib/markdown';
import type { AttachmentDescriptor } from '../../../../lib/classify-attachment';
import type {
  AttachmentPayload,
  EditedTextFileAttachment,
  FileAttachment,
  QueuedCommandAttachment,
  SelectedLinesInIdeAttachment
} from '../../../../lib/parse-session';

/** Sentinel returned by {@link tryParseJson} when `text` does not parse as JSON. */
const NOT_JSON = Symbol('not-json');

/**
 * Attempts to parse `text` as JSON. A parse failure is an expected, common
 * outcome here (most file/snippet bodies are plain source text, not JSON), so
 * it resolves to the {@link NOT_JSON} sentinel rather than throwing or logging.
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
 * Renders a file-lifecycle body, auto-detecting JSON vs. markdown vs. plain text.
 * @param body - The body text to render.
 * @returns The rendered body element.
 */
function renderBody(body: string): React.ReactElement {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = tryParseJson(trimmed);
    if (parsed !== NOT_JSON) return <JsonBlock value={parsed} />;
  }
  if (looksLikeMarkdown(body)) {
    return (
      <div
        className="cc-text session-markdown pb-1.5 break-words overflow-wrap-anywhere min-w-0 max-w-full"
        style={{ fontSize: 'var(--stream-text-code)' }}
      >
        {renderMarkdownNodes(body, 'file-row')}
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

interface FileRowProps {
  /** The classifier descriptor for this attachment. */
  descriptor: AttachmentDescriptor;
  /** The raw attachment payload, read only for body assembly. */
  attachment: AttachmentPayload;
}

/**
 * Assembles the expandable body text for a file-lifecycle attachment.
 * Reads only the fields relevant per subtype; returns null when the payload
 * carries no body worth disclosing.
 * @param attachment - The raw attachment payload.
 * @returns The body text, or null when there is nothing to expand.
 */
export function fileBodyText(attachment: AttachmentPayload): string | null {
  switch (attachment.type) {
    case 'file': {
      const a = attachment as FileAttachment;
      const content = a.content?.file?.content;
      return typeof content === 'string' && content.length > 0 ? content : null;
    }
    case 'edited_text_file': {
      const a = attachment as EditedTextFileAttachment;
      return typeof a.snippet === 'string' && a.snippet.length > 0 ? a.snippet : null;
    }
    case 'queued_command': {
      const a = attachment as QueuedCommandAttachment;
      const parts = [a.prompt, a.commandMode ? `mode: ${a.commandMode}` : null].filter(
        (p): p is string => typeof p === 'string' && p.length > 0
      );
      return parts.length > 0 ? parts.join('\n\n') : null;
    }
    case 'selected_lines_in_ide': {
      const a = attachment as SelectedLinesInIdeAttachment;
      return typeof a.content === 'string' && a.content.length > 0 ? a.content : null;
    }
    default:
      return null;
  }
}

/**
 * Renders the descriptor glyph, tinting the `edited_text_file` glyph with the
 * git-modified hue and leaving every other glyph neutral.
 * @param descriptor - The classifier descriptor.
 * @returns The glyph element, or null when the descriptor has no glyph.
 */
function glyphNode(descriptor: AttachmentDescriptor): React.ReactNode {
  if (!descriptor.glyph) return null;
  const color =
    descriptor.kind === 'edited_text_file'
      ? 'var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)'
      : undefined;
  return (
    <span className="shrink-0" style={color ? { color } : undefined}>
      {descriptor.glyph}
    </span>
  );
}

/**
 * Renders a file-lifecycle attachment row — expandable for content payloads,
 * leaf for IDE-reference rows.
 * @param root0 - The component props.
 * @param root0.descriptor - The classifier descriptor for this attachment.
 * @param root0.attachment - The raw attachment payload, read for body assembly.
 * @returns Rendered file row element.
 */
export function FileRow({ descriptor, attachment }: FileRowProps): React.ReactElement {
  // Leaf rows (rule 6): the `·` bullet is supplied by ExpandableRow's leaf mode,
  // so the header carries only the linkified path with the textLink hue.
  if (!descriptor.expandable) {
    const header = descriptor.linkPath ? (
      <span
        className="overflow-hidden text-ellipsis whitespace-nowrap hover:underline cursor-pointer"
        style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}
      >
        {descriptor.summary}
      </span>
    ) : (
      <span
        className="overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: 'var(--stream-fg-muted)', fontSize: '0.78em' }}
      >
        {descriptor.summary}
      </span>
    );
    return <ExpandableRow header={header} expandable={false} />;
  }

  const body = fileBodyText(attachment);

  // selected_lines_in_ide keeps the rule-6 `·` reference affordance — a linkified
  // path at link weight — in its collapsed header, but the `content` it carries
  // makes it expandable to that selected source text rather than a bodyless leaf.
  const isLinkReference = descriptor.kind === 'selected_lines_in_ide' && descriptor.linkPath !== undefined;
  const header = isLinkReference ? (
    <span className="flex items-center gap-2 flex-1 overflow-hidden">
      {glyphNode(descriptor)}
      <span
        className="overflow-hidden text-ellipsis whitespace-nowrap hover:underline"
        style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}
      >
        {descriptor.summary}
      </span>
    </span>
  ) : (
    <span className="flex items-center gap-2 flex-1 overflow-hidden" style={{ color: 'var(--stream-fg-muted)' }}>
      {glyphNode(descriptor)}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{descriptor.summary}</span>
    </span>
  );

  if (body === null) {
    return <ExpandableRow header={header} expandable={false} />;
  }

  return <ExpandableRow header={header}>{renderBody(body)}</ExpandableRow>;
}

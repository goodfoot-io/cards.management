/**
 * Content-tier openable attachment row.
 *
 * Extracts body text for the content-tier attachments — `nested_memory`,
 * `skill_listing`, `invoked_skills`, `dynamic_skill`, and a long
 * `mcp_instructions_delta`. The Cards-owned provider presenter decides when
 * to mount that body and renders it as safe Markdown, JSON, or pre-wrapped text.
 *
 * The descriptor supplies the summary and visibility decision; body extraction
 * reads only the raw fields needed for display and does not re-derive meaning.
 *
 * @summary Content-tier disclosure row (memory / skills / mcp instructions)
 * @module components/expanded/messages/attachment/DisclosureRow
 */

import type React from 'react';
import { ExpandableRow } from '../../../../../../lib/accordions';
import { looksLikeMarkdown, renderMarkdownNodes } from '../../../../../../lib/markdown';
import type { AttachmentDescriptor } from '../../../../lib/classify-attachment';
import type {
  AttachmentPayload,
  DynamicSkillAttachment,
  InvokedSkillsAttachment,
  NestedMemoryAttachment,
  SkillListingAttachment
} from '../../../../lib/parse-session';

interface DisclosureRowProps {
  /** The classifier descriptor for this attachment. */
  descriptor: AttachmentDescriptor;
  /** The raw attachment payload, read only for body assembly. */
  attachment: AttachmentPayload;
}

/**
 * Assembles the expandable body text for a content-tier disclosure attachment.
 * Reads only the fields relevant per subtype; returns null when the payload
 * carries no body worth disclosing.
 * @param attachment - The raw attachment payload.
 * @returns The body text, or null when there is nothing to expand.
 */
export function disclosureBodyText(attachment: AttachmentPayload): string | null {
  switch (attachment.type) {
    case 'nested_memory': {
      const a = attachment as NestedMemoryAttachment;
      const content = a.content?.content;
      return typeof content === 'string' && content.length > 0 ? content : null;
    }
    case 'skill_listing': {
      const a = attachment as SkillListingAttachment;
      if (typeof a.content === 'string' && a.content.length > 0) return a.content;
      const names = a.names ?? [];
      return names.length > 0 ? names.join('\n') : null;
    }
    case 'invoked_skills': {
      const a = attachment as InvokedSkillsAttachment;
      const skills = a.skills ?? [];
      // One sub-row per skill: a `### name/path` heading followed by its content,
      // so the disclosure shows what each skill loaded — not just its name. The
      // markdown heading renders through renderMarkdownNodes like the other bodies.
      const sections = skills
        .map((s) => {
          const heading = s.name ?? s.path ?? '';
          if (heading.length === 0 && !s.content) return '';
          const content = typeof s.content === 'string' ? s.content : '';
          return content.length > 0 ? `### ${heading}\n\n${content}` : `### ${heading}`;
        })
        .filter((section) => section.length > 0);
      return sections.length > 0 ? sections.join('\n\n') : null;
    }
    case 'dynamic_skill': {
      const a = attachment as DynamicSkillAttachment;
      const names = a.skillNames ?? [];
      return names.length > 0 ? names.join('\n') : null;
    }
    default:
      return null;
  }
}

/**
 * Renders a content-tier disclosure attachment row.
 * @param root0 - The component props.
 * @param root0.descriptor - The classifier descriptor for this attachment.
 * @param root0.attachment - The raw attachment payload, read for body assembly.
 * @returns Rendered disclosure row element.
 */
export function DisclosureRow({ descriptor, attachment }: DisclosureRowProps): React.ReactElement {
  const body = disclosureBodyText(attachment);
  const header = (
    <span className="overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: 'var(--stream-fg-muted)' }}>
      {descriptor.summary}
    </span>
  );

  if (body === null) {
    return <ExpandableRow header={header} expandable={false} />;
  }

  return (
    <ExpandableRow header={header}>
      {looksLikeMarkdown(body) ? (
        <div className="cc-text session-markdown text-[11px] pb-2 break-words overflow-wrap-anywhere min-w-0 max-w-full">
          {renderMarkdownNodes(body, 'disclosure')}
        </div>
      ) : (
        <div className="text-[11px] text-vscode-foreground font-vscode-editor whitespace-pre-wrap break-words pb-1.5">
          {body}
        </div>
      )}
    </ExpandableRow>
  );
}

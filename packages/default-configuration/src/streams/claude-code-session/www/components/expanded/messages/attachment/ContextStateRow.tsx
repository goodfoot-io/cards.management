/**
 * Ambient turn-state attachment row.
 *
 * Renders the quiet, ambient-tier turn-context attachments — `team_context`,
 * `command_permissions`, `deferred_tools_delta`, `mcp_instructions_delta`,
 * `agent_listing_delta`, and `task_reminder` — as a muted one-line summary.
 * Types whose payload carries a
 * body (the descriptor's `expandable` flag) reveal that body in place via the
 * shared {@link ExpandableRow} primitive; the rest render as static leaf lines.
 *
 * Styling follows the ambient tier from the plan: `descriptionForeground`
 * text at ~0.78em. The presenter reads the descriptor for its summary and
 * expandability and never re-derives meaning; it only assembles the body text
 * from the raw payload for the disclosure.
 *
 * @summary Ambient turn-state row (team/permissions/tools/mcp/task-reminder)
 * @module components/expanded/messages/attachment/ContextStateRow
 */

import type React from 'react';
import { ExpandableRow } from '../../../../../../lib/accordions';
import { JsonBlock } from '../../../../../../lib/JsonBlock';
import { looksLikeMarkdown, renderMarkdownNodes } from '../../../../../../lib/markdown';
import type { AttachmentDescriptor } from '../../../../lib/classify-attachment';
import type {
  AgentListingDeltaAttachment,
  AttachmentPayload,
  CommandPermissionsAttachment,
  DeferredToolsDeltaAttachment,
  McpInstructionsDeltaAttachment,
  TaskReminderAttachment,
  TeamContextAttachment
} from '../../../../lib/parse-session';

/** Sentinel returned by {@link tryParseJson} when `text` does not parse as JSON. */
const NOT_JSON = Symbol('not-json');

/**
 * Attempts to parse `text` as JSON. A parse failure is an expected, common
 * outcome here (most bodies here are plain name/path lists, not JSON), so it
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
 * Renders an ambient turn-state body, auto-detecting JSON vs. markdown vs.
 * plain text (e.g. `mcp_instructions_delta`'s `addedBlocks` are often
 * markdown-formatted MCP server instructions).
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
        {renderMarkdownNodes(body, 'context-state')}
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

interface ContextStateRowProps {
  /** The classifier descriptor for this attachment. */
  descriptor: AttachmentDescriptor;
  /** The raw attachment payload, read only for body assembly. */
  attachment: AttachmentPayload;
}

/**
 * Assembles the expandable body lines for an ambient turn-state attachment.
 * Reads only the fields relevant per subtype; returns null when the payload
 * carries no body worth disclosing.
 * @param attachment - The raw attachment payload.
 * @returns The body text, or null when there is nothing to expand.
 */
export function contextBodyText(attachment: AttachmentPayload): string | null {
  switch (attachment.type) {
    case 'team_context': {
      const a = attachment as TeamContextAttachment;
      const parts = [
        a.teamConfigPath ? `config: ${a.teamConfigPath}` : null,
        a.taskListPath ? `tasks: ${a.taskListPath}` : null
      ].filter((p): p is string => p !== null);
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'command_permissions': {
      const a = attachment as CommandPermissionsAttachment;
      return a.allowedTools.length > 0 ? a.allowedTools.join('\n') : null;
    }
    case 'deferred_tools_delta': {
      const a = attachment as DeferredToolsDeltaAttachment;
      const lines = [
        ...(a.addedNames ?? []).map((n) => `+ ${n}`),
        ...(a.readdedNames ?? []).map((n) => `+ ${n}`),
        ...(a.removedNames ?? []).map((n) => `− ${n}`)
      ];
      return lines.length > 0 ? lines.join('\n') : null;
    }
    case 'mcp_instructions_delta': {
      const a = attachment as McpInstructionsDeltaAttachment;
      const blocks = a.addedBlocks ?? [];
      if (blocks.length > 0) return blocks.join('\n\n');
      const names = a.addedNames ?? [];
      return names.length > 0 ? names.join('\n') : null;
    }
    case 'task_reminder': {
      const a = attachment as TaskReminderAttachment;
      const items = a.content ?? [];
      return items.length > 0 ? items.map((item) => String(item)).join('\n') : null;
    }
    case 'agent_listing_delta': {
      const a = attachment as AgentListingDeltaAttachment;
      const lines = [...(a.addedTypes ?? []).map((n) => `+ ${n}`), ...(a.removedTypes ?? []).map((n) => `− ${n}`)];
      return lines.length > 0 ? lines.join('\n') : null;
    }
    default:
      return null;
  }
}

/**
 * Renders an ambient turn-state attachment row.
 * @param root0 - The component props.
 * @param root0.descriptor - The classifier descriptor for this attachment.
 * @param root0.attachment - The raw attachment payload, read for body assembly.
 * @returns Rendered ambient row element.
 */
export function ContextStateRow({ descriptor, attachment }: ContextStateRowProps): React.ReactElement {
  const body = descriptor.expandable ? contextBodyText(attachment) : null;
  const header = (
    <span
      className="overflow-hidden text-ellipsis whitespace-nowrap"
      style={{ color: 'var(--stream-fg-muted)', fontSize: '0.78em' }}
    >
      {descriptor.summary}
    </span>
  );

  if (body === null) {
    return <ExpandableRow header={header} expandable={false} />;
  }

  return <ExpandableRow header={header}>{renderBody(body)}</ExpandableRow>;
}

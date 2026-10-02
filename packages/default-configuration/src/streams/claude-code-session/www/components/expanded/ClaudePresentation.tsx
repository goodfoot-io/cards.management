/**
 * Ordinary Claude presentation consumes Cards leaves and controlled view state.
 * Existing attachment body assembly, classification and tool summaries remain provider-owned.
 * @summary Claude controlled tools, attachments, preamble and ambient groups
 * @module components/expanded/ClaudePresentation
 */
import type { ReactElement } from 'react';
import { ToolInputTable } from '../../../../lib/accordions';
import { JsonBlock } from '../../../../lib/JsonBlock';
import { looksLikeMarkdown, renderMarkdownNodes } from '../../../../lib/markdown';
import {
  BoundedText,
  SessionContent,
  SessionDisclosure,
  type SessionProviderRegistry,
  type SessionRenderContext
} from '../../../../lib/session/SessionContent';
import type { SessionLeaf } from '../../../../lib/session/types';
import type {
  ClaudeAttachmentData,
  ClaudePart,
  ClaudePayloads,
  ClaudeRow,
  ClaudeToolData
} from '../../lib/project-session';
import { summarizeTool } from '../../lib/tool-summary';
import { hookBodyText } from '../accordions/HookRow';
import { contextBodyText } from './messages/attachment/ContextStateRow';
import { disclosureBodyText } from './messages/attachment/DisclosureRow';
import { fileBodyText } from './messages/attachment/FileRow';

const SKIP_INPUT_KEYS = new Set([
  'description',
  'timeout',
  'dangerouslyDisableSandbox',
  'run_in_background',
  'saveAllEditors',
  'summary'
]);
/**
 * Renders bounded text before attempting Markdown or JSON formatting of oversized native output.
 * @param root0 - Typed presentation inputs.
 * @param root0.text - Complete native text retained for inspection.
 * @param root0.leaf - Stable identity and physical provenance.
 * @param root0.context - Caller-controlled disclosure and layout hooks.
 * @param root0.slot - Independent bounded inspection region within this leaf.
 * @returns Rendered controlled Claude presentation.
 */
function Body({
  text,
  leaf,
  context,
  slot = 'body'
}: {
  text: string;
  leaf: SessionLeaf;
  context: SessionRenderContext;
  slot?: string;
}): ReactElement {
  if (text.length > 65536) return <BoundedText text={text} id={leaf.id} context={context} slot={slot} />;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return <JsonBlock value={JSON.parse(text)} />;
    } catch {
      /* Ordinary prose can begin with a brace. */
    }
  }
  return looksLikeMarkdown(text) ? (
    <div className="session-markdown">{renderMarkdownNodes(text, leaf.id)}</div>
  ) : (
    <pre className="session-raw">{text}</pre>
  );
}
/**
 * Produces render-only child rows without taking ownership of a nested scroller.
 * @param root0 - Typed presentation inputs.
 * @param root0.parts - Stable child leaves to render without a viewport.
 * @param root0.context - Caller-controlled disclosure and layout hooks.
 * @returns Rendered controlled Claude presentation.
 */
function Parts({ parts, context }: { parts: readonly ClaudePart[]; context: SessionRenderContext }): ReactElement {
  const rows: ClaudeRow[] = parts.map((part) => ({
    id: `${part.id}/presentation`,
    provenance: part.provenance,
    kind: 'structural',
    label: '',
    tone: 'info',
    anchor: 'none',
    parts: [part]
  }));
  return <SessionContent rows={rows} {...context} providerParts={CLAUDE_PARTS} providerRows={CLAUDE_PARTS} />;
}
/**
 * Preserves attachment summaries, useful body formatting, severity and full native details.
 * @param root0 - Typed presentation inputs.
 * @param root0.data - Provider-owned semantic payload.
 * @param root0.leaf - Stable identity and physical provenance.
 * @returns Rendered controlled Claude presentation.
 */
function Attachment({
  data,
  leaf,
  ...context
}: { data: ClaudeAttachmentData; leaf: SessionLeaf } & SessionRenderContext): ReactElement {
  const { descriptor } = data;
  const label = `${descriptor.glyph ? `${descriptor.glyph} ` : ''}${descriptor.summary}`;
  return (
    <div className={descriptor.glyphSeverity === 'error' ? 'session-tone--error' : undefined}>
      <SessionDisclosure id={leaf.id} label={label} context={context}>
        <AttachmentBody data={data} leaf={leaf} context={context} />
      </SessionDisclosure>
    </div>
  );
}
/**
 * Mounts expensive attachment body assembly only when its controlled disclosure opens.
 * @param root0 - Typed presentation inputs.
 * @param root0.data - Provider-owned semantic payload.
 * @param root0.leaf - Stable identity and physical provenance.
 * @param root0.context - Caller-controlled disclosure and layout hooks.
 * @returns Rendered controlled Claude presentation.
 */
function AttachmentBody({
  data,
  leaf,
  context
}: {
  data: ClaudeAttachmentData;
  leaf: SessionLeaf;
  context: SessionRenderContext;
}): ReactElement {
  const { attachment, descriptor } = data;
  const body =
    hookBodyText(attachment) ??
    disclosureBodyText(attachment) ??
    fileBodyText(attachment) ??
    contextBodyText(attachment);
  const specific = (attachment as unknown as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  const detail: ClaudePart = {
    ...leaf,
    id: `${leaf.id}/raw`,
    kind: 'raw',
    reason: descriptor.kind === '__unknown__' ? 'unknown' : 'detail',
    label: 'Raw attachment details',
    text: JSON.stringify(attachment)
  };
  return (
    <>
      {body ? <Body text={body} leaf={leaf} context={context} /> : null}
      {specific ? (
        <>
          <div className="session-label">Hook-specific output</div>
          <Body text={JSON.stringify(specific)} leaf={leaf} context={context} slot="hook-output" />
        </>
      ) : null}
      <Parts parts={[detail]} context={context} />
    </>
  );
}
/**
 * Keeps Claude tool summaries, Skill input treatment, error escalation and nested hook content.
 * @param root0 - Typed presentation inputs.
 * @param root0.data - Provider-owned semantic payload.
 * @param root0.leaf - Stable identity and physical provenance.
 * @returns Rendered controlled Claude presentation.
 */
function Tool({
  data,
  leaf,
  ...context
}: { data: ClaudeToolData; leaf: SessionLeaf } & SessionRenderContext): ReactElement {
  const blocked = data.hooks.find(
    (part) =>
      part.kind === 'provider' &&
      part.providerKind === 'attachment' &&
      part.data.attachment.type === 'hook_blocking_error'
  );
  const hookName =
    blocked?.kind === 'provider' && blocked.providerKind === 'attachment'
      ? (blocked.data.attachment as unknown as { hookName?: string }).hookName
      : undefined;
  const summary = hookName ? `blocked by ${hookName}` : summarizeTool(data.name, data.input);
  const label = `${data.name}${summary ? ` · ${summary}` : ''} · ${data.status}`;
  return (
    <div className={data.status === 'error' ? 'session-tone--error' : undefined}>
      <SessionDisclosure id={leaf.id} label={label} context={context}>
        <ToolBody data={data} leaf={leaf} context={context} />
      </SessionDisclosure>
    </div>
  );
}
/**
 * Mounts expensive tool inspection only after explicit user disclosure.
 * @param root0 - Typed presentation inputs.
 * @param root0.data - Provider-owned semantic payload.
 * @param root0.leaf - Stable identity and physical provenance.
 * @param root0.context - Caller-controlled disclosure and layout hooks.
 * @returns Rendered controlled Claude presentation.
 */
function ToolBody({
  data,
  leaf,
  context
}: {
  data: ClaudeToolData;
  leaf: SessionLeaf;
  context: SessionRenderContext;
}): ReactElement {
  const input = JSON.stringify(data.input);
  const hooks = [...data.hooks].sort((a, b) => {
    const rank = (part: ClaudePart): number =>
      part.kind === 'provider' &&
      part.providerKind === 'attachment' &&
      (part.data.attachment as unknown as { hookEvent?: string }).hookEvent === 'PreToolUse'
        ? 0
        : 1;
    return rank(a) - rank(b);
  });
  return (
    <>
      {data.name !== 'Skill' ? (
        <>
          <div className="session-label">Input</div>
          {input.length > 65536 ? (
            <Body text={input} leaf={leaf} context={context} slot="input" />
          ) : (
            <ToolInputTable input={data.input} skipKeys={SKIP_INPUT_KEYS} />
          )}
        </>
      ) : null}
      {data.output !== undefined ? (
        <>
          <div className="session-label">Result</div>
          <Body text={data.output} leaf={leaf} context={context} slot="result" />
        </>
      ) : null}
      {data.supplemental !== undefined ? (
        <>
          <div className="session-label">Supplemental content</div>
          <Body text={data.supplemental} leaf={leaf} context={context} slot="supplemental" />
        </>
      ) : null}
      {data.hooks.length ? (
        <>
          <div className="session-label">Hooks</div>
          <Parts parts={hooks} context={context} />
        </>
      ) : null}
      <Parts parts={data.details} context={context} />
    </>
  );
}
/** Provider registries use plain typed props; all disclosure state remains owned by the caller. */
export const CLAUDE_PARTS: SessionProviderRegistry<ClaudePayloads> = {
  attachment: { render: (props) => <Attachment {...props} />, disclosureKeys: (leaf) => [leaf.id, `${leaf.id}/raw`] },
  tool: {
    render: (props) => <Tool {...props} />,
    disclosureKeys: (leaf, data) => [leaf.id, ...nestedPartDisclosureIds([...data.hooks, ...data.details])]
  },
  prose: {
    render: ({ data, leaf, ...context }) => (
      <SessionDisclosure id={leaf.id} label={data.label} context={context}>
        <Body text={data.text} leaf={leaf} context={context} />
      </SessionDisclosure>
    ),
    disclosureKeys: (leaf) => [leaf.id]
  },
  group: {
    render: ({ data, leaf, ...context }) => (
      <SessionDisclosure id={leaf.id} label={data.label} context={context}>
        <SessionContent rows={data.rows} {...context} providerParts={CLAUDE_PARTS} providerRows={CLAUDE_PARTS} />
      </SessionDisclosure>
    ),
    disclosureKeys: (leaf, data) => [leaf.id, ...claudeDisclosureIds(data.rows)]
  }
};
/**
 * Collects nested tool and attachment dependencies for presentation and pruning.
 * @param parts - Native parts retained inside a provider tool.
 * @returns Every controlled child identity, including raw attachment detail.
 */
function nestedPartDisclosureIds(parts: readonly ClaudePart[]): Set<string> {
  const result = new Set<string>();
  const visit = (part: ClaudePart): void => {
    result.add(part.id);
    result.add(`${part.id}/raw`);
    if (part.kind === 'provider' && part.providerKind === 'tool')
      for (const child of [...part.data.hooks, ...part.data.details]) visit(child);
  };
  parts.forEach(visit);
  return result;
}
/**
 * Collects nested provider identities so caller state pruning keeps surviving child choices.
 * @param rows - Projected rows including provider-owned nested groups.
 * @returns Every surviving top-level and nested disclosure identity.
 */
export function claudeDisclosureIds(rows: readonly ClaudeRow[]): Set<string> {
  const result = new Set<string>();
  const visit = (row: ClaudeRow): void => {
    result.add(row.id);
    for (const id of nestedPartDisclosureIds(row.parts)) result.add(id);
    if (row.kind === 'provider' && row.providerKind === 'group') row.data.rows.forEach(visit);
  };
  rows.forEach(visit);
  return result;
}

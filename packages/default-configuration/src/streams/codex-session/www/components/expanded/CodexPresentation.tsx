/**
 * Controlled renderers for Codex semantic rows and leaves.
 * All disclosures are owned by Cards and use the shared session primitives.
 * @summary Codex semantic-part renderers
 * @module components/expanded/CodexPresentation
 */

import { type ReactElement, useMemo } from 'react';
import { ToolInputTable } from '../../../../lib/accordions';
import { JsonBlock } from '../../../../lib/JsonBlock';
import { looksLikeMarkdown, renderMarkdownNodes } from '../../../../lib/markdown';
import {
  BoundedText,
  SessionDisclosure,
  type SessionProviderRegistry,
  type SessionRenderContext
} from '../../../../lib/session/SessionContent';
import type { SessionLeaf } from '../../../../lib/session/types';
import { parseCodexLine } from '../../lib/parser';
import type { CodexNativeDetail, CodexPayloads, CodexToolData } from '../../lib/project-session';
import { summarizeCodexTool } from '../../lib/tool-summary';

/**
 * Renders retained text with bounded paging before optional JSON/Markdown formatting.
 * @param root0 - Text presentation inputs.
 * @param root0.text - Complete native text retained for inspection.
 * @param root0.leaf - Stable identity and physical provenance.
 * @param root0.context - Caller-controlled disclosure and layout hooks.
 * @param root0.slot - Independent bounded inspection region.
 * @returns Rendered Codex text body.
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
      // A prose block can begin with a brace; keep the original text in that case.
    }
  }
  return looksLikeMarkdown(text) ? (
    <div className="session-markdown">{renderMarkdownNodes(text, leaf.id)}</div>
  ) : (
    <pre className="session-raw">{text}</pre>
  );
}

/**
 * Bounds raw event details while preserving their existing preformatted appearance.
 * @param root0 - Raw detail presentation inputs.
 * @param root0.text - Complete native detail text.
 * @param root0.leaf - Stable leaf identity and provenance.
 * @param root0.context - Disclosure and layout hooks.
 * @returns A bounded or preformatted raw detail.
 */
function RawBody({
  text,
  leaf,
  context
}: {
  text: string;
  leaf: SessionLeaf;
  context: SessionRenderContext;
}): ReactElement {
  return text.length > 65_536 ? (
    <BoundedText text={text} id={leaf.id} context={context} slot="event-detail" />
  ) : (
    <pre className="session-raw">{text}</pre>
  );
}

function ImageNote({ data }: { data: CodexPayloads['imageNote'] }): ReactElement {
  return (
    <div className="cx-image-note stream-status-line">
      <span className="codicon codicon-file-media" />
      {data.count === 1 ? 'Image' : `${data.count} Images`}
    </div>
  );
}

function SessionStart({
  data,
  leaf,
  ...context
}: { data: CodexPayloads['sessionStart']; leaf: SessionLeaf } & SessionRenderContext): ReactElement {
  return (
    <SessionDisclosure id={leaf.id} label={data.summary} context={context}>
      {data.entries.map((entry) => (
        <div className="session-markdown" key={entry.id}>
          <div className="cx-event-label">{entry.label}</div>
          {renderMarkdownNodes(entry.text, entry.id)}
          {entry.imageCount ? <ImageNote data={{ count: entry.imageCount }} /> : null}
        </div>
      ))}
    </SessionDisclosure>
  );
}

function Tool({
  data,
  leaf,
  ...context
}: { data: CodexToolData; leaf: SessionLeaf } & SessionRenderContext): ReactElement {
  const summary = summarizeCodexTool(data.name, data.argumentsText);
  const status = data.errorLabel ? `${data.status} · ${data.errorLabel}` : data.status;
  return (
    <div className={data.status === 'error' ? 'session-tone--error' : undefined}>
      <SessionDisclosure
        id={leaf.id}
        label={`${data.name}${summary ? ` · ${summary}` : ''} · ${status}`}
        context={context}
      >
        <ToolBody data={data} leaf={leaf} context={context} />
      </SessionDisclosure>
    </div>
  );
}

function ToolBody({
  data,
  leaf,
  context
}: {
  data: CodexToolData;
  leaf: SessionLeaf;
  context: SessionRenderContext;
}): ReactElement {
  const argumentsText = useMemo(
    () =>
      data.deferredArgumentsRecord === undefined
        ? data.argumentsText
        : formatDeferredArguments(data.deferredArgumentsRecord),
    [data.argumentsText, data.deferredArgumentsRecord]
  );
  const input = parsedInput(data, argumentsText);
  const hasArguments = data.argumentsText.length > 0 || data.deferredArgumentsRecord !== undefined;
  return (
    <>
      {hasArguments ? (
        <>
          <div className="session-label">{data.argsLabel}</div>
          {input ? (
            <ToolInputTable input={input} />
          ) : (
            <Body text={argumentsText} leaf={leaf} context={context} slot="input" />
          )}
        </>
      ) : null}
      {data.outputText !== undefined ? (
        <>
          <div className="session-label">Result</div>
          <Body text={data.outputText} leaf={leaf} context={context} slot="result" />
        </>
      ) : null}
      {data.outputImageCount ? <ImageNote data={{ count: data.outputImageCount }} /> : null}
      {data.details.length ? (
        <div className="cx-event">
          <div className="cx-event-label">Native details</div>
          {data.details.map((detail) => (
            <NativeDetail key={detail.id} detail={detail} leaf={leaf} context={context} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function NativeDetail({
  detail,
  leaf,
  context
}: {
  detail: CodexNativeDetail;
  leaf: SessionLeaf;
  context: SessionRenderContext;
}): ReactElement {
  const detailLeaf = { ...leaf, id: detail.id, provenance: detail.provenance };
  return (
    <SessionDisclosure id={detail.id} label={detail.label} context={context}>
      <Body text={detail.text} leaf={detailLeaf} context={context} />
    </SessionDisclosure>
  );
}

function parsedInput(data: CodexToolData, text: string): Record<string, unknown> | undefined {
  if (!data.prettyPrinted) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Formats oversized object-shaped tool input only after its disclosure mounts.
 * @param nativeRecord - Original tool-search JSONL record.
 * @returns Formatted tool arguments or the retained original record.
 */
function formatDeferredArguments(nativeRecord: string): string {
  const line = parseCodexLine(nativeRecord);
  if (line.kind !== 'response_item' || line.payload.type !== 'tool_search_call') return nativeRecord;
  const input = line.payload.arguments;
  return input === undefined ? '' : (JSON.stringify(input, null, 2) ?? String(input));
}

/** Every registry key is implemented so a provider row or part remains renderable through either seam. */
export const CODEX_PRESENTATION: SessionProviderRegistry<CodexPayloads> = {
  imageNote: { render: ({ data }) => <ImageNote data={data} />, disclosureKeys: () => [] },
  eventActivity: {
    render: ({ data, leaf, ...context }) => (
      <div className="cx-event">
        <div className="cx-event-label">{data.label}</div>
        {data.detailText ? (
          data.label === 'plan_update' && looksLikeMarkdown(data.detailText) ? (
            <div className="session-markdown">{renderMarkdownNodes(data.detailText, leaf.id)}</div>
          ) : (
            <RawBody text={data.detailText} leaf={leaf} context={context} />
          )
        ) : null}
      </div>
    ),
    disclosureKeys: () => []
  },
  turnTime: { render: ({ data }) => <div className="session-muted">{data.text}</div>, disclosureKeys: () => [] },
  sessionContext: {
    render: ({ data, leaf, ...context }) => (
      <SessionDisclosure id={leaf.id} label={data.label} context={context}>
        <Body text={data.detailText} leaf={leaf} context={context} />
      </SessionDisclosure>
    ),
    disclosureKeys: (leaf) => [leaf.id]
  },
  sessionStart: { render: (props) => <SessionStart {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  tool: {
    render: (props) => <Tool {...props} />,
    disclosureKeys: (leaf, data) => [leaf.id, ...data.details.map((detail) => detail.id)],
    progress: (data) => ({ name: data.name, status: data.status })
  },
  boundary: {
    render: ({ data }) => (
      <div className="session-tone--boundary" title={data.tooltip}>
        {data.label ? <span className="session-muted">{data.label}</span> : null}
      </div>
    ),
    disclosureKeys: () => []
  }
};

/** Provider part registry consumed by shared SessionContent. */
export const CODEX_PARTS = CODEX_PRESENTATION;
/** Provider row registry consumed by shared SessionContent and SessionViewport. */
export const CODEX_ROWS = CODEX_PRESENTATION;

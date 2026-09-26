/**
 * Controlled renderers for Codex semantic rows and leaves.
 * All disclosures are owned by Cards and use the shared session primitives.
 * @summary Codex semantic-part renderers
 * @module components/expanded/CodexPresentation
 */

import type { ReactElement } from 'react';
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
  const input = parsedInput(data);
  return (
    <>
      {data.argumentsText ? (
        <>
          <div className="session-label">{data.argsLabel}</div>
          {input ? (
            <ToolInputTable input={input} />
          ) : (
            <Body text={data.argumentsText} leaf={leaf} context={context} slot="input" />
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

function parsedInput(data: CodexToolData): Record<string, unknown> | undefined {
  if (!data.prettyPrinted) return undefined;
  try {
    const parsed: unknown = JSON.parse(data.argumentsText);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Every registry key is implemented so a provider row or part remains renderable through either seam. */
export const CODEX_PRESENTATION: SessionProviderRegistry<CodexPayloads> = {
  imageNote: ({ data }) => <ImageNote data={data} />,
  eventActivity: ({ data, leaf }) => (
    <div className="cx-event">
      <div className="cx-event-label">{data.label}</div>
      {data.detailText ? (
        data.label === 'plan_update' && looksLikeMarkdown(data.detailText) ? (
          <div className="session-markdown">{renderMarkdownNodes(data.detailText, leaf.id)}</div>
        ) : (
          <pre className="session-raw">{data.detailText}</pre>
        )
      ) : null}
    </div>
  ),
  turnTime: ({ data }) => <div className="session-muted">{data.text}</div>,
  sessionStart: (props) => <SessionStart {...props} />,
  tool: (props) => <Tool {...props} />,
  boundary: ({ data }) => (
    <div className="session-tone--boundary" title={data.tooltip}>
      {data.label ? <span className="session-muted">{data.label}</span> : null}
    </div>
  )
};

/** Provider part registry consumed by shared SessionContent. */
export const CODEX_PARTS = CODEX_PRESENTATION;
/** Provider row registry consumed by shared SessionContent and SessionViewport. */
export const CODEX_ROWS = CODEX_PRESENTATION;

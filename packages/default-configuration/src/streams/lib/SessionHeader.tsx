/**
 * Shared session header bar for the expanded transcript view.
 *
 * Shows model name, working directory, and a status indicator dot that
 * updates as the session progresses (running/success/error). Provider-
 * neutral: `provider` and `threadId` are optional fields a provider
 * supplies when it has the concept (Codex today); Claude omits them and the
 * header renders exactly as it did before this component moved here.
 *
 * @summary Session header: subagent · model · provider · cwd · thread · status dot
 * @module streams/lib/SessionHeader
 */

import type React from 'react';
import { Fragment } from 'react';

/** Session running/completion status. */
export type SessionStatus = 'running' | 'success' | 'error';

export interface SessionHeaderProps {
  /** Model name (e.g. "claude-opus-4-5"). */
  model: string;
  /** Current working directory of the session. */
  cwd: string;
  /** Session status for the indicator dot color. */
  status: SessionStatus;
  /** Sidecar agent identifier, present only for `role: 'subagent'`/`'auxiliary'` streams. */
  agentId?: string;
  /** Provider name (e.g. "codex"), shown only when present. */
  provider?: string;
  /** Session/thread identifier, shown only when present (monospace). */
  threadId?: string;
}

/** Status dot color per session state, sourced from the shared severity triad. */
const STATUS_COLOR: Record<SessionStatus, string> = {
  running: 'var(--stream-severity-warning-fg)',
  success: 'var(--stream-severity-success-fg)',
  error: 'var(--stream-severity-error-fg)'
};

/**
 * Sticky header bar showing model, cwd, and live status dot.
 * Hidden when model, cwd, and agentId are all empty.
 * @param root0 - The component props.
 * @param root0.model - Model name (e.g. "claude-opus-4-5").
 * @param root0.cwd - Current working directory of the session.
 * @param root0.status - Session status for the indicator dot color.
 * @param root0.agentId - Sidecar agent identifier for subagent/auxiliary streams.
 * @param root0.provider - Provider name, shown only when present.
 * @param root0.threadId - Session/thread identifier, shown only when present.
 * @returns Rendered sticky header bar, or null when model, cwd, and agentId are all empty.
 */
export function SessionHeader({
  model,
  cwd,
  status,
  agentId,
  provider,
  threadId
}: SessionHeaderProps): React.ReactElement | null {
  if (!model && !cwd && !agentId) return null;

  const parts: { key: string; node: React.ReactNode }[] = [];
  if (agentId) {
    parts.push({
      key: 'agent',
      node: (
        <span className="shrink-0 font-vscode-editor" title={`Subagent: ${agentId}`}>
          {agentId}
        </span>
      )
    });
  }
  if (model) {
    parts.push({ key: 'model', node: <span className="font-vscode-editor shrink-0">{model}</span> });
  }
  if (provider) {
    parts.push({ key: 'provider', node: <span className="font-vscode-editor shrink-0">{provider}</span> });
  }
  if (cwd) {
    parts.push({
      key: 'cwd',
      node: (
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-vscode-editor" title={cwd}>
          {cwd}
        </span>
      )
    });
  }
  if (threadId) {
    parts.push({
      key: 'thread',
      node: (
        <span className="font-vscode-editor shrink-0" title={threadId}>
          {threadId.slice(0, 8)}
        </span>
      )
    });
  }

  return (
    <div
      className="flex items-center gap-2 px-3.5 py-1.5 text-[0.78em] text-vscode-descriptionForeground shrink-0 opacity-70"
      style={{ borderBottom: '1px solid var(--stream-border-subtle)' }}
    >
      {parts.map((part, i) => (
        <Fragment key={part.key}>
          {i > 0 && <span className="opacity-30 shrink-0">·</span>}
          {part.node}
        </Fragment>
      ))}
      <span className="shrink-0 w-[6px] h-[6px] rounded-full ml-auto" style={{ background: STATUS_COLOR[status] }} />
    </div>
  );
}

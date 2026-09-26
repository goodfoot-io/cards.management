/**
 * Cards-owned presentation for an already-projected Antigravity native source.
 * @summary Antigravity session rows inside the shared expanded viewport
 * @module streams/antigravity-session/www/components/expanded/AntigravitySessionView
 */

import type { ReactElement } from 'react';
import { SessionHeader } from '../../../../lib/SessionHeader';
import {
  BoundedText,
  type ProviderPresentationProps,
  SessionDisclosure,
  type SessionProviderRegistry,
  type SessionRenderContext
} from '../../../../lib/session/SessionContent';
import { SessionViewport } from '../../../../lib/session/SessionViewport';
import type { NativeTranscriptSource, SessionDisclosureState, SessionProjection } from '../../../../lib/session/types';
import type {
  AntigravityAnomalyPayload,
  AntigravityPayloads,
  AntigravityToolCallPayload
} from '../../lib/project-session';

/**
 * Renders a native Antigravity anomaly with its previous per-kind evidence policy.
 * @param root0 - Typed anomaly payload and source provenance.
 * @param root0.leaf - Stable semantic identity for bounded content inspection.
 * @param root0.data - Provider-owned anomaly facts.
 * @param root0.disclosures - Controlled disclosure identities.
 * @param root0.layout - Viewport layout notifications.
 * @returns A named structural event, with undecodable payloads withheld.
 */
function AntigravityAnomalyPart({
  leaf,
  data,
  disclosures,
  layout
}: ProviderPresentationProps<AntigravityAnomalyPayload>): ReactElement {
  const context: SessionRenderContext = { disclosures, layout };
  const presentation: Record<AntigravityAnomalyPayload['kind'], { icon: string; label: string }> = {
    'host-drift': { icon: 'codicon-duplicate', label: 'Host drift' },
    'flush-partial': { icon: 'codicon-info', label: 'Partial flush' },
    'format-unknown': { icon: 'codicon-warning', label: 'Unreadable content (format unknown)' },
    'schema-drift': { icon: 'codicon-duplicate', label: 'Host drift · schema changed' }
  };
  const item = presentation[data.kind];
  return (
    <div className="agy-anomaly">
      <div className="agy-anomaly-label">
        <span className={`codicon ${item.icon}`} aria-hidden="true" />
        <span>{item.label}</span>
        {data.idx !== undefined ? <span className="agy-anomaly-idx">step {data.idx}</span> : null}
      </div>
      <div className="agy-anomaly-detail">{data.detail}</div>
      {data.kind === 'format-unknown' ? (
        <div className="agy-anomaly-detail">
          {data.withheldBytes === undefined || data.withheldBytes === 0
            ? 'Undecodable content withheld'
            : `${data.withheldBytes} bytes of undecodable content withheld`}
        </div>
      ) : data.content !== undefined ? (
        <div className="agy-anomaly-content">
          <BoundedText text={data.content} id={leaf.id} context={context} slot="evidence" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders one decoded invocation as inert tool metadata and a bounded argument disclosure.
 * @param root0 - Tool facts, stable identity, controlled state, and layout hooks.
 * @param root0.leaf - Semantic identity backed by Antigravity's native idx.
 * @param root0.data - Decoded provider-owned invocation facts.
 * @param root0.disclosures - Controlled expanded-state map.
 * @param root0.layout - Outer viewport geometry and focus notifications.
 * @returns Tool invocation content with no command execution affordance.
 */
function AntigravityToolCallRow({
  leaf,
  data,
  disclosures,
  layout
}: ProviderPresentationProps<AntigravityToolCallPayload>): ReactElement {
  const context: SessionRenderContext = { disclosures, layout };
  const input = safeJson(data.arguments);
  return (
    <div>
      <div className="session-label">
        Tool · {data.name} · step {data.idx} · status {data.status}
      </div>
      <SessionDisclosure id={leaf.id} label="Tool arguments" context={context}>
        <BoundedText text={input} id={leaf.id} context={context} slot="arguments" />
      </SessionDisclosure>
    </div>
  );
}

/**
 * Serializes decoded JSON arguments only when the disclosure is rendered.
 * @param value - JSON-compatible native invocation arguments.
 * @returns Stable readable JSON or a scalar fallback.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const ANTIGRAVITY_PARTS: SessionProviderRegistry<AntigravityPayloads> = {
  anomaly: AntigravityAnomalyPart,
  toolCall: AntigravityToolCallRow
};
const ANTIGRAVITY_ROWS: SessionProviderRegistry<AntigravityPayloads> = {
  anomaly: AntigravityAnomalyPart,
  toolCall: AntigravityToolCallRow
};

/**
 * Presents one coherent native snapshot through Cards-owned content and scrolling.
 * @param root0 - Native snapshot, matching semantic projection, and controlled disclosure state.
 * @param root0.source - Current SDK-store snapshot and liveness metadata.
 * @param root0.projection - Antigravity-native semantic rows, or null while projection is pending.
 * @param root0.disclosures - Stable controlled disclosure state owned by the expanded view.
 * @returns Header and the shared expanded transcript viewport.
 */
export function AntigravitySessionView({
  source,
  projection,
  disclosures
}: {
  source: NativeTranscriptSource;
  projection: SessionProjection<AntigravityPayloads> | null;
  disclosures: SessionDisclosureState;
}): ReactElement {
  const current =
    projection?.sourceKey === source.sourceKey && projection.generation === source.generation ? projection : null;
  const header = current?.header;
  const status = header?.status === 'done' ? 'success' : (header?.status ?? 'running');
  const rows = current?.rows ?? [];

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <SessionHeader model="" cwd="" status={status} />
      {source.error ? (
        <div className="session-tone--error" role="status">
          {source.error}
        </div>
      ) : null}
      <div className="flex-1 min-h-0">
        <SessionViewport
          ariaLabel="Antigravity session transcript"
          rows={rows}
          providerParts={ANTIGRAVITY_PARTS}
          providerRows={ANTIGRAVITY_ROWS}
          disclosures={disclosures}
          emptyContent={
            <p className="session-muted">
              {source.isLoading ? 'Loading transcript…' : 'No Antigravity session activity yet.'}
            </p>
          }
        />
      </div>
    </div>
  );
}

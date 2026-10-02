/**
 * OpenCode provider parts render inside Cards-owned rows with controlled details and shared leaf state.
 * @summary OpenCode semantic row, part, and tool presentation
 * @module streams/opencode-session/www/components/expanded/OpencodePresentation
 */

import { Fragment, type ReactElement } from 'react';
import {
  BoundedText,
  type ProviderPresentationProps,
  SessionDisclosure,
  type SessionProviderRegistry,
  type SessionRenderContext
} from '../../../../lib/session/SessionContent';
import type { SessionLeaf, SessionToolPart } from '../../../../lib/session/types';
import { type OpencodeNativeUpdates, opencodeNativeUpdateEntries } from '../../lib/native-updates';
import type {
  OpencodeAttachmentData,
  OpencodeEditedFilesData,
  OpencodeEventData,
  OpencodeMessageDetailsData,
  OpencodeNativeDetailsData,
  OpencodePayloads,
  OpencodeRow,
  OpencodeSessionData,
  OpencodeStepData
} from '../../lib/project-session';

/** Derives a path basename without exposing workspace directories in the edited-files summary.
 * @param path - Native absolute or relative path.
 * @returns The final path component.
 */
function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** Displays valid millisecond epochs consistently and leaves unsupported values inspectable.
 * @param value - Native epoch value in milliseconds.
 * @returns ISO timestamp or the original numeric value as text.
 */
function timestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Expands original JSONL strings only inside an opened native-details disclosure.
 * @param root0 - Source-backed native line chain and bounded page context.
 * @param root0.nativeUpdates - Immutable chain retaining original source lines.
 * @param root0.id - Semantic leaf owning independent inspection page slots.
 * @param root0.context - Shared Cards layout notifications.
 * @returns One pageable Cards text inspector per original source update.
 */
function NativeUpdatesContent({
  nativeUpdates,
  id,
  context
}: {
  nativeUpdates: OpencodeNativeUpdates;
  id: string;
  context: SessionRenderContext;
}): ReactElement {
  const updates = opencodeNativeUpdateEntries(nativeUpdates);
  return (
    <>
      {updates.map((update, index) => (
        <Fragment key={`${id}-line-${update.lineNumber}`}>
          {updates.length > 1 ? (
            <div className="session-label">
              Update {index + 1} of {updates.length}
            </div>
          ) : null}
          <BoundedText text={update.line} id={id} context={context} slot={`native-${update.lineNumber}`} />
        </Fragment>
      ))}
    </>
  );
}

/** Controlled tool body keeps status, input, result, errors, and provider-native details visible.
 * @param root0 - Shared tool leaf and disclosure context.
 * @param root0.part - OpenCode semantic tool lifecycle leaf.
 * @param root0.leaf - Stable disclosure identity and physical provenance.
 * @param root0.context - Caller-owned disclosure state and layout hooks.
 * @returns OpenCode tool body with bounded input, result, and native details.
 */
export function OpenCodeTool({
  part,
  leaf,
  context
}: {
  part: SessionToolPart;
  leaf: SessionLeaf;
  context: SessionRenderContext;
}): ReactElement {
  const status =
    part.status === 'complete'
      ? 'completed'
      : part.status === 'error'
        ? 'failed'
        : part.status === 'orphan'
          ? 'unknown state'
          : part.status;
  return (
    <div className={part.status === 'error' ? 'session-tone--error' : undefined}>
      <SessionDisclosure id={leaf.id} label={`${part.name} · ${status}`} context={context}>
        <div className="session-label">Input</div>
        <BoundedText text={part.input} id={leaf.id} context={context} slot="input" />
        {part.output !== undefined ? (
          <>
            <div className="session-label">{part.status === 'error' ? 'Error / result' : 'Result'}</div>
            <BoundedText text={part.output} id={leaf.id} context={context} slot="result" />
          </>
        ) : null}
      </SessionDisclosure>
    </div>
  );
}

/** Presents message timing and model metadata while retaining the exact native info record.
 * @param root0 - Typed message metadata and controlled disclosure context.
 * @param root0.data - Projected OpenCode message info fields.
 * @param root0.leaf - Stable identity and provenance for this message record.
 * @returns Message metadata disclosure.
 */
function MessageDetails({
  data,
  leaf,
  ...context
}: ProviderPresentationProps<OpencodeMessageDetailsData>): ReactElement {
  const created = timestamp(data.created);
  const completed = timestamp(data.completed);
  const timeLabel = created ? ` · ${created}` : '';
  return (
    <SessionDisclosure id={leaf.id} label={`Message details${timeLabel}`} context={context}>
      <div className="session-label">Message {data.messageId}</div>
      <div>Role: {data.role}</div>
      {data.model ? <div>Model: {data.model}</div> : null}
      {data.provider ? <div>Provider: {data.provider}</div> : null}
      {data.agent ? <div>Agent: {data.agent}</div> : null}
      {data.mode ? <div>Mode: {data.mode}</div> : null}
      {data.cwd ? <div>Working directory: {data.cwd}</div> : null}
      {created ? (
        <div>
          Started: <time dateTime={created}>{created}</time>
        </div>
      ) : null}
      {completed ? (
        <div>
          Completed: <time dateTime={completed}>{completed}</time>
        </div>
      ) : null}
      {data.tokens ? (
        <div>
          Tokens: {data.tokens.input ?? 0} input · {data.tokens.output ?? 0} output
        </div>
      ) : null}
      <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
    </SessionDisclosure>
  );
}

/** Session metadata is a provider row rather than an invented conversation message.
 * @param root0 - Typed session metadata and controlled disclosure context.
 * @param root0.data - Merged native session metadata.
 * @param root0.leaf - Stable identity and provenance for the metadata row.
 * @returns Session metadata summary and disclosure.
 */
function SessionDetails({ data, leaf, ...context }: ProviderPresentationProps<OpencodeSessionData>): ReactElement {
  const version = data.version ?? data.runtime ?? 'OpenCode';
  return (
    <div>
      <div className="session-label">OpenCode session · {version}</div>
      <SessionDisclosure id={leaf.id} label="Session metadata" context={context}>
        {data.sessionId ? <div>Session ID: {data.sessionId}</div> : null}
        {data.runtime ? <div>Runtime: {data.runtime}</div> : null}
        {data.version ? <div>Version: {data.version}</div> : null}
        <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
      </SessionDisclosure>
    </div>
  );
}

/** File parts show a safe filename/MIME summary and keep their native URL inert in bounded details.
 * @param root0 - Typed attachment details and controlled disclosure context.
 * @param root0.data - Safe file summary and preserved native JSON.
 * @param root0.leaf - Stable identity and provenance for the file part.
 * @returns Attachment summary with inert raw details.
 */
function Attachment({ data, leaf, ...context }: ProviderPresentationProps<OpencodeAttachmentData>): ReactElement {
  return (
    <div className="session-attachment">
      <span className="session-label">{data.filename}</span>
      {data.mime ? <span className="session-muted">{data.mime}</span> : null}
      <SessionDisclosure id={leaf.id} label="Attachment details" context={context}>
        <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
      </SessionDisclosure>
    </div>
  );
}

/** Shows safe edited-file basenames while keeping hashes and full patch payloads inspectable.
 * @param root0 - Typed patch summary and controlled disclosure context.
 * @param root0.data - Edited file paths, change hash, and native JSON.
 * @param root0.leaf - Stable identity and provenance for the patch part.
 * @returns Visible basename list with an inspectable patch disclosure.
 */
function EditedFiles({ data, leaf, ...context }: ProviderPresentationProps<OpencodeEditedFilesData>): ReactElement {
  const title = data.files.length === 1 ? `${basename(data.files[0]!)} edited` : `Edited ${data.files.length} files`;
  return (
    <div>
      <div className="session-label">{title}</div>
      {data.files.map((file) => (
        <div key={file} className="session-muted">
          {basename(file)}
        </div>
      ))}
      <SessionDisclosure id={leaf.id} label="Patch details" context={context}>
        {data.hash ? <div className="session-muted">Change set {data.hash}</div> : null}
        <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
      </SessionDisclosure>
    </div>
  );
}

/** Step markers stay visibly structural and expose the full native boundary record on demand.
 * @param root0 - Typed step marker and controlled disclosure context.
 * @param root0.data - Native step type, label, and raw JSON.
 * @param root0.leaf - Stable identity and provenance for the step part.
 * @returns Visible step boundary disclosure.
 */
function Step({ data, leaf, ...context }: ProviderPresentationProps<OpencodeStepData>): ReactElement {
  return (
    <SessionDisclosure id={leaf.id} label={data.label} context={context}>
      <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
    </SessionDisclosure>
  );
}

/** Unknown native content remains visible and safely inspectable as inert text.
 * @param root0 - Typed event record and controlled disclosure context.
 * @param root0.data - Display label, tone, and retained native JSON.
 * @param root0.leaf - Stable identity and provenance for the event part.
 * @returns Inert, inspectable native event content.
 */
function Event({ data, leaf, ...context }: ProviderPresentationProps<OpencodeEventData>): ReactElement {
  return (
    <div className={data.tone === 'error' ? 'session-tone--error' : undefined}>
      <SessionDisclosure id={leaf.id} label={data.label} context={context}>
        <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
      </SessionDisclosure>
    </div>
  );
}

/** Presents part updates as independent bounded raw inspectors.
 * @param root0 - Typed native-details payload and its controlled disclosure context.
 * @param root0.data - Human label and immutable native update chain.
 * @param root0.leaf - Stable provider identity and provenance.
 * @returns Lazy native update disclosure.
 */
function NativeDetails({ data, leaf, ...context }: ProviderPresentationProps<OpencodeNativeDetailsData>): ReactElement {
  return (
    <SessionDisclosure id={leaf.id} label={data.label} context={context}>
      <NativeUpdatesContent nativeUpdates={data.nativeUpdates} id={leaf.id} context={context} />
    </SessionDisclosure>
  );
}

/** Shared typed renderers work for native rows or parts; absent kinds are never guessed. */
export const OPENCODE_PRESENTATION: SessionProviderRegistry<OpencodePayloads> = {
  session: { render: (props) => <SessionDetails {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  messageDetails: { render: (props) => <MessageDetails {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  attachment: { render: (props) => <Attachment {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  editedFiles: { render: (props) => <EditedFiles {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  step: { render: (props) => <Step {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  event: { render: (props) => <Event {...props} />, disclosureKeys: (leaf) => [leaf.id] },
  nativeDetails: { render: (props) => <NativeDetails {...props} />, disclosureKeys: (leaf) => [leaf.id] }
};

/** Collects row and part ids so controlled disclosures survive source appends.
 * @param rows - Current semantic rows from OpenCode's projection.
 * @returns Every current row and part identity.
 */
export function opencodeDisclosureIds(rows: readonly OpencodeRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.id);
    for (const part of row.parts) ids.add(part.id);
  }
  return ids;
}

/** Reads OpenCode's sticky header additions from provider rows and message-details parts.
 * @param rows - Current semantic rows from OpenCode's projection.
 * @returns Provider and session identity when the native source supplied them.
 */
export function opencodeHeaderDisplay(rows: readonly OpencodeRow[]): { provider?: string; sessionId?: string } {
  let provider: string | undefined;
  let sessionId: string | undefined;
  for (const row of rows) {
    if (row.kind === 'provider' && row.providerKind === 'session') sessionId = row.data.sessionId ?? sessionId;
    for (const part of row.parts) {
      if (part.kind === 'provider' && part.providerKind === 'messageDetails' && part.data.provider)
        provider = part.data.provider;
    }
  }
  return { provider, sessionId };
}

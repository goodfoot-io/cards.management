/**
 * Session renderer store and host/renderer bridge protocol.
 *
 * Side-effect free: hosts import the message types and validators, renderers
 * call {@link getWindowStreamStore} to bind to `window.__STREAM_INIT__`.
 *
 * @summary Stream store barrel export
 * @module stream-store
 */

export { createDiagnosticLimiter, type DiagnosticLimiter } from './limit.js';
export { createStreamStore, getWindowStreamStore } from './store.js';
export type {
  CloseMessage,
  ConnectionStateMessage,
  HostToRendererMessage,
  LayoutAnchorMessage,
  LayoutHandshakeMessage,
  LayoutPayload,
  LayoutReadyMessage,
  LayoutRendererMessage,
  LayoutScrollCommand,
  LayoutScrollMessage,
  LayoutSizeMessage,
  MessageValidation,
  OpenFileMessage,
  RendererDiagnosticMessage,
  RendererToHostMessage,
  SessionResyncMessage,
  SessionUpdateMessage,
  ShowDiffMessage,
  SourceAppendMessage,
  SourceErrorMessage,
  SourceInvalidatedMessage,
  SourceLifecycleMessage,
  SourceSnapshotMessage,
  SourceStatusMessage,
  SourceSubscribeMessage,
  SourceUnsubscribeMessage,
  StreamConnectionState,
  StreamDisplayMode,
  StreamHistoryMode,
  StreamInitData,
  StreamRendererStore,
  StreamSourceAuthorityStamp,
  StreamSourceInvalidationReason,
  StreamSourceLoadError,
  StreamSourceStatus,
  StreamSourceView,
  StreamStoreDiagnostic,
  StreamStoreOptions,
  StreamStoreState,
  StreamViewState,
  ThemeChangeMessage,
  ViewStateMessage
} from './types.js';
export {
  DIAGNOSTIC_REASON_PATTERN,
  MAX_APPEND_LINES,
  MAX_LAYOUT_HEIGHT,
  MAX_SCROLL_DELTA,
  MAX_TOKEN_LENGTH,
  MAX_VIEW_STATE_ENTRIES,
  MAX_VIEW_STATE_KEY_LENGTH,
  TAIL_HISTORY_LINES
} from './types.js';
export { validateHostMessage, validateRendererMessage, validateViewState } from './validate.js';

/**
 * Session renderer store and host/renderer bridge protocol.
 *
 * Side-effect free: hosts import the message types and validators, renderers
 * call {@link getWindowStreamStore} to bind to `window.__STREAM_INIT__`.
 *
 * @summary Stream store barrel export
 * @module stream-store
 */

export { createStreamStore, getWindowStreamStore } from './store.js';
export type {
  CloseMessage,
  ConnectionStateMessage,
  HostToRendererMessage,
  LayoutHandshakeMessage,
  LayoutPayload,
  LayoutReadyMessage,
  LayoutRendererMessage,
  LayoutScrollCommand,
  LayoutScrollMessage,
  LayoutSizeMessage,
  MessageValidation,
  OpenFileMessage,
  RendererToHostMessage,
  SessionResyncMessage,
  SessionUpdateMessage,
  ShowDiffMessage,
  SourceAppendMessage,
  SourceErrorMessage,
  SourceInvalidatedMessage,
  SourceLifecycleMessage,
  SourceSnapshotMessage,
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
  ThemeChangeMessage
} from './types.js';
export {
  MAX_APPEND_LINES,
  MAX_LAYOUT_HEIGHT,
  MAX_PENDING_BYTES,
  MAX_PENDING_EVENTS,
  MAX_SCROLL_DELTA,
  MAX_TOKEN_LENGTH,
  TAIL_HISTORY_LINES
} from './types.js';
export { validateHostMessage, validateRendererMessage } from './validate.js';

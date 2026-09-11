/**
 * `PreInvocation` hook entry — emitted as `bin/runtime-pre-invocation.mjs`.
 *
 * Runs the Antigravity session-start sequence over the shared runtime
 * behaviors: input validation, reconciliation, action-env extraction, card
 * context readiness, session registration, and stream-sync-watcher setup.
 * The Assistant path also records the conversation-scoped ready marker; an
 * action session's success is its exit status.
 *
 * @summary PreInvocation entry for the Antigravity runtime plugin
 * @module runtime/runtime-pre-invocation
 */

import { handlePreInvocation } from '../internal/handlers.js';
import { main } from '../internal/transport.js';

export { handlePreInvocation };

main(handlePreInvocation);

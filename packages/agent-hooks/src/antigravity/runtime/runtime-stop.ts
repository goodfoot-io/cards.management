/**
 * `Stop` hook entry — emitted as `bin/runtime-stop.mjs`.
 *
 * Runs the call-scoped drain and cleanup: the pending-shutdown handshake
 * under the strict fail-closed idle authority, the transcript-watcher flush
 * sentinel, session artifact cleanup — then records drain readiness.
 * Idempotent by contract; never emits a `continue` decision.
 *
 * @summary Stop entry for the Antigravity runtime plugin
 * @module runtime/runtime-stop
 */

import { handleStop } from '../internal/handlers.js';
import { main } from '../internal/transport.js';

export { handleStop };

main(handleStop);

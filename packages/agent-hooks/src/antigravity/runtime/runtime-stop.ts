/**
 * `Stop` hook entry — emitted as `bin/runtime-stop.mjs`.
 *
 * Runs the call-scoped drain and cleanup: the pending-shutdown handshake
 * under the strict fail-closed idle authority, the transcript-watcher flush
 * sentinel, and session artifact cleanup. Idempotent by contract; never emits
 * a `continue` decision, and reports through its exit status.
 *
 * @summary Stop entry for the Antigravity runtime plugin
 * @module runtime/runtime-stop
 */

import { handleStop } from '../internal/handlers.js';
import { main } from '../internal/transport.js';

export { handleStop };

main(handleStop);

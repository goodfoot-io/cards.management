/**
 * `PostInvocation` hook entry — emitted as `bin/runtime-post-invocation.mjs`.
 *
 * Runs the shared idle/route/merge/shutdown decision once per invocation,
 * injecting an ephemeral step only when another model step is required. The
 * injected step is the whole record of a route; an idle turn writes nothing.
 *
 * @summary PostInvocation entry for the Antigravity runtime plugin
 * @module runtime/runtime-post-invocation
 */

import { handlePostInvocation } from '../internal/handlers.js';
import { main } from '../internal/transport.js';

export { handlePostInvocation };

main(handlePostInvocation);

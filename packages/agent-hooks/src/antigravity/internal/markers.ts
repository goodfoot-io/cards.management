/**
 * Conversation-scoped runtime marker store for the Antigravity `runtime` hooks.
 *
 * The Antigravity adapter is a set of one-shot subprocesses: unlike the
 * OpenCode plugins, no state survives between hook invocations, so the
 * launcher-facing protocol lives entirely on disk. Every handler terminates
 * its conversation's protocol in exactly one durable marker:
 *
 * | Marker | Written by | Meaning |
 * |---|---|---|
 * | `ready` | PreInvocation | Registration, card context, and watcher setup succeeded; the launcher may proceed. |
 * | `failure` | any handler | The contract failed at `stage` with `reason`; the launcher must fail the action. |
 * | `route` | PostInvocation | A route step was injected this session (`merge` or `shutdown`). |
 * | `idle` | PostInvocation | The decision machinery ran and required no next step. |
 * | `drain-ready` | Stop | Idempotent cleanup finished; the launcher may settle. |
 *
 * Markers live under `<cards-config-dir>/antigravity/runtime/markers/`, keyed
 * first by the Cards session id the launcher exported pre-spawn (the launcher
 * knows it without parsing host storage), then by the host conversation id.
 * When an input is too broken to carry a conversation id (or the session env
 * is missing), the marker lands under the `unattributed`/`unknown-conversation`
 * placeholders instead of being dropped — a failure the launcher cannot see is
 * a failure that hangs until timeout.
 *
 * @summary Conversation-scoped marker store for the Antigravity runtime hooks
 * @module internal/markers
 */

import { join } from 'node:path';
import type { AntigravityIo } from './io.js';

/** The five runtime marker kinds. */
export type RuntimeMarkerKind = 'ready' | 'failure' | 'route' | 'idle' | 'drain-ready';

/** Placeholder for a marker whose input carried no conversation id. */
export const UNKNOWN_CONVERSATION = 'unknown-conversation';

/** Placeholder directory for markers whose session identity could not be resolved. */
export const UNATTRIBUTED_SESSION = 'unattributed';

/** Payload of the `ready` marker: the durable session ↔ conversation mapping. */
export interface ReadyMarkerPayload {
  /** Host conversation id the marker is scoped to. */
  conversationId: string;
  /** Cards session id the launcher exported pre-spawn. */
  sessionId: string;
  /** Canonical conversation DB path registered and watched for the session. */
  transcriptPath: string;
  /** Model name reported by the host. */
  modelName: string;
}

/** Why a handler wrote the `failure` marker. */
export interface FailureMarkerPayload {
  /** Contract stage the failure occurred at (e.g. `input`, `watcher-setup`). */
  stage: string;
  /** Human-readable reason the launcher surfaces. */
  reason: string;
}

/** Which route a `route` marker records as already injected. */
export interface RouteMarkerPayload {
  /** Which route was injected this session. */
  kind: 'merge' | 'shutdown';
}

/**
 * Resolves the absolute path of one conversation-scoped marker.
 *
 * @param cardsConfigDir - The Cards global configuration directory.
 * @param sessionId - Cards session id, or `null` when unresolvable (the
 *   marker lands under the {@link UNATTRIBUTED_SESSION} directory).
 * @param conversationId - Host conversation id, or `null` when the input
 *   carried none (the {@link UNKNOWN_CONVERSATION} placeholder is used).
 * @param kind - Marker kind, used as the file extension.
 * @returns Absolute marker path
 *   `<cardsConfigDir>/antigravity/runtime/markers/<sessionId>/<conversationId>.<kind>`.
 */
export function markerPath(
  cardsConfigDir: string,
  sessionId: string | null,
  conversationId: string | null,
  kind: RuntimeMarkerKind
): string {
  return join(
    cardsConfigDir,
    'antigravity',
    'runtime',
    'markers',
    sessionId ?? UNATTRIBUTED_SESSION,
    `${conversationId ?? UNKNOWN_CONVERSATION}.${kind}`
  );
}

/**
 * Writes one marker file, creating its session directory on demand.
 *
 * @param io - Filesystem seam.
 * @param path - Absolute marker path from {@link markerPath}.
 * @param payload - JSON payload to persist; omit for an empty marker.
 * @throws When the directory cannot be created or the file cannot be written.
 */
export function writeMarker(io: AntigravityIo, path: string, payload?: object): void {
  io.ensureDirSync(join(path, '..'));
  io.writeTextFileSync(path, payload === undefined ? '' : `${JSON.stringify(payload, null, 2)}\n`);
}

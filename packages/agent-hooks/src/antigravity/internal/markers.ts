/**
 * Conversation-scoped runtime marker store for the Antigravity `runtime` hooks.
 *
 * The Antigravity adapter is a set of one-shot subprocesses: unlike the
 * OpenCode plugins, no state survives between hook invocations, so the
 * launcher-facing protocol lives entirely on disk. One durable marker
 * survives; the proof markers (`ready`, `route`, `idle`, `drain-ready`) are
 * retired, because an action's outcome rides the native exit status and the
 * bounded stderr latch, and positive launcher-written proof was never what
 * the launcher needed to learn:
 *
 * | Marker | Written by | Meaning |
 * |---|---|---|
 * | `failure` | any handler | The contract failed at `stage` with `reason`; the launcher must fail the action. |
 *
 * `failure` is the one marker the native process cannot replace: a failing
 * hook leaves `agy` exiting 0 with an empty stderr and a `SUCCESS` record, so
 * the marker is that class's only channel. It is read at close on both paths —
 * the action's outcome gate and the Assistant's window-owned lifecycle.
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

/** The runtime marker kinds. */
export type RuntimeMarkerKind = 'failure';

/** Placeholder for a marker whose input carried no conversation id. */
export const UNKNOWN_CONVERSATION = 'unknown-conversation';

/** Placeholder directory for markers whose session identity could not be resolved. */
export const UNATTRIBUTED_SESSION = 'unattributed';

/** Why a handler wrote the `failure` marker. */
export interface FailureMarkerPayload {
  /** Contract stage the failure occurred at (e.g. `input`, `watcher-setup`). */
  stage: string;
  /** Human-readable reason the launcher surfaces. */
  reason: string;
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

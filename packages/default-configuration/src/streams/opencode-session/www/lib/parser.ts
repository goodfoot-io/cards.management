/**
 * Defensive parser for the Cards OpenCode transcript NDJSON lines.
 *
 * The Cards runtime plugin materializes the session transcript (OpenCode
 * stores sessions in SQLite with no tailable native transcript, as observed
 * on v1.18.21) by appending one normalized envelope per line:
 *
 * ```
 * {"v":1,"ts":"<iso>","seq":<n>,"sessionId":"<id>","type":"meta"|"message"|"part"|"idle","data":{…}}
 * ```
 *
 * - `meta` — written at session start (and again on every resume): `{runtime, opencodeVersion}`.
 * - `message` — the OpenCode message info record from `message.updated`
 *   (role, model/provider ids, timestamps; no content).
 * - `part` — an OpenCode message part from `message.part.updated`
 *   (`text` / `reasoning` / `tool` / structural variants).
 * - `idle` — written when the bus reports `session.idle`: the session's turn
 *   loop ended. Payload is empty; the envelope timestamp is the marker.
 *
 * All nested shapes are modeled defensively: unknown part types and unknown
 * fields are preserved as raw fallbacks rather than rejected. Malformed JSON —
 * including a torn trailing line left by a crash mid-append or a reader racing
 * an in-progress write — parses to `{kind: 'malformed'}` without throwing so
 * the rest of the transcript survives.
 *
 * @summary Parses a Cards OpenCode transcript NDJSON line into a discriminated union
 * @module streams/opencode-session/www/lib/parser
 */

/**
 * Tool execution state carried by a `tool` part (OpenCode `ToolState` tagged
 * union). Only the display-relevant fields are read; everything else is
 * preserved under the open index signature.
 */
export interface OpencodeToolState {
  status?: 'pending' | 'running' | 'completed' | 'error' | string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/** An OpenCode message part (`message.part.updated.properties.part`). */
export interface OpencodePart {
  type?: string;
  id?: string;
  /** `text` / `reasoning` parts: the content. */
  text?: string;
  /** `tool` parts: the tool name and call id. */
  tool?: string;
  name?: string;
  callID?: string;
  state?: OpencodeToolState;
  time?: { end?: number; created?: number; completed?: number; [key: string]: unknown };
  /** `patch` parts (v1.18.22): absolute paths of the files changed by this step. */
  files?: string[];
  /** `patch` parts: content hash of the change set. */
  hash?: string;
  /** `file` parts (prompt attachments): display filename. */
  filename?: string;
  /** `file` parts: MIME type, when OpenCode reports one. */
  mime?: string;
  /** `file` parts: `data:`/`file:` URL carrying or locating the content. */
  url?: string;
  [key: string]: unknown;
}

/** An OpenCode message info record (`message.updated.properties.info`). */
export interface OpencodeMessageInfo {
  id?: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  /**
   * User messages nest the model selection under `model` while assistant
   * messages carry flat `modelID`/`providerID` (verified against v1.18.22).
   */
  model?: { providerID?: string; modelID?: string };
  agent?: string;
  mode?: string;
  path?: { cwd?: string; root?: string; [key: string]: unknown };
  time?: { created?: number; completed?: number; [key: string]: unknown };
  tokens?: { input?: number; output?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/** Session metadata payload of a `meta` line, written once at session start. */
export interface OpencodeSessionMeta {
  runtime?: string;
  opencodeVersion?: string;
  [key: string]: unknown;
}

/**
 * Result of parsing a single transcript NDJSON line.
 *
 * Known kinds carry the envelope's `ts`/`seq`/`sessionId` values; `ts` is `''`
 * and `seq` is `0` when absent or mistyped. The `unknown` member carries an
 * unrecognized-but-valid root envelope.
 */
export type OpencodeLine =
  | { kind: 'meta'; ts: string; seq: number; sessionId: string; data: OpencodeSessionMeta }
  | { kind: 'message'; ts: string; seq: number; sessionId: string; data: OpencodeMessageInfo }
  | { kind: 'part'; ts: string; seq: number; sessionId: string; data: OpencodePart }
  | { kind: 'idle'; ts: string; seq: number; sessionId: string }
  | { kind: 'unknown'; ts?: string; raw: Record<string, unknown> }
  | { kind: 'malformed'; raw: string };

/**
 * Parses one raw transcript NDJSON line into an {@link OpencodeLine}.
 *
 * Validates the root `{v, ts, seq, sessionId, type, data}` envelope without
 * asserting any nested `data` shape beyond it being an object when present.
 * Invalid JSON or an unusable envelope yields `{kind: 'malformed', raw}`; a
 * valid envelope with an unrecognized `type` yields `{kind: 'unknown', raw}`.
 * A torn trailing line (truncated JSON) therefore lands on `malformed`, never
 * throws.
 *
 * @param raw - A single line of transcript NDJSON.
 * @returns The discriminated parse result.
 */
export function parseOpencodeLine(raw: string): OpencodeLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed', raw };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', raw };
  }

  const envelope = parsed as Record<string, unknown>;
  const type = typeof envelope['type'] === 'string' ? envelope['type'] : undefined;

  const ts = typeof envelope['ts'] === 'string' ? envelope['ts'] : '';
  const seq = typeof envelope['seq'] === 'number' ? envelope['seq'] : 0;
  const sessionId = typeof envelope['sessionId'] === 'string' ? envelope['sessionId'] : '';

  switch (type) {
    case 'meta':
      return {
        kind: 'meta',
        ts,
        seq,
        sessionId,
        data: (typeof envelope['data'] === 'object' && envelope['data'] !== null
          ? envelope['data']
          : {}) as OpencodeSessionMeta
      };
    case 'message':
      return {
        kind: 'message',
        ts,
        seq,
        sessionId,
        data: (typeof envelope['data'] === 'object' && envelope['data'] !== null
          ? envelope['data']
          : {}) as OpencodeMessageInfo
      };
    case 'part':
      return {
        kind: 'part',
        ts,
        seq,
        sessionId,
        data: (typeof envelope['data'] === 'object' && envelope['data'] !== null
          ? envelope['data']
          : {}) as OpencodePart
      };
    case 'idle':
      // The payload is empty by contract; only the envelope timestamp matters.
      return { kind: 'idle', ts, seq, sessionId };
    default:
      return { kind: 'unknown', ts: ts || undefined, raw: envelope };
  }
}

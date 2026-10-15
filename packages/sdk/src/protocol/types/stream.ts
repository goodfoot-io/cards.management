/**
 * Stream protocol types for JSONL streaming.
 *
 * A stream is an append-only JSONL file attached to a card, synced into
 * `streams/{streamType}/{relPath}` (where `relPath` may contain multiple
 * forward-slash-separated segments) by the transcript-sync engine, and
 * broadcast over WebSocket in real time. An iframe-based renderer (served from
 * the stream definition's `wwwRoot` directory) displays stream content in the
 * extension UI. Metadata lives in a sibling `.meta.json` file and is committed
 * to the card repository at stream creation and close.
 *
 *
 * @summary Stream protocol types for JSONL streaming
 * @module types/stream
 */

// --- Attachment Info ---

/**
 * File-persisted metadata for a card attachment.
 *
 * Stored in the card's attachment metadata sidecar.
 * Timestamps (`createdAt`) are derived from Git history at read time
 * and not persisted in the JSON file.
 *
 * @see AttachmentInfo for the API shape that includes computed timestamps.
 *
 * @example
 * ```typescript
 * const attachmentFile: AttachmentInfoFile = {
 *   id: 'screenshot-2024-01-15.png',
 *   name: 'screenshot-2024-01-15.png',
 *   originalName: 'Screenshot 2024-01-15 at 10.30.00.png',
 *   size: 1024000,
 *   mimeType: 'image/png'
 * };
 * ```
 */
export interface AttachmentInfoFile {
  /** Stable identifier for the attachment. Used in attachment URLs and references. */
  id: string;

  /** Display name for the attachment. */
  name: string;

  /** Original filename as provided by the client during upload. */
  originalName: string;

  /** File size in bytes. */
  size: number;

  /** MIME type of the attachment. */
  mimeType: string;

  /** Optional human-readable context about what the attachment contains or why it was added. */
  description?: string;
}

/**
 * File-persisted metadata for a single stream.
 *
 * Stored as `streams/{streamType}/{relPath}.meta.json` inside the card directory,
 * where `relPath` mirrors the source-relative path (forward slashes, may contain
 * multiple segments, e.g. `<sessionId>/subagents/foo.jsonl`) that the transcript-sync
 * engine's {@link SessionSyncManifest} (see `transcript-sync/manifest.ts`) declared
 * for the source file. This represents the static file fields only. Active/committed
 * state is derived at read time from whether the sidecar is present in git HEAD
 * versus arriving via a live `stream:started` event.
 *
 * Dual-writer contract: the transcript-sync watcher creates this sidecar (all
 * fields except `lineCount`) at first encounter of a new stream file; the server
 * ({@link StreamFileWatcher}) subsequently appends/updates `lineCount` (and, best
 * effort, `slug`/`taskContent`) as lines are tailed, and finalizes it at stream
 * close. No other writer touches this file after creation.
 *
 * @see StreamDefinition for the environment-level configuration that governs
 *   rendering for a given `streamType`.
 * @see StreamMeta for the API shape that includes lifecycle status and timestamps.
 */
export interface StreamMetaFile {
  /** Sidecar schema version. Currently always `1`. */
  version: 1;

  /**
   * Source-relative path (forward slashes) identifying this stream within its
   * `streamType` directory. May contain multiple segments (e.g.
   * `<sessionId>/subagents/foo.jsonl`). Unique within a card's `streams/{streamType}/`
   * directory. Replaces the old flat `filename` field.
   */
  relPath: string;

  /** Stream type key that maps to a {@link StreamDefinition} in the environment config. */
  streamType: string;

  /** Open runtime identifier that produced this stream, e.g. `'claude-code'` or `'codex'`. */
  runtime: string;

  /** Session identifier for grouping related streams (main + subagents) together. */
  sessionId: string;

  /** Role of this stream's source file within its session's transcript set. */
  role: 'main' | 'subagent' | 'auxiliary';

  /**
   * Agent identifier for subagent/auxiliary streams. Absent for `role: 'main'`
   * streams, which have no sub-identity beyond the session.
   */
  agentId?: string;

  /** Human-readable title for UI display. */
  title?: string;

  /** Absolute filesystem path of the source file this stream was synced from. */
  sourcePath: string;

  /** ISO 8601 timestamp when the transcript-sync watcher first began syncing this stream. */
  startedAt: string;

  /**
   * First ~40 characters of `message.content` from line 1 of the JSONL stream, stripped
   * of any `<teammate-message>` XML wrapper. Populated lazily for subagents and team
   * members once the first line is processed; absent for orchestrators (whose first line
   * is a progress event with no user message) and until the first line arrives.
   */
  taskContent?: string;

  /**
   * Human-readable slug derived from the first matching JSONL line after the stream is
   * processed. Populated lazily once a suitable line is found; absent until then and for
   * streams that never produce a matching line.
   */
  slug?: string;

  /** Number of lines appended so far. Updated in-memory on each append; persisted on close. */
  lineCount: number;
}

/**
 * Persisted metadata for a single stream with lifecycle timestamps.
 *
 * This is the API shape used throughout the application. It extends
 * {@link StreamMetaFile} with `createdAt` (derived from git history) and
 * `isActive` — the boolean source of truth for live vs. historical mode.
 *
 * `isActive` is `true` only when the stream has not yet been committed to git
 * (i.e. the panel learned about it from a live `stream:started` event). Once
 * the sidecar is committed and loaded from disk via the snapshot builder,
 * `isActive` is `false`. No timestamp equivalent of "closed at" is stored —
 * the previous `closedAt` field was never meaningful outside of display.
 *
 * @see StreamDefinition for the environment-level configuration that governs
 *   rendering for a given `streamType`.
 */
export interface StreamMeta extends StreamMetaFile {
  /** ISO-8601 timestamp when the stream was created. Derived from Git history. */
  createdAt: string;

  /**
   * `true` when the stream has not yet been committed to git (live append mode);
   * `false` when loaded from a committed `.meta.json` sidecar (historical mode).
   */
  isActive: boolean;
}

/**
 * Environment-level configuration for a stream type.
 *
 * Declared under `environments.{name}.streams` in `settings.json`, keyed by
 * a lowercase-hyphenated type name (e.g., `"claude-session"`). Each definition
 * points to a static directory (`wwwRoot`) containing an iframe renderer and
 * sets size guardrails.
 *
 * @example
 * ```json
 * {
 *   "streams": {
 *     "claude-session": {
 *       "version": 1,
 *       "wwwRoot": "./renderers/claude-session",
 *       "entrypoint": "index.html",
 *       "maxLineLength": 1048576,
 *       "maxStreamSize": 104857600
 *     }
 *   }
 * }
 * ```
 */
export interface StreamDefinition {
  /** Schema version for forward compatibility. */
  version: number;

  /**
   * Path to the directory containing the iframe renderer's static assets.
   *
   * Relative paths resolve from the settings.json file location.
   */
  wwwRoot: string;

  /**
   * Entry point HTML file within the wwwRoot directory.
   *
   * Defaults to `"index.html"` when omitted.
   */
  entrypoint?: string;

  /** Maximum bytes per line before truncation (default 1 MB). Lines exceeding this are clipped with a `...[truncated]` suffix. */
  maxLineLength?: number;

  /** Maximum cumulative bytes per stream file before auto-close with `'size_limit'` status (default 100 MB). */
  maxStreamSize?: number;
}

/** Exact navigation identity of one provider session on one card. */
export interface StreamSessionRef {
  /** Owning card. */
  cardId: string;
  /** Provider stream type. */
  streamType: string;
  /** Authoritative session identity. */
  sessionId: string;
}

/** Exact identity of one native transcript source. */
export interface StreamSourceRef {
  /** Owning card. */
  cardId: string;
  /** Provider stream type. */
  streamType: string;
  /** Logical source-relative path. */
  relPath: string;
}

/** Server-owned source incarnation; ordinary appends preserve both epochs. */
export interface StreamSourceVersion {
  /** Changes on server restart. */
  serverEpoch: string;
  /** Changes on replacement, truncation, or routing metadata changes. */
  sourceEpoch: string;
}

/** Authoritative routing metadata accepted together with source bytes. */
export interface StreamSourceBinding {
  /** Session owning this version. */
  sessionId: string;
  /** Source role within that session. */
  role: 'main' | 'subagent' | 'auxiliary';
  /** Explicit provider agent identity when present. */
  agentId?: string;
}

/** Coherent snapshot of contiguous complete native lines, never a partial last line. */
export interface StreamSourceSnapshot {
  /** Exact source accepted by the server. */
  source: StreamSourceRef;
  /** Server-owned incarnation. */
  version: StreamSourceVersion;
  /** Routing identity accepted with this read. */
  binding: StreamSourceBinding;
  /** Source metadata from the same accepted read. */
  meta: StreamMeta;
  /** Unmodified native lines without newline delimiters. */
  lines: string[];
  /** One-based first coordinate; empty snapshots use totalLineCount + 1. */
  firstLineNumber: number;
  /** Number of complete lines in the coherent source read. */
  totalLineCount: number;
}

/** Inspectable source membership without provider transcript interpretation. */
export interface SessionMember {
  /** Exact native source identity. */
  source: StreamSourceRef;
  /** Authoritative membership role. */
  role: StreamSourceBinding['role'];
  /** Provider identity when supplied. */
  agentId?: string;
  /** Optional display title. */
  title?: string;
}

/** Deterministically ordered membership with no arbitrary main selection. */
export interface SessionDescriptor {
  /** Exact session tuple. */
  session: StreamSessionRef;
  /** Ordered by main, subagent, auxiliary, then source key. */
  members: SessionMember[];
  /** Non-null only when exactly one member is main. */
  main: StreamSourceRef | null;
  /** Explicit missing or conflicting main anomaly. */
  validity: 'ready' | 'missing-main' | 'conflicting-main';
}

/**
 * Full-pass reconciliation for the transcript-sync engine.
 *
 * Given a session's manifest, enumerates every file under `watchRoot`,
 * matches each against the manifest's sources (see `./matcher.ts`), and syncs
 * every matched file: `jsonl-tail` mode tails newline-complete lines (see
 * `./tailer.ts`); `copy` mode idempotently copies the whole file. A reconcile
 * pass is a cheap no-op for files with nothing new to sync, so it is safe to
 * run repeatedly — on a timer, on filesystem events, and to close the
 * install-time "arm gap" (see `./watch-installer.ts`).
 *
 * Per-file behavior:
 * - The sidecar (`<destPath>.meta.json`) is written once, on first successful
 *   sync of a file, using the full {@link StreamMetaFile} shape, and is never
 *   overwritten afterward.
 * - A shrink guard detects a source that has become smaller than the bytes
 *   already consumed from it (truncation, rewrite) and marks the file
 *   permanently failed — excluded from further syncing — rather than
 *   guessing at a new cursor.
 * - Per-file errors are warned-and-continued: one bad file does not abort the
 *   pass for the others. `ENOENT` on the source is tolerated as a filesystem
 *   race (the source may not exist yet, or a subagent file may have been
 *   removed).
 *
 * @summary Enumerate, match, and sync every source file in one pass
 * @module
 */

import { access, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { StreamMetaFile } from '../../protocol/types/stream.js';
import type { SessionSyncManifest, SourceSpec } from '../manifest.js';
import { matchSource } from './matcher.js';
import { type TailerCursor, tailAppend } from './tailer.js';

/**
 * Per-file sync state tracked across reconcile passes for the lifetime of a
 * watcher process. Doubles as the source of the per-file heartbeat payload
 * (see `./status.ts`).
 */
export interface FileSyncState {
  /** Path relative to `watchRoot`, forward-slashed. */
  relPath: string;
  /** Role from the matched {@link SourceSpec}. */
  role: SourceSpec['role'];
  /** Mode from the matched {@link SourceSpec}. */
  mode: SourceSpec['mode'];
  /** Tailer cursor; only meaningful for `mode: 'jsonl-tail'`. */
  cursor: TailerCursor;
  /** Last observed source file size, in bytes. */
  sourceBytes: number;
  /** Bytes consumed from the source so far (tail offset, or full size once copied). */
  consumedBytes: number;
  /** Epoch ms of the last successful sync, or `null` if never synced. */
  lastSyncAt: number | null;
  /** Set once this file is permanently excluded from syncing; the reason. */
  failed?: string;
  /** Whether the sidecar has been written for this file. */
  sidecarWritten: boolean;
}

/**
 * Performs full-pass reconciliation and tracks per-file sync state for one
 * session's manifest.
 */
export class Reconciler {
  private readonly files = new Map<string, FileSyncState>();
  private readonly destRoot: string;

  constructor(
    private readonly manifest: SessionSyncManifest,
    private readonly now: () => number = Date.now
  ) {
    this.destRoot = join(manifest.cardRepoPath, 'streams', manifest.streamType);
  }

  /**
   * Returns a snapshot of every tracked file's current sync state.
   *
   * @returns An array of the current {@link FileSyncState} for every file seen so far.
   */
  getFileStates(): FileSyncState[] {
    return [...this.files.values()];
  }

  /**
   * Returns the tracked state for a single relPath, if any.
   *
   * @param relPath - Path relative to `watchRoot`.
   * @returns The tracked {@link FileSyncState}, or `undefined` if `relPath` has not been seen yet.
   */
  getFileState(relPath: string): FileSyncState | undefined {
    return this.files.get(relPath);
  }

  /**
   * Seeds a file's cursor and consumed-bytes accounting without performing a
   * sync — used by restart recovery (see `./recovery.ts`) to resume from a
   * pre-existing destination file's recovered offset instead of re-tailing
   * from zero.
   *
   * @param relPath - Path relative to `watchRoot`.
   * @param spec - The matched source spec for `relPath`.
   * @param cursor - The recovered byte offset to resume from.
   */
  seedRecoveredCursor(relPath: string, spec: SourceSpec, cursor: number): void {
    this.files.set(relPath, {
      relPath,
      role: spec.role,
      mode: spec.mode,
      cursor: { offset: cursor, pendingFragment: '' },
      sourceBytes: cursor,
      consumedBytes: cursor,
      lastSyncAt: null,
      sidecarWritten: true, // pre-existing destination implies the sidecar already exists
      failed: undefined
    });
  }

  /**
   * Marks a file permanently failed without attempting to sync it — used when
   * restart recovery cannot establish a trustworthy cursor for a pre-existing
   * destination file.
   *
   * @param relPath - Path relative to `watchRoot`.
   * @param spec - The matched source spec for `relPath`.
   * @param reason - Human-readable failure reason.
   */
  markFailed(relPath: string, spec: SourceSpec, reason: string): void {
    this.files.set(relPath, {
      relPath,
      role: spec.role,
      mode: spec.mode,
      cursor: { offset: 0, pendingFragment: '' },
      sourceBytes: 0,
      consumedBytes: 0,
      lastSyncAt: null,
      sidecarWritten: false,
      failed: reason
    });
  }

  /**
   * Runs one full reconcile pass: enumerate `watchRoot`, match against the
   * manifest's sources, and sync every matched file.
   *
   * @param warnFn - Called with a message for each per-file error.
   * @param errorFn - Called with a message when a file is newly marked failed.
   */
  async reconcileOnce(warnFn: (message: string) => void, errorFn: (message: string) => void): Promise<void> {
    let relPaths: string[];
    try {
      relPaths = await enumerateFiles(this.manifest.watchRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const relPath of relPaths) {
      const spec = matchSource(relPath, this.manifest.sources);
      if (!spec) continue;

      let state = this.files.get(relPath);
      if (!state) {
        state = {
          relPath,
          role: spec.role,
          mode: spec.mode,
          cursor: { offset: 0, pendingFragment: '' },
          sourceBytes: 0,
          consumedBytes: 0,
          lastSyncAt: null,
          sidecarWritten: false
        };
        this.files.set(relPath, state);
      }

      if (state.failed) continue;

      try {
        await this.syncFile(relPath, spec, state, errorFn);
      } catch (error) {
        warnFn(`reconciler: error syncing "${relPath}": ${String(error)}`);
      }
    }
  }

  private async syncFile(
    relPath: string,
    spec: SourceSpec,
    state: FileSyncState,
    errorFn: (message: string) => void
  ): Promise<void> {
    const srcPath = join(this.manifest.watchRoot, relPath);
    const destPath = join(this.destRoot, relPath);

    let srcSize: number;
    try {
      srcSize = (await stat(srcPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    state.sourceBytes = srcSize;

    const consumedOffset = state.mode === 'jsonl-tail' ? state.cursor.offset : state.consumedBytes;
    if (srcSize < consumedOffset) {
      state.failed = `source shrank: ${consumedOffset} bytes were already consumed, but the source is now only ${srcSize} bytes`;
      errorFn(`reconciler: "${relPath}" shrank below its consumed offset — marking failed and excluding from sync`);
      return;
    }

    await mkdir(dirname(destPath), { recursive: true });

    if (spec.mode === 'jsonl-tail') {
      await tailAppend(srcPath, destPath, state.cursor);
      state.consumedBytes = state.cursor.offset;
    } else {
      try {
        await copyFile(srcPath, destPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      state.consumedBytes = srcSize;
    }

    state.lastSyncAt = this.now();

    if (!state.sidecarWritten) {
      await writeSidecarIfAbsent(destPath, relPath, spec, this.manifest, srcPath, this.now);
      state.sidecarWritten = true;
    }
  }
}

async function enumerateFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  await walk(root, '', result);
  return result;
}

async function walk(dir: string, relPrefix: string, result: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const absPath = join(dir, entry);
    const relPath = relPrefix === '' ? entry : `${relPrefix}/${entry}`;

    let isDir: boolean;
    try {
      isDir = (await stat(absPath)).isDirectory();
    } catch {
      // Race: entry vanished between readdir and stat. Skip it.
      continue;
    }

    if (isDir) {
      await walk(absPath, relPath, result);
    } else {
      result.push(relPath);
    }
  }
}

async function writeSidecarIfAbsent(
  destPath: string,
  relPath: string,
  spec: SourceSpec,
  manifest: SessionSyncManifest,
  srcPath: string,
  now: () => number
): Promise<void> {
  const sidecarPath = `${destPath}.meta.json`;
  try {
    await access(sidecarPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // Adapter-owned naming convention: a subagent's agentId is the relPath's
  // basename without its extension (e.g. `<sessionId>/subagents/foo.jsonl` ->
  // agentId `foo`). This mirrors how the claude-code adapter names subagent
  // files; if an adapter's naming convention changes, this derivation must
  // change with it.
  const agentId = spec.role === 'subagent' ? basename(relPath, extname(relPath)) : undefined;

  // A subagent gets no generated title: any card-scoped text would be identical across every
  // subagent of the card, and its native identity is already recorded as `agentId` (with the task
  // prompt arriving later as `taskContent`), which is what renderers label it by.
  const title = spec.role === 'subagent' ? undefined : `${manifest.runtime} session for ${manifest.cardId}`;

  const meta: StreamMetaFile = {
    version: 1,
    relPath,
    streamType: manifest.streamType,
    runtime: manifest.runtime,
    sessionId: manifest.sessionId,
    role: spec.role,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(title !== undefined ? { title } : {}),
    sourcePath: srcPath,
    startedAt: new Date(now()).toISOString(),
    lineCount: 0
  };

  await writeFile(sidecarPath, JSON.stringify(meta, null, 2));
}

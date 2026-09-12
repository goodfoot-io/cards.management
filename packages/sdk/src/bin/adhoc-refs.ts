/**
 * Ad-hoc attribution reference files.
 *
 * A ref file at `~/.cards/adhoc-active/<cardId>/<sessionId>.ref` records the
 * monitored agent PID and its start-time so a recycled PID (PID reuse) reads as
 * dead. Status settlement remains an authenticated Cards API operation.
 *
 * @summary Ad-hoc attribution refs, action-presence, and reconciliation sweep
 * @module
 */

import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';
import { isProcessAliveWithStartTime, readProcessStartTime } from './process-utils.js';

/**
 * Minimal logger interface used by ref/sweep helpers.
 */
export interface AdhocRefsLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * Parsed contents of an ad-hoc reference file.
 */
export interface AdhocRef {
  /** Monitored agent PID. */
  pid: number;
  /** Start-time token captured when monitoring began, or null when unavailable. */
  startTime: string | null;
}

/**
 * Returns the root directory holding all per-card ad-hoc reference dirs.
 *
 * @returns Absolute path to `~/.cards/adhoc-active`.
 */
export function adhocActiveRoot(): string {
  return join(resolveGlobalCardsConfigDir(), 'adhoc-active');
}

/**
 * Returns the per-card reference directory under `~/.cards/adhoc-active/`.
 *
 * This namespace is distinct from `adhoc-sessions/` (the per-session de-dupe
 * lock files); the separation makes the two purposes explicit.
 *
 * @param cardId - Card identifier.
 * @returns Absolute path to the per-card reference directory.
 */
export function adhocActiveDir(cardId: string): string {
  return join(adhocActiveRoot(), cardId);
}

/**
 * Serializes a ref's contents to the on-disk format (`pid` then start-time on
 * the next line, when known).
 *
 * @param pid - Monitored agent PID.
 * @param startTime - Start-time token, or null when unavailable.
 * @returns The file contents to write.
 */
export function serializeRef(pid: number, startTime: string | null): string {
  return startTime === null ? String(pid) : `${pid}\n${startTime}`;
}

/**
 * Parses a ref file's contents into a {@link AdhocRef}, or null when the PID is
 * unparseable.
 *
 * Accepts both the legacy single-line (`pid` only) format and the two-line
 * (`pid` + start-time) format.
 *
 * @param content - Raw file contents.
 * @returns The parsed ref, or null when the PID cannot be read.
 */
export function parseRef(content: string): AdhocRef | null {
  const lines = content.split('\n');
  const pid = Number(lines[0]?.trim());
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const startTime = lines[1]?.trim();
  return { pid, startTime: startTime && startTime.length > 0 ? startTime : null };
}

/**
 * Removes a file, ignoring ENOENT.
 *
 * @param path - Absolute path to remove.
 */
async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Writes the ad-hoc reference file for a session, capturing the monitored PID's
 * current start-time so a later reader can detect PID reuse.
 *
 * @param cardId - Card identifier.
 * @param sessionId - Session identifier.
 * @param pid - Monitored agent PID.
 */
export async function writeRef(cardId: string, sessionId: string, pid: number): Promise<void> {
  const startTime = readProcessStartTime(pid);
  const refPath = join(adhocActiveDir(cardId), `${sessionId}.ref`);
  await writeFile(refPath, serializeRef(pid, startTime), 'utf-8');
}

/**
 * Removes the ad-hoc reference file for a session, ignoring ENOENT.
 *
 * @param cardId - Card identifier.
 * @param sessionId - Session identifier.
 */
export async function removeRef(cardId: string, sessionId: string): Promise<void> {
  await unlinkIfExists(join(adhocActiveDir(cardId), `${sessionId}.ref`));
}

/**
 * Scans the per-card reference directory and determines whether any other live
 * ad-hoc session remains. Removes stale ref files whose recorded process is
 * dead (PID gone or start-time mismatch).
 *
 * @param cardId - Card identifier.
 * @param sessionId - The dying session's id (its ref is excluded from the scan).
 * @param logger - Logger for warn output.
 * @returns True when at least one other ref with a live process remains.
 */
export async function liveRefsRemain(cardId: string, sessionId: string, logger: AdhocRefsLogger): Promise<boolean> {
  const dir = adhocActiveDir(cardId);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  let anyLive = false;
  for (const entry of entries) {
    if (!entry.endsWith('.ref')) continue;
    if (entry === `${sessionId}.ref`) continue;

    const refPath = join(dir, entry);
    let ref: AdhocRef | null;
    try {
      ref = parseRef(await readFile(refPath, 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      logger.warn('failed to read ref file', { refPath, error: String(error) });
      continue;
    }

    if (ref && isProcessAliveWithStartTime(ref.pid, ref.startTime)) {
      anyLive = true;
    } else {
      // Stale ref from a crashed cleanup or a recycled PID — unlink it.
      await unlinkIfExists(refPath);
    }
  }

  return anyLive;
}

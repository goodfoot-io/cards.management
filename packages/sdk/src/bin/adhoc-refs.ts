/**
 * Ad-hoc attribution reference files, action-presence detection, and the
 * stranded-active reconciliation sweep.
 *
 * A ref file at `~/.cards/adhoc-active/<cardId>/<sessionId>.ref` records the
 * monitored agent PID and its start-time so a recycled PID (PID reuse) reads as
 * dead. The reconciliation sweep ({@link reconcileStrandedActiveCards}) settles
 * cards left `active` by a dead monitor (reboot/OOM/SIGKILL of the detached
 * cleanup) and is safe to run synchronously at session start: it no-ops for
 * healthy cards and never touches a card whose monitored PID is still live.
 *
 * @summary Ad-hoc attribution refs, action-presence, and reconciliation sweep
 * @module
 */

import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';
import { isProcessAliveWithStartTime, readProcessStartTime, transitionCardStatus } from './process-utils.js';

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

/**
 * Resolves the per-card repository root (`reposPath`) from the API discovery
 * file (`$CARDS_DISCOVERY_PATH`, else `<resolveGlobalCardsConfigDir()>/cards-api.json`,
 * which honors `$CARDS_HOME`).
 *
 * Returns `null` when the discovery file is absent, malformed, or missing
 * `reposPath` — in which case there is no server and the sweep no-ops.
 *
 * @param logger - Logger for warn output on read failure.
 * @returns The reposPath, or null when unresolvable.
 */
export async function resolveReposPath(logger: AdhocRefsLogger): Promise<string | null> {
  const discoveryPath = process.env['CARDS_DISCOVERY_PATH'] ?? join(resolveGlobalCardsConfigDir(), 'cards-api.json');
  let config: { reposPath?: unknown };
  try {
    config = JSON.parse(await readFile(discoveryPath, 'utf-8')) as { reposPath?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('resolveReposPath: failed to read discovery file', {
        discoveryPath,
        error: String(error)
      });
    }
    return null;
  }
  return typeof config.reposPath === 'string' && config.reposPath.length > 0 ? config.reposPath : null;
}

/**
 * Convenience entry for the session-start reconciliation step: resolves the
 * repos root from discovery and runs {@link reconcileStrandedActiveCards}.
 *
 * Fully best-effort: any failure is logged and swallowed so it can never block
 * session start. No-ops when discovery is absent (no server to settle against).
 *
 * @param logger - Logger for warn output.
 */
export async function runReconciliationSweep(logger: AdhocRefsLogger): Promise<void> {
  try {
    const reposPath = await resolveReposPath(logger);
    await reconcileStrandedActiveCards(reposPath, logger);
  } catch (error) {
    logger.warn('runReconciliationSweep: sweep failed', { error: String(error) });
  }
}

/**
 * Reconciliation sweep: settles cards stranded `active` by a dead ad-hoc
 * monitor.
 *
 * Scans every `~/.cards/adhoc-active/<cardId>/` directory. For each card, if
 * ANY ref records a live process (PID alive and start-time matches) the card is
 * healthy — the sweep leaves it and its refs alone. Only when every ref for a
 * card is dead does the sweep settle the card (filesystem transition
 * `active`→`needs_review`, guarded by {@link transitionCardStatus} which no-ops
 * unless the on-disk status is `active`) and remove its stale refs.
 *
 * Bounded and synchronous-friendly: it touches only the local filesystem and a
 * `git commit` per stranded card. It never touches a card with a live monitor
 * and never spawns a long-lived process.
 *
 * @param cardRepoRoot - Directory containing per-card repositories
 *   (`reposPath`); each stranded card's repo is `join(cardRepoRoot, cardId)`.
 *   When null, the sweep no-ops (no server / discovery absent).
 * @param logger - Logger for warn output.
 */
export async function reconcileStrandedActiveCards(
  cardRepoRoot: string | null,
  logger: AdhocRefsLogger
): Promise<void> {
  if (cardRepoRoot === null) return;

  const root = adhocActiveRoot();

  let cardDirs: string[];
  try {
    cardDirs = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn('reconcile: failed to read adhoc-active root', { root, error: String(error) });
    return;
  }

  for (const cardId of cardDirs) {
    const dir = adhocActiveDir(cardId);

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      logger.warn('reconcile: failed to read card ref dir', { dir, error: String(error) });
      continue;
    }

    const refFiles = entries.filter((e) => e.endsWith('.ref'));
    if (refFiles.length === 0) continue;

    let anyLive = false;
    const deadRefPaths: string[] = [];
    for (const entry of refFiles) {
      const refPath = join(dir, entry);
      let ref: AdhocRef | null;
      try {
        ref = parseRef(await readFile(refPath, 'utf-8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        logger.warn('reconcile: failed to read ref', { refPath, error: String(error) });
        // Unreadable ref is treated as dead so it cannot strand a card forever.
        deadRefPaths.push(refPath);
        continue;
      }
      if (ref && isProcessAliveWithStartTime(ref.pid, ref.startTime)) {
        anyLive = true;
      } else {
        deadRefPaths.push(refPath);
      }
    }

    // A live monitor still owns this card — leave it and its refs untouched.
    if (anyLive) continue;

    // All monitors are dead: settle the card (guarded), then drop stale refs.
    try {
      await transitionCardStatus(join(cardRepoRoot, cardId), logger);
    } catch (error) {
      logger.warn('reconcile: failed to settle stranded card', { cardId, error: String(error) });
      // Leave the refs in place so a later sweep retries the settle.
      continue;
    }

    for (const refPath of deadRefPaths) {
      await unlinkIfExists(refPath);
    }
  }
}

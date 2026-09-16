/**
 * Extracted helper for spawning the manifest-driven `stream-sync-watcher`
 * subprocess inside the caller's own session.
 *
 * Shared between the Claude Code and Codex SessionStart hooks (launch-mode,
 * resolving the wrapper by absolute path under the extension's `dist/bin`)
 * and `spawnAdhocAttribution` (attach-mode, resolving the bare wrapper name
 * on PATH). The watcher takes a single JSON argument (a serialized
 * {@link SessionSyncManifest}), so both spawn paths use array-form `spawn`
 * with `shell: false` throughout (never string-concatenated), which is safe
 * regardless of quotes/spaces inside the JSON payload.
 *
 * @summary Spawn the manifest-driven stream-sync-watcher in the caller's session
 * @module
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type SessionSyncManifest, serializeManifest } from '../transcript-sync/manifest.js';
import { resolveDetachedNodeInterpreter } from './detached-node.js';

/**
 * Minimal logger interface required by spawnStreamSyncWatcher.
 *
 * Accepts any logger that exposes `error` and `warn` methods taking
 * a message string plus an optional structured-data argument.
 */
export interface WatcherSpawnLogger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/** No-op logger used when a caller does not supply one. */
const NOOP_LOGGER: WatcherSpawnLogger = {
  error: () => undefined,
  warn: () => undefined
};

/**
 * Probes whether a POSIX wrapper command is launchable.
 *
 * - **Absolute path:** verified with `fs.existsSync` (the file either exists at
 *   the resolved location or it does not).
 * - **Bare name (PATH lookup):** resolved with `sh -c 'command -v "$1"'`, which
 *   exits 0 only when the name is found on PATH.
 *
 * (win32 resolution does not use this — it resolves the interpreter and sibling
 * `.mjs` directly; see {@link spawnStreamSyncWatcher}.)
 *
 * @param command - Absolute path or bare wrapper name to probe.
 * @returns True when the command is launchable.
 */
export function isPosixWrapperAvailable(command: string): boolean {
  if (isAbsolute(command)) {
    return existsSync(command);
  }
  const probe = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

/**
 * Resolves the absolute `.mjs` that a `.cmd` wrapper would exec on win32,
 * from the wrapper reference the caller passed.
 *
 * - **Absolute `.cmd` path (launch mode):** the `.mjs` is the sibling the `.cmd`
 *   invokes (`%~dp0<name>.mjs`), i.e. the same path with the `.cmd` extension
 *   swapped for `.mjs`.
 * - **Bare name (attach mode):** `where <name>` is run to capture the absolute
 *   `.cmd` path it resolves to on PATH, then the extension is swapped. `where`'s
 *   exit status alone is insufficient here — the absolute path is needed to find
 *   the sibling `.mjs`.
 *
 * @param watcher - Absolute `.cmd` path or bare wrapper name.
 * @returns The absolute `.mjs` path, or `null` when it cannot be resolved or the
 *   resolved file does not exist.
 */
export function resolveWin32WatcherMjs(watcher: string): string | null {
  let cmdPath: string | null = null;
  if (isAbsolute(watcher)) {
    cmdPath = watcher;
  } else {
    const probe = spawnSync('where', [watcher], { encoding: 'utf-8', windowsHide: true });
    if (probe.error || probe.status !== 0 || typeof probe.stdout !== 'string') return null;
    // `where` may print multiple matches (one per line); take the first.
    cmdPath = probe.stdout.split(/\r?\n/).map((line) => line.trim())[0] || null;
  }
  if (!cmdPath) return null;

  const mjsPath = cmdPath.replace(/\.cmd$/i, '.mjs');
  if (mjsPath === cmdPath) return null;
  return existsSync(mjsPath) ? mjsPath : null;
}

/**
 * Returns the platform-correct basename of the `stream-sync-watcher` wrapper:
 * `stream-sync-watcher.cmd` on win32 (Windows cannot exec the extension-less
 * POSIX script) and `stream-sync-watcher` elsewhere.
 *
 * @returns The wrapper basename for the current platform.
 */
export function streamSyncWatcherWrapperName(): string {
  return process.platform === 'win32' ? 'stream-sync-watcher.cmd' : 'stream-sync-watcher';
}

/**
 * Resolves the absolute path to the `stream-sync-watcher` wrapper within the
 * extension's bin directory.
 *
 * The wrapper is produced by the extension build into `<extensionPath>/dist/bin`.
 * The runtime plugin's SessionStart hook cannot rely on it being on PATH — a
 * background Launch action enables only the `runtime` plugin, so the `cards`
 * plugin's bin is never prepended to PATH. Resolving an absolute path from the
 * caller-supplied `binPath` removes that cross-plugin PATH dependency.
 *
 * @param binPath - Absolute path to the extension's `dist/bin` directory.
 * @returns Absolute path to the platform-correct `stream-sync-watcher` wrapper
 *   under `<binPath>/`.
 */
export function resolveStreamSyncWatcher(binPath: string): string {
  return join(binPath, streamSyncWatcherWrapperName());
}

/** Options for {@link spawnStreamSyncWatcher}. */
export interface SpawnStreamSyncWatcherOptions {
  /** The manifest describing the session to sync; serialized as the watcher's sole argv entry. */
  manifest: SessionSyncManifest;
  /**
   * Absolute path to the extension root. When supplied, the wrapper is
   * resolved by absolute path under `<extensionPath>/dist/bin` (launch mode,
   * where the `cards` plugin bin is not on PATH). When omitted, the bare
   * wrapper name is used (attach mode, where the `cards` plugin is enabled
   * and its bin is on PATH).
   */
  extensionPath?: string;
  /** Logger for structured error output when the watcher cannot be launched. Defaults to a no-op logger. */
  logger?: WatcherSpawnLogger;
}

/**
 * Spawns a stream-sync-watcher process for crash-resilient transcript upload,
 * driven entirely by the supplied manifest.
 *
 * Process hygiene: **not** detached, so the watcher stays in the spawning
 * action's session and a session-wide terminate reaches it — the only signal
 * path that does not depend on a control socket still being answered. It is
 * still `unref()`'d and `stdio: 'ignore'`, so a short-lived hook can exit
 * without waiting on a watcher that may live for hours. On win32 it is spawned
 * as `node.exe <stream-sync-watcher.mjs> <manifestJson>` with no shell and no
 * `.cmd` hop (avoiding a console-window pop), using the same fail-closed
 * interpreter resolution (`VSCODE_NODE` env → `~/.cards/VSCODE_NODE` file →
 * PATH `node`). On resolution failure the spawn is skipped (logged), never
 * silently routed through a shell. POSIX exec's the extension-less wrapper
 * script directly.
 *
 * @param options - The manifest to serialize, optional extension path for
 *   launch-mode resolution, and an optional logger.
 * @returns `true` when the watcher was spawned, `false` when it was skipped
 *   because the wrapper could not be resolved. Callers gate any success log on
 *   this so a skipped spawn is never reported as a success.
 */
export function spawnStreamSyncWatcher(options: SpawnStreamSyncWatcherOptions): boolean {
  const { manifest, extensionPath, logger = NOOP_LOGGER } = options;

  const watcher = extensionPath
    ? resolveStreamSyncWatcher(join(extensionPath, 'dist', 'bin'))
    : streamSyncWatcherWrapperName();

  const spawnArgs = [serializeManifest(manifest)];
  const { sessionId, cardId, monitorPid } = manifest;

  if (process.platform === 'win32') {
    // Resolve a console-subsystem interpreter and the sibling .mjs, then spawn
    // directly — no `.cmd`, no shell — so the spawned tree stays windowless.
    const nodeExe = resolveDetachedNodeInterpreter();
    if (!nodeExe) {
      logger.error('stream-sync-watcher: no usable Node interpreter — skipping spawn', {
        watcher,
        pid: monitorPid,
        sessionId
      });
      return false;
    }
    const mjs = resolveWin32WatcherMjs(watcher);
    if (!mjs) {
      logger.error('stream-sync-watcher .mjs not resolvable — skipping spawn', {
        watcher,
        pid: monitorPid,
        sessionId
      });
      return false;
    }

    const child = spawn(nodeExe, [mjs, ...spawnArgs], {
      detached: false,
      stdio: 'ignore',
      env: { ...process.env },
      windowsHide: true
    });
    child.on('error', (err) => {
      logger.error('stream-sync-watcher spawn failed', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
        cardId
      });
    });
    child.unref();
    return true;
  }

  // POSIX: the wrapper exec's the .mjs via VSCODE_NODE; this helper only needs a
  // way to invoke it. An absolute path (launch mode) is checked with
  // `fs.existsSync`; a bare name (attach mode) is resolved against PATH with
  // `command -v`. The extension-less script is exec'd directly.
  if (!isPosixWrapperAvailable(watcher)) {
    logger.error('stream-sync-watcher not resolvable — skipping spawn', {
      watcher,
      pid: monitorPid,
      sessionId
    });
    return false;
  }

  const child = spawn(watcher, spawnArgs, {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env }
  });
  child.on('error', (err) => {
    logger.error('stream-sync-watcher spawn failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId,
      cardId
    });
  });
  child.unref();
  return true;
}

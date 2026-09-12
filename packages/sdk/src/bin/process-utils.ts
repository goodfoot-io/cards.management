/**
 * Shared process utilities for detached bin scripts.
 *
 * Extracts `isProcessAlive` so both stream-sync-watcher and adhoc-cleanup can
 * use it without circular imports. Also provides `isKnownAgentComm`
 * (comm-check gate for PID validation).
 *
 * @summary Shared process utilities for detached bin scripts
 * @module
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFileSyncNoWindow } from './childProcess.js';

// These utilities are imported by the detached `adhoc-cleanup` bin (console-less
// under stock node on win32). Their `tasklist` / `git` invocations force
// `windowsHide: true` via the SDK no-window helpers so no per-call console
// window appears; the option is a no-op for the POSIX `cat`/`ps` probes.
const execFileSync = execFileSyncNoWindow;

/**
 * Known comm values that identify Claude agent processes.
 *
 * `comm` is the kernel command name (15-char truncated). Claude Code runs as
 * `claude` (native build) or `node` (dev / older builds). Recent Node releases
 * rename their main thread, so `/proc/<pid>/comm` reports `MainThread` for a
 * node process — accepted here as an equivalent agent comm. Anything else
 * (shells, `sleep`, unrelated binaries) fails closed.
 */
const KNOWN_AGENT_COMMS = new Set(['claude', 'node', 'MainThread']);

/**
 * Requests a process exit without a synchronous {@link process.exit}.
 *
 * A synchronous `process.exit` while an HTTP (`fetch`/undici) or WebSocket
 * request is still tearing down races libuv closing the request's socket /
 * threadpool async handles and trips a fatal assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`, `src/win/async.c`) that aborts the
 * process with `0xC0000409` on Windows — even when the command already
 * succeeded and printed its result. Setting `process.exitCode` and letting the
 * event loop drain naturally avoids the race; well-behaved commands exit within
 * a few hundred ms once their client connections close.
 *
 * The unref'd backstop is fail-closed: it forces exit only if a handle genuinely
 * lingers past the deadline, and being unref'd it cannot itself keep the loop
 * alive, so the normal path still exits promptly and cleanly.
 *
 * Use this in CLI bins that talk to the Cards server (fetch / WebSocket) instead
 * of a bare `process.exit(code)`. It does NOT halt synchronously — callers in a
 * code path that must stop further execution should `return` after calling it.
 *
 * @param code - The exit code to set and, if needed, force.
 */
export function requestProcessExit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5_000).unref();
}

/**
 * Reads the start-time identity of a process, used to defeat PID reuse.
 *
 * The value is an opaque, stable, per-process token that changes when a PID is
 * recycled to a new process:
 *
 * - **Linux:** field 22 (`starttime`, clock ticks since boot) of
 *   `/proc/<pid>/stat`. The field is read positionally from the last `)` of the
 *   `comm` field to avoid mis-parsing process names that contain spaces or
 *   parentheses.
 * - **Other POSIX (macOS, etc.):** `ps -o lstart= -p <pid>` — the absolute
 *   start timestamp.
 * - **Windows:** not supported; returns `null` (start-time reuse detection
 *   degrades to plain PID liveness there).
 *
 * Returns `null` when the process is gone or the start-time cannot be read.
 *
 * @param pid - Process ID to inspect.
 * @returns An opaque start-time token, or `null` when unavailable.
 */
export function readProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf-8' });
      // The comm field (field 2) is wrapped in parens and may contain spaces or
      // parens; everything after the final ')' is space-delimited starting at
      // field 3 (state). starttime is field 22 overall → index 19 of the tail.
      const lastParen = stat.lastIndexOf(')');
      if (lastParen === -1) return null;
      const fields = stat
        .slice(lastParen + 2)
        .trim()
        .split(/\s+/);
      const startTime = fields[19];
      return startTime && startTime.length > 0 ? startTime : null;
    }

    if (process.platform === 'win32') {
      return null;
    }

    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return lstart.length > 0 ? lstart : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether a process is alive, optionally guarding against PID reuse.
 *
 * When `expectedStartTime` is provided, the process is treated as dead unless
 * it is both alive AND its current start-time matches the expected token — so a
 * recycled PID now belonging to a different process reads as dead. When
 * `expectedStartTime` is omitted, this is equivalent to {@link isProcessAlive}.
 *
 * On platforms where {@link readProcessStartTime} returns `null` (Windows, or a
 * transient read failure), the start-time check is skipped and the result falls
 * back to plain liveness — start-time reuse detection is best-effort, never a
 * source of false-dead readings from an unreadable token.
 *
 * @param pid - Process ID to check.
 * @param expectedStartTime - Start-time token captured when monitoring began,
 *   or `null`/`undefined` to skip the reuse guard.
 * @returns True if the process is alive (and, when checked, identity matches).
 */
export function isProcessAliveWithStartTime(pid: number, expectedStartTime?: string | null): boolean {
  if (!isProcessAlive(pid)) return false;
  if (expectedStartTime === undefined || expectedStartTime === null) return true;

  const current = readProcessStartTime(pid);
  // A null current token (unreadable) must not produce a false-dead reading.
  if (current === null) return true;
  return current === expectedStartTime;
}

/**
 * Checks whether a process with the given PID is still alive.
 *
 * Uses `process.kill(pid, 0)` which sends no signal but checks existence.
 * Returns true when the process exists (including EPERM), false on ESRCH.
 *
 * @param pid - Process ID to check.
 * @returns True if the process is alive, false otherwise.
 */
export function isProcessAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf-8'
      });
      return output.includes(String(pid));
    } catch {
      return false;
    }
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    // EPERM means the process exists but we cannot signal it
    return true;
  }
}

/**
 * Minimal logger interface accepted by process utilities.
 */
export interface ProcessUtilsLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * Card statuses from which an ad-hoc session may legitimately (re)activate the
 * card.
 *
 * These are the working / pre-work lifecycle states. Terminal and review-exit
 * states (`done`, `archived`) are deliberately excluded: an ad-hoc `cd` into a
 * finished card's worktree must not force-reactivate it and then strand it in
 * `needs_review`. `needs_review` IS included because that is the steady-state a
 * card returns to after any session, and re-entering it for further work is
 * legitimate (the cleanup will return it to `needs_review` on exit).
 */
const ADHOC_ACTIVATABLE_STATUSES = new Set<string>(['todo', 'active', 'needs_review']);

/**
 * Returns whether a card status permits ad-hoc (re)activation.
 *
 * @param status - The card's current status string.
 * @returns True when the status is a working/pre-work state.
 */
export function isAdhocActivatableStatus(status: string | undefined): boolean {
  return status !== undefined && ADHOC_ACTIVATABLE_STATUSES.has(status);
}

/**
 * Reads the current `status` field from a card repository's `CARD.meta.json`.
 *
 * @param cardRepoPath - Absolute path to the card's git repository.
 * @returns The status string, or null when the file is absent or unreadable.
 */
export async function readCardStatus(cardRepoPath: string): Promise<string | null> {
  const metaPath = join(cardRepoPath, 'CARD.meta.json');
  let content: string;
  try {
    content = await readFile(metaPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const meta = JSON.parse(content) as { status?: unknown };
    return typeof meta.status === 'string' ? meta.status : null;
  } catch {
    return null;
  }
}

/**
 * Validates that the given PID belongs to a known Claude agent process.
 *
 * Reads `/proc/<pid>/comm` on Linux, `ps -p <pid> -o comm=` on macOS, or
 * `tasklist` on Windows, then normalises the value to its bare command name
 * (basename, minus any `.exe` suffix) so every platform compares the same way.
 * Verifies that the result is a known agent comm (`claude`, `node`, or the
 * `MainThread` name a node process exposes). Returns false (fail closed) on
 * any error or unexpected comm value.
 *
 * @param pid - Process ID to check.
 * @param logger - Logger for warn output when comm is unexpected.
 * @returns True if the comm is a known agent comm, false otherwise.
 */
export function isKnownAgentComm(pid: number, logger?: ProcessUtilsLogger): boolean {
  try {
    let rawComm: string;
    if (process.platform === 'linux') {
      rawComm = execFileSync('cat', [`/proc/${pid}/comm`], { encoding: 'utf-8' }).trim();
    } else if (process.platform === 'win32') {
      // tasklist CSV (no header): "node.exe","1234","Console","1","50,000 K".
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf-8'
      });
      rawComm = out.trim().split('\n')[0]?.split(',')[0]?.replace(/^"|"$/g, '') ?? '';
    } else {
      // macOS `ps -o comm=` reports the full executable path (e.g.
      // /usr/local/bin/node) when the process was launched by an absolute path,
      // unlike Linux `/proc/<pid>/comm` which is the bare command name.
      rawComm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
    }

    // Normalise to the bare command name so all platforms compare equally:
    // basename strips a leading path (macOS), and the trailing-.exe strip
    // collapses Windows image names (node.exe -> node).
    const comm = basename(rawComm).replace(/\.exe$/i, '');

    if (KNOWN_AGENT_COMMS.has(comm)) {
      return true;
    }

    logger?.warn('isKnownAgentComm: unexpected comm value — failing closed', { pid, comm });
    return false;
  } catch (error) {
    logger?.warn('isKnownAgentComm: failed to read comm — failing closed', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

/**
 * Transitions a card's status from `active` to `needs_review` via direct
 * filesystem operations on the card repository.
 *
 * Reads and modifies `CARD.meta.json` directly, then stages and commits the
 * change. This is the fallback path used when the API server is unreachable.
 * Guards against writing `needs_review` when the card is not currently `active`.
 *
 * The commit sets an explicit committer identity (mirroring the wrapper's
 * teardown) so it cannot fail for a missing `user.name`/`user.email`. If the
 * commit nonetheless fails (rejecting hook, locked index, etc.), the
 * `CARD.meta.json` write is reverted to its committed contents so the repo is
 * never left dirty-and-inconsistent (committed `active`, working-tree
 * `needs_review`), and the failure is rethrown rather than silently swallowed.
 *
 * @param cardRepoPath - Absolute path to the card's git repository.
 * @param logger - Optional logger for warn output on commit failure.
 * @throws When the status write cannot be committed (after reverting the write).
 */
/**
 * Render a caught error for top-level CLI output, walking the `cause` chain.
 *
 * Node's `fetch` throws a `TypeError` whose own `.message` is just
 * `"fetch failed"` — the actionable detail (ECONNREFUSED, DNS failure, TLS
 * error, etc.) lives on `.cause`, sometimes nested several levels deep. A
 * bare `error.message` print discards that detail and leaves the operator
 * with nothing to debug from.
 *
 * @param error - The caught value to render.
 * @returns A human-readable message including any chained causes.
 */
export function formatErrorForCli(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts = [error.message];
  let cause = error.cause;
  while (cause !== undefined && cause !== null) {
    parts.push(cause instanceof Error ? cause.message : String(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join(' — caused by: ');
}

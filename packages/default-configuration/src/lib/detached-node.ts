/**
 * Fail-closed Node interpreter resolution for detached win32 watcher spawns.
 *
 * {@link spawnBranchCleanupWatcher} in `branch-cleanup-watcher.ts` does not
 * share the extension's interpreter-resolution code. To avoid routing a
 * detached spawn through a `.cmd` → `node.exe` hop (which pops a console
 * window once the win32 interpreter is stock `node.exe`), it spawns
 * `node.exe <bin>.mjs` directly on win32 — and therefore needs to resolve a
 * usable `node.exe` itself.
 *
 * Resolution order mirrors the published `.cmd`/`.sh` shims plus the env
 * override:
 *   1. `VSCODE_NODE` environment variable (set in action subprocess env).
 *   2. `~/.cards/VSCODE_NODE` file (written by the extension on activation; the
 *      anchor the `.cmd`/`.sh` shims read).
 *   3. `node` on PATH (resolved via `where`).
 *
 * Every candidate is existence-checked so a stale path never produces a
 * broken spawn; on total failure the caller logs and skips rather than
 * silently spawning a GUI interpreter through a shell.
 *
 * @summary Fail-closed Node interpreter resolution for detached win32 spawns
 * @module
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Reads the interpreter path persisted to `~/.cards/VSCODE_NODE`.
 *
 * @returns The trimmed path, or `null` when the file is absent/empty/unreadable.
 */
function readVscodeNodeFile(): string | null {
  try {
    const value = readFileSync(join(homedir(), '.cards', 'VSCODE_NODE'), 'utf-8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the first `node.exe` on PATH via `where` (win32).
 *
 * Skips non-`.exe` matches: `where` also lists extension-less POSIX-style shims
 * that precede the real binary (Yarn 4 prepends a temp dir with such a `node`
 * shim for every script it runs), and Windows cannot exec an extension-less file
 * even though it exists on disk.
 *
 * @returns The absolute path to the first `node.exe` match, or `null` when none
 *   resolves or the resolved path does not exist.
 */
function resolveNodeOnPath(): string | null {
  const probe = spawnSync('where', ['node'], { encoding: 'utf-8', windowsHide: true });
  if (probe.error || probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  const firstExe =
    probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith('.exe')) ?? null;
  if (!firstExe) return null;
  return existsSync(firstExe) ? firstExe : null;
}

/**
 * Resolves a usable, console-subsystem Node interpreter for a detached win32
 * watcher spawn, fail-closed.
 *
 * Tries, in order: the `VSCODE_NODE` env var, the `~/.cards/VSCODE_NODE` file,
 * and `node` on PATH. An absolute candidate (env / file) must exist on disk to
 * be accepted; the PATH candidate is resolved and existence-checked by
 * {@link resolveNodeOnPath}.
 *
 * @returns The resolved interpreter path, or `null` when none is usable (the
 *   caller must then log-and-skip rather than spawn through a shell).
 */
export function resolveDetachedNodeInterpreter(): string | null {
  const fromEnv = (process.env['VSCODE_NODE'] ?? '').trim();
  if (fromEnv && isAbsolute(fromEnv) && existsSync(fromEnv)) {
    return fromEnv;
  }

  const fromFile = readVscodeNodeFile();
  if (fromFile && isAbsolute(fromFile) && existsSync(fromFile)) {
    return fromFile;
  }

  return resolveNodeOnPath();
}

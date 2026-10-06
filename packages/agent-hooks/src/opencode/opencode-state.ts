/**
 * Shared state and platform seams for the OpenCode hook bundles.
 *
 * Unlike the Claude/Codex hooks — one-shot subprocesses whose entire state is
 * re-read from disk on every invocation — OpenCode plugins are in-process Bun
 * modules living inside the agent server for the whole session lifetime. This
 * module is bundled into each emitted plugin payload and carries everything
 * that outlives a single hook callback:
 *
 * - the **root-session registry** (built from `event`/`session.created`,
 *   filtering child sessions via absent {@link SessionLike.parentID}) every
 *   per-session hook gates on;
 * - the **NDJSON transcript exporter** that materializes a tailable transcript
 *   under `~/.cards/opencode-transcripts/<sessionId>.jsonl` (OpenCode stores
 *   sessions in SQLite, so no native transcript file exists);
 * - the **hooks log anchor** resolving
 *   `<anchorRoot>/.cards/logs/opencode-cards-hooks.log`, adapted from the
 *   Claude {@link ../shared/default-log-file} computation with an
 *   `OPENCODE_CARDS_HOOKS_LOG_FILE` operator override.
 *
 * Every filesystem/process/git edge goes through {@link OpencodeStateIo}, with
 * a real default implementation, so tests construct handlers against real
 * temporary directories instead of mocking modules.
 *
 * @summary Shared registry, exporter, and log-anchor state for OpenCode hooks
 * @module opencode-state
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// IO seam
// ---------------------------------------------------------------------------

/**
 * Every filesystem/process edge the shared state touches, injectable so tests
 * run against real temporary trees rather than module mocks.
 *
 * @summary Injectable filesystem/process seam for OpenCode hook state
 */
export interface OpencodeStateIo {
  /** Current wall clock as an ISO-8601 timestamp. */
  nowIso(): string;
  /** `fs.mkdirSync(dir, { recursive: true })`. */
  ensureDirSync(dir: string): void;
  /** `fs.appendFileSync(path, data)` — append-only writes, no fsync. */
  appendFileSync(path: string, data: string): void;
  /** File size in bytes, or `null` when the file does not exist / is unreadable. */
  fileSizeSync(path: string): number | null;
  /**
   * Reads the single byte at absolute `position`, or `null` when unreadable
   * (missing file, position past EOF). Used to detect a torn trailing line.
   */
  lastByteSync(path: string, position: number): number | null;
  /** `fs.existsSync`. */
  existsSync(path: string): boolean;
  /** `fs.readFileSync(path, 'utf8')`; throws on failure — callers handle. */
  readTextFileSync(path: string): string;
  /** Best-effort truncation of a file to zero bytes; failures are swallowed. */
  truncateSync(path: string): void;
  /** `os.homedir()`. */
  homedir(): string;
  /**
   * Resolves the worktree root and owning main repository root for `cwd`
   * (mirrors the Claude default-log-file resolution), or `null` when `cwd` is
   * not in a usable standard-layout git repository.
   */
  gitRoots(cwd: string): { worktreeRoot: string; mainRepoRoot: string } | null;
}

/** Ceiling on the single memoized `git rev-parse` per cwd. */
const GIT_TIMEOUT_MS = 3000;

/**
 * Real {@link OpencodeStateIo} over Node builtins.
 *
 * Git-root resolution is memoized per cwd for the process lifetime — git
 * topology cannot change mid-session, and the spawn is charged its full
 * timeout on pathological repositories.
 */
export const defaultOpencodeStateIo: OpencodeStateIo = (() => {
  const gitRootsCache = new Map<string, { worktreeRoot: string; mainRepoRoot: string } | null>();

  return {
    nowIso: () => new Date().toISOString(),
    ensureDirSync: (dir) => mkdirSync(dir, { recursive: true }),
    appendFileSync: (path, data) => appendFileSync(path, data),
    fileSizeSync: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
    lastByteSync: (path, position) => {
      let fd: number;
      try {
        fd = openSync(path, 'r');
      } catch {
        return null;
      }
      try {
        const buf = Buffer.alloc(1);
        const read = readSync(fd, buf, 0, 1, position);
        return read === 1 ? (buf[0] as number) : null;
      } catch {
        return null;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // Nothing better to do — the descriptor leaks only on close failure.
        }
      }
    },
    existsSync: (path) => existsSync(path),
    readTextFileSync: (path) => readFileSync(path, 'utf8'),
    truncateSync: (path) => {
      try {
        writeFileSync(path, '', { flag: 'w' });
      } catch {
        // Best-effort by contract — callers log and continue.
      }
    },
    homedir: () => osHomedir(),
    gitRoots: (cwd) => {
      const cached = gitRootsCache.get(cwd);
      if (cached !== undefined) {
        return cached;
      }
      const roots = computeGitRoots(cwd);
      gitRootsCache.set(cwd, roots);
      return roots;
    }
  };
})();

/**
 * Uncached git-root computation backing {@link OpencodeStateIo.gitRoots}.
 *
 * Ported from the Claude default-log-file module: `--git-common-dir` collapses
 * linked worktrees to their owning repo, `--show-toplevel` names the checkout,
 * and a basename guard degrades non-standard layouts (bare, submodule,
 * separate-git-dir) to "not a repo". Exit 128 (not a repository) is silent;
 * other failures write a stderr diagnostic because they cost real time.
 *
 * @param cwd - Directory to resolve from.
 * @returns Both roots, or `null` outside a usable git repository.
 */
function computeGitRoots(cwd: string): { worktreeRoot: string; mainRepoRoot: string } | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const [commonDir, worktreeRoot] = output.trim().split('\n');
    if (!commonDir || !worktreeRoot || commonDir.length === 0 || worktreeRoot.length === 0) {
      return null;
    }
    if (basename(commonDir) !== '.git') {
      return null;
    }

    return { worktreeRoot, mainRepoRoot: dirname(commonDir) };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
    if (failure.status !== 128) {
      const reason =
        failure.signal === 'SIGTERM' ? `timed out after ${GIT_TIMEOUT_MS} ms` : (failure.code ?? failure.message);
      process.stderr.write(
        `[opencode-cards-hooks] could not resolve a log anchor: git rev-parse ${reason}; logging is off\n`
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Root-session registry
// ---------------------------------------------------------------------------

/** Minimal shape of an OpenCode session record this module needs. */
export interface SessionLike {
  /** Session identifier (`ses_…`). */
  id: string;
  /** Present on child (subagent) sessions; absent on root sessions. */
  parentID?: string;
}

/**
 * In-memory registry of root sessions seen by one plugin bundle.
 *
 * Classification rule (observed on OpenCode v1.18.21):
 *
 * (a) a `session.created` event whose `info.parentID` is null/absent marks a
 *     root, and one carrying `parentID` records the session as a child;
 * (b) a session **first observed through any non-created event** while no
 *     parent record exists for it is also a root.
 *
 * Rule (b) is load-bearing for resumed sessions: `opencode run --continue`
 * never re-emits `session.created` for the resumed session id (I5 live probe),
 * so a bundle that classified only from `created` would fail-closed-skip every
 * hook there. It cannot misclassify children because child sessions always
 * announce `created` carrying `parentID` before any other event (in-process
 * ordering), so their parent record always exists before activity arrives.
 *
 * Each emitted plugin bundle embeds its own copy of this module, so every
 * bundle that needs root gating feeds its own registry from its own `event`
 * subscription — registration is idempotent and cheap.
 *
 * @summary Registry of root card sessions seen by this plugin bundle
 */
export interface RootSessionRegistry {
  /** Records a `session.created` payload; roots are kept, children linked. */
  observe(info: SessionLike): void;
  /**
   * Notes a session first observed through a non-created event.
   *
   * Unknown sessions classify as roots (resumed-session rule); known children
   * stay children. Safe to call on every event.
   *
   * @param sessionId - Session the activity event carries.
   * @returns `true` when this call newly classified the session as a root —
   *   the signal handlers use to run once-per-session startup work.
   */
  noteObserved(sessionId: string): boolean;
  /** Drops a session (on `session.deleted`). */
  forget(sessionId: string): void;
  /** `true` when the id names a known root session. */
  isRoot(sessionId: string): boolean;
  /**
   * Resolves the top-level root ancestor of a child session by walking
   * `childLinks` upward until a known root is reached (grandchildren resolve
   * to their top-level root).
   *
   * Pure lookup: unlinked sessions — including roots themselves and unknown
   * ids — return `null`, as does any chain that tops out at a session that
   * has not classified as a root yet. A contradictory payload cycle fails
   * closed with `null`.
   *
   * @param sessionId - Child session identifier to resolve from.
   * @returns The top-level root id, or `null` when none is reachable.
   */
  rootAncestorOf(sessionId: string): string | null;
  /** Known root ids in first-seen order. */
  rootIds(): string[];
  /** Number of tracked root sessions. */
  readonly size: number;
}

/**
 * Creates an empty {@link RootSessionRegistry}.
 *
 * @returns A fresh registry instance isolated from all others.
 */
export function createRootSessionRegistry(): RootSessionRegistry {
  const roots = new Set<string>();
  /** Sessions observed via `session.created` carrying a parentID. */
  const childLinks = new Map<string, string>();
  const order: string[] = [];

  const addRoot = (sessionId: string) => {
    if (!roots.has(sessionId)) {
      roots.add(sessionId);
      order.push(sessionId);
    }
  };

  return {
    observe(info) {
      if (!info || typeof info.id !== 'string' || info.id.length === 0) {
        return;
      }
      if (info.parentID === undefined || info.parentID === null || info.parentID.length === 0) {
        // Rule (a): created without a parent — a fresh root.
        addRoot(info.id);
        return;
      }
      // Explicit created-with-parent beats any earlier classification: the
      // verified ordering guarantees this arrives before the child's other
      // events, so a conflicting prior root entry can only be stale.
      childLinks.set(info.id, info.parentID);
      if (roots.delete(info.id)) {
        const index = order.indexOf(info.id);
        if (index >= 0) {
          order.splice(index, 1);
        }
      }
    },
    noteObserved(sessionId) {
      if (!sessionId || typeof sessionId !== 'string') {
        return false;
      }
      if (roots.has(sessionId) || childLinks.has(sessionId)) {
        return false;
      }
      // Rule (b): first sight through a non-created event with no parent
      // record — a resumed (or otherwise pre-existing) root session.
      addRoot(sessionId);
      return true;
    },
    forget(sessionId) {
      childLinks.delete(sessionId);
      if (roots.delete(sessionId)) {
        const index = order.indexOf(sessionId);
        if (index >= 0) {
          order.splice(index, 1);
        }
      }
    },
    isRoot: (sessionId) => roots.has(sessionId),
    rootAncestorOf: (sessionId) => {
      let current = childLinks.get(sessionId);
      if (current === undefined) {
        return null;
      }
      const visited = new Set<string>([sessionId]);
      while (!roots.has(current)) {
        if (visited.has(current)) {
          // Contradictory created payloads formed a cycle — fail closed.
          return null;
        }
        visited.add(current);
        const parent = childLinks.get(current);
        if (parent === undefined) {
          // The chain tops out at an unclassified session; no known root above.
          return null;
        }
        current = parent;
      }
      return current;
    },
    rootIds: () => [...order],
    get size() {
      return roots.size;
    }
  };
}

// ---------------------------------------------------------------------------
// NDJSON transcript exporter (CONTRACT-C)
// ---------------------------------------------------------------------------

/** Line types allowed in the materialized transcript stream. */
export type ExporterLineType = 'meta' | 'message' | 'part' | 'idle';

/**
 * Appends normalized lines to a session's transcript file:
 * `{"v":1,"ts":"<ISO>","seq":<n>,"sessionId":"…","type":"meta"|"message"|"part"|"idle","data":{...}}`.
 *
 * **`seq` semantics (pinned):** the counter is per-process — it starts at 1
 * for every exporter instance and therefore **restarts when a session is
 * resumed** (a resumed run opens a fresh exporter appending to the same
 * file). Consumers MUST NOT treat `seq` as a global order key across process
 * boundaries; within one process it orders lines monotonically. The
 * renderer tolerates duplicate and out-of-`seq` values across segments.
 *
 * Writes are append-only with no fsync (throughput over durability — a hard
 * crash loses the tail). The first write after opening heals a torn trailing
 * line left by a dead predecessor: when the file's last byte is not `\n`, the
 * next line is prefixed with `\n`, sacrificing the torn fragment instead of
 * corrupting the following record. Readers additionally tolerate torn tails.
 *
 * @summary Append-only CONTRACT-C exporter for one OpenCode session
 */
export interface TranscriptExporter {
  /** Session whose file this exporter appends to. */
  readonly sessionId: string;
  /** Absolute path of the `.jsonl` file. */
  readonly path: string;
  /** Number of lines written so far (the last used `seq`). */
  readonly seq: number;
  /** Emits the mandatory first line carrying runtime identity metadata. */
  writeMeta(data: Record<string, unknown>): void;
  /** Emits a `message.part.updated` payload. */
  writePart(part: unknown): void;
  /** Emits a `message.updated` payload. */
  writeMessage(message: unknown): void;
  /**
   * Emits an `idle` marker recording that the session's turn loop ended.
   *
   * Renderers fold these header-style (later markers update, never append);
   * `session.idle` is bus-only, so idle lines are purely live appends and
   * never appear in backfilled history.
   *
   * @param data - Optional payload; defaults to `{}`.
   */
  writeIdle(data?: Record<string, unknown>): void;
  /** Stops further writes; safe to call repeatedly. */
  close(): void;
}

/**
 * Creates an exporter appending to `filePath`.
 *
 * The parent directory is created on demand. No line is written until the
 * first `write*` call — a session that produces nothing leaves no file.
 *
 * @param sessionId - Session identifier embedded in every line.
 * @param filePath - Absolute path of the target `.jsonl` file.
 * @param io - Filesystem seam; defaults to the real implementation.
 * @returns A fresh exporter with its own sequence counter starting at 1.
 */
export function createTranscriptExporter(
  sessionId: string,
  filePath: string,
  io: Pick<
    OpencodeStateIo,
    'nowIso' | 'ensureDirSync' | 'appendFileSync' | 'fileSizeSync' | 'lastByteSync'
  > = defaultOpencodeStateIo
): TranscriptExporter {
  let seq = 0;
  let opened = false;
  let closed = false;

  const healTornTailIfNeeded = () => {
    if (opened) {
      return '';
    }
    opened = true;
    const size = io.fileSizeSync(filePath);
    if (size === null || size === 0) {
      return '';
    }
    const last = io.lastByteSync(filePath, size - 1);
    return last !== null && last !== 0x0a ? '\n' : '';
  };

  const writeLine = (type: ExporterLineType, data: Record<string, unknown>): void => {
    if (closed) {
      return;
    }
    seq += 1;
    const line = `${JSON.stringify({ v: 1, ts: io.nowIso(), seq, sessionId, type, data })}\n`;
    io.ensureDirSync(dirname(filePath));
    io.appendFileSync(filePath, `${healTornTailIfNeeded()}${line}`);
  };

  return {
    sessionId,
    path: filePath,
    get seq() {
      return seq;
    },
    writeMeta: (data) => writeLine('meta', data),
    writePart: (part) => writeLine('part', part as Record<string, unknown>),
    writeMessage: (message) => writeLine('message', message as Record<string, unknown>),
    writeIdle: (data) => writeLine('idle', data ?? {}),
    close: () => {
      closed = true;
    }
  };
}

// ---------------------------------------------------------------------------
// Hooks log anchor (adapted default-log-file)
// ---------------------------------------------------------------------------

/**
 * Operator override naming the hooks log file directly. Mirrors
 * `CLAUDE_CODE_HOOKS_LOG_FILE` parity for the OpenCode bundles; an **empty**
 * value means "file logging off" — treating empty as unset would turn logging
 * back on against the operator's wishes.
 */
export const OPENCODE_CARDS_HOOKS_LOG_ENV_VAR = 'OPENCODE_CARDS_HOOKS_LOG_FILE';

/** Log file name, sibling of the Claude/Codex anchors under `<anchorRoot>/.cards/logs/`. */
export const OPENCODE_HOOKS_LOG_FILE_NAME = 'opencode-cards-hooks.log';

/**
 * Strips JSONC constructs that `JSON.parse` rejects (`//` and block comments,
 * trailing commas), preserving offsets by blanking rather than deleting.
 *
 * Ported compactly from the Claude default-log-file reader: OpenCode config
 * files are JSON by convention but `.jsonc` siblings are legal, and a reader
 * that cannot cope would make an annotated-but-valid install indistinguishable
 * from no install at all.
 *
 * @param source - Raw config file contents.
 * @returns Text with comments blanked and trailing commas removed.
 */
function stripJsonc(source: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;

    if (inString) {
      out.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      out.push('\n');
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    out.push(char);
  }

  return out.join('').replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parses one opencode config document tolerantly; returns `undefined` when
 * absent or unparseable (both mean "no signal here").
 *
 * @param io - Filesystem seam.
 * @param path - Absolute config file path.
 * @returns The parsed document, or `undefined`.
 */
function readOpencodeConfig(io: OpencodeStateIo, path: string): unknown {
  if (!io.existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(stripJsonc(io.readTextFileSync(path)));
  } catch {
    return undefined;
  }
}

/**
 * Reports whether a parsed config's `plugin` array references Cards payloads.
 *
 * Accepts exactly the document the launcher writer emits (cross-package
 * contract): the **singular v1 `plugin` key** holding an array of specifier
 * strings, under any `$schema`. Tuple/option-pair entries and plural key
 * spellings are not the writer's shape and fail loudly (`false`) so a future
 * writer/detector drift cannot silently re-enable file logging.
 *
 * Entry content stays deliberately heuristic — user-scope pointer files
 * (`…/plugins/cache/cards/<name>/current.mjs`), package names
 * (`cards-opencode-*`), and launch-time staged absolute paths under
 * `~/.cards/opencode/plugins/` — because the gate only decides where a log
 * file lives, not whether an install is live.
 *
 * @param config - Parsed opencode config document.
 * @returns `true` when any string plugin entry looks like a Cards payload.
 */
export function recordsCardsPluginInstall(config: unknown): boolean {
  if (config === null || typeof config !== 'object') {
    return false;
  }
  const plugin = (config as Record<string, unknown>)['plugin'];
  if (!Array.isArray(plugin)) {
    return false;
  }
  return plugin.some((entry) => typeof entry === 'string' && isCardsPluginSpec(entry));
}

/**
 * Heuristic match for one `"plugin"` entry string.
 *
 * @param spec - The plugin specifier from config.
 * @returns `true` when the specifier names a Cards-shipped payload.
 */
function isCardsPluginSpec(spec: string): boolean {
  if (spec.includes('cards-opencode-')) {
    return true;
  }
  // Content-addressed cache layout: …/plugins/cache/cards/<name>/…
  if (/[/\\]cache[/\\]cards[/\\]/.test(spec)) {
    return true;
  }
  // Launch-time staging root: ~/.cards/opencode/plugins/…
  return /[\\/]\.cards[/\\]opencode[/\\]plugins?[/\\]/.test(spec);
}

/**
 * Resolves the directory the `.cards/logs/` tree hangs off for this session.
 *
 * Restores the install-scope dimension of the Claude anchor logic:
 *
 * - a project-scope install recorded in `<repoRoot>/.opencode/opencode.json{,c}`
 *   anchors on the main repository root (looked up in both the worktree and
 *   its owning checkout, since the installer writes whichever is open);
 * - a launch-time staged config (`OPENCODE_CONFIG`) referencing Cards plugins
 *   anchors on the main repository root — this is how every Cards-spawned
 *   session is recognized without a persistent user install;
 * - a user-scope install in `$OPENCODE_CONFIG_DIR` or `~/.config/opencode`
 *   anchors on the home directory;
 * - no detected install anchors nowhere, leaving file logging off (fail-closed:
 *   an untracked `.cards/logs/` must not appear in unrelated checkouts).
 *
 * @param io - Filesystem seam.
 * @param env - Process environment snapshot.
 * @param cwd - Session working directory to anchor git lookups from.
 * @returns Absolute anchor directory, or `null` when no install is detected.
 */
export function resolveLogAnchorRoot(io: OpencodeStateIo, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const roots = io.gitRoots(cwd);
  if (roots) {
    const candidates =
      roots.worktreeRoot === roots.mainRepoRoot ? [roots.mainRepoRoot] : [roots.worktreeRoot, roots.mainRepoRoot];
    const projectInstall = candidates.some((root) =>
      [join(root, '.opencode', 'opencode.json'), join(root, '.opencode', 'opencode.jsonc')].some((file) =>
        recordsCardsPluginInstall(readOpencodeConfig(io, file))
      )
    );
    if (projectInstall) {
      return roots.mainRepoRoot;
    }
  }

  const stagedConfig = env['OPENCODE_CONFIG'];
  if (stagedConfig && recordsCardsPluginInstall(readOpencodeConfig(io, stagedConfig))) {
    return roots ? roots.mainRepoRoot : cwd;
  }

  const configuredDir = env['OPENCODE_CONFIG_DIR'];
  // Route through the IO seam (not raw os.homedir()) so resolution stays
  // deterministic under injected environments.
  const globalDir =
    configuredDir !== undefined && configuredDir.length > 0 ? configuredDir : join(io.homedir(), '.config', 'opencode');
  const userInstall = [join(globalDir, 'opencode.json'), join(globalDir, 'opencode.jsonc')].some((file) =>
    recordsCardsPluginInstall(readOpencodeConfig(io, file))
  );
  if (userInstall) {
    return io.homedir();
  }

  return null;
}

/**
 * Computes the default hooks log path for this session.
 *
 * An explicit {@link OPENCODE_CARDS_HOOKS_LOG_ENV_VAR} value wins; an empty
 * value stands the default down entirely. Otherwise the install-gated anchor
 * applies, producing exactly `<anchorRoot>/.cards/logs/opencode-cards-hooks.log`.
 *
 * @param io - Filesystem seam.
 * @param env - Process environment snapshot.
 * @param cwd - Session working directory.
 * @returns Absolute log file path, or `null` when logging stays off.
 */
export function resolveHookLogFile(io: OpencodeStateIo, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const override = env[OPENCODE_CARDS_HOOKS_LOG_ENV_VAR];
  if (override !== undefined) {
    return override.length > 0 ? override : null;
  }
  const anchor = resolveLogAnchorRoot(io, env, cwd);
  return anchor === null ? null : join(anchor, '.cards', 'logs', OPENCODE_HOOKS_LOG_FILE_NAME);
}

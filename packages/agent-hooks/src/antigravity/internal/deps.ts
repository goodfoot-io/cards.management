/**
 * Injectable dependency seam shared by the Antigravity runtime handlers.
 *
 * Following the OpenCode `internal/deps` pattern: every edge that would
 * otherwise need a module mock — action-env extraction, session-identity
 * resolution, agent-PID lookup, manifest building, watcher spawning, session
 * registration, session marker files, git counting, shutdown handshake,
 * process-tree drain — is an overridable member of
 * {@link AntigravityHandlerDeps}. The defaults wire the real SDK
 * implementations; tests construct handlers against real temporary
 * filesystems and plain objects.
 *
 * The adapter wraps the same shared internals the Claude/Codex one-shot hooks
 * and the OpenCode in-process plugins use; nothing here reimplements a shared
 * behavior.
 *
 * @summary Dependency seam and defaults for Antigravity runtime handlers
 * @module internal/deps
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnStreamSyncWatcher } from '@cards.management/sdk/bin/spawn-stream-sync-watcher';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk/cards-config';
import {
  type ActionInput,
  clearPendingShutdownRequest,
  extractActionInput,
  type PendingShutdownRequest,
  readPendingShutdownRequest
} from '@cards.management/sdk/config';
import { findAgentPid, isAgentProcessTreeDrained } from '@cards.management/sdk/process-tree';
import type { SessionSyncManifest } from '@cards.management/sdk/transcript-sync';
import {
  ANTIGRAVITY_STREAM_TYPE,
  type AntigravityManifestInput,
  buildAntigravityManifest
} from '@cards.management/sdk/transcript-sync/adapters';
import { addUnboundCandidate, clearUnboundCandidates } from '@cards.management/sdk/unbound-worktree-candidates';
import {
  getActiveSubagentCount,
  hasSessionExitWhenDoneNudgeFired,
  hasSessionRouteNudgeFired,
  markSessionExitWhenDoneNudgeFired,
  markSessionRouteNudgeFired,
  removeSessionCsv,
  removeSessionExitWhenDoneNudge,
  removeSessionHeadSha,
  removeSessionRouteNudge
} from '@cards.management/sessions/card-repo';
import { deliverShutdownReadiness } from '../../shared/shutdown-drain.js';
import type { WorkAuthority } from '../../shared/work-authority.js';
import { createHookWorkAuthority } from '../../shared/work-authority.js';
import { canonicalConversationDbPath, resolveCardsSessionId } from './inputs.js';
import type { AntigravityIo } from './io.js';
import { defaultAntigravityIo } from './io.js';

/** Shape of CARD.meta.json fields the route decision consults. */
export interface AntigravityCardMeta {
  /** Tags set on the card; a `blocked` tag suppresses the merge route. */
  tags?: string[];
  /** Merge gating state of the card. */
  gates?: {
    mergeRequestRequired?: boolean;
    mergeApproved?: boolean;
  };
}

/** Session marker operations persisted under `~/.cards/card-repo-commits/`. */
export interface AntigravitySessionMarkers {
  /** `true` when the merge route nudge already fired for the session. */
  hasRouteNudgeFired(sessionId: string): boolean;
  /** Records that the merge route nudge fired. */
  markRouteNudgeFired(sessionId: string): void;
  /** `true` when the exit-when-done nudge already fired for the session. */
  hasExitWhenDoneFired(sessionId: string): boolean;
  /** Records that the exit-when-done nudge fired. */
  markExitWhenDoneFired(sessionId: string): void;
  /** Number of subagents currently tracked as active for the session. */
  getActiveSubagentCount(sessionId: string): number;
}

export { ANTIGRAVITY_STREAM_TYPE };

/**
 * Everything an Antigravity runtime handler needs from the world outside its
 * arguments.
 *
 * @summary Overridable edges for Antigravity runtime handlers
 */
export interface AntigravityHandlerDeps {
  /** Authenticated authority gating root and child work boundaries. */
  workAuthority: WorkAuthority;
  /** Filesystem seam backing the marker store and cleanup steps. */
  io: AntigravityIo;
  /** Cards global configuration directory (honors `$CARDS_HOME`). */
  cardsConfigDir(): string;
  /**
   * Parses the Cards action environment, or returns `null` when the session
   * was not spawned by a Cards action.
   */
  loadActionInput(): ActionInput | null;
  /** Resolves the Cards session identity from the launcher's pre-spawn env. */
  resolveSessionId(): string | null;
  /** PID of the `agy` agent process, or `null` when it cannot be identified. */
  findMonitorPid(): Promise<number | null>;
  /** Builds the transcript-sync manifest (CONTRACT-B adapter). */
  buildManifest(input: AntigravityManifestInput): SessionSyncManifest;
  /** Spawns the detached stream-sync-watcher for a manifest. */
  spawnWatcher(options: { manifest: SessionSyncManifest; extensionPath?: string }): boolean;
  /**
   * Registers the session → worktree/transcript mapping in the on-disk store
   * `resolveTranscriptPath()` reads, so in-session `cards` CLI processes can
   * recover the transcript. The transcript path MUST be the canonical
   * conversation DB path ({@link AntigravityHandlerDeps.conversationDbPath}).
   */
  registerSession(sessionId: string, worktreeDir: string, transcriptPath: string): Promise<void>;
  /** Removes an Assistant's no-card session registration idempotently. */
  cleanupSessionRegistration(sessionId: string): Promise<void>;
  /**
   * Resolves the canonical Antigravity conversation DB path for a
   * conversation id —
   * `<home>/.gemini/antigravity-cli/conversations/<conversationId>.db` —
   * even when the DB file does not exist yet.
   */
  conversationDbPath(conversationId: string): string;
  /** Session marker store (route/exit-when-done nudges, subagent tracking). */
  sessionMarkers: AntigravitySessionMarkers;
  /** Counts commits on `workspaceBranch` missing from `baseBranch`. */
  unmergedCommitCount(workspacePath: string, baseBranch: string, workspaceBranch: string): number;
  /** Reads and parses CARD.meta.json for the route decision. */
  readCardMeta(cardRepoPath: string): AntigravityCardMeta;
  /** Loads the session's pending shutdown request, when one exists. */
  readPendingShutdownRequest(sessionId: string): PendingShutdownRequest | undefined;
  /** Sends readiness through the authenticated runtime authority. */
  deliverShutdownReadiness(sessionId: string, request: PendingShutdownRequest): Promise<void>;
  /** Clears the session's pending shutdown request after acknowledgement. */
  clearPendingShutdownRequest(sessionId: string, requestId: string): void;
  /** Proves the agent's process tree holds no work outside the hook branch. */
  isAgentProcessTreeDrained(agentPid: number): Promise<boolean | null>;
  /** Absolute path of the installed merge runbook (`card` skill references). */
  mergeRunbookPath(): string;
  /** Absolute path of the installed shutdown runbook (`card` skill references). */
  shutdownRunbookPath(): string;
  /**
   * Removes the session's per-session artifacts (commit CSV, HEAD SHA,
   * route-nudge and exit-when-done markers). Idempotent; throws an
   * aggregate error when any removal fails for a non-ENOENT reason.
   */
  cleanupSessionArtifacts(sessionId: string): void;
}

/**
 * Resolves a runbook shipped beside the emitted handler bundle, from any
 * module URL.
 *
 * The Antigravity build compiles handlers to `<pluginRoot>/bin/<name>.mjs`
 * with the `runtime` plugin's skills shipped as a sibling of `bin/` at
 * `<pluginRoot>/skills/…`. Resolving from the bundle's `import.meta.url`
 * needs exactly one `..`; repo-root-relative strings only work when the
 * agent's cwd happens to be this monorepo, which is never true for installed
 * payloads (the host resolves hook commands with the `hooks.json` directory
 * as the working directory).
 *
 * @param fromUrl - `file://` URL (typically `import.meta.url`) of a module
 *   inside the installed `<pluginRoot>/bin/` directory.
 * @param relative - Skill-relative fragment below `<pluginRoot>/skills/card/references`.
 * @returns Absolute path of the referenced runbook.
 */
export function resolveRunbookFrom(fromUrl: string, relative: string): string {
  return fileURLToPath(new URL(`../skills/card/references/${relative}`, fromUrl));
}

/**
 * Builds the real dependency wiring.
 *
 * @returns Dependencies backed entirely by SDK implementations.
 */
export function defaultAntigravityHandlerDeps(): AntigravityHandlerDeps {
  return {
    workAuthority: {
      admit: async (boundary) => createHookWorkAuthority().admit(boundary),
      observeRevision: async () => createHookWorkAuthority().observeRevision()
    },
    io: defaultAntigravityIo,
    cardsConfigDir: () => resolveGlobalCardsConfigDir(),
    loadActionInput: () => {
      try {
        return extractActionInput();
      } catch {
        return null;
      }
    },
    resolveSessionId: () => resolveCardsSessionId(),
    findMonitorPid: () => findAgentPid(),
    buildManifest: (input) => buildAntigravityManifest(input),
    spawnWatcher: ({ manifest, extensionPath }) =>
      spawnStreamSyncWatcher({
        manifest,
        ...(extensionPath === undefined ? {} : { extensionPath }),
        logger: {
          error: (message, data) => stderrLine(`${message} ${stringify(data)}`),
          warn: (message, data) => stderrLine(`${message} ${stringify(data)}`)
        }
      }),
    registerSession: async (sessionId, worktreeDir, transcriptPath) => {
      await addUnboundCandidate(sessionId, worktreeDir, transcriptPath);
    },
    cleanupSessionRegistration: async (sessionId) => {
      await clearUnboundCandidates(sessionId);
    },
    conversationDbPath: (conversationId) => canonicalConversationDbPath(conversationId),
    sessionMarkers: {
      hasRouteNudgeFired: (sessionId) => hasSessionRouteNudgeFired(sessionId),
      markRouteNudgeFired: (sessionId) => markSessionRouteNudgeFired(sessionId),
      hasExitWhenDoneFired: (sessionId) => hasSessionExitWhenDoneNudgeFired(sessionId),
      markExitWhenDoneFired: (sessionId) => markSessionExitWhenDoneNudgeFired(sessionId),
      getActiveSubagentCount: (sessionId) => getActiveSubagentCount(sessionId)
    },
    unmergedCommitCount: (workspacePath, baseBranch, workspaceBranch) => {
      const output = execFileSync('git', ['rev-list', '--count', `${baseBranch}..${workspaceBranch}`], {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return Number.parseInt(output.trim(), 10);
    },
    readCardMeta: (cardRepoPath) => JSON.parse(readFileSync(join(cardRepoPath, 'CARD.meta.json'), 'utf-8')),
    readPendingShutdownRequest: (sessionId) => readPendingShutdownRequest(sessionId),
    deliverShutdownReadiness: async (sessionId, request) => {
      await deliverShutdownReadiness(sessionId, request);
    },
    clearPendingShutdownRequest: (sessionId, requestId) => {
      clearPendingShutdownRequest(sessionId, requestId);
    },
    isAgentProcessTreeDrained: async (agentPid) => isAgentProcessTreeDrained(agentPid),
    mergeRunbookPath: () => resolveRunbook('merge.md'),
    shutdownRunbookPath: () => resolveRunbook('shutdown.md'),
    cleanupSessionArtifacts: (sessionId) => cleanupSessionArtifacts(sessionId)
  };
}

/**
 * Removes the session's per-session artifacts, each step independent and
 * ENOENT-tolerant (mirrors the Claude SessionEnd cleanup).
 *
 * @param sessionId - Session whose artifacts should be removed.
 * @throws {AggregateError} When one or more removals fail for a non-ENOENT
 *   reason; every step is attempted regardless.
 */
function cleanupSessionArtifacts(sessionId: string): void {
  const errors: Error[] = [];
  const steps: Array<{ label: string; remove: () => void }> = [
    { label: 'commit CSV', remove: () => removeSessionCsv(sessionId) },
    { label: 'HEAD SHA', remove: () => removeSessionHeadSha(sessionId) },
    { label: 'route-nudge marker', remove: () => removeSessionRouteNudge(sessionId) },
    { label: 'exit-when-done marker', remove: () => removeSessionExitWhenDoneNudge(sessionId) }
  ];
  for (const step of steps) {
    try {
      step.remove();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Session cleanup had ${errors.length} failure(s)`);
  }
}

/**
 * Resolves this bundle's installed runbook paths.
 *
 * @param relative - Skill-relative fragment below `<pluginRoot>/skills/card/references`.
 * @returns Absolute path of the referenced runbook.
 */
function resolveRunbook(relative: string): string {
  return resolveRunbookFrom(import.meta.url, relative);
}

/**
 * Writes one line to stderr without ever throwing.
 *
 * @param line - Preformatted diagnostic line.
 */
function stderrLine(line: string): void {
  try {
    process.stderr.write(`[antigravity-cards-hooks] ${line}\n`);
  } catch {
    // A dead stderr must not kill the hook before its marker is written.
  }
}

/**
 * Renders optional structured detail for stderr lines.
 *
 * @param data - Structured detail, when present.
 * @returns JSON text, or the empty string when absent/unrenderable.
 */
function stringify(data?: Record<string, unknown>): string {
  if (data === undefined) {
    return '';
  }
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

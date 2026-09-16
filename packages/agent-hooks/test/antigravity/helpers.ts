/**
 * Shared helpers for the Antigravity runtime hook tests.
 *
 * Real implementations over temporary filesystems and in-memory stores —
 * per the card-developer no-mocks rule — plus recorders wired around the
 * real default dependency implementations.
 *
 * @summary Test harness for the Antigravity runtime handlers
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionInput } from '@cards.management/sdk/config';
import type { SessionSyncManifest } from '@cards.management/sdk/transcript-sync';
import type { AntigravityCardMeta, AntigravityHandlerDeps } from '../../src/antigravity/internal/deps.js';
import { defaultAntigravityHandlerDeps } from '../../src/antigravity/internal/deps.js';
import type { AntigravityCommonInput, AntigravityInvocationInput } from '../../src/antigravity/internal/inputs.js';
import { defaultAntigravityIo } from '../../src/antigravity/internal/io.js';

/** The Cards session id every test dependency wiring reports. */
export const SESSION_ID = 'session-453';

/** The conversation id every test input carries. */
export const CONVERSATION_ID = 'conv-453';

// ---------------------------------------------------------------------------
// In-memory session marker store
// ---------------------------------------------------------------------------

/** In-memory store backing the fake {@link AntigravityHandlerDeps.sessionMarkers}. */
export class MemorySessionMarkers {
  /** Sessions whose merge route nudge fired. */
  readonly routeNudged = new Set<string>();
  /** Sessions whose exit-when-done nudge fired. */
  readonly exitNudged = new Set<string>();
  /** Active subagent counts per session. */
  readonly subagentCounts = new Map<string, number>();

  /**
   * Reports whether the merge route nudge fired for a session.
   *
   * @param sessionId - Session to check.
   * @returns `true` when the marker exists.
   */
  hasRouteNudgeFired(sessionId: string): boolean {
    return this.routeNudged.has(sessionId);
  }

  /**
   * Records the merge route nudge for a session.
   *
   * @param sessionId - Session to mark.
   */
  markRouteNudgeFired(sessionId: string): void {
    this.routeNudged.add(sessionId);
  }

  /**
   * Reports whether the exit-when-done nudge fired for a session.
   *
   * @param sessionId - Session to check.
   * @returns `true` when the marker exists.
   */
  hasExitWhenDoneFired(sessionId: string): boolean {
    return this.exitNudged.has(sessionId);
  }

  /**
   * Records the exit-when-done nudge for a session.
   *
   * @param sessionId - Session to mark.
   */
  markExitWhenDoneFired(sessionId: string): void {
    this.exitNudged.add(sessionId);
  }

  /**
   * Active subagent count for a session.
   *
   * @param sessionId - Session to check.
   * @returns The tracked count (0 when untracked).
   */
  getActiveSubagentCount(sessionId: string): number {
    return this.subagentCounts.get(sessionId) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Recorders and dependency factory
// ---------------------------------------------------------------------------

/** Recorder handles attached to every fake deps instance. */
export interface DepsRecorders {
  /** Manifests produced by the real antigravity manifest builder. */
  manifests: SessionSyncManifest[];
  /** Watcher spawn requests with their manifests. */
  watcherSpawns: Array<{ manifest: SessionSyncManifest; extensionPath?: string }>;
  /** Session registrations (sessionId, worktreeDir, transcriptPath). */
  registrations: Array<{ sessionId: string; worktreeDir: string; transcriptPath: string }>;
  /** Session ids whose artifact cleanup ran. */
  cleanedSessions: string[];
  /** Session ids whose no-card registration cleanup ran. */
  cleanedRegistrations: string[];
  /** In-memory session marker store. */
  markers: MemorySessionMarkers;
}

/**
 * Builds handler dependencies backed by the real default implementations,
 * redirected to a temporary tree, with recorders around the observable edges.
 *
 * @param root - Temporary directory anchoring the cards home, card repo, and
 *   workspace paths.
 * @param overrides - Per-test edge overrides merged last.
 * @returns Deps plus the recorder handles.
 */
export function makeDeps(
  root: string,
  overrides: Partial<AntigravityHandlerDeps> = {}
): { deps: AntigravityHandlerDeps; recorders: DepsRecorders } {
  const defaults = defaultAntigravityHandlerDeps();
  const markers = new MemorySessionMarkers();
  const manifests: SessionSyncManifest[] = [];
  const watcherSpawns: Array<{ manifest: SessionSyncManifest; extensionPath?: string }> = [];
  const registrations: Array<{ sessionId: string; worktreeDir: string; transcriptPath: string }> = [];
  const cleanedSessions: string[] = [];
  const cleanedRegistrations: string[] = [];
  const recorders: DepsRecorders = {
    manifests,
    watcherSpawns,
    registrations,
    cleanedSessions,
    cleanedRegistrations,
    markers
  };

  const deps: AntigravityHandlerDeps = {
    io: defaultAntigravityIo,
    cardsConfigDir: () => join(root, 'cards-home'),
    loadActionInput: () => makeActionInput(root),
    resolveSessionId: () => SESSION_ID,
    findMonitorPid: async () => 4242,
    buildManifest: (input) => {
      const manifest = defaults.buildManifest(input);
      manifests.push(manifest);
      return manifest;
    },
    spawnWatcher: (options) => {
      watcherSpawns.push(options);
      return true;
    },
    registerSession: async (sessionId, worktreeDir, transcriptPath) => {
      registrations.push({ sessionId, worktreeDir, transcriptPath });
    },
    cleanupSessionRegistration: async (sessionId) => {
      cleanedRegistrations.push(sessionId);
    },
    conversationDbPath: (conversationId) =>
      join(root, 'gemini-home', '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`),
    sessionMarkers: markers,
    unmergedCommitCount: () => 0,
    readCardMeta: (cardRepoPath) => defaults.readCardMeta(cardRepoPath),
    mergeRunbookPath: () => join(root, 'skills', 'card', 'references', 'merge.md'),
    shutdownRunbookPath: () => join(root, 'skills', 'card', 'references', 'shutdown.md'),
    cleanupSessionArtifacts: (sessionId) => {
      cleanedSessions.push(sessionId);
    },
    ...overrides
  };

  return { deps, recorders };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a Cards action input for a temp-tree card.
 *
 * @param root - Temporary directory carrying `cards/main-453`.
 * @param overrides - Per-test field overrides.
 * @returns A complete action input.
 */
export function makeActionInput(root: string, overrides: Partial<ActionInput> = {}): ActionInput {
  return {
    cardId: 'main-453',
    actionName: 'Launch',
    executionId: 'execution-453',
    worktreeDirective: { kind: 'reuse' },
    environment: 'default',
    executionMode: 'background',
    exitWhenDone: false,
    codingAgent: 'antigravity-cli',
    switchToInteractiveData: undefined,
    repoRoot: join(root, 'main-repo'),
    cardRepoPath: join(root, 'cards', 'main-453'),
    configPath: join(root, 'config'),
    extensionPath: join(root, 'extension'),
    marketplacePath: join(root, 'marketplace'),
    ...overrides
  };
}

/**
 * Builds the pinned common host input for one hook invocation.
 *
 * @param root - Temporary directory the paths resolve into.
 * @param overrides - Per-test field overrides (replace whole values).
 * @returns The common input fixture.
 */
export function makeCommonInput(root: string, overrides: Partial<AntigravityCommonInput> = {}): AntigravityCommonInput {
  return {
    conversationId: CONVERSATION_ID,
    workspacePaths: [join(root, 'workspace')],
    transcriptPath: join(root, 'transcripts', `${CONVERSATION_ID}.jsonl`),
    artifactDirectoryPath: join(root, 'artifacts', CONVERSATION_ID),
    modelName: 'gemini-3-pro',
    ...overrides
  };
}

/**
 * Builds the pinned invocation input (common fields plus the invocation
 * fields) for the PreInvocation and PostInvocation events.
 *
 * @param root - Temporary directory the paths resolve into.
 * @param overrides - Per-test field overrides (replace whole values).
 * @returns The invocation input fixture.
 */
export function makeInvocationInput(
  root: string,
  overrides: Partial<AntigravityInvocationInput> = {}
): AntigravityInvocationInput {
  const { invocationNum, initialNumSteps, ...commonOverrides } = overrides;
  return {
    ...makeCommonInput(root, commonOverrides),
    invocationNum: invocationNum ?? 0,
    initialNumSteps: initialNumSteps ?? 3
  };
}

/**
 * Creates a unique temporary directory tree.
 *
 * @param label - Subdirectory name under the OS temp dir.
 * @returns Absolute path of the created directory.
 */
export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `antigravity-hooks-${label}-`));
}

/**
 * Removes a temporary directory tree created by {@link makeTempDir}.
 *
 * @param dir - Directory to remove.
 */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Creates a minimal readable card repository (CARD.meta.json present).
 *
 * @param root - Parent directory.
 * @param options - Fixture options.
 * @param options.cardId - Card identifier used as the directory name.
 * @param options.tags - Tags written into CARD.meta.json.
 * @param options.gates - Merge gates written into CARD.meta.json.
 * @param options.withMeta - When `false`, omits CARD.meta.json entirely.
 * @returns Absolute path of the card repository.
 */
export function makeCardRepo(
  root: string,
  options: { cardId?: string; tags?: string[]; gates?: AntigravityCardMeta['gates']; withMeta?: boolean } = {}
): string {
  const repoPath = join(root, 'cards', options.cardId ?? 'main-453');
  mkdirSync(repoPath, { recursive: true });
  if (options.withMeta !== false) {
    writeFileSync(
      join(repoPath, 'CARD.meta.json'),
      JSON.stringify({
        id: options.cardId ?? 'main-453',
        title: 'Test card',
        status: 'active',
        ...(options.tags === undefined ? {} : { tags: options.tags }),
        ...(options.gates === undefined ? {} : { gates: options.gates })
      })
    );
  }
  return repoPath;
}

/**
 * Saves the given environment keys and deletes them, returning a restore
 * function that puts the original values back.
 *
 * @param keys - Environment variable names to clear for the test body.
 * @returns A cleanup function restoring the prior environment.
 */
export function withoutEnv(...keys: string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) {
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

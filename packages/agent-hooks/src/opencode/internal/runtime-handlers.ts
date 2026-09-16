/**
 * Factories for the OpenCode `runtime` plugin handlers.
 *
 * Each factory returns an OpenCode plugin whose hooks mirror one Codex
 * sibling, adapted to OpenCode's verified surface:
 *
 * - **SessionStart** (`createSessionStartPlugin`) rides
 *   `event`/`session.created`; it registers root card sessions, injects card
 *   context every turn through `experimental.chat.system.transform`, persists
 *   identity through `shell.env` (stateless per call), materializes the NDJSON
 *   transcript (CONTRACT-C), builds the manifest (CONTRACT-B adapter), and
 *   spawns the stream-sync-watcher whose lifetime rides agent-PID death.
 * - **SessionStart(compact)** (`createSessionStartAfterCompactionPlugin`)
 *   pushes the routing reminder into `experimental.session.compacting`.
 * - **Stop** (`createStopRouteNudgePlugin`, `createStopExitWhenDonePlugin`)
 *   announce their nudges through the log channels on `event`/`session.idle`:
 *   a plugin cannot block the turn or terminate the host, so both are
 *   delivered as named warnings — the exit-when-done nudge now points at
 *   `cards "$CARD_ID" shutdown`, whose relay lets the action handler perform
 *   the termination.
 * - **SubagentStart/Stop** (`createSubagentStartPlugin`,
 *   `createSubagentStopPlugin`) track child sessions from
 *   `session.created`/`session.idle` parent linkage, best-effort.
 *
 * Nothing here throws across the plugin boundary: every hook body is wrapped
 * in catch-all isolation because a throwing plugin kills the user's whole
 * OpenCode session.
 *
 * @summary Factory implementations for the OpenCode runtime handlers
 * @module internal/runtime-handlers
 */

import { join } from 'node:path';
import {
  CARDS_ENV_VARS,
  extractActionInput,
  getBaseBranch,
  getCardRepoPath,
  getWorkspaceBranch,
  getWorkspacePath
} from '@cards.management/sdk/config';
import type { OpencodeManifestInput } from '@cards.management/sdk/transcript-sync/adapters';
import type { Plugin } from '@opencode-ai/plugin';
import { buildAdditionalContext, CardRepoAccessError } from '../../shared/context.js';
import { isSessionIdle } from '../../shared/session-idle.js';
import { createOpencodeLog, type OpencodeLog } from '../hook-log.js';
import {
  createRootSessionRegistry,
  createTranscriptExporter,
  type SessionLike,
  type TranscriptExporter
} from '../opencode-state.js';
import {
  createSdkSessionHistory,
  defaultOpencodeHandlerDeps,
  type LoadSessionHistory,
  type OpencodeHandlerDeps
} from './deps.js';

/** Routing reminder re-injected after compaction (Codex parity). */
const ROUTING_REMINDER = '**IMPORTANT: Immediately load skills based on the `<routing-instructions>`.**';

/**
 * Builds the bundle-wide logger for a plugin factory.
 *
 * @param directory - Session working directory supplied at plugin init.
 * @param deps - Handler dependencies supplying the IO seam.
 * @param client - Live SDK client, or `null`.
 * @returns The structured logger.
 */
function buildLogger(
  directory: string,
  deps: OpencodeHandlerDeps,
  client: Parameters<Plugin>[0]['client']
): OpencodeLog {
  return createOpencodeLog({ client, cwd: directory, io: deps.io });
}

/**
 * Wraps one hook body in catch-all isolation with a named warning.
 *
 * A throwing plugin kills the user's whole OpenCode session, so every hook
 * body runs under this wrapper; failures are logged (when possible) and
 * swallowed.
 *
 * @template T Hook return type.
 * @param log - Logger for the failure entry.
 * @param name - Handler name for the warning line.
 * @param body - The actual hook logic.
 * @returns An async function safe to hand to OpenCode.
 */
async function guarded<T>(log: OpencodeLog | null, name: string, body: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = `${name} failed (fail-open): ${message}`;
    if (log) {
      await log.warn(entry);
    } else {
      process.stderr.write(`[opencode-cards-hooks] warn: ${entry}\n`);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

/** Bookkeeping the runtime session-start plugin keeps per tracked session. */
interface RuntimeSessionRecord {
  /** Card the action launched against (root records only). */
  cardId?: string;
  /** Materialized transcript path (also injected as `CARDS_TRANSCRIPT_PATH`). */
  transcriptPath?: string;
  /** Exporter handle appending CONTRACT-C lines. */
  exporter?: TranscriptExporter;
  /**
   * Present on child (subagent) records: the top-level root the child streams
   * under (`<transcriptsRoot>/<parentId>/subagents/<childId>.jsonl`).
   */
  parentId?: string;
  /** Cached every-turn context fragment (env block + repo logs). */
  contextFragment?: string;
  /** `true` while resume-backfill reconciliation is in flight for this root. */
  reconciling?: boolean;
  /** Live writes buffered while {@link reconciling}, flushed in arrival order. */
  pending?: Array<{ kind: 'part' | 'message' | 'idle'; payload: unknown }>;
}

/**
 * Creates the runtime SessionStart-equivalent plugin.
 *
/**
 * Whether the hosting OpenCode process was spawned by a Cards action.
 *
 * The Cards launcher injects `CARD_ID` (and the rest of the action envelope)
 * before spawn; plain terminal sessions never carry it. Runtime lifecycle
 * plugins are meaningless outside that context, so their entries export an
 * inert plugin when this returns false — accidental global registration stays
 * silent and side-effect-free instead of idling loudly on every hook.
 *
 * @returns `true` when the complete Cards action envelope is present and valid.
 */
export function isCardsActionSession(): boolean {
  if (!process.env[CARDS_ENV_VARS.CARD_ID]) return false;
  try {
    extractActionInput();
    return true;
  } catch {
    return false;
  }
}

/**
 * A plugin factory registering no hooks. Returned by every runtime entry when
 * {@link isCardsActionSession} is false.
 *
 * @returns An OpenCode plugin with an empty hook surface.
 */
export function createInertRuntimePlugin(): Plugin {
  return async () => ({});
}

/**
 * Runtime session-start plugin: root-session registration and identity,
 * context injection, transcript materialization, watcher wiring.
 *
 * Startup runs once per root session — from `session.created` for fresh
 * sessions, and from the first activity event (message, `shell.env`,
 * transform) that classifies a **resumed** session as root under registry
 * rule (b), since resumed sessions never re-emit `created` (I5 probe).
 *
 * Child (subagent) sessions resolve to their top-level root via the registry
 * and stream their own transcript under
 * `<transcriptsRoot>/<rootId>/subagents/<childId>.jsonl`, riding the same
 * manifest and watcher as their root. Identity (`shell.env`) and context
 * injection stay strictly root-gated.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event`, `shell.env`, and the
 *   `experimental.chat.system.transform` hooks.
 */
export function createSessionStartPlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();
  const records = new Map<string, RuntimeSessionRecord>();
  /** Sessions whose startup sequence already ran (or was declined). */
  const started = new Set<string>();
  /**
   * History loader, wired at plugin init from the captured OpenCode client
   * (or the injected override); reconciliation never runs before init.
   */
  let loadSessionHistory: LoadSessionHistory | null = null;
  /**
   * Ids seen through `session.deleted`, for the plugin lifetime. A deleted
   * session's trailing events must never reclassify it as a resumed root
   * (rule b) — that resurrected phantom transcripts, reconciliation fetches,
   * and a second stream-sync-watcher spawn for a session that no longer
   * exists. OpenCode ids are unique, so the memory never needs clearing.
   */
  const deletedSessions = new Set<string>();

  /**
   * Runs the Cards-action startup sequence for one root session, at most once.
   *
   * @param sessionId - Root session identifier.
   * @param log - Bundle logger.
   * @param version - Runtime version when known (fresh `created` payloads).
   */
  async function ensureStarted(sessionId: string, log: OpencodeLog, version?: string): Promise<void> {
    if (started.has(sessionId)) {
      return;
    }
    started.add(sessionId);

    const actionInput = deps.loadActionInput();
    if (!actionInput) {
      // Not spawned by a Cards action — a user-scope install firing inside the
      // user's own terminal session. Stay out of the way entirely.
      await log.info('OpenCode session is not a Cards action; Cards integration idle', {
        sessionId
      });
      return;
    }

    const record: RuntimeSessionRecord = records.get(sessionId) ?? {};
    record.cardId = actionInput.cardId;
    record.transcriptPath = join(deps.transcriptsRoot(), `${sessionId}.jsonl`);

    // Materialize the transcript: meta line first, then live event appends.
    try {
      const exporter = createTranscriptExporter(sessionId, record.transcriptPath, deps.io);
      exporter.writeMeta({ runtime: 'opencode', opencodeVersion: version ?? 'unknown' });
      record.exporter = exporter;
      // The header exists on disk before anything else — a mid-backfill
      // failure still leaves it. Live writes are held from this point until
      // reconciliation settles so backfilled history strictly precedes every
      // live line, whatever the bus dispatch timing.
      record.reconciling = true;
      record.pending = [];
      void reconcileHistory(sessionId, record, log);
    } catch (error) {
      await log.warn('Failed to open the Cards transcript exporter; streaming disabled', {
        sessionId,
        path: record.transcriptPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Build the every-turn context fragment once. There is no SessionStart
    // output channel on OpenCode, so card context reaches the model through
    // experimental.chat.system.transform; a failing card repo degrades to a
    // logged error because nothing here can stop the session.
    try {
      record.contextFragment = buildAdditionalContext(actionInput);
      await log.info('Card context prepared for injection', {
        sessionId,
        cardId: actionInput.cardId,
        actionName: actionInput.actionName
      });
    } catch (error) {
      if (error instanceof CardRepoAccessError) {
        const failure = error.toHookFailure('session');
        await log.error(`Card repo inaccessible: ${failure.stopReason}`, { repoPath: error.repoPath });
      } else {
        throw error;
      }
    }

    records.set(sessionId, record);

    // Manifest + watcher, mirroring the Codex session-start wiring. Both are
    // non-fatal; build failures warn exactly like spawn failures.
    const monitorPid = deps.findMonitorPid();
    if (monitorPid === null || !record.transcriptPath) {
      await log.warn('Could not identify agent PID; transcript watcher disabled', {
        sessionId,
        cardId: actionInput.cardId,
        cardRepoPath: actionInput.cardRepoPath,
        actionName: actionInput.actionName
      });
      return;
    }

    try {
      const manifestInput: OpencodeManifestInput = {
        sessionId,
        cardId: actionInput.cardId,
        transcriptPath: record.transcriptPath,
        monitorPid,
        cardRepoPath: actionInput.cardRepoPath
      };
      const manifest = deps.buildManifest(manifestInput);
      const spawned = deps.spawnWatcher({ manifest, extensionPath: actionInput.extensionPath });
      if (spawned) {
        await log.info('Spawned stream-sync-watcher', { pid: monitorPid, sessionId });
      }
    } catch (error) {
      await log.warn('stream-sync-watcher spawn failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Opens the child transcript exporter for one subagent of a tracked root,
   * at most once per child (one meta line, one log entry — including after a
   * failed open, so a broken disk cannot turn every event into a retry loop).
   *
   * @param rootId - Top-level root session owning the subagents directory.
   * @param childId - Child (or grandchild) session identifier.
   * @param log - Bundle logger.
   * @param version - Runtime version when known (fresh `created` payloads).
   */
  async function ensureChildStarted(
    rootId: string,
    childId: string,
    log: OpencodeLog,
    version?: string
  ): Promise<void> {
    const existing = records.get(childId);
    if (existing?.parentId === rootId) {
      return;
    }
    // Children stream only under a root whose Cards-action startup ran;
    // outside an action the whole integration stays inert, children included.
    if (!records.has(rootId)) {
      return;
    }
    const transcriptPath = join(deps.transcriptsRoot(), rootId, 'subagents', `${childId}.jsonl`);
    const record: RuntimeSessionRecord = { ...(existing ?? {}), parentId: rootId };
    try {
      const exporter = createTranscriptExporter(childId, transcriptPath, deps.io);
      exporter.writeMeta({
        runtime: 'opencode',
        opencodeVersion: version ?? 'unknown',
        parentSessionId: rootId
      });
      record.exporter = exporter;
      records.set(childId, record);
      await log.info(`Streaming child session ${childId} of ${rootId}`, {
        sessionId: childId,
        parentSessionId: rootId
      });
    } catch (error) {
      records.set(childId, record);
      await log.warn('Failed to open the child transcript exporter; child streaming disabled', {
        sessionId: childId,
        parentSessionId: rootId,
        path: transcriptPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Routes one content line for a tracked session: buffered while resume
   * reconciliation is in flight, written straight through otherwise. Every
   * live line kind rides this path so nothing can land ahead of replayed
   * history.
   *
   * @param sessionId - Owning (root or child) session id.
   * @param kind - Which exporter method the payload rides.
   * @param payload - The raw event payload to serialize.
   */
  function writeToExporter(sessionId: string, kind: 'part' | 'message' | 'idle', payload: unknown): void {
    const record = records.get(sessionId);
    if (!record) {
      return;
    }
    if (record.reconciling) {
      record.pending?.push({ kind, payload });
      return;
    }
    if (kind === 'part') {
      record.exporter?.writePart(payload);
    } else if (kind === 'idle') {
      record.exporter?.writeIdle(payload as Record<string, unknown>);
    } else {
      record.exporter?.writeMessage(payload);
    }
  }

  /**
   * Drains a record's pending buffer in arrival order. Synchronous — no bus
   * event can interleave between the flush and clearing the flag.
   *
   * @param record - Record whose buffer is flushed to its exporter.
   */
  function flushPending(record: RuntimeSessionRecord): void {
    const pending = record.pending ?? [];
    record.pending = [];
    for (const entry of pending) {
      if (!record.exporter) {
        return;
      }
      if (entry.kind === 'part') {
        record.exporter.writePart(entry.payload);
      } else if (entry.kind === 'idle') {
        record.exporter.writeIdle(entry.payload as Record<string, unknown>);
      } else {
        record.exporter.writeMessage(entry.payload);
      }
    }
  }

  /**
   * Collects message ids already present in a transcript file, tolerating
   * missing files and torn/unparseable lines (single pass).
   *
   * @param transcriptPath - Transcript file to scan, when known.
   * @returns Seen message ids (`data.id` of `message`-type lines).
   */
  function collectSeenMessageIds(transcriptPath: string | undefined): Set<string> {
    const seen = new Set<string>();
    if (!transcriptPath) {
      return seen;
    }
    let content: string;
    try {
      content = deps.io.readTextFileSync(transcriptPath);
    } catch {
      // Absent or unreadable file — nothing has been exported yet.
      return seen;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { type?: unknown; data?: { id?: unknown } } | null;
        if (parsed?.type === 'message' && typeof parsed.data?.id === 'string') {
          seen.add(parsed.data.id);
        }
      } catch {
        // Torn tail tolerance mirrors CONTRACT-C readers.
      }
    }
    return seen;
  }

  /**
   * Resume backfill: replays stored history that previous runs never
   * exported, then releases the buffered live lines. Children never
   * reconcile (plan non-goal). Any failure degrades to live-only; partial
   * imports self-heal at the next start's reconciliation because suppression
   * is message-granularity over what the file already holds.
   *
   * @param sessionId - Root session being reconciled.
   * @param record - The session's tracking record (exporter + buffer).
   * @param log - Bundle logger.
   */
  async function reconcileHistory(sessionId: string, record: RuntimeSessionRecord, log: OpencodeLog): Promise<void> {
    try {
      if (!loadSessionHistory) {
        return;
      }
      const seen = collectSeenMessageIds(record.transcriptPath);
      const history = await loadSessionHistory(sessionId);
      let messages = 0;
      let parts = 0;
      for (const entry of history) {
        const id = entry.info['id'];
        if (typeof id === 'string' && seen.has(id)) {
          continue;
        }
        record.exporter?.writeMessage(entry.info);
        messages += 1;
        for (const part of entry.parts) {
          record.exporter?.writePart(part);
          parts += 1;
        }
      }
      if (messages > 0) {
        await log.info(`reconciled ${messages} historical messages (${parts} parts)`, { sessionId });
      }
    } catch (error) {
      try {
        await log.warn('Failed to reconcile historical messages; continuing live-only', {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // Logging must never escalate a degraded backfill into a host crash.
      }
    } finally {
      try {
        flushPending(record);
      } catch {
        // A failing flush must not mask the outcome or kill the host.
      }
      record.reconciling = false;
    }
  }

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);
    // Resume backfill source: injected override or the SDK client captured
    // from this plugin's init input (loopback into the co-located server).
    loadSessionHistory = deps.loadSessionHistory ?? createSdkSessionHistory(client);

    return {
      event: async ({ event }) =>
        guarded(log, 'runtime session-start event', async () => {
          switch (event.type) {
            case 'session.created': {
              const info: SessionLike & { version?: string } = {
                id: event.properties.info.id,
                parentID: event.properties.info.parentID,
                version: event.properties.info.version
              };
              // A deleted id never re-enters classification (fail-closed).
              if (deletedSessions.has(info.id)) {
                return;
              }
              registry.observe(info);
              if (!registry.isRoot(info.id)) {
                // Child created: no content lines yet, but open its exporter
                // (meta with parentSessionId) once the root has started. A
                // child announcing created before its parent classifies drops
                // here benignly and heals at the child's next activity.
                const rootId = registry.rootAncestorOf(info.id);
                if (rootId !== null) {
                  await ensureChildStarted(rootId, info.id, log, info.version);
                }
                return;
              }
              await ensureStarted(info.id, log, info.version);
              return;
            }
            case 'message.part.updated': {
              const sessionId = event.properties.part.sessionID;
              if (deletedSessions.has(sessionId)) {
                return;
              }
              // Resumed sessions surface here first — classify and start.
              if (registry.noteObserved(sessionId)) {
                await ensureStarted(sessionId, log);
              }
              if (!registry.isRoot(sessionId)) {
                // Child activity streams into the child's own transcript
                // under its top-level root's subagents directory.
                const rootId = registry.rootAncestorOf(sessionId);
                if (rootId === null) {
                  return;
                }
                await ensureChildStarted(rootId, sessionId, log);
                writeToExporter(sessionId, 'part', event.properties.part);
                return;
              }
              writeToExporter(sessionId, 'part', event.properties.part);
              return;
            }
            case 'message.updated': {
              const sessionId = event.properties.info.sessionID;
              if (deletedSessions.has(sessionId)) {
                return;
              }
              if (registry.noteObserved(sessionId)) {
                await ensureStarted(sessionId, log);
              }
              if (!registry.isRoot(sessionId)) {
                const rootId = registry.rootAncestorOf(sessionId);
                if (rootId === null) {
                  return;
                }
                await ensureChildStarted(rootId, sessionId, log);
                writeToExporter(sessionId, 'message', event.properties.info);
                return;
              }
              writeToExporter(sessionId, 'message', event.properties.info);
              return;
            }
            case 'session.idle': {
              // Idle means "the session's turn loop ended", full stop. The
              // gate is deliberately ONLY isRoot — not isSessionIdle(), which
              // reads active-subagent marker files owned by other plugin
              // bundles: a still-active child would suppress the line here and
              // OpenCode never re-fires idle, leaving the header "running"
              // forever. Idle also does not classify (no noteObserved): a
              // session with no prior activity has no exporter to write to,
              // and its idle drops benignly.
              const sessionId = event.properties.sessionID;
              if (!registry.isRoot(sessionId)) {
                return;
              }
              // Rides the same reconciling hold as part/message lines: an idle
              // landing inside the backfill fetch must not precede history.
              writeToExporter(sessionId, 'idle', {});
              return;
            }
            case 'session.deleted': {
              // No session-end event exists on this surface beyond deletion;
              // close the exporter and drop the tracking record. The id is
              // tombstoned for the plugin lifetime — trailing events for a
              // deleted session must never reclassify it as a resumed root.
              // The file itself stays (append-only history — age-based reaping
              // is the exporter reaper's job), and watcher close rides PID
              // death.
              const deletedId = event.properties.info.id;
              deletedSessions.add(deletedId);
              const wasRoot = registry.isRoot(deletedId);
              const record = records.get(deletedId);
              registry.forget(deletedId);
              if (record) {
                record.exporter?.close();
                records.delete(deletedId);
              }
              if (wasRoot) {
                // Deleting a root tears down every child exporter hanging off
                // it — grandchildren too, whose parentId stores the top-level
                // root they stream under.
                for (const [childId, childRecord] of Array.from(records)) {
                  if (childRecord.parentId === deletedId) {
                    childRecord.exporter?.close();
                    records.delete(childId);
                  }
                }
              }
              return;
            }
            default:
              return;
          }
        }),

      'shell.env': async (input, output) =>
        guarded(log, 'runtime shell.env', async () => {
          // output.env is stateless per call — re-derive the injection from
          // plugin state every time. Identity rides the root card session;
          // when OpenCode omits the session id, fall back to attributing the
          // execution to the sole tracked root session when exactly one is
          // live (the Cards launcher spawns one session at a time).
          let sessionId = input.sessionID;
          if (sessionId && deletedSessions.has(sessionId)) {
            // Deleted id: never reclassify, never inject.
            return;
          }
          if (sessionId && registry.noteObserved(sessionId)) {
            // Resumed sessions first surface here — classify, then start so
            // the transcript path this call injects actually exists.
            await ensureStarted(sessionId, log);
          }
          if (!sessionId) {
            const roots = registry.rootIds().filter((id) => records.has(id));
            sessionId = roots.length === 1 ? (roots[0] as string) : undefined;
          }
          if (!sessionId || !registry.isRoot(sessionId)) {
            return;
          }
          const record = records.get(sessionId);
          if (!record?.transcriptPath) {
            return;
          }
          output.env['CARDS_SESSION_ID'] = sessionId;
          output.env['OPENCODE_RUN_ID'] = sessionId;
          output.env['CARDS_TRANSCRIPT_PATH'] = record.transcriptPath;
        }),

      'experimental.chat.system.transform': async (input, output) =>
        guarded(log, 'runtime system.transform', async () => {
          if (!input.sessionID) {
            // Verified platform behavior: the transform input carries an
            // optional session id. Without it there is no way to attribute the
            // request — skip with a named warning rather than guessing.
            await log.warn('system.transform fired without a sessionID; card context injection skipped');
            return;
          }
          if (deletedSessions.has(input.sessionID)) {
            // Deleted id: never reclassify, never inject.
            return;
          }
          if (registry.noteObserved(input.sessionID)) {
            // Resumed sessions classify here on their next prompt.
            await ensureStarted(input.sessionID, log);
          }
          const fragment = records.get(input.sessionID)?.contextFragment;
          if (fragment === undefined) {
            return;
          }
          // Mutate-in-place (verified trigger site): append the cached
          // env/log blocks as an every-turn system fragment.
          output.system.push(fragment);
        })
    };
  };
}

// ---------------------------------------------------------------------------
// SessionStart(compact)
// ---------------------------------------------------------------------------

/**
 * Creates the post-compaction reminder plugin.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `experimental.session.compacting`.
 */
export function createSessionStartAfterCompactionPlugin(
  deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()
): Plugin {
  const registry = createRootSessionRegistry();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'compaction registry event', () => {
          if (event.type === 'session.created') {
            registry.observe({ id: event.properties.info.id, parentID: event.properties.info.parentID });
          }
        }),

      'experimental.session.compacting': async (input, output) =>
        guarded(log, 'compaction reminder', async () => {
          // Resumed sessions never re-emit `created`; their first compaction
          // classifies them as roots under registry rule (b).
          registry.noteObserved(input.sessionID);
          if (!registry.isRoot(input.sessionID)) {
            return;
          }
          // After compaction the agent loses conversation history; push the
          // routing reminder so the next turn re-evaluates routing.
          output.context.push(ROUTING_REMINDER);
        })
    };
  };
}

// ---------------------------------------------------------------------------
// Stop nudges (log-channel announcements)
// ---------------------------------------------------------------------------

/** Shape of CARD.meta.json fields the merge nudge consults. */
interface CardMeta {
  tags?: string[];
  gates?: {
    mergeRequestRequired?: boolean;
    mergeApproved?: boolean;
  };
}

/**
 * Reads and parses CARD.meta.json for merge-gating decisions.
 *
 * @param deps - Handler dependencies (filesystem seam).
 * @param cardRepoPath - Absolute card repository path.
 * @returns Parsed metadata.
 */
function readCardMeta(deps: OpencodeHandlerDeps, cardRepoPath: string): CardMeta {
  return JSON.parse(deps.io.readTextFileSync(join(cardRepoPath, 'CARD.meta.json'))) as CardMeta;
}

/**
 * Creates the merge route-nudge plugin (notify-only degradation).
 *
 * On Codex this hook returns `decision: 'block'`; OpenCode plugins cannot
 * block a turn, so when all Codex conditions hold the nudge content is
 * announced through the log channels with a named warning instead.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event`/`session.idle` handling.
 */
export function createStopRouteNudgePlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'stop-route-nudge', async () => {
          if (event.type === 'session.created') {
            registry.observe({ id: event.properties.info.id, parentID: event.properties.info.parentID });
            return;
          }
          if (event.type !== 'session.idle') {
            return;
          }
          const sessionId = event.properties.sessionID;
          // Resumed sessions never re-emit `created`; their first idle classifies.
          registry.noteObserved(sessionId);
          if (!registry.isRoot(sessionId)) {
            return;
          }

          let cardRepoPath: string;
          let workspacePath: string;
          let baseBranch: string;
          let workspaceBranch: string;
          try {
            cardRepoPath = getCardRepoPath();
            workspacePath = getWorkspacePath();
            baseBranch = getBaseBranch();
            workspaceBranch = getWorkspaceBranch();
          } catch {
            // Not a Cards action subprocess (user-scope install) — stay silent.
            return;
          }

          if (!isSessionIdle(sessionId)) {
            return;
          }
          if (deps.markers.hasRouteNudgeFired(sessionId)) {
            return;
          }

          let meta: CardMeta;
          try {
            meta = readCardMeta(deps, cardRepoPath);
          } catch {
            await log.warn('stop-route-nudge: failed to read CARD.meta.json', { cardRepoPath });
            return;
          }

          const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
          if (tags.includes('blocked')) {
            return;
          }
          const mergeRequestRequired = meta.gates?.mergeRequestRequired === true;
          const mergeApproved = meta.gates?.mergeApproved === true;
          if (mergeRequestRequired && !mergeApproved) {
            return;
          }

          let count: number;
          try {
            count = deps.unmergedCommitCount(workspacePath, baseBranch, workspaceBranch);
          } catch {
            await log.warn('stop-route-nudge: git rev-list failed', { workspacePath });
            return;
          }
          if (count === 0) {
            return;
          }

          try {
            deps.markers.markRouteNudgeFired(sessionId);
          } catch {
            await log.warn('stop-route-nudge: failed to write route-nudge marker', { sessionId });
            return;
          }

          // Named degradation: OpenCode plugins cannot block the turn, so the
          // merge nudge ships as a notification instead of a blocking reason.
          await log.warn(
            [
              'Cards merge nudge (notify-only: OpenCode plugins cannot block a turn):',
              `Workspace branch \`${workspaceBranch}\` has ${count} commit(s) not merged into \`${baseBranch}\`.`,
              'If validation and evaluation have passed and no scope remains, read',
              `${deps.mergeRunbookPath()} and follow its <instructions> to merge.`,
              'Otherwise load the `card` skill and follow its <routing-instructions>.'
            ].join('\n'),
            { sessionId, workspaceBranch, baseBranch, unmergedCount: count }
          );
        })
    };
  };
}

/**
 * Creates the exit-when-done nudge plugin.
 *
 * Fires at most once per idle root session launched with
 * `EXIT_WHEN_DONE=true` and announces the shutdown protocol through the log
 * channels: it instructs the model to run `cards "$CARD_ID" shutdown`, and
 * the action handler — parent of this process — performs the graceful
 * termination in response. Mirrors the Codex Stop hook
 * (`../../codex/runtime/stop-exit-when-done.ts`), adapted from a per-turn
 * hook to OpenCode's idle event.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event`/`session.idle` handling.
 */
export function createStopExitWhenDonePlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'stop-exit-when-done', async () => {
          if (event.type === 'session.created') {
            registry.observe({ id: event.properties.info.id, parentID: event.properties.info.parentID });
            return;
          }
          if (event.type !== 'session.idle') {
            return;
          }
          const sessionId = event.properties.sessionID;
          // Resumed sessions never re-emit `created`; their first idle classifies.
          registry.noteObserved(sessionId);
          if (!registry.isRoot(sessionId)) {
            return;
          }

          const actionInput = deps.loadActionInput();
          if (!actionInput?.exitWhenDone) {
            return;
          }

          if (!isSessionIdle(sessionId)) {
            return;
          }
          if (deps.markers.hasExitWhenDoneFired(sessionId)) {
            return;
          }
          try {
            deps.markers.markExitWhenDoneFired(sessionId);
          } catch {
            await log.warn('stop-exit-when-done: failed to write exit-when-done marker', { sessionId });
            return;
          }

          await log.warn(
            [
              'Cards exit-when-done nudge: EXIT_WHEN_DONE=true is set for this session — a reminder for when work is done, not a signal to stop now.',
              `Once the card's work is finished and validated, read ${deps.shutdownRunbookPath()} and follow its <instructions>: confirm the outcome, run \`cards "$CARD_ID" shutdown --outcome success|blocked|error --message "..."\`, then end the session.`,
              'The action handler terminates the launcher gracefully in response to the signal.'
            ].join('\n'),
            { sessionId }
          );
        })
    };
  };
}

// ---------------------------------------------------------------------------
// Subagent tracking
// ---------------------------------------------------------------------------

/**
 * Creates the SubagentStart-equivalent plugin.
 *
 * OpenCode subagents are real child sessions; `session.created` payloads carry
 * the `parentID` link. When the parent is a tracked root session, the child is
 * added to its active-subagent tracking file — best-effort, degraded with a
 * warning on failure.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event` handling.
 */
export function createSubagentStartPlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'subagent-start', async () => {
          if (event.type !== 'session.created') {
            return;
          }
          const info: SessionLike = { id: event.properties.info.id, parentID: event.properties.info.parentID };
          registry.observe(info);
          const parentID = event.properties.info.parentID;
          if (!parentID) {
            return;
          }
          // A resumed root never re-announces `created`, so its child's
          // created event is the parent's first observation — rule (b).
          registry.noteObserved(parentID);
          if (!registry.isRoot(parentID)) {
            return;
          }
          try {
            await deps.markers.addActiveSubagent(parentID, info.id);
          } catch (error) {
            await log.warn('Failed to record active subagent', {
              sessionId: parentID,
              agentId: info.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })
    };
  };
}

/**
 * Creates the SubagentStop-equivalent plugin.
 *
 * When a tracked child session goes idle — or is deleted without going idle —
 * it is removed from the parent's active-subagent tracking so the session can
 * reach a genuine idle state. Best-effort with graceful degradation.
 *
 * @param deps - Injectable edges; defaults wire the real SDK.
 * @returns An OpenCode plugin registering `event` handling.
 */
export function createSubagentStopPlugin(deps: OpencodeHandlerDeps = defaultOpencodeHandlerDeps()): Plugin {
  const registry = createRootSessionRegistry();
  /** Child sessions observed with their tracking parent. */
  const children = new Map<string, string>();

  return async ({ client, directory }) => {
    const log = buildLogger(directory, deps, client);

    return {
      event: async ({ event }) =>
        guarded(log, 'subagent-stop', async () => {
          if (event.type === 'session.created') {
            const info: SessionLike = { id: event.properties.info.id, parentID: event.properties.info.parentID };
            registry.observe(info);
            const parentID = event.properties.info.parentID;
            if (parentID) {
              // A resumed root never re-announces `created`; classify it from
              // its child's created event (rule (b)) before tracking.
              registry.noteObserved(parentID);
              if (registry.isRoot(parentID)) {
                children.set(info.id, parentID);
              }
            }
            return;
          }

          if (event.type === 'session.deleted') {
            // A child destroyed without going idle (crash, cancel) must not
            // leak its tracking entry — the parent could never reach a
            // genuine idle state otherwise.
            const deletedChildId = event.properties.info.id;
            const deletedParentId = children.get(deletedChildId);
            if (deletedParentId === undefined) {
              return;
            }
            children.delete(deletedChildId);
            try {
              await deps.markers.removeActiveSubagent(deletedParentId, deletedChildId);
            } catch (error) {
              await log.warn('Failed to remove active subagent after deletion', {
                sessionId: deletedParentId,
                agentId: deletedChildId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
            return;
          }

          if (event.type !== 'session.idle') {
            return;
          }
          const childId = event.properties.sessionID;
          const parentId = children.get(childId);
          if (!parentId) {
            return;
          }

          try {
            await deps.markers.removeActiveSubagent(parentId, childId);
            children.delete(childId);
          } catch (error) {
            await log.warn('Failed to remove active subagent', {
              sessionId: parentId,
              agentId: childId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })
    };
  };
}

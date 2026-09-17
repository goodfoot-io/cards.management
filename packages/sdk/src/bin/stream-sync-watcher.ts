/**
 * Wrapper-owned, runtime-agnostic transcript-sync watcher process.
 *
 * Spawned by session-start with a single argv argument — a serialized
 * {@link SessionSyncManifest} (see `../transcript-sync/manifest.ts`) — this
 * process syncs every file the manifest describes from its `watchRoot` into
 * `<cardRepoPath>/streams/<streamType>/`, using the engine modules under
 * `../transcript-sync/engine/`. It is a manifest-driven implementation that
 * serves both Claude Code and Codex sessions.
 *
 * Startup is fail-closed and REGISTERS FIRST: this process runs with
 * `stdio: 'ignore'`, so once spawned its exit code is invisible to the parent.
 * The control-socket registration (which gives the extension a channel to
 * observe and stop this process) happens before manifest validation, so even
 * a malformed manifest is reported via an `error` event on that channel
 * rather than vanishing silently. If registration itself cannot happen (the
 * server is down, or even the minimal sessionId/cardId extraction fails),
 * nothing else is possible and the process exits nonzero.
 *
 * The control channel here survives an extension restart: it is a
 * {@link createReconnectingWatcher} channel, which
 * re-registers with capped exponential backoff on an unexpected disconnect
 * instead of exiting — sync work keeps running underneath a dropped socket.
 *
 * @summary Manifest-driven transcript-sync watcher — composition root
 */

import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WatcherContext } from '../config/watcher/context.js';
import { createReconnectingWatcher, type ReconnectingWatcherHandle } from '../config/watcher/reconnectingWatcher.js';
import { commitSessionClose, sentinelExists } from '../transcript-sync/engine/commit.js';
import { recordExecutionFinalization } from '../transcript-sync/engine/execution-finalization.js';
import { acquireFinalizationLock } from '../transcript-sync/engine/finalization-lock.js';
import { ensureGitignoreEntry } from '../transcript-sync/engine/gitignore.js';
import {
  MAX_LIFETIME_MS,
  runWatcherLoop,
  STEADY_TICK_INTERVAL_MS,
  WATCH_INSTALL_RETRY_INTERVAL_MS
} from '../transcript-sync/engine/lifecycle.js';
import { assertSupportedPatterns, matchSource } from '../transcript-sync/engine/matcher.js';
import { Reconciler } from '../transcript-sync/engine/reconciler.js';
import { recoverCursor } from '../transcript-sync/engine/recovery.js';
import { cleanupSessionArtifacts } from '../transcript-sync/engine/session-artifacts.js';
import { writeSessionStatus } from '../transcript-sync/engine/session-status.js';
import {
  SQLITE_POLL_STEADY_INTERVAL_MS,
  SqlitePollEngine,
  type SqlitePollOutcome
} from '../transcript-sync/engine/sqlite-poll.js';
import { buildStatusHeartbeat, MainFileInvariantChecker } from '../transcript-sync/engine/status.js';
import { SyncChain } from '../transcript-sync/engine/sync-chain.js';
import { finalizeSqlitePollSession } from '../transcript-sync/engine/termination-flush.js';
import { WatchInstaller } from '../transcript-sync/engine/watch-installer.js';
import { parseManifest, type SessionSyncManifest, type SqlitePollSourceSpec } from '../transcript-sync/manifest.js';
import { isProcessAlive } from './process-utils.js';

/** What asked this watcher to finalize. */
export type FinalizationTrigger = 'control-stop' | 'sigterm' | 'local';

/**
 * The one way this watcher is asked to wind down, shared by every path that can
 * ask.
 *
 * It exists because the watcher is now an ordinary same-session background
 * process rather than a detached one: the wrapper stops it with a signal, and a
 * signal arrives whether or not a control socket is connected. Routing
 * `ctx.onControl('stop')` and `SIGTERM` through the same idempotent entry point
 * is what keeps an API outage from turning a five-second graceful window into a
 * five-second sleep the watcher never wakes from.
 *
 * {@link FinalizationController.sleep} replaces the loop's plain timer so that
 * a request lands immediately instead of at the end of the current tick.
 */
export interface FinalizationController {
  /** Stop signal handed to {@link runWatcherLoop}. */
  readonly signal: { stopped: boolean };
  /** Interruptible sleep handed to {@link runWatcherLoop}. */
  readonly sleep: (ms: number) => Promise<void>;
  /** What first requested finalization, or `null` while none has. */
  readonly trigger: FinalizationTrigger | null;
  /**
   * Marks stop, wakes the steady-loop sleep, and starts the finalizer. Safe to
   * call any number of times from any path: the finalizer runs at most once and
   * every caller awaits the same settlement.
   *
   * @param trigger - What is asking; only the first caller's value is recorded.
   * @returns Settlement of the one finalizer run.
   */
  requestFinalization(trigger: FinalizationTrigger): Promise<void>;
  /** Removes the process-level signal handler this controller installed. */
  dispose(): void;
}

/**
 * Builds the shared finalization controller and installs its `SIGTERM` handler.
 *
 * @param finalize - The session's existing finalizer; invoked at most once.
 * @returns A controller whose `signal` and `sleep` drive {@link runWatcherLoop}.
 */
export function createFinalizationController(finalize: () => Promise<void>): FinalizationController {
  interface SleepWaiter {
    readonly resolve: () => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  }

  const signal = { stopped: false };
  const waiters = new Set<SleepWaiter>();
  let trigger: FinalizationTrigger | null = null;
  let settlement: Promise<void> | null = null;

  function requestFinalization(requested: FinalizationTrigger): Promise<void> {
    trigger ??= requested;
    signal.stopped = true;
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve();
    }
    settlement ??= Promise.resolve().then(finalize);
    void settlement.catch(() => undefined);
    return settlement;
  }

  const onSigterm = (): void => {
    void requestFinalization('sigterm');
  };
  process.on('SIGTERM', onSigterm);

  return {
    signal,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        if (signal.stopped) {
          resolve();
          return;
        }
        const waiter: SleepWaiter = { resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, ms);
        waiters.add(waiter);
      }),
    get trigger(): FinalizationTrigger | null {
      return trigger;
    },
    requestFinalization,
    dispose: () => {
      process.off('SIGTERM', onSigterm);
    }
  };
}

/** Minimal identity extracted from the raw manifest argv for registration purposes only. */
export interface MinimalIdentity {
  sessionId: string;
  cardId: string;
}

/**
 * Extracts just `sessionId`/`cardId` from the raw manifest JSON, without full
 * schema validation — enough to register a watcher identity before the
 * manifest itself has been validated. Returns `null` on any parse or shape
 * failure; the caller must exit nonzero in that case, since nothing else is
 * possible without even this much.
 *
 * @param raw - The raw argv manifest JSON string.
 * @returns The extracted identity, or `null` if it cannot be extracted.
 */
export function parseMinimalIdentity(raw: string): MinimalIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const sessionId = obj['sessionId'];
  const cardId = obj['cardId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof cardId !== 'string' || cardId.length === 0) return null;
  return { sessionId, cardId };
}

async function listExistingDestFiles(destRoot: string): Promise<string[]> {
  const result: string[] = [];
  await walk(destRoot, '', result);
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
      continue;
    }
    if (isDir) {
      await walk(absPath, relPath, result);
    } else {
      result.push(relPath);
    }
  }
}

/**
 * Recovers cursors for every pre-existing destination file that matches a
 * manifest source, so a restarted watcher resumes instead of re-tailing from
 * zero (which would duplicate lines already committed). A file whose recovery
 * fails is marked permanently failed and excluded from syncing — see
 * `../transcript-sync/engine/recovery.ts` for why this is a detect-and-fatal
 * condition with no fallback.
 *
 * @param manifest - The session's manifest, whose sources determine which destination files are recovered.
 * @param reconciler - Receives the recovered (or failed) cursor for each matched file.
 * @param destRoot - Absolute path to `<cardRepoPath>/streams/<streamType>`.
 * @param ctx - Used to emit an `error` event for each recovery failure.
 * @param errorFn - Called with a message for each recovery failure.
 * @returns Resolves once every pre-existing destination file has been processed.
 */
async function recoverExistingFiles(
  manifest: SessionSyncManifest,
  reconciler: Reconciler,
  destRoot: string,
  ctx: WatcherContext,
  errorFn: (message: string) => void
): Promise<void> {
  const existing = await listExistingDestFiles(destRoot);
  for (const relPath of existing) {
    const spec = matchSource(relPath, manifest.sources);
    if (!spec) continue;

    const srcPath = join(manifest.watchRoot, relPath);
    const destPath = join(destRoot, relPath);
    const result = await recoverCursor(srcPath, destPath);

    if ('error' in result) {
      reconciler.markFailed(relPath, spec, result.error);
      errorFn(`stream-sync-watcher: recovery failed for "${relPath}": ${result.error}`);
      ctx.emit({ type: 'error', data: { relPath, message: result.error } });
    } else {
      reconciler.seedRecoveredCursor(relPath, spec, result.cursor);
    }
  }
}

/**
 * Creates the poll engine for a v2 sqlite-poll manifest. The manifest is
 * homogeneous (exactly one main sqlite-poll source — enforced by
 * `parseManifest`), so the first source is the poll spec.
 *
 * Shared by {@link runSession}'s poll branch and the composition fixture —
 * this seam is the real watcher attach path for polled sessions.
 *
 * @param manifest - The validated v2 manifest.
 * @param warnFn - Warning sink for recoverable conditions.
 * @returns The engine bound to the manifest's DB and destination stream.
 */
export function createPollEngine(manifest: SessionSyncManifest, warnFn: (message: string) => void): SqlitePollEngine {
  const spec = manifest.sources[0] as SqlitePollSourceSpec;
  const destRoot = join(manifest.cardRepoPath, 'streams', manifest.streamType);
  return new SqlitePollEngine({
    manifest,
    spec,
    destPath: join(destRoot, `${spec.pattern}.jsonl`),
    warnFn,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  });
}

/**
 * Runs the poll session for a v2 sqlite-poll manifest: attach (destination
 * scan + sidecar rebuild), the steady poll loop, and every shutdown path.
 * There is nothing to `fs.watch` — polling IS the sync mechanism — so the
 * watch installer and file reconciler are not used.
 *
 * @param manifest - The validated v2 manifest (single sqlite-poll source).
 * @param handle - The already-registered reconnecting control channel.
 */
async function runPollSession(manifest: SessionSyncManifest, handle: ReconnectingWatcherHandle): Promise<void> {
  const { ctx } = handle;
  const warnFn = (message: string) => ctx.logger.warn(message);
  const errorFn = (message: string) => ctx.logger.error(message);

  const engine = createPollEngine(manifest, warnFn);
  const spec = manifest.sources[0] as SqlitePollSourceSpec;
  const lockPath = `${spec.sidecarPath}.finalize.lock`;
  const attachRelease = await acquireFinalizationLock(lockPath, 10_000);
  if (attachRelease === null) {
    throw new Error(`stream-sync-watcher: could not acquire sqlite-poll mutation lock at ${lockPath} during attach`);
  }
  try {
    await engine.attach();
  } finally {
    await attachRelease();
  }

  const startedAt = new Date().toISOString();
  await writeSessionStatus(manifest, { startedAt, fileFailures: {} });

  let closed = false;
  const closeSession = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // The live watcher and launcher-owned takeover share one persisted-
    // manifest finalizer. This closes the race where both owners could append
    // the same terminal row after the child exits.
    const finalization = await finalizeSqlitePollSession({ manifest, startedAt, warnFn, errorFn });
    if (finalization.kind === 'degraded') {
      errorFn(`stream-sync-watcher: final transcript drain degraded (${finalization.reason}): ${finalization.detail}`);
      ctx.emit({ type: 'error', data: { message: finalization.detail } });
    }
    await recordExecutionFinalization(manifest, finalization.kind === 'flushed');
  };

  const controller = createFinalizationController(closeSession);
  ctx.onControl('stop', () => controller.requestFinalization('control-stop'));

  ctx.emit({ type: 'watching', data: null });

  const { maxLifetimeExceeded } = await runWatcherLoop({
    signal: controller.signal,
    checkSentinel: () => sentinelExists(manifest),
    checkAlive: () => isProcessAlive(manifest.monitorPid),
    now: () => Date.now(),
    sleep: controller.sleep,
    onMaxLifetime: () =>
      warnFn(`stream-sync-watcher: exceeded maximum lifetime (${String(MAX_LIFETIME_MS)}ms), exiting`),
    onTick: async () => {
      const release = await acquireFinalizationLock(lockPath);
      if (release === null) {
        // A launcher-owned finalizer may be taking over after child exit. Do
        // not mutate destination/sidecar state concurrently; the next loop
        // lifecycle check observes its sentinel/monitor transition.
        warnFn(`stream-sync-watcher: sqlite-poll mutation lock is busy at ${lockPath}; yielding this poll tick`);
        return SQLITE_POLL_STEADY_INTERVAL_MS;
      }
      let outcome: SqlitePollOutcome;
      try {
        outcome = await engine.pollOnce();
      } finally {
        await release();
      }
      if (outcome.kind === 'absence-expired' || outcome.kind === 'permanent-unavailable') {
        // Named terminal outcomes — never a hang or silent vanish.
        errorFn(`stream-sync-watcher: ${outcome.detail}`);
        ctx.emit({ type: 'error', data: { message: outcome.detail } });
        await controller.requestFinalization('local');
        return 0;
      }
      return SQLITE_POLL_STEADY_INTERVAL_MS;
    }
  });

  try {
    if (controller.trigger === 'control-stop') {
      await handle.waitForStop();
      return;
    }
    await controller.requestFinalization('local');
    if (!maxLifetimeExceeded) {
      cleanupSessionArtifacts(manifest.sessionId, warnFn);
    }
    handle.shutdown();
  } finally {
    controller.dispose();
  }
}

/**
 * Runs the full sync session for a validated manifest: recovery, initial
 * reconcile, watch install, the steady-tick loop, and every shutdown path.
 * A v2 sqlite-poll manifest routes to {@link runPollSession} instead.
 *
 * @param manifest - The validated manifest to sync.
 * @param handle - The already-registered reconnecting control channel.
 */
export async function runSession(manifest: SessionSyncManifest, handle: ReconnectingWatcherHandle): Promise<void> {
  if (manifest.version === 2) {
    await runPollSession(manifest, handle);
    return;
  }

  const { ctx } = handle;
  const warnFn = (message: string) => ctx.logger.warn(message);
  let reportedError = false;
  const errorFn = (message: string): void => {
    reportedError = true;
    ctx.logger.error(message);
  };

  const destRoot = join(manifest.cardRepoPath, 'streams', manifest.streamType);
  await mkdir(destRoot, { recursive: true });
  await ensureGitignoreEntry(manifest.cardRepoPath);

  const startedAt = new Date().toISOString();
  await writeSessionStatus(manifest, { startedAt, fileFailures: {} });

  const reconciler = new Reconciler(manifest);
  await recoverExistingFiles(manifest, reconciler, destRoot, ctx, errorFn);
  await reconciler.reconcileOnce(warnFn, errorFn);

  const chain = new SyncChain();
  const watchInstaller = new WatchInstaller({ manifest, reconciler, chain, warnFn, errorFn });
  const mainInvariantChecker = new MainFileInvariantChecker();

  let closed = false;
  const closeSession = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    watchInstaller.close();
    await chain.drain();
    await reconciler.reconcileOnce(warnFn, errorFn);
    await commitSessionClose(manifest, warnFn, errorFn);

    const fileFailures: Record<string, string> = {};
    for (const state of reconciler.getFileStates()) {
      if (state.failed !== undefined) fileFailures[state.relPath] = state.failed;
    }
    await writeSessionStatus(manifest, { startedAt, closedAt: new Date().toISOString(), fileFailures });
    await recordExecutionFinalization(
      manifest,
      !reportedError &&
        Object.keys(fileFailures).length === 0 &&
        reconciler.getFileStates().some((state) => state.role === 'main')
    );
  };

  await watchInstaller.tryInstall();

  const controller = createFinalizationController(closeSession);
  ctx.onControl('stop', () => controller.requestFinalization('control-stop'));

  ctx.emit({ type: 'watching', data: null });

  const { maxLifetimeExceeded } = await runWatcherLoop({
    signal: controller.signal,
    checkSentinel: () => sentinelExists(manifest),
    checkAlive: () => isProcessAlive(manifest.monitorPid),
    now: () => Date.now(),
    sleep: controller.sleep,
    onMaxLifetime: () =>
      warnFn(`stream-sync-watcher: exceeded maximum lifetime (${String(MAX_LIFETIME_MS)}ms), exiting`),
    onTick: async () => {
      if (!watchInstaller.isInstalled()) {
        const installed = await watchInstaller.tryInstall();
        return installed ? STEADY_TICK_INTERVAL_MS : WATCH_INSTALL_RETRY_INTERVAL_MS;
      }

      const states = reconciler.getFileStates();
      const heartbeat = buildStatusHeartbeat(states);
      ctx.emit({ type: heartbeat.type, data: { files: heartbeat.files } });

      const mainState = states.find((state) => state.role === 'main');
      const invariantError = mainInvariantChecker.check(mainState);
      if (invariantError) {
        errorFn(invariantError);
        ctx.emit({ type: 'error', data: { message: invariantError } });
      }

      // fs.watch is best-effort and can silently drop events; re-run a full
      // pass through the sync chain each steady tick so anything missed is
      // eventually caught. A pass with nothing new is a cheap no-op.
      chain.push(() => reconciler.reconcileOnce(warnFn, errorFn), warnFn);

      return STEADY_TICK_INTERVAL_MS;
    }
  });

  try {
    if (controller.trigger === 'control-stop') {
      // The control callback already finalized, and the reconnecting watcher's
      // own stop machinery still needs to send the stop-ack and end the socket.
      // Wait for it instead of racing it — calling handle.shutdown() here could
      // destroy the socket before the stop-ack goes out. Only a remote stop
      // produces that ack; a signal or a local terminal outcome must not wait
      // on a peer that was never asked.
      await handle.waitForStop();
      return;
    }
    await controller.requestFinalization('local');
    if (!maxLifetimeExceeded) {
      cleanupSessionArtifacts(manifest.sessionId, warnFn);
    }
    handle.shutdown();
  } finally {
    controller.dispose();
  }
}

/**
 * Main entry point for the stream-sync-watcher process.
 *
 * argv contract: exactly one argument, `process.argv[2]`, holding the
 * serialized manifest JSON produced by
 * {@link import('../transcript-sync/manifest.js').serializeManifest}.
 */
export async function main(): Promise<void> {
  const raw = process.argv[2];
  if (typeof raw !== 'string' || raw.length === 0) {
    process.stderr.write('stream-sync-watcher: missing manifest argument\n');
    process.exitCode = 1;
    return;
  }

  const identity = parseMinimalIdentity(raw);
  if (!identity) {
    process.stderr.write('stream-sync-watcher: could not extract sessionId/cardId from manifest argument\n');
    process.exitCode = 1;
    return;
  }

  // Register first: this is the one thing that must succeed before anything
  // else is possible, since a detached stdio-ignored process's exit code is
  // invisible to its parent — without a control channel, a startup failure
  // would otherwise vanish silently.
  const handle = await createReconnectingWatcher({
    watcherId: identity.sessionId,
    cardId: identity.cardId,
    metadata: { sessionId: identity.sessionId }
  });

  let manifest: SessionSyncManifest;
  try {
    manifest = parseManifest(raw);
    assertSupportedPatterns(manifest.sources);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handle.ctx.emit({ type: 'error', data: { message } });
    handle.ctx.logger.error(`stream-sync-watcher: manifest validation failed: ${message}`);
    handle.shutdown();
    process.exitCode = 1;
    return;
  }

  await runSession(manifest, handle);
}

if (process.argv[1]?.endsWith('stream-sync-watcher.mjs') || process.argv[1]?.endsWith('stream-sync-watcher.ts')) {
  main().catch((error) => {
    process.stderr.write(`stream-sync-watcher: fatal error: ${String(error)}\n`);
    process.exitCode = 1;
  });
}

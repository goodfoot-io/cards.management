/**
 * Public API for the transcript-sync engine: the runtime-agnostic sync
 * mechanics that turn a validated {@link SessionSyncManifest} into a running
 * watcher (tailing/copying, matching, restart recovery, lifecycle, status,
 * and close-time commit).
 *
 * @summary Transcript-sync engine barrel
 * @module
 */

export { commitSessionClose, removeSentinelFile, sentinelExists, sentinelPath } from './commit.js';
export {
  EXECUTION_FINALIZATION_DIR_ENV,
  readExecutionFinalization,
  recordExecutionFinalization,
  registerExecutionFinalization,
  SESSION_FINALIZATION_FILE_ENV
} from './execution-finalization.js';
export { ensureGitignoreEntry } from './gitignore.js';
export {
  type LifecycleDeps,
  MAX_LIFETIME_MS,
  runWatcherLoop,
  STEADY_TICK_INTERVAL_MS,
  WATCH_INSTALL_RETRY_INTERVAL_MS
} from './lifecycle.js';
export { assertSupportedPatterns, matchSource, UnsupportedPatternError } from './matcher.js';
export { type FileSyncState, Reconciler } from './reconciler.js';
export {
  RECOVERY_VERIFY_TAIL_BYTES,
  type RecoveredCursor,
  type RecoveryFailure,
  recoverCursor
} from './recovery.js';
export {
  type SessionStatus,
  type SessionStatusFile,
  sessionStatusPath,
  writeSessionStatus
} from './session-status.js';
export {
  SQLITE_POLL_ABSENCE_BOUND_MS,
  SQLITE_POLL_BUSY_RETRY_ATTEMPTS,
  SQLITE_POLL_BUSY_TIMEOUT_MS,
  SQLITE_POLL_REHASH_ROWS_PER_TICK,
  SQLITE_POLL_STEADY_INTERVAL_MS,
  type SqlitePollDeps,
  SqlitePollEngine,
  type SqlitePollFlushOutcome,
  type SqlitePollOutcome
} from './sqlite-poll.js';
export {
  buildStatusHeartbeat,
  type FileStatus,
  MainFileInvariantChecker,
  type StatusHeartbeat
} from './status.js';
export { SyncChain } from './sync-chain.js';
export { type TailerCursor, tailAppend } from './tailer.js';
export {
  type FinalizePersistedSqlitePollSessionOptions,
  type FinalizeSqlitePollSessionOptions,
  finalizePersistedSqlitePollSession,
  finalizeSqlitePollSession,
  type SqlitePollFinalizationDegradation,
  type SqlitePollFinalizationOutcome
} from './termination-flush.js';
export { WatchInstaller, type WatchInstallerDeps } from './watch-installer.js';

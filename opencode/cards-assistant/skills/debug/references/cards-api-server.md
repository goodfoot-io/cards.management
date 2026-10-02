# Cards API Server Reference

Scope: the Cards API server's discovery file schema, database settings, liveness states, and recovery constants.

## Discovery File

**Path**: `~/.cards/cards-api.json` (production) or `~/.cards/edh/{edhId}/storage/cards-api.json` (EDH).

**Overridden by**: `$CARDS_DISCOVERY_PATH`.

**Resolution**: `discoverApiInfo()` → `$CARDS_DISCOVERY_PATH` → `{resolveGlobalCardsConfigDir()}/cards-api.json`.

**Written by**: the extension's Cards API startup routine, on the window that owns the server. Atomic write: temp file at `{path}.{6rand}.tmp` with `'wx'` + `0o600`, then `fs.rename`.

### Schema

```json
{
  "port": 52431,
  "host": "127.0.0.1",
  "pid": 12345,
  "accessToken": "<bearer-token>",
  "startedAt": "2026-06-26T14:45:00.000Z",
  "buildTime": 1719432000000,
  "reposPath": "/home/user/.cards/cards-repos",
  "serverIdentity": {
    "serverInstanceId": "owner-lifetime-id",
    "ownerEpoch": 42,
    "protocolVersion": 1,
    "buildTime": 1719432000000
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `port` | number | Yes | Server listen port |
| `host` | string | Yes | Server host (always `127.0.0.1`) |
| `pid` | number | Yes | Server owner process ID |
| `accessToken` | string | Yes | Bearer token for API authentication |
| `startedAt` | string | Yes | ISO 8601 startup timestamp |
| `buildTime` | number | No | Extension build timestamp (epoch ms from `__BUILD_TIME__` esbuild define) |
| `reposPath` | string | No | Path to card repositories directory |
| `serverIdentity` | object | No | Complete owner identity: lifetime ID, durable ownership epoch, protocol version, and matching build time |

Production clients require a complete, protocol-compatible `serverIdentity` for a live owner and verify that authenticated readiness echoes that exact identity before following the descriptor. `buildTime` expresses upgrade preference; it does not establish ownership by itself.

### Lifecycle Watcher

**Source**: the extension's discovery-file watcher (`watchDiscoveryFile()`), run by every window connected to the server.

A watcher (`fs.watch` on parent dir + 5s polling fallback) observes the complete endpoint fingerprint (`port`, `accessToken`, `buildTime`, and `serverIdentity`) and:

- **Requests reconciliation** when the observed endpoint changes or becomes unavailable; the notification does not itself authorize demotion or takeover.
- **Serializes and coalesces observations** so filesystem events and polling cannot race concurrent reconciliation callbacks.
- **Never writes, renames, or deletes discovery**. Only a proven owner may publish or remove its descriptor.

## Liveness States

| State | File | PID | TCP pre-probe | Health check | Meaning |
|-------|------|-----|---------------|--------------|---------|
| Healthy owner | present | alive | reachable | — | Server running — connect as client |
| Slow but healthy | present | alive | timeout | passes within 200ms | Server running under CPU load — connect as client |
| Stale PID | present | alive | dead | — | Port definitively refused/reset/closed — report `not_found`; leave descriptor untouched |
| Crashed owner | present | dead | — | — | Report `not_found`; leave descriptor untouched for owner-authorized recovery |
| Hung port | present | alive | timeout | fails within 200ms | Report `not_found`; health failure alone never authorizes unlink |
| No server | absent | — | — | — | Server never started or crashed |

**Source**: the extension's read-only server-liveness check combines a PID check, a TCP pre-probe, and an HTTP health check. Before binding, connection preparation also validates the complete descriptor identity against authenticated readiness and re-reads the descriptor to reject an owner change during verification.

## Database Settings

**Path**: `~/.cards/cards.db` (production) or `~/.cards/edh/{edhId}/storage/cards.db` (EDH).

**Auxiliary files**: `cards.db-wal`, `cards.db-shm`, `cards.db-journal`.

**Source**: the extension's database-open routine, run once by the server owner on startup.

| Pragma | Value | Purpose |
|--------|-------|---------|
| `locking_mode` | `NORMAL` | Allow concurrent reads while serializing writes |
| `busy_timeout` | `3000` | 3s retry on transient lock contention |
| `journal_mode` | `WAL` | Write-Ahead Logging for concurrent access |
| `synchronous` | `NORMAL` | Durability via WAL checkpoints, not per-transaction fsync |

### Corruption Recovery

On `SQLITE_CORRUPT`, `SQLITE_NOTADB`, `SQLITE_IOERR`, FTS corruption (`vtable constructor failed` or `cards_fts has an unexpected schema`), or `CacheSchemaMismatchError`, the disposable SQLite cache is deleted and rebuilt from the authoritative card Git repositories. A cache schema mismatch is an incompatible read-model layout, not proof that Git data is corrupt; rebuilding restores branch registration metadata and separate invalid-entry evidence. Assignment and execution authority live in the durable runtime admission journal, independently of this cache. WAL/SHM/journal files are also cleaned up. Do not remove card repositories or durable runtime records as part of cache recovery.

**Source**: the extension's database-corruption check, run whenever opening the database fails.

### Unreadable Admission Recovery

An unreadable or invalid live admission causes startup refusal naming the exact file. Preserve it for diagnosis. To explicitly abandon that action, move only that named file into `runtime/admission/quarantine/` under the same runtime root, then reload the window. Create the quarantine directory if needed; leave the admission authority marker, claims and all other records in place. This is manual recovery, not an automatic quarantine command.

The action is then treated as lost, including its assignment protection. Verify or terminate any remaining processes before permitting slot reuse. Moving the file cannot stop its agent. Do not delete the runtime directory or rebuild admissions from the disposable cache. The [journal reader](./packages/cards/server/src/runtime/admission/journal.ts#L271) scans top-level admission JSON files and fails closed on malformed live records.

Utility Git has a 30-second execution deadline followed by bounded best-effort cleanup using Node process groups and operating-system commands. On every platform, detached or reparented descendants can survive. Diagnostics distinguish observed termination, known survivors and incomplete observation; an OS-command exit does not certify that every descendant stopped. Inspect these decisions before retrying a failed mutation. Dirty or unmerged work remains protected independently of process cleanup.

### Lock Conflicts

`SQLITE_BUSY` / `SQLITE_LOCKED` are NOT treated as corruption — they indicate a live server holds the write lock. The caller re-runs discovery and connects as client.

**Source**: the extension's database-lock check, run whenever opening the database fails.

## Recovery Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECOVERY_POLL_INTERVAL_MS` | 500 | Poll interval when waiting for recovery |
| `RECOVERY_POLL_TIMEOUT_MS` | 5000 | Max time to wait for another window's server |
| `HEALTH_CHECK_TIMEOUT_MS` | 3000 | Full HTTP health check timeout |
| `REACHABLE_HEALTH_TIMEOUT_MS` | 1000 | Health check for TCP-pre-probed reachable ports |
| `AMBIGUOUS_HEALTH_TIMEOUT_MS` | 200 | Health check for TCP-pre-probed ambiguous ports |

## Out of Scope

- Diagnostic procedures for server failures → `diagnose-server-health.md`
- EDH-specific path isolation → `platform-reference.md`
- Agent launch prerequisites (server must be running) → `diagnose-agent-launch.md`
- CLI authentication using discovery file → `inspect-cli-tools.md`

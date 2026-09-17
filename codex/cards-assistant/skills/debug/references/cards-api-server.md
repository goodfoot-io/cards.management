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
  "reposPath": "/home/user/.cards/cards-repos"
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

`buildTime` is used for stale-server takeover: a newer build kills the old server and takes ownership.

### Lifecycle Watcher

**Source**: the extension's discovery-file watcher (`watchDiscoveryFile()`), run by every window connected to the server.

A watcher (`fs.watch` on parent dir + 5s polling fallback) detects peer writes and:

- **Self-demotes** when a newer `buildTime` appears, or an equal `buildTime` with a different `port`/`accessToken` (a same-build peer took over during a health stall).
- **Claims a dead-PID discovery file atomically**: renames to `{path}.{6rand}.stale`, compares content, deletes only if matching.
- **Re-asserts on external deletion** (ENOENT) after a debounce window, with a peer-existence check so it won't clobber a peer's fresh file.

## Liveness States

| State | File | PID | TCP pre-probe | Health check | Meaning |
|-------|------|-----|---------------|--------------|---------|
| Healthy owner | present | alive | reachable | — | Server running — connect as client |
| Slow but healthy | present | alive | timeout | passes within 200ms | Server running under CPU load — connect as client |
| Stale PID | present | alive | dead | — | Port definitively refused/reset/closed. Stale — treated as not_found |
| Crashed owner | present | dead | — | — | Discovery file cleaned up. Trigger recovery poll |
| Hung port | present | alive | timeout | fails within 200ms | Port hung — treated as stale |
| No server | absent | — | — | — | Server never started or crashed |

**Source**: the extension's server-liveness check, which combines a PID check, a TCP pre-probe, and an HTTP health check.

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

On `SQLITE_CORRUPT`, `SQLITE_NOTADB`, `SQLITE_IOERR`, FTS corruption (`vtable constructor failed` or `cards_fts has an unexpected schema`), or `CacheSchemaMismatchError`, the disposable SQLite cache is deleted and rebuilt from the authoritative card Git repositories. A cache schema mismatch is an incompatible read-model layout, not proof that Git data is corrupt; rebuilding restores fields such as branch registration revisions and execution ownership before serving operations. WAL/SHM/journal files are also cleaned up. Do not remove card repositories or durable runtime records as part of cache recovery.

**Source**: the extension's database-corruption check, run whenever opening the database fails.

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

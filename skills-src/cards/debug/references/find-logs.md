# Finding Log Files

Scope: every log file the Cards extension and its plugins produce, by subsystem — path, format, and path resolution.

## Quick Discovery

```bash
# Repo-scoped logs. From a linked worktree the two roots differ and the hook logs
# live under the main repo root, so search both rather than assuming they coincide.
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
[ "$(basename "${COMMON_DIR:-}")" = ".git" ] && MAIN_REPO_ROOT=$(dirname "$COMMON_DIR")
find "$MAIN_REPO_ROOT/.cards/logs" "$(git rev-parse --show-toplevel)/.cards/logs" \
  -name "*.log" -type f 2>/dev/null

# Global logs — resolveGlobalCardsConfigDir(), and the Claude API hook log when the
# Cards plugin is installed at user scope
find ~/.cards -name "*.log" -type f 2>/dev/null

# VS Code extension host logs
find ~/.config/Code/logs ~/Library/Application\ Support/Code/logs -name "Cards.log" -type f 2>/dev/null
```

## Log File Inventory

### VS Code Extension

| Field | Value |
|-------|-------|
| **Path** | Output → Cards channel (View → Output, select "Cards") |
| **Persisted** | `{vscode-userdata}/logs/{date}/window{N}/exthost/goodfoot.cards/Cards.log` |
| **Format** | Plain text (VS Code manages persistence, not the extension) |
| **Child channels** | `Cards.Git`, `Cards.Router`, `Cards.Runtime`, `Cards.Server` |
| **Implementation** | Built on VS Code's `window.createOutputChannel(name, { log: true })` API |
| **Note** | The extension does NOT write this channel to disk — VS Code persists it depending on log level and user settings. An in-memory ring buffer (last 500 entries, `logBuffer.ts`) is pre-filled into `cards-extension issue` reports automatically. |

### Claude API Hooks

| Field | Value |
|-------|-------|
| **Path** | `$HOOKS_LOG_ANCHOR/.cards/logs/claude-code-cards-api-hooks.log` — `{main-repo-root}` for a `claude-local`/`claude-project` install, `$HOME` for a `claude-user` install (§1 of `SKILL.md` computes it) |
| **Format** | JSON Lines — one JSON object per line |
| **Env var** | `CLAUDE_CODE_HOOKS_LOG_FILE` — operator override only, unset by default. `CLAUDE_CODE_HOOKS_LOG_ENV_VAR` redirects that name; an **empty** value of whichever name applies means file logging is deliberately off. (`CARDS_CLAUDE_CODE_HOOKS_LOG_FILE` is the legacy name; the bundles no longer read it.) |
| **Set by** | Nothing — the compiled bundle computes the path itself at handler entry, from the install scope recorded in the Claude settings chain plus the hook payload's `cwd`. Nothing is written into `settings.json` or the launch env. |
| **Source** | `public/packages/agent-hooks/src/shared/default-log-file.ts`::`resolveDefaultApiHooksLogPath()` |
| **No file?** | The path resolves fail-closed: no recorded Cards install, a bare repo, a non-repo `cwd`, or a missing `git` yields no path and therefore no file, rather than a guessed location. |
| **Wrong file?** | A copy of this log inside a *linked worktree* is dead, not current — a few old worktrees inherited one at creation time, and its entries stop months ago while the anchor's log runs to now. Read the anchor's; a worktree copy will date a breakage that did not happen. |
| **JSON schema** | `{timestamp, level, hookType, message, input?, context?, error?}` |

### Claude Runtime Hooks

| Field | Value |
|-------|-------|
| **Path** | `{workspace}/.cards/logs/claude-code-cards-runtime-hooks.log` |
| **Format** | JSON Lines |
| **Env var** | `CLAUDE_CODE_RUNTIME_HOOKS_LOG_FILE` |
| **Set by** | The Cards extension's runtime action dispatcher |
| **Note** | `{workspace}` is the **VS Code window's** workspace folder, resolved at activation — not the session's cwd and not a git root. A window opened on the main repo logs every session it dispatches, including ones running in worktrees, to the main repo root; a window opened on a worktree logs to that worktree. So this log can sit under either root and neither `WORKSPACE` nor `MAIN_REPO_ROOT` reliably names it — locate it with the Quick Discovery `find` above rather than composing a path. |

### Claude Assistant Hook

| Field | Value |
|-------|-------|
| **Path** | `$CLAUDE_CODE_ASSISTANT_HOOKS_LOG_FILE` — **user-set. Cards does not set it, so no file exists by default.** Set it before launch: the Logger reads it at construction |
| **Format** | JSON Lines |
| **Set by** | Compiled hook binary — `session-start.mjs` line 8: `process.env['CLAUDE_CODE_HOOKS_LOG_ENV_VAR'] = "CLAUDE_CODE_ASSISTANT_HOOKS_LOG_FILE"` |
| **Source** | `public/claude/cards-assistant/hooks/bin/session-start.mjs` (compiled from `public/packages/agent-hooks/src/claude/assistant/session-start.ts`) |

### Codex Hooks

| Field | Value |
|-------|-------|
| **Path** | `$CODEX_HOOKS_LOG_FILE` — **user-set. Cards does not set it, so no file exists by default.** |
| **Format** | JSON Lines |
| **Source** | `@goodfoot/codex-hooks/dist/logger.js` — `const DEFAULT_LOG_ENV_VAR = "CODEX_HOOKS_LOG_FILE"` |

### Handler (Compiled .mjs)

| Field | Value |
|-------|-------|
| **Path** | `{main-repo-root}/.cards/logs/{subsystem}.log` or `$CARDS_HOOKS_LOG_FILE` |
| **Format** | JSON Lines |
| **Source** | `public/packages/sdk/src/config/logger.ts` |
| **Resolution order** | 1. `config.logFilePath` (explicit) — 2. `$CARDS_HOOKS_LOG_FILE` env var — 3. `$CARDS_LOG_DIR/{subsystem}.log` — 4. `{main-repo-root}/.cards/logs/{subsystem}.log` (computed via `git rev-parse --path-format=absolute --git-common-dir`) — 5. `null` (file output disabled) |

### Branch Cleanup Watcher

| Field | Value |
|-------|-------|
| **Path** | `{main-repo-root}/.cards/logs/cards-default-configuration-hooks.log` |
| **Format** | JSON Lines |
| **Source** | `public/packages/default-configuration/src/lib/branch-cleanup-watcher.ts` — resolves via `resolveLogFilePath()`, so the Handler resolution order above applies; the parent passes the resolved path to the detached child as `CARDS_HOOKS_LOG_FILE` |

### Detached Child Output

| Field | Value |
|-------|-------|
| **Default path** | `{main-repo-root}/.cards/logs/cards-detached-child-stderr.log` |
| **Format** | Append-only plain text containing the combined, verbatim stdout and stderr of detached cleanup children, plus versioned attribution records described below. This is **not JSON Lines**. |
| **Resolution order** | 1. A nonempty `$CARDS_DETACHED_STDERR_LOG_FILE` selects that exact file. 2. Otherwise, a nonempty `$CARDS_LOG_DIR` selects `$CARDS_LOG_DIR/cards-detached-child-stderr.log`. 3. Otherwise, the main repository is resolved using nonempty `REPO_ROOT`, then `git rev-parse --path-format=absolute --git-common-dir`, and the default path above is used. 4. If no main repository can be resolved, capture is disabled (`null`) and the child is spawned with ignored output. Empty override values are skipped. `$CARDS_HOOKS_LOG_FILE` is never consulted. |
| **Sources** | [`prepareDetachedChildOutputCapture()`](./public/packages/sdk/src/config/detached-child-output.ts#L126), used by [`spawnBranchCleanupWatcher()`](./public/packages/default-configuration/src/lib/branch-cleanup-watcher.ts#L91) and by the extension's own detached-cleanup spawn path |
| **No file?** | Path-resolution, directory-creation, open, or initial-write failure produces a warning through the caller's existing logging channel, then leaves cleanup fail-open with ignored output. A healthy child normally adds only the two small attribution records below. |

Each attribution record occupies one physical line and starts with the magic prefix `@@CARDS_DETACHED_CHILD_V1@@`, immediately followed by a JSON object. The parent writes a `spawn` record before launching the child. If Node reaches the generated preload, the child writes a `started` record before loading the existing cleanup entry module. Both records carry the same correlation ID, card ID, nullable session ID, and child kind; the second also records the runtime PID. Card, session, and child-kind values are bounded to 512 Unicode code points and visibly end in `...[truncated]` when shortened. JSON serialization keeps embedded newlines and other identity delimiters inside the physical record line.

These examples show the exact V1 prefix, field names, field order, and compact single-line encoding; UUIDs, IDs, PIDs, and timestamps vary at runtime:

```text
@@CARDS_DETACHED_CHILD_V1@@{"phase":"spawn","correlationId":"793a94c2-ae9c-4280-a8ae-c6f7ed160f33","cardId":"main-456","sessionId":"session-123","childKind":"branch-cleanup-watcher","timestamp":"2026-08-14T02:10:00.000Z"}
@@CARDS_DETACHED_CHILD_V1@@{"phase":"started","correlationId":"793a94c2-ae9c-4280-a8ae-c6f7ed160f33","cardId":"main-456","sessionId":"session-123","childKind":"branch-cleanup-watcher","pid":28430,"timestamp":"2026-08-14T02:10:00.014Z"}
@@CARDS_DETACHED_CHILD_V1@@{"phase":"spawn","correlationId":"b68e809e-5a92-430b-84ba-31bd3604e32a","cardId":"main-456","sessionId":null,"childKind":"wrapper-cleanup","timestamp":"2026-08-14T02:11:00.000Z"}
@@CARDS_DETACHED_CHILD_V1@@{"phase":"started","correlationId":"b68e809e-5a92-430b-84ba-31bd3604e32a","cardId":"main-456","sessionId":null,"childKind":"wrapper-cleanup","pid":28431,"timestamp":"2026-08-14T02:11:00.012Z"}
```

A missing `started` record narrows the failure to the period before the preload ran, but it does not by itself identify the cause.

The same append descriptor receives both stdout and stderr, so their original stream identity is lost. Each attribution record is emitted with one write, but arbitrary output from concurrent children can still interleave and cannot always be assigned to one child. Use the correlation ID and nearby `spawn`/`started` records as attribution boundaries, not as a guarantee that every following stack-trace line belongs to that child.

This diagnostic may contain filesystem paths, command arguments, environment-derived values, stack traces, or secrets printed by a failed process. Newly created files use owner-only permissions where the platform supports them, but the file is not rotated or cleaned up automatically. Review and redact it before sharing: **do not attach this file to a `cards-extension issue` report without operator review.**

> **Do not run the JSONL `jq` recipes below against this file.** Only the prefixed attribution lines contain JSON; raw child output is plain text and may span or interleave across lines.

### Session Stderr

| Field | Value |
|-------|-------|
| **Path** | `~/.cards/sessions/{sanitizedCardId}/stderr.log` |
| **Format** | Plain text |

## Reading JSON Lines Logs

`HOOKS_LOG_ANCHOR` is set by §1 of `SKILL.md`; substitute any other inventory path above for a different subsystem.

```bash
LOG=$HOOKS_LOG_ANCHOR/.cards/logs/claude-code-cards-api-hooks.log

# Live tail, filtered — swap the predicate for any field, e.g. .hookType == "SessionStart"
tail -f "$LOG" | jq 'select(.level == "error")'

# Filter + project the fields that matter
jq 'select(.level == "error") | {timestamp, message, error: .error?.message}' "$LOG" | tail -20

# Aggregate (-s slurps the whole file)
jq -s 'group_by(.level) | map({level: .[0].level, count: length})' "$LOG"
```

## Log Format

Every entry carries `timestamp`, `level`, `message`, and optionally `hookType`, `input`, `context`. Entries from `logError` add a nested `error`:

```json
{
  "timestamp": "2026-06-26T14:45:16.374Z",
  "level": "error",
  "hookType": "SessionStart",
  "message": "Failed to spawn claude",
  "input": { "source": "startup" },
  "context": { "sessionId": "abc123" },
  "error": { "name": "Error", "message": "spawn claude ENOENT", "stack": "...", "cause": null }
}
```

## Out of Scope

- VS Code internal log files (managed by VS Code, not the extension) → VS Code documentation
- Agent CLI internal logs → Claude Code / Codex documentation
- Hook execution lifecycle → `diagnose-hooks.md`
- Server startup logs → `diagnose-server-health.md`
- Log path env var configuration → `inspect-settings.md`

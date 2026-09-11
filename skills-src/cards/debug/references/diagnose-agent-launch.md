# Diagnosing Agent Launch Failures

Scope: the spawn chain for the Cards Assistant and per-card action launches — VS Code command through agent CLI.

## Quick Diagnostics

```bash
# 1. Check VS Code Output → Cards channel for launch log
#    Grep for: "[Cards] Start Cards Assistant" or "[Cards] Execute action requested"

# 2. Verify the compiled handler exists
ls -la "$(cat ~/.cards/EXTENSION_PATH 2>/dev/null)/dist/config/bin/cards-assistant."*.mjs

# 3. Verify the agent CLI is on PATH
which claude 2>/dev/null && echo "claude: found" || echo "claude: NOT FOUND"
which codex 2>/dev/null && echo "codex: found" || echo "codex: NOT FOUND"

# 4. Dump env vars the handler receives
env | grep -E 'MARKETPLACE_PATH|EXTENSION_PATH|CODING_AGENT|REPO_ROOT|CARDS_BIN_PATH'
```

## The Spawn Chain

```
VS Code command (cards.startCardsAssistant or cards.executeAction)
  → Gate checks (agent configured, server running, config exists)
    → Resolve interpreter (getNodePath)
      → Parse command string (ProcessLauncher.parseVscodeNodeCommand)
        → Launch terminal (vscode.window.createTerminal)
          → Handler .mjs reads env vars (extractCardsAssistantInput)
            → resolveCodingAgent → spawnAgentCli (Claude or Codex)
              → Agent CLI loads plugins → SessionStart hook fires
```

## Failure Modes

### Agent Not Configured

**Evidence**: Output → Cards channel shows `"Start Cards Assistant aborted: no defaultCodingAgent configured"`.

**Cause**: `cards.defaultCodingAgent` VS Code setting is empty. **Probability**: high on first install.

**Recovery**: Run the setup wizard (triggered automatically by the command). **Risk**: safe.

**Post-fix verification**: `cards.startCardsAssistant` opens a terminal.

**Looks like, but isn't**: The command may not appear in the command palette at all if the extension didn't activate. Check Output → Cards for activation logs.

### Server Not Running

**Evidence**: `"Start Cards Assistant aborted: server not running"`. `deps.getState()` returns null.

**Cause**: Cards API server hasn't started or crashed. **Probability**: medium — server startup is atomic (all-or-nothing).

**Recovery**: Reload the VS Code window to trigger server recovery — **safe**. Load `diagnose-server-health.md` for detailed diagnostics. **Escalate if**: server won't start after 3 reloads.

### No Cards Assistant Configured

**Evidence**: `"Start Cards Assistant aborted: no cards assistant configured"`. `settingsLoader.getCardsAssistant()` returns undefined.

**Cause**: `settings.json` missing `cardsAssistant.command`. The `cards-sdk build` step may have been skipped or the config doesn't export a `cardsAssistant` handler.

**Recovery**: Rebuild the configuration: `cards-sdk build -c settings.config.ts -o dist` — **safe**. Verify `dist/settings.json` contains `"cardsAssistant": {"command": "..."}`.

### Interpreter Resolution Fails

**Evidence**: `"Start Cards Assistant aborted: <message>"`. On win32: no console-subsystem `node.exe` ≥ v22 found on PATH.

**Cause**: `getNodePath()` throws. On Windows, `Code.exe` is a GUI-subsystem image that cannot attach to a ConPTY — a real `node.exe` must be on PATH. On POSIX, `process.execPath` should always work.

**Recovery**: Install Node.js ≥ v22 and add it to PATH. **Risk**: **safe**.

**Post-fix verification**: `cat ~/.cards/VSCODE_NODE` contains a valid path; running it prints Node.js version.

### Handler Binary Missing

**Evidence**: Terminal opens but immediately closes. The handler `.mjs` doesn't exist at the command path in `settings.json`.

**Cause**: The `cards-sdk build` step didn't run, or the compiled handler was deleted from `dist/config/bin/`.

**Recovery**: Rebuild: `cards-sdk build -c settings.config.ts -o dist` — **safe**. Verify the handler exists: `ls -la <ext>/dist/config/bin/cards-assistant.*.mjs`.

### Agent CLI Not Found (ENOENT)

**Evidence**: Handler log shows `"Failed to spawn claude"`, `"Failed to spawn codex"`, `"Failed to spawn opencode"`, or `"Failed to spawn agy"` with error `spawn claude ENOENT` (or the matching binary). The handler's promise settles (doesn't hang) because the fail-closed guard catches the `error` event.

**Cause**: the agent CLI (`claude`, `codex`, `opencode`, or `agy`) is not on PATH. On win32, the `.cmd` shim may be missing.

**Recovery**: Install the agent CLI. Verify with `which claude`. **Risk**: **safe**.

**Post-fix verification**: `which claude` returns a path. Running `claude --version` succeeds.

### Inline Settings JSON Mangled (win32)

**Evidence**: Claude starts but plugins aren't loaded. The `--settings` argument was corrupted by cmd.exe.

**Cause**: A `shell: true` spawn on win32 concatenates argv unquoted, mangling JSON with `{`/`}`/`"` characters. `spawnAgentCli` (cross-spawn) escapes each argument for cmd.exe.

**Recovery**: Verify the code uses `spawnAgentCli`, not `spawn(..., { shell: true })` — **safe**. `cards-assistant.ts` routes every assistant spawn — `claude`, `codex`, `opencode`, and `agy` — through `spawnAgentCli`.

**Looks like, but isn't**: Plugin cache corruption can look like missing plugins. Load `inspect-plugin-cache.md`.

## Launch Environment Variables

The Cards Assistant and action dispatcher each assemble their base environment immediately before dispatch and hand it to the agent CLI unchanged. No authorization step gates a launch — nothing is issued for authorization before spawn, and no launch path probes credentials. What the launch path does refuse, it refuses for reasons that are not variables: the action dispatcher validates its execution controls (model and effort) before dispatch, and both launchers refuse as `marker-store-unavailable` when the session's runtime marker store cannot be established. A missing or malformed variable therefore surfaces as the handler's or agent CLI's own startup failure.

| Variable | Value | Purpose |
|----------|-------|---------|
| `MARKETPLACE_PATH` | `{globalStorage}/marketplace` | Stable symlink to bundled marketplace |
| `EXTENSION_PATH` | `{ext}/dist` | Extension install directory |
| `CARDS_BIN_PATH` | `{ext}/dist/bin` | CLI tool directory |
| `CODING_AGENT` | `codingAgentEnvValue` (resolved via `resolveEffectiveAgent`/gate: `claude-code-cli`, `codex-cli`, `opencode-cli`, or `antigravity-cli`) | Agent identifier |
| `REPO_ROOT` | First workspace folder path | Main git repository root |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | `1` | Enable additional directory CLAUDE.md loading |
| `INITIAL_PROMPT` | Command's `prompt` arg (set only when provided) | Seeds the assistant session |

## Escalation

File a bug report — load `interview-issue-report.md`, then `issue-report-guide.md`. Escalate if:
- **Handler binary is present but won't execute**: Include `ls -la "$(cat ~/.cards/EXTENSION_PATH 2>/dev/null)/dist/config/bin/"` and `cat ~/.cards/VSCODE_NODE`.
- **Agent CLI is on PATH but ENOENT persists**: Include `which claude codex` output and the handler log tail at `${WORKSPACE}/.cards/logs/cards-default-configuration-hooks.log`.
- **Terminal opens but no agent output appears**: Include `ps aux | grep claude` and `tail -50 ${WORKSPACE}/.cards/logs/claude-code-cards-runtime-hooks.log`.
- **Launch succeeds but hook doesn't fire**: Load `diagnose-hooks.md` first. If root cause is not identified, file an issue with the hook log tail.

## Out of Scope

- Server startup failures → `diagnose-server-health.md`
- Hook failures after agent starts → `diagnose-hooks.md`
- Plugin cache problems → `inspect-plugin-cache.md`
- Agent CLI installation → agent-specific documentation
- Post-launch session behavior → `find-session-state.md`

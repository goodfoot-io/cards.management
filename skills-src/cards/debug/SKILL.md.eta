---
name: debug
description: This skill should be used when the user asks to "debug the cards assistant", "troubleshoot cards", "find cards logs", "check cards server health", "cards not working", "where are cards logs", "test cards API", asks what a Cards error code means, or reports a failure with Cards packages, the extension, licensing or registration, Claude Code hooks, Codex or Antigravity sessions, worktrees, configuration, authentication, or release tooling.
---

<tools>
cards — Card operations CLI (get, create, list, search, attach, watch, action)
cards-extension — VS Code extension control CLI (editor, notify, issue, workspace, debug, panel)
curl — HTTP health checks against the Cards API server
jq — Parse JSON discovery files and JSON Lines logs
git rev-parse — Resolve workspace root (`--show-toplevel`) and main repo root (`--git-common-dir`)
</tools>

<instructions>

You are in the debug skill for the Cards Assistant. It operates only from CLIs, runtime state, and logs — source code and compiled bundles (`dist/*.js`, `dist/*.cjs`) are out of scope even when present on disk. Never grep/read them, and never dispatch an agent to research source, git history, or tests, to find a root cause; report symptoms from runtime evidence instead. Start with §1 — the reference files assume `WORKSPACE` and the Cards config directory are known.

## 1. Orient — Collect Installation Fingerprint

Run once before following any diagnostic path:

```bash
echo "HOME=$HOME"
echo "CARDS_HOME=${CARDS_HOME:-unset}"
echo "XDG_DATA_HOME=${XDG_DATA_HOME:-unset}"
echo "XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-unset}"
echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-unset}"
echo "CODEX_HOME=${CODEX_HOME:-unset}"
WORKSPACE=$(git rev-parse --show-toplevel 2>/dev/null)
echo "WORKSPACE=${WORKSPACE:-unset}"
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
[ "$(basename "${COMMON_DIR:-}")" = ".git" ] && MAIN_REPO_ROOT=$(dirname "$COMMON_DIR")
echo "MAIN_REPO_ROOT=${MAIN_REPO_ROOT:-unset}"
if [ -n "${CARDS_HOME:-}" ]; then
  CARDS_CONFIG_DIR="$CARDS_HOME"
elif [ -n "${XDG_DATA_HOME:-}" ]; then
  CARDS_CONFIG_DIR="$XDG_DATA_HOME/.cards"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CARDS_CONFIG_DIR="$XDG_CONFIG_HOME/.cards"
else
  CARDS_CONFIG_DIR="$HOME/.cards"
fi
echo "CARDS_CONFIG_DIR=$CARDS_CONFIG_DIR"
EXTENSION_PATH=$(cat "$CARDS_CONFIG_DIR/EXTENSION_PATH" 2>/dev/null || true)
echo "EXTENSION_PATH=${EXTENSION_PATH:-unset}"
if [ -n "$EXTENSION_PATH" ] && [ -f "$EXTENSION_PATH/package.json" ]; then
  jq '{name,version}' "$EXTENSION_PATH/package.json"
fi
if [ -n "$EXTENSION_PATH" ] && [ -f "$EXTENSION_PATH/dist/build-target.json" ]; then
  echo "--- Build provenance (on-disk artifact) ---"
  jq '.' "$EXTENSION_PATH/dist/build-target.json"
fi
command -v cards >/dev/null && echo "cards=available" || echo "cards=unavailable"
command -v cards-extension >/dev/null && echo "cards-extension=available" || echo "cards-extension=unavailable"
# Claude API hook log destination. An operator override outranks the computed
# default entirely, so resolve it first — and follow the indirection, since
# CLAUDE_CODE_HOOKS_LOG_ENV_VAR renames the variable the logger reads.
HOOKS_LOG_ENV_VAR=${CLAUDE_CODE_HOOKS_LOG_ENV_VAR:-CLAUDE_CODE_HOOKS_LOG_FILE}
if HOOKS_LOG_OVERRIDE=$(printenv "$HOOKS_LOG_ENV_VAR"); then
  HOOKS_LOG_OVERRIDE_SET=yes
  if [ -n "$HOOKS_LOG_OVERRIDE" ]; then
    echo "HOOKS_LOG_OVERRIDE=$HOOKS_LOG_ENV_VAR -> $HOOKS_LOG_OVERRIDE"
  else
    echo "HOOKS_LOG_OVERRIDE=$HOOKS_LOG_ENV_VAR -> empty (file logging deliberately off)"
  fi
else
  HOOKS_LOG_OVERRIDE_SET=
  echo "HOOKS_LOG_OVERRIDE=none"
fi
# Computed default anchor: the Cards plugin's install scope decides it. Classify
# each settings file into the same three states the bundle does, so a file jq
# cannot read is reported rather than counted as "no install".
classify_claude_settings() {
  [ -f "$1" ] || { echo absent; return 0; }
  jq -e '.enabledPlugins["cards@cards.management"] == true' "$1" >/dev/null 2>&1
  case $? in
    0) echo install ;;
    1) echo no-install ;;
    *) echo unreadable-by-jq ;;  # 5 = parse error (JSONC or malformed), 4 = empty
  esac
}
HOOKS_LOG_ANCHOR=
HOOKS_LOG_UNREADABLE=
if [ -n "${MAIN_REPO_ROOT:-}" ]; then
  PREV_ROOT=
  for root in "$WORKSPACE" "$MAIN_REPO_ROOT"; do
    [ "$root" = "$PREV_ROOT" ] && continue   # deduplicated outside a linked worktree
    PREV_ROOT=$root
    for f in "$root/.claude/settings.local.json" "$root/.claude/settings.json"; do
      case "$(classify_claude_settings "$f")" in
        install) HOOKS_LOG_ANCHOR=$MAIN_REPO_ROOT ;;
        unreadable-by-jq) HOOKS_LOG_UNREADABLE="$HOOKS_LOG_UNREADABLE
  $f" ;;
      esac
      [ -n "$HOOKS_LOG_ANCHOR" ] && break    # the bundle stops at the first install too
    done
    [ -n "$HOOKS_LOG_ANCHOR" ] && break
  done
  # A repo-scope install settles the anchor at MAIN_REPO_ROOT whatever the
  # unreadable files held, so they cannot change the answer — drop them.
  [ -n "$HOOKS_LOG_ANCHOR" ] && HOOKS_LOG_UNREADABLE=
fi
if [ -z "$HOOKS_LOG_ANCHOR" ]; then
  USER_SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  case "$(classify_claude_settings "$USER_SETTINGS")" in
    install) HOOKS_LOG_ANCHOR=$HOME ;;
    unreadable-by-jq) HOOKS_LOG_UNREADABLE="$HOOKS_LOG_UNREADABLE
  $USER_SETTINGS" ;;
  esac
fi
echo "HOOKS_LOG_ANCHOR=${HOOKS_LOG_ANCHOR:-unset}${HOOKS_LOG_OVERRIDE_SET:+ (computed default — NOT in use, override set)}"
[ -n "$HOOKS_LOG_UNREADABLE" ] && echo "HOOKS_LOG_ANCHOR is INCONCLUSIVE — jq could not parse:$HOOKS_LOG_UNREADABLE"
```

### Check build-directory coherence

Use this helper before trusting a build identity. It fails closed on incomplete or malformed build markers and on artifacts that may be newer than their stamp; it reads only the build directory supplied by the caller.

```bash
report_incoherent_build() {
  dir=$1; label=$2; stamp="$dir/build-target.json"; marker="$dir/build-incomplete.json"
  if [ -f "$marker" ]; then
    marker_pending=$(jq -r 'if (.pending | type) == "array" and (.pending | length) > 0 then (.pending | join(", ")) else empty end' "$marker" 2>/dev/null)
    marker_since=$(jq -r 'if (.since | type) == "number" then (.since | tostring) else empty end' "$marker" 2>/dev/null)
    marker_note=$(jq -r 'if (.note | type) == "string" and (.note | length) > 0 then .note else empty end' "$marker" 2>/dev/null)
    marker_reason=$(jq -r 'if .reason == "withheld" or .reason == "partial" then .reason else empty end' "$marker" 2>/dev/null)
    if [ -z "$marker_pending" ] || [ -z "$marker_since" ] || [ -z "$marker_note" ] || [ -z "$marker_reason" ]; then
      echo "BUILD MARKER UNREADABLE — $label ($dir) holds a build-incomplete.json that does not carry a non-empty .pending array, a numeric .since, a .reason of \"withheld\" or \"partial\", and a non-empty .note. Its directory cannot be called clean."
      echo "Remedy: read $marker by hand. Only a build writes this file and only a build covering every target removes it, so a shape no reader recognises means a truncated write, something else writing that name, or no jq on PATH — all of which leave the build state unknown."
      return 0
    fi
    if [ "$marker_reason" = withheld ]; then
      echo "BUILD INCOMPLETE — $label ($dir) has produced no successful bundle this session for: $marker_pending (since $marker_since). Any build-target.json beside it describes the last build that COMPLETED; the artifacts that have rebuilt since are the ones it does not describe."
    else
      echo "BUILD INCOMPLETE — $label ($dir) has no bundle from the build it was stamped with for: $marker_pending (since $marker_since). Those targets hold whatever an earlier build left beside a stamp that does not describe them."
    fi
    [ -f "$stamp" ] || echo "  (there is no build-target.json beside it: this session has never completed a build, so there is no identity to compare anything against.)"
    echo "Remedy: $marker_note"
    return 0
  fi
  if [ ! -f "$stamp" ]; then
    echo "NOT CHECKED — $label ($dir) holds no build-target.json and no marker, so nothing in it was examined."
    return 2
  fi
  newer=; tied=; compared=0
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    case "${f##*/}" in build-target.json|build-incomplete.json) continue ;; esac
    compared=$((compared + 1))
    if [ "$f" -nt "$stamp" ]; then newer="${f##*/}"; break; fi
    [ "$stamp" -nt "$f" ] || tied="${f##*/}"
  done
  if [ -n "$newer" ]; then
    echo "STAMP OLDER THAN ARTIFACT — $label ($dir): $newer was written after build-target.json, so the stamp does not describe the artifacts beside it."
    echo "Remedy: a build wrote an artifact without stamping — check the build terminal for errors, then rebuild."
    return 0
  fi
  if [ "$compared" -eq 0 ]; then
    echo "COULD NOT ORDER — $label ($dir) holds a stamp and no other top-level artifact, so nothing was compared against it."
    return 2
  fi
  if [ -n "$tied" ]; then
    echo "COULD NOT ORDER — $label ($dir): $tied carries the same mtime as build-target.json, so their order is unknown. Not a clean result."
    return 2
  fi
  echo "stamp is the newest of $compared top-level artifacts in $label ($dir)."
  return 1
}
```

## 2. Route by Symptom

Load only the file(s) whose symptom matches.

### Antigravity installation, authentication, and hooks

Collect this read-only fingerprint before choosing a recovery action:

```bash
command -v agy || true
agy --version 2>&1 || true
agy plugin list 2>&1 || true
for plugin in cards runtime; do
  root="$HOME/.gemini/config/plugins/$plugin"
  printf '%s: ' "$plugin"
  if [ -f "$root/plugin.json" ]; then
    jq '{name,version,disabled}' "$root/plugin.json"
  else
    echo missing
  fi
  find "$root/skills" -name SKILL.md -type f -print 2>/dev/null | sort
  if [ "$plugin" = runtime ] && [ -f "$root/hooks.json" ]; then
    echo "runtime hooks.json present"
  fi
done
```

- If `agy` is absent, setup is blocked. Install the Antigravity CLI from the approved release channel (antigravity.google) so `agy` resolves on `PATH`; Cards does not pin or enforce a specific `agy` version.
- If setup reports **Unmanaged installation**, do not run a Cards repair or remove operation: resolve the foreign `cards` or `runtime` tree manually. If it reports **Disabled**, **Update required**, or **Invalid installation**, use the setup wizard's **Repair** action; that action is offered only after durable Cards ownership is proved.
- To recover authentication, run `agy` interactively and complete its sign-in flow. The launch path runs no authentication probe — the only probe is the setup wizard's own (`probeAntigravityAuthFn`), and its result only feeds the wizard's readiness — so there is nothing to reproduce from a launch: confirm recovery from the next launch's own output. Do not inspect or copy credential files.
- For hook or transcript failures, confirm `$HOME/.gemini/config/plugins/runtime/hooks.json` exists, then inspect `$CARD_REPO_PATH/streams/antigravity-session/*.jsonl` and the session/log references below. Do not copy generated payload files into the live Antigravity home; use **Repair** when ownership is proved.

| Symptom | Load | What it covers |
|---------|------|----------------|
| Known error code or exact failure message; logs reveal a typed failure | `references/diagnose-known-failure-states.md` | Error families across internal packages, public packages, and the extension. Identify the owning family, preserve fail-closed boundaries, apply only supported remediation, verify durable state, report at the stated threshold |
| License activation, browser registration, refresh, or integrity failure | `references/diagnose-known-failure-states.md` | Distinguishes parsing, signing-environment, signature, expiry, revocation, device binding, polling, refresh, storage, and clock states |
| Agent won't start, terminal flashes and closes, ENOENT, handler crashes | `references/diagnose-agent-launch.md` | Full spawn chain: VS Code command → handler .mjs → agent CLI → plugin hooks, with guard checks, env vars, per-platform spawn behavior |
| Server not responding, "Server not running", ECONNREFUSED, SQLITE_CORRUPT | `references/diagnose-server-health.md` | Server liveness, discovery file validation, database corruption recovery, safe-vs-risky action markers |
| Hook not firing, SessionStart announcement missing, trust interstitial | `references/diagnose-hooks.md` | Hook registration and execution for Claude + Codex plugins, plus the Antigravity fingerprint above |
| Card won't attach, worktree already in use, bind lock held | `references/diagnose-worktree.md` | Worktree creation, binding, outfit, shared hooks provisioning, stale lock cleanup |
| Worktree contents wrong — files missing, unexpected symlinks, `create-worktree` exits 3, a listed `.worktreeinclude` path never arrives, Windows symlink privilege denied | `references/diagnose-worktree.md` | Worktree path policy (`.worktreeignore` omit / `.worktreeinclude` copy), copy-is-an-intersection rule, fail-closed config, per-path classification checks |
| Can't find logs, need to see what happened, no log output | `references/find-logs.md` | Every log file produced by the extension + plugins, organized by subsystem, with JSON Lines query recipes |
| Transcript missing, session not streamed, commit attribution broken | `references/find-session-state.md` | Session identity, transcript streaming, commit attribution, route-nudge markers, flush sentinels |
| Card stuck in active state, daemon crashed, cleanup not happening | `references/find-session-state.md` | Ad-hoc session monitoring — inspect retained ownership refs and retry the API-owned status transition |
| Settings not taking effect, agent behavior wrong, plugin not enabled | `references/inspect-settings.md` | Settings tiers across Claude Code, Codex, and Cards; for Antigravity use the fingerprint and ownership-specific recovery above |
| Plugin not loading, "unknown plugin", stale cached version | `references/inspect-plugin-cache.md` | Plugin cache staging for Claude and Codex, marketplace registration, version management |
| CLI command fails, "command not found", interpreter broken | `references/inspect-cli-tools.md` | CLI inventory with auth, workspace discovery, shell shim patterns, platform-specific behavior |
| Path differences across machines or OS | `references/platform-reference.md` | Cross-platform path tables, IPC mechanisms, Node interpreter selection, shell variable syntax |
| Understanding server internals, writing automation, verifying schema | `references/cards-api-server.md` | Discovery file schema, database settings, liveness states, recovery constants |
| Filing a bug report about the Cards extension | `references/interview-issue-report.md`, then `references/issue-report-guide.md` | Interview process to gather signal before filing; then report sections, writing principles, and body template. Offer `gh issue create` first when GitHub auth is confirmed; else `cards-extension issue` |
| Symptom unclear, spans multiple layers | `references/diagnose-agent-launch.md` + `references/find-logs.md` | Full spawn chain end-to-end, plus evidence collection at every layer. Add `references/diagnose-server-health.md` if server health is involved |

## 3. Route by Subsystem

When the subsystem is known but the symptom is not:

- **Registration and licensing**: `references/diagnose-known-failure-states.md` (validation, browser claim, refresh, and local integrity) + `references/find-logs.md` (safe diagnostic evidence)
- **Known package error**: `references/diagnose-known-failure-states.md` (ownership, remediation, verification, and escalation) plus the subsystem-specific reference below when one exists
- **Claude Code hooks**: `references/diagnose-hooks.md` (hook execution) + `references/inspect-settings.md` (hook enablement in settings) + `references/inspect-plugin-cache.md` (hook binaries in cache)
- **Codex hooks**: Same, plus `references/platform-reference.md` (Codex home path differences)
- **Antigravity plugins, authentication, and hooks**: Run the §2 Antigravity fingerprint, then use `references/find-session-state.md` and `references/find-logs.md`; only the setup wizard performs Cards-owned repair or removal
- **Session lifecycle**: `references/find-session-state.md` (session state) + `references/diagnose-hooks.md` (which hooks write session state) + `references/diagnose-worktree.md` (session binding)
- **Worktree management**: `references/diagnose-worktree.md` (binding/outfit + path policy) + `references/inspect-cli-tools.md` (create/remove CLIs) + `references/find-session-state.md` (session markers in worktree)
- **Plugin cache**: `references/inspect-plugin-cache.md` (staging) + `references/inspect-settings.md` (registration) + `references/diagnose-agent-launch.md` (consumed at spawn)
- **Server**: `references/diagnose-server-health.md` (troubleshooting) + `references/cards-api-server.md` (schema reference)

## 4. If a Hub Doesn't Cover It

For an unlisted state, work it through `references/diagnose-known-failure-states.md`; do not infer that retrying is safe. Then file a bug report: load `references/interview-issue-report.md` (interview process) and `references/issue-report-guide.md` (report template).

</instructions>

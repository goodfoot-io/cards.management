# Inspecting Plugin Caches

Scope: how Cards plugins reach the Claude Code and Codex plugin caches — inventory, directory structure, staging, version management, stale cleanup.

## Quick Diagnostics

```bash
# Claude Code plugin cache
find ~/.claude/plugins/cache/cards.management -maxdepth 3 -type d 2>/dev/null
cat ~/.claude/plugins/installed_plugins.json 2>/dev/null | jq '.["cards.management"]'

# Codex plugin cache
find ~/.codex/plugins/cache/local -maxdepth 2 -type d 2>/dev/null

# Marketplace symlink (stable across extension upgrades)
ls -la ~/.config/Code/User/globalStorage/goodfoot.cards/marketplace 2>/dev/null

# Codex plugin manifests in cache
find ~/.codex/plugins/cache/local -name "plugin.json" -path "*/.codex-plugin/*" -type f 2>/dev/null
```

## Plugin Bundle Layout

The Cards extension ships four Claude Code plugins and four Codex plugins:

```
{ext}/dist/marketplace/claude/
  cards/                 → Plugin "cards@cards.management"
  cards-assistant/       → Plugin "cards-assistant@cards.management"
  cards-sdk/             → Plugin "cards-sdk@cards.management"
  runtime/               → Plugin "runtime@cards.management"

{ext}/dist/codex/
  cards/                 → Codex plugin "cards"
  cards-assistant/       → Codex plugin "cards-assistant"
  cards-sdk/             → Codex plugin "cards-sdk"
  runtime/               → Codex plugin "runtime"
```

Each contains a `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` with `name` and `version`.

## Marketplace Symlink

**Path**: `{globalStorage}/marketplace` → `{ext}/dist/marketplace`.

**Created by**: `ensureMarketplaceSymlink()`. On POSIX: native symlink. On Windows: directory junction. Removed and recreated on every extension activation so upgrades point to the latest version.

VS Code installs each extension version to a versioned directory, but this `globalStorage` symlink survives upgrades — so the path agent settings reference never changes. The `MARKETPLACE_PATH` env var injected into agent processes holds it.

A `codex` symlink follows the same pattern: `{globalStorage}/codex` → `{ext}/dist/codex`.

## Claude Code Plugin Cache

**Path**: `{claudeConfigDir}/plugins/cache/cards.management/{plugin}/{version}/`.

**Resolution**: `resolveClaudeConfigDir()` in `public/packages/sdk/src/marketplace.ts` — honors `$CLAUDE_CONFIG_DIR`, then `$XDG_DATA_HOME/claude` → `$XDG_CONFIG_HOME/claude` → `~/.config/claude` → `~/.claude`. This is a disk-probe resolver (requires the `plugins/` subdirectory to exist for fallthrough).

### Registration Files

| Path | Purpose | Schema |
|------|---------|--------|
| `known_marketplaces.json` | Marketplace registry | `{ "<name>": { "source": { "source": "directory", "path": "<dir>" }, "installLocation": "<dir>" } }` |
| `installed_plugins.json` | Active plugin version pointers | `{ "<name>": { "version": "<ver>", "installPath": "<path>", "installedAt": "<ISO>" } }` |

**Source**: `public/packages/sdk/src/marketplace.ts`::`updateMarketplaceRegistration()`.

### Registration Flow

1. Reads `known_marketplaces.json`
2. Updates the `cards.management` entry's `source.path` and `installLocation` to the stable marketplace path
3. Writes back atomically

This ensures plugin version checks hit the cache instead of re-scanning the source directory.

### Headless Session Materialization

For background (headless) `claude --print` sessions that don't auto-sync marketplaces, the `ClaudeInstaller` calls:

```bash
claude plugin marketplace add <marketplacePath> --scope <scope>
claude plugin install cards@cards.management --scope <scope>
```

This populates the plugin store so `--print` sessions can discover the plugins.

## Codex Plugin Cache

**Path**: `{codexHome}/plugins/cache/local/{pluginName}/{version}/`.

### Staging Flow

Two entry points write the Codex plugin cache; both stage through the same routine, `installPluginToCache()` in `public/packages/default-configuration/src/lib/codex-session.ts`, so both carry the same guarantees. They differ only in *which* plugins they stage and *when*:

| Entry point | Caller | Triggered by |
|---|---|---|
| Setup wizard / repair | `CodexInstaller` transaction methods | **Cards: Configure Coding Agent**, or one-shot activation repair after freshness detects drift |
| Session launch | `populateCodexPluginCache()` | Every Cards-spawned Codex session, before spawn |

`installPluginToCache(pluginName, marketplaceDir, sourceDir, version)`:

1. Computes a `.cards-content-hash` digest of the source bundle (SHA-256 folded over entries sorted by relative path)
2. Content-addressed skip: reads the existing slot's stamp. A match leaves the slot untouched — no write at all, the race-free common case. A missing stamp is treated as stale (fail-closed), so a pre-content-address slot always restages.
3. On a miss, creates a temp dir under `{marketplaceDir}/.plugin-install-XXXXXX`, copies source files with `fs.cp`, writes the stamp, and validates `.codex-plugin/plugin.json`
4. Publishes by evicting any stale slot (to `.plugin-evict-XXXXXX`) and renaming the staged copy into `{marketplaceDir}/{pluginName}/{version}/`
5. Prunes superseded versions via `pruneSupersededPluginVersions()` — keeps only the highest semver

Codex reads `plugin.json` `version` only as a display label and selects a `Local` plugin by the highest-semver **directory name** — so a rebuilt bundle whose version was not bumped maps to the same slot, and step 2's digest comparison is what still restages it.

`populateCodexPluginCache()` wraps this with discovery: it reads the bundled `{bundlePath}/.agents/plugins/marketplace.json` to enumerate plugins and reads each `.codex-plugin/plugin.json` for the version before calling `installPluginToCache()`.

### Plugins Staged for Launch

`CODEX_LAUNCH_PLUGIN_NAMES`: `['cards', 'runtime']`. `CODEX_ASSISTANT_PLUGIN_NAMES`: `['cards', 'cards-assistant']`.

The `cards-sdk` plugin is NOT staged — it's only consumed at build time.

## Which Plugins Are Used When

| Mode | Plugin names | Purpose |
|------|-------------|---------|
| **Action launch** (Claude) | `runtime@cards.management` | Runtime hooks (session management, transcript streaming, commit attribution) |
| **Action launch** (Codex) | `cards`, `runtime` | Same, Codex equivalents |
| **Cards Assistant** (Claude) | `cards@cards.management`, `cards-assistant@cards.management` | Card management + interview bootstrapping |
| **Cards Assistant** (Codex) | `cards`, `cards-assistant` | Same, Codex equivalents |

## Staleness & Cleanup

Based on cache state:
- **Claude cache has old versions**: Managed by Claude Code's own plugin system — 7-day orphan GC on unused versions.
- **Codex cache has old versions**: `pruneSupersededPluginVersions()` deletes all but the highest semver at each cache population.
- **Codex slot stale despite an extension rebuild** (same `version`, different bytes): the slot is content-addressed via `.cards-content-hash`, so a rebuilt bundle restages even when its declared `version` did not change. A slot from before this fix has no stamp and is stale (fail-closed). On activation, the initial warm capability probe performs one freshness read; stale or absent user-scope plugins trigger one background `CodexInstaller.repairInstalled()`. Installer transactions share a Codex-home lock across VS Code windows, and repair rechecks the install manifest while holding it so a concurrent user uninstall is never revived. A successful repair is not re-probed or retried. If repair fails, Cards writes one warning to the activation log and shows one VS Code warning notification. Every Cards-spawned Codex session also stages before launch.
- **Inspecting staleness manually**: `probeCodexFreshness()` reads the highest-semver slot per plugin, compares its `.cards-content-hash` against a digest of the shipped bundle, and returns `current` / `stale` / `absent`. It runs only when activation explicitly opts its warm capability probe into freshness; later service probes do not repeat the check. Manual equivalent:
  ```bash
  find ~/.codex/plugins/cache/local -name '.cards-content-hash' -exec sh -c 'echo "$1: $(cat "$1")"' _ {} \;
  ```
  Zero results means every slot predates content addressing and is treated as stale.
- **Marketplace symlink unchanged**: Recreated on every extension activation — always points to the current version.
- **Extension upgraded but settings reference old paths**: The marketplace symlink is stable — `MARKETPLACE_PATH` doesn't change. But installed plugin pointers in `installed_plugins.json` may point to a stale cache directory. Re-running the agent install flow refreshes them.

## Out of Scope

- Plugin enablement in settings files → `inspect-settings.md`
- Hook registration and execution → `diagnose-hooks.md`
- Agent launch (cache consumed at spawn) → `diagnose-agent-launch.md`
- Agent CLI internal cache management → Claude Code / Codex documentation

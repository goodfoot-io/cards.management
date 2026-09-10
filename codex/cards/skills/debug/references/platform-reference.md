# Platform Reference

Scope: cross-platform path, IPC, Node interpreter, and shell-syntax differences for Linux, macOS, and Windows.

## Home Directory Resolution

Node's `os.homedir()` is the canonical resolver throughout the codebase.

| Platform | `os.homedir()` reads | Typical value |
|----------|---------------------|---------------|
| Linux | `$HOME` | `/home/user` |
| macOS | `$HOME` | `/Users/user` |
| Windows | `%USERPROFILE%` | `C:\Users\user` |

**Critical**: `os.homedir()` ignores `$HOME` on Windows. Code that sets only `process.env.HOME` works on POSIX but silently reads the real `%USERPROFILE%` on Windows. Tests and demo infrastructure that override home must set BOTH `HOME` and `USERPROFILE`.

Internal git-hook tests rely on this dual-override to point `os.homedir()` at a temporary directory regardless of host OS.

## Path Tables

### Cards Config (`~/.cards/`)

Resolution: `$CARDS_HOME` → `$XDG_DATA_HOME/.cards` → `$XDG_CONFIG_HOME/.cards` → `~/.cards`.

| Platform | Default |
|----------|---------|
| Linux | `~/.cards` (XDG-aware) |
| macOS | `~/.cards` |
| Windows | `%USERPROFILE%\.cards` |

### Claude Code Config

Resolution: `$CLAUDE_CONFIG_DIR` → XDG probe chain → `~/.claude` (full chain in `inspect-plugin-cache.md`).

| Platform | Default |
|----------|---------|
| Linux | `~/.claude` (or `~/.config/claude` if `plugins/` dir exists) |
| macOS | `~/.claude` |
| Windows | `%USERPROFILE%\.claude` |

### Codex Config

Resolution: `$CODEX_HOME` → `~/.codex`.

| Platform | Default |
|----------|---------|
| Linux | `~/.codex` |
| macOS | `~/.codex` |
| Windows | `%USERPROFILE%\.codex` |

### VS Code User Data

| Platform | Path |
|----------|------|
| Linux | `~/.config/Code/` |
| macOS | `~/Library/Application Support/Code/` |
| Windows | `%APPDATA%\Code\` |

### VS Code globalStorage

| Platform | Path |
|----------|------|
| Linux | `~/.config/Code/User/globalStorage/{publisher}.{name}/` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/{publisher}.{name}/` |
| Windows | `%APPDATA%\Code\User\globalStorage\{publisher}.{name}\` |

### VS Code Extension Host Logs

| Platform | Path |
|----------|------|
| Linux | `~/.config/Code/logs/{date}/window{N}/exthost/goodfoot.cards/Cards.log` |
| macOS | `~/Library/Application Support/Code/logs/{date}/window{N}/exthost/goodfoot.cards/Cards.log` |
| Windows | `%APPDATA%\Code\logs\{date}\window{N}\exthost\goodfoot.cards\Cards.log` |

## IPC

### Action Wrapper Sockets

| Platform | Path | Mechanism |
|----------|------|-----------|
| Linux | `~/.cards/a-{pid}-{8hex}.sock` | Unix domain socket |
| macOS | `~/.cards/a-{pid}-{8hex}.sock` | Unix domain socket |
| Windows | `\\.\pipe\cards-a-{pid}-{hash}` | Named pipe |

**macOS `sun_path` constraint**: the full socket path (directory + filename) must not exceed 104 bytes. This is why demo infrastructure anchors on `/tmp` (resolved to `/private/tmp`) rather than macOS's long per-user `$TMPDIR` (`/var/folders/.../T`, ~54 chars).

**Cleanup**: On POSIX, stale `.sock` files in `~/.cards/` are cleaned up during ActionDispatcher startup. On Windows, named pipes auto-cleanup on process exit.

**Source**: `public/packages/sdk/src/config/ipc-endpoint.ts` (IPC endpoint format).

### SDK IPC Endpoints (POSIX)

Path: `os.tmpdir()/{name}.sock`. Same `sun_path` constraint applies.

## Node Interpreter Selection

| Platform | Interpreter | Why |
|----------|-------------|-----|
| Linux | `process.execPath` (Electron binary) | Electron works as Node via `ELECTRON_RUN_AS_NODE=1` |
| macOS | `process.execPath` (Electron binary) | Same. Path contains spaces (`/Applications/Visual Studio Code.app/.../Code Helper (Plugin)`) — always double-quote it |
| Windows | Console-subsystem `node.exe` from PATH | `Code.exe` is a GUI-subsystem image that cannot attach to a ConPTY |

The resolved interpreter is persisted to `~/.cards/VSCODE_NODE` on every extension activation.

## Shell Variable Syntax

| Context | POSIX | Windows (cmd.exe) |
|---------|-------|-------------------|
| `--settings` command string | `"$VSCODE_NODE" ./bin/handler.mjs` | `"%VSCODE_NODE%" ./bin/handler.mjs` |
| Hook command | `"$CLAUDE_PLUGIN_ROOT"/hooks/bin/hook.mjs` | `"%CLAUDE_PLUGIN_ROOT%"\hooks\bin\hook.mjs` |

Double-quote the interpreter reference on both — the macOS path has spaces.

**Source**: `public/packages/sdk/src/config/env.ts`::`vscodeNodeCommandRef()`: `'%VSCODE_NODE%'` on win32, `'$VSCODE_NODE'` elsewhere.

## Symlinks

| Platform | Symlink type for directories |
|----------|----------------------------|
| Linux | Native symlink |
| macOS | Native symlink |
| Windows | Directory junction (`'junction'` type in `fs.symlink()`) |

Used for marketplace and codex symlinks in `globalStorage`. The `'junction'` type is silently ignored on POSIX.

## Temp Directories

| Platform | `os.tmpdir()` | Demo anchor | Why different |
|----------|--------------|-------------|---------------|
| Linux | `/tmp` | `/tmp` | Same |
| macOS | `/var/folders/{x}/{y}/T` (~54 chars) | `/tmp` (realpath → `/private/tmp`) | `sun_path` limit (above) |
| Windows | `%TEMP%` (expanded to long form via `GetLongPathName`) | `%TEMP%` | No `/tmp` on Windows |

## OneDrive (Windows)

`%USERPROFILE%` on Windows may be synced by OneDrive. Files under `%USERPROFILE%\.cards\` can be affected. The extension does not take special precautions against this. **Status**: known limitation.

## Path Normalization

- Worktree paths: `git` emits forward-slash paths even on Windows. All consumers normalize via `path.resolve()`.
- Windows temp paths: expanded from 8.3 short names using `GetLongPathName` Win32 API to match VS Code's canonical `fsPath`.
- `path.posix.join()` used for forward-slash paths embedded in `settings.json` command strings — these are consumed by the wrapper's shell on POSIX and by Node on Windows (which accepts forward slashes).

## Out of Scope

- Agent CLI platform-specific behavior → Claude Code / Codex documentation
- VS Code platform-specific installation paths → VS Code documentation
- Node.js platform-specific APIs → Node.js documentation

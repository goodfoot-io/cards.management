/**
 * Environment variable utilities for Cards Extension actions.
 *
 * The execution wrapper injects action inputs via process.env.
 * This module provides strict getters and typed extractors so handlers do not
 * need to parse environment variables manually.
 *
 * Use the individual getters when you only need one value; use
 * {@link extractActionInput} when you need a full typed payload for an action.
 *
 *
 * @summary Environment variable utilities for Cards Extension actions
 * @module
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGlobalCardsConfigDir } from '../cards-config.js';
import type { ActionInput, CardsAssistantInput } from './inputs.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Environment variable names set by the Cards execution wrapper.
 *
 * This is the single source of truth for env var keys used by action and type
 * hook processes. Keep it in sync with the wrapper to avoid subtle "undefined
 * input" bugs.
 */
export const CARDS_ENV_VARS = {
  /**
   * Unique identifier for the current card.
   * Available in all actions and type hooks.
   */
  CARD_ID: 'CARD_ID',

  /**
   * The environment name from settings.json.
   * Available in all actions and type hooks.
   */
  ENVIRONMENT: 'ENVIRONMENT',

  /**
   * Display name of the action button that triggered this handler.
   * Available in actions only (not type hooks).
   */
  ACTION_NAME: 'ACTION_NAME',

  /**
   * Card's execution mode, determining UI interaction model.
   * Available in actions only (not type hooks).
   * Valid values: 'interactive' | 'background'
   */
  EXECUTION_MODE: 'EXECUTION_MODE',

  /**
   * Whether the action should exit when done.
   * Available in actions only (not type hooks).
   * Valid values: 'true' | 'false'
   */
  EXIT_WHEN_DONE: 'EXIT_WHEN_DONE',

  /**
   * Configured coding agent identifier from cards.codingAgent setting.
   * Available in actions only (not type hooks).
   * Optional.
   */
  CODING_AGENT: 'CODING_AGENT',

  /**
   * Path to the Node.js interpreter the extension selected for action launches.
   *
   * Set by the extension host. The resolved value is platform-dependent:
   * - **win32 (desktop):** a real console-subsystem `node.exe` discovered on
   *   PATH. `Code.exe` is a GUI-subsystem image that cannot attach to a ConPTY
   *   or run as a console process, so it is deliberately NOT used here.
   * - **POSIX / remote / dev-container:** `process.execPath` (the Electron
   *   binary), run as Node via `ELECTRON_RUN_AS_NODE=1`. There is no
   *   PE-subsystem/console-allocation concept, so the Electron binary works.
   *
   * `ELECTRON_RUN_AS_NODE=1` is still exported alongside this everywhere: it is a
   * no-op for a stock `node.exe` and remains required on POSIX/remote.
   *
   * Commands in settings.json use `"$VSCODE_NODE" ./bin/...` (double-quoted — the
   * macOS interpreter path contains spaces) so they work regardless of whether
   * `node` is on the system PATH.
   *
   * Available in all actions and type hooks.
   */
  VSCODE_NODE: 'VSCODE_NODE',

  /**
   * Path to the Node.js interpreter running the wrapper process.
   *
   * Set by the wrapper from `process.execPath`. Because the wrapper itself now
   * runs under the `VSCODE_NODE` interpreter (a real `node.exe` on win32), its
   * `process.execPath` is that same console-subsystem Node — so `$NODE` is a
   * valid console interpreter on every platform. Use `$NODE` in embedded bash
   * statements to invoke Node scripts portably.
   *
   * Available in all actions.
   */
  NODE: 'NODE',

  /**
   * Path to the Unix domain socket for runtime-to-dispatcher communication.
   * Available in actions only.
   */
  SOCKET_PATH: 'SOCKET_PATH',

  /**
   * Path to a JSON file containing switchToInteractive data from a previous handler.
   * Available in actions only. Optional.
   */
  SWITCH_TO_INTERACTIVE_DATA_PATH: 'SWITCH_TO_INTERACTIVE_DATA_PATH',

  /**
   * Path to the settings configuration directory.
   * Available in actions only.
   */
  CONFIG_PATH: 'CONFIG_PATH',

  /**
   * Path to the VS Code workspace root directory.
   * Set by the action handler (e.g., launch.ts) to the worktree path.
   * Available in hooks running inside the claude CLI.
   */
  WORKSPACE_PATH: 'WORKSPACE_PATH',

  /**
   * Absolute path to the main git repository root (NOT a worktree).
   * Set by ActionDispatcher; consumed by the wrapper and watcher for
   * git operations (worktree removal, branch deletion) that must run
   * against the main repository.
   */
  REPO_ROOT: 'REPO_ROOT',

  /**
   * Path to the card's repository directory.
   * Available in actions only.
   */
  CARD_REPO_PATH: 'CARD_REPO_PATH',

  /**
   * Resolved shell command for the wrapper to spawn as the action handler.
   * Set by ActionDispatcher; consumed by the wrapper (not by action handlers).
   */
  ACTION_COMMAND: 'ACTION_COMMAND',

  /**
   * Git branch that the card's workspace branch will merge into.
   * Resolved from the workspace HEAD at launch time.
   * Set by the launch action.
   * Available in actions only.
   */
  BASE_BRANCH: 'BASE_BRANCH',

  /**
   * Git branch from which the card's workspace branch was created.
   * May differ from BASE_BRANCH when the worktree was created against
   * a different ref than the current workspace HEAD.
   * Set by the launch action.
   * Available in actions only.
   */
  PARENT_BRANCH: 'PARENT_BRANCH',

  /**
   * Git branch name for the card's workspace implementation.
   * Set by the launch action after resolving or creating the worktree.
   * Available in actions only.
   */
  WORKSPACE_BRANCH: 'WORKSPACE_BRANCH',

  /**
   * Session ID persisted by the session-start hook via `persistEnvVar`.
   *
   * Available in Bash tool shell descendants (commands, git hooks) after
   * session start. NOT available in hooks spawned directly by Claude Code
   * (stop, session-end, etc.) — those receive the session ID via hook input.
   *
   * The card-repo post-commit hook reads this to record commits directly
   * without needing a process-tree walk or PID registry lookup.
   */
  CARDS_SESSION_ID: 'CARDS_SESSION_ID',

  /**
   * Absolute path to the Claude Code transcript JSONL file for the current
   * session. Persisted by the session-start hook via `persistEnvVar`.
   *
   * Available in Bash tool shell descendants after session start. Read by
   * attach-mode watcher spawn to target the correct transcript file.
   */
  CARDS_TRANSCRIPT_PATH: 'CARDS_TRANSCRIPT_PATH',

  /**
   * Absolute path to the VS Code extension installation directory.
   *
   * Set by the extension host from `context.extensionUri.fsPath` and injected
   * into all spawned action processes. Use this to locate bundled assets such
   * as the runtime plugin directory (`<extensionPath>/dist/claude/runtime`).
   *
   * Available in actions only (not type hooks).
   */
  EXTENSION_PATH: 'EXTENSION_PATH',

  /**
   * Stable symlink path to the marketplace directory inside global storage.
   *
   * Set by ActionDispatcher at runtime from the symlink created during extension
   * activation. This path does not change across extension upgrades, unlike the
   * versioned extension installation path.
   *
   * Available in actions only (not type hooks).
   */
  MARKETPLACE_PATH: 'MARKETPLACE_PATH',

  /**
   * Opening prompt for the cards assistant, seeding the session's first user
   * turn instead of leaving it to wait for typed input.
   *
   * Set by the extension host from the caller-supplied argument to
   * `cards.startCardsAssistant`. Absent (or empty) reproduces today's cold
   * start.
   *
   * Available in the cards-assistant handler only.
   */
  INITIAL_PROMPT: 'INITIAL_PROMPT',

  /**
   * Absolute path to the extension's cards CLI bin directory
   * (`<extensionPath>/dist/bin`).
   *
   * Set by the extension host on the action env. The cards CLI bin tree (the
   * `.mjs` bundles and shell shims) is produced by the extension build and ships
   * here, no longer under the marketplace plugin tree. Read on win32 by the
   * detached `adhoc-cleanup` spawn to locate the sibling `adhoc-cleanup.mjs`.
   *
   * Available in actions only (not type hooks).
   */
  CARDS_BIN_PATH: 'CARDS_BIN_PATH',

  /**
   * Absolute path to the protected runtime credential handoff file.
   * Secrets are read from this file and never expanded into individual environment variables.
   */
  RUNTIME_CREDENTIAL_FILE: 'CARDS_RUNTIME_CREDENTIAL_FILE',

  /**
   * Absolute path to the Cards hooks log file.
   *
   * Set by ActionDispatcher at runtime. Read by the Logger singleton
   * at construction time to determine where hook execution logs are written.
   *
   * Available in all actions and type hooks.
   */
  HOOKS_LOG_FILE: 'CARDS_HOOKS_LOG_FILE'
} as const;

// ============================================================================
// Individual Getters
// ============================================================================

/**
 * Reads the card identifier from the environment.
 *
 * The execution wrapper always sets this for every action and type hook.
 * @returns The current card ID
 * @throws Error if CARD_ID is missing or empty
 * @example
 * ```typescript
 * const cardId = getCardId();
 * console.log(`Processing card: ${cardId}`);
 * ```
 */
export function getCardId(): string {
  const value = process.env[CARDS_ENV_VARS.CARD_ID];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.CARD_ID}`);
  }
  return value;
}

/**
 * Reads the protected runtime credential-file path from the environment.
 * @returns The absolute credential-file path supplied by the execution wrapper.
 * @throws When the wrapper did not provide a path.
 */
export function getRuntimeCredentialFilePath(): string {
  const value = process.env[CARDS_ENV_VARS.RUNTIME_CREDENTIAL_FILE];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.RUNTIME_CREDENTIAL_FILE}`);
  }
  return value;
}

/**
 * Reads the environment name from the environment.
 *
 * This value matches the environment key in settings.json (e.g., "default", "staging").
 * @returns The environment name
 * @throws Error if ENVIRONMENT is missing or empty
 * @example
 * ```typescript
 * const environment = getEnvironment();
 * console.log(`Environment: ${environment}`);
 * ```
 */
export function getEnvironment(): string {
  const value = process.env[CARDS_ENV_VARS.ENVIRONMENT];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.ENVIRONMENT}`);
  }
  return value;
}

/**
 * Reads the action button name from the environment.
 *
 * This is the display name of the action that triggered the handler, matching
 * the `actionName` field from `defineAction`.
 * @returns Display name of the action that triggered the current handler run.
 * @throws Error if ACTION_NAME is missing or empty
 * @example
 * ```typescript
 * const actionName = getActionName();
 * console.log(`Running action: ${actionName}`);
 * ```
 */
export function getActionName(): string {
  const value = process.env[CARDS_ENV_VARS.ACTION_NAME];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.ACTION_NAME}`);
  }
  return value;
}

/**
 * Reads the execution mode from the environment.
 *
 * Determines the UI interaction model for actions.
 * @returns The execution mode ('interactive' or 'background')
 * @throws Error if EXECUTION_MODE is missing, empty, or invalid
 * @example
 * ```typescript
 * const mode = getExecutionMode();
 * if (mode === 'interactive') {
 *   // Show user prompts
 * }
 * ```
 */
export function getExecutionMode(): 'interactive' | 'background' {
  const value = process.env[CARDS_ENV_VARS.EXECUTION_MODE];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.EXECUTION_MODE}`);
  }
  if (value !== 'interactive' && value !== 'background') {
    throw new Error(`Invalid ${CARDS_ENV_VARS.EXECUTION_MODE}: expected 'interactive' or 'background', got "${value}"`);
  }
  return value;
}

/**
 * Reads the exit-when-done flag from the environment.
 *
 * Determines whether the action should exit when the agent finishes.
 * @returns `true` when the action should exit on completion, `false` otherwise
 * @throws Error if EXIT_WHEN_DONE is missing, empty, or not 'true' or 'false'
 * @example
 * ```typescript
 * const exitWhenDone = getExitWhenDone();
 * if (exitWhenDone) {
 *   // Exit after agent completes
 * }
 * ```
 */
export function getExitWhenDone(): boolean {
  const value = process.env[CARDS_ENV_VARS.EXIT_WHEN_DONE];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.EXIT_WHEN_DONE}`);
  }
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Invalid ${CARDS_ENV_VARS.EXIT_WHEN_DONE}: expected 'true' or 'false', got "${value}"`);
  }
  return value === 'true';
}

/**
 * Reads the configured coding agent identifier from the environment.
 *
 * Optional value from cards.codingAgent setting. When set, indicates which AI
 * coding assistant the user prefers. Actions can use this to customize behavior
 * or prompts for different agents.
 * @returns The coding agent identifier, or undefined if not set
 * @example
 * ```typescript
 * const codingAgent = getCodingAgent();
 * if (codingAgent === 'claude') {
 *   // Customize for Claude
 * }
 * ```
 */
export function getCodingAgent(): string | undefined {
  const value = process.env[CARDS_ENV_VARS.CODING_AGENT];
  if (value === undefined || value === '') {
    return undefined;
  }
  return value;
}

/**
 * Reads the VS Code bundled Node.js interpreter path from the environment.
 *
 * This is set by the extension during activation and injected into all
 * spawned action/hook processes. Configuration authors can use it to invoke
 * Node.js without relying on the system PATH.
 *
 * @returns The path to the Node.js interpreter
 * @throws Error if VSCODE_NODE is missing or empty
 * @example
 * ```typescript
 * const nodePath = getVscodeNodePath();
 * execFileSync(nodePath, ['script.js']);
 * ```
 */
export function getVscodeNodePath(): string {
  const value = process.env[CARDS_ENV_VARS.VSCODE_NODE];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.VSCODE_NODE}`);
  }
  return value;
}

/**
 * Returns the shell-expandable `VSCODE_NODE` reference for a generated command
 * string, double-quoted, for the current host platform.
 *
 * This is the single source of truth for the interpreter token embedded in
 * `settings.json` commands. The wrapper runs those commands through the
 * platform's default shell (`spawn(…, { shell: true })`): `cmd.exe` on win32
 * (which expands `%VAR%` and leaves `$VAR` literal) and `/bin/sh` elsewhere
 * (which expands `$VAR`). Emitting the wrong form leaves the reference
 * unexpanded and the wrapper tries to run a program literally named
 * `$VSCODE_NODE` / `%VSCODE_NODE%`.
 *
 * The reference is double-quoted because the macOS interpreter path contains
 * spaces (`/Applications/Visual Studio Code.app/.../Code Helper (Plugin)`); an
 * unquoted reference word-splits and the shell fails to find the interpreter.
 *
 * Consumers that *parse* a generated command rather than shell-expanding it (the
 * extension's `ProcessLauncher.parseVscodeNodeCommand`) must accept both forms,
 * because a config built on one platform can be read by an extension on another.
 *
 * @returns `"%VSCODE_NODE%"` on win32, `"$VSCODE_NODE"` elsewhere.
 */
export function vscodeNodeCommandRef(): string {
  return process.platform === 'win32' ? '"%VSCODE_NODE%"' : '"$VSCODE_NODE"';
}

/**
 * Reads the Unix domain socket path for runtime-to-dispatcher communication.
 *
 * @returns Unix socket path used to send runtime control messages.
 * @throws Error if SOCKET_PATH is missing or empty
 */
export function getSocketPath(): string {
  const value = process.env[CARDS_ENV_VARS.SOCKET_PATH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.SOCKET_PATH}`);
  }
  return value;
}

/**
 * Reads the path to the switchToInteractive data file.
 *
 * This is optional — returns undefined when not set (i.e., the action
 * was not relaunched via switchToInteractive).
 *
 * @returns The file path, or undefined if not set
 */
export function getSwitchToInteractiveDataPath(): string | undefined {
  const value = process.env[CARDS_ENV_VARS.SWITCH_TO_INTERACTIVE_DATA_PATH];
  if (value === undefined || value === '') {
    return undefined;
  }
  return value;
}

/**
 * Reads the settings configuration directory path.
 *
 * @returns Absolute path to the directory containing generated settings artifacts.
 * @throws Error if CONFIG_PATH is missing or empty
 */
export function getConfigPath(): string {
  const value = process.env[CARDS_ENV_VARS.CONFIG_PATH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.CONFIG_PATH}`);
  }
  return value;
}

/**
 * Reads the workspace path set by the action handler (e.g., the worktree path).
 *
 * This is for hooks running inside the Claude CLI, **not** for action handlers.
 * Action handlers should use {@link getRepoRoot} instead.
 *
 * @returns Absolute path to the active workspace / worktree.
 * @throws Error if WORKSPACE_PATH is missing or empty
 */
export function getWorkspacePath(): string {
  const value = process.env[CARDS_ENV_VARS.WORKSPACE_PATH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.WORKSPACE_PATH}`);
  }
  return value;
}

/**
 * Reads the base branch that the workspace branch will merge into.
 *
 * @returns Branch name string.
 * @throws Error if BASE_BRANCH is missing or empty
 */
export function getBaseBranch(): string {
  const value = process.env[CARDS_ENV_VARS.BASE_BRANCH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.BASE_BRANCH}`);
  }
  return value;
}

/**
 * Reads the workspace branch name for the card's implementation.
 *
 * @returns Branch name string.
 * @throws Error if WORKSPACE_BRANCH is missing or empty
 */
export function getWorkspaceBranch(): string {
  const value = process.env[CARDS_ENV_VARS.WORKSPACE_BRANCH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.WORKSPACE_BRANCH}`);
  }
  return value;
}

/**
 * Reads the main git repository root path.
 *
 * Set by ActionDispatcher; used by action handlers to resolve worktrees
 * and perform git operations against the main repository.
 *
 * @returns Absolute path to the main git repository root (NOT a worktree).
 * @throws Error if REPO_ROOT is missing or empty
 */
export function getRepoRoot(): string {
  const value = process.env[CARDS_ENV_VARS.REPO_ROOT];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.REPO_ROOT}`);
  }
  return value;
}

/**
 * Reads the card's repository directory path.
 *
 * @returns Absolute path to the repository associated with the active card.
 * @throws Error if CARD_REPO_PATH is missing or empty
 */
export function getCardRepoPath(): string {
  const value = process.env[CARDS_ENV_VARS.CARD_REPO_PATH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.CARD_REPO_PATH}`);
  }
  return value;
}

/**
 * Reads the VS Code extension installation directory path.
 *
 * Set by the extension host from `context.extensionUri.fsPath` and injected
 * into all spawned action processes. Use this to locate bundled assets such
 * as the runtime plugin directory (`<extensionPath>/dist/claude/runtime`).
 *
 * @returns Absolute path to the extension installation directory.
 * @throws Error if EXTENSION_PATH is missing or empty
 */
export function getExtensionPath(): string {
  const value = process.env[CARDS_ENV_VARS.EXTENSION_PATH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.EXTENSION_PATH}`);
  }
  return value;
}

/**
 * Resolves the extension installation path for CLI contexts where `EXTENSION_PATH`
 * is not injected by the ActionDispatcher.
 *
 * Resolution order:
 * 1. `EXTENSION_PATH` env var (set in action subprocess environments).
 * 2. `~/.cards/EXTENSION_PATH` file (written by the extension on activation,
 *    mirrors the `~/.cards/VSCODE_NODE` pattern for terminal CLI use).
 *
 * @returns Absolute path to the extension installation directory.
 * @throws Error if neither source provides a non-empty path.
 */
export async function resolveExtensionPath(): Promise<string> {
  const fromEnv = (process.env[CARDS_ENV_VARS.EXTENSION_PATH] ?? '').trim();
  if (fromEnv) return fromEnv;

  // Honor $CARDS_HOME (then XDG, then ~/.cards) via the shared resolver — NOT a
  // bare homedir()/.cards. On the host leg the OS HOME stays real while the Cards
  // server is isolated under $CARDS_HOME; the extension writes EXTENSION_PATH
  // there, so a homedir-based read looks in the wrong (often empty) place.
  const filePath = join(resolveGlobalCardsConfigDir(), 'EXTENSION_PATH');
  let fromFile: string;
  try {
    fromFile = (await readFile(filePath, 'utf-8')).trim();
  } catch (error) {
    // Only "file absent" means "extension never activated"; surface anything else
    // (e.g. a permission error) rather than misreporting it as not-installed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `Cannot resolve extension path: EXTENSION_PATH env var is not set and ${filePath} does not exist. ` +
        `Ensure the Cards extension is installed and has been activated at least once.`
    );
  }
  if (!fromFile) {
    throw new Error(
      `Cannot resolve extension path: ~/.cards/EXTENSION_PATH is empty. ` +
        `Restart VS Code to allow the Cards extension to re-write it.`
    );
  }
  return fromFile;
}

/**
 * Reads the stable marketplace symlink path from the environment.
 *
 * Set by ActionDispatcher from the symlink created during extension activation.
 * This path is stable across extension upgrades.
 *
 * @returns Absolute path to the marketplace symlink.
 * @throws Error if MARKETPLACE_PATH is missing or empty
 */
export function getMarketplacePath(): string {
  const value = process.env[CARDS_ENV_VARS.MARKETPLACE_PATH];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${CARDS_ENV_VARS.MARKETPLACE_PATH}`);
  }
  return value;
}

/**
 * Reads the cards assistant's opening prompt, if the caller supplied one.
 *
 * Unlike the other getters in this section, this is non-throwing: an absent
 * or empty value means "no opening prompt" (today's cold start), not a
 * misconfiguration.
 *
 * @returns The opening prompt string, or undefined if not set or empty.
 */
export function getInitialPrompt(): string | undefined {
  const value = process.env[CARDS_ENV_VARS.INITIAL_PROMPT];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reads and parses the switchToInteractive data file.
 *
 * When `SWITCH_TO_INTERACTIVE_DATA_PATH` is set, reads the file at that path
 * and parses it as JSON. Returns undefined if the env var is not set.
 *
 * @returns The parsed data, or undefined if the path is not set
 * @throws Error if the file cannot be read or contains invalid JSON
 */
export function readSwitchToInteractiveData(): unknown | undefined {
  const dataPath = getSwitchToInteractiveDataPath();
  if (dataPath === undefined) {
    return undefined;
  }
  const content = readFileSync(dataPath, 'utf-8');
  return JSON.parse(content);
}

// ============================================================================
// Typed Input Extraction
// ============================================================================

/**
 * Builds a typed action input object from environment variables.
 *
 * Extracts all fields required for action handlers.
 *
 * @returns Typed ActionInput object
 * @throws Error if required env vars are missing or invalid
 * @example
 * ```typescript
 * // For an action handler
 * const input = extractActionInput();
 * console.log(input.cardId);
 * console.log(input.executionMode);
 * ```
 */
export function extractActionInput(): ActionInput {
  return {
    cardId: getCardId(),
    actionName: getActionName(),
    environment: getEnvironment(),
    executionMode: getExecutionMode(),
    exitWhenDone: getExitWhenDone(),
    codingAgent: getCodingAgent(),
    switchToInteractiveData: readSwitchToInteractiveData(),
    repoRoot: getRepoRoot(),
    cardRepoPath: getCardRepoPath(),
    configPath: getConfigPath(),
    extensionPath: getExtensionPath(),
    marketplacePath: getMarketplacePath()
  };
}

/**
 * Builds a typed cards-assistant input object from environment variables.
 *
 * Extracts the fields required for cards-assistant handlers. Unlike
 * {@link extractActionInput}, this does not require card-specific env vars
 * (CARD_ID, ACTION_NAME, etc.) since the cards assistant operates at
 * workspace scope.
 *
 * @returns Typed CardsAssistantInput object
 * @throws Error if required env vars are missing or invalid
 * @example
 * ```typescript
 * const input = extractCardsAssistantInput();
 * console.log(input.marketplacePath);
 * ```
 */
export function extractCardsAssistantInput(): CardsAssistantInput {
  return {
    marketplacePath: getMarketplacePath(),
    extensionPath: getExtensionPath(),
    codingAgent: getCodingAgent(),
    repoRoot: getRepoRoot(),
    initialPrompt: getInitialPrompt()
  };
}

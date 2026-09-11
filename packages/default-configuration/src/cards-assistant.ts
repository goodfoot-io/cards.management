/**
 * Default cards assistant handler for the Cards extension.
 *
 * Branches on `input.codingAgent` via {@link resolveCodingAgent}:
 * - Claude: calls `updateMarketplaceRegistration`, then spawns the `claude` CLI
 *   with both the `cards@cards.management` and `cards-assistant@cards.management`
 *   plugins enabled, passing the interview instructions via `--append-system-prompt`.
 * - Codex: stages the `cards` and `cards-assistant` plugins into a managed
 *   `CODEX_HOME`, writes a `cards-assistant` profile, and spawns `codex` with
 *   `--profile cards-assistant` and the interview instructions as a
 *   `developer_instructions` override via `-c`.
 * - OpenCode: stages the `cards` and `cards-assistant` plugins into the
 *   content-addressed cache, writes the per-set staged config document, and
 *   spawns the `opencode` TUI with the interview instructions seeded as the
 *   opening turn via `--prompt` and the repo root as the project positional,
 *   passing the document via `OPENCODE_CONFIG`.
 * - Antigravity: spawns `agy` interactively (`-i`) with the assistant
 *   instructions as the opening prompt. No plugin is globally enabled for this
 *   launch and no card/session state exists: no card ID, no worktree, no branch
 *   watcher, no `EXIT_WHEN_DONE` override, and no card settlement calls.
 *
 * When `input.initialPrompt` is set, it is appended to the Claude branch's
 * `cliArgs` after a `--` end-of-options terminator, so `claude` treats it as
 * the session's opening user turn even if it begins with `-` — the
 * terminator prevents an attacker-influenced prompt from being parsed as CLI
 * flags. The Codex and OpenCode branches do not read it; it is unreachable
 * via `cards.startCardsAssistant` in this release.
 *
 * Unlike action handlers, this handler has no card context, no worktree, and no
 * socket. It runs in `input.repoRoot` under either coding agent.
 *
 * @summary Default cards assistant handler
 * @module
 */

import { defineCardsAssistant } from '@cards.management/sdk/config';
import { updateMarketplaceRegistration } from './lib/claude-session.js';
import {
  CODEX_ASSISTANT_PLUGIN_NAMES,
  formatDeveloperInstructionsOverride,
  populateCodexPluginCache,
  resolveDefaultCodexHome,
  writeCodexProfileConfig
} from './lib/codex-session.js';
import { resolveCodingAgent } from './lib/coding-agent.js';
import {
  assertOpencodeBinaryAvailable,
  OPENCODE_ASSISTANT_PLUGIN_NAMES,
  populateOpencodePluginCache,
  readGlobalPluginEntries,
  resolveCardsOpencodeStagingDir,
  resolveDefaultOpencodeConfigDir,
  writeCardsLaunchConfig
} from './lib/opencode-session.js';
import { spawnAgentCli } from './lib/spawn-cli.js';

const INTERVIEW_INSTRUCTIONS = `<instructions>
    You are the Cards assistant: a conversational front-end to the Cards extension. Load the \`cards:cards\` skill. These six modes are exhaustive — no request falls outside them; if unsure which applies, \`cards search\` the request's terms before deciding.

    Modes:
    - Create a card — goal/outcome phrasing, no existing card matches, and scope is real (multi-file, new behavior, unclear repro). Grep/Read the affected area to size it, \`cards search\` to rule out duplicates, match card type by deliverable (bug/feature/doc/maintenance/operations/investigation — investigation only if asked or too large for one session), then interview via that type's guide before creating.
    - Capture quickly — user or a calling agent explicitly asks to capture something quickly, or another workflow dispatches here to record an issue it hit. Confirm title/scope in one exchange, no interview.
    - Modify a card — user names or describes an existing card and wants scope/CARD.md/comments/notes/attachments/tags/relations changed. Resolve via \`cards <id>\` or \`cards search\`, read current state, edit directly, no interview.
    - Act on a card — user wants an existing card launched/bound/watched. Resolve via \`cards <id>\`, confirm status/gates/worktree fit the action, start it — the user implements, you don't.
    - Drive the extension — user wants a VS Code action (open file, run command, panel, notify, debugger), independent of any card. Check \`cards:cards\`'s \`./references/extension-cli.md\` for the matching command and run it; no card involved.
    - Troubleshoot or give feedback on Cards itself — complaint is about the extension's own behavior, not the user's project. Load \`cards:debug\`; extension bugs/features go to \`cards-extension issue\`, not a card.

    Always: never name the extension's servers, processes, or endpoints — describe outcomes. Verify, don't guess — run the check yourself rather than asking. Ask one question at a time, with your recommended answer attached. Resolve feasibility/research yourself (codebase, git, web); frame any information gap as your own need, never the user's failure to provide it. Confirm ambiguous deliverables in plain language before acting, without naming the card type.
    </instructions>`;

export default defineCardsAssistant({}, async (input, { logger }) => {
  const agent = resolveCodingAgent(input);

  if (agent === 'antigravity-cli') {
    // This branch is workspace/window-owned — no card ID, no worktree, no
    // branch watcher, no EXIT_WHEN_DONE override, and no card settlement calls.
    const args = ['-i', INTERVIEW_INSTRUCTIONS];

    logger.info('Starting cards assistant (antigravity)', {
      cwd: input.repoRoot
    });

    const child = spawnAgentCli('agy', args, {
      cwd: input.repoRoot,
      stdio: 'inherit',
      // Detached on POSIX so `agy` roots its own process group: the extension
      // records the group for window-disposal and cancellation drains
      // (graceful-then-forced, same escalation as the action paths).
      detached: process.platform !== 'win32'
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      // Fail closed: a spawn failure (e.g. ENOENT when the `agy` binary is
      // missing) emits `error` but never `close`, which would leave this
      // promise hung forever. Mirrors the codex/claude/opencode launch
      // guards above/below.
      child.on('error', (error) => {
        logger.error('Failed to spawn agy', {
          error: error instanceof Error ? error.message : String(error)
        });
        resolve(null);
      });
      child.on('close', resolve);
    });

    logger.info('Cards assistant exited', { exitCode });
    return;
  }

  if (agent === 'codex-cli') {
    const codexHome = resolveDefaultCodexHome();
    const { pluginCachePaths } = await populateCodexPluginCache(
      codexHome,
      input.marketplacePath,
      CODEX_ASSISTANT_PLUGIN_NAMES
    );
    const profilePath = await writeCodexProfileConfig(codexHome, {
      profileName: 'cards-assistant',
      pluginNames: CODEX_ASSISTANT_PLUGIN_NAMES,
      pluginCachePaths
    });

    const args = [
      '--dangerously-bypass-approvals-and-sandbox',
      '--profile',
      'cards-assistant',
      '--cd',
      input.repoRoot,
      '-c',
      formatDeveloperInstructionsOverride(INTERVIEW_INSTRUCTIONS)
    ];

    logger.info('Starting cards assistant (codex)', {
      cwd: input.repoRoot,
      codexHome,
      profilePath
    });

    // Route through cross-spawn so the win32 PATHEXT shim (`codex.cmd`) resolves
    // and its arguments are escaped for cmd.exe; on POSIX it spawns `codex`
    // directly. A bare `spawn('codex', …)` ENOENTs on the `.cmd` shim on win32.
    const child = spawnAgentCli('codex', args, {
      cwd: input.repoRoot,
      stdio: 'inherit',
      env: { ...process.env, CODEX_HOME: codexHome }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      // Fail closed: a spawn failure (e.g. ENOENT when the `codex` shim is
      // missing) emits `error` but never `close`, which would leave this promise
      // hung forever. Mirrors the `claude` launch guard below.
      child.on('error', (error) => {
        logger.error('Failed to spawn codex', {
          error: error instanceof Error ? error.message : String(error)
        });
        resolve(null);
      });
      child.on('close', resolve);
    });

    logger.info('Cards assistant exited', { exitCode });
    return;
  }

  if (agent === 'opencode-cli') {
    const opencodeBinary = await assertOpencodeBinaryAvailable();
    const configDir = resolveDefaultOpencodeConfigDir();
    const { pluginCachePaths } = await populateOpencodePluginCache(
      configDir,
      input.marketplacePath,
      OPENCODE_ASSISTANT_PLUGIN_NAMES
    );
    const stagingDir = resolveCardsOpencodeStagingDir();
    // The staged document must not re-register globally registered plugins
    // under a distinct load identity (double hook execution) — hand the
    // writer the global layer's registrations so it can stage the colliding
    // pointer spec.
    const globalRegistrations = await readGlobalPluginEntries(configDir);
    if (globalRegistrations.failure !== undefined) {
      logger.warn('Could not read the global OpenCode config plugin registrations', {
        configDir,
        reason: globalRegistrations.failure
      });
    }
    const configPath = await writeCardsLaunchConfig(
      stagingDir,
      'assistant',
      OPENCODE_ASSISTANT_PLUGIN_NAMES,
      pluginCachePaths,
      {
        globalPluginEntries: globalRegistrations.entries
      }
    );

    // Interactive TUI launch, mirroring the action path's live-verified argv
    // shape (`buildOpencodeArgs` in ./lib/opencode-session.js): the TUI
    // accepts neither `--dir` nor a system-prompt override flag, so the
    // interview instructions seed the opening turn via `--prompt` and the
    // repo root rides as the project positional. `input.initialPrompt` is
    // not read by this branch — it is unreachable via
    // `cards.startCardsAssistant` in this release (same gap as the codex
    // branch, named there).
    const args = ['--prompt', INTERVIEW_INSTRUCTIONS, input.repoRoot];

    logger.info('Starting cards assistant (opencode)', {
      cwd: input.repoRoot,
      configDir,
      stagingDir,
      configPath
    });

    // Route through cross-spawn so the win32 PATHEXT shim resolves and its
    // arguments are escaped for cmd.exe; on POSIX it spawns the resolved
    // absolute path directly.
    const child = spawnAgentCli(opencodeBinary, args, {
      cwd: input.repoRoot,
      stdio: 'inherit',
      env: { ...process.env, OPENCODE_CONFIG: configPath }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      // Fail closed: a spawn failure (e.g. ENOENT when the binary is missing)
      // emits `error` but never `close`, which would leave this promise hung
      // forever. Mirrors the codex/claude launch guards above.
      child.on('error', (error) => {
        logger.error('Failed to spawn opencode', {
          error: error instanceof Error ? error.message : String(error)
        });
        resolve(null);
      });
      child.on('close', resolve);
    });

    logger.info('Cards assistant exited', { exitCode });
    return;
  }

  await updateMarketplaceRegistration(input.marketplacePath, logger);

  const settingsJson = JSON.stringify({
    enabledPlugins: {
      'cards@cards.management': true,
      'cards-assistant@cards.management': true
    },
    extraKnownMarketplaces: {
      'cards.management': {
        source: { source: 'directory', path: input.marketplacePath }
      }
    }
  });

  const cliArgs = [
    '--append-system-prompt',
    INTERVIEW_INSTRUCTIONS,
    '--settings',
    settingsJson,
    ...(input.initialPrompt ? ['--', input.initialPrompt] : [])
  ];

  logger.info('Starting cards assistant', {
    cwd: input.repoRoot,
    marketplacePath: input.marketplacePath
  });

  // Route through cross-spawn rather than `spawn('claude', …, { shell: win32 })`.
  // On win32 the `claude` CLI is a PATHEXT `.cmd` shim: a bare spawn ENOENTs, and
  // a `shell: true` spawn resolves the shim but concatenates argv into the cmd.exe
  // command line UNQUOTED — so the `"`/`{`/`}` in `--settings '{…JSON…}'` and the
  // multi-line `--append-system-prompt` get mangled and claude exits before its
  // session starts ("The system cannot find the file specified"). cross-spawn
  // resolves the shim AND escapes each argument for cmd.exe, so complex args
  // survive intact and the multi-line prompt no longer needs collapsing; on POSIX
  // it spawns the binary directly. Mirrors the action-path launch in
  // `claude-session.ts`.
  const child = spawnAgentCli('claude', cliArgs, {
    cwd: input.repoRoot,
    stdio: 'inherit'
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    // Fail closed: a spawn failure (e.g. ENOENT when the shim is missing) emits
    // `error` but never `close`, which would leave this promise hung forever.
    child.on('error', (error) => {
      logger.error('Failed to spawn claude', {
        error: error instanceof Error ? error.message : String(error)
      });
      resolve(null);
    });
    child.on('close', resolve);
  });

  logger.info('Cards assistant exited', { exitCode });
});

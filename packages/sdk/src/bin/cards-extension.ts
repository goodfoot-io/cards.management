/**
 * `cards-extension` CLI dispatcher.
 *
 * Routes argv into subcommand handlers for attribution, notify, workspace,
 * editor, execute-command, panel, and debug.
 * The dispatcher never calls `process.exit` — only the module-bottom
 * executable guard does, exactly once, so the exported `main` function
 * is safe to invoke from vitest workers.
 *
 * @summary cards-extension CLI dispatcher
 */

import { runAttribution } from './cards-extension/attribution.js';
import { runDebug } from './cards-extension/debug.js';
import { runEditor } from './cards-extension/editor.js';
import { runExecuteCommand } from './cards-extension/execute-command.js';
import { runIssue } from './cards-extension/issue.js';
import { runNotify } from './cards-extension/notify.js';
import { runPanel } from './cards-extension/panel.js';
import { runRuntime } from './cards-extension/runtime.js';
import { runWorkspace } from './cards-extension/workspace.js';
import { formatErrorForCli } from './process-utils.js';

const HELP = `Usage: cards-extension <subcommand> [options]

Cards VSCode extension CLI.

Subcommands:
  attribution <set|get|clear>    Manage the attribution/comparison state
  notify --type ... --title ... --message ... --source ...
                                 Send a notification to the VSCode UI
  workspace <list>               List workspaces registered with VS Code
  editor <info|open|select>      Inspect or control the active editor
  execute-command <commandId>    Execute a VS Code command
  issue                           Open a pre-filled GitHub issue (reads JSON {title, body} from stdin)
  panel <show>                   Show a VS Code panel
  debug <start|stop|state>       Control the VS Code debugger
  runtime retire <execution-id>  Guardedly retire a proven-dead legacy execution

Options:
  -h, --help                     Show this help text

Examples:
  cards-extension attribution set <<'EOF'
  { "baseRef": "main", "compareRef": "feature/x" }
  EOF
  cards-extension attribution get
  cards-extension attribution clear
  cards-extension notify --type info --title "Built" --message "All tests pass" --source agent
  cards-extension workspace list
  cards-extension editor info --workspace /path/to/workspace
  cards-extension editor open src/auth.ts --line 42
  cards-extension editor select src/index.ts --start 10:1 --end 15:20
  cards-extension execute-command editor.action.formatDocument
  cards-extension issue <<'EOF'
  {"title": "Login fails on Ubuntu", "body": "When I click login nothing happens."}
  EOF
  cards-extension panel show problems
  cards-extension debug start --config "My Config"
  cards-extension debug stop
  cards-extension debug state

Run 'cards-extension <subcommand> --help' for subcommand help.`;

/**
 * Parse argv tail and dispatch to the appropriate subcommand handler.
 *
 * @param argv - The argv tail (everything after the executable path).
 * @returns The intended process exit code. Never calls process.exit itself.
 */
export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  if (!sub) {
    console.error(HELP);
    return 1;
  }
  if (sub === '-h' || sub === '--help') {
    console.log(HELP);
    return 0;
  }

  try {
    if (sub === 'attribution') return await runAttribution(rest);
    if (sub === 'notify') return await runNotify(rest);
    if (sub === 'workspace') return await runWorkspace(rest);
    if (sub === 'editor') return await runEditor(rest);
    if (sub === 'execute-command') return await runExecuteCommand(rest);
    if (sub === 'issue') return await runIssue(rest);
    if (sub === 'panel') return await runPanel(rest);
    if (sub === 'debug') return await runDebug(rest);
    if (sub === 'runtime') return await runRuntime(rest);

    console.error(`cards-extension: unknown command "${sub}"`);
    console.error(HELP);
    return 1;
  } catch (error) {
    console.error('cards-extension:', formatErrorForCli(error));
    return 1;
  }
}

// Executable guard.
//
// We deliberately do NOT call `process.exit(code)` here. The subcommands talk
// to the extension over HTTP via `fetch`; on Windows a forced `process.exit`
// from this resolution races libuv tearing down the request's socket/threadpool
// async handles and trips a fatal libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`, async.c) that aborts the process with
// 0xC0000409 even though the command already succeeded and printed its result.
// Setting `process.exitCode` and letting the event loop drain naturally avoids
// the race entirely — well-behaved subcommands exit within a few hundred ms.
//
// The unref'd safety timer is a fail-closed backstop: it cannot itself keep the
// loop alive, so the normal path still exits promptly and cleanly. It only fires
// if some handle genuinely lingers past the deadline, in which case a bounded
// forced exit is preferable to hanging a human's terminal.
if (process.argv[1]?.endsWith('cards-extension.mjs')) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    const fallback = setTimeout(() => process.exit(code), 5_000);
    fallback.unref();
  });
}

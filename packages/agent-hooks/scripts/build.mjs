// Manifest-driven multi-target build for @cards.management/agent-hooks.
//
// Emits all ten plugin payloads — the three Claude targets (core, assistant,
// runtime) and the three Codex targets (core, assistant, runtime), each via
// its SDK CLI, the three OpenCode targets (core → cards, assistant →
// cards-assistant, runtime → runtime) emitted directly with esbuild, and the
// Antigravity runtime target (hooks.json + self-contained bin/ handlers) —
// into their existing output directories under public/, with the exact
// per-target flags inherited from the former package.json `build` scripts.
// Each target globs only its own handler directory; shared leaves in
// src/shared/ are pulled into every bundle through normal imports, never
// added to an input glob (matching today, where the hook CLI ignores
// non-hook modules).
//
// Plain Node ESM, consistent with scripts/validate.mjs and scripts/typecheck.mjs
// at the workspace root — no TS-runner tooling.

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEsmRequireBridgeToDirectory } from './esm-require-bridge.mjs';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// The hook CLI JS entry point, spawned with `process.execPath` (see
// {@link buildTarget}). We deliberately do NOT spawn the bare `.bin` shim: on
// Windows that shim is a `.cmd`, which Node can only launch through a shell
// (`shell: true`), and cmd.exe then mangles any `--executable` argument
// containing shell metacharacters (`"`, `$()`, `||`, `2>`) before the CLI ever
// parses argv — silently truncating the stamped hook command and breaking its
// trust hash. Resolving `dist/cli.js` and running `node <entry> …` passes argv
// verbatim on every platform. `@goodfoot/agent-hooks`'s `exports` map has no
// `./cli` subpath (only `.`, `./claude-code`, `./codex`, `./opencode`), so the
// CLI entry is resolved off the package's `.` export (`dist/index.js`) instead
// — `cli.js` sits alongside it in `dist/`, matching the installed
// `node_modules/.bin/agent-hooks` symlink target. The single CLI now builds
// both agents, selected per target via `--agent`.
const agentHooksCli = path.join(path.dirname(fileURLToPath(import.meta.resolve('@goodfoot/agent-hooks'))), 'cli.js');

// The VSCODE_NODE executable wrapper, embedded verbatim into every hooks.json
// command string. The `$(...)` is intentionally NOT command-substituted — the
// CLI stamps this literal string (including the surrounding quotes) so the
// plugin resolves the VS Code-bundled Node at runtime.
//
// `ELECTRON_RUN_AS_NODE=1` forces a desktop VS Code's Electron binary to run as
// a headless Node interpreter rather than launching a GUI window. The agent CLI
// (claude/codex) spawns these hook commands and does NOT set the var, so without
// it every hook invocation (SessionStart, PostToolUse, Stop, …) pops a focus-
// stealing Electron window on a macOS host where VSCODE_NODE is the Electron
// `code` binary. It is a no-op for a real `node` on PATH.
const EXECUTABLE = 'ELECTRON_RUN_AS_NODE=1 "$(cat $HOME/.cards/VSCODE_NODE 2>/dev/null || echo node)"';

const TEXT_LOADERS = ['--loader', '.md=text', '--loader', '.txt=text'];

/**
 * Ceiling on one target's CLI build, in milliseconds.
 *
 * The CLI compiles through esbuild's long-lived service process, whose requests
 * carry no timeout of their own, so a service that stops answering parks the CLI
 * on an unsettled promise with no timer to break the tie. Nothing above this
 * call bounds the wait either: `payload-build.js` `execFileSync`s this script,
 * `runTest.ts` and `yarn test` await that, and `validate.mjs`'s `runStep`
 * resolves only on `close`. An unresponsive target therefore used to freeze the
 * whole pipeline at zero CPU rather than fail it — observed once, when the CLI
 * emitted its completion line for `claude-core` and then never exited, stalling
 * a `yarn validate` run for ten minutes with `build.mjs`, the CLI, and the
 * esbuild service all idle.
 *
 * Matches the ceiling `test/setup/build-once.ts` already puts on this same
 * script for all nine targets at once, so it is strictly looser than a bound the
 * suite already accepts and cannot fail a target that path would have passed.
 */
const TARGET_TIMEOUT_MS = 120_000;

/**
 * The six build targets. `agent` selects the CLI's `--agent claude-code|codex`
 * flag; `clean` lists the output subdirectories to remove before compiling
 * (relative to the target's output base); `logEnvVar` is the Claude-only
 * `--log-env-var` name.
 */
const targets = [
  {
    name: 'claude-core',
    agent: 'claude-code',
    input: 'src/claude/core/**/*.ts',
    outBase: '../../claude/cards',
    output: '../../claude/cards/hooks/hooks.json',
    clean: ['hooks'],
    loaders: [],
    // No stamped log env var: the bundle installs its own computed default via
    // src/shared/default-log-file.ts, and the operator override is the upstream
    // name (CLAUDE_CODE_HOOKS_LOG_FILE) the logger singleton reads by default.
    logEnvVar: null
  },
  {
    name: 'claude-assistant',
    agent: 'claude-code',
    input: 'src/claude/assistant/**/*.ts',
    outBase: '../../claude/cards-assistant',
    output: '../../claude/cards-assistant/hooks/hooks.json',
    clean: ['hooks', 'bin', 'content'],
    loaders: TEXT_LOADERS,
    logEnvVar: 'CLAUDE_CODE_ASSISTANT_HOOKS_LOG_FILE'
  },
  {
    name: 'claude-runtime',
    agent: 'claude-code',
    input: 'src/claude/runtime/**/*.ts',
    outBase: '../../claude/runtime',
    output: '../../claude/runtime/hooks/hooks.json',
    clean: ['hooks', 'bin', 'content'],
    loaders: TEXT_LOADERS,
    logEnvVar: 'CLAUDE_CODE_RUNTIME_HOOKS_LOG_FILE'
  },
  {
    name: 'codex-assistant',
    agent: 'codex',
    input: 'src/codex/assistant/**/*.ts',
    outBase: '../../codex/cards-assistant',
    output: '../../codex/cards-assistant/hooks/hooks.json',
    clean: ['hooks', 'bin', 'content'],
    loaders: TEXT_LOADERS,
    logEnvVar: null
  },
  {
    name: 'codex-runtime',
    agent: 'codex',
    input: 'src/codex/runtime/**/*.ts',
    outBase: '../../codex/runtime',
    output: '../../codex/runtime/hooks/hooks.json',
    clean: ['hooks', 'bin', 'content'],
    loaders: TEXT_LOADERS,
    logEnvVar: null
  },
  {
    name: 'codex-core',
    agent: 'codex',
    input: 'src/codex/core/**/*.ts',
    outBase: '../../codex/cards',
    output: '../../codex/cards/hooks/hooks.json',
    clean: ['hooks'],
    loaders: [],
    logEnvVar: null
  }
];

/**
 * The three OpenCode build targets.
 *
 * OpenCode v1.18.21 plugins are in-process modules executed by the host's
 * embedded Bun — there is no hooks.json and nothing to stamp (no
 * ELECTRON_RUN_AS_NODE / VSCODE_NODE indirection). Each target bundles every
 * handler under its own `src/opencode/<area>/` directory into one
 * self-contained `<name>.mjs` per handler at `<outBase>/<name>.mjs`, exporting
 * the plugin factory functions verbatim. Bundling is required because the
 * emitted files run from installed payload locations where the workspace
 * packages (`@cards.management/sdk`, …) do not resolve; only Node builtins and
 * the editor-only `vscode` module stay external.
 */
const opencodeTargets = [
  {
    name: 'opencode-core',
    input: 'src/opencode/core/**/*.ts',
    // Core handlers ship with the `cards` plugin, mirroring the Codex layout.
    outBase: '../../opencode/cards/plugin'
  },
  {
    name: 'opencode-assistant',
    input: 'src/opencode/assistant/**/*.ts',
    outBase: '../../opencode/cards-assistant/plugin'
  },
  {
    name: 'opencode-runtime',
    input: 'src/opencode/runtime/**/*.ts',
    outBase: '../../opencode/runtime/plugin'
  }
];

/**
 * Recursively lists the `.ts` entry files under a directory relative to the
 * package root, sorted for deterministic output ordering.
 *
 * @param dirRel - Directory to scan, relative to the package root.
 * @returns Absolute paths of every `.ts` file beneath it (sorted).
 */
function listEntryFiles(dirRel) {
  const absDir = path.resolve(packageRoot, dirRel);
  const entries = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.ts')) {
        entries.push(path.join(dir, entry.name));
      }
    }
  };

  walk(absDir);
  return entries.sort();
}

/**
 * Resolves the concrete directory to scan from a target's glob-style `input`
 * by cutting at the first wildcard segment, so an input like
 * `src/x/(star)(star)/star.ts` scans `src/x`.
 *
 * @param input - The target's input glob.
 * @returns Directory path relative to the package root.
 */
function inputScanRoot(input) {
  const wildcard = input.indexOf('*');
  const dir = wildcard === -1 ? path.dirname(input) : input.slice(0, wildcard);
  return dir.replace(/[/\\]+$/, '');
}

/**
 * Builds one OpenCode target: cleans the output directory, then bundles each
 * handler source into a flat `<basename>.mjs` beside its siblings via esbuild.
 *
 * Flags follow the pinned decision for this emitter: ESM output on the Node
 * platform (`platform: 'browser'` is wrong — these modules import `node:*`
 * builtins), `esnext` target for Bun, full bundling, `vscode` external. The
 * banner bridges one gap between the two: bundled CommonJS dependencies that
 * `require()` Node builtins compile to esbuild's `__require` shim, which has
 * no `require` binding under strict ESM. OpenCode's Bun tolerates it, but the
 * banner gives every runtime a working binding instead of relying on that.
 *
 * @param {typeof opencodeTargets[number]} target - Target descriptor.
 */
async function buildOpencodeTarget(target) {
  const esbuild = require('esbuild');
  const outDir = path.resolve(packageRoot, target.outBase);

  rmSync(outDir, { recursive: true, force: true });

  const entryFiles = listEntryFiles(inputScanRoot(target.input));
  if (entryFiles.length === 0) {
    throw new Error(`target ${target.name} has no entry files under ${target.input}`);
  }

  await Promise.all(
    entryFiles.map((entryFile) =>
      esbuild.build({
        entryPoints: [entryFile],
        outfile: path.join(outDir, `${path.basename(entryFile, '.ts')}.mjs`),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'esnext',
        external: ['vscode'],
        banner: {
          js: [
            "import { createRequire as cardsCreateRequire } from 'node:module';",
            'const require = cardsCreateRequire(import.meta.url);'
          ].join('\n')
        },
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'warning'
      })
    )
  );
}

/**
 * The Antigravity build target.
 *
 * The Antigravity host (pinned `agy` CLI) recognizes a plugin root with an
 * optional root `hooks.json`; only the `runtime` logical plugin ships one
 * (see the card's notes/antigravity-host-contract.md "Cards hook matrix").
 * Like OpenCode, there is no SDK CLI support for this agent, so the target
 * follows the OpenCode direct-esbuild pattern: one self-contained `.mjs` per
 * handler on the Node platform, plus a generated root `hooks.json` in the
 * host's *named hooks* schema — one hook (`cards-runtime`) mapping the three
 * pinned events to bounded-timeout command specs whose command paths are
 * relative to the hooks.json root (the host resolves hook commands with the
 * hooks.json directory as the working directory).
 *
 * The output base is the shared Antigravity plugin root — `plugin.json` and
 * `skills/` are owned by other payload generators, so the cleaner removes
 * only this emitter's own outputs (`hooks.json` and `bin/`).
 */
const antigravityTargets = [
  {
    name: 'antigravity-runtime',
    input: 'src/antigravity/runtime/**/*.ts',
    outBase: '../../antigravity/runtime'
  }
];

/**
 * The pinned `runtime/hooks.json` registration matrix, exactly as the
 * Antigravity host contract requires: three events, `bin/` command paths
 * relative to the hooks.json root, bounded explicit timeouts (seconds). There
 * are intentionally no Cards PreToolUse hooks — in this host a PreToolUse
 * response `{}` is a denial, and no allow path is shipped.
 *
 * The host's hooks.json schema (pinned CLI v1.1.22, docs
 * antigravity.google/docs/hooks, disposable-host smoke witness) is *named
 * hooks*: the top level maps a hook name to an event → command-spec map. The
 * flat Claude-Code-style `{"hooks": {…}}` wrapper is rejected by the host
 * (`invalid hook "hooks": command hook must specify 'command'`) and no hook
 * ever fires.
 */
const ANTIGRAVITY_HOOK_REGISTRATIONS = [
  { event: 'PreInvocation', handler: 'runtime-pre-invocation.mjs' },
  { event: 'PostInvocation', handler: 'runtime-post-invocation.mjs' },
  { event: 'Stop', handler: 'runtime-stop.mjs' }
];

/** The hook name the host registers the three runtime event entries under. */
const ANTIGRAVITY_HOOK_NAME = 'cards-runtime';

/** Bounded explicit timeout (seconds) stamped into every registration. */
const ANTIGRAVITY_HOOK_TIMEOUT_SECONDS = 30;

/**
 * Builds the exact `runtime/hooks.json` document.
 *
 * @returns The hooks.json value: the named `cards-runtime` hook carrying
 *   exactly the three pinned registrations.
 */
function antigravityHooksJson() {
  const events = {};
  for (const { event, handler } of ANTIGRAVITY_HOOK_REGISTRATIONS) {
    events[event] = [
      {
        type: 'command',
        command: `node bin/${handler}`,
        timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS
      }
    ];
  }
  return { [ANTIGRAVITY_HOOK_NAME]: events };
}

/**
 * Builds the Antigravity runtime target: cleans only the emitter's own
 * outputs, bundles each handler source into `bin/<name>.mjs`, and writes the
 * generated `hooks.json`.
 *
 * Flags follow the OpenCode emitter's pinned decision (ESM on the Node
 * platform, `esnext`, full bundling, `vscode` external, `require` bridge
 * banner) — the emitted handlers are plain Node subprocesses, not
 * editor-hosted modules, so nothing Antigravity-specific changes the bundling.
 * After bundling, the emitted `bin/` set is proven equal to the pinned
 * registration matrix: a missing or extra handler file would make the
 * installed plugin unhealthy or non-deterministic, so the build fails closed.
 *
 * @param {typeof antigravityTargets[number]} target - Target descriptor.
 */
async function buildAntigravityTarget(target) {
  const esbuild = require('esbuild');
  const outDir = path.resolve(packageRoot, target.outBase);

  // Clean ONLY this emitter's outputs: the plugin root also carries
  // plugin.json and skills/ owned by other payload generators.
  rmSync(path.join(outDir, 'bin'), { recursive: true, force: true });
  rmSync(path.join(outDir, 'hooks.json'), { force: true });

  const entryFiles = listEntryFiles(inputScanRoot(target.input));
  if (entryFiles.length === 0) {
    throw new Error(`target ${target.name} has no entry files under ${target.input}`);
  }

  await Promise.all(
    entryFiles.map((entryFile) =>
      esbuild.build({
        entryPoints: [entryFile],
        outfile: path.join(outDir, 'bin', `${path.basename(entryFile, '.ts')}.mjs`),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'esnext',
        external: ['vscode'],
        banner: {
          js: [
            "import { createRequire as cardsCreateRequire } from 'node:module';",
            'const require = cardsCreateRequire(import.meta.url);'
          ].join('\n')
        },
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'warning'
      })
    )
  );

  const emitted = readdirSync(path.join(outDir, 'bin')).sort();
  const expected = ANTIGRAVITY_HOOK_REGISTRATIONS.map((registration) => registration.handler).sort();
  if (emitted.join(',') !== expected.join(',')) {
    throw new Error(
      `target ${target.name} emitted [${emitted.join(', ')}] but the pinned registration matrix requires [${expected.join(', ')}]`
    );
  }

  writeFileSync(path.join(outDir, 'hooks.json'), `${JSON.stringify(antigravityHooksJson(), null, 2)}\n`);
}

function buildTarget(target) {
  // Pre-clean each output subdirectory (rm → compile), matching the
  // `node -e "...rmSync..."` prefix of each former build script.
  for (const sub of target.clean) {
    rmSync(path.resolve(packageRoot, target.outBase, sub), {
      recursive: true,
      force: true
    });
  }

  const args = ['--agent', target.agent, '-i', target.input, '-o', target.output, ...target.loaders];
  if (target.logEnvVar) {
    args.push('--log-env-var', target.logEnvVar);
  }
  args.push('--executable', EXECUTABLE);

  // Run the resolved CLI entry directly via node — never the PATH `.bin` shim —
  // so argv (notably `--executable`, which carries shell metacharacters) reaches
  // the CLI byte-for-byte on Windows as well as POSIX. See the `agentHooksCli`
  // note above.
  const result = spawnSync(process.execPath, [agentHooksCli, ...args], {
    cwd: packageRoot,
    stdio: 'inherit',
    timeout: TARGET_TIMEOUT_MS
  });
  if (result.status !== 0) {
    throw new Error(
      result.signal
        ? `target ${target.name} did not exit within ${TARGET_TIMEOUT_MS}ms and was killed by ${result.signal}`
        : `target ${target.name} failed with exit code ${result.status}`
    );
  }

  // The Codex CLI emits strict-ESM bundles with no `require` binding, so any
  // bundled CommonJS dependency that require()s a Node builtin (mime-types →
  // path) crashed its hook at module load. Bridge every emitted artifact the
  // same way the Claude CLI's banner and buildOpencodeTarget already do; the
  // bridge is idempotent and leaves vendor-bannered bundles untouched.
  const bridged = applyEsmRequireBridgeToDirectory(path.dirname(path.resolve(packageRoot, target.output)));
  console.log(`[agent-hooks] esm require bridge: ${bridged.bridged}/${bridged.scanned} bundles bridged for ${target.name}`);
}

// Exported build manifest — side-effect-free. Consumers (e.g. tests) can import
// EXECUTABLE, targets, and antigravity wiring without triggering the build.
export {
  agentHooksCli,
  EXECUTABLE,
  targets,
  opencodeTargets,
  antigravityTargets,
  ANTIGRAVITY_HOOK_REGISTRATIONS,
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_HOOK_TIMEOUT_SECONDS,
  antigravityHooksJson,
  listEntryFiles,
  inputScanRoot,
  buildOpencodeTarget,
  buildAntigravityTarget
};

// Only run the build when executed directly (not when imported as a module).
// Guard on argv[1] being defined: an importer with no script argument (e.g.
// `node -e 'import(...)'`) leaves it undefined, and pathToFileURL(undefined)
// would throw at evaluation time before the importer receives the exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Wipe the package-local dist first: it holds only the completion manifest
  // that the build-unchanged gate (see package.json `build`) writes after a
  // successful run, so removing it now is what invalidates a stale manifest
  // when a new build starts — an interrupted build must never leave
  // yesterday's proof of completion on disk.
  rmSync(path.resolve(packageRoot, 'dist'), { recursive: true, force: true });

  for (const target of targets) {
    console.log(`\n[agent-hooks] building ${target.name}`);
    buildTarget(target);
  }

  for (const target of opencodeTargets) {
    console.log(`\n[agent-hooks] building ${target.name}`);
    await buildOpencodeTarget(target);
  }

  for (const target of antigravityTargets) {
    console.log(`\n[agent-hooks] building ${target.name}`);
    await buildAntigravityTarget(target);
  }

  console.log('\n[agent-hooks] all ten targets built');
}

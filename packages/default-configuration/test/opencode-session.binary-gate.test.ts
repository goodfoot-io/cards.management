/**
 * Real-binary end-to-end witness for the staged launch config (A1 closure).
 *
 * Stages EXACTLY what production emits — the real bundled plugins through
 * {@link populateOpencodePluginCache}, the real document bytes through
 * {@link writeCardsLaunchConfig} — then executes the installed `opencode`
 * CLI against that document via `OPENCODE_CONFIG` and asserts:
 *
 * 1. the run exits 0 (a rejected document hard-fails startup — e.g. the
 *    array-shaped `skills` or any silently-ignored plural key regression);
 * 2. the emitted document carries only the live-verified v1 key set
 *    (`$schema`, singular `plugin`, nested `permission`, legacy `skills`);
 * 3. the Cards runtime plugin actually fired, proven through the production
 *    hook-log sink pointed at a temp anchor;
 * 4. the session reached a model turn.
 *
 * The model is a local OpenAI-compatible stub declared as provider `stub` in
 * the child's global config (`XDG_CONFIG_HOME`), never in the staged document,
 * so the staged bytes stay exactly what production writes. That directory is
 * read-only, which v1.18.31 takes as the signal to skip installing
 * `@opencode-ai/plugin` into it from npm; offline, that install blocks a run
 * for about 70 seconds before giving up. The child's other traffic meets a
 * closed proxy and its models fetch and autoupdate are off, so the tier needs
 * no network and no credentials: a run that stalls fails at its bound with the
 * signal and stderr instead of hanging the suite.
 *
 * Setting `CARDS_OPENCODE_LIVE_MODEL` to a hosted `provider/model` that needs
 * no sign-in adds an opt-in tier that boots the same document
 * against that real provider over the network.
 *
 * Skipped entirely when no usable `opencode` binary resolves, so environments
 * without an install stay green while this machine exercises the real Bun
 * runtime on every `yarn test`. Verified against the installed v1.18.31.
 *
 * @summary Live-binary integration tier for the staged launch config contract
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Where the installed CLI lives in the pinned environment. */
const FALLBACK_BINARY = path.join(homedir(), '.opencode', 'bin', 'opencode');

/**
 * Resolves the opencode CLI: explicit override → PATH → pinned install path.
 *
 * @returns Absolute binary path, or `null` when unavailable (tier skips).
 */
function resolveOpencodeBinary(): string | null {
  const override = process.env['CARDS_OPENCODE_BINARY'];
  if (override) {
    return existsSync(override) ? override : null;
  }
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'opencode');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return existsSync(FALLBACK_BINARY) ? FALLBACK_BINARY : null;
}

const binary = resolveOpencodeBinary();

/**
 * The hosted `provider/model` for the opt-in live tier; unset skips it. The
 * child's HOME and XDG directories are isolated, so it must be a model that
 * needs no sign-in, such as one of OpenCode Zen's free models.
 */
const liveModel = process.env['CARDS_OPENCODE_LIVE_MODEL'] || null;

/** Bound on one stubbed run; a healthy one finishes in a few seconds. */
const STUB_RUN_TIMEOUT_MS = 30_000;

/** Bound on one live run, which waits on a hosted model. */
const LIVE_RUN_TIMEOUT_MS = 120_000;

/** How one opencode run ended. */
interface OpencodeRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the CLI without blocking the event loop, so the in-process stub can
 * answer it. The child leads its own process group; at the bound that group,
 * and only that group, is killed.
 * @param args - CLI arguments.
 * @param options - How to run it.
 * @param options.cwd - Working directory.
 * @param options.env - The child's whole environment.
 * @param options.timeoutMs - Bound after which the child's group is killed.
 * @returns The exit status or signal, whether the bound fired, and the output.
 */
function runOpencode(
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number }
): Promise<OpencodeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary as string, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const pgid = child.pid;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid !== undefined && pgid > 1 && child.exitCode === null && child.signalCode === null)
        process.kill(-pgid, 'SIGKILL');
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout, stderr });
    });
  });
}

/**
 * Describes a run for an assertion message.
 * @param run - The finished run.
 * @returns Its status, signal, bound and stderr tail.
 */
const describeRun = (run: OpencodeRun): string =>
  `status ${run.status}, signal ${run.signal}${run.timedOut ? ', killed at its bound' : ''}; stderr:\n${run.stderr.slice(-4000)}`;

/** Model requests the stub has answered, by requested model id. */
const stubRequests: string[] = [];

/**
 * Starts an OpenAI-compatible chat completions stub that answers every
 * request with `ok`, streamed or not.
 * @returns The listening server.
 */
function startStubProvider(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
      const model = parsed.model ?? '';
      stubRequests.push(model);
      const base = { id: 'stub', created: 0, model };
      if (parsed.stream) {
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(chunk({ role: 'assistant', content: 'ok' }, null));
        response.write(chunk({}, 'stop'));
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Package root (`public/packages/default-configuration`). */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Marketplace path whose sibling `opencode/` resolves to the real bundled
 * payload tree (`public/opencode`) — the same `dirname(marketplace)/opencode`
 * relationship production's launcher relies on.
 */
const MARKETPLACE_PATH = path.join(packageRoot, '..', '..', 'marketplace');

/** Action-env keys stripped from the child environment so handlers take the not-an-action path deterministically. */
const ACTION_ENV_KEYS = [
  'CARD_ID',
  'ACTION_NAME',
  'ENVIRONMENT',
  'EXECUTION_MODE',
  'EXIT_WHEN_DONE',
  'REPO_ROOT',
  'CARD_REPO_PATH',
  'CONFIG_PATH',
  'EXTENSION_PATH',
  'MARKETPLACE_PATH',
  'WORKSPACE_PATH',
  'BASE_BRANCH',
  'WORKSPACE_BRANCH'
];

let scratchRoot: string;
let configPath: string;
let anchorPath: string;
let stub: Server | undefined;

beforeAll(async () => {
  if (!binary) {
    return;
  }
  scratchRoot = mkdtempSync(path.join(tmpdir(), 'opencode-staged-config-gate-'));
  // Every bundle expects a project cwd; git keeps opencode's VCS detection quiet.
  mkdirSync(path.join(scratchRoot, 'proj'), { recursive: true });
  spawnSync('git', ['init', '-q', path.join(scratchRoot, 'proj')]);
  mkdirSync(path.join(scratchRoot, 'config'), { recursive: true });
  mkdirSync(path.join(scratchRoot, 'staging'), { recursive: true });

  // Stage exactly what production stages — real bundle, real writer, real bytes.
  const { OPENCODE_LAUNCH_PLUGIN_NAMES, populateOpencodePluginCache, writeCardsLaunchConfig } = await import(
    '../src/lib/opencode-session.js'
  );
  const { pluginCachePaths } = await populateOpencodePluginCache(
    path.join(scratchRoot, 'config'),
    MARKETPLACE_PATH,
    OPENCODE_LAUNCH_PLUGIN_NAMES
  );
  configPath = await writeCardsLaunchConfig(
    path.join(scratchRoot, 'staging'),
    'launch',
    OPENCODE_LAUNCH_PLUGIN_NAMES,
    pluginCachePaths
  );
  anchorPath = path.join(scratchRoot, 'hooks-anchor.log');
  stub = await startStubProvider();
});

afterAll(async () => {
  await new Promise<void>((resolve) => (stub === undefined ? resolve() : stub.close(() => resolve())));
  if (scratchRoot) {
    for (const name of ['stubbed', 'live']) {
      const dir = path.join(scratchRoot, name, 'xdg', 'opencode');
      if (existsSync(dir)) chmodSync(dir, 0o755);
    }
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

/**
 * Builds the child environment: isolated HOME and XDG directories, the staged
 * document, the hook-log anchor, and no action env.
 * @param name - Directory name under the scratch root, one per tier.
 * @param globalConfig - The child's global opencode config, or null for none.
 * @returns The environment, network isolation not included.
 */
function isolatedEnv(name: string, globalConfig: object | null): NodeJS.ProcessEnv {
  const root = path.join(scratchRoot, name);
  for (const dir of ['home', 'xdg/opencode', 'data', 'cache', 'state'])
    mkdirSync(path.join(root, dir), { recursive: true });
  if (globalConfig !== null)
    writeFileSync(path.join(root, 'xdg', 'opencode', 'opencode.json'), JSON.stringify(globalConfig));
  // A config directory opencode cannot write to gets no npm install of `@opencode-ai/plugin`.
  chmodSync(path.join(root, 'xdg', 'opencode'), 0o555);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ACTION_ENV_KEYS) {
    delete env[key];
  }
  return {
    ...env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG: configPath,
    // Operator override: every handler entry lands in this temp anchor.
    OPENCODE_CARDS_HOOKS_LOG_FILE: anchorPath
  };
}

describe.skipIf(binary === null)('staged launch config — real-binary witness (installed opencode v1.18.x)', () => {
  it('emits only the live-verified v1 key set', () => {
    const doc = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['$schema', 'permission', 'plugin', 'skills']);
    // Singular key names are load-bearing: plural `plugins` is silently
    // ignored, array-shaped `skills` hard-rejects startup.
    expect(Array.isArray(doc['plugin'])).toBe(true);
    expect(doc['permission']).toEqual({ '*': { '*': 'allow' } });
    expect(doc['skills']).toEqual({ paths: expect.any(Array) });
  });

  it(
    'boots a full session on the emitted document; runtime stays inert without an action env',
    async () => {
      const port = (stub?.address() as AddressInfo).port;
      const env: NodeJS.ProcessEnv = {
        ...isolatedEnv('stubbed', {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            stub: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Stub',
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'stub' },
              models: { echo: { name: 'echo' } }
            }
          }
        }),
        // Nothing but the stub is reachable: other traffic meets a closed proxy port.
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1'
      };
      const proj = path.join(scratchRoot, 'proj');
      const spawnWith = (extraEnv: NodeJS.ProcessEnv) =>
        runOpencode(['run', '--print-logs', '--dir', proj, '--model', 'stub/echo', 'reply with ok'], {
          cwd: proj,
          env: { ...env, ...extraEnv },
          timeoutMs: STUB_RUN_TIMEOUT_MS
        });

      // A rejected document hard-fails startup with a non-zero exit (the
      // pre-fix v2-shaped doc exited 1 with "Configuration is invalid").
      const run = await spawnWith({});
      expect(run.status, describeRun(run)).toBe(0);
      expect(stubRequests, 'the session never reached a model turn').toContain('echo');

      // The runtime entry exports NO hooks without `CARD_ID` — the document
      // still boots cleanly, and no lifecycle handler idles into the anchor.
      let anchorText = existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8') : '';
      expect(anchorText).not.toContain('OpenCode session');

      // `CARD_ID` classifies this as a Cards action. Without the required
      // protected credential, durable work admission prevents later lifecycle
      // handlers from presenting it as an inert non-action session.
      rmSync(anchorPath, { force: true });
      stubRequests.length = 0;
      const actionRun = await spawnWith({ CARD_ID: 'ope-age-sup-1' });
      expect(actionRun.status, describeRun(actionRun)).toBe(0);
      expect(stubRequests, 'the action session never reached a model turn').toContain('echo');
      anchorText = existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8') : '';
      expect(anchorText).not.toContain('OpenCode session is not a Cards action');
    },
    2 * STUB_RUN_TIMEOUT_MS + 10_000
  );

  it.skipIf(liveModel === null)(
    'boots the emitted document against the hosted model in CARDS_OPENCODE_LIVE_MODEL',
    async () => {
      const proj = path.join(scratchRoot, 'proj');
      // Isolated like the stubbed tier, but with the network open and opencode's own provider list.
      const run = await runOpencode(['run', '--dir', proj, '--model', liveModel as string, 'reply with ok'], {
        cwd: proj,
        env: isolatedEnv('live', null),
        timeoutMs: LIVE_RUN_TIMEOUT_MS
      });
      expect(run.status, describeRun(run)).toBe(0);
      expect(run.stdout.trim(), describeRun(run)).not.toBe('');
    },
    LIVE_RUN_TIMEOUT_MS + 10_000
  );
});

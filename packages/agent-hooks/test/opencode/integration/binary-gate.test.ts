/**
 * Real-binary gate (plan §7 I4/I5 closure).
 *
 * For each emitted OpenCode bundle — cards, cards-assistant, runtime — stages
 * an isolated environment (temp XDG/HOME/data dirs, an `OPENCODE_CONFIG`
 * listing exactly that bundle), executes the installed
 * {@link OPENCODE_BINARY} CLI against a trivial prompt, and asserts:
 *
 * 1. the run exits 0;
 * 2. the bundle actually fired — proven through the production hook-log sink,
 *    pointed at a temp anchor via `OPENCODE_CARDS_HOOKS_LOG_FILE`, which every
 *    handler writes its named info lines into;
 * 3. the session reached a model turn.
 *
 * The model is a local OpenAI-compatible stub declared as provider `stub` in
 * the child's global config (`XDG_CONFIG_HOME`), so the per-bundle
 * `OPENCODE_CONFIG` lists only the bundle. That directory is read-only, which
 * v1.18.31 takes as the signal to skip installing `@opencode-ai/plugin` into
 * it from npm; offline, that install blocks a run for about 70 seconds before
 * giving up. The child's other traffic meets a closed proxy and its models
 * fetch and autoupdate are off, so the tier needs no network and no
 * credentials: a run that stalls fails at its bound with the signal and
 * stderr instead of hanging the suite.
 *
 * Setting `CARDS_OPENCODE_LIVE_MODEL` to a hosted `provider/model` that needs
 * no sign-in adds an opt-in tier that drives the assistant bundle against
 * that real provider over the network.
 *
 * Skipped entirely when no usable `opencode` binary resolves, so environments
 * without an install stay green while this machine exercises the real Bun
 * runtime on every `yarn test`. Verified against the installed v1.18.31.
 *
 * @summary Opt-in live-binary integration tier for the three OpenCode bundles
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

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const bundles = {
  cards: path.join(packageRoot, '..', '..', 'opencode', 'cards', 'plugin', 'user-prompt-submit.mjs'),
  assistant: path.join(packageRoot, '..', '..', 'opencode', 'cards-assistant', 'plugin', 'session-start.mjs'),
  runtime: path.join(packageRoot, '..', '..', 'opencode', 'runtime', 'plugin', 'session-start.mjs')
} as const;

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

let scratchRoot: string;
let stub: Server | undefined;

beforeAll(async () => {
  if (!binary) {
    return;
  }
  scratchRoot = mkdtempSync(path.join(tmpdir(), 'opencode-binary-gate-'));
  // Every bundle expects a project cwd; git keeps opencode's VCS detection quiet.
  mkdirSync(path.join(scratchRoot, 'proj'), { recursive: true });
  spawnSync('git', ['init', '-q', path.join(scratchRoot, 'proj')]);
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

/** How one opencode run ended. */
interface RunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly anchorText: string;
}

/**
 * Describes a run for an assertion message.
 * @param run - The finished run.
 * @returns Its status, signal, bound and stderr tail.
 */
const describeRun = (run: RunResult): string =>
  `status ${run.status}, signal ${run.signal}${run.timedOut ? ', killed at its bound' : ''}; stderr:\n${run.stderr.slice(-4000)}`;

/**
 * Builds a tier's isolated directories and its read-only global config.
 * @param name - Directory name under the scratch root, one per tier.
 * @param globalConfig - The child's global opencode config, or null for none.
 * @returns HOME and XDG variables pointing into those directories.
 */
function isolatedDirs(name: string, globalConfig: object | null): NodeJS.ProcessEnv {
  const root = path.join(scratchRoot, name);
  const config = path.join(root, 'xdg', 'opencode');
  if (!existsSync(config)) {
    for (const dir of ['home', 'xdg/opencode', 'data', 'cache', 'state'])
      mkdirSync(path.join(root, dir), { recursive: true });
    if (globalConfig !== null) writeFileSync(path.join(config, 'opencode.json'), JSON.stringify(globalConfig));
    // A config directory opencode cannot write to gets no npm install of `@opencode-ai/plugin`.
    chmodSync(config, 0o555);
  }
  return {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state')
  };
}

/**
 * The stubbed tier's environment: the stub as the only provider, a closed
 * proxy for everything else, no models fetch and no autoupdate.
 * @returns HOME, XDG and network variables.
 */
function stubbedEnv(): NodeJS.ProcessEnv {
  const port = (stub?.address() as AddressInfo).port;
  return {
    ...isolatedDirs('stubbed', {
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
}

/**
 * Runs the installed opencode once with exactly one plugin bundle loaded,
 * without blocking the event loop, so the in-process stub can answer it. The
 * child leads its own process group; at the bound that group, and only that
 * group, is killed.
 *
 * @param bundlePath - Absolute path of the emitted `.mjs` under test.
 * @param prompt - Trivial prompt driving one full turn.
 * @param options - How to run it.
 * @param options.model - The `provider/model` the turn uses.
 * @param options.env - Tier environment (isolation and network), plus any
 *        extra variables, e.g. a `CARD_ID` to simulate a Cards-action launch.
 * @param options.timeoutMs - Bound after which the child's group is killed.
 * @returns Exit status or signal, whether the bound fired, streams, and the hook-log anchor contents.
 */
function runBundle(
  bundlePath: string,
  prompt: string,
  options: { readonly model: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number }
): Promise<RunResult> {
  const proj = path.join(scratchRoot, 'proj');
  const configFile = path.join(scratchRoot, `${path.basename(path.dirname(path.dirname(bundlePath)))}.config.json`);
  writeFileSync(configFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [bundlePath] }));

  const anchor = path.join(scratchRoot, `${path.basename(bundlePath)}.anchor.log`);
  rmSync(anchor, { force: true });
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ACTION_ENV_KEYS) {
    delete childEnv[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(binary as string, ['run', '--dir', proj, '--model', options.model, prompt], {
      cwd: proj,
      env: {
        ...childEnv,
        OPENCODE_CONFIG: configFile,
        // Operator override: every handler entry lands in this temp anchor.
        OPENCODE_CARDS_HOOKS_LOG_FILE: anchor,
        ...options.env
      },
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
      const anchorText = existsSync(anchor) ? readFileSync(anchor, 'utf8') : '';
      resolve({ status, signal, timedOut, stdout, stderr, anchorText });
    });
  });
}

/**
 * Runs a bundle against the stub, expecting a clean exit and a model turn.
 * @param bundlePath - Absolute path of the emitted `.mjs` under test.
 * @param prompt - Trivial prompt driving one full turn.
 * @param extraEnv - Additional environment injected into the child.
 * @returns The finished run.
 */
async function runStubbed(bundlePath: string, prompt: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  stubRequests.length = 0;
  const result = await runBundle(bundlePath, prompt, {
    model: 'stub/echo',
    env: { ...stubbedEnv(), ...extraEnv },
    timeoutMs: STUB_RUN_TIMEOUT_MS
  });
  expect(result.status, describeRun(result)).toBe(0);
  expect(stubRequests, 'the session never reached a model turn').toContain('echo');
  return result;
}

describe.skipIf(binary === null)('real-binary gate (installed opencode v1.18.x)', () => {
  it(
    'runtime bundle: inert outside Cards-action sessions — no hooks, silent anchor',
    async () => {
      const result = await runStubbed(bundles.runtime, 'reply with ok');
      // The runtime entry exports NO hooks without `CARD_ID`: accidental global
      // registration must be fully silent, not merely idle-guarded.
      expect(result.anchorText).not.toContain('OpenCode session');
      expect(result.anchorText).not.toContain('Nudging');
    },
    STUB_RUN_TIMEOUT_MS + 10_000
  );

  it(
    'runtime bundle: a lone CARD_ID stays inert without the complete Cards action envelope',
    async () => {
      const result = await runStubbed(bundles.runtime, 'reply with ok', { CARD_ID: 'ope-age-sup-1' });
      expect(result.anchorText).toBe('');
    },
    STUB_RUN_TIMEOUT_MS + 10_000
  );

  it(
    'cards bundle: prompt nudge hook fires on a card-term mention',
    async () => {
      // The standalone word "card" trips the detection predicates.
      const result = await runStubbed(bundles.cards, 'reply with ok and think about the card concept');
      expect(result.anchorText).toContain('Nudging to load cards');
    },
    STUB_RUN_TIMEOUT_MS + 10_000
  );

  it(
    'assistant bundle: capability menu injection fires on the first turn',
    async () => {
      const result = await runStubbed(bundles.assistant, 'reply with ok');
      expect(result.anchorText).toContain('Assistant capability menu injected');
    },
    STUB_RUN_TIMEOUT_MS + 10_000
  );

  it.skipIf(liveModel === null)(
    'assistant bundle: fires against the hosted model in CARDS_OPENCODE_LIVE_MODEL',
    async () => {
      // Isolated like the stubbed tier, but with the network open and opencode's own provider list.
      const result = await runBundle(bundles.assistant, 'reply with ok', {
        model: liveModel as string,
        env: isolatedDirs('live', null),
        timeoutMs: LIVE_RUN_TIMEOUT_MS
      });
      expect(result.status, describeRun(result)).toBe(0);
      expect(result.stdout.trim(), describeRun(result)).not.toBe('');
      expect(result.anchorText).toContain('Assistant capability menu injected');
    },
    LIVE_RUN_TIMEOUT_MS + 10_000
  );
});

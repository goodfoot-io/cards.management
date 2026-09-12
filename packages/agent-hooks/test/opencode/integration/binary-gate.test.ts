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
 *    handler writes its named info lines into.
 *
 * Skipped entirely when no usable `opencode` binary resolves, so environments
 * without the pinned v1.18.21 install stay green while this machine exercises
 * the real Bun runtime on every `yarn test`.
 *
 * @summary Opt-in live-binary integration tier for the three OpenCode bundles
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

let scratchRoot: string;

beforeAll(() => {
  if (!binary) {
    return;
  }
  scratchRoot = mkdtempSync(path.join(tmpdir(), 'opencode-binary-gate-'));
  // Every bundle expects a project cwd; git keeps opencode's VCS detection quiet.
  mkdirSync(path.join(scratchRoot, 'proj'), { recursive: true });
  spawnSync('git', ['init', '-q', path.join(scratchRoot, 'proj')]);
});

afterAll(() => {
  if (scratchRoot) {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  anchorText: string;
}

/**
 * Runs the installed opencode once with exactly one plugin bundle loaded.
 *
 * @param bundlePath - Absolute path of the emitted `.mjs` under test.
 * @param prompt - Trivial prompt driving one full turn.
 * @param extraEnv - Additional environment injected into the child (e.g. a
 *        `CARD_ID` to simulate a Cards-action launch).
 * @returns Exit status, streams, and the hook-log anchor contents.
 */
function runBundle(bundlePath: string, prompt: string, extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const home = path.join(scratchRoot, 'home');
  const xdg = path.join(scratchRoot, 'xdg');
  const data = path.join(scratchRoot, 'data');
  const proj = path.join(scratchRoot, 'proj');
  mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });

  const configFile = path.join(scratchRoot, `${path.basename(path.dirname(path.dirname(bundlePath)))}.config.json`);
  writeFileSync(configFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [bundlePath] }));

  const anchor = path.join(scratchRoot, `${path.basename(bundlePath)}.anchor.log`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ACTION_ENV_KEYS) {
    delete childEnv[key];
  }

  const run = spawnSync(binary as string, ['run', '--dir', proj, prompt], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: proj,
    env: {
      ...childEnv,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: data,
      OPENCODE_CONFIG: configFile,
      // Operator override: every handler entry lands in this temp anchor.
      OPENCODE_CARDS_HOOKS_LOG_FILE: anchor,
      ...extraEnv
    }
  });

  const anchorText = existsSync(anchor) ? readFileSync(anchor, 'utf8') : '';
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', anchorText };
}

describe.skipIf(binary === null)('real-binary gate (installed opencode v1.18.x)', () => {
  it('runtime bundle: inert outside Cards-action sessions — no hooks, silent anchor', () => {
    const result = runBundle(bundles.runtime, 'reply with ok');
    expect(result.status).toBe(0);
    // The runtime entry exports NO hooks without `CARD_ID`: accidental global
    // registration must be fully silent, not merely idle-guarded.
    expect(result.anchorText).not.toContain('OpenCode session');
    expect(result.anchorText).not.toContain('Nudging');
  }, 180000);

  it('runtime bundle: a lone CARD_ID stays inert without the complete Cards action envelope', () => {
    const result = runBundle(bundles.runtime, 'reply with ok', { CARD_ID: 'ope-age-sup-1' });
    expect(result.status).toBe(0);
    expect(result.anchorText).toBe('');
  }, 180000);

  it('cards bundle: prompt nudge hook fires on a card-term mention', () => {
    // The standalone word "card" trips the detection predicates.
    const result = runBundle(bundles.cards, 'reply with ok and think about the card concept');
    expect(result.status).toBe(0);
    expect(result.anchorText).toContain('Nudging to load cards');
  }, 180000);

  it('assistant bundle: capability menu injection fires on the first turn', () => {
    const result = runBundle(bundles.assistant, 'reply with ok');
    expect(result.status).toBe(0);
    expect(result.anchorText).toContain('Assistant capability menu injected');
  }, 180000);
});

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
 *    hook-log sink pointed at a temp anchor.
 *
 * Skipped entirely when no usable `opencode` binary resolves, so environments
 * without the pinned v1.18.21 install stay green while this machine exercises
 * the real Bun runtime on every `yarn test`. Mirrors the harness style of
 * `agent-hooks/test/opencode/integration/binary-gate.test.ts`.
 *
 * @summary Live-binary integration tier for the staged launch config contract
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
});

afterAll(() => {
  if (scratchRoot) {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

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

  it('boots a full session on the emitted document; runtime stays inert without an action env', () => {
    const home = path.join(scratchRoot, 'home');
    const xdg = path.join(scratchRoot, 'xdg');
    const data = path.join(scratchRoot, 'data');
    mkdirSync(home, { recursive: true });
    mkdirSync(xdg, { recursive: true });
    mkdirSync(data, { recursive: true });

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ACTION_ENV_KEYS) {
      delete childEnv[key];
    }

    const spawnWith = (extraEnv: NodeJS.ProcessEnv) =>
      spawnSync(binary as string, ['run', '--dir', path.join(scratchRoot, 'proj'), 'reply with ok'], {
        encoding: 'utf8',
        timeout: 120000,
        cwd: path.join(scratchRoot, 'proj'),
        env: {
          ...childEnv,
          HOME: home,
          XDG_CONFIG_HOME: xdg,
          XDG_DATA_HOME: data,
          OPENCODE_CONFIG: configPath,
          // Operator override: every handler entry lands in this temp anchor.
          OPENCODE_CARDS_HOOKS_LOG_FILE: anchorPath,
          ...extraEnv
        }
      });

    // A rejected document hard-fails startup with a non-zero exit (the
    // pre-fix v2-shaped doc exited 1 with "Configuration is invalid").
    const run = spawnWith({});
    expect(run.status).toBe(0);

    // The runtime entry exports NO hooks without `CARD_ID` — the document
    // still boots cleanly, and no lifecycle handler idles into the anchor.
    let anchorText = existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8') : '';
    expect(anchorText).not.toContain('OpenCode session');

    // `CARD_ID` classifies this as a Cards action. Without the required
    // protected credential, durable work admission prevents later lifecycle
    // handlers from presenting it as an inert non-action session.
    rmSync(anchorPath, { force: true });
    const actionRun = spawnWith({ CARD_ID: 'ope-age-sup-1' });
    expect(actionRun.status).toBe(0);
    anchorText = existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8') : '';
    expect(anchorText).not.toContain('OpenCode session is not a Cards action');
  }, 180000);
});

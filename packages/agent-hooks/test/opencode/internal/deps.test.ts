/**
 * A3 witness — the runbook resolver must land on `<pkg>/skills/…` (a sibling
 * of `plugin/`) from a module inside the installed payload, in every layout.
 *
 * The regression it pins: the original expression climbed two levels
 * (`../../skills/…`), which misses in both layouts — repo/dist payloads would
 * resolve to `public/opencode/skills/…` (nonexistent) and cache slots skip
 * their version segment.
 *
 * Two tiers:
 * 1. Direct assertions against `resolveRunbookFrom` with base URLs pointing at
 *    bundle locations in both fixture layouts and at the real emitted bundles.
 * 2. Execution witness: a probe entry is esbuild-bundled into each layout's
 *    `plugin/` directory and executed under Node, so the resolver runs from a
 *    real bundle whose `import.meta.url` is the installed location.
 *
 * @summary A3 runbook resolver layout witness
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRunbookFrom } from '../../../src/opencode/internal/deps.js';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild') as typeof import('esbuild');

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const emittedRuntimeBundle = path.join(packageRoot, '../../opencode/runtime/plugin/session-start.mjs');

let repoShapedRoot: string;
let cacheShapedRoot: string;

beforeAll(() => {
  repoShapedRoot = mkdtempSync(path.join(tmpdir(), 'runbook-repo-'));
  cacheShapedRoot = mkdtempSync(path.join(tmpdir(), 'runbook-cache-'));
});

afterAll(() => {
  rmSync(repoShapedRoot, { recursive: true, force: true });
  rmSync(cacheShapedRoot, { recursive: true, force: true });
});

/**
 * Creates the skills fixtures of one payload tree and returns its plugin dir.
 *
 * @param payloadDir - The `<pkg>` directory of the shaped tree.
 * @returns Absolute path of the `plugin/` directory inside it.
 */
function stagePayload(payloadDir: string): string {
  const references = path.join(payloadDir, 'skills', 'card', 'references');
  mkdirSync(references, { recursive: true });
  writeFileSync(path.join(references, 'merge.md'), '<instructions>merge</instructions>\n');
  writeFileSync(path.join(references, 'shutdown.md'), '<instructions>shutdown</instructions>\n');
  const pluginDir = path.join(payloadDir, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  return pluginDir;
}

interface ProbeResult {
  merge: string;
  shutdown: string;
}

/**
 * Bundles the probe entry into `pluginDir` and executes it there.
 *
 * @param pluginDir - The staged `plugin/` directory to install the probe into.
 * @returns The resolver results reported by the executed probe bundle.
 */
async function runProbe(pluginDir: string): Promise<ProbeResult> {
  const resultPath = path.join(pluginDir, 'probe-result.json');
  await esbuild.build({
    entryPoints: [path.join(packageRoot, 'test', 'opencode', 'fixtures', 'runbook-probe-entry.ts')],
    outfile: path.join(pluginDir, 'probe.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'esnext',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    },
    external: ['vscode'],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent'
  });

  const run = spawnSync(process.execPath, [path.join(pluginDir, 'probe.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CARDS_RUNBOOK_PROBE_OUT: resultPath },
    timeout: 30000
  });
  if (run.status !== 0) {
    throw new Error(`probe failed (${run.status}): ${run.stderr}`);
  }
  return JSON.parse(readFileSync(resultPath, 'utf8')) as ProbeResult;
}

describe('runbook resolver layouts (A3)', () => {
  it('resolves sibling skills from a repo-shaped payload (`<root>/cards/plugin/x.mjs`)', async () => {
    const pluginDir = stagePayload(path.join(repoShapedRoot, 'cards'));
    const probe = await runProbe(pluginDir);

    expect(probe.merge).toBe(path.join(repoShapedRoot, 'cards', 'skills', 'card', 'references', 'merge.md'));
    expect(existsSync(probe.merge)).toBe(true);
    expect(existsSync(probe.shutdown)).toBe(true);
  });

  it('resolves sibling skills from a cache-slot payload (`<cache>/<name>/<version>/plugin/x.mjs`)', async () => {
    const versionDir = path.join(cacheShapedRoot, 'cards-opencode-runtime', '1.0.0');
    const pluginDir = stagePayload(versionDir);
    const probe = await runProbe(pluginDir);

    // The version segment must NOT be skipped — resolution stays inside the slot.
    expect(probe.merge).toBe(path.join(versionDir, 'skills', 'card', 'references', 'merge.md'));
    expect(existsSync(probe.merge)).toBe(true);
    expect(existsSync(probe.shutdown)).toBe(true);
  });

  it('lands on the real runtime skills beside the real emitted bundles', () => {
    expect(existsSync(emittedRuntimeBundle)).toBe(true);
    const merge = resolveRunbookFrom(pathToFileURL(emittedRuntimeBundle).href, 'merge.md');
    const shutdown = resolveRunbookFrom(pathToFileURL(emittedRuntimeBundle).href, 'shutdown.md');

    const expectedSkills = path.resolve(packageRoot, '..', '..', 'opencode', 'runtime', 'skills', 'card', 'references');
    expect(merge).toBe(path.join(expectedSkills, 'merge.md'));
    expect(shutdown).toBe(path.join(expectedSkills, 'shutdown.md'));
    expect(existsSync(merge)).toBe(true);
    expect(existsSync(shutdown)).toBe(true);
  });
});

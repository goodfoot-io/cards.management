/**
 * Vitest global setup that runs the real `scripts/build.mjs` exactly once per
 * vitest run, before any test file starts.
 *
 * Multiple integration suites (`test/antigravity/compiled-output.test.ts`,
 * `test/compiled-bundles/codex-bundles-load.test.ts`) need the compiled
 * `public/codex/**` and `public/antigravity/runtime/**` bundles to exist and
 * be current before they spawn them as subprocesses. Vitest runs test files
 * in parallel; if each suite ran the build itself in its own `beforeAll`, two
 * builds could write and esm-bridge-rewrite the same output bundles at the
 * same time, and a build could read a half-written bundle mid-write and
 * crash. Running the build exactly once, before any test file loads, removes
 * the race instead of papering over it with retries or serialization.
 *
 * Fail-closed: a non-zero build exit throws, with the build's own stderr
 * attached, and vitest fails the run instead of testing against stale or
 * partially-written artifacts.
 *
 * @summary Build compiled hook bundles once per vitest run
 * @module test/setup/build-once
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupNeeded } from '@goodfoot/vitest-cache/plan';
import type { TestProject } from 'vitest/node';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildScript = resolve(packageRoot, 'scripts', 'build.mjs');

/**
 * Test files declared in `vitest.cache.json` never read the compiled bundles, so
 * the build is only needed when some other file is pending execution.
 */
const buildFreeFiles = new Set(
  Object.keys((JSON.parse(readFileSync(resolve(packageRoot, 'vitest.cache.json'), 'utf8')) as { files: object }).files)
);
const repoRelativePrefix = relative(resolve(packageRoot, '..', '..', '..'), packageRoot);

/**
 * Runs `scripts/build.mjs` once before any test file in the vitest session,
 * skipping it when every pending file is declared build-independent.
 *
 * @param project - Root Vitest project, used to read the pending-file plan.
 * @throws When the build exits non-zero; the error message carries the
 *   build's captured stderr for diagnosis.
 */
export function setup(project: TestProject): void {
  const needsBuild = setupNeeded(
    project,
    (file) => !buildFreeFiles.has(`${repoRelativePrefix}/${relative(packageRoot, file)}`)
  );
  if (!needsBuild) {
    return;
  }
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 120_000
  });
  if (result.status !== 0) {
    throw new Error(`build failed with exit code ${result.status}:\n${result.stderr}`);
  }
}

/**
 * Tests for the `antigravity-session` stream registration: the settings
 * config carries the streamType with version 1, the wwwRoot resolves to the
 * generated entrypoint directory (the entrypoint cannot be committed under
 * src/ — see `scripts/generate-antigravity-entry.mjs`), and the package build
 * pipeline (entrypoint generation, bun www builds, renderer-type list,
 * typecheck project) knows about the new renderer.
 *
 * @summary Tests for the antigravity-session settings registration and build wiring
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateAntigravityEntry } from '../scripts/generate-antigravity-entry.mjs';
import settingsConfig from '../settings.config.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Reads a file from this package's tree so tests can assert on committed
 * build wiring (package.json scripts, scripts/build.mjs) without hardcoding
 * absolute paths.
 *
 * @param relativePath - Path beneath this package's root.
 * @returns The file's full text.
 */
function readPackageFile(relativePath: string): string {
  return readFileSync(join(PACKAGE_ROOT, relativePath), 'utf-8');
}

describe('settings registration — antigravity-session', () => {
  const streams = settingsConfig.environments['default']?.streams;

  it('registers the streamType with version 1 and the generated wwwRoot', () => {
    expect(streams).toBeDefined();
    const entry = streams?.['antigravity-session'];
    expect(entry).toBeDefined();
    expect(entry?.version).toBe(1);
    expect(entry?.wwwRoot).toBe('./dist/www-entry/antigravity-session');
    expect(entry?.maxLineLength).toBeGreaterThan(0);
  });

  it('materializes the generated entrypoint into the wwwRoot on demand', () => {
    // Same mechanism scripts/build.mjs runs before the settings build: the
    // generator is idempotent (content written only when changed) and lives
    // outside the watched src/ tree.
    const indexPath = generateAntigravityEntry(PACKAGE_ROOT);

    expect(existsSync(indexPath)).toBe(true);
    const html = readFileSync(indexPath, 'utf-8');
    // The generated entry references its sibling sources by relative paths
    // back into src/ from the un-watched output location (the OpenCode
    // generated-entrypoint shape).
    expect(html).toContain('../../../src/streams/antigravity-session/www/theme.css');
    expect(html).toContain('../../../src/streams/antigravity-session/www/app.tsx');
    expect(html).toContain('id="stream-root"');
  });

  it('keeps no committed index.html under src/ (the integration hook forbids it)', () => {
    const srcWww = join(PACKAGE_ROOT, 'src/streams/antigravity-session/www');
    expect(existsSync(join(srcWww, 'index.html'))).toBe(false);
    expect(existsSync(join(srcWww, 'index.meta.json'))).toBe(false);
    // The rest of the renderer stays committed under src/.
    for (const required of ['app.tsx', 'theme.css', 'build.ts', 'tsconfig.json']) {
      expect(existsSync(join(srcWww, required))).toBe(true);
    }
  });

  it('keeps the three sibling stream registrations intact', () => {
    expect(streams?.['claude-code-session']).toBeDefined();
    expect(streams?.['codex-session']).toBeDefined();
    expect(streams?.['opencode-session']).toBeDefined();
  });

  it('wires the renderer into the package build pipeline', () => {
    const pkg = JSON.parse(readPackageFile('package.json')) as { scripts?: Record<string, string> };
    const buildWww = pkg.scripts?.['build:www'] ?? '';
    const typecheck = pkg.scripts?.['typecheck'] ?? '';
    expect(buildWww).toContain('src/streams/antigravity-session/www/build.ts');
    expect(typecheck).toContain('src/streams/antigravity-session/www/tsconfig.json');

    // The bundle build materializes the generated entrypoint before the
    // settings build and pre-creates/verifies each registered renderer's
    // output directory by streamType name.
    const buildScript = readPackageFile('scripts/build.mjs');
    expect(buildScript).toContain('generateAntigravityEntry(pkgRoot)');
    expect(buildScript).toContain("'antigravity-session'");

    // The bun bundler builds the GENERATED entrypoint into the registered
    // renderer output directory.
    const buildTs = readPackageFile('src/streams/antigravity-session/www/build.ts');
    expect(buildTs).toContain('generateAntigravityEntry(pkgRoot)');
    expect(buildTs).toContain('./dist/www/antigravity-session');
  });
});

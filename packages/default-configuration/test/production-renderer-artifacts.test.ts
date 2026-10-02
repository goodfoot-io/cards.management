/**
 * Checks the actual shipping artifacts under an explicitly development build environment.
 * @summary Native renderer publication excludes development React and JSX overhead
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const packageDirectory = resolve(import.meta.dirname, '..');

describe('shipping native renderer artifacts', () => {
  it.each([
    'claude-code-session',
    'codex-session',
    'opencode-session',
    'antigravity-session'
  ])('publishes production React and JSX for %s even when the build process uses development', async (provider) => {
    const directory = await mkdtemp(join(tmpdir(), 'cards-production-renderer-'));
    try {
      await symlink(join(packageDirectory, 'src'), join(directory, 'src'), 'junction');
      await promisify(execFile)(
        'yarn',
        ['exec', 'bun', `--cwd=${directory}`, 'run', join(packageDirectory, `src/streams/${provider}/www/build.ts`)],
        { cwd: packageDirectory, env: { ...process.env, NODE_ENV: 'development' } }
      );
      const html = await readFile(join(directory, `dist/www/${provider}/index.html`), 'utf8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).not.toContain('react_stack_bottom_frame');
      expect(html).not.toContain('jsxDEV');
      expect(html).not.toContain('react.development.js');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

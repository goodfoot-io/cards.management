/**
 * Real-git tests for rich main-repository root resolution.
 * @summary Verifies main-repository root resolution behavior.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMainRepoRoot } from '../../src/config/main-repo-root.js';

describe('main repository root resolution', () => {
  let tempDir: string;
  let savedCwd: string;
  let savedRepoRoot: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-main-root-'));
    savedCwd = process.cwd();
    savedRepoRoot = process.env['REPO_ROOT'];
    delete process.env['REPO_ROOT'];
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedRepoRoot === undefined) delete process.env['REPO_ROOT'];
    else process.env['REPO_ROOT'] = savedRepoRoot;
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('prefers a nonempty REPO_ROOT verbatim', () => {
    process.env['REPO_ROOT'] = path.join(tempDir, 'declared-root');

    expect(resolveMainRepoRoot()).toEqual({
      ok: true,
      path: path.join(tempDir, 'declared-root')
    });
  });

  it('falls through an empty REPO_ROOT to a standard git common directory', () => {
    process.env['REPO_ROOT'] = '';
    execFileSync('git', ['init', '--quiet', tempDir], { stdio: 'ignore' });
    process.chdir(tempDir);

    expect(resolveMainRepoRoot()).toEqual({ ok: true, path: tempDir });
  });

  it('rejects a bare repository as a nonstandard common-directory layout', () => {
    execFileSync('git', ['init', '--quiet', '--bare', tempDir], { stdio: 'ignore' });
    process.chdir(tempDir);

    const result = resolveMainRepoRoot();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unsupported basename');
  });

  it('returns bounded single-line failure data outside a git repository', () => {
    process.chdir(tempDir);

    const result = resolveMainRepoRoot();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('git common-directory lookup failed');
      expect(result.reason.length).toBeLessThanOrEqual(1024 + 40);
      expect(result.reason).not.toMatch(/[\r\n]/u);
    }
  });
});

/**
 * Tests for the wwwRoot directory copier.
 *
 * @summary Tests for processWwwRoot
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processWwwRoot } from '../../../src/config/cli/www-bundler.js';

const FIXTURES_DIR = mkdtempSync(join(tmpdir(), 'cards-sdk-www-bundler-test-fixtures-'));

beforeAll(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURES_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('processWwwRoot', () => {
  it('copies the entrypoint and sibling assets to the output directory', async () => {
    const testDir = join(FIXTURES_DIR, 'process-test');
    const srcDir = join(testDir, 'www');
    const outDir = join(testDir, 'output');
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, 'helper.js'), `export const val = 'copied';\n`);
    writeFileSync(join(srcDir, 'style.css'), `body { margin: 0; }\n`);
    writeFileSync(
      join(srcDir, 'index.html'),
      `<!DOCTYPE html><html><body><script type="module" src="./helper.js"></script></body></html>`
    );

    await processWwwRoot(srcDir, outDir);

    expect(readFileSync(join(outDir, 'index.html'), 'utf-8')).toContain('helper.js');
    expect(readFileSync(join(outDir, 'style.css'), 'utf-8')).toContain('body { margin: 0; }');
    expect(readFileSync(join(outDir, 'helper.js'), 'utf-8')).toContain('copied');
  });

  it('recursively copies nested directories', async () => {
    const testDir = join(FIXTURES_DIR, 'nested');
    const srcDir = join(testDir, 'www');
    const outDir = join(testDir, 'output');
    mkdirSync(join(srcDir, 'assets', 'icons'), { recursive: true });

    writeFileSync(join(srcDir, 'index.html'), `<!DOCTYPE html><html></html>`);
    writeFileSync(join(srcDir, 'assets', 'icons', 'logo.svg'), `<svg/>`);

    await processWwwRoot(srcDir, outDir);

    expect(readFileSync(join(outDir, 'assets', 'icons', 'logo.svg'), 'utf-8')).toBe('<svg/>');
  });

  it('supports a custom entrypoint filename', async () => {
    const testDir = join(FIXTURES_DIR, 'custom-entry');
    const srcDir = join(testDir, 'www');
    const outDir = join(testDir, 'output');
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, 'app.html'), `<!DOCTYPE html><html><body>app</body></html>`);

    await processWwwRoot(srcDir, outDir, 'app.html');

    expect(readFileSync(join(outDir, 'app.html'), 'utf-8')).toContain('app');
  });

  it('throws when the entrypoint does not exist', async () => {
    const testDir = join(FIXTURES_DIR, 'missing-entry');
    const srcDir = join(testDir, 'www');
    const outDir = join(testDir, 'output');
    mkdirSync(srcDir, { recursive: true });

    await expect(processWwwRoot(srcDir, outDir)).rejects.toThrow('wwwRoot entrypoint not found');
  });
});

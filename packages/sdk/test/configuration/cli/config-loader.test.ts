/**
 * Tests for configuration file loader.
 *
 *
 * @summary Tests for configuration file loader
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/cli/config-loader.js';

// Test fixtures directory - tmpdir() is canonicalised via realpathSync so it
// matches the path production loadConfig resolves to (on macOS os.tmpdir() is a
// /var symlink that resolves to /private/var; Windows 8.3 short names and a
// symlinked $TMPDIR on Linux differ likewise). Built with path.join so it is
// separator-correct on every platform.
const FIXTURES_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'cards-sdk-config-loader-fixtures-')));

describe('loadConfig', () => {
  beforeAll(() => {
    // Create fixtures directory
    mkdirSync(FIXTURES_DIR, { recursive: true });

    // Create valid TypeScript config with a simple inline structure
    writeFileSync(
      join(FIXTURES_DIR, 'valid.config.ts'),
      `
const testAction = {
  factoryType: 'action',
  actionName: 'Test',
  handler: async () => {}
};

export default {
  environments: {
    default: {
      version: 1,
      actions: [testAction]
    }
  }
};
      `.trim()
    );

    // Create valid JavaScript config
    writeFileSync(
      join(FIXTURES_DIR, 'valid.config.js'),
      `
export default {
  environments: {
    default: {
      version: 1,
      actions: []
    }
  }
};
      `.trim()
    );

    // Create config without default export (only named exports)
    writeFileSync(
      join(FIXTURES_DIR, 'no-default.config.ts'),
      `
export const config = {
  environments: {
    default: {
      version: 1,
      actions: []
    }
  }
};
      `.trim()
    );

    // Create config with null default export
    writeFileSync(
      join(FIXTURES_DIR, 'null-default.config.ts'),
      `
export default null;
      `.trim()
    );

    // Create config with invalid structure (missing environments)
    writeFileSync(
      join(FIXTURES_DIR, 'invalid-structure.config.ts'),
      `
export default {
  version: 1,
  actions: []
};
      `.trim()
    );

    // Create config in subdirectory for relative path test
    mkdirSync(join(FIXTURES_DIR, 'subdir'), { recursive: true });
    writeFileSync(
      join(FIXTURES_DIR, 'subdir', 'nested.config.ts'),
      `
export default {
  environments: {
    production: {
      version: 1,
      actions: []
    }
  }
};
      `.trim()
    );
  });

  afterAll(() => {
    // Clean up fixtures
    rmSync(FIXTURES_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('successful loads', () => {
    it('loads valid TypeScript config file with default export', async () => {
      const configPath = join(FIXTURES_DIR, 'valid.config.ts');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.config).toBeDefined();
        expect(result.config.environments).toBeDefined();
        expect(result.config.environments['default']).toBeDefined();
        expect(result.configPath).toBe(configPath);
      }
    });

    it('loads valid JavaScript config file', async () => {
      const configPath = join(FIXTURES_DIR, 'valid.config.js');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.config).toBeDefined();
        expect(result.config.environments).toBeDefined();
        expect(result.config.environments['default']).toBeDefined();
        expect(result.configPath).toBe(configPath);
      }
    });

    it('resolves relative paths to absolute paths', async () => {
      // Save current directory
      const originalCwd = process.cwd();

      try {
        // Change to fixtures directory
        process.chdir(FIXTURES_DIR);

        // Load with relative path
        const result = await loadConfig('./valid.config.ts');

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.configPath).toBe(join(FIXTURES_DIR, 'valid.config.ts'));
          expect(result.config.environments).toBeDefined();
        }
      } finally {
        // Restore original directory
        process.chdir(originalCwd);
      }
    });

    it('loads config from nested directory', async () => {
      const configPath = join(FIXTURES_DIR, 'subdir', 'nested.config.ts');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.config.environments['production']).toBeDefined();
        expect(result.configPath).toBe(configPath);
      }
    });
  });

  describe('error handling', () => {
    it('returns error for non-existent file', async () => {
      const configPath = join(FIXTURES_DIR, 'does-not-exist.config.ts');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('does not exist');
        expect(result.error).toContain(configPath);
      }
    });

    it('returns error for config without default export', async () => {
      const configPath = join(FIXTURES_DIR, 'no-default.config.ts');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(false);
      if (!result.success) {
        // Without a default export, module.default is undefined
        expect(result.error).toContain('no default export');
      }
    });

    it('returns error for null default export', async () => {
      const configPath = join(FIXTURES_DIR, 'null-default.config.ts');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(false);
      if (!result.success) {
        // null fails the !config check
        expect(result.error).toContain('no default export');
      }
    });

    it('returns error for config with invalid structure (missing environments)', async () => {
      const configPath = join(FIXTURES_DIR, 'invalid-structure.config.ts');
      const result = await loadConfig(configPath);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('invalid structure');
        expect(result.error).toContain('environments');
      }
    });

    it('returns error for non-existent relative path', async () => {
      const result = await loadConfig('./this-does-not-exist.config.ts');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('does not exist');
      }
    });
  });

  describe('path handling', () => {
    it('handles absolute paths correctly', async () => {
      const absolutePath = join(FIXTURES_DIR, 'valid.config.ts');
      const result = await loadConfig(absolutePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.configPath).toBe(absolutePath);
      }
    });

    it('normalizes path separators', async () => {
      // Use forward slashes even on Windows
      const configPath = `${FIXTURES_DIR.replace(/\\/g, '/')}/valid.config.ts`;
      const result = await loadConfig(configPath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.configPath).toBe(join(FIXTURES_DIR, 'valid.config.ts'));
      }
    });
  });
});

/**
 * End-to-end tests for the builder CLI.
 *
 * These tests verify the complete build pipeline:
 * 1. Configuration loading from TypeScript files
 * 2. Handler compilation into standalone ESM bundles
 * 3. Settings.json generation with proper structure
 * 4. Stale file cleanup between builds
 * 5. Error handling for various failure scenarios
 *
 *
 * @summary End-to-end tests for the builder CLI
 * @module
 */

import { exec as execCallback } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from '../../src/config/cli/index.js';
import type { Settings } from '../../src/config/schema.js';

const exec = promisify(execCallback);

// ============================================================================
// Test Constants
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Path to the factories module for creating valid handlers.
 */
const FACTORIES_PATH = path.resolve(__dirname, '../../src/config/factories/index.js');

/**
 * Temporary directory for test fixtures.
 */
const FIXTURES_BASE = path.join(
  '/tmp/claude-1000/-workspace--worktrees-settings-updates',
  crypto.randomUUID(),
  'builder-cli-fixtures'
);

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a unique test directory for each test.
 *
 * @param name - Logical suite name used as part of the temporary directory path.
 * @returns Absolute path to the created test directory.
 */
function createTestDir(name: string): string {
  const dir = path.join(FIXTURES_BASE, name, crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Writes a configuration file that imports handlers.
 *
 * @param dir - Directory where `settings.config.ts` should be written.
 * @param content - TypeScript configuration source text.
 * @returns Absolute path to the generated config file.
 */
function writeConfig(dir: string, content: string): string {
  const configPath = path.join(dir, 'settings.config.ts');
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

/**
 * Writes a handler file.
 *
 * @param dir - Directory where the handler file should be created.
 * @param filename - Handler file name to write.
 * @param content - Handler source code.
 * @returns Absolute path to the written handler file.
 */
function writeHandler(dir: string, filename: string, content: string): string {
  const handlerPath = path.join(dir, filename);
  fs.writeFileSync(handlerPath, content, 'utf-8');
  return handlerPath;
}

/**
 * Creates a minimal valid action handler.
 *
 * @param actionName - Action label embedded into the generated fixture.
 * @param _handlerPath - Reserved argument kept for API symmetry with other fixture builders.
 * @returns Handler module source code string.
 */
function createActionHandler(actionName: string, _handlerPath: string): string {
  return `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  {
    actionName: '${actionName}',
    timeout: 30000
  },
  async (input, { logger }) => {
    logger.info('${actionName} executed');
  }
);
`;
}

/**
 * Reads and parses settings.json from the output directory.
 *
 * @param outdir - Build output directory expected to contain `settings.json`.
 * @returns Parsed settings object with optional generated-files metadata.
 */
function readSettings(outdir: string): Settings & { __generated?: { files: string[] } } {
  const settingsPath = path.join(outdir, 'settings.json');
  const content = fs.readFileSync(settingsPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Lists files in the bin directory.
 *
 * @param outdir - Build output directory expected to contain a `bin` subdirectory.
 * @returns Compiled `.mjs` filenames from the bin directory.
 */
function listBinFiles(outdir: string): string[] {
  const binDir = path.join(outdir, 'bin');
  if (!fs.existsSync(binDir)) {
    return [];
  }
  return fs.readdirSync(binDir).filter((f) => f.endsWith('.mjs'));
}

// ============================================================================
// Tests
// ============================================================================

describe('builder CLI: build function', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir('build-function');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('successful builds', () => {
    it('should build a config with a single action', async () => {
      writeHandler(testDir, 'my-action.ts', createActionHandler('My Action', testDir));

      // Create config
      const configPath = writeConfig(
        testDir,
        `
import handler from './my-action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [handler]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');

      // Build
      const result = await build({ config: configPath, outdir });

      if (!result.success) {
        console.error('Build failed:', result.error);
      }
      expect(result.success).toBe(true);
      if (result.success) {
        // Production resolves outdir via path.resolve (adds the drive letter on
        // Windows). Resolve the expectation the same way so the assertion is
        // drive-letter/separator tolerant rather than over-specifying a POSIX
        // literal path.
        expect(result.settingsPath).toBe(path.resolve(outdir, 'settings.json'));
        expect(result.compiledHandlers.length).toBe(1);
      }

      // Verify settings.json
      const settings = readSettings(outdir);
      expect(settings.environments['default']).toBeDefined();
      expect(settings.environments['default']!.actions).toHaveLength(1);
      expect(settings.environments['default']!.actions[0]!.name).toBe('My Action');
      expect(settings.environments['default']!.actions[0]!.command.command).toMatch(/\.mjs$/);

      // Verify compiled handler exists
      const binFiles = listBinFiles(outdir);
      expect(binFiles.length).toBe(1);
      expect(binFiles[0]).toMatch(/my-action\.[a-f0-9]{8}\.mjs$/);
    });

    it('should build a config with multiple actions', async () => {
      // Create handlers
      writeHandler(testDir, 'launch.ts', createActionHandler('Launch', testDir));
      writeHandler(testDir, 'deploy.ts', createActionHandler('Deploy', testDir));

      // Create config
      const configPath = writeConfig(
        testDir,
        `
import launchHandler from './launch.js';
import deployHandler from './deploy.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [launchHandler, deployHandler]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      const result = await build({ config: configPath, outdir });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.compiledHandlers.length).toBe(2);
      }

      // Verify settings.json
      const settings = readSettings(outdir);
      expect(settings.environments['default']!.actions).toHaveLength(2);
      expect(settings.environments['default']!.actions[0]!.command.command).toMatch(/launch\.[a-f0-9]{8}\.mjs$/);
      expect(settings.environments['default']!.actions[1]!.command.command).toMatch(/deploy\.[a-f0-9]{8}\.mjs$/);

      // Verify both handlers compiled
      const binFiles = listBinFiles(outdir);
      expect(binFiles.length).toBe(2);
    });

    it('should build a config with multiple environments', async () => {
      // Create handlers
      writeHandler(testDir, 'dev-action.ts', createActionHandler('Dev Action', testDir));
      writeHandler(testDir, 'prod-action.ts', createActionHandler('Prod Action', testDir));

      // Create config
      const configPath = writeConfig(
        testDir,
        `
import devAction from './dev-action.js';
import prodAction from './prod-action.js';

export default {
  environments: {
    development: {
      version: 1,
      description: 'Development environment',
      actions: [devAction]
    },
    production: {
      version: 1,
      description: 'Production environment',
      actions: [prodAction]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      const result = await build({ config: configPath, outdir });

      expect(result.success).toBe(true);

      // Verify settings.json has both environments
      const settings = readSettings(outdir);
      expect(settings.environments['development']).toBeDefined();
      expect(settings.environments['production']).toBeDefined();
      expect(settings.environments['development']!.description).toBe('Development environment');
      expect(settings.environments['production']!.description).toBe('Production environment');
    });

    it('should include action metadata in settings.json', async () => {
      // Create handler with all metadata
      const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  {
    actionName: 'Full Metadata Action',
    description: 'An action with all metadata',
    icon: 'rocket',
    timeout: 60000,
    supportsBackgroundMode: true
  },
  async (input, { logger }) => {
    logger.info('Executed');
  }
);
`;
      writeHandler(testDir, 'full-action.ts', handlerContent);

      const configPath = writeConfig(
        testDir,
        `
import action from './full-action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      const result = await build({ config: configPath, outdir });

      expect(result.success).toBe(true);

      // Verify all metadata is in settings.json
      const settings = readSettings(outdir);
      const action = settings.environments['default']!.actions[0]!;
      expect(action.name).toBe('Full Metadata Action');
      expect(action.description).toBe('An action with all metadata');
      expect(action.icon).toBe('rocket');
      expect(action.supportsBackgroundMode).toBe(true);
      expect(action.command.timeout).toBe(60000);
    });
  });

  describe('__generated metadata', () => {
    it('should include __generated metadata with file list', async () => {
      writeHandler(testDir, 'action.ts', createActionHandler('Test', testDir));

      const configPath = writeConfig(
        testDir,
        `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      await build({ config: configPath, outdir });

      const settings = readSettings(outdir);
      expect(settings.__generated).toBeDefined();
      expect(settings.__generated?.files).toBeInstanceOf(Array);
      expect(settings.__generated?.files.length).toBe(1);
    });

    it('should list unique files in __generated.files', async () => {
      // Create handlers where one is used twice
      writeHandler(testDir, 'shared-handler.ts', createActionHandler('Shared', testDir));

      const configPath = writeConfig(
        testDir,
        `
import handler from './shared-handler.js';

export default {
  environments: {
    env1: {
      version: 1,
      actions: [handler]
    },
    env2: {
      version: 1,
      actions: [handler]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      await build({ config: configPath, outdir });

      const settings = readSettings(outdir);
      // Should only have one unique file even though handler is used twice
      expect(settings.__generated?.files.length).toBe(1);
    });
  });

  describe('content hashing', () => {
    it('should generate deterministic hashes for same content', async () => {
      writeHandler(testDir, 'action.ts', createActionHandler('Test', testDir));

      const configPath = writeConfig(
        testDir,
        `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
      );

      const outdir1 = path.join(testDir, 'dist1');
      const outdir2 = path.join(testDir, 'dist2');

      await build({ config: configPath, outdir: outdir1 });
      await build({ config: configPath, outdir: outdir2 });

      const files1 = listBinFiles(outdir1);
      const files2 = listBinFiles(outdir2);

      // Same content should produce same hash
      expect(files1[0]!).toBe(files2[0]!);
    });

    it('should generate different hashes for different content', async () => {
      writeHandler(testDir, 'action1.ts', createActionHandler('Action One', testDir));
      writeHandler(testDir, 'action2.ts', createActionHandler('Action Two', testDir));

      const configPath = writeConfig(
        testDir,
        `
import action1 from './action1.js';
import action2 from './action2.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action1, action2]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      await build({ config: configPath, outdir });

      const files = listBinFiles(outdir);
      expect(files.length).toBe(2);

      // Extract hashes
      const hash1 = files[0]!.match(/\.([a-f0-9]{8})\.mjs$/)?.[1];
      const hash2 = files[1]!.match(/\.([a-f0-9]{8})\.mjs$/)?.[1];

      expect(hash1).toBeDefined();
      expect(hash2).toBeDefined();
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('stale file cleanup', () => {
    it('should remove stale files from previous build', async () => {
      // First build with two actions
      writeHandler(testDir, 'action1.ts', createActionHandler('Action 1', testDir));
      writeHandler(testDir, 'action2.ts', createActionHandler('Action 2', testDir));

      const configPath = writeConfig(
        testDir,
        `
import action1 from './action1.js';
import action2 from './action2.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action1, action2]
    }
  }
};
`
      );

      const outdir = path.join(testDir, 'dist');
      await build({ config: configPath, outdir });

      const filesAfterFirstBuild = listBinFiles(outdir);
      expect(filesAfterFirstBuild.length).toBe(2);

      // Second build with only one action
      writeConfig(
        testDir,
        `
import action1 from './action1.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action1]
    }
  }
};
`
      );

      await build({ config: configPath, outdir });

      const filesAfterSecondBuild = listBinFiles(outdir);
      expect(filesAfterSecondBuild.length).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should fail for non-existent config file', async () => {
      const result = await build({
        config: path.join(testDir, 'does-not-exist.config.ts'),
        outdir: path.join(testDir, 'dist')
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('does not exist');
      }
    });

    it('should fail for config with invalid structure', async () => {
      writeConfig(
        testDir,
        `
export default {
  // Missing environments
  version: 1
};
`
      );

      const result = await build({
        config: path.join(testDir, 'settings.config.ts'),
        outdir: path.join(testDir, 'dist')
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('invalid structure');
      }
    });

    it('should fail for config with syntax error', async () => {
      writeConfig(
        testDir,
        `
export default {
  environments: {
    default: {
      version: 1
      actions: []  // Missing comma
    }
  }
};
`
      );

      const result = await build({
        config: path.join(testDir, 'settings.config.ts'),
        outdir: path.join(testDir, 'dist')
      });

      expect(result.success).toBe(false);
    });

    it('should fail for handler with compilation error', async () => {
      // Create handler with syntax error
      writeHandler(
        testDir,
        'broken.ts',
        `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Broken', timeout: 30000, sourcePath: '/broken.ts' },
  async (input, { logger }) => {
    // Missing closing brace
    logger.info('test');
`
      );

      const configPath = writeConfig(
        testDir,
        `
import broken from './broken.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [broken]
    }
  }
};
`
      );

      const result = await build({
        config: configPath,
        outdir: path.join(testDir, 'dist')
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });
  });
});

describe('builder CLI: compiled handler execution', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir('handler-execution');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * Builds the child environment for a compiled handler.
   *
   * The handler must see exactly the Cards environment the test declares. A
   * developer running this suite from inside a Cards action inherits that
   * session's `CARDS_*` variables, and an inherited
   * `CARDS_RUNTIME_CREDENTIAL_FILE` in particular hands the handler the very
   * credentials these cases exist to withhold — the refusal assertion then
   * passes vacuously against a handler that admitted cleanly.
   *
   * @param env - Cards environment variables declared for the handler.
   * @returns Child environment with ambient Cards variables removed.
   */
  function handlerEnv(env: Record<string, string>): NodeJS.ProcessEnv {
    const child: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(child)) {
      if (key.startsWith('CARDS_')) delete child[key];
    }
    return { ...child, ...env };
  }

  /**
   * Helper to execute a compiled handler.
   *
   * @param handlerPath - Absolute path to the compiled handler executable.
   * @param env - Environment variable overrides supplied to the process.
   * @returns Exit code and captured stdio from the spawned process.
   */
  async function executeHandler(
    handlerPath: string,
    env: Record<string, string>
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await exec(`node "${handlerPath}"`, {
        env: handlerEnv(env),
        timeout: 10000
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error: unknown) {
      const execError = error as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: execError.code ?? 1,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? ''
      };
    }
  }

  it('compiles handlers that refuse execution without admitted runtime credentials', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Executable', testDir));

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    await build({ config: configPath, outdir });

    const binFiles = listBinFiles(outdir);
    expect(binFiles.length).toBe(1);

    const handlerPath = path.join(outdir, 'bin', binFiles[0]!);
    const result = await executeHandler(handlerPath, {
      CARD_ID: 'test-card',
      ACTION_NAME: 'Test',
      ENVIRONMENT: 'default',
      EXECUTION_MODE: 'interactive',
      EXIT_WHEN_DONE: 'false',
      WORKSPACE_PATH: testDir,
      REPO_ROOT: testDir,
      CARD_REPO_PATH: testDir,
      CONFIG_PATH: testDir,
      EXTENSION_PATH: testDir,
      MARKETPLACE_PATH: testDir
    });

    expect(result.exitCode).toBe(1);
  });

  it('compiles CommonJS dependencies while preserving fail-closed runtime admission', async () => {
    // Create a handler that would need CommonJS support
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';
import * as path from 'node:path';

export default defineAction(
  {
    actionName: 'CJS Test',
    timeout: 30000
  },
  async (input, { logger }) => {
    // Use path module (a Node built-in that works with CJS shim)
    const joined = path.join('a', 'b', 'c');
    logger.info('Path joined: ' + joined);
  }
);
`;
    writeHandler(testDir, 'cjs-action.ts', handlerContent);

    const configPath = writeConfig(
      testDir,
      `
import action from './cjs-action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    const buildResult = await build({ config: configPath, outdir });
    expect(buildResult.success).toBe(true);

    const binFiles = listBinFiles(outdir);
    const handlerPath = path.join(outdir, 'bin', binFiles[0]!);
    const result = await executeHandler(handlerPath, {
      CARD_ID: 'test-card',
      ACTION_NAME: 'CJS Test',
      ENVIRONMENT: 'default',
      EXECUTION_MODE: 'interactive',
      EXIT_WHEN_DONE: 'false',
      WORKSPACE_PATH: testDir,
      REPO_ROOT: testDir,
      CARD_REPO_PATH: testDir,
      CONFIG_PATH: testDir,
      EXTENSION_PATH: testDir,
      MARKETPLACE_PATH: testDir
    });

    expect(result.exitCode).toBe(1);
  });
});

describe('builder CLI: directory and file handling', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir('file-handling');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('should create output directory if it does not exist', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Test', testDir));

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'nested', 'output', 'directory');
    expect(fs.existsSync(outdir)).toBe(false);

    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);
    expect(fs.existsSync(outdir)).toBe(true);
    expect(fs.existsSync(path.join(outdir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(outdir, 'bin'))).toBe(true);
  });

  it('should create bin directory for compiled handlers', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Test', testDir));

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    await build({ config: configPath, outdir });

    const binDir = path.join(outdir, 'bin');
    expect(fs.existsSync(binDir)).toBe(true);
    expect(fs.statSync(binDir).isDirectory()).toBe(true);
  });

  // Skipped on Windows: the executable bit (POSIX mode & 0o100) does not exist
  // in the Windows file system, so `chmod +x` is a no-op and stats.mode never
  // carries an owner-execute bit. This is an intrinsically-POSIX assertion;
  // skipping honestly rather than weakening it on POSIX.
  it.skipIf(process.platform === 'win32')('should make compiled handlers executable', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Test', testDir));

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    await build({ config: configPath, outdir });

    const binFiles = listBinFiles(outdir);
    for (const file of binFiles) {
      const filePath = path.join(outdir, 'bin', file);
      const stats = fs.statSync(filePath);
      // Check executable bit
      const isExecutable = (stats.mode & 0o100) !== 0;
      expect(isExecutable).toBe(true);
    }
  });

  it('should write settings.json with proper formatting', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Test', testDir));

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action]
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    await build({ config: configPath, outdir });

    const settingsContent = fs.readFileSync(path.join(outdir, 'settings.json'), 'utf-8');

    // Should be formatted with 2-space indentation
    expect(settingsContent).toContain('\n');
    expect(settingsContent).toContain('  ');

    // Should be valid JSON
    expect(() => JSON.parse(settingsContent)).not.toThrow();
  });
});

describe('builder CLI: stream wwwRoot builds', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir('stream-wwwroot');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * Creates a renderer directory with an entrypoint so the build's fail-closed
   * wwwRoot check passes.
   *
   * @param name - Renderer directory name under `renderers/`.
   * @param entrypoint - Entrypoint filename (defaults to `index.html`).
   */
  function writeRenderer(name: string, entrypoint = 'index.html'): void {
    const rendererDir = path.join(testDir, 'renderers', name);
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, entrypoint), `<html><body>${name}</body></html>`);
  }

  it('should build config with stream wwwRoot and include streams section in settings.json', async () => {
    writeHandler(testDir, 'action-start.ts', createActionHandler('Test Action', testDir));
    writeRenderer('test-stream');

    const configPath = writeConfig(
      testDir,
      `
import action from './action-start.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'test-stream': {
          version: 1,
          wwwRoot: './renderers/test-stream'
        }
      }
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);

    // Verify settings.json has streams section with wwwRoot
    const settings = readSettings(outdir);
    expect(settings.environments['default']!.streams).toBeDefined();
    expect(settings.environments['default']!.streams?.['test-stream']).toBeDefined();
    expect(settings.environments['default']!.streams?.['test-stream']!.version).toBe(1);
    expect(settings.environments['default']!.streams?.['test-stream']!.wwwRoot).toBe('./www/test-stream');
  });

  it('should support streams coexisting with actions', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Test Action', testDir));
    writeRenderer('test-stream');

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'test-stream': {
          version: 1,
          wwwRoot: './renderers/test-stream'
        }
      }
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);

    // Verify settings.json has actions and streams sections
    const settings = readSettings(outdir);
    expect(settings.environments['default']!.actions).toBeDefined();
    expect(settings.environments['default']!.actions.length).toBe(1);
    expect(settings.environments['default']!.streams).toBeDefined();
    expect(settings.environments['default']!.streams?.['test-stream']).toBeDefined();

    // Verify bin/ has file for action (not stream — no compilation)
    const binFiles = listBinFiles(outdir);
    expect(binFiles.length).toBe(1);
    expect(binFiles.some((f) => f.includes('action'))).toBe(true);
  });

  it('should preserve stream metadata in settings.json', async () => {
    writeHandler(testDir, 'action.ts', createActionHandler('Test Action', testDir));
    writeRenderer('metadata', 'app.html');

    const configPath = writeConfig(
      testDir,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'stream-with-metadata': {
          version: 2,
          wwwRoot: './renderers/metadata',
          entrypoint: 'app.html',
          maxLineLength: 2048,
          maxStreamSize: 1048576
        }
      }
    }
  }
};
`
    );

    const outdir = path.join(testDir, 'dist');
    await build({ config: configPath, outdir });

    // Verify all metadata fields are in settings.json
    const settings = readSettings(outdir);
    const streamConfig = settings.environments['default']!.streams?.['stream-with-metadata'];
    expect(streamConfig).toBeDefined();
    expect(streamConfig?.version).toBe(2);
    expect(streamConfig?.wwwRoot).toBe('./www/stream-with-metadata');
    expect(streamConfig?.entrypoint).toBe('app.html');
    expect(streamConfig?.maxLineLength).toBe(2048);
    expect(streamConfig?.maxStreamSize).toBe(1048576);
  });
});

// ============================================================================
// Cleanup
// ============================================================================

beforeAll(() => {
  fs.mkdirSync(FIXTURES_BASE, { recursive: true });
});

afterAll(() => {
  fs.rmSync(FIXTURES_BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

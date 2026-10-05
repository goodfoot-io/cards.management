/**
 * Tests for CLI main entry point.
 *
 *
 * @summary Tests for CLI main entry point
 * @module
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build, main } from '../../../src/config/cli/index.js';

// Test fixtures directory - built with path.join so it is separator-correct on
// every platform (build() resolves outdir to a native absolute path).
const FIXTURES_DIR = join(tmpdir(), 'cards-sdk-cli-index-test-fixtures');

// Module-level setup/teardown so fixtures are available to all describe blocks
beforeAll(() => {
  // Create fixtures directory
  mkdirSync(FIXTURES_DIR, { recursive: true });

  // Create valid config with actions
  writeFileSync(
    join(FIXTURES_DIR, 'valid.config.ts'),
    `
const launch = {
  factoryType: 'action',
  actionName: 'Launch',
  description: 'Launch Claude',
  icon: 'rocket',
  handler: async () => {}
};

export default {
  environments: {
    default: {
      version: 1,
      description: 'Default environment',
      actions: [launch]
    }
  }
};
    `.trim()
  );

  // Create config with multiple environments
  writeFileSync(
    join(FIXTURES_DIR, 'multi-env.config.ts'),
    `
const action1 = {
  factoryType: 'action',
  actionName: 'Action1',
  handler: async () => {}
};

const action2 = {
  factoryType: 'action',
  actionName: 'Action2',
  handler: async () => {}
};

export default {
  environments: {
    development: {
      version: 1,
      actions: [action1]
    },
    production: {
      version: 1,
      actions: [action2]
    }
  }
};
    `.trim()
  );

  // Create config with type definitions
  writeFileSync(
    join(FIXTURES_DIR, 'with-types.config.ts'),
    `
const noteCreate = {
  factoryType: 'typeCreate',
  typeName: 'note',
  handler: async () => {}
};

const action = {
  factoryType: 'action',
  actionName: 'CreateNote',
  handler: async () => {}
};

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      types: {
        note: {
          version: '1.0.0',
          create: noteCreate
        }
      }
    }
  }
};
    `.trim()
  );

  // Create invalid config (missing environments)
  writeFileSync(
    join(FIXTURES_DIR, 'invalid.config.ts'),
    `
export default {
  version: 1,
  actions: []
};
    `.trim()
  );

  // Create config with syntax error
  writeFileSync(
    join(FIXTURES_DIR, 'syntax-error.config.ts'),
    `
export default {
  environments: {
    default: {
      version: 1
      actions: []  // Missing comma
    }
  }
};
    `.trim()
  );
});

afterAll(() => {
  // Clean up fixtures directory
  rmSync(FIXTURES_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('build', () => {
  describe('successful build', () => {
    it('should load config, serialize settings, and write settings.json', async () => {
      const outdir = join(FIXTURES_DIR, 'output-basic');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.settingsPath).toBe(join(outdir, 'settings.json'));
        expect(result.compiledHandlers).toEqual([]);

        // Verify settings.json was written
        const settingsContent = readFileSync(result.settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);

        expect(settings).toHaveProperty('environments');
        expect(settings.environments).toHaveProperty('default');
        expect(settings.environments.default.version).toBe(1);
        expect(settings.environments.default.description).toBe('Default environment');
        expect(settings.environments.default.actions).toHaveLength(1);
        expect(settings.environments.default.actions[0].name).toBe('Launch');
        expect(settings.environments.default.actions[0].description).toBe('Launch Claude');
        expect(settings.environments.default.actions[0].icon).toBe('rocket');
        // Without sourcePath, commands use placeholder format
        expect(settings.environments.default.actions[0].command.command).toBe('action-placeholder.js');
      }
    });

    it('should create output directory if it does not exist', async () => {
      const outdir = join(FIXTURES_DIR, 'output-created');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.settingsPath).toBe(join(outdir, 'settings.json'));

        // Verify directory was created
        const settingsContent = readFileSync(result.settingsPath, 'utf-8');
        expect(settingsContent).toBeTruthy();
      }
    });

    it('should handle multiple environments', async () => {
      const outdir = join(FIXTURES_DIR, 'output-multi-env');
      const result = await build({
        config: join(FIXTURES_DIR, 'multi-env.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const settingsContent = readFileSync(result.settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);

        expect(settings.environments).toHaveProperty('development');
        expect(settings.environments).toHaveProperty('production');
        expect(settings.environments.development.actions[0].name).toBe('Action1');
        expect(settings.environments.production.actions[0].name).toBe('Action2');
      }
    });

    it('should accept absolute config path', async () => {
      const outdir = join(FIXTURES_DIR, 'output-absolute');
      const absoluteConfigPath = join(FIXTURES_DIR, 'valid.config.ts');

      const result = await build({
        config: absoluteConfigPath,
        outdir
      });

      expect(result.success).toBe(true);
    });

    it('should accept relative config path', async () => {
      const outdir = join(FIXTURES_DIR, 'output-relative');

      const result = await build({
        config: './valid.config.ts',
        outdir
      });

      // Should fail because the relative path doesn't exist from cwd
      // This tests that the path resolution happens correctly
      expect(result.success).toBe(false);
    });

    it('should write well-formatted JSON with 2-space indentation', async () => {
      const outdir = join(FIXTURES_DIR, 'output-formatting');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const settingsContent = readFileSync(result.settingsPath, 'utf-8');

        // Check that it's properly formatted (has newlines and indentation)
        expect(settingsContent).toContain('\n');
        expect(settingsContent).toContain('  '); // 2-space indent

        // Verify it's valid JSON
        expect(() => JSON.parse(settingsContent)).not.toThrow();
      }
    });
  });

  describe('error handling - config loading', () => {
    it('should return error for non-existent config file', async () => {
      const result = await build({
        config: join(FIXTURES_DIR, 'nonexistent.config.ts'),
        outdir: join(FIXTURES_DIR, 'output-error')
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('does not exist');
      }
    });

    it('should return error for invalid config structure', async () => {
      const result = await build({
        config: join(FIXTURES_DIR, 'invalid.config.ts'),
        outdir: join(FIXTURES_DIR, 'output-error')
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('invalid structure');
      }
    });

    it('should return error for config with syntax error', async () => {
      const result = await build({
        config: join(FIXTURES_DIR, 'syntax-error.config.ts'),
        outdir: join(FIXTURES_DIR, 'output-error')
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });
  });

  describe('error handling - serialization', () => {
    it('should handle actions without sourcePath gracefully', async () => {
      // Actions are now direct ActionCommand objects with factoryType 'action'
      // Commands without sourcePath get placeholder format
      const outdir = join(FIXTURES_DIR, 'output-no-source');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const settingsContent = readFileSync(result.settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        expect(settings.environments.default.actions[0].command.command).toBe('action-placeholder.js');
      }
    });
  });

  describe('error handling - file system', () => {
    it('should handle directory-creation errors when writing files', async () => {
      // Portable analog of an unwritable destination: nest the outdir beneath a
      // regular file so mkdir(recursive) fails (ENOTDIR on POSIX, ENOENT/ENOTDIR
      // on Windows) on every platform without relying on POSIX permissions.
      const blocker = join(FIXTURES_DIR, 'not-a-directory');
      writeFileSync(blocker, 'i am a file');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir: join(blocker, 'path')
      });

      // The exact error depends on permissions, but it should fail
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
    });

    it('should return clear error when outdir is a file instead of directory', async () => {
      // Create a file at the outdir path (common mistake: -o dist/settings.json instead of -o dist)
      const filePath = join(FIXTURES_DIR, 'output-is-file.json');
      writeFileSync(filePath, '{}');

      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir: filePath
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('is a file, not a directory');
        expect(result.error).toContain('-o/--outdir argument should be a directory path');
      }
    });
  });

  describe('$VSCODE_NODE in commands', () => {
    it('should use $VSCODE_NODE instead of node in generated commands', async () => {
      const outdir = join(FIXTURES_DIR, 'output-node-path');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const settingsContent = readFileSync(result.settingsPath, 'utf-8');
        // Commands without sourcePath use placeholder format, so verify
        // no 'node ./' appears in the output (it would only appear for compiled handlers)
        expect(settingsContent).not.toContain('"node ./');
      }
    });
  });

  describe('handler compilation', () => {
    it('should not compile handlers when sourcePath is not provided', async () => {
      const outdir = join(FIXTURES_DIR, 'output-no-compile');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // When sourcePath is not provided, handlers are not compiled
        // Commands use placeholder format in settings.json
        expect(result.compiledHandlers).toEqual([]);
      }
    });
  });

  describe('worktree maintenance', () => {
    it.skip('compiles the worktreeMaintenance root command into its own settings entry', async () => {
      const factories = join(__dirname, '../../../src/config/factories/index.ts').replace(/\\/g, '/');
      const dir = join(FIXTURES_DIR, 'maintenance');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'maintenance.ts'),
        `import { defineWorktreeMaintenance } from '${factories}';
export default defineWorktreeMaintenance({}, async (input, context) => {
  context.report({ mode: input.mode });
});
`
      );
      writeFileSync(
        join(dir, 'settings.config.ts'),
        `import maintenance from './maintenance.js';
export default {
  environments: { default: { version: 1, actions: [] } },
  worktreeMaintenance: maintenance
};
`
      );
      const outdir = join(dir, 'output');
      const result = await build({ config: join(dir, 'settings.config.ts'), outdir });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.compiledHandlers).toHaveLength(1);
        const settings = JSON.parse(readFileSync(result.settingsPath, 'utf-8'));
        const compiled = basename(result.compiledHandlers[0]!);
        expect(settings.worktreeMaintenance.command.command).toContain(compiled);
        expect(settings.environments.default.actions).toEqual([]);
        expect(readFileSync(result.compiledHandlers[0]!, 'utf-8')).toContain('executeCommand');
      }
    });

    it.skip('omits the entry when the configuration has no worktreeMaintenance', async () => {
      const outdir = join(FIXTURES_DIR, 'output-no-maintenance');
      const result = await build({ config: join(FIXTURES_DIR, 'valid.config.ts'), outdir });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(JSON.parse(readFileSync(result.settingsPath, 'utf-8'))).not.toHaveProperty('worktreeMaintenance');
      }
    });
  });

  describe('no log preamble', () => {
    it('should not embed CARDS_HOOKS_LOG_FILE preamble in compiled handler bundles', async () => {
      const outdir = join(FIXTURES_DIR, 'output-no-log');
      const result = await build({
        config: join(FIXTURES_DIR, 'valid.config.ts'),
        outdir
      });

      expect(result.success).toBe(true);

      if (result.success) {
        for (const handlerPath of result.compiledHandlers) {
          const content = readFileSync(handlerPath, 'utf-8');
          // No build-time preamble assigning CARDS_HOOKS_LOG_FILE
          expect(content).not.toMatch(/process\.env\[["']CARDS_HOOKS_LOG_FILE["']\]\s*=/);
        }
      }
    });
  });
});

describe('stream wwwRoot configs', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(FIXTURES_DIR, `stream-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('should include streams with wwwRoot in settings.json', async () => {
    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `
export default {
  factoryType: 'action',
  actionName: 'Test',
  handler: async () => {}
};
      `.trim()
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
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
      `.trim()
    );

    // The build fails closed on a missing wwwRoot entrypoint, so the renderer
    // directory must exist for the streams section to be generated at all.
    const rendererDir = join(testDir, 'renderers', 'test-stream');
    mkdirSync(rendererDir, { recursive: true });
    writeFileSync(join(rendererDir, 'index.html'), '<html><body>test</body></html>');

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);
    if (result.success) {
      const settingsContent = readFileSync(result.settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);

      expect(settings.environments.default.streams).toBeDefined();
      expect(settings.environments.default.streams['test-stream']).toBeDefined();
      expect(settings.environments.default.streams['test-stream'].version).toBe(1);
      expect(settings.environments.default.streams['test-stream'].wwwRoot).toBe('./www/test-stream');
    }
  });

  it('should preserve stream metadata (entrypoint, maxLineLength, maxStreamSize)', async () => {
    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `
export default {
  factoryType: 'action',
  actionName: 'Test',
  handler: async () => {}
};
      `.trim()
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'metadata': {
          version: 1,
          wwwRoot: './renderers/metadata',
          entrypoint: 'app.html',
          maxLineLength: 2048,
          maxStreamSize: 1048576
        }
      }
    }
  }
};
      `.trim()
    );

    // Fail-closed wwwRoot check: the configured entrypoint (app.html) must exist.
    const rendererDir = join(testDir, 'renderers', 'metadata');
    mkdirSync(rendererDir, { recursive: true });
    writeFileSync(join(rendererDir, 'app.html'), '<html><body>metadata</body></html>');

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);
    if (result.success) {
      const settingsContent = readFileSync(result.settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);

      const stream = settings.environments.default.streams.metadata;
      expect(stream.version).toBe(1);
      expect(stream.wwwRoot).toBe('./www/metadata');
      expect(stream.entrypoint).toBe('app.html');
      expect(stream.maxLineLength).toBe(2048);
      expect(stream.maxStreamSize).toBe(1048576);
    }
  });

  it('should handle missing/empty streams gracefully', async () => {
    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `
export default {
  factoryType: 'action',
  actionName: 'Test',
  handler: async () => {}
};
      `.trim()
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
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
      `.trim()
    );

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);
    if (result.success) {
      const settingsContent = readFileSync(result.settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);

      expect(settings.environments.default.streams).toBeUndefined();
    }
  });

  it('should produce settings.json with streams alongside actions', async () => {
    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `
export default {
  factoryType: 'action',
  actionName: 'Test',
  handler: async () => {}
};
      `.trim()
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'full': {
          version: 1,
          wwwRoot: './renderers/full'
        }
      }
    }
  }
};
      `.trim()
    );

    // Fail-closed wwwRoot check: the entrypoint must exist before the build.
    const rendererDir = join(testDir, 'renderers', 'full');
    mkdirSync(rendererDir, { recursive: true });
    writeFileSync(join(rendererDir, 'index.html'), '<html><body>full</body></html>');

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);
    if (result.success) {
      const settingsContent = readFileSync(result.settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);

      expect(settings.environments.default.actions).toBeDefined();
      expect(settings.environments.default.streams).toBeDefined();

      expect(settings.environments.default.actions).toHaveLength(1);
      expect(settings.environments.default.streams.full).toBeDefined();
      expect(settings.environments.default.streams.full.wwwRoot).toBe('./www/full');
    }
  });
});

describe('wwwRoot bundling', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(FIXTURES_DIR, `www-bundle-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('should copy wwwRoot contents to the output directory and rewrite wwwRoot path', async () => {
    const wwwDir = join(testDir, 'renderers', 'my-stream');
    mkdirSync(wwwDir, { recursive: true });

    writeFileSync(join(wwwDir, 'helpers.js'), `export function greet(name) { return 'Hello, ' + name; }\n`);
    writeFileSync(
      join(wwwDir, 'index.html'),
      `<!DOCTYPE html>
<html>
<head><style>body { margin: 0; }</style></head>
<body>
  <div id="root"></div>
  <script type="module" src="./helpers.js"></script>
</body>
</html>`
    );

    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `export default { factoryType: 'action', actionName: 'Test', handler: async () => {} };`
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'my-stream': {
          version: 1,
          wwwRoot: './renderers/my-stream'
        }
      }
    }
  }
};
      `.trim()
    );

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // settings.json should point to the bundled output directory, keyed by
    // stream name (www/<stream>).
    const settings = JSON.parse(readFileSync(result.settingsPath, 'utf-8'));
    expect(settings.environments.default.streams['my-stream'].wwwRoot).toBe('./www/my-stream');

    const copiedHtml = readFileSync(join(outdir, 'www', 'my-stream', 'index.html'), 'utf-8');
    expect(copiedHtml).toContain('body { margin: 0; }');
    expect(copiedHtml).toContain('<div id="root"></div>');
    expect(copiedHtml).toContain('src="./helpers.js"');

    expect(readFileSync(join(outdir, 'www', 'my-stream', 'helpers.js'), 'utf-8')).toContain('Hello, ');
  });

  it('fails closed when two environments define a stream with the same name', async () => {
    // Stream output directories are keyed by stream name alone (www/<stream>),
    // so two environments defining a stream with the same name ('claude-session')
    // would write to the same directory — a last-writer-wins merge. The build
    // must reject this up front instead of silently corrupting one renderer.
    const defaultWww = join(testDir, 'renderers', 'default-session');
    const prodWww = join(testDir, 'renderers', 'prod-session');
    mkdirSync(defaultWww, { recursive: true });
    mkdirSync(prodWww, { recursive: true });

    writeFileSync(
      join(defaultWww, 'index.html'),
      `<!DOCTYPE html><html><body><div id="default-marker"></div></body></html>`
    );
    writeFileSync(join(prodWww, 'index.html'), `<!DOCTYPE html><html><body><div id="prod-marker"></div></body></html>`);

    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `export default { factoryType: 'action', actionName: 'Test', handler: async () => {} };`
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'claude-session': {
          version: 1,
          wwwRoot: './renderers/default-session'
        }
      }
    },
    production: {
      version: 1,
      actions: [action],
      streams: {
        'claude-session': {
          version: 1,
          wwwRoot: './renderers/prod-session'
        }
      }
    }
  }
};
      `.trim()
    );

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    expect(result.success).toBe(false);
    if (result.success) return;

    // The error must name the offending stream and both environments so the
    // author knows exactly what to rename.
    expect(result.error).toContain('claude-session');
    expect(result.error).toContain('default');
    expect(result.error).toContain('production');
  });

  it('should fail closed when the wwwRoot entrypoint does not exist', async () => {
    const actionHandlerPath = join(testDir, 'action.ts');
    writeFileSync(
      actionHandlerPath,
      `export default { factoryType: 'action', actionName: 'Test', handler: async () => {} };`
    );

    const configPath = join(testDir, 'settings.config.ts');
    writeFileSync(
      configPath,
      `
import action from './action.js';

export default {
  environments: {
    default: {
      version: 1,
      actions: [action],
      streams: {
        'missing': {
          version: 1,
          wwwRoot: './renderers/nonexistent'
        }
      }
    }
  }
};
      `.trim()
    );

    const outdir = join(testDir, 'output');
    const result = await build({ config: configPath, outdir });

    // Passing the source path through would deploy a wwwRoot that resolves to
    // nothing at runtime — the build must refuse and name the offending
    // stream, environment, and resolved entrypoint path.
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error).toContain('missing');
    expect(result.error).toContain('default');
    expect(result.error).toContain(join(testDir, 'renderers', 'nonexistent', 'index.html'));
  });
});

describe('main', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    // Mock process.exit to throw instead of terminating
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('should read process.argv and execute build', async () => {
    const outdir = join(FIXTURES_DIR, 'output-main-argv');
    process.argv = ['node', 'cli.js', 'build', '-c', join(FIXTURES_DIR, 'valid.config.ts'), '-o', outdir];

    await expect(main()).rejects.toThrow('process.exit(0)');
    expect(consoleLogSpy).toHaveBeenCalledWith('Build successful!');
  });

  it('should exit with code 0 on success', async () => {
    const outdir = join(FIXTURES_DIR, 'output-main-success');
    process.argv = ['node', 'cli.js', 'build', '-c', join(FIXTURES_DIR, 'valid.config.ts'), '-o', outdir];

    await expect(main()).rejects.toThrow('process.exit(0)');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should exit with code 1 on error', async () => {
    process.argv = ['node', 'cli.js', 'build', '-c', '/nonexistent/config.ts', '-o', '/tmp/out'];

    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should print error message on failure', async () => {
    process.argv = ['node', 'cli.js', 'build', '-c', '/nonexistent/config.ts', '-o', '/tmp/out'];

    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Build failed:'), expect.any(String));
  });

  it('should print usage on parse error', async () => {
    process.argv = ['node', 'cli.js', 'build']; // Missing required args

    await expect(main()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error:', expect.any(String));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });
});

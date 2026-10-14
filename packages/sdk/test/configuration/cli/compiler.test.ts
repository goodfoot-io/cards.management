/**
 * Tests for the handler compiler.
 *
 * These tests verify that the compiler correctly bundles handler files into
 * standalone ESM bundles with runtime wrapper code injected.
 *
 * @summary Tests for the handler compiler
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileHandler } from '../../../src/config/cli/compiler.js';

// Resolve the path to the factories module for test fixtures
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTORIES_PATH = path.resolve(__dirname, '../../../src/config/factories/index.js');

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a temporary directory for test files.
 *
 * @returns Absolute path to a newly created temporary directory.
 */
function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-compiler-test-'));
}

/**
 * Writes a test handler file and returns its path.
 *
 * @param dir - Directory where the handler fixture should be written.
 * @param filename - Filename to assign to the handler fixture.
 * @param content - Source code content to write into the fixture file.
 * @returns Absolute path to the written handler fixture.
 */
function writeTestHandler(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Reads the compiled output file.
 *
 * @param outputPath - Absolute path to the compiled bundle to inspect.
 * @returns UTF-8 source text of the compiled bundle.
 */
function readCompiledOutput(outputPath: string): string {
  return fs.readFileSync(outputPath, 'utf-8');
}

/**
 * Cleans up a test directory.
 *
 * @param dir - Directory path to recursively remove.
 */
function cleanupTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('compileHandler', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    cleanupTestDir(testDir);
  });

  // ==========================================================================
  // Basic Compilation
  // ==========================================================================

  it('should compile a simple JavaScript handler to ESM bundle', async () => {
    // Create a simple handler that imports from the real source path
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info('Action started');
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify success
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputPath).toBe(outputPath);
    }

    // Verify output file exists
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify output is valid JavaScript
    const output = readCompiledOutput(outputPath);
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(0);
  });

  it('should compile a TypeScript handler to ESM bundle', async () => {
    // Create a TypeScript handler that imports from the real source path
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';
import type { ActionInput, ActionContext } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input: ActionInput, context: ActionContext) => {
    context.logger.info('Action started');
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.ts', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify success
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.outputPath).toBe(outputPath);
    }

    // Verify output file exists
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  // ==========================================================================
  // Wrapper Injection
  // ==========================================================================

  it('should inject runtime wrapper code that calls executeCommand', async () => {
    // Create a simple handler
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info('Test');
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify success
    expect(result.success).toBe(true);

    // Read output and verify wrapper code
    const output = readCompiledOutput(outputPath);

    // The output should import executeCommand from the runtime
    expect(output).toContain('executeCommand');

    // The output should call executeCommand (either directly or through bundled code)
    // We're looking for the pattern where executeCommand is invoked
    expect(output).toMatch(/executeCommand\s*\(/);
  });

  // ==========================================================================
  // Source Maps
  // ==========================================================================

  it('should generate inline source maps when requested', async () => {
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info('Test');
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile with sourcemap
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: true
    });

    // Verify success
    expect(result.success).toBe(true);

    // Read output and verify source map is present
    const output = readCompiledOutput(outputPath);
    expect(output).toContain('sourceMappingURL');
  });

  it('should not generate source maps when not requested', async () => {
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info('Test');
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile without sourcemap
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify success
    expect(result.success).toBe(true);

    // Read output and verify no source map
    const output = readCompiledOutput(outputPath);
    expect(output).not.toContain('sourceMappingURL');
  });

  // ==========================================================================
  // Dependency Bundling
  // ==========================================================================

  it('should bundle dependencies inline', async () => {
    // Create a handler that imports a local module
    const utilContent = `
export function greet(name) {
  return \`Hello, \${name}!\`;
}
`;
    writeTestHandler(testDir, 'util.js', utilContent);

    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';
import { greet } from './util.js';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info(greet('World'));
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify success
    expect(result.success).toBe(true);

    // Read output and verify the greet function is bundled
    const output = readCompiledOutput(outputPath);
    expect(output).toContain('greet');
    expect(output).toContain('Hello');
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  it('should return error for non-existent source file', async () => {
    const sourcePath = path.join(testDir, 'non-existent.js');
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify failure
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('should return error for handler with syntax errors', async () => {
    // Create a handler with syntax errors
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    // Missing closing brace
    context.logger.info('Test');
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputPath = path.join(testDir, 'output.mjs');

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify failure
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeTruthy();
    }
  });

  // ==========================================================================
  // Output Directory Creation
  // ==========================================================================

  it('should create output directory if it does not exist', async () => {
    const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info('Test');
  }
);
`;
    const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
    const outputDir = path.join(testDir, 'nested', 'output', 'dir');
    const outputPath = path.join(outputDir, 'output.mjs');

    // Verify output directory doesn't exist yet
    expect(fs.existsSync(outputDir)).toBe(false);

    // Compile
    const result = await compileHandler({
      sourcePath,
      outputPath,
      sourcemap: false
    });

    // Verify success
    expect(result.success).toBe(true);

    // Verify output directory was created
    expect(fs.existsSync(outputDir)).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  // ==========================================================================
  // Log Preamble Removed
  // ==========================================================================

  describe('no log preamble', () => {
    it('should not embed CARDS_HOOKS_LOG_FILE preamble in compiled output', async () => {
      const handlerContent = `
import { defineAction } from '${FACTORIES_PATH.replace(/\\/g, '/')}';

export default defineAction(
  { actionName: 'Test', timeout: 30000 },
  async (input, context) => {
    context.logger.info('Test');
  }
);
`;
      const sourcePath = writeTestHandler(testDir, 'handler.js', handlerContent);
      const outputPath = path.join(testDir, 'output.mjs');

      const result = await compileHandler({
        sourcePath,
        outputPath,
        sourcemap: false
      });

      expect(result.success).toBe(true);
      const output = readCompiledOutput(outputPath);
      // No build-time preamble setting CARDS_HOOKS_LOG_FILE — env var is set at runtime
      expect(output).not.toMatch(/process\.env\[["']CARDS_HOOKS_LOG_FILE["']\]\s*=/);
    });
  });
});

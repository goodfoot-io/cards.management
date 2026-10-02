/**
 * Handler compiler for Cards Configuration.
 *
 * This module provides functionality to compile handler files into standalone
 * ESM bundles that can be executed by the runtime. The compiler uses esbuild
 * to bundle each handler file with its dependencies and injects a wrapper
 * that calls the executeCommand function.
 *
 * ## Compilation Process
 *
 * 1. Generates wrapper code that imports the handler and runtime
 * 2. Feeds the wrapper to esbuild via stdin (no temp files on disk)
 * 3. Outputs a standalone ESM file that can be executed with Node.js or Bun
 * 4. Optionally generates source maps for debugging
 *
 * ## Wrapper Code
 *
 * The compiler injects a wrapper that:
 * - Imports the executeCommand function from the runtime
 * - Imports the user's handler default export
 * - Calls executeCommand(handler) to start the runtime orchestration
 *
 *
 * @summary Handler compiler for Cards Configuration
 * @module
 * @see {@link compileHandler} for the main compilation function
 *
 * @example
 * ```typescript
 * import { compileHandler } from '@cards.management/sdk/config/cli/compiler';
 *
 * const result = await compileHandler({
 *   sourcePath: '/path/to/handler.ts',
 *   outputPath: '/path/to/output.mjs',
 *   sourcemap: true
 * });
 *
 * if (result.success) {
 *   console.log(`Compiled to: ${result.outputPath}`);
 * } else {
 *   console.error(`Compilation failed: ${result.error}`);
 * }
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Options for compiling a handler file.
 */
export interface CompileOptions {
  /**
   * Source file path (handler file).
   *
   * This should be an absolute path to a TypeScript or JavaScript file that
   * exports a command handler as its default export.
   */
  sourcePath: string;

  /**
   * Output file path for compiled bundle.
   *
   * The compiled bundle will be written to this path. Parent directories will
   * be created if they don't exist.
   */
  outputPath: string;

  /**
   * Whether to generate source maps.
   *
   * When true, generates inline source maps for debugging. When false, no
   * source maps are generated. Defaults to false.
   */
  sourcemap?: boolean;

  /**
   * Additional esbuild loaders for non-code imports.
   *
   * Maps file extensions to esbuild loader types (e.g., `{ '.md': 'text' }`).
   * Allows handler code to import non-JS assets like markdown files.
   */
  loaders?: Record<string, string>;
}

/**
 * Result of a successful compilation.
 */
export interface CompileSuccess {
  /** Indicates the compilation succeeded */
  success: true;

  /** The path where the compiled bundle was written */
  outputPath: string;
}

/**
 * Result of a failed compilation.
 */
export interface CompileFailure {
  /** Indicates the compilation failed */
  success: false;

  /** Human-readable error message describing the failure */
  error: string;
}

/**
 * Result of a handler compilation.
 *
 * This is a discriminated union that either represents success or failure.
 * Check the `success` field to determine which variant you have.
 */
export type CompileResult = CompileSuccess | CompileFailure;

// ============================================================================
// Implementation
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * Finds the package root by traversing up from a starting directory
 * looking for package.json. Works whether invoked from src/ (tests)
 * or dist/ (bundled CLI).
 *
 * @param startDir - Directory to start traversing upward from.
 * @returns Absolute path to the first ancestor containing `package.json`.
 * @throws Error if no `package.json` is found before reaching the filesystem root.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find package.json from ${startDir}`);
}

function getPackageRoot(): string {
  return findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
}

/**
 * External modules (Node built-ins) that should not be bundled.
 */
const EXTERNALS = [
  'node:*',
  'http',
  'https',
  'url',
  'stream',
  'zlib',
  'events',
  'buffer',
  'util',
  'path',
  'fs',
  'os',
  'crypto',
  'child_process',
  'perf_hooks',
  'async_hooks',
  'diagnostics_channel'
];

/**
 * Banner to enable CommonJS require() in ESM bundles.
 * This is needed because some dependencies (e.g., gray-matter) use CommonJS
 * and need a working require() function for Node built-ins.
 */
const BANNER = `import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);`;

/**
 * Compiles a handler file into a standalone ESM bundle.
 *
 * This function bundles the handler file with all its dependencies using
 * esbuild, injects runtime wrapper code, and outputs an executable ESM file.
 * The resulting bundle can be executed directly with Node.js or Bun.
 *
 * ## Bundling Strategy
 *
 * - **Format**: ESM (ES Modules)
 * - **Target**: Node.js compatible (ES2022)
 * - **External modules**: Node built-ins are externalized
 * - **Wrapper injection**: Feeds wrapper code to esbuild via stdin that
 *   imports the handler and calls executeCommand()
 *
 * ## Error Handling
 *
 * Returns a CompileFailure result if:
 * - The source file doesn't exist
 * - The source file has syntax errors
 * - esbuild encounters an error during bundling
 * - The output directory cannot be created
 * - File system operations fail
 *
 * @param options - Compilation options including source path, output path, and sourcemap flag
 * @returns A promise that resolves to a CompileResult indicating success or failure
 *
 * @example
 * ```typescript
 * // Compile a TypeScript handler
 * const result = await compileHandler({
 *   sourcePath: '/workspace/handlers/my-action.ts',
 *   outputPath: '/workspace/.compiled/my-action.mjs',
 *   sourcemap: true
 * });
 *
 * if (!result.success) {
 *   console.error(result.error);
 *   process.exit(1);
 * }
 * ```
 */
export async function compileHandler(options: CompileOptions): Promise<CompileResult> {
  const { sourcePath, outputPath, sourcemap = false, loaders } = options;

  try {
    // Verify source file exists
    if (!fs.existsSync(sourcePath)) {
      return {
        success: false,
        error: `Source file does not exist: ${sourcePath}`
      };
    }

    // Generate wrapper content based on handler type.
    // Use relative paths so that sourcesContent in the source map is
    // identical regardless of which worktree or checkout directory the
    // build runs from. esbuild resolves these via resolveDir.
    const resolveDir = path.dirname(sourcePath);
    const toRelativeImport = (absolute: string) => {
      const rel = path.relative(resolveDir, absolute).replace(/\\/g, '/');
      return rel.startsWith('.') ? rel : `./${rel}`;
    };
    const sourceImport = toRelativeImport(sourcePath);

    // Generate the compiled handler entrypoint.
    const runtimeImport = toRelativeImport(path.resolve(getPackageRoot(), 'src/config/runtime.ts'));
    const wrapperContent = `
import handler from '${sourceImport}';
import { executeCommand } from '${runtimeImport}';

executeCommand(handler);
`;

    // Create output directory if it doesn't exist
    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });

    // Build using esbuild
    // Use stdin to avoid writing a temporary wrapper file to disk. The
    // sourcefile uses a distinct name so it cannot collide with the
    // handler file that the wrapper imports (esbuild treats sourcefile
    // as the virtual filename for the stdin content).
    //
    const result = await esbuild.build({
      stdin: {
        contents: wrapperContent,
        resolveDir,
        sourcefile: 'hook-wrapper.ts',
        loader: 'ts'
      },
      outfile: outputPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      sourcemap: sourcemap ? 'inline' : false,
      minify: false,
      treeShaking: true,
      external: EXTERNALS,
      banner: { js: BANNER },
      logLevel: 'silent',
      loader: loaders as Record<string, esbuild.Loader> | undefined
    });

    if (result.errors.length > 0) {
      const errors = result.errors.map((e) => e.text).join('\n');
      return {
        success: false,
        error: `Bundling failed: ${errors}`
      };
    }

    return {
      success: true,
      outputPath
    };
  } catch (error) {
    // Handle esbuild build errors
    if (error && typeof error === 'object' && 'errors' in error) {
      const buildError = error as esbuild.BuildFailure;
      const errors = buildError.errors.map((e) => e.text).join('\n');
      return {
        success: false,
        error: `Bundling failed: ${errors}`
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Compilation failed: ${errorMessage}`
    };
  }
}

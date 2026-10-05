/**
 * Configuration file loader for settings.config.ts files.
 *
 * Loads and validates TypeScript configuration files using esbuild to bundle
 * them into a temporary ESM module, then dynamically imports the result.
 * Validates that the loaded module exports a valid SettingsConfig with the
 * required 'environments' property.
 *
 *
 * @summary Configuration file loader for settings.config.ts files
 * @module
 *
 * @example
 * ```typescript
 * const result = await loadConfig('./settings.config.ts');
 * if (result.success) {
 *   console.log('Loaded config from:', result.configPath);
 *   console.log('Environments:', Object.keys(result.config.environments));
 * } else {
 *   console.error('Failed to load config:', result.error);
 * }
 * ```
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import type { SettingsConfig } from '../config.js';

/**
 * Pattern matching factory call sites in handler files.
 *
 * Matches `defineAction({` at the start of a config object literal.
 * The plugin injects `sourcePath` as the first property so that the
 * V8-based `getCallerFile()` fallback (which returns the temp bundle
 * path) is never reached.
 */
const FACTORY_CALL_RE = /\b(define(?:Action|StreamTransform|CardsAssistant|WorktreeMaintenance))\s*\(\s*\{/g;

/**
 * esbuild plugin that injects `sourcePath` into factory config objects during
 * config bundling.
 *
 * When esbuild bundles a settings.config.ts, all handler source files are
 * merged into a single temp file. This plugin runs before bundling and injects
 * each file's real path into the factory config object so that the CLI knows
 * which source file to compile for each handler.
 */
const injectSourcePath: esbuild.Plugin = {
  name: 'inject-source-path',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      const source = readFileSync(args.path, 'utf-8');

      if (!FACTORY_CALL_RE.test(source)) {
        return undefined;
      }

      // Reset lastIndex after test()
      FACTORY_CALL_RE.lastIndex = 0;

      const contents = source.replaceAll(FACTORY_CALL_RE, `$1({ sourcePath: ${JSON.stringify(args.path)},`);

      const ext = extname(args.path);
      const loader: esbuild.Loader =
        ext === '.ts' || ext === '.mts' ? 'ts' : ext === '.tsx' || ext === '.mtsx' ? 'tsx' : 'js';

      return { contents, loader };
    });
  }
};

/**
 * Successful configuration load result.
 */
export interface LoadSuccess {
  /**
   * Indicates successful load.
   */
  success: true;

  /**
   * The loaded and validated configuration.
   */
  config: SettingsConfig;

  /**
   * Absolute path to the loaded configuration file.
   */
  configPath: string;
}

/**
 * Failed configuration load result.
 */
export interface LoadFailure {
  /**
   * Indicates failed load.
   */
  success: false;

  /**
   * Human-readable error message describing why the load failed.
   */
  error: string;
}

/**
 * Result of loading a configuration file.
 *
 * This is a discriminated union that can be checked using the `success`
 * property to determine if the load succeeded or failed.
 */
export type LoadResult = LoadSuccess | LoadFailure;

/**
 * Load and validate a settings configuration file.
 *
 * Bundles a TypeScript or JavaScript configuration file using esbuild into a
 * temporary ESM module, then dynamically imports it. The file must have a
 * default export containing a valid SettingsConfig object with an
 * 'environments' property.
 *
 * @param configPath - Path to the configuration file (relative or absolute)
 * @param loaders - Additional esbuild loaders for non-code imports (e.g., `{ '.md': 'text' }`).
 * @returns Promise resolving to a LoadResult indicating success or failure
 *
 * @example
 * ```typescript
 * // Load from relative path
 * const result = await loadConfig('./settings.config.ts');
 *
 * if (result.success) {
 *   console.log('Config loaded from:', result.configPath);
 *   const environments = Object.keys(result.config.environments);
 *   console.log('Available environments:', environments);
 * } else {
 *   console.error('Failed to load:', result.error);
 * }
 * ```
 */
export async function loadConfig(configPath: string, loaders?: Record<string, string>): Promise<LoadResult> {
  // Resolve to absolute path
  const absolutePath = resolve(configPath);

  // Check if file exists
  if (!existsSync(absolutePath)) {
    return {
      success: false,
      error: `Configuration file does not exist: ${absolutePath}`
    };
  }

  const tempFile = join(tmpdir(), `cards-config-${randomUUID()}.mjs`);

  try {
    // Bundle the config file with esbuild. This handles TypeScript
    // transpilation and resolves all imports into a single ESM file.
    const buildResult = await esbuild.build({
      entryPoints: [absolutePath],
      outfile: tempFile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      plugins: [injectSourcePath],
      banner: {
        js: `import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);`
      },
      logLevel: 'silent',
      loader: loaders as Record<string, esbuild.Loader> | undefined
    });

    if (buildResult.errors.length > 0) {
      const errors = buildResult.errors.map((e) => e.text).join('\n');
      return {
        success: false,
        error: `Failed to load configuration file: ${errors}`
      };
    }

    // Dynamically import the bundled config
    const mod = await import(pathToFileURL(tempFile).href);
    const config = mod.default;

    // Check for default export
    if (!config || typeof config !== 'object') {
      return {
        success: false,
        error: `Configuration file has no default export: ${absolutePath}`
      };
    }

    const maybeConfig = config as Record<string, unknown>;

    // Validate basic structure (must have environments property)
    if (!maybeConfig['environments'] || typeof maybeConfig['environments'] !== 'object') {
      return {
        success: false,
        error: `Configuration has invalid structure: missing 'environments' property in ${absolutePath}`
      };
    }

    // Return successful result
    return {
      success: true,
      config: maybeConfig as unknown as SettingsConfig,
      configPath: absolutePath
    };
  } catch (error) {
    // Handle esbuild build errors
    if (error && typeof error === 'object' && 'errors' in error) {
      const buildError = error as esbuild.BuildFailure;
      const errors = buildError.errors.map((e) => e.text).join('\n');
      return {
        success: false,
        error: `Failed to load configuration file: ${errors}`
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to load configuration file: ${errorMessage}`
    };
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`config-loader: failed to clean up temp file ${tempFile}: ${error}\n`);
      }
    }
  }
}

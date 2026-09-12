/**
 * Shared session utilities for OpenCode action workflows.
 *
 * Mirrors {@link ./codex-session.js} launch-for-launch: it populates a
 * content-addressed plugin cache from the bundled `opencode` payload tree,
 * writes per-plugin-set staged config documents, and spawns the `opencode`
 * CLI with card context, worktree lifecycle, cancel handling, status settle,
 * and mode-dependent post-exit branch cleanup (detached watcher when
 * interactive, inline sweep in background mode).
 *
 * Isolation model (verified against the installed binary, v1.18.21): the child
 * is pointed at one staged config document via the `OPENCODE_CONFIG` env var,
 * which adds a config layer **between** the user's global config dir and the
 * project layer (`OPENCODE_CONFIG_DIR` is deliberately NOT overridden — the
 * user's provider/model config keeps loading, and their plain `opencode`
 * sessions never see ours because the staged document never enters their
 * config dir). Arrays concat across layers (spiked), so the user's own plugins
 * keep loading alongside the Cards set. The cache itself nests under
 * `<configDir>/plugins/cache/cards/<plugin>/<version>/`, which the single-level
 * `{plugin,plugins}/*.{ts,js}` auto-scan glob never enumerates.
 *
 * Cross-layer load identity (verified against v1.18.23): plugin origins concat
 * across config layers and dedupe ONLY by load identity — the npm package name
 * for bare specs, the exact file URL for local specs. When a user-scope
 * install already registers a managed plugin's stable `current.mjs` pointer in
 * the global layer, staging that plugin's per-hook entry URLs would give every
 * hook module two distinct identities and therefore TWO registrations per
 * hook in dispatched sessions. {@link writeCardsLaunchConfig} consequently
 * stages the byte-identical pointer spec for globally registered plugins so
 * the loader's own dedupe collapses the layers into one registration, and
 * keeps direct entry paths otherwise.
 *
 * Staged config schema (verified against the installed binary's embedded
 * Config v2 schema strings): `plugins` accepts absolute `.mjs` file specs;
 * `permissions` is an ordered ruleset of `{action, resource, effect}` rules;
 * `skills` registers additional skill discovery directories. The legacy v1
 * document shape (`plugin`, nested `permission` records) is deliberately NOT
 * used: a document containing any v1 key is migrated wholesale, and the v1→v2
 * migration would silently drop our array-shaped `skills` entries.
 *
 * @summary Shared session utilities for OpenCode action workflows
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { resolveGlobalCardsConfigDir } from '@cards.management/sdk';
import { execFileNoWindowAsync } from '@cards.management/sdk/bin/child-process';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { CARDS_ENV_VARS } from '@cards.management/sdk/config';
import { spawnBranchCleanupWatcher } from './branch-cleanup-watcher.js';
import {
  cleanupMergedBranches,
  errorMessage,
  resolveBaseBranch,
  resolveMarketplacePath,
  resolveOrCreateWorktree
} from './claude-session.js';
import {
  CODEX_PLUGIN_CONTENT_STAMP,
  composeDeveloperInstructions,
  readCardRepoAgentsMd,
  readSlotContentStamp
} from './codex-session.js';
import { createOpencodeTerminationController } from './opencode-termination.js';
import { spawnAgentCli } from './spawn-cli.js';

/**
 * Computes the content digest of a bundled plugin source directory, following
 * directory symlinks.
 *
 * Differs deliberately from {@link computePluginContentHash} in codex-session:
 * the OpenCode payload tree ships out-of-package relative symlinks (e.g.
 * `skills/debug -> ../../../skills/debug`), which the codex walker's
 * `withFileTypes` directory check EISDIRs on when hashing source-as-shipped.
 * Every entry is resolved with {@link module:fs/promises.stat} — which follows
 * symlinks — so linked directories are walked and linked files are hashed by
 * content, mirroring exactly what `fs.cp(..., { dereference: true })` lands in
 * the cache slot. The stamp file is skipped, and repo-relative POSIX paths are
 * folded into one SHA-256 in sorted order for cross-platform determinism.
 *
 * @param sourceDir - Absolute path to the packaged plugin source directory.
 * @returns Lowercase hex SHA-256 digest of the directory's dereferenced contents.
 */
async function computeDereferencedContentHash(sourceDir: string): Promise<string> {
  const files: Array<{ rel: string; abs: string }> = [];

  async function walk(dir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === CODEX_PLUGIN_CONTENT_STAMP) continue;
      const abs = path.join(dir, entry.name);
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        await walk(abs, rel);
      } else if (stat.isFile()) {
        files.push({ rel, abs });
      }
    }
  }

  await walk(sourceDir, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.rel, 'utf-8');
    hash.update('\0');
    hash.update(await fs.readFile(file.abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Options for {@link spawnOpencodeSession}.
 */
export interface OpencodeSessionOptions {
  /** Prompt passed to the OpenCode CLI as positional arguments. */
  prompt?: string;
  /**
   * Session guidance prepended to the prompt positionals. This is the
   * OpenCode analog of Claude's `--append-system-prompt`: `opencode run` has
   * no system-prompt override flag, so caller guidance rides the opening user
   * turn instead of a dedicated channel. Card context itself is injected by
   * the runtime plugin's `experimental.chat.system.transform` hook, not here.
   */
  appendSystemPrompt?: string;
  /**
   * When true, overrides `EXIT_WHEN_DONE` to `'false'` in the child process
   * environment. The runtime plugin's exit-when-done handler then never
   * nudges toward `cards shutdown`, so the agent-driven termination path is
   * suppressed exactly as the sibling agents do.
   */
  suppressExitWhenDone?: boolean;
}

/**
 * Minimal manifest shape required from each bundled OpenCode plugin package.
 *
 * The package.json manifest is the governance anchor for the OpenCode payload
 * tree (the counterpart of Codex's `.codex-plugin/plugin.json`).
 */
interface OpencodePluginManifest {
  /** Package name; must be exactly `cards-opencode-<plugin directory name>`. */
  name: string;
  /** Plugin version; used as the cache version segment `<plugin>/<version>`. */
  version: string;
}

/** All plugin names that may appear in an OpenCode plugin set managed by Cards. */
export type OpencodePluginName = 'cards' | 'runtime' | 'cards-assistant';

/** Plugin set used for the standard Cards launch session (cards + runtime). */
export const OPENCODE_LAUNCH_PLUGIN_NAMES = ['cards', 'runtime'] as const satisfies readonly OpencodePluginName[];

/** Plugin set used for the Cards Assistant session (cards + cards-assistant, no runtime). */
export const OPENCODE_ASSISTANT_PLUGIN_NAMES = [
  'cards',
  'cards-assistant'
] as const satisfies readonly OpencodePluginName[];

/** Which per-plugin-set staged config {@link writeCardsLaunchConfig} writes. */
export type OpencodeLaunchConfigSet = 'launch' | 'assistant';

// ============================================================================
// OpenCode bundle + staging utilities
// ============================================================================

/**
 * Resolves the packaged OpenCode bundle directory bundled alongside the
 * extension marketplace.
 *
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @returns Absolute path to the bundled OpenCode root directory.
 */
function resolveOpencodeBundlePath(marketplacePath: string): string {
  return path.join(path.dirname(marketplacePath), 'opencode');
}

/**
 * Resolves the packaged OpenCode plugin bundled in the extension installation.
 *
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @param pluginName - Bundled OpenCode plugin name to resolve.
 * @returns Absolute path to the packaged OpenCode plugin directory.
 */
function resolveOpencodePluginPath(marketplacePath: string, pluginName: OpencodePluginName): string {
  return path.join(resolveOpencodeBundlePath(marketplacePath), pluginName);
}

/**
 * Resolves the default OpenCode global config directory whose plugin cache we
 * stage into. Mirrors the binary's own resolution: `$XDG_CONFIG_HOME` when set,
 * otherwise `~/.config`, plus `/opencode`. Only the deeply-nested cache below
 * this directory is written — the user's own `opencode.json` is never touched.
 *
 * @returns Absolute path to the OpenCode config directory.
 */
export function resolveDefaultOpencodeConfigDir(): string {
  return `${process.env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config')}/opencode`;
}

/**
 * Resolves the Cards-managed staging directory holding the per-plugin-set
 * config documents passed to spawned sessions via `OPENCODE_CONFIG`. Lives
 * under the Cards home (honoring `$CARDS_HOME`) so it never collides with the
 * user's own OpenCode files.
 *
 * @returns Absolute path to the Cards OpenCode staging directory.
 */
export function resolveCardsOpencodeStagingDir(): string {
  return path.join(resolveGlobalCardsConfigDir(), 'opencode');
}

/**
 * Reads and validates the packaged OpenCode plugin manifest. Fails closed: a
 * manifest whose name disagrees with the requested plugin directory indicates a
 * mis-assembled bundle and must not be staged.
 *
 * @param pluginPath - Absolute path to the packaged OpenCode plugin directory.
 * @param expectedName - Expected plugin name from the bundle layout.
 * @returns Parsed plugin manifest.
 */
async function readOpencodePluginManifest(pluginPath: string, expectedName: OpencodePluginName): Promise<string> {
  const manifestPath = path.join(pluginPath, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Partial<OpencodePluginManifest>;

  const expectedPackageName = `cards-opencode-${expectedName}`;
  if (manifest.name !== expectedPackageName) {
    throw new Error(`Invalid OpenCode plugin manifest name at ${manifestPath}: expected "${expectedPackageName}"`);
  }

  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`OpenCode plugin manifest at ${manifestPath} is missing a non-empty string "version"`);
  }
  validatePluginVersionSegment(manifest.version, manifestPath);

  return manifest.version;
}

/**
 * Validates that a plugin version is usable as a single cache path segment
 * `<plugin>/<version>`. Mirrors the codex launcher's segment validation so a
 * bundle with an unsafe version fails closed here rather than producing an
 * unusable or path-traversing cache entry.
 *
 * @param version - Version string from the plugin manifest.
 * @param sourceLabel - Manifest path, for the error message.
 * @throws {Error} When the version is not a single safe path segment.
 */
function validatePluginVersionSegment(version: string, sourceLabel: string): void {
  if (version === '.' || version === '..' || !/^[A-Za-z0-9._+-]+$/.test(version)) {
    throw new Error(
      `Invalid OpenCode plugin version segment "${version}" at ${sourceLabel}: ` +
        `only ASCII letters, digits, '.', '+', '_', and '-' are allowed`
    );
  }
}

/**
 * Verifies the bundled OpenCode payload tree is present and every requested
 * plugin carries a valid manifest.
 *
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @param pluginNames - Plugin set to verify.
 * @returns Bundle path, source plugin paths, and their validated versions.
 */
async function ensureOpencodeBundleAvailable(
  marketplacePath: string,
  pluginNames: readonly OpencodePluginName[]
): Promise<{
  bundlePath: string;
  pluginPaths: Record<string, string>;
  pluginVersions: Record<string, string>;
}> {
  const bundlePath = resolveOpencodeBundlePath(marketplacePath);
  const pluginPaths: Record<string, string> = Object.fromEntries(
    pluginNames.map((pluginName) => [pluginName, resolveOpencodePluginPath(marketplacePath, pluginName)])
  );
  const pluginVersions: Record<string, string> = {};

  await fs.access(bundlePath);
  for (const pluginName of pluginNames) {
    const pluginPath = pluginPaths[pluginName]!;
    await fs.access(pluginPath);
    const version = await readOpencodePluginManifest(pluginPath, pluginName);
    pluginVersions[pluginName] = version;
  }

  return { bundlePath, pluginPaths, pluginVersions };
}

/** Cache root below the OpenCode config dir; deep enough to never be auto-scanned. */
const OPENCODE_PLUGINS_CACHE_DIR = 'plugins/cache/cards';

/**
 * Resolves whether `directoryPath` exists and is a directory.
 *
 * @param directoryPath - Absolute path to probe.
 * @returns `true` when the path exists and is a directory; `false` on ENOENT.
 * @throws Rethrows non-ENOENT stat errors so genuine failures propagate.
 */
async function isExistingDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Installs one bundled plugin into the cache under its own version segment
 * `<cacheRoot>/<plugin>/<version>` and returns that load path.
 *
 * Clones the codex launcher's stamp/mktemp/rename/prune discipline: fully-built
 * content is staged in an OS-unique mkdtemp dir under the cache root (a
 * sibling of the versioned slots, so the binary's single-level auto-scan never
 * enumerates it), stamped with the bundle's content digest, validated, then
 * published into the version slot by rename. A slot whose stamp already
 * matches the current bundle digest is byte-for-byte current and left
 * untouched, so launches under one extension build converge on the fast path
 * without racing.
 *
 * @param pluginName - Bundled plugin name.
 * @param cacheRoot - `<configDir>/plugins/cache/cards`.
 * @param sourceDir - Packaged plugin source directory.
 * @param version - Validated manifest version used as the cache segment.
 * @returns The load path `<cacheRoot>/<plugin>/<version>`.
 */
async function installPluginToCache(
  pluginName: OpencodePluginName,
  cacheRoot: string,
  sourceDir: string,
  version: string
): Promise<string> {
  const baseRoot = path.join(cacheRoot, pluginName);
  const destVersionDir = path.join(baseRoot, version);
  const contentHash = await computeDereferencedContentHash(sourceDir);

  // Fast path: an existing slot whose stamp matches the current bundle is
  // byte-identical — leave it untouched. No writes, so any number of concurrent
  // launches under the same build converge here without racing.
  if ((await readSlotContentStamp(destVersionDir)) === contentHash) {
    return destVersionDir;
  }

  const staging = await fs.mkdtemp(path.join(cacheRoot, '.plugin-install-'));
  try {
    const stagedVersionDir = path.join(staging, version);
    // dereference: the payload ships relative skill symlinks that must land
    // as real files in the cache slot (see {@link computeDereferencedContentHash}).
    await fs.cp(sourceDir, stagedVersionDir, { recursive: true, force: true, dereference: true });

    // Validate the staged bundle BEFORE publishing — fail closed on a bad bundle.
    await readOpencodePluginManifest(stagedVersionDir, pluginName);
    // Stamp the staged copy so a future launch can recognize this exact bundle.
    await fs.writeFile(path.join(stagedVersionDir, CODEX_PLUGIN_CONTENT_STAMP), contentHash, 'utf-8');

    await fs.mkdir(baseRoot, { recursive: true });
    await publishVersionSlot(stagedVersionDir, destVersionDir, cacheRoot, contentHash);
  } finally {
    // Remove the staging dir (the publish either consumed its version child via
    // rename or lost the race and left it behind). Never touches a live slot.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }

  await pruneSupersededPluginVersions(baseRoot, version);
  return destVersionDir;
}

/**
 * Publishes a fully-built, stamped staging directory into its version slot.
 *
 * Fast path is a single atomic rename into an absent slot. When the slot already
 * exists, the current bundle's content decides: a stamp match means a concurrent
 * or previous publish already placed byte-identical content (idempotent success,
 * leave it), while a mismatch means the slot is stale — {@link replaceVersionSlot}
 * swaps the fresh content in. Any error that is neither an atomic-rename success
 * nor a recognized slot-exists condition propagates (fail closed).
 *
 * @param stagedVersionDir - Fully-built, stamped source in the staging dir.
 * @param destVersionDir - Target version slot `<baseRoot>/<version>`.
 * @param cacheRoot - `<configDir>/plugins/cache/cards`, for the eviction temp dir.
 * @param contentHash - Digest the staged copy is stamped with.
 */
async function publishVersionSlot(
  stagedVersionDir: string,
  destVersionDir: string,
  cacheRoot: string,
  contentHash: string
): Promise<void> {
  try {
    // Publish with a single atomic rename into the (absent) version slot.
    await fs.rename(stagedVersionDir, destVersionDir);
    return;
  } catch (error) {
    if (!(await isSlotExistsError(error, destVersionDir))) {
      throw error;
    }
  }

  // The slot exists. If it already holds our exact bytes, a concurrent or prior
  // publish won — idempotent success. Otherwise it is stale and must be replaced.
  if ((await readSlotContentStamp(destVersionDir)) === contentHash) {
    return;
  }
  await replaceVersionSlot(stagedVersionDir, destVersionDir, cacheRoot, contentHash);
}

/**
 * Replaces a stale version slot with fresh, stamped content by evicting the old
 * slot and renaming the new one in.
 *
 * Eviction moves the stale slot to an OS-unique temp dir (never a live sibling
 * slot) then deletes it; the install rename then lands the fresh content. If a
 * concurrent replacer evicted first, the eviction ENOENT is tolerated; if one
 * re-published first, the install's slot-exists error is accepted only when the
 * now-present slot already holds our exact bytes (fail closed otherwise).
 *
 * @param stagedVersionDir - Fully-built, stamped source in the staging dir.
 * @param destVersionDir - Stale version slot to replace.
 * @param cacheRoot - `<configDir>/plugins/cache/cards`, parent of the temp dir.
 * @param contentHash - Digest the staged copy is stamped with.
 */
async function replaceVersionSlot(
  stagedVersionDir: string,
  destVersionDir: string,
  cacheRoot: string,
  contentHash: string
): Promise<void> {
  const evictDir = await fs.mkdtemp(path.join(cacheRoot, '.plugin-evict-'));
  try {
    try {
      await fs.rename(destVersionDir, path.join(evictDir, 'stale'));
    } catch (error) {
      // A concurrent replacer already evicted the stale slot — proceed to install.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await fs.rename(stagedVersionDir, destVersionDir);
    } catch (error) {
      // A concurrent replacer re-published first. Accept only if the now-present
      // slot already holds our exact bytes; otherwise surface the failure.
      if (
        !(await isSlotExistsError(error, destVersionDir)) ||
        (await readSlotContentStamp(destVersionDir)) !== contentHash
      ) {
        throw error;
      }
    }
  } finally {
    await fs.rm(evictDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Classifies a `fs.rename` failure as "the destination version slot already
 * exists". POSIX surfaces this as `EEXIST`/`ENOTEMPTY`; Windows `MoveFile`
 * refuses to overwrite an existing directory with `EPERM`/`EACCES` instead, so
 * for those codes the slot's presence is confirmed before treating the error as
 * benign — a genuine permission failure still propagates (fail closed).
 *
 * @param error - The error thrown by `fs.rename`.
 * @param destVersionDir - The target version slot.
 * @returns `true` when the error means the slot is already present.
 */
async function isSlotExistsError(error: unknown, destVersionDir: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'EEXIST' ||
    code === 'ENOTEMPTY' ||
    ((code === 'EPERM' || code === 'EACCES') && (await isExistingDirectory(destVersionDir)))
  );
}

/**
 * Best-effort removal of version slots strictly older than `keepVersion` under a
 * plugin base root, keeping the cache bounded across upgrades. Never fatal, and
 * never removes `keepVersion` or any equal-or-higher version — so it cannot race
 * a concurrent launch into deleting the slot that launch resolved to.
 *
 * @param baseRoot - `<cacheRoot>/<plugin>`.
 * @param keepVersion - The version just installed; this and any higher are kept.
 */
async function pruneSupersededPluginVersions(baseRoot: string, keepVersion: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(baseRoot, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === keepVersion) {
        return;
      }
      if (comparePluginVersions(entry.name, keepVersion) >= 0) {
        return;
      }
      await fs.rm(path.join(baseRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
    })
  );
}

/**
 * Orders two plugin version segments. Parses `major.minor.patch` numerically
 * (build/pre-release suffix ignored) and falls back to lexicographic comparison
 * when either side is not a semver triple, matching the intent of the codex
 * launcher's ordering for our bundle versions.
 *
 * @param a - First version segment.
 * @param b - Second version segment.
 * @returns Negative when `a < b`, positive when `a > b`, zero when equal.
 */
function comparePluginVersions(a: string, b: string): number {
  const pa = parseSemverTriple(a);
  const pb = parseSemverTriple(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      const av = pa[i] ?? 0;
      const bv = pb[i] ?? 0;
      if (av !== bv) {
        return av < bv ? -1 : 1;
      }
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parses a `major.minor.patch[-+suffix]` version into its numeric triple.
 *
 * @param version - Version segment to parse.
 * @returns The triple, or `null` when the segment is not a semver-style triple.
 */
function parseSemverTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Materializes each bundled plugin into the OpenCode plugin cache under the
 * resolved config dir, then verifies the load path — without touching the
 * user's own OpenCode configuration. Enablement is supplied separately by
 * {@link writeCardsLaunchConfig} through the staged `OPENCODE_CONFIG` document.
 *
 * Each plugin is installed under its own manifest version segment:
 * `<configDir>/plugins/cache/cards/<plugin>/<version>/`. The nested depth is
 * load-bearing: the binary's local plugin scan globs a single level
 * (`{plugin,plugins}/*.{ts,js}`) across the config dir, so cached slots are
 * never auto-loaded — they load only through the explicit absolute paths in the
 * staged config document.
 *
 * Errors from staging, copy, manifest validation, or the publish rename
 * propagate — fail closed.
 *
 * @param configDir - Resolved OpenCode config dir (`$XDG_CONFIG_HOME ?? ~/.config` + `/opencode`).
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @param pluginNames - Plugin set to stage into the cache. Defaults to
 *   `OPENCODE_LAUNCH_PLUGIN_NAMES` (`cards` + `runtime`), preserving launch behavior.
 * @returns Bundle path, source plugin paths, and the on-disk cache load paths.
 */
export async function populateOpencodePluginCache(
  configDir: string,
  marketplacePath: string,
  pluginNames: readonly OpencodePluginName[] = OPENCODE_LAUNCH_PLUGIN_NAMES
): Promise<{
  bundlePath: string;
  pluginPaths: Record<string, string>;
  pluginCachePaths: Record<string, string>;
}> {
  const { bundlePath, pluginPaths, pluginVersions } = await ensureOpencodeBundleAvailable(marketplacePath, pluginNames);
  const pluginCachePaths: Record<string, string> = {};
  const cacheRoot = path.join(configDir, OPENCODE_PLUGINS_CACHE_DIR);
  await fs.mkdir(cacheRoot, { recursive: true });

  for (const pluginName of pluginNames) {
    const destDir = await installPluginToCache(
      pluginName,
      cacheRoot,
      pluginPaths[pluginName]!,
      pluginVersions[pluginName]!
    );

    // Verify the manifest at the exact load path — fail closed. An off-by-one in
    // destDir (missing/wrong version segment) produces a concrete error here
    // rather than a silent "plugin not loaded" at session startup. Race-free:
    // installPluginToCache never moves or removes a live version slot, so no
    // concurrent launch can move this path out from under the read.
    await readOpencodePluginManifest(destDir, pluginName);
    pluginCachePaths[pluginName] = destDir;
  }

  return { bundlePath, pluginPaths, pluginCachePaths };
}

// ============================================================================
// Per-set staged launch configs
// ============================================================================

/**
 * Serializes a staged-config document deterministically: object keys are sorted
 * recursively, arrays keep their (caller-sorted) element order, output is
 * pretty-printed with two-space indent and a trailing newline. Two calls with
 * identical inputs therefore produce identical bytes regardless of property
 * insertion order.
 *
 * @param value - The document to serialize.
 * @returns The deterministic serialization, newline-terminated.
 */
function stableSerialize(value: unknown): string {
  const sortValue = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sortValue);
    }
    if (input !== null && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]));
    }
    return input;
  };
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

/**
 * Collects the plugin specs to stage for every enabled plugin, in sorted order.
 *
 * For each enabled plugin this is either:
 *
 * - the stable unversioned pointer spec `<cacheRoot>/<plugin>/current.mjs` —
 *   when the global layer already registers EXACTLY that spec string. The
 *   staged document then repeats the global registration byte-for-byte, so
 *   opencode's cross-layer identity dedupe (exact file URL for local specs)
 *   collapses both layers into ONE registration instead of loading the same
 *   hook modules twice (once via the pointer's re-exports, once via direct
 *   entry paths). The pointer must also exist on disk: a registration whose
 *   cache subtree was wiped would otherwise stage a dead module path and
 *   break the session, while the freshly published entry paths are verified
 *   to exist.
 * - the plugin's built hook modules (`<cacheDir>/plugin/*.mjs`) — when there
 *   is no global registration to collide with (plugins that load exclusively
 *   through launch-time staging, users without a user-scope install, or any
 *   fallback above).
 *
 * Fail-closed: an enabled plugin whose `plugin/` directory cannot be read
 * aborts the launch — silently enabling a plugin without its hook modules
 * would degrade session behavior invisibly.
 *
 * @param pluginNames - Enabled plugin names.
 * @param pluginCachePaths - Map of plugin name → installed cache dir.
 * @param globalPluginEntries - `plugin` array entries registered in the
 *   user's global OpenCode config, as resolved by
 *   {@link readGlobalPluginEntries}.
 * @returns Absolute spec paths, sorted lexicographically.
 */
async function collectStagedPluginSpecs(
  pluginNames: readonly OpencodePluginName[],
  pluginCachePaths: Record<string, string>,
  globalPluginEntries: readonly string[]
): Promise<string[]> {
  const specs: string[] = [];
  for (const pluginName of pluginNames) {
    const cacheDir = pluginCachePaths[pluginName];
    if (cacheDir === undefined) {
      throw new Error(`No cache path was populated for enabled OpenCode plugin "${pluginName}"`);
    }
    const pointerPath = path.join(path.dirname(cacheDir), 'current.mjs');
    if (globalPluginEntries.includes(pointerPath) && (await isExistingPath(pointerPath))) {
      specs.push(pointerPath);
      continue;
    }
    const pluginDir = path.join(cacheDir, 'plugin');
    const dirents = await fs.readdir(pluginDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isFile() && dirent.name.endsWith('.mjs')) {
        specs.push(path.join(pluginDir, dirent.name));
      }
    }
  }
  return specs.sort();
}

/**
 * Resolves whether `filePath` can be stat-ed at all (existence probe).
 *
 * Used for pointer files that are about to be staged: any concrete error other
 * than a clean ENOENT still counts as "not safely stageable", so the caller
 * falls back to the freshly published entry paths.
 *
 * @param filePath - Absolute path to probe.
 * @returns `true` when the path exists; `false` otherwise.
 */
async function isExistingPath(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the `plugin` array from the user's global OpenCode config document.
 *
 * The staged launch config must not re-register globally registered plugins
 * under a distinct load identity — see {@link collectStagedPluginSpecs} — so
 * the launch path hands the global registrations to the writer. Absence of
 * the file is normal (no user-scope install); an unreadable or unparseable
 * document degrades to no known registrations rather than failing the launch,
 * which preserves today's entry-path staging behavior at worst.
 *
 * @param configDir - Resolved OpenCode config dir.
 * @returns Registered plugin specs plus a failure reason when the document
 *   existed but could not be trusted; callers should log the failure.
 */
export async function readGlobalPluginEntries(configDir: string): Promise<{
  entries: string[];
  failure?: 'unreadable' | 'unparseable';
}> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(configDir, 'opencode.json'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [] };
    }
    return { entries: [], failure: 'unreadable' };
  }

  try {
    const doc = JSON.parse(raw) as { plugin?: unknown };
    if (!Array.isArray(doc.plugin)) {
      return { entries: [], failure: doc.plugin === undefined ? undefined : 'unparseable' };
    }
    return { entries: doc.plugin.filter((entry): entry is string => typeof entry === 'string') };
  } catch {
    return { entries: [], failure: 'unparseable' };
  }
}

/**
 * Collects each enabled plugin's existing `<cacheSlot>/skills` directory.
 *
 * Shared by launch staging ({@link writeCardsLaunchConfig}) and the
 * extension-side user-scope installer, which registers the same directories in
 * the user's `opencode.json` so plain terminal sessions discover Cards skills.
 *
 * @param pluginNames - Enabled plugin names.
 * @param pluginCachePaths - Map of plugin name → installed cache dir.
 * @returns Absolute existing skills directories, sorted lexicographically.
 */
export async function collectSkillDirs(
  pluginNames: readonly OpencodePluginName[],
  pluginCachePaths: Record<string, string>
): Promise<string[]> {
  const dirs: string[] = [];
  for (const pluginName of pluginNames) {
    const cacheDir = pluginCachePaths[pluginName];
    if (cacheDir === undefined || !(await isExistingDirectory(path.join(cacheDir, 'skills')))) {
      continue;
    }
    dirs.push(path.join(cacheDir, 'skills'));
  }
  return dirs.sort();
}

/**
 * Options for {@link writeCardsLaunchConfig}.
 */
export interface WriteCardsLaunchConfigOptions {
  /**
   * `plugin` array entries registered in the user's global OpenCode config,
   * as resolved by {@link readGlobalPluginEntries}. When an entry equals an
   * enabled plugin's stable pointer spec byte-for-byte, that plugin stages
   * the pointer instead of its per-hook entry paths so opencode's cross-layer
   * identity dedupe collapses global and staged layers into ONE registration
   * — staging raw entry paths alongside a pointer registration loads every
   * hook module twice in dispatched sessions. Omit (or pass empty) to stage
   * direct entry paths unconditionally.
   */
  globalPluginEntries?: readonly string[];
  /**
   * Additional top-level config keys merged over the base document.
   */
  extras?: Record<string, unknown>;
}

/**
 * Writes the per-plugin-set Cards launch config document consumed by spawned
 * OpenCode sessions via the `OPENCODE_CONFIG` env var.
 *
 * One file PER SET (`cards-launch.config.json` / `cards-assistant.config.json`)
 * — never one per launch — closing the concurrent-launch clobber race: the
 * document holds only set-scoped inputs (enabled plugin specs, allow-all
 * tool permissions, skill discovery dirs), so every launch of the same set
 * under the same extension build computes byte-identical content. Concurrent
 * launches hit the stamp-match fast path (current bytes on disk → no write);
 * the rare post-upgrade rewrite lands through a sibling mkdtemp + atomic
 * rename, so a concurrent reader sees either the old or the new complete
 * document, never a partial one.
 *
 * Plugin specs follow {@link collectStagedPluginSpecs}: the stable pointer
 * spec for plugins whose exact pointer the global layer registers, direct
 * entry paths otherwise.
 *
 * Document shape (live-probed against the installed v1.18.21 binary — the
 * earlier "Config v2 schema" reading was wrong: those schema strings exist but
 * the plugin/skills consumers decode legacy keys):
 *
 * - `"plugin"` (singular) — absolute file specs; the plural form is
 *   silently ignored (`onExcessProperty: "ignore"`), producing dead sessions
 *   with no Cards hooks and exit 0.
 * - `"permission"` — nested allow-all records (`{"*":{"*":"allow"}}`); the key
 *   the running binary itself consumes (workspace-root opencode.json precedent).
 * - `"skills": {"paths": [...]}` — object form only; array-shaped skills
 *   hard-rejects startup (`Expected object | undefined`). Probed live: with
 *   this shape a staged SKILL.md was discoverable by the model; without it,
 *   not. Omitted entirely when a set ships no skill directories.
 *
 * Any v1 key (`plugin`) trips the binary's v1 detection, which then migrates
 * the whole document — so the document is pure v1 throughout. `extras` entries
 * are merged last and win over the base keys; they participate in the
 * determinism contract — callers passing per-card values would break
 * cross-launch byte-stability and must not.
 *
 * Deliberately omitted: per-card `references` (Config v2 record mapping a name
 * to a local path or Git repository) and inline `agents` definitions — see
 * {@link spawnOpencodeSession} for the named degradations.
 *
 * @param stagingDir - Directory receiving the config document.
 * @param set - Which plugin set this document enables; also the file stem.
 * @param pluginNames - Enabled plugin names for this set.
 * @param pluginCachePaths - Map of plugin name → installed cache dir (as
 *   returned by {@link populateOpencodePluginCache}). Every enabled plugin must
 *   have an entry — fail closed otherwise.
 * @param options - Global registrations consulted for identity collision,
 *   plus extra top-level config keys.
 * @returns Absolute path to the staged config document.
 * @throws {Error} When an enabled plugin has no cache path, or a plugin's
 *   `plugin/` directory cannot be read.
 */
export async function writeCardsLaunchConfig(
  stagingDir: string,
  set: OpencodeLaunchConfigSet,
  pluginNames: readonly OpencodePluginName[],
  pluginCachePaths: Record<string, string>,
  options?: WriteCardsLaunchConfigOptions
): Promise<string> {
  const { globalPluginEntries = [], extras } = options ?? {};
  const skillDirs = await collectSkillDirs(pluginNames, pluginCachePaths);
  const document: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    plugin: await collectStagedPluginSpecs(pluginNames, pluginCachePaths, globalPluginEntries),
    permission: { '*': { '*': 'allow' } }
  };
  if (skillDirs.length > 0) {
    // Object form is required — array-shaped skills hard-rejects the document.
    document['skills'] = { paths: skillDirs };
  }
  Object.assign(document, extras ?? {});
  const serialized = stableSerialize(document);

  const stem = set === 'launch' ? 'cards-launch' : 'cards-assistant';
  const configPath = path.join(stagingDir, `${stem}.config.json`);

  // Stamp-match skip: current bytes on disk → leave untouched, so the common
  // concurrent-launch case performs no write at all.
  let current: string | null = null;
  try {
    current = await fs.readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (current === serialized) {
    return configPath;
  }

  await fs.mkdir(stagingDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(stagingDir, '.config-write-'));
  try {
    const stagedPath = path.join(staging, `${stem}.config.json`);
    await fs.writeFile(stagedPath, serialized, 'utf-8');
    await fs.rename(stagedPath, configPath);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  return configPath;
}

// ============================================================================
// Launch
// ============================================================================

/**
 * Builds the CLI argument list for the `opencode` process.
 *
 * Interactive actions boot the TUI with the composed opening turn seeded via
 * `--prompt` and the worktree as the project positional — the live-verified
 * surface of the installed binary (the TUI accepts neither `--dir` nor
 * `--title`). Background dispatch uses the headless one-shot
 * `opencode run --dir <worktree> --title <cardId> [message…]`, where the title
 * labels the transcript. There is no system-prompt override flag on either
 * form, so session guidance rides the composed opening turn ahead of the
 * prompt.
 *
 * @param prompt - Prompt passed to OpenCode. Omit for prompt-less sessions.
 * @param workspacePath - Card worktree path used as the session working directory.
 * @param cardId - Card identifier carried on `--title` (background only) so the transcript and UI label the session.
 * @param appendSystemPrompt - Session guidance prepended ahead of `prompt`.
 * @param executionMode - Dispatch mode: `'interactive'` boots the TUI, `'background'` the headless run.
 * @returns Array of CLI arguments.
 */
export function buildOpencodeArgs(
  prompt: string | undefined,
  workspacePath: string,
  cardId: string,
  appendSystemPrompt: string | undefined,
  executionMode: 'interactive' | 'background'
): string[] {
  const fragments = [appendSystemPrompt?.trim(), prompt?.trim()].filter(
    (fragment): fragment is string => fragment !== undefined && fragment.length > 0
  );
  const composed = fragments.join('\n\n');

  // Interactive actions boot the TUI seeded with the composed opening turn
  // (`--prompt`); background dispatch runs the headless one-shot (`run`),
  // which additionally supports `--title` for transcript labeling.
  if (executionMode === 'interactive') {
    return composed.length > 0 ? ['--prompt', composed, workspacePath] : [workspacePath];
  }

  const args = ['run', '--dir', workspacePath];
  if (cardId.length > 0) {
    args.push('--title', cardId);
  }
  if (composed.length > 0) {
    args.push(composed);
  }
  return args;
}

/**
 * Well-known OpenCode install locations probed when the PATH probe fails.
 *
 * The official installer (`curl -fsSL https://opencode.ai/install | bash`)
 * installs to `<home>/.opencode/bin`, which users typically put on PATH from an
 * interactive-shell rc file (`.zshrc`) — a file VS Code's extension host never
 * sources (it resolves its environment through login shells), so a bare-PATH
 * probe misses otherwise-working installs. Mirrors the detection-side fallback
 * in `packages/extension/src/agents/agentDetection.ts`.
 *
 * @returns Absolute candidate paths, best-first.
 */
function wellKnownOpencodeBinaryCandidates(): string[] {
  return [path.join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')];
}

/**
 * Resolves the `opencode` CLI to an absolute path.
 *
 * Probes PATH via `which`/`where` first; when that fails, probes the well-known
 * installer locations ({@link wellKnownOpencodeBinaryCandidates}) so installs
 * reachable only through interactive-shell PATH edits are found.
 *
 * @returns Absolute binary path, or null when nothing resolves.
 */
export async function resolveOpencodeBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileNoWindowAsync(process.platform === 'win32' ? 'where' : 'which', ['opencode']);
    const firstLine = stdout.trim().split('\n')[0]?.trim();
    if (firstLine) {
      return firstLine;
    }
  } catch {
    // Not on PATH (or the probe itself failed) — fall through to the
    // well-known locations rather than declaring the CLI absent.
  }

  for (const candidate of wellKnownOpencodeBinaryCandidates()) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Candidate missing or not executable — try the next one.
    }
  }

  return null;
}

/**
 * Probes for the `opencode` binary before any staging work, failing closed
 * with an actionable message. Mirrors the claude-session launcher's
 * `where`/`which` probe (win32 has no `which`; `where` exits non-zero when the
 * executable is absent).
 *
 * @returns Absolute path to the resolved binary — pass it to {@link spawnAgentCli}
 *          instead of the bare name so a PATH-less extension-host environment
 *          cannot turn an already-verified install into a spawn ENOENT.
 * @throws {Error} When no `opencode` executable resolves on PATH or at the
 *         well-known installer locations.
 */
export async function assertOpencodeBinaryAvailable(): Promise<string> {
  const binaryPath = await resolveOpencodeBinary();
  if (binaryPath === null) {
    throw new Error(
      'The `opencode` CLI was not found on PATH or at ~/.opencode/bin. Install OpenCode and make sure `opencode` ' +
        'resolves on PATH, or switch cards.defaultCodingAgent to another coding agent.'
    );
  }
  return binaryPath;
}

/**
 * Spawns an `opencode` CLI session with worktree lifecycle and prompt-based skill guidance.
 *
 * Stage order mirrors {@link ./codex-session.js} launch-for-launch: pre-spawn
 * binary probe → marketplace resolution → API client → base branch → worktree →
 * plugin-cache staging → per-set staged config → CLI spawn with card env vars →
 * cancel handling → exit settle → card status settle → branch cleanup.
 *
 * Execution modes mirror the Claude launcher: interactive sessions inherit
 * stdio (direct terminal control) and hand post-exit cleanup to the detached
 * branch-cleanup watcher so the terminal closes immediately; background runs
 * execute headlessly via `opencode run` under console-less stdio (`ignore`,
 * `ignore`, piped stderr), log captured stderr for diagnostics, and run the
 * merged-branch sweep inline before resolving.
 *
 * Named degradations (documented plan decisions):
 * - **Per-card `references`**: the Config v2 shape is verified (a record
 *   mapping a name to a local path or Git repository — the `--add-dir` analog),
 *   but folding a per-card path into the shared per-set config document would
 *   break cross-launch byte-determinism and reintroduce the concurrent-launch
 *   clobber race the one-file-per-set design closes. Omitted with this named
 *   note; tool-level access stays governed by the staged allow-all permission
 *   ruleset, and the `CARD_REPO_PATH` env var still reaches every child.
 * - **Inline `agents`**: shipped only when the runtime agents' markdown
 *   frontmatter maps trivially onto Config v2 `agents` entries. It does not —
 *   the frontmatter carries fields with no Config v2 counterpart (`tools`)
 *   alongside out-of-schema color literals — and a rejected inline mapping
 *   would invalidate the whole staged document, silently dropping every other
 *   key with it. Omitted with a warning.
 * - **Switch-to-interactive in background mode**: Claude's switch path relaunches
 *   with `--resume <sessionId>`, but a headless `opencode run` session ID is
 *   server-assigned and unknowable until exit, so no
 *   {@link ActionContext.onSwitchToInteractive} callback is registered — the
 *   runtime wrapper simply never advertises the capability.
 *
 * @param input - Parsed action input from the environment.
 * @param context - Action context providing logger and lifecycle hooks.
 * @param options - Session-specific parameters.
 */
export async function spawnOpencodeSession(
  input: ActionInput,
  context: ActionContext,
  options: OpencodeSessionOptions
): Promise<void> {
  const { prompt: rawPrompt, appendSystemPrompt } = options;

  const opencodeBinary = await assertOpencodeBinaryAvailable();
  const marketplacePath = resolveMarketplacePath();

  context.logger.info(`${input.actionName} action started`, {
    cardId: input.cardId,
    environment: input.environment,
    executionMode: input.executionMode
  });

  const client = await createCardsClient(context.logger);
  if (!client) {
    throw new Error('Cards API discovery failed — cannot start session');
  }

  const baseBranch = await resolveBaseBranch(input.repoRoot, client);
  const {
    worktreePath: cwd,
    branchName,
    parentBranch
  } = await resolveOrCreateWorktree(input, client, baseBranch, context.logger);

  context.logger.info('Using worktree', { cwd, branch: branchName, baseBranch, parentBranch });

  const configDir = resolveDefaultOpencodeConfigDir();
  const { bundlePath, pluginPaths, pluginCachePaths } = await populateOpencodePluginCache(configDir, marketplacePath);
  context.logger.info('Populated OpenCode plugin cache', { configDir, bundlePath, pluginPaths, pluginCachePaths });

  const stagingDir = resolveCardsOpencodeStagingDir();
  // The staged document must not re-register globally registered plugins under
  // a distinct load identity (double hook execution) — hand the writer the
  // global layer's registrations so it can stage the colliding pointer spec.
  const globalRegistrations = await readGlobalPluginEntries(configDir);
  if (globalRegistrations.failure !== undefined) {
    context.logger.warn('Could not read the global OpenCode config plugin registrations', {
      configDir,
      reason: globalRegistrations.failure,
      consequence: 'staged config enumerates direct entry paths; hooks may double-fire for user-scope installed plugins'
    });
  }
  const configPath = await writeCardsLaunchConfig(
    stagingDir,
    'launch',
    OPENCODE_LAUNCH_PLUGIN_NAMES,
    pluginCachePaths,
    {
      globalPluginEntries: globalRegistrations.entries
    }
  );
  context.logger.info('Wrote staged Cards launch config', { stagingDir, configPath });

  // See the JSDoc above: these omissions are deliberate, documented degradations.
  context.logger.info('Staged config omits per-card references registration', {
    reason: 'per-card values would break the shared per-set config byte-determinism'
  });
  context.logger.warn(
    'Staged config omits inline agent definitions: shipped agents/*.md frontmatter is not trivially mappable to OpenCode Config v2 agent entries'
  );

  // Card/workspace context (env, card metadata, repo log, workspace log) is
  // injected by the runtime plugin's system.transform hook, so the prompt is
  // passed through unmodified here. The card-repo AGENTS.md, however, sits
  // outside the session's project-discovery path (--dir worktree), so it is
  // folded ahead of any caller-supplied session guidance into the opening
  // positional turn — the same additive composition the codex launcher feeds
  // its developer_instructions channel.
  const cardRepoAgentsMd = readCardRepoAgentsMd(input.cardRepoPath);
  const guidance = composeDeveloperInstructions([cardRepoAgentsMd, appendSystemPrompt]);
  const args = buildOpencodeArgs(rawPrompt, cwd, input.cardId, guidance, input.executionMode);

  const isInteractive = input.executionMode === 'interactive';

  const child: ChildProcess = spawnAgentCli(opencodeBinary, args, {
    cwd,
    // Interactive mode inherits stdio so the user gets direct terminal control.
    // Background handlers run console-less (spawned from the GUI extension host
    // via pipes): stdout/stdin have no reader and are ignored, stderr is piped
    // for diagnostic capture. windowsHide keeps the cross-spawn cmd.exe hop
    // invisible on win32 — libuv ignores it when any fd is inherited, so the
    // interactive path must not set it.
    stdio: isInteractive ? 'inherit' : ['ignore', 'ignore', 'pipe'],
    // Detached on POSIX (matching spawnCodexSession) so `opencode` roots its
    // own process group instead of sharing the extension host's: termination
    // below signals -pid, which must stay inside a launcher-owned group or it
    // would sweep sibling actions sharing the host's group.
    detached: process.platform !== 'win32',
    ...(isInteractive ? {} : { windowsHide: true }),
    env: {
      ...process.env,
      // Staged activation: ONE extra config layer between the user's global
      // config dir and the project layer. Never OPENCODE_CONFIG_DIR — replacing
      // the config dir would cut the user's provider/model config off.
      OPENCODE_CONFIG: configPath,
      WORKSPACE_PATH: cwd,
      BASE_BRANCH: baseBranch,
      PARENT_BRANCH: parentBranch,
      WORKSPACE_BRANCH: branchName,
      ...(options.suppressExitWhenDone ? { [CARDS_ENV_VARS.EXIT_WHEN_DONE]: 'false' } : {})
    }
  });

  const termination = createOpencodeTerminationController(child, {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 5_000
  });

  context.onCancel(async () => {
    context.logger.info(`${input.actionName} action cancelled, terminating opencode`);
    const result = await termination.terminate('cancel');
    context.logger.info(`${input.actionName} cancellation termination completed`, { result });
  });

  context.onAgentShutdown(async () => {
    context.logger.info(`${input.actionName} agent signalled shutdown, terminating opencode`);
    const result = await termination.terminate('shutdown');
    context.logger.info(`${input.actionName} shutdown termination completed`, { result });
    return result;
  });

  // Background mode: capture stderr for diagnostic logging.
  if (!isInteractive) {
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        context.logger.warn(text);
      }
    });
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    // Fail closed: a spawn failure (e.g. ENOENT) emits `error` but never
    // `close`, which would leave this promise hung forever. Mirrors the
    // cards-assistant launch guard.
    child.on('error', (error) => {
      context.logger.error('Failed to spawn opencode', {
        error: error instanceof Error ? error.message : String(error)
      });
      resolve(null);
    });
    child.on('close', resolve);
  });

  context.logger.info(`${input.actionName} action completed`, { exitCode });

  // Settle the card's status (active → needs_review) before cleanup can
  // read it: the sweep's first gate is the on-disk status, which otherwise
  // races this exit path from a separate process. See
  // Post-exit cleanup: remove fully-merged branches. In background mode there
  // is no terminal to keep open, so the sweep runs inline before the action
  // resolves; in interactive mode a detached watcher takes over so the
  // terminal closes immediately (the watcher calls the same
  // {@link cleanupMergedBranches} function).
  if (isInteractive) {
    try {
      await spawnBranchCleanupWatcher(
        {
          cardId: input.cardId,
          repoRoot: input.repoRoot,
          cardRepoPath: input.cardRepoPath
        },
        context.logger
      );
    } catch (error) {
      context.logger.warn('Failed to spawn branch-cleanup watcher (non-fatal)', {
        error: errorMessage(error)
      });
    }
  } else {
    try {
      await cleanupMergedBranches(input, input.cardRepoPath, context.logger);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('self-referential parentBranch') || message.includes('data corruption')) {
        throw error;
      }
      context.logger.warn('Post-exit cleanup failed (non-fatal)', { error: message });
    }
  }
}

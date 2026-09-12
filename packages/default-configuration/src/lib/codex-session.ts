/**
 * Shared session utilities for Codex action workflows.
 *
 * Reuses the existing worktree lifecycle used by Claude-based actions, while
 * populating the Codex plugin cache before launching the `codex` CLI.
 *
 * @summary Shared session utilities for Codex action workflows
 * @module
 */

import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type Dirent, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createCardsClient } from '@cards.management/sdk/client/discovery';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { CARDS_ENV_VARS } from '@cards.management/sdk/config';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { applyCodexConfig } from './applyCodexConfig.js';
import { spawnBranchCleanupWatcher } from './branch-cleanup-watcher.js';
import {
  cleanupMergedBranches,
  errorMessage,
  resolveBaseBranch,
  resolveMarketplacePath,
  resolveOrCreateWorktree
} from './claude-session.js';
import { buildPluginHooksState, type HooksJson, type HookTrustEntry } from './codex-hook-trust.js';
import { createCodexTerminationController } from './codex-termination.js';
import { spawnAgentCli } from './spawn-cli.js';

/**
 * Options for {@link spawnCodexSession}.
 */
export interface CodexSessionOptions {
  /** Prompt string passed to the Codex CLI. */
  prompt?: string;
  /**
   * Content injected into the Codex CLI as a `developer_instructions` config
   * override (`-c developer_instructions=...`). This is the Codex analog of
   * Claude's `--append-system-prompt`: the value is appended to the developer
   * message bundle every turn without disabling the personality template or
   * overriding `base_instructions` / AGENTS.md `user_instructions`.
   *
   * {@link spawnCodexSession} always prepends the card repository's `AGENTS.md`
   * to this value (see {@link readCardRepoAgentsMd}), so it loads additively
   * alongside the global `~/.codex/AGENTS.md` and any `<workspace>/AGENTS.md`.
   */
  appendSystemPrompt?: string;
  /**
   * When true, overrides `EXIT_WHEN_DONE` to `'false'` in the child process
   * environment.
   */
  suppressExitWhenDone?: boolean;
}

/**
 * Minimal manifest shape required by the Codex plugin loader.
 */
interface CodexPluginManifest {
  name: string;
  /** Plugin version; used as the cache version segment `<plugin>/<version>`. */
  version: string;
}

interface CodexPluginMarketplaceManifest {
  name: string;
}

/** All plugin names that may appear in a Codex plugin set managed by Cards. */
export type CodexPluginName = 'cards' | 'runtime' | 'cards-assistant';

/** Plugin set used for the standard Cards launch session (cards + runtime). */
const CODEX_LAUNCH_PLUGIN_NAMES = ['cards', 'runtime'] as const satisfies readonly CodexPluginName[];

/** Plugin set used for the Cards Assistant session (cards + cards-assistant, no runtime). */
export const CODEX_ASSISTANT_PLUGIN_NAMES = ['cards', 'cards-assistant'] as const satisfies readonly CodexPluginName[];

const CODEX_PLUGIN_MARKETPLACE = 'local';

export class CardRepoAccessError extends Error {
  override readonly name = 'CardRepoAccessError';

  constructor(
    public readonly repoPath: string,
    cause: unknown
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot read card repository at ${repoPath}: ${reason}`);
    this.cause = cause;
  }
}

// ============================================================================
// Codex bundle + staging utilities
// ============================================================================

/**
 * Resolves the packaged Codex bundle directory bundled alongside the extension marketplace.
 *
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @returns Absolute path to the bundled Codex root directory.
 */
function resolveCodexBundlePath(marketplacePath: string): string {
  return path.join(path.dirname(marketplacePath), 'codex');
}

/**
 * Resolves the packaged Codex plugin bundled in the extension installation.
 *
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @param pluginName - Bundled Codex plugin name to resolve.
 * @returns Absolute path to the packaged Codex runtime plugin directory.
 */
function resolveCodexPluginPath(marketplacePath: string, pluginName: CodexPluginName): string {
  return path.join(resolveCodexBundlePath(marketplacePath), pluginName);
}

/**
 * Resolves the source Codex home that should be staged into the Cards-managed home.
 *
 * @returns Absolute path to the source Codex home.
 */
export function resolveDefaultCodexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex');
}

/**
 * Reads and validates the packaged Codex plugin manifest.
 *
 * @param pluginPath - Absolute path to the packaged Codex plugin directory.
 * @param expectedName - Expected plugin name from the bundle manifest.
 * @returns Parsed plugin manifest.
 */
async function readCodexPluginManifest(pluginPath: string, expectedName: CodexPluginName): Promise<string> {
  const manifestPath = path.join(pluginPath, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Partial<CodexPluginManifest>;

  if (manifest.name !== expectedName) {
    throw new Error(`Invalid Codex plugin manifest name at ${manifestPath}: expected "${expectedName}"`);
  }

  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`Codex plugin manifest at ${manifestPath} is missing a non-empty string "version"`);
  }
  validatePluginVersionSegment(manifest.version, manifestPath);

  return manifest.version;
}

/**
 * Validates that a plugin version is usable as a single cache path segment
 * `<plugin>/<version>`. Mirrors codex `validate_plugin_version_segment`
 * (core-plugins/src/store.rs:177-193) so a bundle codex would reject fails
 * closed here rather than producing an unscannable cache entry.
 *
 * @param version - Version string from the plugin manifest.
 * @param sourceLabel - Manifest path, for the error message.
 * @throws {Error} When the version is not a single safe path segment.
 */
function validatePluginVersionSegment(version: string, sourceLabel: string): void {
  if (version === '.' || version === '..' || !/^[A-Za-z0-9._+-]+$/.test(version)) {
    throw new Error(
      `Invalid Codex plugin version segment "${version}" at ${sourceLabel}: ` +
        `only ASCII letters, digits, '.', '+', '_', and '-' are allowed`
    );
  }
}

async function validateCodexMarketplaceManifest(bundlePath: string): Promise<void> {
  const manifestPath = path.join(bundlePath, '.agents', 'plugins', 'marketplace.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Partial<CodexPluginMarketplaceManifest>;

  if (manifest.name !== CODEX_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Invalid Codex marketplace manifest name at ${manifestPath}: expected "${CODEX_PLUGIN_MARKETPLACE}"`
    );
  }
}

async function ensureCodexBundleAvailable(
  marketplacePath: string,
  pluginNames: readonly CodexPluginName[] = CODEX_LAUNCH_PLUGIN_NAMES
): Promise<{
  bundlePath: string;
  pluginPaths: Record<string, string>;
  pluginVersions: Record<string, string>;
}> {
  const bundlePath = resolveCodexBundlePath(marketplacePath);
  const pluginPaths: Record<string, string> = Object.fromEntries(
    pluginNames.map((pluginName) => [pluginName, resolveCodexPluginPath(marketplacePath, pluginName)])
  );
  const pluginVersions: Record<string, string> = {};
  const marketplaceManifestPath = path.join(bundlePath, '.agents', 'plugins', 'marketplace.json');

  await fs.access(bundlePath);
  await fs.access(marketplaceManifestPath);
  await validateCodexMarketplaceManifest(bundlePath);
  for (const pluginName of pluginNames) {
    const pluginPath = pluginPaths[pluginName]!;
    await fs.access(pluginPath);
    const version = await readCodexPluginManifest(pluginPath, pluginName);
    pluginVersions[pluginName] = version;
  }

  return { bundlePath, pluginPaths, pluginVersions };
}

// Matches codex PLUGINS_CACHE_DIR (store.rs:17,40)
const CODEX_PLUGINS_CACHE_DIR = 'plugins/cache';

/**
 * Materializes each bundled plugin into the codex plugin cache under the
 * resolved home, then verifies the load path — without touching the user's
 * config.toml. Enablement is supplied separately by {@link writeCodexProfileConfig}.
 *
 * Each plugin is installed under its own manifest version segment:
 * `<codexHome>/plugins/cache/local/<plugin>/<version>/` (marketplace=`local`).
 * codex's version scanner (`active_plugin_version`, store.rs:70-91) prefers the
 * highest semver when no `local` dir is present, so an extension upgrade lands a
 * new, higher-versioned sibling that supersedes the old one without disturbing
 * it — and a version slot, once published, is never moved or removed, making the
 * post-install verification below race-free under concurrent launches.
 *
 * Errors from staging, copy, manifest validation, or the publish rename
 * propagate — fail closed.
 *
 * @param codexHome - Resolved codex home (`$CODEX_HOME ?? ~/.codex`).
 * @param marketplacePath - Absolute path to the packaged marketplace directory.
 * @param pluginNames - Plugin set to stage into the cache. Defaults to
 *   `CODEX_LAUNCH_PLUGIN_NAMES` (`cards` + `runtime`), preserving launch behavior.
 * @returns Bundle path, source plugin paths, and the on-disk cache load paths.
 */
export async function populateCodexPluginCache(
  codexHome: string,
  marketplacePath: string,
  pluginNames: readonly CodexPluginName[] = CODEX_LAUNCH_PLUGIN_NAMES
): Promise<{
  bundlePath: string;
  pluginPaths: Record<string, string>;
  pluginCachePaths: Record<string, string>;
}> {
  const { bundlePath, pluginPaths, pluginVersions } = await ensureCodexBundleAvailable(marketplacePath, pluginNames);
  const pluginCachePaths: Record<string, string> = {};

  // marketplaceDir = plugins/cache/local/ — ONE LEVEL ABOVE plugin_base_root.
  // Staging dirs are placed here so the version scanner (active_plugin_version,
  // store.rs:70-91) — which reads only <plugin_base_root>/ — never enumerates them.
  const marketplaceDir = path.join(codexHome, CODEX_PLUGINS_CACHE_DIR, CODEX_PLUGIN_MARKETPLACE);
  await fs.mkdir(marketplaceDir, { recursive: true });

  for (const pluginName of pluginNames) {
    const destDir = await installPluginToCache(
      pluginName,
      marketplaceDir,
      pluginPaths[pluginName]!,
      pluginVersions[pluginName]!
    );

    // Verify the manifest at the exact load path — fail closed. An off-by-one in
    // destDir (missing/wrong version segment, wrong marketplace) produces a
    // concrete error here rather than a silent "plugin not installed" at session
    // startup (Q22 primary detection). Race-free: installPluginToCache never
    // moves or removes a live version slot, so no concurrent launch can move this
    // path out from under the read.
    await readCodexPluginManifest(destDir, pluginName);
    pluginCachePaths[pluginName] = destDir;
  }

  return { bundlePath, pluginPaths, pluginCachePaths };
}

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
 * Filename of the content stamp written into each published version slot. Holds
 * the hex digest of the bundle the slot was staged from, so a later launch can
 * tell a byte-for-byte-current slot from a stale one whose declared `version`
 * never moved. A dotfile at the plugin root, it is invisible to codex's manifest
 * read (`.codex-plugin/plugin.json`) and hook-trust hashing (per-command over
 * `hooks/*`), and is excluded from {@link computePluginContentHash} so it never
 * perturbs the digest it records.
 */
export const CODEX_PLUGIN_CONTENT_STAMP = '.cards-content-hash';

/**
 * Computes a stable content digest of a bundled plugin source directory: every
 * file's repo-relative POSIX path and bytes, folded into one SHA-256 in sorted
 * path order so the result is deterministic across platforms and filesystem
 * enumeration order. The {@link CODEX_PLUGIN_CONTENT_STAMP} dotfile is skipped so
 * hashing a previously-staged tree yields the same digest as the pristine source.
 *
 * This is the identity codex cannot compute for a `Local` plugin (it keys purely
 * on the version segment), so the extension must: two builds that leave
 * `plugin.json` `version` untouched but change a hook's bytes produce different
 * digests here, which is what drives the restage below.
 *
 * @param sourceDir - Absolute path to the packaged plugin source directory.
 * @returns Lowercase hex SHA-256 digest of the directory's file contents.
 */
export async function computePluginContentHash(sourceDir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.name !== CODEX_PLUGIN_CONTENT_STAMP) {
          files.push(abs);
        }
      })
    );
  };
  await walk(sourceDir);

  files.sort();
  const hash = createHash('sha256');
  for (const abs of files) {
    const rel = path.relative(sourceDir, abs).split(path.sep).join('/');
    hash.update(rel, 'utf-8');
    hash.update('\0');
    hash.update(await fs.readFile(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Reads the content stamp of an installed version slot.
 *
 * @param versionDir - Absolute path to a published version slot.
 * @returns The stored hex digest, or `null` when the slot or its stamp is absent
 *   (an unstamped slot from a pre-content-address build always reads as `null`,
 *   which forces a restage — fail closed).
 */
export async function readSlotContentStamp(versionDir: string): Promise<string | null> {
  try {
    return (await fs.readFile(path.join(versionDir, CODEX_PLUGIN_CONTENT_STAMP), 'utf-8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Installs one bundled plugin into the cache under its own version segment
 * `<marketplaceDir>/<plugin>/<version>` and returns that load path.
 *
 * Fully-built content is staged in an OS-unique `mkdtemp` dir under
 * `marketplaceDir` (a sibling of the scanned base root, so codex never enumerates
 * it as a version candidate), stamped with the bundle's content digest, validated,
 * then published into the version slot.
 *
 * codex selects a `Local` plugin by the highest-semver *directory name* and reads
 * `plugin.json` `version` only as a display label, so a rebuilt bundle whose
 * version string was not bumped maps to the same slot. To honor the invariant —
 * the executed hook is byte-identical to the current bundle — the slot is
 * content-addressed: when it is absent, or its stamp differs from the current
 * bundle digest, the fresh copy replaces it; when the stamp already matches, the
 * slot is byte-for-byte current and left untouched.
 *
 * Concurrency: launches under one extension build stage identical bytes, so they
 * hit the matching-stamp fast path and never write — the common case stays
 * race-free. The replace path runs only on the first launch after an in-place
 * upgrade that skipped the version bump; it evicts the stale slot and renames the
 * fresh one in, leaving a sub-millisecond window where the slot is absent. A
 * concurrent launch that reads during that window fails and is fixed by relaunch
 * (the same posture the card takes toward already-stranded sessions); a
 * concurrent replacer that races the eviction is reconciled by re-checking the
 * stamp and failing closed on any genuine mismatch.
 *
 * @param pluginName - Bundled plugin name.
 * @param marketplaceDir - `<codexHome>/plugins/cache/local`.
 * @param sourceDir - Packaged plugin source directory.
 * @param version - Validated manifest version used as the cache segment.
 * @returns The load path `<marketplaceDir>/<plugin>/<version>`.
 */
export async function installPluginToCache(
  pluginName: CodexPluginName,
  marketplaceDir: string,
  sourceDir: string,
  version: string
): Promise<string> {
  const baseRoot = path.join(marketplaceDir, pluginName);
  const destVersionDir = path.join(baseRoot, version);
  const contentHash = await computePluginContentHash(sourceDir);

  // Fast path: an existing slot whose stamp matches the current bundle is
  // byte-identical — leave it untouched. No writes, so any number of concurrent
  // launches under the same build converge here without racing.
  if ((await readSlotContentStamp(destVersionDir)) === contentHash) {
    return destVersionDir;
  }

  const staging = await fs.mkdtemp(path.join(marketplaceDir, '.plugin-install-'));
  try {
    const stagedVersionDir = path.join(staging, version);
    await fs.cp(sourceDir, stagedVersionDir, { recursive: true, force: true });

    // Validate the staged bundle BEFORE publishing — fail closed on a bad bundle.
    await readCodexPluginManifest(stagedVersionDir, pluginName);
    // Stamp the staged copy so a future launch can recognize this exact bundle.
    await fs.writeFile(path.join(stagedVersionDir, CODEX_PLUGIN_CONTENT_STAMP), contentHash, 'utf-8');

    await fs.mkdir(baseRoot, { recursive: true });
    await publishVersionSlot(stagedVersionDir, destVersionDir, marketplaceDir, contentHash);
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
 * @param marketplaceDir - `<codexHome>/plugins/cache/local`, for the eviction temp dir.
 * @param contentHash - Digest the staged copy is stamped with.
 */
async function publishVersionSlot(
  stagedVersionDir: string,
  destVersionDir: string,
  marketplaceDir: string,
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
  await replaceVersionSlot(stagedVersionDir, destVersionDir, marketplaceDir, contentHash);
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
 * @param marketplaceDir - `<codexHome>/plugins/cache/local`, parent of the temp dir.
 * @param contentHash - Digest the staged copy is stamped with.
 */
async function replaceVersionSlot(
  stagedVersionDir: string,
  destVersionDir: string,
  marketplaceDir: string,
  contentHash: string
): Promise<void> {
  const evictDir = await fs.mkdtemp(path.join(marketplaceDir, '.plugin-evict-'));
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
 * plugin base root, mirroring codex `remove_old_plugin_versions` (store.rs:333-368).
 * codex's scanner already prefers the highest semver, so older slots are inert;
 * pruning keeps the cache bounded across upgrades.
 *
 * Never fatal, and never removes `keepVersion` or any equal-or-higher version —
 * so it cannot race a concurrent launch into deleting the slot that launch
 * resolved to.
 *
 * @param baseRoot - `<marketplaceDir>/<plugin>`.
 * @param keepVersion - The version just installed; this and any higher are kept.
 */
async function pruneSupersededPluginVersions(baseRoot: string, keepVersion: string): Promise<void> {
  let entries: Dirent<string>[];
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
 * when either side is not a semver triple — matching the intent of codex
 * `compare_plugin_versions` (store.rs:375-381) for our bundle versions.
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

function parseSemverTriple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Profile-v2: plugin enablement lives in a SEPARATE `${CODEX_HOME}/<name>.config.toml`
// User-config layer selected with `--profile <name>`, never in the user's own
// config.toml. Suffix matches codex CONFIG_PROFILE_V2_SUFFIX (core/config/mod.rs:200);
// the name satisfies ProfileV2Name (ASCII alphanumeric + `_`/`-`).
const CODEX_PROFILE_CONFIG_SUFFIX = '.config.toml';
const CODEX_DEFAULT_PROFILE_NAME = 'cards';

/**
 * Writes a Codex profile-v2 config file `${codexHome}/${profileName}.config.toml`,
 * enabling the given plugins via a SEPARATE User-config layer. codex loads this
 * file as a second User layer only when launched with `--profile <profileName>`;
 * the user's own `codex` (no `--profile`) never reads it and the user's
 * `config.toml` is never read-modified-written.
 *
 * Fail-closed pre-check: codex hard-errors a `--profile <profileName>` launch if
 * the base config.toml declares a legacy `profile = "<profileName>"` selector or a
 * `[profiles.<profileName>]` table (config/src/loader/mod.rs:227-247).
 * {@link assertNoLegacyProfileCollision} surfaces that as a clear, actionable error
 * before codex is spawned.
 *
 * Calling with no `options` (or an empty object) preserves the original launch
 * behavior: writes `cards.config.toml` enabling `cards@local` and `runtime@local`.
 *
 * Each enabled plugin that ships a `hooks/hooks.json` in its installed cache dir
 * (supplied via `options.pluginCachePaths`) also contributes `[hooks.state."…"]`
 * trust entries whose `trusted_hash` matches the hash Codex computes for each
 * bundled command hook. Codex therefore reports those hooks as Trusted at
 * discovery — no `/hooks` review interstitial and no broad
 * `--dangerously-bypass-hook-trust` flag. Fail-closed: a plugin without a
 * `hooks.json` (e.g. `cards`) contributes nothing, and only plugins enabled for
 * this profile are seeded — the assistant profile never trusts runtime's hooks.
 *
 * @param codexHome - Resolved codex home (`$CODEX_HOME ?? ~/.codex`).
 * @param options - Optional overrides for profile name and plugin set.
 * @param options.profileName - Profile name written as `<profileName>.config.toml`
 *   and used in the legacy-collision pre-check. Defaults to `'cards'`.
 * @param options.pluginNames - Plugin names to enable in the profile. Defaults to
 *   `CODEX_LAUNCH_PLUGIN_NAMES` (`cards` + `runtime`).
 * @param options.pluginCachePaths - Map of plugin name → installed cache dir (as
 *   returned by {@link populateCodexPluginCache}). Used to locate each enabled
 *   plugin's `hooks/hooks.json` for trust seeding. Omitted entries seed no hooks.
 * @returns Absolute path to the written profile config file.
 */
export async function writeCodexProfileConfig(
  codexHome: string,
  options: {
    profileName?: string;
    pluginNames?: readonly CodexPluginName[];
    pluginCachePaths?: Record<string, string>;
  } = {}
): Promise<string> {
  const profileName = options.profileName ?? CODEX_DEFAULT_PROFILE_NAME;
  const pluginNames = options.pluginNames ?? CODEX_LAUNCH_PLUGIN_NAMES;
  const pluginCachePaths = options.pluginCachePaths ?? {};

  await assertNoLegacyProfileCollision(codexHome, profileName);

  const enablePlugins = pluginNames.map((name) => `${name}@${CODEX_PLUGIN_MARKETPLACE}`);
  const { result } = applyCodexConfig({}, { enablePlugins, featuresPlugins: true });

  const hooksState = await buildEnabledPluginsHooksState(pluginNames, pluginCachePaths);
  if (Object.keys(hooksState).length > 0) {
    const hooks = { ...((result['hooks'] as Record<string, unknown> | undefined) ?? {}) };
    hooks['state'] = { ...((hooks['state'] as Record<string, unknown> | undefined) ?? {}), ...hooksState };
    result['hooks'] = hooks;
  }

  const profilePath = path.join(codexHome, `${profileName}${CODEX_PROFILE_CONFIG_SUFFIX}`);
  await fs.writeFile(profilePath, `${stringifyToml(result)}\n`, 'utf-8');
  return profilePath;
}

/**
 * Collects `hooks.state` trust entries for every enabled plugin that ships a
 * `hooks/hooks.json` in its installed cache directory.
 *
 * For each plugin name, resolves `<cacheDir>/hooks/hooks.json`. A plugin with no
 * cache path or no `hooks.json` on disk contributes nothing (normal — `cards`
 * has no hooks). Any other read or parse error propagates (fail closed): a
 * present-but-unreadable bundle hooks file must not silently launch a session
 * whose hooks fall back to the review flow under a false sense of trust.
 *
 * @param pluginNames - Plugin names enabled for this profile.
 * @param pluginCachePaths - Map of plugin name → installed cache dir.
 * @returns Merged `<hook_key>` → `{ trusted_hash }` entries across all plugins.
 */
async function buildEnabledPluginsHooksState(
  pluginNames: readonly CodexPluginName[],
  pluginCachePaths: Record<string, string>
): Promise<Record<string, HookTrustEntry>> {
  const state: Record<string, HookTrustEntry> = {};

  for (const name of pluginNames) {
    const cacheDir = pluginCachePaths[name];
    if (cacheDir === undefined) {
      continue;
    }

    const hooksJsonPath = path.join(cacheDir, 'hooks', 'hooks.json');
    let raw: string;
    try {
      raw = await fs.readFile(hooksJsonPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    let json: HooksJson;
    try {
      json = JSON.parse(raw) as HooksJson;
    } catch (error) {
      throw new Error(
        `Corrupt Cards bundle: Codex hooks manifest at ${hooksJsonPath} is not valid JSON ` +
          `(${(error as Error).message})`,
        { cause: error }
      );
    }
    Object.assign(state, buildPluginHooksState(`${name}@${CODEX_PLUGIN_MARKETPLACE}`, 'hooks/hooks.json', json));
  }

  return state;
}

/**
 * Throws a clear error when the user's base `config.toml` would collide with the
 * given profile name — the one case where codex refuses a `--profile` launch.
 *
 * Best-effort: when `config.toml` is absent or unparseable, codex remains the
 * authority (it still fails closed on a genuine collision) and we proceed rather
 * than block a launch on our own parse disagreement.
 *
 * @param codexHome - Resolved codex home holding the user's `config.toml`.
 * @param profileName - Profile name to check for a legacy collision.
 */
async function assertNoLegacyProfileCollision(codexHome: string, profileName: string): Promise<void> {
  const configPath = path.join(codexHome, 'config.toml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const legacySelector = parsed['profile'] === profileName;
  const profilesTable = parsed['profiles'];
  const legacyTable =
    typeof profilesTable === 'object' &&
    profilesTable !== null &&
    !Array.isArray(profilesTable) &&
    Object.hasOwn(profilesTable, profileName);

  if (legacySelector || legacyTable) {
    throw new Error(
      `Cannot launch codex with the Cards profile "${profileName}": ${configPath} declares a legacy ` +
        `profile = "${profileName}" selector or a [profiles.${profileName}] table, which codex ` +
        `refuses to combine with --profile. Rename or remove that legacy profile to launch Cards sessions.`
    );
  }
}

/**
 * Formats a `developer_instructions` value as a Codex `-c key=value` override.
 *
 * Codex parses the right-hand side of a `-c` override as TOML
 * ({@link https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/config_override.rs}).
 * Using `smol-toml`'s stringifier guarantees that multi-line content,
 * embedded quotes, and other special characters are safely encoded as a TOML
 * basic string.
 *
 * @param value - The developer-instructions content to inject.
 * @returns A `developer_instructions = "..."` assignment suitable for `-c`.
 */
export function formatDeveloperInstructionsOverride(value: string): string {
  return stringifyToml({ developer_instructions: value }).trimEnd();
}

// ============================================================================
// Developer instructions
// ============================================================================

/**
 * Reads the card repository's `AGENTS.md` instruction file.
 *
 * The card-repo `AGENTS.md` is provisioned as a symlink to a central shared
 * instruction file (`HybridStore.provisionScaffold`) and is the canonical card
 * repository reference. Codex never auto-discovers it: project-doc discovery is
 * anchored at the workspace cwd (`--cd`) and bounded upward by the project-root
 * marker, so the card repo — a separate tree reachable only via `--add-dir` — is
 * never on the search path. We read it here and fold it into the additive
 * `developer_instructions` channel instead (see {@link spawnCodexSession}).
 *
 * Fail-closed: a missing or unreadable file aborts the session as a
 * {@link CardRepoAccessError}, consistent with {@link buildCardBlock}, rather
 * than launching Codex without the card repository's guidance.
 *
 * @param cardRepoPath - Absolute path to the card repository directory.
 * @returns The trimmed `AGENTS.md` contents.
 * @throws {CardRepoAccessError} When the file cannot be read.
 */
export function readCardRepoAgentsMd(cardRepoPath: string): string {
  try {
    return readFileSync(path.join(cardRepoPath, 'AGENTS.md'), 'utf-8').trim();
  } catch (error) {
    throw new CardRepoAccessError(cardRepoPath, error);
  }
}

/**
 * Joins instruction fragments into a single `developer_instructions` value,
 * dropping empty fragments and separating the rest with a blank line.
 *
 * @param fragments - Ordered instruction fragments (card-repo `AGENTS.md` first,
 *   then any caller-supplied session guidance).
 * @returns The combined value, or `undefined` when every fragment is empty.
 */
export function composeDeveloperInstructions(fragments: ReadonlyArray<string | undefined>): string | undefined {
  const nonEmpty = fragments
    .map((fragment) => fragment?.trim())
    .filter((fragment): fragment is string => fragment !== undefined && fragment.length > 0);
  return nonEmpty.length > 0 ? nonEmpty.join('\n\n') : undefined;
}

/**
 * Builds the CLI argument list for the `codex` process.
 *
 * @param prompt - Prompt passed to Codex.
 * @param workspacePath - Card worktree path used as the Codex workspace root.
 * @param cardRepoPath - Additional writable directory for the card repo.
 * @param appendSystemPrompt - Content injected as `developer_instructions`
 *   via `-c`. This is the Codex analog of Claude's `--append-system-prompt`.
 * @param executionMode - Dispatch mode: `'interactive'` boots the TUI,
 *   `'background'` runs the non-interactive `codex exec` command.
 * @returns Array of CLI arguments.
 */
export function buildCodexArgs(
  prompt: string | undefined,
  workspacePath: string,
  cardRepoPath: string,
  appendSystemPrompt: string | undefined,
  executionMode: 'interactive' | 'background'
): string[] {
  // Enable the bundled plugins via the Cards profile-v2 User-config layer
  // (`${CODEX_HOME}/cards.config.toml`, written by writeCodexProfileConfig).
  // codex loads that file only under `--profile cards`, so the user's own
  // `config.toml` is never touched and their plain `codex` sees no Cards plugins.
  const args = [
    ...(executionMode === 'background' ? ['exec'] : []),
    '--dangerously-bypass-approvals-and-sandbox',
    '--profile',
    CODEX_DEFAULT_PROFILE_NAME,
    '--cd',
    workspacePath,
    '--add-dir',
    cardRepoPath
  ];

  if (appendSystemPrompt !== undefined && appendSystemPrompt.length > 0) {
    args.push('-c', formatDeveloperInstructionsOverride(appendSystemPrompt));
  }

  if (prompt !== undefined) {
    args.push(prompt);
  }

  return args;
}

/**
 * Spawns a `codex` CLI session with worktree lifecycle and prompt-based skill guidance.
 *
 * @param input - Parsed action input from the environment.
 * @param context - Action context providing logger and lifecycle hooks.
 * @param options - Session-specific parameters.
 */
export async function spawnCodexSession(
  input: ActionInput,
  context: ActionContext,
  options: CodexSessionOptions
): Promise<void> {
  const { prompt: rawPrompt, appendSystemPrompt } = options;
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

  const codexHome = resolveDefaultCodexHome();
  const { bundlePath, pluginPaths, pluginCachePaths } = await populateCodexPluginCache(codexHome, marketplacePath);
  context.logger.info('Populated Codex plugin cache', { codexHome, bundlePath, pluginPaths, pluginCachePaths });

  const profilePath = await writeCodexProfileConfig(codexHome, { pluginCachePaths });
  context.logger.info('Wrote Codex plugin-enablement profile', { codexHome, profilePath });

  // Card/workspace context (env, card metadata, repo log, workspace log) is
  // injected by the runtime plugin's SessionStart hook as additionalContext, so
  // the prompt is passed through unmodified here.

  // Codex cannot auto-discover the card-repo AGENTS.md (it lives outside the
  // workspace cwd→project-root search path), so fold it into developer_instructions
  // ahead of any caller-supplied session guidance. This loads additively — it does
  // not displace the global ~/.codex/AGENTS.md or a <workspace>/AGENTS.md.
  const cardRepoAgentsMd = readCardRepoAgentsMd(input.cardRepoPath);
  const developerInstructions = composeDeveloperInstructions([cardRepoAgentsMd, appendSystemPrompt]);
  const args = buildCodexArgs(rawPrompt, cwd, input.cardRepoPath, developerInstructions, input.executionMode);
  const isInteractive = input.executionMode === 'interactive';

  const child: ChildProcess = spawnAgentCli('codex', args, {
    cwd,
    detached: process.platform !== 'win32',
    // `codex exec` is the CLI's non-interactive automation surface. Background
    // actions have no terminal reader, so discard stdin/stdout and retain stderr
    // for progress and diagnostics; interactive sessions keep direct terminal
    // control. Hide the console-less Windows cross-spawn shell hop.
    stdio: isInteractive ? 'inherit' : ['ignore', 'ignore', 'pipe'],
    ...(isInteractive ? {} : { windowsHide: true }),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      WORKSPACE_PATH: cwd,
      BASE_BRANCH: baseBranch,
      PARENT_BRANCH: parentBranch,
      WORKSPACE_BRANCH: branchName,
      ...(options.suppressExitWhenDone ? { [CARDS_ENV_VARS.EXIT_WHEN_DONE]: 'false' } : {})
    }
  });

  const termination = createCodexTerminationController(child, {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 5_000
  });

  context.onCancel(async () => {
    context.logger.info(`${input.actionName} action cancelled, terminating codex`);
    const result = await termination.terminate('cancel');
    context.logger.info(`${input.actionName} cancellation termination completed`, { result });
  });

  context.onAgentShutdown(async () => {
    context.logger.info(`${input.actionName} agent signalled shutdown, terminating codex`);
    const result = await termination.terminate('shutdown');
    context.logger.info(`${input.actionName} shutdown termination completed`, { result });
    return result;
  });

  if (!isInteractive) {
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        context.logger.warn(text);
      }
    });
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    // A spawn failure emits `error` without guaranteeing `close`. Resolve the
    // lifecycle wait so a background action cannot hang indefinitely.
    child.on('error', (error) => {
      context.logger.error('Failed to spawn codex', {
        error: error instanceof Error ? error.message : String(error)
      });
      resolve(null);
    });
    child.on('close', resolve);
  });

  context.logger.info(`${input.actionName} action completed`, { exitCode });

  // Settle the card's status (active → needs_review) before the watcher can
  // read it: the sweep's first gate is the on-disk status, which otherwise
  // races this exit path from a separate process. See
  // Interactive sessions hand cleanup to a detached watcher so their terminal
  // closes immediately. Background actions have no terminal to release, so run
  // the same sweep inline before reporting completion.
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

/**
 * Native Antigravity workspace-trust preparation for Cards action launches.
 *
 * ### Why this exists
 * `agy` refuses to run in a directory it has not been told to trust: it raises
 * a native folder-trust dialog ("Do you trust the contents of this project?")
 * before the action prompt is ever reached. The user's approved directories
 * live in `trustedWorkspaces` inside the CLI's own settings file, and a Cards
 * action runs in a *linked worktree* — a path the user never approved, even
 * when the project it belongs to is approved and its repository identity is
 * exactly the approved project's.
 *
 * Cards therefore carries the already-granted consent into the exact action
 * checkout before spawning `agy`. What is carried is only the checkout whose
 * relationship to an already trusted project is established by *repository
 * identity*: `git rev-parse --git-common-dir`, resolved to an absolute
 * physical path, must be equal for the checkout and for an existing trust
 * entry (`--git-dir` is per-worktree and says nothing about which repository a
 * directory belongs to). Path prefixes, parent directories, sibling
 * repositories, and remote URLs establish nothing.
 *
 * ### Boundaries
 * This module never invents consent (a profile that records no trust yields
 * `no-established-consent`, and a missing settings file is never created) and
 * never widens tool permissions: every key other than `trustedWorkspaces` is
 * read-only here, so `toolPermission`, `dangerously_skip_permissions`,
 * `browser_policy`, `execution_policy`, `model`, and `allowNonWorkspaceAccess`
 * keep whatever value the user set.
 *
 * Updates use the staged-write pattern shared with the OpenCode launcher:
 * serialize deterministically, skip the write entirely when the bytes already
 * match, stage inside the same directory, then `rename` onto the target so a
 * reader never observes a partial profile. Concurrent launchers merge
 * optimistically and re-verify their own entry, retrying bounded times.
 *
 * @summary Native Antigravity workspace-trust preparation for action launches
 * @module lib/antigravity-workspace-trust
 */

import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileNoWindowAsync } from '@cards.management/sdk/bin/child-process';
import { errorMessage } from './claude-session.js';

/**
 * Settings key holding the directories the user has approved in the native
 * Antigravity profile.
 */
const TRUSTED_WORKSPACES_KEY = 'trustedWorkspaces';

/** Bounded optimistic-merge attempts before a concurrent writer is reported. */
const MAX_WRITE_ATTEMPTS = 5;

/** Base backoff between optimistic-merge attempts, in milliseconds. */
const RETRY_BACKOFF_MS = 10;

/**
 * Resolves the native Antigravity profile directory.
 *
 * Mirrors the convention used by the other launchers' home resolvers
 * (`ANTIGRAVITY_HOME` first, then the CLI's own default location).
 *
 * @returns Absolute path to the native Antigravity profile directory.
 */
export function resolveDefaultAntigravityHome(): string {
  return process.env['ANTIGRAVITY_HOME'] ?? join(homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Resolves the native Antigravity settings file.
 *
 * @returns Absolute path to the native Antigravity settings file.
 */
export function resolveAntigravitySettingsPath(): string {
  return join(resolveDefaultAntigravityHome(), 'settings.json');
}

/**
 * One workspace-trust preparation request.
 */
export interface AntigravityTrustRequest {
  /** Action checkout the session will run in (may be a symlinked/logical spelling). */
  checkoutPath: string;
  /**
   * Main repository root already authorized by the user. Consent itself is
   * decided by repository identity against the recorded trust entries — never
   * by this path — so the claimed root is only used to examine its own entry
   * first, which is the common case.
   */
  projectRoot: string;
  /** Native settings file to update. */
  settingsPath: string;
}

/**
 * Outcome of one workspace-trust preparation.
 *
 * `no-established-consent` carries a short reason token: `'settings-missing'`
 * when the profile records no trust at all, and
 * `'repository-identity-untrusted'` when the profile exists but no recorded
 * entry shares the checkout's repository identity.
 */
export type AntigravityTrustOutcome =
  | { kind: 'prepared'; trustedPath: string }
  | { kind: 'already-trusted'; trustedPath: string }
  | { kind: 'no-established-consent'; reason: string };

/**
 * Thrown when the settings file exists but cannot be trusted or safely updated.
 *
 * The profile is never replaced or truncated on failure: a malformed document,
 * an unexpected shape, an unreadable file, or an exhausted optimistic merge all
 * abort the launch with the profile exactly as it was found.
 */
export class AntigravityTrustError extends Error {
  override readonly name = 'AntigravityTrustError';
}

/** A parsed settings document plus its validated trust entries. */
interface ParsedSettings {
  /** Complete settings document, preserving every unrelated key. */
  document: Record<string, unknown>;
  /** Validated `trustedWorkspaces` entries, in file order. */
  entries: string[];
}

/**
 * Reads the settings file as text.
 *
 * @param settingsPath - Native settings file to read.
 * @returns The file's bytes, or `undefined` when it does not exist.
 * @throws {AntigravityTrustError} When the file exists but cannot be read.
 */
async function readSettingsFile(settingsPath: string): Promise<string | undefined> {
  try {
    return await readFile(settingsPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AntigravityTrustError(
      `Antigravity settings file ${settingsPath} could not be read: ${errorMessage(error)}`
    );
  }
}

/**
 * Parses and validates a settings document.
 *
 * Fails closed on anything the merge could not faithfully round-trip: a
 * document that is not JSON, not an object, or whose `trustedWorkspaces` is not
 * an array of strings is refused rather than rewritten.
 *
 * A document that simply does not mention `trustedWorkspaces` is a profile that
 * records no trust — the user configured the CLI but never approved a folder —
 * and is read as an empty list rather than refused. That is the state the
 * native folder-trust dialog belongs to, so it must reach the launch as
 * `no-established-consent` (and no launch ever writes the key before consent
 * exists, because an empty list can match no repository identity).
 *
 * @param raw - Raw settings file bytes.
 * @param settingsPath - Settings file path, for failure messages.
 * @returns The parsed document and its validated trust entries.
 * @throws {AntigravityTrustError} When the document cannot be trusted as a settings file.
 */
function parseSettingsDocument(raw: string, settingsPath: string): ParsedSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AntigravityTrustError(
      `Antigravity settings file ${settingsPath} is not valid JSON: ${errorMessage(error)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AntigravityTrustError(
      `Antigravity settings file ${settingsPath} must hold a JSON object at the top level`
    );
  }

  const document = parsed as Record<string, unknown>;
  const entries = document[TRUSTED_WORKSPACES_KEY];
  if (entries === undefined) {
    return { document, entries: [] };
  }
  if (!Array.isArray(entries)) {
    throw new AntigravityTrustError(
      `Antigravity settings file ${settingsPath} must hold a "${TRUSTED_WORKSPACES_KEY}" array of workspace paths`
    );
  }
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new AntigravityTrustError(
        `Antigravity settings file ${settingsPath} holds a non-string "${TRUSTED_WORKSPACES_KEY}" entry; ` +
          'refusing to rewrite the profile'
      );
    }
  }

  return { document, entries: entries as string[] };
}

/**
 * Detects the JSON indentation a settings file already uses.
 *
 * The profile is a user-owned document, so a rewrite keeps its prevailing
 * shape: a single-line file stays compact, an indented file keeps its own
 * indentation unit (2 spaces when a multi-line file carries no indentation).
 *
 * @param raw - Raw settings file bytes.
 * @returns The indentation unit, or `undefined` for a compact document.
 */
function detectSettingsIndent(raw: string): string | undefined {
  if (!raw.includes('\n')) return undefined;
  return /\n([ \t]+)\S/.exec(raw)?.[1] ?? '  ';
}

/**
 * Serializes a settings document the way the file already presents itself.
 *
 * @param document - Complete settings document to serialize.
 * @param template - Raw bytes of the document being replaced.
 * @returns Serialized document bytes, preserving the template's shape.
 */
function serializeSettings(document: Record<string, unknown>, template: string): string {
  const indent = detectSettingsIndent(template);
  const text = indent === undefined ? JSON.stringify(document) : JSON.stringify(document, null, indent);
  return template.endsWith('\n') ? `${text}\n` : text;
}

/**
 * Resolves a path to its physical spelling.
 *
 * @param path - Path to resolve.
 * @returns The physical path, or `undefined` when it cannot be resolved.
 */
async function resolvePhysicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the repository identity shared by every checkout of one repository:
 * the physical `git rev-parse --git-common-dir`.
 *
 * `--git-common-dir` is the repository-wide answer, unlike the per-worktree
 * `--git-dir`, which is why linked worktrees of an approved project share this
 * identity while a sibling repository never does. Any failure — not a
 * repository, git absent, a broken checkout — simply answers `undefined`, which
 * establishes no consent.
 *
 * @param directory - Directory to interrogate.
 * @returns Physical path of the repository's common directory, or `undefined`.
 */
async function resolveGitCommonDir(directory: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileNoWindowAsync('git', ['rev-parse', '--git-common-dir'], { cwd: directory });
    const reported = stdout.trim();
    if (reported.length === 0) return undefined;
    // A main checkout reports the relative `.git`; a linked worktree reports an
    // absolute path. Both are resolved against the directory git ran in.
    return await realpath(resolve(directory, reported));
  } catch {
    return undefined;
  }
}

/**
 * Orders trust entries so the claimed project root is examined first.
 *
 * Ordering only — the outcome is the same whichever entry establishes consent,
 * but the common case (the project root itself is trusted) then costs a single
 * repository-identity lookup.
 *
 * @param entries - Recorded trust entries, in file order.
 * @param projectRoot - Main repository root the launch claims.
 * @returns The same entries, with the claimed project root moved to the front.
 */
function orderEntriesForConsent(entries: readonly string[], projectRoot: string): string[] {
  const index = entries.indexOf(projectRoot);
  if (index <= 0) return [...entries];
  return [entries[index] as string, ...entries.slice(0, index), ...entries.slice(index + 1)];
}

/**
 * Checks whether one of the recorded entries is the physical path itself,
 * counting logical/physical aliases of the same directory as the same entry.
 *
 * @param entries - Recorded trust entries.
 * @param physicalPath - Physical checkout path being recorded.
 * @returns True when the path is already recorded.
 */
async function containsPhysicalPath(entries: readonly string[], physicalPath: string): Promise<boolean> {
  for (const entry of entries) {
    if (entry === physicalPath) return true;
    if ((await resolvePhysicalPath(entry)) === physicalPath) return true;
  }
  return false;
}

/**
 * Writes serialized settings atomically, skipping the write when the bytes on
 * disk already match.
 *
 * Mirrors the OpenCode launcher's staged write: stage inside the target
 * directory so the rename stays on one filesystem, and remove the staging
 * directory on every path. The last read before the rename is the merge's
 * staleness check — `rename` is unconditional, so replacing a profile that no
 * longer holds the bytes the merge was computed from would silently drop a
 * concurrent launcher's addition; refusing to write lets the caller re-merge
 * from those bytes instead.
 *
 * @param settingsPath - Settings file to replace.
 * @param serialized - Exact bytes the settings file should hold.
 * @param baseRaw - Bytes the serialized document was merged from.
 * @returns True when the settings file holds `serialized`, false when a
 *   concurrent writer changed the base first and the merge must be redone.
 */
async function writeSettingsAtomically(settingsPath: string, serialized: string, baseRaw: string): Promise<boolean> {
  if (baseRaw === serialized) return true;

  const directory = dirname(settingsPath);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.antigravity-trust-'));
  try {
    const stagedPath = join(staging, 'settings.json');
    await writeFile(stagedPath, serialized, 'utf-8');
    if ((await readSettingsFile(settingsPath)) !== baseRaw) return false;
    await rename(stagedPath, settingsPath);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}

/**
 * Waits out one optimistic-merge backoff before the next attempt.
 *
 * @param attempt - One-based attempt number that just failed.
 */
async function backoff(attempt: number): Promise<void> {
  await new Promise((settle) => setTimeout(settle, RETRY_BACKOFF_MS * attempt));
}

/**
 * Merges one checkout into `trustedWorkspaces` with a bounded optimistic
 * merge, so a parallel launcher's addition is never silently dropped.
 *
 * Each attempt reads the profile as it is now, appends the checkout, writes it
 * atomically, and re-reads to confirm the entry survived; a writer that was
 * clobbered retries the whole merge (a bounded number of times, with a small
 * backoff) instead of reporting a trust state it did not achieve. An attempt
 * whose base was replaced before its rename re-merges from the newer bytes
 * rather than overwriting them, so a parallel launcher's entry survives even
 * when both writers prepared from the same document. Entries other writers
 * added in the meantime are preserved — the merge always starts from the bytes
 * on disk, never from the stale document this call first read.
 *
 * @param settingsPath - Settings file to update.
 * @param trustedPath - Physical checkout path to record.
 * @returns The prepared outcome.
 * @throws {AntigravityTrustError} When the profile disappears mid-merge, or when
 *   concurrent writers keep replacing the entry after the bounded attempts.
 */
async function mergeTrustedPath(settingsPath: string, trustedPath: string): Promise<AntigravityTrustOutcome> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const raw = await readSettingsFile(settingsPath);
    if (raw === undefined) {
      throw new AntigravityTrustError(
        `Antigravity settings file ${settingsPath} disappeared before its workspace trust could be recorded`
      );
    }

    const { document, entries } = parseSettingsDocument(raw, settingsPath);
    if (await containsPhysicalPath(entries, trustedPath)) {
      // A concurrent launcher recorded this checkout while we prepared: the
      // entry is in place, so no write is needed.
      return { kind: 'prepared', trustedPath };
    }

    const written = await writeSettingsAtomically(
      settingsPath,
      serializeSettings({ ...document, [TRUSTED_WORKSPACES_KEY]: [...entries, trustedPath] }, raw),
      raw
    );
    if (!written) {
      await backoff(attempt);
      continue;
    }

    const verifiedRaw = await readSettingsFile(settingsPath);
    if (verifiedRaw !== undefined) {
      const verified = parseSettingsDocument(verifiedRaw, settingsPath);
      if (await containsPhysicalPath(verified.entries, trustedPath)) {
        return { kind: 'prepared', trustedPath };
      }
    }

    await backoff(attempt);
  }

  throw new AntigravityTrustError(
    `Antigravity settings file ${settingsPath} could not record workspace trust for ${trustedPath}: ` +
      `concurrent writers replaced the entry after ${MAX_WRITE_ATTEMPTS} attempts`
  );
}

/**
 * Prepares native Antigravity workspace trust for one action checkout.
 *
 * Consent is carried only when the checkout's repository identity (physical
 * `git rev-parse --git-common-dir`) matches an existing trust entry's, and the
 * recorded path is always the checkout's physical spelling — the spelling
 * `agy` itself records. A missing profile yields `no-established-consent`
 * rather than a new profile, so a launch never creates trust the user has not
 * granted.
 *
 * @param request - Checkout, claimed project root, and native settings file.
 * @returns How the checkout's trust stands after preparation.
 * @throws {AntigravityTrustError} When the profile exists but cannot be trusted
 *   or safely updated; the profile is left untouched in that case.
 */
export async function prepareAntigravityWorkspaceTrust(
  request: AntigravityTrustRequest
): Promise<AntigravityTrustOutcome> {
  const { checkoutPath, projectRoot, settingsPath } = request;

  // Resolve before deciding anything: what gets recorded, and what `agy` is
  // spawned with, is the physical path — logical spellings (a symlinked
  // worktree root) must not produce a second, unusable trust entry.
  const trustedPath = await realpath(checkoutPath);

  const raw = await readSettingsFile(settingsPath);
  if (raw === undefined) {
    return { kind: 'no-established-consent', reason: 'settings-missing' };
  }
  const { entries } = parseSettingsDocument(raw, settingsPath);

  const checkoutCommonDir = await resolveGitCommonDir(trustedPath);
  if (checkoutCommonDir === undefined) {
    return { kind: 'no-established-consent', reason: 'repository-identity-untrusted' };
  }

  let consentEstablished = false;
  for (const entry of orderEntriesForConsent(entries, projectRoot)) {
    const entryPhysical = entry === trustedPath ? trustedPath : await resolvePhysicalPath(entry);
    if (entryPhysical === undefined) continue;
    if ((await resolveGitCommonDir(entryPhysical)) === checkoutCommonDir) {
      consentEstablished = true;
      break;
    }
  }
  if (!consentEstablished) {
    return { kind: 'no-established-consent', reason: 'repository-identity-untrusted' };
  }

  if (await containsPhysicalPath(entries, trustedPath)) {
    return { kind: 'already-trusted', trustedPath };
  }

  return await mergeTrustedPath(settingsPath, trustedPath);
}

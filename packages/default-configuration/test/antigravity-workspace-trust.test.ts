/**
 * Verifies the Antigravity workspace-trust preparation that carries an already
 * authorized project's folder trust into the exact action checkout, and that
 * the preparation never widens, invents, or clobbers native profile trust.
 *
 * The launcher-level reproduction drives the real {@link spawnAntigravitySession}
 * against a real linked git worktree and a temporary Antigravity profile
 * (`ANTIGRAVITY_HOME`): without trust preparation the profile's
 * `trustedWorkspaces` never gains the checkout `agy` is spawned into, which is
 * exactly the state that makes `agy` raise its native folder-trust dialog for
 * every freshly created card worktree.
 *
 * Only the client/worktree/spawn seams are stubbed (mirroring
 * `antigravity-branches.test.ts`); settings reads/writes, path resolution, and
 * the fixture repositories are real filesystem and git I/O under a temp
 * directory, so the profile bytes the assertions inspect are the bytes the
 * launcher produced.
 *
 * Beyond the launcher-level reproduction, the module's own contract is checked
 * directly against injected `settingsPath`s: physical-path recording and
 * idempotency, symlinked spellings, preservation of unrelated keys and entry
 * order, concurrent preparations, fail-closed refusal of malformed documents,
 * and consent that repository identity alone can establish. Rename-based atomic
 * writes replace the target's inode, so an unchanged inode is positive evidence
 * that a case performed no write at all.
 *
 * @summary Tests Antigravity workspace-trust preparation before launch
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ActionContext, type ActionInput, Logger } from '@cards.management/sdk/config';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntigravitySessionFailureError, spawnAntigravitySession } from '../src/lib/antigravity-session.js';
import {
  AntigravityTrustError,
  type AntigravityTrustOutcome,
  type AntigravityTrustRequest,
  prepareAntigravityWorkspaceTrust,
  resolveAntigravitySettingsPath,
  resolveDefaultAntigravityHome
} from '../src/lib/antigravity-workspace-trust.js';

vi.mock('../src/lib/antigravity-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/antigravity-termination.js')>();
  const { createSyntheticProcessTreeAuthority } = await import('./helpers/process-tree-authority.js');
  return {
    ...actual,
    createAntigravityTerminationController: (
      child: Parameters<typeof actual.createAntigravityTerminationController>[0],
      options: Parameters<typeof actual.createAntigravityTerminationController>[1]
    ) =>
      actual.createAntigravityTerminationController(child, {
        ...options,
        authority: createSyntheticProcessTreeAuthority()
      })
  };
});

vi.mock('cross-spawn', async () => {
  // spawnAgentCli routes the agent launch through cross-spawn; forward it to the
  // mocked node:child_process.spawn so spawn('agy', ...) assertions hold on
  // every platform (cross-spawn would otherwise rewrite the call into a cmd.exe
  // invocation on win32 and bypass the node:child_process mock).
  const cp = await import('node:child_process');
  return { default: cp.spawn };
});

vi.mock('node:child_process', async (importOriginal) => {
  // Only the agent-launch seam is stubbed: every other child process (the real
  // `git` invocations that drive fixture worktrees and repository-identity
  // resolution) must keep running for real, so this mock forwards `spawn` to
  // the platform implementation by default.
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: readonly string[], options: SpawnOptions) =>
      actual.spawn(command, args as string[], options)
    )
  };
});

vi.mock('@cards.management/sdk/worktree', () => ({
  createWorktree: vi.fn(),
  checkWorktreeExists: vi.fn(),
  findGitRoots: vi.fn()
}));

vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  createWorktreeForCard: vi.fn()
}));

vi.mock('@cards.management/sdk/bin/process-utils', () => ({
  readCardStatus: vi.fn()
}));

vi.mock('@cards.management/sdk/transcript-sync', () => ({
  finalizePersistedSqlitePollSession: vi.fn()
}));

vi.mock('../src/lib/branch-cleanup-watcher.js', () => ({
  spawnBranchCleanupWatcher: vi.fn()
}));

/** Agent id the Antigravity launch paths are bound to. */
const AGENT = 'antigravity-cli';

/** Branch the fixture worktree is created on. */
const WORKTREE_BRANCH = 'cards/card-123/1';

/** Prompt the Cards launch action passes to the Antigravity launcher. */
const LAUNCH_PROMPT = 'Load the `runtime:card` skill and follow the `<routing-instructions>`.';

const originalFetch = globalThis.fetch;

/** Root of the per-test temp scratch directory holding every fixture. */
let scratchDir: string;

/** Fixture project repository acting as the user's already authorized workspace. */
let workspace: TestGitWorkspace;

/** Physical path of the fixture project root. */
let repoRoot: string;

/** Physical path of the fixture linked worktree the action runs in. */
let checkoutPath: string;

/** Temporary Antigravity profile directory (`ANTIGRAVITY_HOME`). */
let antigravityHome: string;

/** Temporary Antigravity settings file. */
let settingsPath: string;

/** Temporary Cards config directory (`CARDS_HOME`) receiving lifecycle markers. */
let cardsHome: string;

/** Every `agy` spawn the launcher performed during the current test. */
const agySpawns: SpawnedAgy[] = [];

/** Additional fixture repositories created by a test, destroyed with the scratch directory. */
const extraWorkspaces: TestGitWorkspace[] = [];

/**
 * Encodes a grant payload the way the extension's single writer helper does:
 * base64url-encoded JSON.
 *
 * @param grant - Grant payload to encode.
 * @returns The base64url-encoded envelope.
 */
function encodeGrant(grant: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(grant), 'utf-8').toString('base64url');
}

/**
 * Builds a valid launch grant bound to `antigravity-cli` with a future expiry.
 *
 * @param overrides - Field overrides merged over the valid payload.
 * @returns The base64url-encoded grant envelope.
 */
function validGrant(overrides: Record<string, unknown> = {}): string {
  return encodeGrant({
    v: 1,
    agent: AGENT,
    issuedAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    probeFingerprint: 'probe-fingerprint-1',
    ...overrides
  });
}

/**
 * Builds a mock child with EventEmitter stdio so launcher drains and close
 * events can be driven deterministically without spawning `agy`.
 *
 * @returns A ChildProcess-shaped mock with event-driven stdio.
 */
function createMockChild(): ChildProcess {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    pid: 12345,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
      return true;
    }
  } as unknown as ChildProcess;
}

/**
 * Builds the action context the launcher is driven with.
 *
 * @returns An ActionContext with a real logger and recording lifecycle hooks.
 */
function createMockContext(): ActionContext {
  return {
    reportWorktreeAssignment: vi.fn().mockResolvedValue(undefined),
    logger: new Logger(),
    cwd: process.cwd(),
    onCancel: vi.fn(),
    onSwitchToInteractive: vi.fn()
  };
}

/**
 * Builds the action input for the fixture card.
 *
 * @param overrides - Input field overrides.
 * @returns Action input pointing at the fixture project and card repository.
 */
function baseInput(overrides: Partial<ActionInput> = {}): ActionInput {
  return {
    executionId: 'execution-test',
    worktreeDirective: { kind: 'reuse' },
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    repoRoot,
    cardRepoPath: join(scratchDir, 'card-repo'),
    configPath: join(scratchDir, 'config.json'),
    extensionPath: '/test/extension',
    codingAgent: AGENT,
    ...overrides
  };
}

/**
 * Writes the temporary Antigravity profile's settings document.
 *
 * @param document - Complete settings document to serialize as pretty JSON.
 * @returns Resolves once the profile file holds the serialized document.
 */
async function writeSettings(document: Record<string, unknown>): Promise<void> {
  await writeFile(settingsPath, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
}

/**
 * Reads `trustedWorkspaces` out of the temporary profile's settings file.
 *
 * @returns The recorded trust entries, in file order.
 */
async function readTrustedWorkspaces(): Promise<string[]> {
  const parsed = JSON.parse(await readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
  return parsed['trustedWorkspaces'] as string[];
}

/**
 * Reads the temporary profile's settings file as raw bytes.
 *
 * @returns The exact file contents.
 */
async function readSettingsText(): Promise<string> {
  return await readFile(settingsPath, 'utf-8');
}

/**
 * Reads a file's inode number.
 *
 * The atomic write replaces its target by renaming a staged file over it, so
 * every real write yields a new inode: an unchanged inode is positive evidence
 * that a case performed no write at all.
 *
 * @param path - File to stat.
 * @returns The file's inode number.
 */
async function inodeOf(path: string): Promise<bigint> {
  return (await stat(path)).ino;
}

/**
 * Creates a directory alias (a symlinked spelling) for a fixture path.
 *
 * @param target - Directory the alias resolves to.
 * @param name - Alias name inside the temp scratch directory.
 * @returns Absolute path of the alias.
 */
async function createAlias(target: string, name: string): Promise<string> {
  const aliasPath = join(scratchDir, name);
  await symlink(target, aliasPath, 'dir');
  return aliasPath;
}

/**
 * Creates an unrelated fixture repository, cleaned up with the scratch directory.
 *
 * @returns Physical path of the new repository root.
 */
async function createSiblingWorkspace(): Promise<string> {
  const sibling = new TestGitWorkspace();
  await sibling.create();
  extraWorkspaces.push(sibling);
  return sibling.getPath();
}

/**
 * Runs one workspace-trust preparation against the fixture checkout and the
 * temporary profile.
 *
 * @param overrides - Request fields to override.
 * @returns The preparation outcome.
 */
async function prepare(overrides: Partial<AntigravityTrustRequest> = {}): Promise<AntigravityTrustOutcome> {
  return await prepareAntigravityWorkspaceTrust({
    checkoutPath,
    projectRoot: repoRoot,
    settingsPath,
    ...overrides
  });
}

/**
 * Writes the runtime lifecycle markers a completed Antigravity session leaves
 * for the launcher's positive-evidence gate.
 *
 * @param sessionId - Session identity the launcher exported to the child.
 * @returns Resolves once every required marker exists.
 */
async function writeLifecycleMarkers(sessionId: string): Promise<void> {
  const directory = join(cardsHome, 'antigravity', 'runtime', 'markers', sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'conv-1.ready'),
    JSON.stringify({
      conversationId: 'conv-1',
      sessionId,
      transcriptPath: join(cardsHome, 'conversations', 'conv-1.db'),
      modelName: 'gemini-3-pro'
    }),
    'utf-8'
  );
  await writeFile(join(directory, 'conv-1.idle'), '', 'utf-8');
  await writeFile(join(directory, 'conv-1.drain-ready'), '', 'utf-8');
}

/** One armed `agy` spawn: the fake child plus the details the launcher passed. */
interface SpawnedAgy {
  /** Fake `agy` child handed back to the launcher. */
  child: ChildProcess;
  /** Spawn options the launcher used for the child. */
  options: SpawnOptions;
  /** Session identity exported into the child environment. */
  sessionId: string;
}

/**
 * Arms the spawn seam: the next `agy` spawn returns a fake child while every
 * other command keeps spawning for real.
 *
 * @returns Promise resolving with the fake child once the launcher spawns it.
 */
function armAgySpawn(): Promise<SpawnedAgy> {
  let report!: (spawned: SpawnedAgy) => void;
  const spawned = new Promise<SpawnedAgy>((resolve) => {
    report = resolve;
  });

  vi.mocked(spawn).mockImplementation((command: string, args: readonly string[], options: SpawnOptions) => {
    if (command !== 'agy') {
      return realSpawn(command, args as string[], options);
    }
    const child = createMockChild();
    const spawned: SpawnedAgy = {
      child,
      options,
      sessionId: String((options.env as Record<string, string | undefined>)['ANTIGRAVITY_SESSION_ID'])
    };
    agySpawns.push(spawned);
    report(spawned);
    return child;
  });

  return spawned;
}

/** Real `node:child_process.spawn`, captured past the module mock. */
let realSpawn: typeof import('node:child_process').spawn;

/**
 * Starts one launcher run against the fixture checkout.
 *
 * @param input - Action input to drive the launcher with.
 * @param options - Session-specific launcher options.
 * @param options.prompt - Prompt passed to the Antigravity CLI.
 * @returns The launcher's own promise plus the armed spawn details.
 */
function launch(
  input: ActionInput,
  options: { prompt?: string } = { prompt: LAUNCH_PROMPT }
): {
  done: Promise<void>;
  spawned: Promise<SpawnedAgy>;
} {
  const spawned = armAgySpawn();
  return { done: spawnAntigravitySession(input, createMockContext(), options), spawned };
}

beforeEach(async () => {
  vi.clearAllMocks();
  realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;

  scratchDir = await mkdtemp(join(tmpdir(), 'antigravity-trust-'));
  workspace = new TestGitWorkspace();
  await workspace.create();
  repoRoot = workspace.getPath();
  checkoutPath = await workspace.createWorktree(WORKTREE_BRANCH);

  antigravityHome = join(scratchDir, 'antigravity-cli');
  settingsPath = join(antigravityHome, 'settings.json');
  cardsHome = join(scratchDir, 'cards-home');
  await mkdir(antigravityHome, { recursive: true });
  agySpawns.length = 0;
  extraWorkspaces.length = 0;

  process.env['API_TEST_MODE'] = '1';
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['CARDS_AGENT_LAUNCH_GRANT'] = validGrant();
  process.env['ANTIGRAVITY_HOME'] = antigravityHome;
  process.env['CARDS_HOME'] = cardsHome;

  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (opts?.method === 'PATCH')
      return Promise.resolve(new Response(JSON.stringify({ outcome: 'applied', revision: 'revision-claimed' })));
    if (typeof url === 'string' && url.includes('/branches') && (!opts?.method || opts.method === 'GET')) {
      return Promise.resolve(
        new Response(JSON.stringify({ branches: [], commits: [], defaultBranch: 'main' }), { status: 200 })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });

  const { createWorktree, checkWorktreeExists, findGitRoots } = await import('@cards.management/sdk/worktree');
  vi.mocked(findGitRoots).mockResolvedValue({ sourceRoot: repoRoot, repoRoot });
  vi.mocked(checkWorktreeExists).mockResolvedValue(false);
  vi.mocked(createWorktree).mockResolvedValue({
    path: checkoutPath,
    settle: Promise.resolve({ branch: WORKTREE_BRANCH, worktree: checkoutPath, baseSha: 'abc123' })
  });

  const { createWorktreeForCard } = await import('@cards.management/sdk/worktree-for-card');
  vi.mocked(createWorktreeForCard).mockImplementation((_client, ref, opts) =>
    createWorktree(ref, { cwd: opts.cwd, cardId: opts.cardId, compiledScriptPaths: opts.compiledScriptPaths })
  );

  const { finalizePersistedSqlitePollSession } = await import('@cards.management/sdk/transcript-sync');
  vi.mocked(finalizePersistedSqlitePollSession).mockResolvedValue({ kind: 'flushed', emitted: 0, partial: 0 });

  const { readCardStatus } = await import('@cards.management/sdk/bin/process-utils');
  vi.mocked(readCardStatus).mockResolvedValue('needs_review');
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
  delete process.env['CARDS_AGENT_LAUNCH_GRANT'];
  delete process.env['ANTIGRAVITY_HOME'];
  delete process.env['CARDS_HOME'];
  workspace.destroy();
  for (const extra of extraWorkspaces) extra.destroy();
  extraWorkspaces.length = 0;
  await rm(scratchDir, { recursive: true, force: true });
});

describe('spawnAntigravitySession — workspace trust preparation', () => {
  it('records the action checkout as trusted when its repository is already trusted', async () => {
    await writeSettings({
      allowNonWorkspaceAccess: true,
      toolPermission: 'always-proceed',
      trustedWorkspaces: [repoRoot]
    });

    const run = launch(baseInput());
    const agy = await run.spawned;
    expect(agy.options.cwd).toBe(checkoutPath);

    await writeLifecycleMarkers(agy.sessionId);
    agy.child.emit('close', 0);
    await run.done;

    const trusted = await readTrustedWorkspaces();
    expect(trusted).toContain(await realpath(checkoutPath));
  });

  it('adds no second entry when a later launch reaches the same checkout', async () => {
    await writeSettings({ toolPermission: 'always-proceed', trustedWorkspaces: [repoRoot] });

    const first = launch(baseInput());
    const firstAgy = await first.spawned;
    await writeLifecycleMarkers(firstAgy.sessionId);
    firstAgy.child.emit('close', 0);
    await first.done;

    const afterFirstLaunch = await readTrustedWorkspaces();
    const inode = await inodeOf(settingsPath);

    const second = launch(baseInput());
    const secondAgy = await second.spawned;
    await writeLifecycleMarkers(secondAgy.sessionId);
    secondAgy.child.emit('close', 0);
    await second.done;

    expect(afterFirstLaunch).toEqual([repoRoot, await realpath(checkoutPath)]);
    expect(await readTrustedWorkspaces()).toEqual(afterFirstLaunch);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('fails a background launch that cannot carry trust, without spawning or writing the profile', async () => {
    await writeSettings({ toolPermission: 'always-proceed', trustedWorkspaces: [] });
    const inode = await inodeOf(settingsPath);

    const failure = await launch(baseInput({ executionMode: 'background' })).done.then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AntigravitySessionFailureError);
    const named = failure as AntigravitySessionFailureError;
    expect(named.reason).toBe('workspace-trust-unresolved');
    expect(named.message).toContain(checkoutPath);
    expect(named.message).toContain(repoRoot);
    expect(named.message).toContain('repository-identity-untrusted');
    expect(agySpawns).toHaveLength(0);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('lets an interactive launch proceed when trust cannot be carried, leaving the profile untouched', async () => {
    await writeSettings({ toolPermission: 'always-proceed', trustedWorkspaces: [] });
    const inode = await inodeOf(settingsPath);

    const run = launch(baseInput());
    const agy = await run.spawned;
    await writeLifecycleMarkers(agy.sessionId);
    agy.child.emit('close', 0);
    await run.done;

    expect(await readTrustedWorkspaces()).toEqual([]);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('carries no trust when worktree settlement rejects, before any spawn', async () => {
    await writeSettings({ toolPermission: 'always-proceed', trustedWorkspaces: [repoRoot] });
    const inode = await inodeOf(settingsPath);
    const { createWorktree } = await import('@cards.management/sdk/worktree');
    // The rejection is deliberate, and the launcher consumes it by awaiting
    // settle; the no-op handler only keeps Node from reporting the rejection as
    // unhandled in the window before that await is reached.
    const settle = Promise.reject(new Error('worktree outfit failed'));
    settle.catch(() => undefined);
    vi.mocked(createWorktree).mockResolvedValue({ path: checkoutPath, settle });

    await expect(launch(baseInput()).done).rejects.toThrow(/worktree outfit failed/);

    expect(agySpawns).toHaveLength(0);
    expect(await readTrustedWorkspaces()).toEqual([repoRoot]);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });
});

describe('prepareAntigravityWorkspaceTrust — recording', () => {
  it('records a fresh checkout by its physical path and adds no duplicate on a second run', async () => {
    await writeSettings({ trustedWorkspaces: [repoRoot] });
    const physical = await realpath(checkoutPath);

    expect(await prepare()).toEqual({ kind: 'prepared', trustedPath: physical });
    expect(await readTrustedWorkspaces()).toEqual([repoRoot, physical]);

    const inode = await inodeOf(settingsPath);
    expect(await prepare()).toEqual({ kind: 'already-trusted', trustedPath: physical });
    expect(await readTrustedWorkspaces()).toEqual([repoRoot, physical]);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('establishes consent from every spelling of the shared git-common-dir', async () => {
    // `git rev-parse --git-common-dir` is not uniformly absolute: a main
    // checkout answers `.git`, a subdirectory of it answers a relative
    // `../../../.git`, and only linked worktrees answer absolutely. The repo
    // root the user approved is the relative case, so resolving each answer
    // against anything but the directory it was queried with would deny consent
    // on the primary path — silently, as `no-established-consent`.
    const report = (directory: string): string =>
      execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: directory, encoding: 'utf-8' }).trim();
    const subdirectory = join(repoRoot, 'packages', 'nested');
    await mkdir(subdirectory, { recursive: true });
    const upstream = await workspace.createWorktree('cards/card-123/3');

    expect(report(repoRoot)).toBe('.git');
    expect(report(subdirectory)).toBe(join('..', '..', '.git'));
    expect(report(upstream)).toBe(join(repoRoot, '.git'));

    const cases = [
      // Approved project root (relative answer) authorizes the action checkout.
      { entry: repoRoot, checkout: checkoutPath },
      // A linked worktree (absolute answer) authorizes the main checkout.
      { entry: upstream, checkout: repoRoot },
      // A subdirectory of the approved project (relative, multi-level answer).
      { entry: subdirectory, checkout: checkoutPath }
    ];

    for (const { entry, checkout } of cases) {
      await writeSettings({ trustedWorkspaces: [entry] });
      expect(await prepare({ checkoutPath: checkout })).toEqual({
        kind: 'prepared',
        trustedPath: await realpath(checkout)
      });
      expect(await readTrustedWorkspaces()).toEqual([entry, await realpath(checkout)]);
    }
  });

  it('resolves a symlinked checkout spelling to the physical path and records it once', async () => {
    await writeSettings({ trustedWorkspaces: [repoRoot] });
    const alias = await createAlias(checkoutPath, 'checkout-alias');
    const physical = await realpath(checkoutPath);

    expect(await prepare({ checkoutPath: alias })).toEqual({ kind: 'prepared', trustedPath: physical });
    expect(await readTrustedWorkspaces()).toEqual([repoRoot, physical]);

    const inode = await inodeOf(settingsPath);
    expect(await prepare({ checkoutPath: alias })).toEqual({ kind: 'already-trusted', trustedPath: physical });
    expect(await readTrustedWorkspaces()).toEqual([repoRoot, physical]);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('counts a recorded alias of the physical path as the same entry, without rewriting the spelling', async () => {
    const alias = await createAlias(checkoutPath, 'recorded-alias');
    await writeSettings({ trustedWorkspaces: [repoRoot, alias] });
    const inode = await inodeOf(settingsPath);

    expect(await prepare()).toEqual({ kind: 'already-trusted', trustedPath: await realpath(checkoutPath) });
    expect(await readTrustedWorkspaces()).toEqual([repoRoot, alias]);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('preserves unrelated keys, existing entries, entry order, and file formatting', async () => {
    const otherProject = join(scratchDir, 'other-project');
    const document = {
      toolPermission: 'always-proceed',
      dangerously_skip_permissions: false,
      browser_policy: { allow: ['localhost'] },
      execution_policy: 'sandboxed',
      model: 'gemini-3-pro',
      allowNonWorkspaceAccess: true,
      customUnknownKey: [1, 'two', { three: true }],
      trustedWorkspaces: [repoRoot, otherProject]
    };
    await writeSettings(document);

    expect(await prepare()).toEqual({ kind: 'prepared', trustedPath: await realpath(checkoutPath) });

    const text = await readSettingsText();
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "toolPermission"');
    expect(JSON.parse(text)).toEqual({
      ...document,
      trustedWorkspaces: [repoRoot, otherProject, await realpath(checkoutPath)]
    });
  });

  it('keeps both entries when two preparations run concurrently', async () => {
    await writeSettings({ trustedWorkspaces: [repoRoot] });
    const secondCheckout = await workspace.createWorktree('cards/card-123/2');
    const physicalFirst = await realpath(checkoutPath);
    const physicalSecond = await realpath(secondCheckout);

    const outcomes = await Promise.all([prepare({ checkoutPath }), prepare({ checkoutPath: secondCheckout })]);

    expect(outcomes).toEqual([
      { kind: 'prepared', trustedPath: physicalFirst },
      { kind: 'prepared', trustedPath: physicalSecond }
    ]);
    const entries = await readTrustedWorkspaces();
    expect(entries).toContain(repoRoot);
    expect(entries.filter((entry) => entry === physicalFirst)).toHaveLength(1);
    expect(entries.filter((entry) => entry === physicalSecond)).toHaveLength(1);
  });
});

describe('prepareAntigravityWorkspaceTrust — refusals', () => {
  it('fails closed on a malformed or unexpected profile, leaving the file byte-identical', async () => {
    const documents = [
      '{ "trustedWorkspaces": [',
      '[ "not", "an", "object" ]',
      '{ "trustedWorkspaces": "nope" }',
      '{ "trustedWorkspaces": [42] }',
      '{ "trustedWorkspaces": [{}] }'
    ];

    for (const raw of documents) {
      await writeFile(settingsPath, raw, 'utf-8');
      const inode = await inodeOf(settingsPath);

      await expect(prepare()).rejects.toThrow(AntigravityTrustError);
      await expect(prepare()).rejects.toThrow(settingsPath);

      expect(await readSettingsText()).toBe(raw);
      expect(await inodeOf(settingsPath)).toBe(inode);
    }
  });

  it('reads a profile that records no trust at all as no consent, without adding the key', async () => {
    const raw = '{ "toolPermission": "always-proceed" }\n';
    await writeFile(settingsPath, raw, 'utf-8');
    const inode = await inodeOf(settingsPath);

    expect(await prepare()).toEqual({ kind: 'no-established-consent', reason: 'repository-identity-untrusted' });
    expect(await readSettingsText()).toBe(raw);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('never treats proximity to a trusted entry as consent', async () => {
    const sibling = await createSiblingWorkspace();
    const entries = [
      sibling,
      dirname(repoRoot),
      join(scratchDir, 'never-existed'),
      'https://github.com/example/project.git'
    ];
    await writeSettings({ trustedWorkspaces: entries });
    const inode = await inodeOf(settingsPath);

    expect(await prepare()).toEqual({ kind: 'no-established-consent', reason: 'repository-identity-untrusted' });
    expect(await readTrustedWorkspaces()).toEqual(entries);
    expect(await inodeOf(settingsPath)).toBe(inode);
  });

  it('reports a missing profile as no established consent and never creates one', async () => {
    const missing = join(scratchDir, 'absent-profile', 'settings.json');

    await expect(prepare({ settingsPath: missing })).resolves.toEqual({
      kind: 'no-established-consent',
      reason: 'settings-missing'
    });
    await expect(stat(missing)).rejects.toThrow();
    await expect(stat(dirname(missing))).rejects.toThrow();
  });
});

describe('Antigravity profile resolvers', () => {
  it('resolves the profile directory from ANTIGRAVITY_HOME, then from the native location', () => {
    process.env['ANTIGRAVITY_HOME'] = '/custom/antigravity';
    expect(resolveDefaultAntigravityHome()).toBe('/custom/antigravity');
    expect(resolveAntigravitySettingsPath()).toBe('/custom/antigravity/settings.json');

    delete process.env['ANTIGRAVITY_HOME'];
    const nativeHome = join(homedir(), '.gemini', 'antigravity-cli');
    expect(resolveDefaultAntigravityHome()).toBe(nativeHome);
    expect(resolveAntigravitySettingsPath()).toBe(join(nativeHome, 'settings.json'));
  });
});

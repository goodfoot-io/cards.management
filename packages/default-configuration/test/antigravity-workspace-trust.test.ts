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
 * @summary Tests Antigravity workspace-trust preparation before launch
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ActionContext, type ActionInput, Logger } from '@cards.management/sdk/config';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnAntigravitySession } from '../src/lib/antigravity-session.js';

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
  readCardStatus: vi.fn(),
  transitionCardStatus: vi.fn()
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
    logger: new Logger(),
    cwd: process.cwd(),
    onCancel: vi.fn(),
    onAgentShutdown: vi.fn(),
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
    report({
      child,
      options,
      sessionId: String((options.env as Record<string, string | undefined>)['ANTIGRAVITY_SESSION_ID'])
    });
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

  process.env['API_TEST_MODE'] = '1';
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';
  process.env['CARDS_AGENT_LAUNCH_GRANT'] = validGrant();
  process.env['ANTIGRAVITY_HOME'] = antigravityHome;
  process.env['CARDS_HOME'] = cardsHome;

  globalThis.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
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

  const { readCardStatus, transitionCardStatus } = await import('@cards.management/sdk/bin/process-utils');
  vi.mocked(readCardStatus).mockResolvedValue('needs_review');
  vi.mocked(transitionCardStatus).mockResolvedValue(undefined);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
  delete process.env['CARDS_AGENT_LAUNCH_GRANT'];
  delete process.env['ANTIGRAVITY_HOME'];
  delete process.env['CARDS_HOME'];
  workspace.destroy();
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
});

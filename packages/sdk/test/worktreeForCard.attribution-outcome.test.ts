/**
 * Reproduction tests for the swallowed attribution outcome in
 * outfitWorktreeForCard.
 *
 * Hypothesis under test: `outfitWorktreeForCard()` resolves `void`, so callers
 * (e.g. `cards <id> attach`) cannot distinguish "attribution spawned" from the
 * warn-and-return skip paths (no transcript, unresolvable card repo path,
 * unresolvable agent PID) — attach reports success even when activation was
 * silently skipped. The contract asserted here is that the orchestrator
 * resolves an outcome object: `{ attribution: 'spawned' | 'skipped', reason?:
 * string }`. These tests MUST FAIL against current code, which resolves
 * `undefined` on every path.
 *
 * @summary outfitWorktreeForCard attribution-outcome contract repro
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardsClient } from '../src/client/cardsClient.js';
import { outfitWorktreeForCard } from '../src/worktreeForCard.js';

// ---------------------------------------------------------------------------
// Module-level fakes — same shape as test/worktreeForCard.test.ts, plus the
// attribution collaborators (resolveCardRepoPath, findAgentPid,
// isKnownAgentComm, spawnAdhocAttribution).
// ---------------------------------------------------------------------------

vi.mock('../src/worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  writeCardBoundFile: vi.fn(async () => undefined),
  clearCardBoundFile: vi.fn(),
  appendWorktreeGitExcludes: vi.fn(async () => undefined),
  findGitRoots: vi.fn(async () => ({ sourceRoot: '/src', repoRoot: '/repo' })),
  captureOriginalHooksPath: vi.fn(async () => '/repo/.git/hooks'),
  provisionSharedHooksDir: vi.fn(async () => undefined),
  gitConfigWithRetry: vi.fn(async () => undefined),
  resolveHomeDir: vi.fn(() => '/home')
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined)
  };
});

vi.mock('../src/adhocAttribution.js', () => ({
  resolveCardRepoPath: vi.fn()
}));

vi.mock('../src/process-tree.js', () => ({
  findAgentPid: vi.fn()
}));

vi.mock('../src/bin/process-utils.js', () => ({
  isKnownAgentComm: vi.fn()
}));

vi.mock('../src/bin/spawnAdhocAttribution.js', () => ({
  spawnAdhocAttribution: vi.fn()
}));

import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import after vi.mock so we get the mocked versions.
import { resolveCardRepoPath } from '../src/adhocAttribution.js';
import { isKnownAgentComm } from '../src/bin/process-utils.js';
import { spawnAdhocAttribution } from '../src/bin/spawnAdhocAttribution.js';
import { findAgentPid } from '../src/process-tree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal CardsClient fake whose addBranch resolves immediately.
 *
 * @returns A partial CardsClient sufficient for outfitWorktreeForCard.
 */
function makeClient(): CardsClient {
  return {
    addBranch: async () => ({ outcome: 'upserted', revision: 'test-revision' }),
    removeBranch: async () => undefined
  } as unknown as CardsClient;
}

const WORKTREE_PATH = '/worktrees/cards/main-196/1';
const BASE_OPTIONS = {
  cardId: 'main-196',
  parentBranch: 'main',
  compiledScriptPaths: { 'post-commit': '/hooks/post-commit.mjs' }
} as const;

describe('outfitWorktreeForCard attribution outcome', () => {
  let cardsHomeDir: string;
  let priorCardsHome: string | undefined;

  beforeEach(async () => {
    priorCardsHome = process.env['CARDS_HOME'];
    cardsHomeDir = await mkdtemp(join(tmpdir(), 'outfit-attr-test-'));
    process.env['CARDS_HOME'] = cardsHomeDir;

    // Snapshot guard: CARD_ORIGINAL_HOOK_PATH absent.
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // git config writes succeed; rev-parse returns the branch name.
    vi.mocked(execFile).mockImplementation((...callArgs: unknown[]) => {
      const argv = callArgs[1] as string[];
      const cb = callArgs[callArgs.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
      const isRevParse = argv.includes('rev-parse');
      cb(null, { stdout: isRevParse ? 'cards/main-196/1\n' : '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (priorCardsHome === undefined) {
      delete process.env['CARDS_HOME'];
    } else {
      process.env['CARDS_HOME'] = priorCardsHome;
    }
    await rm(cardsHomeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('marks attribution skipped (not undefined) when transcriptPath is omitted', async () => {
    const client = makeClient();

    const outcome = await outfitWorktreeForCard(client, WORKTREE_PATH, {
      ...BASE_OPTIONS
      // no transcriptPath, no sessionId → attribution phase never runs
    });

    // The caller must be able to see that attribution was skipped — a `void`
    // resolution makes the skip indistinguishable from a successful spawn.
    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({ attribution: 'skipped' });
    expect(spawnAdhocAttribution).not.toHaveBeenCalled();
  });

  it('marks attribution skipped with a reason when the card repo path is unresolvable', async () => {
    // Attribution phase is entered (transcript + session supplied) but the card
    // repo path cannot be resolved → current code warn-and-returns undefined.
    vi.mocked(resolveCardRepoPath).mockResolvedValue(null);

    const client = makeClient();
    const outcome = await outfitWorktreeForCard(client, WORKTREE_PATH, {
      ...BASE_OPTIONS,
      sessionId: 'sess-abc',
      transcriptPath: '/transcripts/sess-abc.jsonl',
      runtime: 'claude-code'
    });

    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({ attribution: 'skipped' });
    expect((outcome as unknown as { reason?: string }).reason).toEqual(expect.any(String));
    expect(spawnAdhocAttribution).not.toHaveBeenCalled();
  });

  it('marks attribution skipped with a reason when the runtime cannot be resolved', async () => {
    // Transcript + session are supplied but no runtime — the caller could not
    // determine which SessionSyncManifest adapter applies.
    const client = makeClient();
    const outcome = await outfitWorktreeForCard(client, WORKTREE_PATH, {
      ...BASE_OPTIONS,
      sessionId: 'sess-abc',
      transcriptPath: '/transcripts/sess-abc.jsonl'
      // no runtime
    });

    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({ attribution: 'skipped', reason: 'runtime-unresolved' });
    expect(spawnAdhocAttribution).not.toHaveBeenCalled();
    expect(resolveCardRepoPath).not.toHaveBeenCalled();
  });

  it('marks attribution spawned when spawnAdhocAttribution actually activates', async () => {
    vi.mocked(resolveCardRepoPath).mockResolvedValue('/home/.cards/cards-repos/main-196');
    vi.mocked(findAgentPid).mockResolvedValue(4242);
    vi.mocked(isKnownAgentComm).mockReturnValue(true);
    vi.mocked(spawnAdhocAttribution).mockResolvedValue({ attribution: 'spawned' } as never);

    const client = makeClient();
    const outcome = await outfitWorktreeForCard(client, WORKTREE_PATH, {
      ...BASE_OPTIONS,
      sessionId: 'sess-abc',
      transcriptPath: '/transcripts/sess-abc.jsonl',
      runtime: 'claude-code'
    });

    expect(spawnAdhocAttribution).toHaveBeenCalledOnce();
    expect(spawnAdhocAttribution).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'claude-code' }),
      expect.anything()
    );
    expect(outcome).toBeDefined();
    expect(outcome).toMatchObject({ attribution: 'spawned' });
  });

  it('resolves agentPid via findAgentPid() — ties cleanup to the ambient agent, not the CLI process', async () => {
    // Reproduction: outfitWorktreeForCard always calls findAgentPid() to
    // resolve the PID passed to spawnAdhocAttribution. For the card-create
    // path this returns the ambient agent PID — which persists long after
    // `cards create` exits — so the card stays `active` until the whole agent
    // session ends. Action-launched cards monitor a dedicated handler PID that
    // exits promptly; worktree-created cards need a caller-supplied PID so
    // the CLI process exit drives the flip to `needs_review`.
    vi.mocked(resolveCardRepoPath).mockResolvedValue('/home/.cards/cards-repos/main-196');
    vi.mocked(findAgentPid).mockResolvedValue(99999);
    vi.mocked(isKnownAgentComm).mockReturnValue(true);
    vi.mocked(spawnAdhocAttribution).mockResolvedValue({ activated: true, attribution: 'spawned' } as never);

    const client = makeClient();
    await outfitWorktreeForCard(client, WORKTREE_PATH, {
      ...BASE_OPTIONS,
      sessionId: 'sess-abc',
      transcriptPath: '/transcripts/sess-abc.jsonl',
      runtime: 'claude-code'
    });

    // The PID passed to spawnAdhocAttribution is the agent PID resolved by
    // findAgentPid — NOT process.pid (the CLI). This is the bug.
    expect(findAgentPid).toHaveBeenCalled();
    expect(spawnAdhocAttribution).toHaveBeenCalledWith(expect.objectContaining({ agentPid: 99999 }), expect.anything());
  });

  it('uses a caller-supplied agentPid when provided, bypassing findAgentPid', async () => {
    vi.mocked(resolveCardRepoPath).mockResolvedValue('/home/.cards/cards-repos/main-196');
    vi.mocked(isKnownAgentComm).mockReturnValue(true);
    vi.mocked(spawnAdhocAttribution).mockResolvedValue({ activated: true, attribution: 'spawned' } as never);

    const client = makeClient();
    await outfitWorktreeForCard(client, WORKTREE_PATH, {
      ...BASE_OPTIONS,
      sessionId: 'sess-abc',
      transcriptPath: '/transcripts/sess-abc.jsonl',
      runtime: 'claude-code',
      agentPid: 77777
    });

    // The caller-supplied PID must reach spawnAdhocAttribution, and
    // findAgentPid must NOT be consulted.
    expect(findAgentPid).not.toHaveBeenCalled();
    expect(spawnAdhocAttribution).toHaveBeenCalledWith(expect.objectContaining({ agentPid: 77777 }), expect.anything());
  });
});

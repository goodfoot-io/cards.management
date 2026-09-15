/**
 * Unit tests for createWorktreeForCard and removeWorktreeForCard orchestrators.
 *
 * The bare createWorktree / removeWorktree primitives are replaced with
 * controllable fakes via vi.mock so no real git or filesystem operations run.
 * CardsClient is injected as a plain object implementing only addBranch /
 * removeBranch — no mocking framework needed for the client half.
 *
 * @summary createWorktreeForCard / removeWorktreeForCard unit tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardsClient } from '../src/client/cardsClient.js';
import { type EarlyWorktreeResult, WorktreeSettlementCleanupError } from '../src/worktree.js';
import {
  BranchUnregisterError,
  createWorktreeForCard,
  outfitWorktreeForCard,
  removeWorktreeForCard
} from '../src/worktreeForCard.js';

// ---------------------------------------------------------------------------
// Module-level fake for the worktree primitives
// ---------------------------------------------------------------------------

vi.mock('../src/worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/worktree.js')>();
  return {
    ...actual,
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    cleanupFailedWorktree: vi.fn(async () => []),
    writeCardBoundFile: vi.fn(),
    clearCardBoundFile: vi.fn(),
    appendWorktreeGitExcludes: vi.fn(),
    // outfit/release internals — stubbed so the composition tests exercise the
    // orchestration logic without real git or filesystem hook provisioning.
    findGitRoots: vi.fn(async () => ({ sourceRoot: '/src', repoRoot: '/repo' })),
    captureOriginalHooksPath: vi.fn(async () => '/repo/.git/hooks'),
    provisionSharedHooksDir: vi.fn(async () => undefined),
    gitConfigWithRetry: vi.fn(async () => undefined),
    resolveHomeDir: vi.fn(() => '/home')
  };
});

// Override only `execFile` (used for the git rev-parse in the bind path) but
// keep every other real export. The cross-process bind lock's liveness check
// (`isProcessAlive` in @cards.management/sessions) calls `execFileSync('tasklist')` on
// Windows; replacing the whole module with `{ execFile }` would make
// `execFileSync` undefined, so the lock's stale-detection would throw, treat the
// live holder as dead, and break mutual exclusion — failing the serialization
// test on Windows only (POSIX uses `process.kill`, not `execFileSync`).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn()
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined)
  };
});

import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import after vi.mock so we get the mocked versions.
import {
  appendWorktreeGitExcludes,
  captureOriginalHooksPath,
  cleanupFailedWorktree,
  clearCardBoundFile,
  createWorktree,
  gitConfigWithRetry,
  removeWorktree,
  writeCardBoundFile
} from '../src/worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal CardsClient fake that tracks calls and resolves immediately.
 *
 * @param overrides - Optional overrides for the client methods.
 * @param overrides.addBranch - Override for the addBranch method.
 * @param overrides.removeBranch - Override for the removeBranch method.
 * @param overrides.updateBranchOwner - Override for the updateBranchOwner method.
 * @param overrides.getBranches - Override for the getBranches method.
 * @returns A partial CardsClient with call tracking arrays attached.
 */
function makeClient(overrides?: {
  addBranch?: CardsClient['addBranch'];
  removeBranch?: CardsClient['removeBranch'];
  updateBranchOwner?: CardsClient['updateBranchOwner'];
  getBranches?: CardsClient['getBranches'];
}): CardsClient & {
  addBranchCalls: Parameters<CardsClient['addBranch']>[];
  removeBranchCalls: Parameters<CardsClient['removeBranch']>[];
} {
  const addBranchCalls: Parameters<CardsClient['addBranch']>[] = [];
  const removeBranchCalls: Parameters<CardsClient['removeBranch']>[] = [];

  return {
    getBranches:
      overrides?.getBranches ?? (async () => ({ branches: [{ name: 'cards/main-95/1', revision: 'test-revision' }] })),
    updateBranchOwner:
      overrides?.updateBranchOwner ?? (async () => ({ outcome: 'applied', revision: 'cleanup-revision' })),
    addBranch:
      overrides?.addBranch ??
      (async (...args) => {
        addBranchCalls.push(args as Parameters<CardsClient['addBranch']>);
        return { outcome: 'created', revision: 'test-revision' };
      }),
    removeBranch:
      overrides?.removeBranch ??
      (async (...args) => {
        removeBranchCalls.push(args as Parameters<CardsClient['removeBranch']>);
        return { outcome: 'removed' };
      }),
    addBranchCalls,
    removeBranchCalls
  } as unknown as CardsClient & {
    addBranchCalls: Parameters<CardsClient['addBranch']>[];
    removeBranchCalls: Parameters<CardsClient['removeBranch']>[];
  };
}

const EARLY_PATH = '/worktrees/cards/main-95/1';
const BASE_OPTIONS = {
  cardId: 'main-95',
  compiledScriptPaths: { 'post-commit': '/hooks/post-commit.mjs' },
  parentBranch: 'main',
  sessionId: 'sess-abc',
  registrationIntent: 'create'
} as const;

// ---------------------------------------------------------------------------
// createWorktreeForCard
// ---------------------------------------------------------------------------

describe('createWorktreeForCard', () => {
  let earlyResult!: EarlyWorktreeResult;

  // The recomposed orchestrator delegates the disk + API phase to the real
  // outfitWorktreeForCard, which acquires a cross-process bind lock under the
  // global Cards config dir. Redirect that dir to an isolated temp dir.
  let cardsHomeDir: string;
  let priorCardsHome: string | undefined;

  beforeEach(async () => {
    priorCardsHome = process.env['CARDS_HOME'];
    cardsHomeDir = await mkdtemp(join(tmpdir(), 'create-wt-test-'));
    process.env['CARDS_HOME'] = cardsHomeDir;

    earlyResult = {
      path: EARLY_PATH,
      settle: Promise.resolve(undefined) as unknown as EarlyWorktreeResult['settle']
    };

    vi.mocked(createWorktree).mockResolvedValue(earlyResult);
    vi.mocked(removeWorktree).mockResolvedValue(undefined);
    // outfit's CARD_ORIGINAL_HOOK_PATH snapshot guard: ENOENT → not yet captured.
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // git config writes (extensions.worktreeConfig, core.hooksPath) succeed;
    // rev-parse --abbrev-ref HEAD returns the worktree's branch name.
    vi.mocked(execFile).mockImplementation((...callArgs: unknown[]) => {
      const argv = callArgs[1] as string[];
      const cb = callArgs[callArgs.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
      const isRevParse = argv.includes('rev-parse');
      cb(null, { stdout: isRevParse ? 'cards/main-95/1\n' : '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });
    vi.mocked(writeCardBoundFile).mockResolvedValue(undefined);
    vi.mocked(appendWorktreeGitExcludes).mockResolvedValue(undefined);
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

  it('assigns settlement cleanup ownership to the card-bound orchestrator', async () => {
    const client = makeClient();
    await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);

    expect(createWorktree).toHaveBeenCalledOnce();
    expect(createWorktree).toHaveBeenCalledWith('cards/main-95/1', {
      cwd: undefined,
      cleanupOnSettleFailure: false
    });
  });

  it('forwards cwd when provided', async () => {
    const client = makeClient();
    await createWorktreeForCard(client, 'cards/main-95/1', { ...BASE_OPTIONS, cwd: '/repo' });

    expect(createWorktree).toHaveBeenCalledWith('cards/main-95/1', {
      cwd: '/repo',
      cleanupOnSettleFailure: false
    });
  });

  it('does not roll back a failed settlement beneath an in-flight outfit', async () => {
    const settlementError = new Error('materialization failed');
    let releaseHooksConfig!: () => void;
    const hooksConfigBlocked = new Promise<void>((resolve) => {
      releaseHooksConfig = resolve;
    });
    let hooksConfigStarted!: () => void;
    const hooksConfigEntered = new Promise<void>((resolve) => {
      hooksConfigStarted = resolve;
    });

    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      repoRoot: '/repo',
      createdBranch: 'cards/main-95/1',
      settle: Promise.reject(settlementError) as EarlyWorktreeResult['settle']
    });
    vi.mocked(gitConfigWithRetry).mockImplementation(async (args) => {
      if (args.includes('--worktree')) {
        hooksConfigStarted();
        await hooksConfigBlocked;
      }
    });
    const client = makeClient();

    const creation = createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);
    await hooksConfigEntered;

    // Settlement has already rejected, but outfit still owns the path.
    await Promise.resolve();
    expect(cleanupFailedWorktree).not.toHaveBeenCalled();
    expect(client.removeBranchCalls).toEqual([]);

    releaseHooksConfig();
    await expect(creation).rejects.toBe(settlementError);

    expect(client.removeBranchCalls).toEqual([]);
    expect(client.addBranchCalls).toEqual([]);
    expect(cleanupFailedWorktree).toHaveBeenCalledOnce();
    expect(cleanupFailedWorktree).toHaveBeenCalledWith('/repo', EARLY_PATH, 'cards/main-95/1');
  });

  it('calls addBranch with the early path, ref, parentBranch, and sessionId', async () => {
    const addBranchArgs: Parameters<CardsClient['addBranch']>[] = [];
    const client = makeClient({
      addBranch: async (...args) => {
        addBranchArgs.push(args as Parameters<CardsClient['addBranch']>);
        return { outcome: 'created', revision: 'test-revision' };
      }
    });

    await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);

    expect(addBranchArgs).toHaveLength(1);
    const [cardId, data, opts] = addBranchArgs[0]!;
    expect(cardId).toBe('main-95');
    expect(data).toEqual({
      name: 'cards/main-95/1',
      worktree: EARLY_PATH,
      parentBranch: 'main',
      intent: 'create'
    });
    expect(opts).toEqual({ sessionId: 'sess-abc' });
  });

  it('does not publish a reusable registration until settlement completes', async () => {
    const addBranchArgs: Parameters<CardsClient['addBranch']>[] = [];
    let resolveSettle!: () => void;
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve;
    }) as unknown as EarlyWorktreeResult['settle'];
    vi.mocked(createWorktree).mockResolvedValue({ path: EARLY_PATH, settle });

    const client = makeClient({
      addBranch: async (...args) => {
        addBranchArgs.push(args as Parameters<CardsClient['addBranch']>);
        return { outcome: 'created', revision: 'test-revision' };
      }
    });

    let handedOff = false;
    const creation = createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS).then((value) => {
      handedOff = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(addBranchArgs).toHaveLength(0);
    expect(handedOff).toBe(false);
    resolveSettle();
    await creation;
    expect(addBranchArgs).toHaveLength(1);
  });

  it('returns the worktree only after settlement succeeds', async () => {
    const client = makeClient();
    let resolveSettle!: () => void;
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve;
    }) as unknown as EarlyWorktreeResult['settle'];
    vi.mocked(createWorktree).mockResolvedValue({ path: EARLY_PATH, settle });
    let handedOff = false;
    const creation = createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS).then((value) => {
      handedOff = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.addBranchCalls).toHaveLength(0);
    expect(handedOff).toBe(false);
    resolveSettle();
    const result = await creation;

    expect(result.path).toBe(EARLY_PATH);
    expect(result.settle).toBeInstanceOf(Promise);
    await result.settle;
  });

  it('conditionally unregisters its revision and removes the quiescent worktree when settlement fails', async () => {
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      settle: Promise.reject(new Error('materialization failed')) as EarlyWorktreeResult['settle']
    });
    const client = makeClient();

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow(
      'materialization failed'
    );

    expect(client.removeBranchCalls).toEqual([]);
    expect(client.addBranchCalls).toEqual([]);
    expect(removeWorktree).toHaveBeenCalledWith(EARLY_PATH);
  });

  it('preserves Git resources when another registration won the slot', async () => {
    const conflict = Object.assign(new Error('registration conflict'), { code: 'BRANCH_REGISTRATION_CONFLICT' });
    const client = makeClient({
      addBranch: async () => {
        throw conflict;
      }
    });
    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toBe(conflict);
    expect(cleanupFailedWorktree).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('retries owned branch cleanup after inner settlement cleanup removed only the worktree', async () => {
    const initiatingError = new Error('materialization failed');
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      repoRoot: '/repo',
      createdBranch: 'cards/main-95/1',
      settle: Promise.reject(
        new WorktreeSettlementCleanupError(initiatingError, ['branch=cards/main-95/1 remains'])
      ) as EarlyWorktreeResult['settle']
    });
    vi.mocked(cleanupFailedWorktree).mockResolvedValue([]);
    const client = makeClient();

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toBe(initiatingError);

    expect(cleanupFailedWorktree).toHaveBeenCalledWith('/repo', EARLY_PATH, 'cards/main-95/1');
  });

  it('drops stale inner residuals when outfit and settlement fail but outer rollback succeeds', async () => {
    const outfitError = new Error('API failure');
    vi.mocked(writeCardBoundFile).mockRejectedValue(outfitError);
    const settlementError = new Error('materialization failed');
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      repoRoot: '/repo',
      createdBranch: 'cards/main-95/1',
      settle: Promise.reject(
        new WorktreeSettlementCleanupError(settlementError, ['branch=cards/main-95/1 remains'])
      ) as EarlyWorktreeResult['settle']
    });
    vi.mocked(cleanupFailedWorktree).mockResolvedValue([]);
    const client = makeClient({
      addBranch: async () => {
        throw outfitError;
      }
    });

    const failure = await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('outfit and settlement failed, but rollback completed');
    expect((failure as Error).message).toContain('settle=materialization failed');
    expect((failure as Error).message).not.toContain('branch=cards/main-95/1 remains');
    expect((failure as Error).message).not.toContain('rollback was incomplete');
    expect((failure as Error).cause).toBe(outfitError);
  });

  it('never calls addBranch when createWorktree rejects', async () => {
    vi.mocked(createWorktree).mockRejectedValue(new Error('git failure'));
    const addBranchArgs: Parameters<CardsClient['addBranch']>[] = [];
    const client = makeClient({
      addBranch: async (...args) => {
        addBranchArgs.push(args as Parameters<CardsClient['addBranch']>);
        return { outcome: 'upserted', revision: 'test-revision' };
      }
    });

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('git failure');
    expect(addBranchArgs).toHaveLength(0);
  });

  it('propagates addBranch rejection', async () => {
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      settle: Promise.resolve(undefined) as unknown as EarlyWorktreeResult['settle']
    });
    const client = makeClient({
      addBranch: async () => {
        throw new Error('API failure');
      }
    });

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('API failure');
  });

  it('preserves the worktree and rethrows an ambiguous registration failure', async () => {
    // Give createWorktree a settle that resolves so rollback can quiesce before
    // removing the worktree.
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      settle: Promise.resolve(undefined) as unknown as EarlyWorktreeResult['settle']
    });

    const client = makeClient({
      addBranch: async () => {
        throw new Error('API failure');
      }
    });

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('API failure');

    // The just-created worktree is rolled back so no orphan remains on disk.
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('waits for deferred settlement before registration and preserves an ambiguous rejection', async () => {
    let resolveSettle!: () => void;
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve;
    }) as unknown as EarlyWorktreeResult['settle'];
    vi.mocked(createWorktree).mockResolvedValue({ path: EARLY_PATH, settle });
    let addAttempted = false;
    const client = makeClient({
      addBranch: async () => {
        addAttempted = true;
        throw new Error('API failure');
      }
    });

    const creation = createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(addAttempted).toBe(false);
    expect(removeWorktree).not.toHaveBeenCalled();

    resolveSettle();
    await expect(creation).rejects.toThrow('API failure');
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('waits for deferred settlement before teardown when the outfit disk phase fails', async () => {
    let resolveSettle!: () => void;
    const settle = new Promise<void>((resolve) => {
      resolveSettle = resolve;
    }) as unknown as EarlyWorktreeResult['settle'];
    vi.mocked(createWorktree).mockResolvedValue({ path: EARLY_PATH, settle });
    vi.mocked(writeCardBoundFile).mockRejectedValue(new Error('marker write failed'));

    const creation = createWorktreeForCard(makeClient(), 'cards/main-95/1', BASE_OPTIONS);
    await vi.waitFor(() => expect(writeCardBoundFile).toHaveBeenCalled());
    expect(removeWorktree).not.toHaveBeenCalled();

    resolveSettle();
    await expect(creation).rejects.toThrow('marker write failed');
    expect(removeWorktree).toHaveBeenCalledOnce();
  });

  it('does not leave settle as an unhandled rejection on the addBranch-rejection path', async () => {
    // A settle that REJECTS after the orchestrator has already failed and
    // returned must not surface as an unhandledRejection. The orchestrator
    // attaches a handler to settle on the rollback path.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const settle = Promise.reject(new Error('settle blew up')) as EarlyWorktreeResult['settle'];
      vi.mocked(createWorktree).mockResolvedValue({ path: EARLY_PATH, settle });

      const client = makeClient({
        addBranch: async () => {
          throw new Error('API failure');
        }
      });

      await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('settle blew up');

      // Let any microtasks / unhandledRejection callbacks flush.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('preserves a sibling checkout when registration commits but its response is lost', async () => {
    let activeOwner: string | undefined;
    const responseLost = new Error('response lost after commit');
    const client = makeClient({
      addBranch: async () => {
        activeOwner = 'sibling-execution';
        throw responseLost;
      }
    });
    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toBe(responseLost);
    expect(activeOwner).toBe('sibling-execution');
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(cleanupFailedWorktree).not.toHaveBeenCalled();
    expect(client.removeBranchCalls).toEqual([]);
  });

  it('aggregates settlement and cleanup failures while retaining the outfit failure as cause', async () => {
    const outfitError = new Error('API failure');
    vi.mocked(writeCardBoundFile).mockRejectedValue(outfitError);
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      settle: Promise.reject(new Error('settlement boom')) as EarlyWorktreeResult['settle']
    });
    vi.mocked(removeWorktree).mockRejectedValue(new Error('rollback boom'));
    const client = makeClient({
      addBranch: async () => {
        throw outfitError;
      }
    });

    const failure = await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /outfit=API failure; settle=settlement boom; worktree=.* may remain: rollback boom/
    );
    expect((failure as Error).cause).toBe(outfitError);
  });
});

// ---------------------------------------------------------------------------
// removeWorktreeForCard
// ---------------------------------------------------------------------------

describe('removeWorktreeForCard', () => {
  const REMOVE_OPTIONS = {
    cardId: 'main-95',
    branchName: 'cards/main-95/1',
    sessionId: 'sess-xyz'
  } as const;

  beforeEach(() => {
    vi.mocked(removeWorktree).mockResolvedValue(undefined);
    vi.mocked(clearCardBoundFile).mockResolvedValue(undefined);
    // release derives the branch via rev-parse and reads CARD_ORIGINAL_HOOK_PATH
    // to restore core.hooksPath; both run against the still-present worktree.
    vi.mocked(execFile).mockImplementation((...callArgs: unknown[]) => {
      const argv = callArgs[1] as string[];
      const cb = callArgs[callArgs.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
      const isRevParse = argv.includes('rev-parse');
      cb(null, { stdout: isRevParse ? 'cards/main-95/1\n' : '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });
    vi.mocked(readFile).mockResolvedValue('/repo/.git/hooks\n');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('refuses disk teardown when a sibling owns the registration', async () => {
    const client = makeClient({
      getBranches: async () =>
        ({ branches: [{ name: 'cards/main-95/1', revision: 'sibling', activeExecutionOwner: 'execution-b' }] }) as never
    });
    await expect(removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS)).rejects.toThrow('owned');
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(client.removeBranchCalls).toEqual([]);
  });

  it('calls removeWorktree with the worktree path', async () => {
    const client = makeClient();
    await removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS);

    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(removeWorktree).toHaveBeenCalledWith(EARLY_PATH);
  });

  it('calls removeBranch with cardId, the HEAD-derived branch name, and sessionId', async () => {
    const removeBranchArgs: Parameters<CardsClient['removeBranch']>[] = [];
    const client = makeClient({
      removeBranch: async (...args) => {
        removeBranchArgs.push(args as Parameters<CardsClient['removeBranch']>);
        return { outcome: 'removed' };
      }
    });

    await removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS);

    expect(removeBranchArgs).toHaveLength(1);
    const [cardId, name, opts] = removeBranchArgs[0]!;
    expect(cardId).toBe('main-95');
    expect(name).toBe('cards/main-95/1');
    expect(opts).toEqual({
      sessionId: 'sess-xyz',
      expectedRevision: 'cleanup-revision',
      expectedCleanupOwner: expect.stringMatching(/^cleanup:/)
    });
  });

  it('holds the registration until disk teardown completes', async () => {
    const callOrder: string[] = [];

    vi.mocked(removeWorktree).mockImplementation(async () => {
      callOrder.push('removeWorktree');
    });

    const client = makeClient({
      removeBranch: async () => {
        callOrder.push('removeBranch');
        return { outcome: 'removed' };
      }
    });

    await removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS);

    // Release needs the worktree on disk (rev-parse, hook-path snapshot), so it
    // runs first; teardown follows.
    expect(callOrder).toEqual(['removeWorktree', 'removeBranch']);
  });

  it('propagates the teardown failure untouched (not wrapped) when removeWorktree rejects', async () => {
    const diskError = new Error('disk error');
    vi.mocked(removeWorktree).mockRejectedValue(diskError);
    const client = makeClient();

    // The teardown-phase error must propagate as-is so callers can apply their
    // teardown stance to it; it is NOT a BranchUnregisterError.
    await expect(removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS)).rejects.toBe(diskError);
  });

  it('wraps a removeBranch failure in BranchUnregisterError carrying the cause', async () => {
    const apiError = new Error('API remove failure');
    const client = makeClient({
      removeBranch: async () => {
        throw apiError;
      }
    });

    await expect(removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS)).rejects.toBeInstanceOf(
      BranchUnregisterError
    );
    // The original cause is preserved for diagnostics.
    await removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS).catch((error: unknown) => {
      expect(error).toBeInstanceOf(BranchUnregisterError);
      expect((error as BranchUnregisterError).cause).toBe(apiError);
    });
  });
});

// ---------------------------------------------------------------------------
// outfitWorktreeForCard — idempotency / snapshot guard
// ---------------------------------------------------------------------------

describe('outfitWorktreeForCard idempotency', () => {
  /**
   * The snapshot guard: when `.cards/CARD_ORIGINAL_HOOK_PATH` already exists on
   * disk, a re-run of `outfitWorktreeForCard` must NOT call
   * `captureOriginalHooksPath` again and must NOT overwrite the file. Without
   * the guard, the second run would capture the cards shared dispatcher dir
   * (installed by the first run) as the "original" and permanently break hook
   * chaining.
   *
   * Half-outfitted input: CARD_ID written, CARD_ORIGINAL_HOOK_PATH already
   * present → re-run must skip the snapshot step.
   */

  let cardsHomeDir: string;
  let priorCardsHome: string | undefined;

  beforeEach(async () => {
    priorCardsHome = process.env['CARDS_HOME'];
    cardsHomeDir = await mkdtemp(join(tmpdir(), 'outfit-idem-test-'));
    process.env['CARDS_HOME'] = cardsHomeDir;

    vi.mocked(writeCardBoundFile).mockResolvedValue(undefined);
    vi.mocked(appendWorktreeGitExcludes).mockResolvedValue(undefined);

    vi.mocked(execFile).mockImplementation((...callArgs: unknown[]) => {
      const argv = callArgs[1] as string[];
      const cb = callArgs[callArgs.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
      const isRevParse = argv.includes('rev-parse');
      cb(null, { stdout: isRevParse ? 'cards/main-95/1\n' : '', stderr: '' });
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

  it('skips captureOriginalHooksPath when CARD_ORIGINAL_HOOK_PATH already exists (snapshot guard holds)', async () => {
    // Simulate a half-outfitted worktree: the snapshot file is already on disk.
    // `access` resolving (no error) signals the file exists.
    vi.mocked(access).mockResolvedValue(undefined);

    const client = makeClient();
    await outfitWorktreeForCard(client, EARLY_PATH, {
      cardId: 'main-95',
      parentBranch: 'main',
      compiledScriptPaths: { 'post-commit': '/hooks/post-commit.mjs' }
    });

    // captureOriginalHooksPath must NOT have been called — the guard prevented it.
    expect(captureOriginalHooksPath).not.toHaveBeenCalled();
  });

  it('does NOT write CARD_ORIGINAL_HOOK_PATH when the snapshot already exists', async () => {
    vi.mocked(access).mockResolvedValue(undefined);

    const client = makeClient();
    await outfitWorktreeForCard(client, EARLY_PATH, {
      cardId: 'main-95',
      parentBranch: 'main',
      compiledScriptPaths: { 'post-commit': '/hooks/post-commit.mjs' }
    });

    // writeFile is the mechanism that writes CARD_ORIGINAL_HOOK_PATH. When the
    // snapshot guard fires it must not be called for that path.
    const writeCalls = vi.mocked(writeFile).mock.calls;
    const snapshotWrite = writeCalls.find(
      ([p]) => typeof p === 'string' && (p as string).includes('CARD_ORIGINAL_HOOK_PATH')
    );
    expect(snapshotWrite).toBeUndefined();
  });

  it('calls captureOriginalHooksPath and writes CARD_ORIGINAL_HOOK_PATH on first run (snapshot absent)', async () => {
    // Snapshot absent: access rejects with ENOENT.
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const client = makeClient();
    await outfitWorktreeForCard(client, EARLY_PATH, {
      cardId: 'main-95',
      parentBranch: 'main',
      compiledScriptPaths: { 'post-commit': '/hooks/post-commit.mjs' }
    });

    expect(captureOriginalHooksPath).toHaveBeenCalledOnce();
    const writeCalls = vi.mocked(writeFile).mock.calls;
    const snapshotWrite = writeCalls.find(
      ([p]) => typeof p === 'string' && (p as string).includes('CARD_ORIGINAL_HOOK_PATH')
    );
    expect(snapshotWrite).toBeDefined();
  });
});

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
import type { EarlyWorktreeResult } from '../src/worktree.js';
import {
  BranchUnregisterError,
  createWorktreeForCard,
  outfitWorktreeForCard,
  removeWorktreeForCard
} from '../src/worktreeForCard.js';

// ---------------------------------------------------------------------------
// Module-level fake for the worktree primitives
// ---------------------------------------------------------------------------

vi.mock('../src/worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
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
}));

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
  clearCardBoundFile,
  createWorktree,
  removeWorktree,
  writeCardBoundFile
} from '../src/worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal CardsClient fake that tracks calls and resolves immediately.
 *
 * @param overrides - Optional overrides for addBranch and removeBranch.
 * @param overrides.addBranch - Override for the addBranch method.
 * @param overrides.removeBranch - Override for the removeBranch method.
 * @returns A partial CardsClient with call tracking arrays attached.
 */
function makeClient(overrides?: {
  addBranch?: CardsClient['addBranch'];
  removeBranch?: CardsClient['removeBranch'];
}): CardsClient & {
  addBranchCalls: Parameters<CardsClient['addBranch']>[];
  removeBranchCalls: Parameters<CardsClient['removeBranch']>[];
} {
  const addBranchCalls: Parameters<CardsClient['addBranch']>[] = [];
  const removeBranchCalls: Parameters<CardsClient['removeBranch']>[] = [];

  return {
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
  let settleResolve!: () => void;
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

    const settle = new Promise<unknown>((res) => {
      settleResolve = res as () => void;
    }) as Promise<never>;
    earlyResult = { path: EARLY_PATH, settle: settle as EarlyWorktreeResult['settle'] };

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

  it('calls createWorktree as a pure primitive (cwd only, no card options)', async () => {
    const client = makeClient();
    await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);

    expect(createWorktree).toHaveBeenCalledOnce();
    expect(createWorktree).toHaveBeenCalledWith('cards/main-95/1', { cwd: undefined });
  });

  it('forwards cwd when provided', async () => {
    const client = makeClient();
    await createWorktreeForCard(client, 'cards/main-95/1', { ...BASE_OPTIONS, cwd: '/repo' });

    expect(createWorktree).toHaveBeenCalledWith('cards/main-95/1', { cwd: '/repo' });
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

  it('calls addBranch with the EARLY path before settle is awaited', async () => {
    const addBranchArgs: Parameters<CardsClient['addBranch']>[] = [];
    let settleAwaited = false;

    const settle = new Promise<never>((res) => {
      // Resolve only after we mark settle as being waited on
      setTimeout(() => {
        settleAwaited = true;
        res(undefined as never);
      }, 100);
    });
    vi.mocked(createWorktree).mockResolvedValue({ path: EARLY_PATH, settle });

    const client = makeClient({
      addBranch: async (...args) => {
        // By the time addBranch is called, settle must NOT have been awaited
        expect(settleAwaited).toBe(false);
        addBranchArgs.push(args as Parameters<CardsClient['addBranch']>);
        return { outcome: 'created', revision: 'test-revision' };
      }
    });

    // The orchestrator must not await settle before calling addBranch
    await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);

    expect(addBranchArgs).toHaveLength(1);
    expect(settleAwaited).toBe(false);
  });

  it('returns the EarlyWorktreeResult (path + settle) without awaiting settle', async () => {
    const client = makeClient();

    const result = await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);

    expect(result.path).toBe(EARLY_PATH);
    // settle must be a promise (not undefined); its resolution must be
    // outstanding — we can check it hasn't resolved synchronously.
    expect(result.settle).toBeInstanceOf(Promise);
    // settle has NOT been awaited by the orchestrator, so settleResolve is
    // still callable — trigger it and confirm result.settle resolves.
    settleResolve();
    // Confirm settle resolves (doesn't hang or reject) once triggered.
    await result.settle;
  });

  it('conditionally unregisters its revision and removes the quiescent worktree when settlement fails', async () => {
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      settle: Promise.reject(new Error('materialization failed')) as EarlyWorktreeResult['settle']
    });
    const client = makeClient();

    const result = await createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS);
    await expect(result.settle).rejects.toThrow('materialization failed');

    expect(client.removeBranchCalls).toEqual([
      ['main-95', 'cards/main-95/1', { sessionId: 'sess-abc', expectedRevision: 'test-revision' }]
    ]);
    expect(removeWorktree).toHaveBeenCalledWith(EARLY_PATH);
  });

  it('never calls addBranch when createWorktree rejects', async () => {
    vi.mocked(createWorktree).mockRejectedValue(new Error('git failure'));
    const addBranchArgs: Parameters<CardsClient['addBranch']>[] = [];
    const client = makeClient({
      addBranch: async (...args) => {
        addBranchArgs.push(args as Parameters<CardsClient['addBranch']>);
      }
    });

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('git failure');
    expect(addBranchArgs).toHaveLength(0);
  });

  it('propagates addBranch rejection', async () => {
    const client = makeClient({
      addBranch: async () => {
        throw new Error('API failure');
      }
    });

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('API failure');
  });

  it('rolls back the worktree and rethrows the original error when addBranch rejects', async () => {
    // Give createWorktree a settle that resolves so the test does not depend on
    // the never-resolving default; the rollback path must not await it anyway.
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
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(removeWorktree).toHaveBeenCalledWith(EARLY_PATH);
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

      await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow('API failure');

      // Let any microtasks / unhandledRejection callbacks flush.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports a combined error when rollback also fails after addBranch rejects', async () => {
    vi.mocked(createWorktree).mockResolvedValue({
      path: EARLY_PATH,
      settle: Promise.resolve(undefined) as unknown as EarlyWorktreeResult['settle']
    });
    vi.mocked(removeWorktree).mockRejectedValue(new Error('rollback boom'));

    const client = makeClient({
      addBranch: async () => {
        throw new Error('API failure');
      }
    });

    await expect(createWorktreeForCard(client, 'cards/main-95/1', BASE_OPTIONS)).rejects.toThrow(
      /outfit=API failure; rollback=rollback boom/
    );
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
      }
    });

    await removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS);

    expect(removeBranchArgs).toHaveLength(1);
    const [cardId, name, opts] = removeBranchArgs[0]!;
    expect(cardId).toBe('main-95');
    expect(name).toBe('cards/main-95/1');
    expect(opts).toEqual({ sessionId: 'sess-xyz' });
  });

  it('releases the binding (removeBranch) BEFORE tearing the worktree down', async () => {
    const callOrder: string[] = [];

    vi.mocked(removeWorktree).mockImplementation(async () => {
      callOrder.push('removeWorktree');
    });

    const client = makeClient({
      removeBranch: async () => {
        callOrder.push('removeBranch');
      }
    });

    await removeWorktreeForCard(client, EARLY_PATH, REMOVE_OPTIONS);

    // Release needs the worktree on disk (rev-parse, hook-path snapshot), so it
    // runs first; teardown follows.
    expect(callOrder).toEqual(['removeBranch', 'removeWorktree']);
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

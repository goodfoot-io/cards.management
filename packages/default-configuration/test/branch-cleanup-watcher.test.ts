import type { ChildProcess } from 'node:child_process';
import { fstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ActionContext } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the detached branch-cleanup watcher: the parent-side spawn helper
 * (`spawnBranchCleanupWatcher`) and the detached entry point
 * (`runDetachedCleanup`).
 *
 * Covers the observability gaps this card closes: every step between "spawn
 * attempted" and "cleanup confirmed done or failed" must land a log line,
 * including the previously-silent stdin-timeout and JSON-parse-failure paths.
 * One test reads an actual temp log file back (rather than only spying on the
 * `Logger` instance) to confirm the `CARDS_HOOKS_LOG_FILE` env-plumbing
 * actually produces a queryable trail, not just calls a mock.
 *
 * @summary Tests for the branch-cleanup watcher's spawn and detached-entry-point paths
 */

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn()
}));

// Wraps `existsSync` in a spy that forwards to the real implementation by
// default (most tests spawn the interim `.js` module path, which never calls
// `existsSync`, but the real `Logger`/detached-output-capture machinery uses
// other `node:fs` exports synchronously and must not be replaced wholesale).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('../src/lib/detached-node.js', () => ({
  resolveDetachedNodeInterpreter: vi.fn()
}));

vi.mock('@cards.management/sdk/client/discovery', () => ({
  createCardsClient: vi.fn()
}));

vi.mock('../src/lib/claude-session.js', () => ({
  cleanupMergedBranches: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

// Wraps the real configuration functions in spies (default behavior
// unchanged) so individual tests can force fail-open outcomes without
// disturbing the real Logger or detached-output implementation used by the
// behavioral tests below.
vi.mock('@cards.management/sdk/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/config')>();
  return {
    ...actual,
    prepareDetachedChildOutputCapture: vi.fn(actual.prepareDetachedChildOutputCapture),
    resolveLogFilePath: vi.fn(actual.resolveLogFilePath)
  };
});

// Wraps mkdir/writeFile in spies that forward to the real implementation by
// default (the cleanup-marker tests below rely on genuine file I/O), so
// individual fake-timer tests can override them to resolve instantly —
// otherwise the marker write's real (if brief) disk latency races against
// `vi.advanceTimersByTimeAsync`'s fixed-step advances and can starve them.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
});

/**
 * Builds a fake logger conforming to `ActionContext['logger']` with spy-able
 * methods, for tests that only need to assert calls (not real file output).
 * @returns A logger whose methods are `vi.fn()` spies.
 */
function createSpyLogger(): ActionContext['logger'] {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn()
  };
}

/**
 * Builds a fake `ChildProcess` with an event-emitting `stdin` and `.on`/`.unref`
 * spies, matching the shape `spawnBranchCleanupWatcher` interacts with.
 * @param overrides - Partial `ChildProcess` fields to override the defaults with.
 * @returns A fake `ChildProcess` with a working `emit`/`on` pair for both itself and its `stdin`.
 */
function createMockChild(overrides?: Partial<ChildProcess>): ChildProcess {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const stdinHandlers = new Map<string, (...args: unknown[]) => void>();
  return {
    pid: 54321,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
      return true;
    },
    stdin: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        stdinHandlers.set(event, cb);
      }),
      write: vi.fn(),
      end: vi.fn(),
      emit(event: string, ...args: unknown[]) {
        stdinHandlers.get(event)?.(...args);
        return true;
      }
    },
    unref: vi.fn(),
    ...overrides
  } as unknown as ChildProcess;
}

/**
 * Reads back a JSON-Lines log file written by the real `Logger` and parses
 * each line, for tests asserting on-disk content rather than mock calls.
 *
 * @param logFilePath - Absolute path to the log file.
 * @returns Parsed log events, one per line.
 */
async function readLogEvents(logFilePath: string): Promise<Array<{ message: string; [key: string]: unknown }>> {
  const content = await fs.readFile(logFilePath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { message: string; [key: string]: unknown });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spawnBranchCleanupWatcher', () => {
  const baseParams = {
    cardId: 'card-123',
    repoRoot: '/test/workspace',
    cardRepoPath: '/test/repo',
    sessionId: 'session-abc'
  };
  const watcherPath = '/resolved/dist/bin/branch-cleanup-watcher.js';

  afterEach(() => {
    vi.useRealTimers();
    delete process.env['CARDS_DETACHED_STDERR_LOG_FILE'];
    delete process.env['CARDS_LOG_DIR'];
  });

  it('prepends the capture preload, shares its descriptor, closes the parent copy, and logs its path', async () => {
    const capturePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-capture-')),
      'detached-output.log'
    );
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = capturePath;

    const { spawn } = await import('node:child_process');
    const { prepareDetachedChildOutputCapture } = await import('@cards.management/sdk/config');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
    child.emit('exit', 0, null);
    await promise;

    expect(prepareDetachedChildOutputCapture).toHaveBeenCalledWith({
      cardId: 'card-123',
      sessionId: 'session-abc',
      childKind: 'branch-cleanup-watcher'
    });
    const [, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(args[0]).toMatch(/^--import=data:text\/javascript,/u);
    expect(args[1]).toMatch(/branch-cleanup-watcher\.[jt]s$/u);
    expect(args[2]).toBe('--branch-cleanup');
    const stdio = (options as { stdio: ['pipe', number, number] }).stdio;
    expect(stdio[1]).toBe(stdio[2]);
    expect(() => fstatSync(stdio[1])).toThrow();
    expect(logger.info).toHaveBeenCalledWith(
      'Branch-cleanup watcher spawned',
      expect.objectContaining({ capturePath })
    );

    const captureText = await fs.readFile(capturePath, 'utf-8');
    expect(captureText).toContain('"phase":"spawn"');
    expect(captureText).toContain('"childKind":"branch-cleanup-watcher"');
  });

  it('warns and retains ignored output sinks when capture preparation fails', async () => {
    const { spawn } = await import('node:child_process');
    const { prepareDetachedChildOutputCapture } = await import('@cards.management/sdk/config');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    vi.mocked(prepareDetachedChildOutputCapture).mockReturnValueOnce({
      ok: false,
      reason: 'capture directory is unavailable'
    });
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
    child.emit('exit', 0, null);
    await promise;

    const [, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(args).toHaveLength(2);
    expect(args[0]).toMatch(/branch-cleanup-watcher\.[jt]s$/u);
    expect(args[1]).toBe('--branch-cleanup');
    expect((options as { stdio: unknown[] }).stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(logger.warn).toHaveBeenCalledWith('Branch-cleanup watcher output capture unavailable', {
      reason: 'capture directory is unavailable',
      cardId: 'card-123',
      sessionId: 'session-abc'
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Branch-cleanup watcher spawned',
      expect.objectContaining({ capturePath: null })
    );
  });

  it('derives CARDS_HOOKS_LOG_FILE via the same resolveLogFilePath the parent logger uses', async () => {
    const { spawn } = await import('node:child_process');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');
    const { resolveLogFilePath } = await import('@cards.management/sdk/config');

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
    child.emit('exit', 0, null);
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
    // Asserting parity against the actual resolveLogFilePath() output (rather
    // than a hardcoded path) is the regression guard: if the implementation
    // ever reverts to recomputing its own path, this stops matching.
    expect(spawnOpts.env['CARDS_HOOKS_LOG_FILE']).toBe(
      resolveLogFilePath({ subsystem: 'cards-default-configuration-hooks' })
    );
  });

  it('honors a CARDS_LOG_DIR override, so parent and child agree on the same log file', async () => {
    // Same harness caveat as above: CARDS_HOOKS_LOG_FILE (tier 2) outranks
    // CARDS_LOG_DIR (tier 3) in resolveLogFilePath()'s precedence, and the
    // vitest harness sets CARDS_HOOKS_LOG_FILE globally, so it must be
    // cleared to actually exercise the CARDS_LOG_DIR tier.
    const originalEnvValue = process.env['CARDS_HOOKS_LOG_FILE'];
    delete process.env['CARDS_HOOKS_LOG_FILE'];
    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-log-dir-'));
    process.env['CARDS_LOG_DIR'] = tmpLogDir;

    try {
      const { spawn } = await import('node:child_process');
      const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const logger = createSpyLogger();
      const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
      child.emit('exit', 0, null);
      await promise;

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect(spawnOpts.env['CARDS_HOOKS_LOG_FILE']).toBe(path.join(tmpLogDir, 'cards-default-configuration-hooks.log'));
    } finally {
      if (originalEnvValue !== undefined) {
        process.env['CARDS_HOOKS_LOG_FILE'] = originalEnvValue;
      }
    }
  });

  it('omits CARDS_HOOKS_LOG_FILE from the child env when resolveLogFilePath returns null', async () => {
    // The vitest harness itself sets CARDS_HOOKS_LOG_FILE=/dev/null on
    // process.env for every test in this suite (see vitest.config.ts), so it
    // must be cleared here too — otherwise the child would inherit it from
    // `...process.env` even though the (mocked) resolution says file logging
    // is disabled, masking the behavior this test exists to check.
    const originalEnvValue = process.env['CARDS_HOOKS_LOG_FILE'];
    delete process.env['CARDS_HOOKS_LOG_FILE'];
    try {
      const { spawn } = await import('node:child_process');
      const { resolveLogFilePath } = await import('@cards.management/sdk/config');
      vi.mocked(resolveLogFilePath).mockReturnValueOnce(null);
      const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const logger = createSpyLogger();
      const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
      child.emit('exit', 0, null);
      await promise;

      const spawnOpts = vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string> };
      expect(spawnOpts.env['CARDS_HOOKS_LOG_FILE']).toBeUndefined();
    } finally {
      if (originalEnvValue !== undefined) {
        process.env['CARDS_HOOKS_LOG_FILE'] = originalEnvValue;
      }
    }
  });

  it('logs pid on successful spawn', async () => {
    const { spawn } = await import('node:child_process');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    const child = createMockChild({ pid: 999 });
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
    child.emit('exit', 0, null);
    await promise;

    expect(logger.info).toHaveBeenCalledWith(
      'Branch-cleanup watcher spawned',
      expect.objectContaining({ pid: 999, cardId: 'card-123', sessionId: 'session-abc' })
    );
  });

  it('logs an error when spawn() throws, and does not touch stdin', async () => {
    const capturePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-capture-')),
      'detached-output.log'
    );
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = capturePath;
    const { spawn } = await import('node:child_process');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    let inheritedFd: number | undefined;
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      inheritedFd = (options?.stdio as ['pipe', number, number])[1];
      throw new Error('EMFILE: too many open files');
    });

    const logger = createSpyLogger();
    await expect(spawnBranchCleanupWatcher(baseParams, logger, watcherPath)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'Branch-cleanup watcher failed to spawn',
      expect.objectContaining({
        error: 'EMFILE: too many open files',
        cardId: 'card-123',
        sessionId: 'session-abc'
      })
    );
    expect(inheritedFd).toBeTypeOf('number');
    expect(() => fstatSync(inheritedFd!)).toThrow();
  });

  it('logs when the spawned child emits exit', async () => {
    const { spawn } = await import('node:child_process');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);

    (child as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit('exit', 0, null);
    await promise;

    expect(logger.info).toHaveBeenCalledWith(
      'Branch-cleanup watcher process exited',
      expect.objectContaining({ pid: child.pid, code: 0, signal: null, cardId: 'card-123', sessionId: 'session-abc' })
    );
  });

  it('warns (not throws) on a stdin pipe error', async () => {
    const { spawn } = await import('node:child_process');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);

    (child.stdin as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit('error', new Error('EPIPE'));
    child.emit('exit', 0, null);
    await promise;

    expect(logger.warn).toHaveBeenCalledWith(
      'Branch-cleanup watcher stdin pipe error',
      expect.objectContaining({ error: 'EPIPE', cardId: 'card-123', sessionId: 'session-abc' })
    );
  });

  it('resolves via the child exit event without waiting for the grace-period timer', async () => {
    vi.useFakeTimers();
    const { spawn } = await import('node:child_process');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    // Marker write isn't under test here; make it resolve instantly so it
    // can't race the fake-timer advances below.
    vi.mocked(mkdir).mockResolvedValueOnce(undefined as unknown as string);
    vi.mocked(writeFile).mockResolvedValueOnce(undefined);

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
    child.emit('exit', 0, null);

    // The promise must resolve purely from the exit event — the fake timer is
    // never advanced, so this would hang (and fail on the suite's timeout) if
    // the race were implemented as "always wait out the grace period."
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves via the grace-period timer when the child never exits', async () => {
    vi.useFakeTimers();
    const { spawn } = await import('node:child_process');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

    // Marker write isn't under test here; make it resolve instantly so it
    // can't race the fake-timer advances below.
    vi.mocked(mkdir).mockResolvedValueOnce(undefined as unknown as string);
    vi.mocked(writeFile).mockResolvedValueOnce(undefined);

    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const logger = createSpyLogger();
    let resolved = false;
    const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath).then(() => {
      resolved = true;
    });

    // EXIT_GRACE_MS is 500ms; confirm the race is still pending just short of
    // it, then resolves once the grace period elapses.
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    await promise;
  });

  describe('cleanup-attempt marker', () => {
    // os.homedir() honors HOME on POSIX, so pointing it at a temp dir lets
    // these tests exercise the real fs.mkdir/writeFile calls (no mocking of
    // node:fs/promises, which would also break the real-Logger tests below
    // that share this module) while keeping everything under a disposable
    // directory.
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
      originalHome = process.env['HOME'];
      tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-marker-home-'));
      process.env['HOME'] = tmpHome;
    });

    afterEach(() => {
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome;
      } else {
        delete process.env['HOME'];
      }
    });

    function expectedMarkerPath(cardId: string, sessionId: string | undefined): string {
      return path.join(tmpHome, '.cards', 'branch-cleanup-markers', `${cardId}-${sessionId ?? 'unknown'}.json`);
    }

    it('writes the cleanup-attempt marker on successful spawn and logs its path in the "spawned" log line', async () => {
      const { spawn } = await import('node:child_process');
      const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const logger = createSpyLogger();
      const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
      child.emit('exit', 0, null);
      await promise;

      const markerPath = expectedMarkerPath(baseParams.cardId, baseParams.sessionId);
      const markerContent = JSON.parse(await fs.readFile(markerPath, 'utf-8')) as { startedAt: string };
      expect(markerContent.startedAt).toEqual(expect.any(String));

      expect(logger.info).toHaveBeenCalledWith(
        'Branch-cleanup watcher spawned',
        expect.objectContaining({ cardId: baseParams.cardId, sessionId: baseParams.sessionId, markerPath })
      );
    });

    it('logs a warning and still spawns when the marker directory cannot be created', async () => {
      // Force the marker write to fail by pre-creating a *file* (not a
      // directory) at the path fs.mkdir needs to create as a directory.
      const conflictingPath = path.join(tmpHome, '.cards');
      await fs.mkdir(path.dirname(conflictingPath), { recursive: true });
      await fs.writeFile(conflictingPath, 'not a directory');

      const { spawn } = await import('node:child_process');
      const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child);

      const logger = createSpyLogger();
      const promise = spawnBranchCleanupWatcher(baseParams, logger, watcherPath);
      child.emit('exit', 0, null);
      await promise;

      expect(logger.warn).toHaveBeenCalledWith(
        'Branch-cleanup watcher failed to write cleanup-attempt marker',
        expect.objectContaining({ cardId: baseParams.cardId, sessionId: baseParams.sessionId })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Branch-cleanup watcher spawned',
        expect.objectContaining({ markerPath: undefined })
      );
      // Fail-open: the spawn itself still happened despite the marker failure.
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('installed-binary wrapper resolution', () => {
    // Unlike `watcherPath` above (a `.js` module — the interim self-invocation
    // shim), a resolved installed binary has no JS extension on POSIX
    // (`branch-cleanup-watcher`) and `.cmd` on win32 — `node <path>` cannot run
    // either, so these must be spawned via the wrapper-exec branch.
    const wrapperPath = '/resolved/dist/bin/branch-cleanup-watcher';

    let savedPlatform: PropertyDescriptor | undefined;

    beforeEach(() => {
      savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    });

    afterEach(() => {
      if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
    });

    function setPlatform(platform: NodeJS.Platform): void {
      Object.defineProperty(process, 'platform', { value: platform });
    }

    describe('POSIX', () => {
      beforeEach(() => setPlatform('linux'));

      it('execs the wrapper directly with no argv and no node interpreter', async () => {
        const { spawn } = await import('node:child_process');
        const { existsSync } = await import('node:fs');
        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

        vi.mocked(existsSync).mockReturnValue(true);
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const logger = createSpyLogger();
        const promise = spawnBranchCleanupWatcher(baseParams, logger, wrapperPath);
        child.emit('exit', 0, null);
        await promise;

        expect(spawn).toHaveBeenCalledWith(wrapperPath, [], expect.objectContaining({ detached: true }));
      });

      it('carries the output-capture preload via NODE_OPTIONS instead of argv', async () => {
        const capturePath = path.join(
          await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-capture-')),
          'detached-output.log'
        );
        process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = capturePath;

        const { spawn } = await import('node:child_process');
        const { existsSync } = await import('node:fs');
        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

        vi.mocked(existsSync).mockReturnValue(true);
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const logger = createSpyLogger();
        const promise = spawnBranchCleanupWatcher(baseParams, logger, wrapperPath);
        child.emit('exit', 0, null);
        await promise;

        const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
        expect(command).toBe(wrapperPath);
        expect(args).toEqual([]);
        const env = (options as { env: Record<string, string> }).env;
        expect(env['NODE_OPTIONS']).toMatch(/--import=data:text\/javascript,/u);
      });

      it('skips the spawn and logs an error when the wrapper does not exist', async () => {
        const { spawn } = await import('node:child_process');
        const { existsSync } = await import('node:fs');
        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

        vi.mocked(existsSync).mockReturnValue(false);
        const logger = createSpyLogger();

        await spawnBranchCleanupWatcher(baseParams, logger, wrapperPath);

        expect(spawn).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
          'Branch-cleanup watcher not resolvable — skipping spawn',
          expect.objectContaining({ watcher: wrapperPath })
        );
      });
    });

    describe('win32', () => {
      beforeEach(() => setPlatform('win32'));

      it('skips the spawn when no Node interpreter can be resolved', async () => {
        const { spawn } = await import('node:child_process');
        const { resolveDetachedNodeInterpreter } = await import('../src/lib/detached-node.js');
        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

        vi.mocked(resolveDetachedNodeInterpreter).mockReturnValue(null);
        const logger = createSpyLogger();

        await spawnBranchCleanupWatcher(baseParams, logger, `${wrapperPath}.cmd`);

        expect(spawn).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('no usable Node interpreter'),
          expect.any(Object)
        );
      });

      it('spawns node.exe directly with the sibling .mjs and no shell when resolution succeeds', async () => {
        const { spawn, spawnSync } = await import('node:child_process');
        const { existsSync } = await import('node:fs');
        const { prepareDetachedChildOutputCapture } = await import('@cards.management/sdk/config');
        const { resolveDetachedNodeInterpreter } = await import('../src/lib/detached-node.js');
        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

        // Capture failure isolates this test to interpreter/.mjs resolution;
        // the NODE_OPTIONS-preload carry-through is covered by the POSIX test
        // above.
        vi.mocked(prepareDetachedChildOutputCapture).mockReturnValueOnce({
          ok: false,
          reason: 'capture directory is unavailable'
        });
        vi.mocked(resolveDetachedNodeInterpreter).mockReturnValue('C:\\node.exe');
        // node:path's isAbsolute() uses the POSIX implementation under a Linux
        // test runner even with process.platform stubbed to 'win32', so a
        // `C:\...` wrapper path is not seen as absolute here — the code takes
        // the `where`-lookup branch.
        vi.mocked(spawnSync).mockReturnValue({
          status: 0,
          error: undefined,
          stdout: 'C:\\ext\\dist\\bin\\branch-cleanup-watcher.cmd\n'
        } as never);
        vi.mocked(existsSync).mockReturnValue(true);
        const child = createMockChild();
        vi.mocked(spawn).mockReturnValue(child);

        const logger = createSpyLogger();
        const promise = spawnBranchCleanupWatcher(baseParams, logger, 'branch-cleanup-watcher.cmd');
        child.emit('exit', 0, null);
        await promise;

        expect(spawn).toHaveBeenCalledWith(
          'C:\\node.exe',
          ['C:\\ext\\dist\\bin\\branch-cleanup-watcher.mjs'],
          expect.objectContaining({ detached: true, windowsHide: true })
        );
      });

      it('skips the spawn when the sibling .mjs cannot be resolved', async () => {
        const { spawn, spawnSync } = await import('node:child_process');
        const { existsSync } = await import('node:fs');
        const { resolveDetachedNodeInterpreter } = await import('../src/lib/detached-node.js');
        const { spawnBranchCleanupWatcher } = await import('../src/lib/branch-cleanup-watcher.js');

        vi.mocked(resolveDetachedNodeInterpreter).mockReturnValue('C:\\node.exe');
        vi.mocked(spawnSync).mockReturnValue({
          status: 0,
          error: undefined,
          stdout: 'C:\\ext\\dist\\bin\\branch-cleanup-watcher.cmd\n'
        } as never);
        vi.mocked(existsSync).mockReturnValue(false);
        const logger = createSpyLogger();

        await spawnBranchCleanupWatcher(baseParams, logger, 'branch-cleanup-watcher.cmd');

        expect(spawn).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('.mjs not resolvable'), expect.any(Object));
      });
    });
  });
});

describe('runDetachedCleanup', () => {
  let logFilePath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    logFilePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-watcher-test-')), 'hooks.log');
    process.env['CARDS_HOOKS_LOG_FILE'] = logFilePath;
    // The timeout/parse-failure paths call process.exit(1) directly (by
    // design — they must not wait on anything else). Stub it so the test
    // process survives; the function still resolves its promise with the
    // correct code before the exit call.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // Same HOME-redirection trick as the marker tests above: the child
    // recomputes the marker path via os.homedir(), so pointing HOME at a temp
    // dir lets these tests plant/observe the real marker file on disk.
    originalHome = process.env['HOME'];
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-cleanup-marker-home-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    delete process.env['CARDS_HOOKS_LOG_FILE'];
    exitSpy.mockRestore();
    vi.useRealTimers();
    if (originalHome !== undefined) {
      process.env['HOME'] = originalHome;
    } else {
      delete process.env['HOME'];
    }
  });

  function markerPathFor(cardId: string, sessionId: string | undefined): string {
    return path.join(tmpHome, '.cards', 'branch-cleanup-markers', `${cardId}-${sessionId ?? 'unknown'}.json`);
  }

  async function plantMarker(cardId: string, sessionId: string | undefined): Promise<string> {
    const markerPath = markerPathFor(cardId, sessionId);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ startedAt: new Date().toISOString() }));
    return markerPath;
  }

  async function markerExists(markerPath: string): Promise<boolean> {
    return fs
      .access(markerPath)
      .then(() => true)
      .catch(() => false);
  }

  it('returns 0 and logs a full success trail, readable back from the log file', async () => {
    const { createCardsClient } = await import('@cards.management/sdk/client/discovery');
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { runDetachedCleanup } = await import('../src/lib/branch-cleanup-watcher.js');

    vi.mocked(createCardsClient).mockResolvedValue({} as never);
    vi.mocked(cleanupMergedBranches).mockResolvedValue(undefined);

    // The parent normally writes this marker before the child even starts;
    // planted here to simulate that, so removal can be observed.
    const markerPath = await plantMarker('card-123', undefined);

    const stdin = new Readable({ read() {} });
    const resultPromise = runDetachedCleanup(stdin);
    stdin.push(JSON.stringify({ cardId: 'card-123', repoRoot: '/test/workspace', cardRepoPath: '/test/repo' }));
    stdin.push(null);

    const result = await resultPromise;
    expect(result).toBe(0);
    expect(cleanupMergedBranches).toHaveBeenCalledWith(
      { cardId: 'card-123', repoRoot: '/test/workspace' },
      '/test/repo',
      expect.anything(),
      undefined
    );

    const events = await readLogEvents(logFilePath);
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        'Branch-cleanup watcher process started',
        'Branch-cleanup watcher started',
        'Branch-cleanup watcher completed'
      ])
    );

    // The child removes the marker itself, in its finally block, once
    // cleanup settles — it never received the path over stdin, it recomputed
    // the same deterministic path.
    expect(await markerExists(markerPath)).toBe(false);
  });

  it('logs a parse failure and returns 1 when stdin ends with invalid JSON', async () => {
    const { runDetachedCleanup } = await import('../src/lib/branch-cleanup-watcher.js');

    const stdin = new Readable({ read() {} });
    const resultPromise = runDetachedCleanup(stdin);
    stdin.push('not valid json{{{');
    stdin.push(null);

    const result = await resultPromise;
    expect(result).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const events = await readLogEvents(logFilePath);
    const messages = events.map((e) => e.message);
    expect(messages).toContain('Branch-cleanup watcher process started');
    expect(messages).toContain('Branch-cleanup watcher failed to parse stdin params');
  });

  it('logs a timeout and returns 1 when stdin never ends', async () => {
    vi.useFakeTimers();
    const { runDetachedCleanup } = await import('../src/lib/branch-cleanup-watcher.js');

    const stdin = new Readable({ read() {} });
    const resultPromise = runDetachedCleanup(stdin);

    await vi.advanceTimersByTimeAsync(10_000);

    const result = await resultPromise;
    expect(result).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const events = await readLogEvents(logFilePath);
    const messages = events.map((e) => e.message);
    expect(messages).toContain('Branch-cleanup watcher process started');
    expect(messages).toContain('Branch-cleanup watcher timed out waiting for stdin params');
  });

  it('logs failure and returns 1 when cleanupMergedBranches rejects', async () => {
    const { createCardsClient } = await import('@cards.management/sdk/client/discovery');
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const { runDetachedCleanup } = await import('../src/lib/branch-cleanup-watcher.js');

    vi.mocked(createCardsClient).mockResolvedValue({} as never);
    vi.mocked(cleanupMergedBranches).mockRejectedValue(new Error('git worktree remove failed'));

    const markerPath = await plantMarker('card-123', 's1');

    const stdin = new Readable({ read() {} });
    const resultPromise = runDetachedCleanup(stdin);
    stdin.push(
      JSON.stringify({ cardId: 'card-123', repoRoot: '/test/workspace', cardRepoPath: '/test/repo', sessionId: 's1' })
    );
    stdin.push(null);

    const result = await resultPromise;
    expect(result).toBe(1);

    const events = await readLogEvents(logFilePath);
    const failure = events.find((e) => e.message === 'Branch-cleanup watcher failed');
    expect(failure).toMatchObject({
      context: { error: 'git worktree remove failed', cardId: 'card-123', sessionId: 's1' }
    });

    // The marker is removed even on failure — it's a "was an attempt made"
    // signal, not a success flag.
    expect(await markerExists(markerPath)).toBe(false);
  });
});

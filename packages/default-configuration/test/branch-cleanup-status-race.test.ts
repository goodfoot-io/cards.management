import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import * as fsSyncNs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActionContext, ActionInput } from '@cards.management/sdk/config';
import { Logger } from '@cards.management/sdk/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Faithful reproduction of the post-exit branch-cleanup status race.
 *
 * When an interactive session ends, the exit path spawns the detached
 * branch-cleanup watcher; the card's `active`→`needs_review` transition is
 * written by a separate process (the ad-hoc cleanup monitor) with no ordering
 * relationship to that spawn. The sweep's first gate is the card status read
 * from disk ([`cleanupMergedBranches`](../src/lib/claude-session.ts#L580-L591)):
 * when the watcher reads the file before the flip lands it sees `active`,
 * skips the whole sweep, removes its cleanup-attempt marker, and nothing ever
 * retries — a merged, idle card keeps its worktree indefinitely.
 *
 * This test drives the real interactive exit path ([`spawnClaudeSession`](../src/lib/claude-session.ts#L876))
 * against real git repositories (workspace with a fully-merged card branch and
 * worktree, card repo with a committed `active` status and a `branches/`
 * entry — exactly the state observed in the wild). Only the agent/watcher
 * process launches are mocked; every git and filesystem call is real. The
 * spawn mock reads the card repo's `CARD.meta.json` at the moment the watcher
 * is spawned — the state the detached child's sweep would read — and asserts
 * it is already settled to `needs_review`. The desired post-fix assertions
 * FAIL against current code, which spawns the watcher while the file still
 * says `active`. It then runs the sweep the detached child would have run and
 * asserts the merged branch, worktree, and `branches/` entry are all removed.
 *
 * @summary Reproduction: the watcher must read a settled card status at spawn time
 */

// Agent/watcher process launches and the CLI-presence probe are mocked.
// execFileSync stays real so all git work runs against fixture repositories.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

// spawnAgentCli routes the agent launch through cross-spawn; forward it to the
// mocked node:child_process.spawn (same pattern as claude-session.test.ts).
vi.mock('cross-spawn', async () => {
  const cp = await import('node:child_process');
  return { default: cp.spawn };
});

let wsRepo: string;
let cardRepo: string;
let wtPath: string;
let branchesEntryPath: string;

/** The on-disk card status at the exact moment the watcher is spawned. */
let statusAtWatcherSpawn: string | null = null;

let originalFetch: typeof globalThis.fetch;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function configUser(cwd: string): void {
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
}

function createMockLogger(): ActionContext['logger'] {
  return new Logger();
}

function createMockContext(): ActionContext {
  return {
    logger: new Logger(),
    cwd: process.cwd(),
    onCancel: vi.fn(),
    onAgentShutdown: vi.fn(),
    onSwitchToInteractive: vi.fn()
  };
}

function createMockChild(overrides?: Partial<ChildProcess>): ChildProcess {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    pid: 12345,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    kill: vi.fn(),
    stdout: null,
    stderr: null,
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
      return true;
    },
    ...overrides
  } as unknown as ChildProcess;
}

function baseInput(overrides?: Partial<ActionInput>): ActionInput {
  return {
    cardId: 'card-123',
    actionName: 'Launch',
    environment: 'default',
    executionMode: 'interactive',
    repoRoot: wsRepo,
    cardRepoPath: cardRepo,
    configPath: '/test/config',
    extensionPath: '/test/extension',
    exitWhenDone: true,
    ...overrides
  };
}

beforeEach(() => {
  vi.mocked(execFile).mockImplementation(((command: string, args: readonly string[], ...rest: unknown[]) => {
    const callback = rest.at(-1);
    if ((command === 'which' || command === 'where') && args[0] === 'claude' && typeof callback === 'function') {
      callback(null, { stdout: '/usr/local/bin/claude\n', stderr: '' });
      return createMockChild();
    }
    if (command === 'git' && args.join(' ') === 'rev-parse --abbrev-ref HEAD' && typeof callback === 'function') {
      callback(null, { stdout: 'main\n', stderr: '' });
      return createMockChild();
    }
    if (command === 'git' && typeof callback === 'function') {
      const options = (rest[0] ?? {}) as { cwd?: string; env?: NodeJS.ProcessEnv };
      try {
        const stdout = execFileSync(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
        callback(null, { stdout, stderr: '' });
      } catch (error) {
        callback(error, { stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      }
      return createMockChild();
    }
    throw new Error(`Unexpected execFile call: ${command} ${args.join(' ')}`);
  }) as typeof execFile);

  // Resolve realpath so the /proc cwd comparison matches (on some systems
  // /tmp is a symlink to /private/tmp etc).
  wsRepo = fsSyncNs.realpathSync(fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'status-race-ws-')));
  cardRepo = fsSyncNs.realpathSync(fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'status-race-card-')));
  wtPath = path.join(wsRepo, '.worktrees', 'cards', 'card-123', '1');

  // Workspace repo: main, a card branch carrying one commit, and its worktree;
  // main fast-forwarded onto the branch tip so the branch is fully merged.
  git(wsRepo, ['init', '-b', 'main']);
  configUser(wsRepo);
  fsSyncNs.writeFileSync(path.join(wsRepo, 'README.md'), '# workspace\n');
  git(wsRepo, ['add', 'README.md']);
  git(wsRepo, ['commit', '-m', 'initial commit']);

  fsSyncNs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(wsRepo, ['worktree', 'add', wtPath, '-b', 'cards/card-123/1', 'main']);
  fsSyncNs.writeFileSync(path.join(wtPath, 'feature.txt'), 'work\n');
  git(wtPath, ['add', 'feature.txt']);
  git(wtPath, ['commit', '-m', 'feature work']);
  git(wsRepo, ['merge', '--ff-only', 'cards/card-123/1']);

  // Card repo: committed `active` status (the pre-exit state observed in the
  // wild) plus the branches/ record pointing at the real worktree.
  git(cardRepo, ['init', '-b', 'main']);
  configUser(cardRepo);
  fsSyncNs.writeFileSync(path.join(cardRepo, 'CARD.meta.json'), `${JSON.stringify({ status: 'active' }, null, 2)}\n`);
  const branchesDir = path.join(cardRepo, 'branches');
  fsSyncNs.mkdirSync(branchesDir, { recursive: true });
  branchesEntryPath = path.join(branchesDir, `${encodeURIComponent('cards/card-123/1')}.json`);
  fsSyncNs.writeFileSync(
    branchesEntryPath,
    JSON.stringify(
      { name: 'cards/card-123/1', worktree: wtPath, parentBranch: 'main', addedAt: '2026-01-01T00:00:00Z' },
      null,
      2
    )
  );
  git(cardRepo, ['add', '.']);
  git(cardRepo, ['commit', '-m', 'track branch']);

  // The interactive exit path constructs a Logger and writes the cleanup-attempt
  // marker under $HOME — point it at a disposable directory.
  process.env['HOME'] = fsSyncNs.realpathSync(fsSyncNs.mkdtempSync(path.join(os.tmpdir(), 'status-race-home-')));
  process.env['API_TEST_MODE'] = '1';
  process.env['EXTENSION_PATH'] = '/test/extension';
  process.env['MARKETPLACE_PATH'] = '/test/extension/dist/marketplace';

  originalFetch = globalThis.fetch;
  // The branch record tells resolveOrCreateWorktree the worktree already
  // exists on disk, so no worktree creation machinery runs.
  globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
    if (typeof url === 'string' && url.includes('/branches')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            branches: [
              {
                name: 'cards/card-123/1',
                worktree: wtPath,
                parentBranch: 'main',
                addedAt: '2026-01-01T00:00:00Z',
                exists: true
              }
            ],
            commits: [],
            defaultBranch: 'main'
          }),
          { status: 200 }
        )
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['API_TEST_MODE'];
  delete process.env['EXTENSION_PATH'];
  delete process.env['MARKETPLACE_PATH'];
  for (const dir of [wsRepo, cardRepo]) {
    fsSyncNs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('interactive exit path — status settled before watcher spawn', () => {
  it('spawns the branch-cleanup watcher only after the card status is settled to needs_review', async () => {
    const agentChild = createMockChild({ pid: 1111 });
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes('--branch-cleanup')) {
        // This is the moment the detached watcher child would read the card
        // status. Capture the on-disk value at exactly this point.
        const meta = JSON.parse(fsSyncNs.readFileSync(path.join(cardRepo, 'CARD.meta.json'), 'utf-8')) as {
          status?: string;
        };
        statusAtWatcherSpawn = meta.status ?? null;
        const watcherChild = createMockChild({ pid: 2222 });
        // Resolve the parent's grace-period race once the exit listener is
        // registered (synchronously after spawn returns).
        setImmediate(() => {
          (watcherChild as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('exit', 0, null);
        });
        return watcherChild;
      }
      return agentChild;
    }) as unknown as typeof spawn);

    const { spawnClaudeSession } = await import('../src/lib/claude-session.js');
    const context = createMockContext();
    const promise = spawnClaudeSession(baseInput(), context, {
      prompt: 'test prompt',
      sessionId: 'session-123',
      resume: false,
      supportsSwitchToInteractive: false
    });

    // The session's setup runs real git/fetch I/O before it registers the
    // child's close listener — wait for the registration, then let the agent
    // "exit" so the post-exit path runs.
    await vi.waitFor(() => {
      expect(vi.mocked(agentChild.on)).toHaveBeenCalledWith('close', expect.any(Function));
    });
    (agentChild as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('close', 0);
    await promise;

    // DESIRED post-fix behavior — this assertion FAILS on current code, which
    // spawns the watcher while CARD.meta.json still says `active`.
    expect(statusAtWatcherSpawn).toBe('needs_review');

    // The sweep the detached child would run against the same state must now
    // find the branch merged, the worktree idle, and reclaim all three: the
    // worktree directory, the branch ref, and the branches/ entry.
    const { cleanupMergedBranches } = await import('../src/lib/claude-session.js');
    const outcomes = await cleanupMergedBranches(
      { cardId: 'card-123', repoRoot: wsRepo },
      cardRepo,
      createMockLogger(),
      'session-123'
    );
    expect(outcomes).toContainEqual(expect.objectContaining({ branch: 'cards/card-123/1', action: 'cleaned' }));
    expect(fsSyncNs.existsSync(wtPath)).toBe(false);
    expect(git(wsRepo, ['branch', '--list', 'cards/card-123/1'])).toBe('');
    expect(fsSyncNs.existsSync(branchesEntryPath)).toBe(false);
  });
});

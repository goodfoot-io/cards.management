/**
 * Reproduction for: `cards <id> attach` on an already-bound worktree can
 * proceed past the bind gate and silently re-bind (or surface a downstream
 * registration error) instead of refusing with "already bound".
 *
 * Hypothesis under test: attachCard()'s gate 2 consults ONLY the
 * `.cards/CARD_ID` marker. A worktree whose binding machinery survives marker
 * loss — per-worktree `core.hooksPath` pointed at the cards shared hooks dir,
 * the durable artifact outfitWorktreeForCard installs and
 * releaseWorktreeForCard removes — is treated as unbound: gate 2 passes, and
 * attach re-binds the worktree to a different card (outfitWorktreeForCard
 * invoked, branch record overwritten) instead of refusing. Correct behavior:
 * the bind gate must also consult the cards hooks evidence and refuse with
 * "already bound to card <id>", deriving the id from the `cards/<id>/<n>`
 * branch name when the marker is missing. This test MUST FAIL against the
 * current unfixed code.
 *
 * @summary attachCard re-binds a worktree whose cards hooks survive marker loss instead of refusing
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir as realTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceRemoveSync } from '../helpers/forceRemove.js';

// Mock outfitWorktreeForCard so we can assert the bind gate refused before
// any outfit (re-bind) attempt was made. cardsSharedHooksDir stays REAL: the
// bind gate's durable-evidence probe must compare against the same shared
// hooks dir outfit installs, resolved from the test's HOME.
const outfitWorktreeForCard = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve());
vi.mock('@cards.management/sdk/worktree-for-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/worktree-for-card')>();
  return {
    ...actual,
    outfitWorktreeForCard: (...args: unknown[]) => outfitWorktreeForCard(...args)
  };
});

const readUnboundCandidates = vi.fn<
  (...args: unknown[]) => Promise<{ worktreeDir: string; sessionId: string; transcriptPath: string }[]>
>(() => Promise.resolve([]));
const removeUnboundCandidate = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@cards.management/sdk/unbound-worktree-candidates', () => ({
  readUnboundCandidates: (...args: unknown[]) => readUnboundCandidates(...args),
  removeUnboundCandidate: (...args: unknown[]) => removeUnboundCandidate(...args)
}));

vi.mock('@cards.management/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk')>();
  return {
    ...actual,
    resolveExtensionPath: vi.fn(() => Promise.resolve('/tmp/ext-install'))
  };
});

import { attachCard } from '../../src/bin/cards.js';

/**
 * Restores an environment variable to a previously-saved value, deleting it
 * when the saved value is `undefined` (i.e. it was unset before the test).
 *
 * @param key - Environment variable name.
 * @param saved - The value captured before the test mutated it.
 */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = saved;
  }
}

describe('attachCard bind gate with cards hooks present but marker missing', () => {
  let testDir: string;
  let server: Server;
  /** Cards stored in the test server, keyed by ID. */
  let cards: Map<string, Record<string, unknown>>;
  /** Number of HTTP requests the test server received. */
  let requestCount: number;
  let savedHome: string | undefined;
  let savedCardsHome: string | undefined;
  let savedXdgDataHome: string | undefined;
  let savedXdgConfigHome: string | undefined;

  /** A main repo + linked worktree that attachCard is invoked from. */
  let base: string;
  let origCwd: string;
  let savedSessionId: string | undefined;
  let savedTranscript: string | undefined;
  /** Spy on process.exit so exits throw instead of killing the process. */
  let exitSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Absolute path of the cards shared hooks dir under the mocked home.
   *
   * @returns The shared hooks dir path the bind gate compares against.
   */
  function sharedHooksDir(): string {
    return join(testDir, '.cards', 'workspace-hooks');
  }

  /**
   * Creates a real linked git worktree (git-dir ≠ common-dir) checked out on
   * `branchName`, with `branch.<name>.cardsParent` configured so parent-branch
   * resolution succeeds, and with the per-worktree `core.hooksPath` pointing
   * at the cards shared hooks dir — the durable state outfitWorktreeForCard
   * installs on a card-bound worktree. Deliberately does NOT write
   * `.cards/CARD_ID` (the marker whose loss leaves this state behind).
   *
   * @param branchName - Branch to check out in the new linked worktree.
   * @returns Absolute (realpath'd) worktree root.
   */
  function makeOutfittedWorktree(branchName: string): string {
    const mainRepo = join(base, 'main');
    execFileSync('git', ['init', '-q', '-b', 'main', mainRepo]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: mainRepo });
    const linkedRaw = join(base, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', branchName, linkedRaw], { cwd: mainRepo });
    const linkedWorktree = realpathSync(linkedRaw);
    execFileSync('git', ['config', `branch.${branchName}.cardsParent`, 'main'], { cwd: linkedWorktree });
    // Mirror outfitWorktreeForCard's durable bind artifacts: worktree config
    // enabled, per-worktree hooksPath → cards shared hooks dir.
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: linkedWorktree });
    execFileSync('git', ['config', '--worktree', 'core.hooksPath', sharedHooksDir()], { cwd: linkedWorktree });
    return linkedWorktree;
  }

  beforeEach(async () => {
    cards = new Map();
    requestCount = 0;

    // Temp home so resolveHomeDir()-derived shared hooks dir lands in testDir.
    testDir = join(realTmpdir(), `card-bind-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.cards', 'workspace-hooks'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = testDir;
    savedCardsHome = process.env['CARDS_HOME'];
    savedXdgDataHome = process.env['XDG_DATA_HOME'];
    savedXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    process.env['CARDS_HOME'] = join(testDir, '.cards');
    delete process.env['XDG_DATA_HOME'];
    delete process.env['XDG_CONFIG_HOME'];

    // Minimal HTTP server: attach only needs GET /cards/:id. Every request is
    // counted so tests can assert the bind gate refused before ANY API contact
    // (the property that keeps a server-side workspace-registration error from
    // ever substituting for the local already-bound refusal).
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestCount += 1;
      const url = new URL(req.url ?? '/', `http://localhost`);
      const getCardMatch = url.pathname.match(/^\/cards\/([^/]+)$/);
      if ((req.method ?? 'GET') === 'GET' && getCardMatch) {
        const card = cards.get(getCardMatch[1]!);
        if (!card) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const port = (server.address() as AddressInfo).port;
    writeFileSync(
      join(testDir, '.cards', 'cards-api.json'),
      JSON.stringify({
        host: 'localhost',
        port,
        accessToken: 'test-token',
        pid: 12345,
        startedAt: '2024-01-01T00:00:00Z'
      })
    );

    // Worktree fixture state.
    origCwd = process.cwd();
    savedSessionId = process.env['CARDS_SESSION_ID'];
    savedTranscript = process.env['CARDS_TRANSCRIPT_PATH'];
    base = realpathSync(
      (() => {
        const b = join(realTmpdir(), `card-bind-marker-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(b, { recursive: true });
        return b;
      })()
    );
    outfitWorktreeForCard.mockClear();
    removeUnboundCandidate.mockClear();
    readUnboundCandidates.mockClear();
    readUnboundCandidates.mockResolvedValue([]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    // Post-connection gates set `process.exitCode` and return; clear it so it
    // does not leak into sibling tests or fail the runner.
    process.exitCode = undefined;
    process.chdir(origCwd);
    restoreEnv('CARDS_SESSION_ID', savedSessionId);
    restoreEnv('CARDS_TRANSCRIPT_PATH', savedTranscript);
    forceRemoveSync(base);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    forceRemoveSync(testDir);
    restoreEnv('HOME', savedHome);
    restoreEnv('CARDS_HOME', savedCardsHome);
    restoreEnv('XDG_DATA_HOME', savedXdgDataHome);
    restoreEnv('XDG_CONFIG_HOME', savedXdgConfigHome);
  });

  it('refuses with already bound (id from branch) when marker is missing but cards hooks are installed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      cards.set('main-001', {
        id: 'main-001',
        title: 'Bind Target',
        status: 'active',
        repositoryPath: '/tmp/test-card-repo'
      });
      const linkedWorktree = makeOutfittedWorktree('cards/main-007/1');
      process.chdir(linkedWorktree);
      process.env['CARDS_SESSION_ID'] = 'sess-marker-loss';
      process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/transcript.jsonl';

      await expect(attachCard('main-001')).rejects.toThrow('process.exit(1)');
      const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(diagnostic).toContain('already bound to card main-007');
      expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      // Refusal must be local: no request may reach the API from an
      // already-bound worktree, so no server-side error can ever substitute
      // for the already-bound message.
      expect(requestCount).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('refuses with already bound (id from branch) when the marker file is present but empty', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const linkedWorktree = makeOutfittedWorktree('cards/main-007/1');
      // Marker exists but carries no id — the refusal must still name the
      // bound card, derived from the branch.
      mkdirSync(join(linkedWorktree, '.cards'), { recursive: true });
      writeFileSync(join(linkedWorktree, '.cards', 'CARD_ID'), '   \n');
      process.chdir(linkedWorktree);
      process.env['CARDS_SESSION_ID'] = 'sess-empty-marker';

      await expect(attachCard('main-001')).rejects.toThrow('process.exit(1)');
      const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(diagnostic).toContain('already bound to card main-007');
      expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      expect(requestCount).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('refuses as already bound when hooks point at the cards dispatcher but the branch is not cards-named', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      cards.set('main-001', {
        id: 'main-001',
        title: 'Bind Target',
        status: 'active',
        repositoryPath: '/tmp/test-card-repo'
      });
      const linkedWorktree = makeOutfittedWorktree('feature/other');
      process.chdir(linkedWorktree);
      process.env['CARDS_SESSION_ID'] = 'sess-unknown-id';

      await expect(attachCard('main-001')).rejects.toThrow('process.exit(1)');
      const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(diagnostic).toContain('already bound');
      expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      expect(requestCount).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('refuses a marker-bound worktree locally, before any API request', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const linkedWorktree = makeOutfittedWorktree('cards/main-007/1');
      // The primary bind record: a marker naming the bound card.
      mkdirSync(join(linkedWorktree, '.cards'), { recursive: true });
      writeFileSync(join(linkedWorktree, '.cards', 'CARD_ID'), 'main-007\n');
      process.chdir(linkedWorktree);
      process.env['CARDS_SESSION_ID'] = 'sess-marker-pin';

      await expect(attachCard('main-001')).rejects.toThrow('process.exit(1)');
      const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(diagnostic).toContain('already bound to card main-007');
      expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      // The bind refusal must stay pre-network: zero requests to the API.
      // If a refactor ever moves the bind gate behind connectClient(), a
      // server-side error (e.g. "Workspace not registered") could substitute
      // for the local already-bound message — this assertion fails first.
      expect(requestCount).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});

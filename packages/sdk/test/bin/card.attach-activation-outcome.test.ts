/**
 * Reproduction for: `cards <id> attach` reports plain success (exit 0 +
 * card-repo-log on stdout) even when session activation was silently skipped
 * inside outfitWorktreeForCard (de-dupe lock held by another card, card not
 * activatable, attribution preflight failed).
 *
 * Hypothesis under test: attachCard() ignores any activation outcome returned by
 * outfitWorktreeForCard and unconditionally prints the success payload and
 * completes with exit 0. The fail-closed contract applies when activation
 * or attribution preflight fails after a transcript exists. Missing transcript
 * is deliberately different: binding succeeds, streaming is unavailable, and
 * attach exits 0 after warning rather than converting the completed bind into
 * a partial failure.
 *
 * @summary attachCard activation failure and no-transcript degraded-success contracts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir as realTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceRemoveSync } from '../helpers/forceRemove.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => process.env['MOCK_HOMEDIR'] || '/tmp')
  };
});

// Mock the worktree-outfit orchestrator so we can have it report that session
// activation was skipped (e.g. the de-dupe lock is held by another card).
const outfitWorktreeForCard = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve());
vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  outfitWorktreeForCard: (...args: unknown[]) => outfitWorktreeForCard(...args)
}));

// Mock the candidate-set reads/removals so attach never touches the global
// cards config dir.
const readUnboundCandidates = vi.fn<
  (...args: unknown[]) => Promise<{ worktreeDir: string; sessionId: string; transcriptPath: string }[]>
>(() => Promise.resolve([]));
const removeUnboundCandidate = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@cards.management/sdk/unbound-worktree-candidates', () => ({
  readUnboundCandidates: (...args: unknown[]) => readUnboundCandidates(...args),
  removeUnboundCandidate: (...args: unknown[]) => removeUnboundCandidate(...args)
}));

// resolveExtensionPath is invoked only to build compiledScriptPaths for the
// (mocked) outfit call; stub it so it never touches the real install.
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

describe('attachCard activation outcome (fail-closed)', () => {
  let testDir: string;
  let server: Server;
  /** Cards stored in the test server, keyed by ID. */
  let cards: Map<string, Record<string, unknown>>;
  let savedCardsHome: string | undefined;
  let savedXdgDataHome: string | undefined;
  let savedXdgConfigHome: string | undefined;

  /** A main repo + linked worktree that attachCard is invoked from. */
  let base: string;
  let mainRepo: string;
  let linkedWorktree: string;
  let origCwd: string;
  let savedSessionId: string | undefined;
  let savedTranscript: string | undefined;
  /** Spy on process.exit so exits throw instead of killing the process. */
  let exitSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Creates a real linked git worktree (git-dir ≠ common-dir) so
   * resolveLinkedWorktreeDir treats it as a bind target, with
   * `branch.feature/bind.cardsParent` configured so parent-branch resolution
   * succeeds.
   */
  function makeLinkedWorktree(): void {
    mainRepo = join(base, 'main');
    execFileSync('git', ['init', '-q', '-b', 'main', mainRepo]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: mainRepo });
    const linkedRaw = join(base, 'linked');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/bind', linkedRaw], { cwd: mainRepo });
    linkedWorktree = realpathSync(linkedRaw);
    execFileSync('git', ['config', 'branch.feature/bind.cardsParent', 'main'], { cwd: linkedWorktree });
  }

  beforeEach(async () => {
    cards = new Map();

    // Create temp directory for homedir mock and pin discovery to it.
    testDir = join(realTmpdir(), `card-bind-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.cards'), { recursive: true });
    process.env['MOCK_HOMEDIR'] = testDir;
    savedCardsHome = process.env['CARDS_HOME'];
    savedXdgDataHome = process.env['XDG_DATA_HOME'];
    savedXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    process.env['CARDS_HOME'] = join(testDir, '.cards');
    delete process.env['XDG_DATA_HOME'];
    delete process.env['XDG_CONFIG_HOME'];

    // Minimal HTTP server: attach only needs GET /cards/:id.
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
        const b = join(realTmpdir(), `card-bind-outcome-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    // The partial-activation gate sets `process.exitCode` (instead of a
    // libuv-racing synchronous `process.exit`) and returns; clear it so it does
    // not leak into sibling tests or fail the runner.
    process.exitCode = undefined;
    process.chdir(origCwd);
    restoreEnv('CARDS_SESSION_ID', savedSessionId);
    restoreEnv('CARDS_TRANSCRIPT_PATH', savedTranscript);
    forceRemoveSync(base);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    forceRemoveSync(testDir);
    delete process.env['MOCK_HOMEDIR'];
    restoreEnv('CARDS_HOME', savedCardsHome);
    restoreEnv('XDG_DATA_HOME', savedXdgDataHome);
    restoreEnv('XDG_CONFIG_HOME', savedXdgConfigHome);
  });

  it('succeeds with context when attribution is skipped only because no transcript exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      makeLinkedWorktree();
      // Give the card-repository fixture one path-bearing commit so the real
      // context builder has content to emit after the degraded-success bind.
      writeFileSync(join(mainRepo, 'CARD.md'), 'context fixture\n');
      execFileSync('git', ['add', 'CARD.md'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-q', '-m', 'card context'], { cwd: mainRepo });
      cards.set('main-001', {
        id: 'main-001',
        title: 'Bind Target',
        status: 'todo',
        repositoryPath: mainRepo
      });
      process.chdir(linkedWorktree);
      process.env['CARDS_SESSION_ID'] = 'sess-no-transcript';
      delete process.env['CARDS_TRANSCRIPT_PATH'];
      outfitWorktreeForCard.mockResolvedValue({
        attribution: 'skipped',
        reason: 'no-transcript',
        registrationRevision: 'revision-1'
      });

      await expect(attachCard('main-001')).resolves.toBeUndefined();

      expect(process.exitCode).not.toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(removeUnboundCandidate).toHaveBeenCalledWith('sess-no-transcript', linkedWorktree);
      expect(errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain(
        'session streaming is disabled for this attach'
      );
      expect(logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain(
        '<card-repo-log order="oldest-first">'
      );
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('exits non-zero when outfitWorktreeForCard reports activation was skipped', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      makeLinkedWorktree();
      cards.set('main-001', {
        id: 'main-001',
        title: 'Bind Target',
        status: 'active',
        repositoryPath: '/tmp/test-card-repo'
      });
      process.chdir(linkedWorktree);
      process.env['CARDS_SESSION_ID'] = 'sess-skipped-activation';
      process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/transcript.jsonl';

      // Activation was silently skipped: the card is not in an activatable
      // state, so the worktree got its branch registered but the card was
      // never activated and attribution never attached.
      outfitWorktreeForCard.mockResolvedValue({ activated: false, reason: 'not-activatable' });

      // Fail-closed contract: attach must NOT complete as a plain success.
      // Primary expectation: a non-zero exit code so scripted callers can detect
      // that the card was not activated. This gate runs AFTER the CardsClient +
      // `outfitWorktreeForCard` opened sockets, so it sets `process.exitCode` and
      // returns rather than calling `process.exit` (which races libuv teardown →
      // 0xC0000409 on Windows). The function therefore resolves.
      await expect(attachCard('main-001')).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();

      // And the diagnostic must make the partial state unmistakable.
      const stderr = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(stderr).toMatch(/not activated/i);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

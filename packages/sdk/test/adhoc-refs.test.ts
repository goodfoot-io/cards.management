/**
 * Tests for ad-hoc reference handling and the reconciliation sweep.
 *
 * Real filesystem and real processes only — no mocks. A CARDS_HOME-isolated
 * tmp dir holds the `adhoc-active/` refs; real git repos back the sweep's
 * status transition; real `sleep`/dead PIDs drive liveness checks.
 *
 * @summary adhoc-refs sweep and ref liveness tests
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adhocActiveDir,
  liveRefsRemain,
  reconcileStrandedActiveCards,
  serializeRef,
  writeRef
} from '../src/bin/adhoc-refs.js';

const noopLogger = { warn: () => {} };

function spawnSleep(): ChildProcess {
  // A real long-lived process to read a PID from. `sleep` is absent on Windows,
  // so use node itself (cross-platform) to stay alive for 30s.
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
}

function initCardRepo(repoDir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
}

describe('adhoc-refs CARDS_HOME-isolated suite', () => {
  let cardsHome: string;
  let originalCardsHome: string | undefined;

  beforeEach(async () => {
    cardsHome = await mkdtemp(join(tmpdir(), 'adhoc-refs-home-'));
    originalCardsHome = process.env['CARDS_HOME'];
    process.env['CARDS_HOME'] = cardsHome;
  });

  afterEach(async () => {
    if (originalCardsHome === undefined) {
      delete process.env['CARDS_HOME'];
    } else {
      process.env['CARDS_HOME'] = originalCardsHome;
    }
    await rm(cardsHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('writeRef + liveRefsRemain start-time reuse', () => {
    // Start-time reuse detection is POSIX-only: on Windows readProcessStartTime
    // returns null (see process-utils.ts), so a mismatched token degrades to
    // plain PID liveness and a live PID's ref is correctly kept, not unlinked.
    it.skipIf(process.platform === 'win32')('treats a ref whose start-time no longer matches as dead', async () => {
      const cardId = 'main-1';
      await mkdir(adhocActiveDir(cardId), { recursive: true });

      const child = spawnSleep();
      const livePid = child.pid!;
      try {
        // Write a ref for the live PID but with a deliberately wrong start-time.
        await writeFile(join(adhocActiveDir(cardId), 'other-session.ref'), serializeRef(livePid, 'WRONG-START-TIME'));
        // PID is alive but identity mismatches → treated as dead, ref unlinked.
        expect(await liveRefsRemain(cardId, 'dying', noopLogger)).toBe(false);
        await expect(access(join(adhocActiveDir(cardId), 'other-session.ref'))).rejects.toMatchObject({
          code: 'ENOENT'
        });
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('keeps a ref whose PID and start-time both match', async () => {
      const cardId = 'main-1';
      await mkdir(adhocActiveDir(cardId), { recursive: true });
      const child = spawnSleep();
      const livePid = child.pid!;
      try {
        await writeRef(cardId, 'other-session', livePid);
        expect(await liveRefsRemain(cardId, 'dying', noopLogger)).toBe(true);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  describe('reconcileStrandedActiveCards', () => {
    let reposRoot: string;

    beforeEach(async () => {
      reposRoot = await mkdtemp(join(tmpdir(), 'adhoc-repos-'));
    });

    afterEach(async () => {
      await rm(reposRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    async function seedCardRepo(cardId: string, status: string): Promise<string> {
      const repoDir = join(reposRoot, cardId);
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, 'CARD.meta.json'), JSON.stringify({ id: cardId, status }, null, 2));
      initCardRepo(repoDir);
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
      return repoDir;
    }

    it('settles a card whose only ref is a dead monitor', async () => {
      const cardId = 'main-1';
      const repoDir = await seedCardRepo(cardId, 'active');
      await mkdir(adhocActiveDir(cardId), { recursive: true });
      // Dead-PID ref (guaranteed-dead high PID).
      await writeFile(join(adhocActiveDir(cardId), 'dead-session.ref'), serializeRef(2147483646, '12345'));

      await reconcileStrandedActiveCards(reposRoot, noopLogger);

      const meta = JSON.parse(await readFile(join(repoDir, 'CARD.meta.json'), 'utf-8')) as { status?: string };
      expect(meta.status).toBe('needs_review');
      // Stale ref removed.
      await expect(access(join(adhocActiveDir(cardId), 'dead-session.ref'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('leaves a card with a live monitor untouched', async () => {
      const cardId = 'main-1';
      const repoDir = await seedCardRepo(cardId, 'active');
      await mkdir(adhocActiveDir(cardId), { recursive: true });
      const child = spawnSleep();
      const livePid = child.pid!;
      try {
        await writeRef(cardId, 'live-session', livePid);
        await reconcileStrandedActiveCards(reposRoot, noopLogger);

        const meta = JSON.parse(await readFile(join(repoDir, 'CARD.meta.json'), 'utf-8')) as { status?: string };
        // Healthy card — left active, ref intact.
        expect(meta.status).toBe('active');
        await expect(access(join(adhocActiveDir(cardId), 'live-session.ref'))).resolves.toBeUndefined();
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('does not flip a card that is not active (guarded by transitionCardStatus)', async () => {
      const cardId = 'main-1';
      const repoDir = await seedCardRepo(cardId, 'done');
      await mkdir(adhocActiveDir(cardId), { recursive: true });
      await writeFile(join(adhocActiveDir(cardId), 'dead-session.ref'), serializeRef(2147483646, '12345'));

      await reconcileStrandedActiveCards(reposRoot, noopLogger);

      const meta = JSON.parse(await readFile(join(repoDir, 'CARD.meta.json'), 'utf-8')) as { status?: string };
      expect(meta.status).toBe('done');
    });

    it('no-ops when reposRoot is null', async () => {
      await expect(reconcileStrandedActiveCards(null, noopLogger)).resolves.toBeUndefined();
    });

    it('skips a bound card with no active-ref files (regression: invisible to sweep)', async () => {
      // A card bound to a worktree but with no .ref files in its adhoc-active
      // dir is completely invisible to the reconciliation sweep: its status is
      // never transitioned, even if it is active. This guards the invariant
      // that motivates writing the adhoc ref atomically-with the `active` flip.
      const cardId = 'main-1';
      const repoDir = await seedCardRepo(cardId, 'active');
      // Create the adhoc-active dir for the card (simulating it is bound to a
      // worktree), but do not write any .ref files.
      await mkdir(adhocActiveDir(cardId), { recursive: true });

      await reconcileStrandedActiveCards(reposRoot, noopLogger);

      // Card status must remain unchanged; the sweep skips it entirely.
      const meta = JSON.parse(await readFile(join(repoDir, 'CARD.meta.json'), 'utf-8')) as { status?: string };
      expect(meta.status).toBe('active');
    });

    it('skips a bound card when ref dir does not exist (regression: invisible to sweep)', async () => {
      // A card may be bound but have no adhoc-active dir at all (the binding
      // marker exists, but no ref files have ever been written). The sweep must
      // skip such cards entirely.
      const cardId = 'main-2';
      const repoDir = await seedCardRepo(cardId, 'active');
      // Do NOT create adhoc-active dir for this card.

      await reconcileStrandedActiveCards(reposRoot, noopLogger);

      // Card status must remain unchanged; the sweep skips it entirely.
      const meta = JSON.parse(await readFile(join(repoDir, 'CARD.meta.json'), 'utf-8')) as { status?: string };
      expect(meta.status).toBe('active');
    });
  });
});

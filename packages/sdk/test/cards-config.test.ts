/**
 * Tests the shared Cards global config directory resolver.
 *
 * @summary Tests Cards config directory resolution
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CARDS_DIR_NAME,
  generateRepoId,
  resolveGlobalCardsConfigDir,
  resolveMainRepoRoot,
  resolveSlotRoot,
  resolveWorktreeDir,
  resolveWorktreesRoot
} from '../src/cards-config.js';

const originalCardsHome = process.env['CARDS_HOME'];
const originalCardsWorktreesDir = process.env['CARDS_WORKTREES_DIR'];
const originalXdgDataHome = process.env['XDG_DATA_HOME'];
const originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];

function restoreEnv(): void {
  if (originalCardsHome === undefined) {
    delete process.env['CARDS_HOME'];
  } else {
    process.env['CARDS_HOME'] = originalCardsHome;
  }

  if (originalXdgDataHome === undefined) {
    delete process.env['XDG_DATA_HOME'];
  } else {
    process.env['XDG_DATA_HOME'] = originalXdgDataHome;
  }

  if (originalCardsWorktreesDir === undefined) {
    delete process.env['CARDS_WORKTREES_DIR'];
  } else {
    process.env['CARDS_WORKTREES_DIR'] = originalCardsWorktreesDir;
  }

  if (originalXdgConfigHome === undefined) {
    delete process.env['XDG_CONFIG_HOME'];
  } else {
    process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
  }
}

afterEach(() => {
  restoreEnv();
});

describe('resolveGlobalCardsConfigDir', () => {
  it('uses CARDS_HOME when set', () => {
    process.env['CARDS_HOME'] = '/custom/cards-home';
    delete process.env['XDG_DATA_HOME'];
    delete process.env['XDG_CONFIG_HOME'];

    expect(resolveGlobalCardsConfigDir()).toBe('/custom/cards-home');
  });

  it('falls back to XDG_DATA_HOME/.cards', () => {
    delete process.env['CARDS_HOME'];
    process.env['XDG_DATA_HOME'] = '/custom/xdg-data';
    delete process.env['XDG_CONFIG_HOME'];

    expect(resolveGlobalCardsConfigDir()).toBe(path.join('/custom/xdg-data', CARDS_DIR_NAME));
  });

  it('falls back to XDG_CONFIG_HOME/.cards', () => {
    delete process.env['CARDS_HOME'];
    delete process.env['XDG_DATA_HOME'];
    process.env['XDG_CONFIG_HOME'] = '/custom/xdg-config';

    expect(resolveGlobalCardsConfigDir()).toBe(path.join('/custom/xdg-config', CARDS_DIR_NAME));
  });

  it('falls back to ~/.cards when no env override is set', async () => {
    delete process.env['CARDS_HOME'];
    delete process.env['XDG_DATA_HOME'];
    delete process.env['XDG_CONFIG_HOME'];

    const { homedir } = await import('node:os');
    expect(resolveGlobalCardsConfigDir()).toBe(path.join(homedir(), CARDS_DIR_NAME));
  });

  it('matches extension precedence exactly', () => {
    process.env['CARDS_HOME'] = '/cards-home';
    process.env['XDG_DATA_HOME'] = '/xdg-data';
    process.env['XDG_CONFIG_HOME'] = '/xdg-config';

    expect(resolveGlobalCardsConfigDir()).toBe('/cards-home');

    delete process.env['CARDS_HOME'];
    expect(resolveGlobalCardsConfigDir()).toBe(path.join('/xdg-data', CARDS_DIR_NAME));
  });
});

describe('generateRepoId', () => {
  it('generates a stable ID based on repo root', () => {
    const root = '/workspace';
    const id1 = generateRepoId(root);
    const id2 = generateRepoId(root);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^workspace-[0-9a-f]{8}$/);
  });

  it('generates different IDs for different roots', () => {
    const id1 = generateRepoId('/workspace/a');
    const id2 = generateRepoId('/workspace/b');

    expect(id1).not.toBe(id2);
  });
});

describe('resolveWorktreeDir', () => {
  it('resolves the centralized worktree path', () => {
    process.env['CARDS_HOME'] = '/custom/cards-home';
    const repoRoot = '/workspace';
    const ref = 'main-123';

    const worktreeDir = resolveWorktreeDir(repoRoot, ref);
    const repoId = generateRepoId(repoRoot);

    expect(worktreeDir).toBe(path.join('/custom/cards-home', 'worktrees', repoId, ref));
  });

  it('uses CARDS_WORKTREES_DIR as the only supported worktree root override', () => {
    process.env['CARDS_WORKTREES_DIR'] = '/tmp/cards-worktrees';
    const repoRoot = '/workspace';
    const ref = 'cards/main-123/1';

    expect(resolveWorktreesRoot()).toBe('/tmp/cards-worktrees');
    expect(resolveWorktreeDir(repoRoot, ref)).toBe(path.join('/tmp/cards-worktrees', generateRepoId(repoRoot), ref));
  });
});

describe('resolveSlotRoot', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com'
  };

  it('derives the same slot root from a linked worktree as from the main repository [R12]', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cards-slot-root-')));
    try {
      process.env['CARDS_WORKTREES_DIR'] = path.join(dir, 'worktrees');
      const main = path.join(dir, 'main');
      const linked = path.join(dir, 'linked');
      const git = (cwd: string, ...args: string[]): void => {
        execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' });
      };
      execFileSync('git', ['init', '--quiet', main], { env: GIT_ENV, stdio: 'ignore' });
      git(main, 'commit', '--allow-empty', '--quiet', '-m', 'root');
      git(main, 'worktree', 'add', '--quiet', '-b', 'side', linked);

      expect(await resolveMainRepoRoot(linked)).toBe(main);
      const expected = resolveWorktreeDir(main, 'cards/main-734');
      expect(await resolveSlotRoot(main, 'main-734')).toBe(expected);
      expect(await resolveSlotRoot(linked, 'main-734')).toBe(expected);
      expect(expected).not.toBe(resolveWorktreeDir(linked, 'cards/main-734'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the workspace has no .git marker', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cards-slot-root-'));
    try {
      await expect(resolveSlotRoot(dir, 'main-734')).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

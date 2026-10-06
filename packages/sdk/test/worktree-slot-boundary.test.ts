/**
 * Real-Git boundaries keep dedicated runtime slots out of generic SDK tools.
 * A slot is identified by where it lives, the `cards` namespace under the
 * repository's worktree directory, never by what its HEAD names, so no ref
 * spelling can create into, over or above slots, and a slot is refused for
 * removal whether its HEAD is on its branch, detached or switched.
 * @summary Generic worktree operations preserve reserved slots
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isInSlotNamespace,
  resolveSlotNamespace,
  resolveWorktreeDir,
  SlotNamespaceError
} from '../src/cards-config.js';
import type { CardsClient } from '../src/client/cardsClient.js';
import { assertRefOutsideSlotNamespace, createWorktree, removeWorktree } from '../src/worktree.js';
import { createWorktreeForCard, releaseWorktreeForCard, removeWorktreeForCard } from '../src/worktreeForCard.js';

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const removeBin = fileURLToPath(new URL('../src/bin/remove-worktree.ts', import.meta.url));
const createBin = fileURLToPath(new URL('../src/bin/create-worktree.ts', import.meta.url));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('generic SDK dedicated-slot boundary', () => {
  let base = '';
  let repo = '';
  let root = '';
  let priorRoot: string | undefined;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sdk-slot-boundary-')));
    repo = join(base, 'repo');
    root = join(base, 'worktrees');
    await mkdir(repo);
    await mkdir(root);
    priorRoot = process.env['CARDS_WORKTREES_DIR'];
    process.env['CARDS_WORKTREES_DIR'] = root;
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await mkdir(join(repo, 'packages'));
    await writeFile(join(repo, 'packages', 'f.txt'), 'committed content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'fixture');
  });

  afterEach(async () => {
    if (priorRoot === undefined) delete process.env['CARDS_WORKTREES_DIR'];
    else process.env['CARDS_WORKTREES_DIR'] = priorRoot;
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /**
   * A live slot `cards/x/1` with uncommitted work and a lock file, as card launches leave it.
   * @returns The slot path and a snapshot function of everything that must survive.
   */
  async function liveSlot(): Promise<{ slot: string; snapshot: () => Promise<unknown> }> {
    const namespace = resolveSlotNamespace(repo);
    const slot = join(namespace, 'x', '1');
    git(repo, 'worktree', 'add', '-q', '-b', 'cards/x/1', slot);
    await mkdir(join(namespace, 'x', '.locks'), { recursive: true });
    await writeFile(join(namespace, 'x', '.locks', '1.lock'), 'live');
    await writeFile(join(slot, 'uncommitted.txt'), 'work in progress\n');
    await mkdir(join(slot, '.cards'));
    await writeFile(join(slot, '.cards', 'CARD_ID'), 'x\n');
    await writeFile(join(slot, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), 'original-hooks\n');
    const snapshot = async () => ({
      lock: await readFile(join(namespace, 'x', '.locks', '1.lock'), 'utf8'),
      work: await readFile(join(slot, 'uncommitted.txt'), 'utf8'),
      packages: await readFile(join(slot, 'packages', 'f.txt'), 'utf8'),
      card: await readFile(join(slot, '.cards', 'CARD_ID'), 'utf8'),
      hooks: await readFile(join(slot, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), 'utf8'),
      head: git(slot, 'rev-parse', 'HEAD'),
      registry: git(repo, 'worktree', 'list', '--porcelain'),
      branches: git(repo, 'branch', '--list')
    });
    return { slot, snapshot };
  }

  describe('isInSlotNamespace', () => {
    it.each([
      ['the namespace', 'cards'],
      ['a card directory', 'cards/x'],
      ['a slot', 'cards/x/1'],
      ['inside a slot', 'cards/x/1/packages'],
      ['a slot lock', 'cards/x/.locks/1.lock'],
      ['a not-yet-created slot', 'cards/y/2/a'],
      ['a zero-padded ordinal', 'cards/x/01'],
      ['a trailing separator', 'cards/x/1/'],
      ['a doubled separator', 'cards//x/1'],
      ['a dot segment', './cards/x/1'],
      ['a parent segment', 'other/../cards/x/1'],
      ['the repository directory, which contains it', '.'],
      ['another repository id’s namespace', '../other-repo-1234abcd/cards/x/1'],
      ['another repository id’s directory', '../other-repo-1234abcd'],
      ['the worktrees root', '..']
    ])('holds for %s', async (_case, ref) => {
      await expect(isInSlotNamespace(repo, resolveWorktreeDir(repo, ref))).resolves.toBe(true);
    });

    it.each([
      ['an ordinary branch', 'feature/x'],
      ['a sibling of the namespace', 'cardsx/1'],
      ['a name that only starts with it', 'cards-old/x/1']
    ])('does not hold for %s', async (_case, ref) => {
      await expect(isInSlotNamespace(repo, resolveWorktreeDir(repo, ref))).resolves.toBe(false);
    });

    it('holds for a path that reaches the namespace through a symlink', async () => {
      const namespace = resolveSlotNamespace(repo);
      await mkdir(namespace, { recursive: true });
      const alias = resolveWorktreeDir(repo, 'alias');
      await symlink(namespace, alias, 'dir');
      await expect(isInSlotNamespace(repo, join(alias, 'x', '1'))).resolves.toBe(true);
    });

    it.each(['darwin', 'win32'] as const)('case-folds on %s, where the filesystem ignores case', async (platform) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        await expect(isInSlotNamespace(repo, resolveWorktreeDir(repo, 'Cards/X/1'))).resolves.toBe(true);
      } finally {
        if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor);
      }
    });

    it.runIf(process.platform === 'linux')('treats a different case as a different directory on Linux', async () => {
      await expect(isInSlotNamespace(repo, resolveWorktreeDir(repo, 'Cards/x/1'))).resolves.toBe(false);
    });
  });

  describe('creation', () => {
    it.each([
      'cards',
      'cards/x',
      'cards/x/1',
      'cards/x/1/packages',
      'cards/x/2/a',
      'cards/x/01',
      'cards/x/1.lock',
      'cards/main-88/90071992547409931234567890'
    ])('refuses %s with nothing on disk or in git changed', async (ref) => {
      const { snapshot } = await liveSlot();
      const before = await snapshot();
      let publications = 0;
      const client = {
        addBranch: async () => {
          publications++;
        }
      } as unknown as CardsClient;

      await expect(createWorktree(ref, { cwd: repo })).rejects.toThrow(SlotNamespaceError);
      await expect(
        createWorktreeForCard(client, ref, {
          cwd: repo,
          cardId: 'x',
          parentBranch: 'main',
          registrationIntent: 'create',
          compiledScriptPaths: {}
        })
      ).rejects.toThrow(SlotNamespaceError);
      await expect(assertRefOutsideSlotNamespace(repo, ref)).rejects.toThrow(SlotNamespaceError);

      expect(publications).toBe(0);
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      ['an empty ref, which names the repository directory', ''],
      ['a parent segment, which names the worktrees root', '..'],
      ['a trailing slash', 'cards/x/1/'],
      ['a doubled slash', 'cards//x/1'],
      ['a dot segment', './cards/x/1'],
      ['a backslash', 'cards\\x\\1']
    ])('names %s as an invalid branch name before the namespace guard', async (_case, ref) => {
      const { snapshot } = await liveSlot();
      const before = await snapshot();
      let publications = 0;
      const client = {
        addBranch: async () => {
          publications++;
        }
      } as unknown as CardsClient;

      await expect(createWorktree(ref, { cwd: repo })).rejects.toThrow('Error: Invalid branch name format.');
      await expect(
        createWorktreeForCard(client, ref, {
          cwd: repo,
          cardId: 'x',
          parentBranch: 'main',
          registrationIntent: 'create',
          compiledScriptPaths: {}
        })
      ).rejects.toThrow('Error: Invalid branch name format.');
      await expect(assertRefOutsideSlotNamespace(repo, ref)).rejects.toThrow('Error: Invalid branch name format.');

      expect(publications).toBe(0);
      expect(await snapshot()).toEqual(before);
    });

    it('names the supported way to change slots in the refusal, and the remedy for a deleted card', async () => {
      const refusal = createWorktree('cards/x/1', { cwd: repo });
      await expect(refusal).rejects.toThrow(/Clean Up Worktrees \(the worktreeMaintenance command\)/);
      await expect(refusal).rejects.toThrow(
        'If the card was deleted, see "Worktrees left by a deleted card" ' +
          '(wiki/guides/troubleshooting/failures/public-default-configuration.md#worktrees-left-by-a-deleted-card).'
      );
    });

    it('refuses through the create-worktree CLI with the same message and no change', async () => {
      const { snapshot } = await liveSlot();
      const before = await snapshot();
      let failure: { status: number | null; stderr: string } | undefined;
      try {
        execFileSync(process.execPath, [tsxCli, createBin, 'cards/x'], {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, CARDS_DISCOVERY_PATH: join(base, 'absent.json') }
        });
      } catch (error) {
        failure = error as { status: number | null; stderr: string };
      }
      expect(failure?.status).not.toBe(0);
      expect(failure?.stderr).toContain('worktreeMaintenance');
      expect(await snapshot()).toEqual(before);
    });

    it('still creates an ordinary worktree', async () => {
      const result = await createWorktree('feature/x', { cwd: repo });
      await result.settle;
      expect(result.path).toBe(resolveWorktreeDir(repo, 'feature/x'));
      expect(await readFile(join(result.path, 'packages', 'f.txt'), 'utf8')).toBe('committed content\n');
    });
  });

  describe('stale directory cleanup', () => {
    it('removes a crash remnant at an ordinary path and creates the worktree', async () => {
      const target = resolveWorktreeDir(repo, 'feature/x');
      await mkdir(join(target, 'partial'), { recursive: true });
      await writeFile(join(target, 'partial', 'file'), 'half-written\n');
      const result = await createWorktree('feature/x', { cwd: repo });
      await result.settle;
      expect(existsSync(join(target, 'partial'))).toBe(false);
      expect(existsSync(join(target, 'packages', 'f.txt'))).toBe(true);
    });

    it('refuses to delete a remnant that holds a lock directory at any depth', async () => {
      const target = resolveWorktreeDir(repo, 'feature/x');
      await mkdir(join(target, 'nested', '.locks'), { recursive: true });
      await writeFile(join(target, 'nested', '.locks', '1.lock'), 'live');
      await expect(createWorktree('feature/x', { cwd: repo })).rejects.toThrow(/lock directory/);
      expect(await readFile(join(target, 'nested', '.locks', '1.lock'), 'utf8')).toBe('live');
    });

    it('refuses to delete a remnant that holds a registered worktree', async () => {
      const target = resolveWorktreeDir(repo, 'feature/x');
      const nested = join(target, 'nested');
      git(repo, 'worktree', 'add', '-q', '-b', 'nested', nested);
      await writeFile(join(nested, 'uncommitted.txt'), 'work\n');
      await expect(createWorktree('feature/x', { cwd: repo })).rejects.toThrow(/registered worktree/);
      expect(await readFile(join(nested, 'uncommitted.txt'), 'utf8')).toBe('work\n');
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(nested);
    });
  });

  describe('removal', () => {
    it.each([
      ['on its slot branch', () => undefined],
      ['with a detached HEAD', (slot: string) => git(slot, 'checkout', '-q', '--detach')],
      ['switched to another branch', (slot: string) => git(slot, 'switch', '-q', '-c', 'feature')]
    ])('refuses a slot %s through every removal path', async (_case, prepare) => {
      const { slot, snapshot } = await liveSlot();
      prepare(slot);
      const before = await snapshot();
      let removals = 0;
      const client = {
        removeBranch: async () => {
          removals++;
          return { outcome: 'removed' };
        }
      } as unknown as CardsClient;

      await expect(removeWorktree(slot)).rejects.toThrow(SlotNamespaceError);
      await expect(removeWorktreeForCard(client, slot, { cardId: 'x' })).rejects.toThrow(SlotNamespaceError);
      await expect(releaseWorktreeForCard(client, slot, { cardId: 'x' })).rejects.toThrow(SlotNamespaceError);
      await expect(removeWorktree(join(slot, 'packages', '..'))).rejects.toThrow(SlotNamespaceError);

      for (const discovery of [join(base, 'absent.json'), join(base, 'unreachable.json')]) {
        if (discovery.endsWith('unreachable.json'))
          await writeFile(
            discovery,
            JSON.stringify({
              host: '127.0.0.1',
              port: 1,
              accessToken: 'unused',
              pid: process.pid,
              startedAt: new Date().toISOString()
            })
          );
        let failure: { status: number | null; stderr: string } | undefined;
        try {
          execFileSync(process.execPath, [tsxCli, removeBin, slot], {
            cwd: repo,
            encoding: 'utf8',
            env: { ...process.env, CARDS_DISCOVERY_PATH: discovery }
          });
        } catch (error) {
          failure = error as { status: number | null; stderr: string };
        }
        expect(failure?.status).toBe(2);
        // The refusal alone: no detached-HEAD or API-unavailable warning that the slot is being removed.
        expect(failure?.stderr).toContain('worktreeMaintenance');
        expect(failure?.stderr).not.toContain('Warning');
        expect(failure?.stderr).not.toMatch(/removing worktree/i);
      }

      expect(removals).toBe(0);
      expect(await snapshot()).toEqual(before);
    });

    it('still removes an ordinary card worktree and unregisters its branch', async () => {
      const checkout = resolveWorktreeDir(repo, 'feature/x');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', checkout);
      await mkdir(join(checkout, '.cards'));
      await writeFile(join(checkout, '.cards', 'CARD_ID'), 'x\n');
      const removed: string[] = [];
      const client = {
        removeBranch: async (_card: string, branch: string) => {
          removed.push(branch);
          return { outcome: 'removed' };
        }
      } as unknown as CardsClient;
      await removeWorktreeForCard(client, checkout, { cardId: 'x' });
      expect(existsSync(checkout)).toBe(false);
      expect(removed).toEqual(['feature/x']);
    });

    it('removes an ordinary worktree whose HEAD names a slot-shaped branch, since it is not in the namespace', async () => {
      const checkout = resolveWorktreeDir(repo, 'not-a-slot');
      git(repo, 'worktree', 'add', '-q', '-b', 'cards/y/1', checkout);
      await removeWorktree(checkout);
      expect(existsSync(checkout)).toBe(false);
    });
  });
});

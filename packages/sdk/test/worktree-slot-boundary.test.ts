/**
 * Real-Git boundaries keep dedicated runtime slots out of generic SDK tools.
 * @summary Generic worktree operations preserve reserved slots
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardsClient } from '../src/client/cardsClient.js';
import { createWorktree, removeWorktree } from '../src/worktree.js';
import { createWorktreeForCard, releaseWorktreeForCard, removeWorktreeForCard } from '../src/worktreeForCard.js';

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const removeBin = fileURLToPath(new URL('../src/bin/remove-worktree.ts', import.meta.url));
const slots = ['cards/main-88/1', 'cards/another-card/90071992547409931234567890'];

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
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'committed content\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'fixture']);
  });

  afterEach(async () => {
    if (priorRoot === undefined) delete process.env['CARDS_WORKTREES_DIR'];
    else process.env['CARDS_WORKTREES_DIR'] = priorRoot;
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each(slots)('refuses creation of %s before Git or card publication', async (branch) => {
    let publications = 0;
    const client = {
      addBranch: async () => {
        publications++;
      }
    } as unknown as CardsClient;
    const missingRepo = join(base, 'not-a-repository');
    await expect(createWorktree(branch, { cwd: missingRepo })).rejects.toThrow('Dedicated slots');
    await expect(
      createWorktreeForCard(client, branch, {
        cwd: missingRepo,
        cardId: 'main-88',
        parentBranch: 'main',
        registrationIntent: 'create',
        compiledScriptPaths: {}
      })
    ).rejects.toThrow('Dedicated slots');
    expect(publications).toBe(0);
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' })).toBe('');
  });

  it.each(slots)('preserves %s through bare, bound, release, and unavailable-API CLI removal', async (branch) => {
    const checkout = join(root, 'slot');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', branch, checkout]);
    await mkdir(join(checkout, '.cards'));
    await writeFile(join(checkout, '.cards', 'CARD_ID'), 'main-88\n');
    await writeFile(join(checkout, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), 'original-hooks\n');
    await writeFile(join(checkout, 'README.md'), 'dirty content that must survive\n');
    const oid = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const registry = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    let removals = 0;
    const client = {
      removeBranch: async () => {
        removals++;
      }
    } as unknown as CardsClient;
    await expect(removeWorktree(checkout)).rejects.toThrow('Dedicated slots');
    await expect(removeWorktreeForCard(client, checkout, { cardId: 'main-88' })).rejects.toThrow('Dedicated slots');
    await expect(releaseWorktreeForCard(client, checkout, { cardId: 'main-88' })).rejects.toThrow('Dedicated slots');
    for (const discovery of [join(base, 'absent.json'), join(base, 'unreachable.json')]) {
      if (discovery.endsWith('unreachable.json')) {
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
      }
      let result: { status: number | null; stderr: string } | undefined;
      try {
        execFileSync(process.execPath, [tsxCli, removeBin, checkout], {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, CARDS_DISCOVERY_PATH: discovery }
        });
      } catch (error) {
        result = error as { status: number | null; stderr: string };
      }
      expect(result?.status).toBe(2);
      expect(result?.stderr).toContain('Dedicated slots');
    }
    // The bare CLI path must protect slots even without a card binding marker.
    await rm(join(checkout, '.cards', 'CARD_ID'));
    let bareStatus: number | null | undefined;
    try {
      execFileSync(process.execPath, [tsxCli, removeBin, checkout], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CARDS_DISCOVERY_PATH: join(base, 'absent.json') }
      });
    } catch (error) {
      bareStatus = (error as { status: number | null }).status;
    }
    expect(bareStatus).toBe(2);
    await writeFile(join(checkout, '.cards', 'CARD_ID'), 'main-88\n');
    expect(removals).toBe(0);
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('dirty content that must survive\n');
    expect(await readFile(join(checkout, '.cards', 'CARD_ID'), 'utf8')).toBe('main-88\n');
    expect(await readFile(join(checkout, '.cards', 'CARD_ORIGINAL_HOOK_PATH'), 'utf8')).toBe('original-hooks\n');
    expect(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(oid);
    expect(execFileSync('git', ['-C', repo, 'rev-parse', branch], { encoding: 'utf8' })).toBe(oid);
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).toBe(registry);
  });
});

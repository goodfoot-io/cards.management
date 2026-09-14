/**
 * Tests for shared context-building utilities.
 *
 * @summary Tests for lib/context
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANS_PREFIX } from '@cards.management/sdk/card-repo-layout';
import { BRANCHES_DIR, COMMITS_DIR } from '@cards.management/sdk/protocol';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * Parses the plain-text log body shared by card-repo-log and workspace-repo-log blocks.
 * Each entry is `{sha} • {author}\n{subject}` (or `{sha} [merged] • {author}\n{subject}`),
 * optionally followed by `- {file}` lines, separated by blank lines.
 *
 * @param body - Raw text content between the log XML tags.
 * @returns Array of parsed commit entries.
 */
function parseLogEntries(
  body: string
): Array<{ sha: string; author: string; subject: string; files: string[]; merged?: true }> {
  if (!body.trim()) return [];
  return body.split('\n\n').map((entry) => {
    const lines = entry.split('\n');
    const shaLine = lines[0]!;
    const files: string[] = [];
    const subjectLines: string[] = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith('- ')) {
        files.push(line.slice(2));
      } else {
        subjectLines.push(line);
      }
    }
    const subject = subjectLines.join('\n');
    const mergedMatch = /^(\S+) \[merged\] • (.+)$/.exec(shaLine);
    if (mergedMatch) {
      return { sha: mergedMatch[1]!, author: mergedMatch[2]!, subject, files, merged: true };
    }
    const match = /^(\S+) • (.+)$/.exec(shaLine);
    return { sha: match![1]!, author: match![2]!, subject, files };
  });
}

import {
  buildAdditionalContext,
  buildCardRepoLogBlock,
  buildEnvBlock,
  buildWorkspaceRepoLogBlocks,
  CardRepoAccessError
} from '../../src/shared/context.js';

let testRepo: TestGitWorkspace;
let repoPath: string;

beforeAll(async () => {
  testRepo = new TestGitWorkspace();
  repoPath = await testRepo.create();
});

afterAll(() => {
  testRepo.destroy();
});

describe('buildEnvBlock', () => {
  const makeActionInput = (overrides?: Record<string, unknown>) => ({
    cardId: 'card-123',
    actionName: 'Launch',
    executionId: 'execution-123',
    worktreeDirective: { kind: 'reuse' } as const,
    environment: 'default',
    executionMode: 'interactive' as const,
    exitWhenDone: false,
    repoRoot: '/workspace',
    cardRepoPath: repoPath,
    configPath: '/tmp/config',
    extensionPath: '/tmp/extension',
    switchToInteractiveData: undefined,
    codingAgent: undefined,
    marketplacePath: '/test/marketplace',
    ...overrides
  });

  afterEach(() => {
    delete process.env['WORKSPACE_PATH'];
    delete process.env['WORKSPACE_BRANCH'];
    delete process.env['BASE_BRANCH'];
  });

  it('produces a fenced bash block with all env vars', () => {
    process.env['WORKSPACE_PATH'] = '/workspace';
    process.env['BASE_BRANCH'] = 'main';
    process.env['WORKSPACE_BRANCH'] = 'cards/card-123/1';

    const result = buildEnvBlock(makeActionInput());

    expect(result).toMatch(/^```bash\n/);
    expect(result).toMatch(/\n```$/);
    expect(result).toContain('CARD_ID=card-123');
    expect(result).toContain(`CARD_REPO_PATH=${repoPath}`);
    expect(result).toContain('WORKSPACE_PATH=/workspace');
    expect(result).toContain('BASE_BRANCH=main');
    expect(result).toContain('WORKSPACE_BRANCH=cards/card-123/1');
    expect(result).toContain('EXECUTION_MODE=interactive');
    expect(result).toContain('EXIT_WHEN_DONE=false');
  });

  it('includes EXECUTION_MODE from actionInput.executionMode', () => {
    const result = buildEnvBlock(makeActionInput({ executionMode: 'background' }));

    expect(result).toContain('EXECUTION_MODE=background');
  });

  it('includes EXIT_WHEN_DONE=true when exitWhenDone is true', () => {
    const result = buildEnvBlock(makeActionInput({ exitWhenDone: true }));

    expect(result).toContain('EXIT_WHEN_DONE=true');
  });
});

describe('buildCardRepoLogBlock', () => {
  it('returns plain-text log block with order="oldest-first" attribute', () => {
    const result = buildCardRepoLogBlock(repoPath);

    expect(result).not.toBeNull();
    expect(result).toMatch(/<card-repo-log order="oldest-first">/);
    expect(result).toContain('</card-repo-log>');
    expect(result).not.toContain('type="yaml"');
    expect(result).not.toMatch(/count="\d+"/);
  });

  it('produces plain-text entries with sha, author, subject fields', () => {
    const result = buildCardRepoLogBlock(repoPath);

    expect(result).not.toBeNull();
    const body = result!.replace(/^<card-repo-log[^>]*>\n/, '').replace(/\n<\/card-repo-log>$/, '');
    const entries = parseLogEntries(body);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.sha).toBeTruthy();
      expect(entry.author).toBeTruthy();
      expect(entry.subject).toBeTruthy();
    }
    // TestGitWorkspace creates a "Repository initializes." commit
    expect(entries.some((c) => c.subject === 'Repository initializes.')).toBe(true);
  });

  it('returns null for non-git directory', () => {
    const dir = join(repoPath, '..', `no-git-log-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const result = buildCardRepoLogBlock(dir);

    expect(result).toBeNull();
  });

  it('lists commits in chronological order (oldest first)', async () => {
    const chronoRepo = new TestGitWorkspace();
    const chronoPath = await chronoRepo.create();

    try {
      await chronoRepo.createAndCommitFile('CARD.md', '# First', 'First commit');
      await chronoRepo.createAndCommitFile(`${PLANS_PREFIX}initial.md`, '# Second', 'Second commit');

      const result = buildCardRepoLogBlock(chronoPath);

      expect(result).not.toBeNull();
      const body = result!.replace(/^<card-repo-log[^>]*>\n/, '').replace(/\n<\/card-repo-log>$/, '');
      const entries = parseLogEntries(body);
      const firstIdx = entries.findIndex((c) => c.subject === 'First commit');
      const secondIdx = entries.findIndex((c) => c.subject === 'Second commit');
      expect(firstIdx).toBeLessThan(secondIdx);
    } finally {
      chronoRepo.destroy();
    }
  });

  it('lists files touched by each commit', async () => {
    const fileRepo = new TestGitWorkspace();
    const filePath = await fileRepo.create();

    try {
      await fileRepo.createAndCommitFile('CARD.md', '# Card', 'Add card');
      await fileRepo.createAndCommitFile(`${PLANS_PREFIX}file2.md`, '# Plan', 'Add plan');

      const result = buildCardRepoLogBlock(filePath);

      expect(result).not.toBeNull();
      const body = result!.replace(/^<card-repo-log[^>]*>\n/, '').replace(/\n<\/card-repo-log>$/, '');
      const entries = parseLogEntries(body);

      const addCard = entries.find((c) => c.subject === 'Add card');
      expect(addCard).toBeDefined();
      expect(addCard!.files).toContain('CARD.md');

      const addPlan = entries.find((c) => c.subject === 'Add plan');
      expect(addPlan).toBeDefined();
      expect(addPlan!.files).toContain(`${PLANS_PREFIX}file2.md`);
    } finally {
      fileRepo.destroy();
    }
  });

  describe('.gitignore filtering', () => {
    let gitignoreRepo: TestGitWorkspace;
    let gitignorePath: string;

    beforeAll(async () => {
      gitignoreRepo = new TestGitWorkspace();
      gitignorePath = await gitignoreRepo.create();
      await gitignoreRepo.createAndCommitFile('.gitignore', 'node_modules/\ndist/\n', 'Add gitignore');
      await gitignoreRepo.createAndCommitFile('CARD.md', '# Card\n', 'Add card description');
    }, 120_000);

    afterAll(() => {
      gitignoreRepo.destroy();
    });

    it('omits .gitignore-only commits from log', () => {
      const result = buildCardRepoLogBlock(gitignorePath);

      expect(result).not.toBeNull();
      expect(result).not.toContain('Add gitignore');
    });
  });

  describe('streams filtering', () => {
    let streamsRepo: TestGitWorkspace;
    let streamsPath: string;

    beforeAll(async () => {
      streamsRepo = new TestGitWorkspace();
      streamsPath = await streamsRepo.create();

      await streamsRepo.createAndCommitFile('CARD.md', '# Card\n', 'Add card description');
      await streamsRepo.createAndCommitFile('streams/session/log.jsonl', '{"type":"init"}\n', 'Add session stream');

      const git = streamsRepo.getGit();
      writeFileSync(join(streamsPath, 'streams/session/log.jsonl'), '{"type":"update"}\n');
      writeFileSync(join(streamsPath, 'CARD.md'), '# Updated Card\n');
      await git.add(['streams/session/log.jsonl', 'CARD.md']);
      await git.commit('Update card and stream');
    }, 120_000);

    afterAll(() => {
      streamsRepo.destroy();
    });

    it('omits streams-only commits from log', () => {
      const result = buildCardRepoLogBlock(streamsPath);

      expect(result).not.toBeNull();
      expect(result).not.toContain('Add session stream');
    });

    it('includes mixed commits', () => {
      const result = buildCardRepoLogBlock(streamsPath);

      expect(result).not.toBeNull();
      expect(result).toContain('Update card and stream');
    });
  });
});

describe('buildWorkspaceRepoLogBlocks', () => {
  let workspace: TestGitWorkspace;
  let workspacePath: string;

  let mainCommitSha: string;
  let branch1CommitSha1: string;
  let branch1CommitSha2: string;
  let branch2CommitSha: string;

  beforeAll(async () => {
    workspace = new TestGitWorkspace();
    workspacePath = await workspace.create();
    const git = workspace.getGit();

    await workspace.createAndCommitFile('src/main.ts', 'export const x = 1;', 'feat: main work');
    mainCommitSha = (await git.revparse(['HEAD'])).trim();

    await git.checkout(['-b', 'cards/card-123/1']);
    await workspace.createAndCommitFile('src/auth.ts', 'export function auth() {}', 'feat: implement auth');
    branch1CommitSha1 = (await git.revparse(['HEAD'])).trim();
    await workspace.createAndCommitFile('src/auth.test.ts', 'test("auth")', 'test: auth tests');
    branch1CommitSha2 = (await git.revparse(['HEAD'])).trim();

    await git.checkout(['main']);
    await git.checkout(['-b', 'cards/card-123/2']);
    await workspace.createAndCommitFile('src/api.ts', 'export function api() {}', 'feat: implement api');
    branch2CommitSha = (await git.revparse(['HEAD'])).trim();

    await git.checkout(['main']);
  });

  afterAll(() => {
    workspace.destroy();
  });

  afterEach(() => {
    delete process.env['BASE_BRANCH'];
  });

  function makeCardRepo(branches: Record<string, unknown>, commits: string[]): string {
    const dir = join(workspacePath, '..', `card-repo-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    // Phase-3 decomposed layout: each branch is a per-entry file
    // branches/<encodeURIComponent(name)>.json carrying the authoritative `name`
    // inside, and each attributed commit is a commits/<sha> entry file.
    const branchesDir = join(dir, BRANCHES_DIR);
    mkdirSync(branchesDir, { recursive: true });
    for (const [name, meta] of Object.entries(branches)) {
      writeFileSync(
        join(branchesDir, `${encodeURIComponent(name)}.json`),
        `${JSON.stringify({ name, ...(meta as object) }, null, 2)}\n`
      );
    }
    const commitsDir = join(dir, COMMITS_DIR);
    mkdirSync(commitsDir, { recursive: true });
    for (const sha of commits) {
      writeFileSync(join(commitsDir, sha), `${sha}\n`);
    }
    return dir;
  }

  it('returns empty array when workspace files are missing', () => {
    const dir = join(workspacePath, '..', `no-ws-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toEqual([]);
  });

  it('renders plain-text blocks with branch and count attributes', () => {
    const dir = makeCardRepo({ 'cards/card-123/1': { parentBranch: 'main', addedAt: '2025-01-15T10:30:00Z' } }, [
      branch1CommitSha1,
      branch1CommitSha2
    ]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain('type="yaml"');
    expect(blocks[0]).toContain('branch="cards/card-123/1"');
    expect(blocks[0]).toContain('count="2"');
    expect(blocks[0]).toContain('</workspace-repo-log>');
  });

  it('produces plain-text entries with sha, author, and subject fields', () => {
    const dir = makeCardRepo({ 'cards/card-123/1': { parentBranch: 'main', addedAt: '2025-01-15T10:30:00Z' } }, [
      branch1CommitSha1,
      branch1CommitSha2
    ]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);
    const body = blocks[0]!.replace(/^<workspace-repo-log[^>]*>\n/, '').replace(/\n<\/workspace-repo-log>$/, '');
    const entries = parseLogEntries(body);

    expect(entries.some((c) => c.subject === 'feat: implement auth')).toBe(true);
    expect(entries.some((c) => c.subject === 'test: auth tests')).toBe(true);
    for (const entry of entries) {
      expect(entry.sha).toBeTruthy();
      expect(entry.author).toBeTruthy();
      expect(entry.subject).toBeTruthy();
    }
  });

  it('does not include file lists in commit entries', () => {
    const dir = makeCardRepo({ 'cards/card-123/1': { parentBranch: 'main', addedAt: '2025-01-15T10:30:00Z' } }, [
      branch1CommitSha1
    ]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain('src/auth.ts');
  });

  it('assigns unclaimed commits to base branch', () => {
    process.env['BASE_BRANCH'] = 'main';

    const dir = makeCardRepo({}, [mainCommitSha]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('branch="main"');
    expect(blocks[0]).toContain('feat: main work');
  });

  it('renders orphaned block for commits not on any branch', () => {
    process.env['BASE_BRANCH'] = 'nonexistent-base-branch';

    const dir = makeCardRepo({}, [branch1CommitSha1]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('orphaned="true"');
    expect(blocks[0]).toContain('feat: implement auth');
  });

  it('silently drops unresolvable orphaned commits', () => {
    process.env['BASE_BRANCH'] = 'nonexistent-base-branch';

    const fakeSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const dir = makeCardRepo({}, [fakeSha]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toEqual([]);
  });

  it('annotates merged commits with [merged] in the sha line', () => {
    process.env['BASE_BRANCH'] = 'main';

    const dir = makeCardRepo({ 'cards/card-123/1': { parentBranch: 'main', addedAt: '2025-01-15T10:30:00Z' } }, [
      mainCommitSha,
      branch1CommitSha1
    ]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toHaveLength(1);
    const body = blocks[0]!.replace(/^<workspace-repo-log[^>]*>\n/, '').replace(/\n<\/workspace-repo-log>$/, '');
    const entries = parseLogEntries(body);

    const mainCommit = entries.find((c) => c.subject === 'feat: main work');
    expect(mainCommit).toBeDefined();
    expect(mainCommit!.merged).toBe(true);

    const authCommit = entries.find((c) => c.subject === 'feat: implement auth');
    expect(authCommit).toBeDefined();
    expect(authCommit!.merged).toBeUndefined();
  });

  it('does not show merged for orphaned commits', () => {
    process.env['BASE_BRANCH'] = 'nonexistent-base-branch';

    const dir = makeCardRepo({}, [branch1CommitSha1]);

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('orphaned="true"');
    expect(blocks[0]).not.toContain('merged');
  });

  it('annotates [merged] for commits after merge to main', async () => {
    const mergeWorkspace = new TestGitWorkspace();
    const mergePath = await mergeWorkspace.create();
    const git = mergeWorkspace.getGit();

    await git.checkout(['-b', 'cards/merge-test/1']);
    await mergeWorkspace.createAndCommitFile('src/feature.ts', 'export const f = 1;', 'feat: new feature');
    const featureSha = (await git.revparse(['HEAD'])).trim();

    await git.checkout(['main']);
    await git.merge(['cards/merge-test/1', '--no-ff', '-m', 'merge: feature branch']);
    await git.checkout(['cards/merge-test/1']);

    process.env['BASE_BRANCH'] = 'main';
    const dir = makeCardRepo({ 'cards/merge-test/1': { parentBranch: 'main', addedAt: '2025-01-15T10:30:00Z' } }, [
      featureSha
    ]);

    const blocks = buildWorkspaceRepoLogBlocks(mergePath, dir);

    expect(blocks).toHaveLength(1);
    const body = blocks[0]!.replace(/^<workspace-repo-log[^>]*>\n/, '').replace(/\n<\/workspace-repo-log>$/, '');
    const entries = parseLogEntries(body);
    const featureCommit = entries.find((c) => c.subject === 'feat: new feature');
    expect(featureCommit).toBeDefined();
    expect(featureCommit!.merged).toBe(true);

    mergeWorkspace.destroy();
  });

  it('sorts branches by addedAt (oldest first)', () => {
    const dir = makeCardRepo(
      {
        'cards/card-123/2': { parentBranch: 'main', addedAt: '2025-01-16T14:00:00Z' },
        'cards/card-123/1': { parentBranch: 'main', addedAt: '2025-01-15T10:30:00Z' }
      },
      [mainCommitSha, branch1CommitSha1, branch2CommitSha]
    );

    const blocks = buildWorkspaceRepoLogBlocks(workspacePath, dir);

    expect(blocks[0]).toContain('branch="cards/card-123/1"');
  });
});

describe('buildAdditionalContext', () => {
  const makeActionInput = (overrides?: Record<string, unknown>) => ({
    cardId: 'card-123',
    actionName: 'Launch',
    executionId: 'execution-123',
    worktreeDirective: { kind: 'reuse' } as const,
    environment: 'default',
    executionMode: 'interactive' as const,
    exitWhenDone: false,
    repoRoot: '/workspace',
    cardRepoPath: repoPath,
    configPath: '/tmp/config',
    extensionPath: '/tmp/extension',
    switchToInteractiveData: undefined,
    codingAgent: undefined,
    marketplacePath: '/test/marketplace',
    ...overrides
  });

  afterEach(() => {
    delete process.env['WORKSPACE_BRANCH'];
    delete process.env['BASE_BRANCH'];
    delete process.env['WORKSPACE_PATH'];
  });

  it('contains env block and asserts CARD.meta.json is readable', () => {
    const tmpDir = join(repoPath, '..', `ctx-full-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'CARD.meta.json'),
      JSON.stringify({
        id: 'card-123',
        title: 'Test',
        status: 'active',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false }
      })
    );
    process.env['WORKSPACE_PATH'] = '/workspace';

    const result = buildAdditionalContext(makeActionInput({ cardRepoPath: tmpDir }));

    expect(result).toContain('```bash');
    expect(result).toContain('EXECUTION_MODE=interactive');
    expect(result).not.toContain('<card>');
    expect(result).not.toContain('</card>');
  });

  it('throws CardRepoAccessError when CARD.meta.json is missing', () => {
    const input = makeActionInput({ cardRepoPath: '/tmp/does-not-exist-xyz-999' });

    expect(() => buildAdditionalContext(input)).toThrow(CardRepoAccessError);
  });

  it('includes branch info in env block when env vars are set', () => {
    process.env['WORKSPACE_BRANCH'] = 'cards/card-123/1';
    process.env['BASE_BRANCH'] = 'main';
    process.env['WORKSPACE_PATH'] = '/workspace';

    const tmpDir = join(repoPath, '..', `ctx-env-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'CARD.meta.json'),
      JSON.stringify({
        id: 'card-123',
        title: 'Test',
        status: 'active',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false }
      })
    );

    const result = buildAdditionalContext(makeActionInput({ cardRepoPath: tmpDir }));

    expect(result).toContain('WORKSPACE_BRANCH=cards/card-123/1');
    expect(result).toContain('BASE_BRANCH=main');
  });
});

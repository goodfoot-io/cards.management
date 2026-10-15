/**
 * Integration tests for TestCardRepository.
 *
 * Why: validate that the repository helper creates real git history, file
 * layouts, and conflict states that downstream tests depend on.
 *
 *
 * @summary Integration tests for TestCardRepository
 * @module sdk/test/testing/TestCardRepository.test
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_DIR, COMMENTS_DIR, COMMENTS_PREFIX, PLANS_DIR } from '../../src/cardRepoLayout.js';
import { COMMITS_DIR } from '../../src/protocol/index.js';
import { TestCardRepository } from '../../src/testing/TestCardRepository.js';

describe('TestCardRepository', () => {
  let repo: TestCardRepository;

  beforeEach(() => {
    repo = new TestCardRepository();
  });

  afterEach(() => {
    repo.destroy();
  });

  describe('create()', () => {
    it('creates a repository directory', async () => {
      const reposPath = await repo.create();
      expect(reposPath).toBeTruthy();
      expect(await fs.pathExists(reposPath)).toBe(true);
    });

    it('uses TEST_WORKSPACE env if set', async () => {
      const originalEnv = process.env['TEST_WORKSPACE'];
      try {
        // Use a platform-appropriate absolute path: production joins this via
        // `path.join`, which normalizes to native separators on Windows, so a
        // hardcoded POSIX literal would never prefix-match the result there.
        const customWorkspace = path.join(os.tmpdir(), 'custom-test-workspace');
        process.env['TEST_WORKSPACE'] = customWorkspace;
        const reposPath = await repo.create();
        expect(reposPath.startsWith(customWorkspace)).toBe(true);
      } finally {
        if (originalEnv !== undefined) {
          process.env['TEST_WORKSPACE'] = originalEnv;
        } else {
          delete process.env['TEST_WORKSPACE'];
        }
      }
    });
  });

  describe('createCard()', () => {
    beforeEach(async () => {
      await repo.create();
    });

    it('creates card directory with proper structure', async () => {
      const cardId = await repo.createCard({ title: 'Test Card' });
      const cardPath = repo.getCardPath(cardId);

      expect(await fs.pathExists(path.join(cardPath, 'CARD.md'))).toBe(true);
      expect(await fs.pathExists(path.join(cardPath, PLANS_DIR, 'initial.md'))).toBe(false);
      expect(await fs.pathExists(path.join(cardPath, COMMENTS_DIR))).toBe(false);
      expect(await fs.pathExists(path.join(cardPath, ATTACHMENTS_DIR))).toBe(false);
      // workspace commits are managed via commits.csv
    });

    it('creates CARD.meta.json with metadata', async () => {
      const cardId = await repo.createCard({
        title: 'My Test Card',
        status: 'active',
        tags: ['bug', 'urgent']
      });

      const metaContent = await repo.readFile(cardId, 'CARD.meta.json');
      const metadata = JSON.parse(metaContent);
      expect(metadata.title).toBe('My Test Card');
      expect(metadata.status).toBe('active');
      expect(metadata.tags).toEqual(['bug', 'urgent']);
      expect(metadata.id).toBe(cardId);
      expect(metadata.repositoryId).toBe('test-repo');
    });

    it('creates CARD.md with pure markdown (no frontmatter)', async () => {
      const cardId = await repo.createCard({
        title: 'My Test Card',
        description: 'This is the card description'
      });

      const cardContent = await repo.readFile(cardId, 'CARD.md');
      expect(cardContent).toBe('This is the card description');
      expect(cardContent).not.toContain('---');
      expect(cardContent).not.toContain('title:');
    });

    it('uses custom card ID if provided', async () => {
      const customId = 'CUSTOM-CARD-123';
      const cardId = await repo.createCard({ id: customId, title: 'Test' });
      expect(cardId).toBe(customId);
    });

    it('initializes git repository with initial commit', async () => {
      const cardId = await repo.createCard({ title: 'Test Card' });
      const git = repo.getCardGit(cardId);
      const log = await git.log();
      expect(log.total).toBeGreaterThanOrEqual(1);
      expect(log.latest?.message).toBe('Initialized.');
    });

    it('applies custom gates', async () => {
      const cardId = await repo.createCard({
        title: 'Test Card',
        gates: { planRequired: false, mergeRequestRequired: false }
      });

      const metaContent = await repo.readFile(cardId, 'CARD.meta.json');
      const metadata = JSON.parse(metaContent);
      expect(metadata.gates.planRequired).toBe(false);
      expect(metadata.gates.mergeRequestRequired).toBe(false);
    });
  });

  describe('updateCard()', () => {
    let cardId: string;

    beforeEach(async () => {
      await repo.create();
      cardId = await repo.createCard({ title: 'Original Title' });
    });

    it('updates card title', async () => {
      await repo.updateCard(cardId, { title: 'Updated Title' });
      const metaContent = await repo.readFile(cardId, 'CARD.meta.json');
      const metadata = JSON.parse(metaContent);
      expect(metadata.title).toBe('Updated Title');
    });

    it('updates card status', async () => {
      await repo.updateCard(cardId, { status: 'done' });
      const metaContent = await repo.readFile(cardId, 'CARD.meta.json');
      const metadata = JSON.parse(metaContent);
      expect(metadata.status).toBe('done');
    });

    it('creates a commit for the update', async () => {
      await repo.updateCard(cardId, { title: 'New Title' });
      const git = repo.getCardGit(cardId);
      const log = await git.log({ maxCount: 1 });
      expect(log.latest?.message).toBe('Card updates.');
    });
  });

  describe('addComment()', () => {
    let cardId: string;

    beforeEach(async () => {
      await repo.create();
      cardId = await repo.createCard({ title: 'Test Card' });
    });

    it('creates comment file', async () => {
      const filename = await repo.addComment(cardId, 'test-comment', 'This is a comment');
      const content = await repo.readFile(cardId, `${COMMENTS_PREFIX}${filename}`);
      expect(content).toBe('This is a comment');
    });
  });

  describe('addAttribution()', () => {
    let cardId: string;

    beforeEach(async () => {
      await repo.create();
      cardId = await repo.createCard({ title: 'Test Card' });
    });

    it('writes a commits/<sha> entry file', async () => {
      await repo.addAttribution(cardId, 'abc123def456');
      const commitsDir = path.join(repo.getCardPath(cardId), COMMITS_DIR);
      const entries = await fs.readdir(commitsDir);
      expect(entries).toContain('abc123def456');
    });
  });

  describe('branch management', () => {
    let cardId: string;

    beforeEach(async () => {
      await repo.create();
      cardId = await repo.createCard({ title: 'Test Card' });
    });

    it('creates a branch', async () => {
      await repo.createBranch(cardId, 'feature-branch');
      const git = repo.getCardGit(cardId);
      const branches = await git.branchLocal();
      expect(branches.all).toContain('feature-branch');
    });

    it('checkouts a branch', async () => {
      await repo.createBranch(cardId, 'feature-branch');
      await repo.checkoutBranch(cardId, 'feature-branch');
      const current = await repo.getCurrentBranch(cardId);
      expect(current).toBe('feature-branch');
    });

    it('gets current branch', async () => {
      const current = await repo.getCurrentBranch(cardId);
      expect(current).toBe('main');
    });
  });

  describe('file operations', () => {
    let cardId: string;

    beforeEach(async () => {
      await repo.create();
      cardId = await repo.createCard({ title: 'Test Card' });
    });

    it('adds file to working directory', async () => {
      await repo.addFileToWorkingDir(cardId, 'new-file.txt', 'content');
      const content = await repo.readFile(cardId, 'new-file.txt');
      expect(content).toBe('content');
    });

    it('modifies file and commits', async () => {
      await repo.addFileToWorkingDir(cardId, 'test.txt', 'initial');
      await repo.stageFile(cardId, 'test.txt');
      const git = repo.getCardGit(cardId);
      await git.commit('Added a test file.');

      await repo.modifyFile(cardId, 'test.txt', 'modified');
      const content = await repo.readFile(cardId, 'test.txt');
      expect(content).toBe('modified');
    });

    it('deletes file from working directory', async () => {
      await repo.addFileToWorkingDir(cardId, 'to-delete.txt', 'content');
      await repo.deleteFile(cardId, 'to-delete.txt');
      const exists = await fs.pathExists(path.join(repo.getCardPath(cardId), 'to-delete.txt'));
      expect(exists).toBe(false);
    });

    it('reads file content', async () => {
      await repo.addFileToWorkingDir(cardId, 'read-me.txt', 'hello world');
      const content = await repo.readFile(cardId, 'read-me.txt');
      expect(content).toBe('hello world');
    });
  });

  describe('advanced git operations', () => {
    let cardId: string;

    beforeEach(async () => {
      await repo.create();
      cardId = await repo.createCard({ title: 'Test Card' });
    });

    it('creates nested directory structure', async () => {
      await repo.createNestedStructure(cardId);
      const cardPath = repo.getCardPath(cardId);

      expect(await fs.pathExists(path.join(cardPath, 'src/index.ts'))).toBe(true);
      expect(await fs.pathExists(path.join(cardPath, 'src/components/Button.tsx'))).toBe(true);
      expect(await fs.pathExists(path.join(cardPath, 'src/services/api.ts'))).toBe(true);
      expect(await fs.pathExists(path.join(cardPath, 'test/app.test.ts'))).toBe(true);
    });

    it('gets head SHA', async () => {
      const sha = await repo.getHeadSha(cardId);
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    });

    it('gets commits since baseline', async () => {
      const baseline = await repo.getHeadSha(cardId);
      await repo.addFileToWorkingDir(cardId, 'file1.txt', 'content1');
      const git = repo.getCardGit(cardId);
      await git.add('file1.txt');
      await git.commit('Added file1.');

      await repo.addFileToWorkingDir(cardId, 'file2.txt', 'content2');
      await git.add('file2.txt');
      await git.commit('Added file2.');

      const commits = await repo.getCommitsSince(cardId, baseline);
      expect(commits.length).toBe(2);
    });

    it('creates conflict', async () => {
      await repo.createConflict(cardId);
      const git = repo.getCardGit(cardId);
      const status = await git.status();
      expect(status.conflicted.length).toBeGreaterThan(0);
    });
  });

  describe('destroy()', () => {
    it('cleans up repository directory', async () => {
      const reposPath = await repo.create();
      await repo.createCard({ title: 'Test' });
      repo.destroy();

      expect(await fs.pathExists(reposPath)).toBe(false);
    });

    it('can be called multiple times safely', () => {
      repo.destroy();
      repo.destroy();
      // Should not throw
    });
  });

  describe('error handling', () => {
    it('throws when getting git before create', () => {
      expect(() => repo.getGit()).toThrow('Repository not created');
    });

    it('throws when getting path before create', () => {
      expect(() => repo.getPath()).toThrow('Repository not created');
    });

    it('throws when creating card before create', async () => {
      await expect(repo.createCard({ title: 'Test' })).rejects.toThrow('Repository not created');
    });
  });
});

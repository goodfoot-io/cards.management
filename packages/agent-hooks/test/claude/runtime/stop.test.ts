/**
 * Tests for the Stop hook.
 *
 * @summary Tests for the Stop hook
 */

import { execFileSync } from 'node:child_process';
import { getCommitsSince } from '@cards.management/sdk/card-repo';
import { getUnattributedCommits } from '@cards.management/sdk/client';
import { appendCommitToSession, getSessionCommits, readSessionHeadSha } from '@cards.management/sessions/card-repo';
import { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import hook from '../../../src/claude/runtime/stop.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn()
}));

vi.mock('@cards.management/sessions/card-repo', () => ({
  getSessionCommits: vi.fn(),
  appendCommitToSession: vi.fn(),
  readSessionHeadSha: vi.fn()
}));

vi.mock('@cards.management/sdk/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/client')>();
  return {
    ...actual,
    getUnattributedCommits: vi.fn()
  };
});

vi.mock('@cards.management/sdk/card-repo', () => ({
  getCommitsSince: vi.fn()
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockGetSessionCommits = vi.mocked(getSessionCommits);
const mockAppendCommitToSession = vi.mocked(appendCommitToSession);
const mockReadSessionHeadSha = vi.mocked(readSessionHeadSha);
const mockGetCommitsSince = vi.mocked(getCommitsSince);
const mockGetUnattributedCommits = vi.mocked(getUnattributedCommits);

const logger = new Logger();
const START_SHA = 'a'.repeat(40);
const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);

/** Minimal set of env vars required by extractActionInput. */
const ACTION_ENV = {
  CARD_ID: 'card-456',
  ACTION_NAME: 'Launch Claude',
  CARDS_EXECUTION_ID: 'execution-456',
  CARDS_WORKTREE_DIRECTIVE: '{"kind":"reuse"}',
  ENVIRONMENT: 'staging',
  EXECUTION_MODE: 'interactive',
  EXIT_WHEN_DONE: 'false',
  REPO_ROOT: '/workspace',
  CARD_REPO_PATH: '/workspace/.cards/repo',
  CONFIG_PATH: '/tmp/config',
  EXTENSION_PATH: '/tmp/extension',
  MARKETPLACE_PATH: '/tmp/extension/dist/marketplace',
  WORKSPACE_PATH: '/workspace',
  BASE_BRANCH: 'main',
  WORKSPACE_BRANCH: 'cards/main-1/1'
} as const;

describe('Stop Hook', () => {
  it('exports a valid hook function', () => {
    expect(hook).toBeDefined();
    expect(typeof hook).toBe('function');
  });

  it('has correct hookEventName metadata', () => {
    expect(hook.eventName).toBe('Stop');
  });

  describe('inside an action subprocess', () => {
    beforeEach(() => {
      for (const [key, value] of Object.entries(ACTION_ENV)) {
        process.env[key] = value;
      }
    });

    afterEach(() => {
      for (const key of Object.keys(ACTION_ENV)) {
        delete process.env[key];
      }
      mockExecFileSync.mockReset();
      mockGetSessionCommits.mockReset();
      mockAppendCommitToSession.mockReset();
      mockReadSessionHeadSha.mockReset();
      mockGetCommitsSince.mockReset();
      mockGetUnattributedCommits.mockReset();
    });

    it('approves when no HEAD SHA stored for session', async () => {
      mockReadSessionHeadSha.mockReturnValue(null);
      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'Stop');
      const stdout = result!.stdout as { decision?: string; systemMessage?: string };
      expect(stdout.decision).toBe('approve');
      expect(stdout.systemMessage).toContain('no HEAD SHA');
    });

    it('approves fail-open when readSessionHeadSha throws a non-ENOENT error', async () => {
      // Reproduces hooks-01: readSessionHeadSha rethrows non-ENOENT errors
      // (EACCES, EISDIR, ...). The Stop hook invokes it bare, so the exception
      // escapes the hook instead of being handled gracefully like every other
      // I/O call in the file. The hook should fail open with a graceful
      // approve, as the sibling post-tool-use hook does for the same call.
      const eaccesError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      mockReadSessionHeadSha.mockImplementation(() => {
        throw eaccesError;
      });
      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'Stop');
      const stdout = result!.stdout as { decision?: string };
      expect(stdout.decision).toBe('approve');
    });

    it('returns null when no commits since HEAD SHA', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([]);
      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toBeNull();
    });

    it('returns null when all commits are attributed to session', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_1, SHA_2]);
      mockGetSessionCommits.mockReturnValue([SHA_1, SHA_2]);
      mockGetUnattributedCommits.mockReturnValue([]);
      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toBeNull();
    });

    it('blocks with stat content when unattributed commits exist', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_2, SHA_1]);
      mockGetSessionCommits.mockReturnValue([SHA_1]);
      mockGetUnattributedCommits.mockReturnValue([SHA_2]);
      mockExecFileSync.mockReturnValue('stat content here');

      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };
      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'Stop');
      const stdout = result!.stdout as { decision?: string; reason?: string };
      expect(stdout.decision).toBe('block');
      expect(stdout.reason).toContain('stat content here');
      expect(stdout.reason).toContain('1 unattributed commit');
    });

    it('appends unattributed SHAs to CSV after blocking', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_2, SHA_1]);
      mockGetSessionCommits.mockReturnValue([SHA_1]);
      mockGetUnattributedCommits.mockReturnValue([SHA_2]);
      mockExecFileSync.mockReturnValue('stat content');

      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };
      await hook(mockInput, context);

      expect(mockAppendCommitToSession).toHaveBeenCalledWith('sess-1', SHA_2);
      expect(mockAppendCommitToSession).not.toHaveBeenCalledWith('sess-1', SHA_1);
    });

    it('approves with actionable error when git log fails', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockImplementation(() => {
        throw new Error('not a git repo');
      });
      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'Stop');
      const stdout = result!.stdout as { decision?: string; systemMessage?: string; reason?: string };
      expect(stdout.decision).toBe('approve');
      expect(stdout.systemMessage).toContain('Could not list commits');
      expect(stdout.systemMessage).toContain('To investigate:');
      expect(stdout.systemMessage).toContain(START_SHA);
      expect(stdout.reason).toContain('Commit log failed');
    });

    it('approves with actionable error when CSV read fails', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_1]);
      mockGetSessionCommits.mockImplementation(() => {
        throw new Error('permission denied');
      });
      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'Stop');
      const stdout = result!.stdout as { decision?: string; systemMessage?: string; reason?: string };
      expect(stdout.decision).toBe('approve');
      expect(stdout.systemMessage).toContain('Could not read session commit records');
      expect(stdout.systemMessage).toContain('To investigate:');
      expect(stdout.reason).toContain('Session CSV read failed');
    });

    it('treats all commits as unattributed when CSV is missing (empty array from getSessionCommits)', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_1, SHA_2]);
      mockGetSessionCommits.mockReturnValue([]);
      mockGetUnattributedCommits.mockReturnValue([SHA_1, SHA_2]);
      mockExecFileSync.mockReturnValue('all changes stat');

      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };
      const result = await hook(mockInput, context);

      const stdout = result!.stdout as { decision?: string; reason?: string };
      expect(stdout.decision).toBe('block');
      expect(stdout.reason).toContain('2 unattributed commits');
      expect(mockAppendCommitToSession).toHaveBeenCalledWith('sess-1', SHA_1);
      expect(mockAppendCommitToSession).toHaveBeenCalledWith('sess-1', SHA_2);
    });

    it('includes warnings in block reason when stat generation fails', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_2, SHA_1]);
      mockGetSessionCommits.mockReturnValue([SHA_1]);
      mockGetUnattributedCommits.mockReturnValue([SHA_2]);
      mockExecFileSync.mockImplementation(() => {
        throw new Error('repository corrupted');
      });

      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };
      const result = await hook(mockInput, context);

      const stdout = result!.stdout as { decision?: string; reason?: string };
      expect(stdout.decision).toBe('block');
      expect(stdout.reason).toContain('1 unattributed commit');
      expect(stdout.reason).toContain('Could not generate log --name-only');
      expect(stdout.reason).toContain('To view manually');
      expect(stdout.reason).toContain('Warnings:');
      expect(stdout.reason).toContain('File list generation failed');
    });

    it('includes warnings when recordUnattributedCommits fails', async () => {
      mockReadSessionHeadSha.mockReturnValue(START_SHA);
      mockGetCommitsSince.mockReturnValue([SHA_2, SHA_1]);
      mockGetSessionCommits.mockReturnValue([SHA_1]);
      mockGetUnattributedCommits.mockReturnValue([SHA_2]);
      mockExecFileSync.mockReturnValue('stat content');
      mockAppendCommitToSession.mockRejectedValue(new Error('disk full'));

      const mockInput = { session_id: 'sess-1' } as Parameters<typeof hook>[0];
      const context = { logger };
      const result = await hook(mockInput, context);

      const stdout = result!.stdout as { decision?: string; reason?: string };
      expect(stdout.decision).toBe('block');
      expect(stdout.reason).toContain('stat content');
      expect(stdout.reason).toContain('Warnings:');
      expect(stdout.reason).toContain('Commit recording failed');
      expect(stdout.reason).toContain('disk full');
      expect(stdout.reason).toContain('session CSV is writable');
    });
  });

  describe('outside an action subprocess', () => {
    it('approves stop with an error message when action env vars are missing', async () => {
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'Stop');
      const stdout = result!.stdout as { systemMessage?: string };
      expect(stdout.systemMessage).toContain('not running inside an action subprocess');
    });
  });
});

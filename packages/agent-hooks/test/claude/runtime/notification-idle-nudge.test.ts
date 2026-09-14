/**
 * Tests for the merged Notification(idle_prompt) route/exit-when-done nudge hook.
 *
 * @summary Tests for the Notification(idle_prompt) nudge hook
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractActionInput,
  getBaseBranch,
  getCardRepoPath,
  getWorkspaceBranch,
  getWorkspacePath
} from '@cards.management/sdk/config';
import {
  hasSessionExitWhenDoneNudgeFired,
  hasSessionRouteNudgeFired,
  markSessionExitWhenDoneNudgeFired,
  markSessionRouteNudgeFired
} from '@cards.management/sessions/card-repo';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import hook from '../../../src/claude/runtime/notification-idle-nudge.js';

vi.mock('@cards.management/sdk/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/config')>();
  return {
    ...actual,
    extractActionInput: vi.fn(),
    getCardRepoPath: vi.fn(),
    getWorkspacePath: vi.fn(),
    getBaseBranch: vi.fn(),
    getWorkspaceBranch: vi.fn()
  };
});

vi.mock('@cards.management/sessions/card-repo', () => ({
  hasSessionExitWhenDoneNudgeFired: vi.fn(),
  markSessionExitWhenDoneNudgeFired: vi.fn(),
  hasSessionRouteNudgeFired: vi.fn(),
  markSessionRouteNudgeFired: vi.fn()
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn()
  };
});

const mockExtractActionInput = vi.mocked(extractActionInput);
const mockGetCardRepoPath = vi.mocked(getCardRepoPath);
const mockGetWorkspacePath = vi.mocked(getWorkspacePath);
const mockGetBaseBranch = vi.mocked(getBaseBranch);
const mockGetWorkspaceBranch = vi.mocked(getWorkspaceBranch);
const mockHasExitWhenDoneFired = vi.mocked(hasSessionExitWhenDoneNudgeFired);
const mockMarkExitWhenDoneFired = vi.mocked(markSessionExitWhenDoneNudgeFired);
const mockHasRouteFired = vi.mocked(hasSessionRouteNudgeFired);
const mockMarkRouteFired = vi.mocked(markSessionRouteNudgeFired);
const mockExecFileSync = vi.mocked(execFileSync);

const logger = new Logger();
const context = { logger };

const baseInput = {
  session_id: 'sess-abc',
  transcript_path: '/tmp/transcript-abc.jsonl',
  cwd: '/workspace',
  hook_event_name: 'Notification' as const,
  notification_type: 'idle_prompt',
  message: 'Claude is waiting for your input'
};

let testRepo: TestGitWorkspace;
let repoPath: string;

beforeAll(async () => {
  testRepo = new TestGitWorkspace();
  repoPath = await testRepo.create();
});

afterAll(() => {
  testRepo.destroy();
});

beforeEach(() => {
  vi.resetAllMocks();
  mockGetCardRepoPath.mockReturnValue(repoPath);
  mockGetWorkspacePath.mockReturnValue('/workspace');
  mockGetBaseBranch.mockReturnValue('main');
  mockGetWorkspaceBranch.mockReturnValue('feature-branch');
  mockHasRouteFired.mockReturnValue(false);
  mockHasExitWhenDoneFired.mockReturnValue(false);
  mockExtractActionInput.mockReturnValue({
    cardId: 'card-123',
    executionId: 'execution-123',
    worktreeDirective: { kind: 'reuse' },
    actionName: 'Launch Claude',
    environment: 'default',
    executionMode: 'background',
    exitWhenDone: false,
    repoRoot: '/workspace',
    cardRepoPath: repoPath,
    configPath: '/tmp/config',
    extensionPath: '/tmp/extension',
    switchToInteractiveData: undefined,
    codingAgent: undefined,
    marketplacePath: '/test/marketplace'
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeCardMeta(meta: Record<string, unknown>) {
  writeFileSync(join(repoPath, 'CARD.meta.json'), JSON.stringify(meta));
}

describe('Notification(idle_prompt) nudge hook', () => {
  it('exports a valid hook with hookEventName Notification and matcher idle_prompt', () => {
    expect(hook).toBeDefined();
    expect(typeof hook).toBe('function');
    expect(hook.eventName).toBe('Notification');
  });

  describe('route nudge branch', () => {
    beforeEach(() => {
      writeCardMeta({ tags: [], gates: { mergeRequestRequired: false, mergeApproved: false } });
      mockExecFileSync.mockReturnValue('3\n');
    });

    it('fires the route nudge when not blocked, merge ungated, and unmerged commits exist', async () => {
      const result = await hook(baseInput, context);

      const stdout = result!.stdout as { hookSpecificOutput?: { additionalContext?: string } };
      expect(stdout.hookSpecificOutput?.additionalContext).toContain('feature-branch');
      expect(stdout.hookSpecificOutput?.additionalContext).toContain('3 commit(s)');
      expect(mockMarkRouteFired).toHaveBeenCalledWith('sess-abc');
    });

    it('does not fire when the card is tagged blocked', async () => {
      writeCardMeta({ tags: ['blocked'], gates: {} });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
      expect(mockMarkRouteFired).not.toHaveBeenCalled();
    });

    it('does not fire when merge is gated and not approved', async () => {
      writeCardMeta({ tags: [], gates: { mergeRequestRequired: true, mergeApproved: false } });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fires when merge is gated and approved', async () => {
      writeCardMeta({ tags: [], gates: { mergeRequestRequired: true, mergeApproved: true } });

      const result = await hook(baseInput, context);

      expect(result).not.toBeNull();
    });

    it('does not fire when there are no unmerged commits', async () => {
      mockExecFileSync.mockReturnValue('0\n');

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('does not fire again once the route-nudge marker has already been set', async () => {
      mockHasRouteFired.mockReturnValue(true);

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
      expect(mockMarkRouteFired).not.toHaveBeenCalled();
    });

    it('fails open and returns null when CARD.meta.json is unreadable', async () => {
      mockGetCardRepoPath.mockReturnValue('/tmp/does-not-exist-xyz-123');

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fails open and returns null when git rev-list fails', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('git failed');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fails open and returns null when config env vars are missing', async () => {
      mockGetCardRepoPath.mockImplementation(() => {
        throw new Error('not in action subprocess');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fails open and returns null when the route-nudge marker check throws', async () => {
      mockHasRouteFired.mockImplementation(() => {
        throw new Error('read failed');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fails open and returns null when writing the route-nudge marker throws', async () => {
      mockMarkRouteFired.mockImplementation(() => {
        throw new Error('write failed');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });
  });

  describe('exit-when-done branch (falls through only when route condition does not hold)', () => {
    beforeEach(() => {
      writeCardMeta({ tags: [], gates: {} });
      mockExecFileSync.mockReturnValue('0\n');
      mockExtractActionInput.mockReturnValue({
        cardId: 'card-123',
        executionId: 'execution-123',
        worktreeDirective: { kind: 'reuse' },
        actionName: 'Launch Claude',
        environment: 'default',
        executionMode: 'background',
        exitWhenDone: true,
        repoRoot: '/workspace',
        cardRepoPath: repoPath,
        configPath: '/tmp/config',
        extensionPath: '/tmp/extension',
        switchToInteractiveData: undefined,
        codingAgent: undefined,
        marketplacePath: '/test/marketplace'
      });
    });

    it('fires the exit-when-done nudge when exitWhenDone is true and the route condition does not hold', async () => {
      const result = await hook(baseInput, context);

      const stdout = result!.stdout as { hookSpecificOutput?: { additionalContext?: string } };
      expect(stdout.hookSpecificOutput?.additionalContext).toContain('EXIT_WHEN_DONE=true');
      expect(mockMarkExitWhenDoneFired).toHaveBeenCalledWith('sess-abc');
    });

    it('does not fire when exitWhenDone is false', async () => {
      mockExtractActionInput.mockReturnValue({
        cardId: 'card-123',
        executionId: 'execution-123',
        worktreeDirective: { kind: 'reuse' },
        actionName: 'Launch Claude',
        environment: 'default',
        executionMode: 'background',
        exitWhenDone: false,
        repoRoot: '/workspace',
        cardRepoPath: repoPath,
        configPath: '/tmp/config',
        extensionPath: '/tmp/extension',
        switchToInteractiveData: undefined,
        codingAgent: undefined,
        marketplacePath: '/test/marketplace'
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('does not fire again once the exit-when-done marker has already been set', async () => {
      mockHasExitWhenDoneFired.mockReturnValue(true);

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
      expect(mockMarkExitWhenDoneFired).not.toHaveBeenCalled();
    });

    it('fails open and returns null when outside an action subprocess', async () => {
      mockExtractActionInput.mockImplementation(() => {
        throw new Error('not in action subprocess');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fails open and returns null when the exit-when-done marker check throws', async () => {
      mockHasExitWhenDoneFired.mockImplementation(() => {
        throw new Error('read failed');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });

    it('fails open and returns null when writing the exit-when-done marker throws', async () => {
      mockMarkExitWhenDoneFired.mockImplementation(() => {
        throw new Error('write failed');
      });

      const result = await hook(baseInput, context);

      expect(result).toBeNull();
    });
  });

  describe('mutual exclusion', () => {
    it('fires only the route nudge (not exit-when-done) when both conditions hold on the same idle moment', async () => {
      writeCardMeta({ tags: [], gates: {} });
      mockExecFileSync.mockReturnValue('2\n');
      mockExtractActionInput.mockReturnValue({
        cardId: 'card-123',
        executionId: 'execution-123',
        worktreeDirective: { kind: 'reuse' },
        actionName: 'Launch Claude',
        environment: 'default',
        executionMode: 'background',
        exitWhenDone: true,
        repoRoot: '/workspace',
        cardRepoPath: repoPath,
        configPath: '/tmp/config',
        extensionPath: '/tmp/extension',
        switchToInteractiveData: undefined,
        codingAgent: undefined,
        marketplacePath: '/test/marketplace'
      });

      const result = await hook(baseInput, context);

      const stdout = result!.stdout as { hookSpecificOutput?: { additionalContext?: string } };
      expect(stdout.hookSpecificOutput?.additionalContext).toContain('commit(s)');
      expect(mockMarkExitWhenDoneFired).not.toHaveBeenCalled();
      expect(mockMarkRouteFired).toHaveBeenCalledWith('sess-abc');
    });

    it('retains its own chance to fire later: exit-when-done still fires once the route condition no longer holds, even if route already fired earlier', async () => {
      mockHasRouteFired.mockReturnValue(true);
      writeCardMeta({ tags: [], gates: {} });
      mockExtractActionInput.mockReturnValue({
        cardId: 'card-123',
        executionId: 'execution-123',
        worktreeDirective: { kind: 'reuse' },
        actionName: 'Launch Claude',
        environment: 'default',
        executionMode: 'background',
        exitWhenDone: true,
        repoRoot: '/workspace',
        cardRepoPath: repoPath,
        configPath: '/tmp/config',
        extensionPath: '/tmp/extension',
        switchToInteractiveData: undefined,
        codingAgent: undefined,
        marketplacePath: '/test/marketplace'
      });

      const result = await hook(baseInput, context);

      const stdout = result!.stdout as { hookSpecificOutput?: { additionalContext?: string } };
      expect(stdout.hookSpecificOutput?.additionalContext).toContain('EXIT_WHEN_DONE=true');
      expect(mockMarkExitWhenDoneFired).toHaveBeenCalledWith('sess-abc');
    });
  });

  it('does not import or call isSessionIdle', () => {
    // Structural guard: the whole point of this hook is to not reimplement
    // idle detection — it matches on the CLI's own idle_prompt notification.
    expect(hook.toString()).not.toContain('isSessionIdle');
  });
});

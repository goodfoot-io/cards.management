/**
 * Tests for the SubagentStart hook.
 *
 * @summary Tests for the SubagentStart hook
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractActionInput } from '@cards.management/sdk/config';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { Logger, subagentStartHook } from '@goodfoot/agent-hooks/codex';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexSubagentStartHandler } from '../../../src/codex/runtime/subagent-start.js';

const hook = subagentStartHook({}, createCodexSubagentStartHandler());

vi.mock('@cards.management/sdk/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/config')>();
  return {
    ...actual,
    extractActionInput: vi.fn()
  };
});

const mockExtractActionInput = vi.mocked(extractActionInput);

const logger = new Logger();

let testRepo: TestGitWorkspace;
let repoPath: string;

beforeAll(async () => {
  testRepo = new TestGitWorkspace();
  repoPath = await testRepo.create();
  writeFileSync(
    join(repoPath, 'CARD.meta.json'),
    JSON.stringify({
      id: 'card-123',
      title: 'Test card',
      status: 'active',
      gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false }
    })
  );
});

afterAll(() => {
  testRepo.destroy();
});

const baseInput = {
  agent_id: 'agent-xyz',
  agent_type: 'general-purpose',
  session_id: 'sess-abc',
  transcript_path: '/tmp/transcript-abc.jsonl',
  cwd: '/workspace',
  hook_event_name: 'SubagentStart' as const
} as Parameters<typeof hook>[0];

const context = { logger };

describe('SubagentStart Hook', () => {
  it('exports a valid hook with hookEventName SubagentStart', () => {
    expect(hook).toBeDefined();
    expect(typeof hook).toBe('function');
    expect(hook.hookEventName).toBe('SubagentStart');
  });

  describe('inside an action subprocess', () => {
    /** Minimal set of env vars required by extractActionInput. */
    let ACTION_ENV: Record<string, string>;

    beforeEach(() => {
      ACTION_ENV = {
        CARD_ID: 'card-123',
        ACTION_NAME: 'Launch Claude',
        ENVIRONMENT: 'default',
        EXECUTION_MODE: 'background',
        EXIT_WHEN_DONE: 'false',
        WORKSPACE_PATH: '/workspace',
        CARD_REPO_PATH: repoPath,
        CONFIG_PATH: '/tmp/config',
        EXTENSION_PATH: '/tmp/extension'
      };
      for (const [key, value] of Object.entries(ACTION_ENV)) {
        process.env[key] = value;
      }
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
      for (const key of Object.keys(ACTION_ENV)) {
        delete process.env[key];
      }
      mockExtractActionInput.mockReset();
    });

    it('returns additionalContext with XML context blocks', async () => {
      const result = await hook(baseInput, context);

      expect(result).toHaveProperty('_type', 'SubagentStart');
      expect(result).toHaveProperty('stdout');

      const stdout = (
        result as { stdout: { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } } }
      ).stdout;

      // Env block with EXECUTION_MODE
      expect(stdout.systemMessage).toMatch(/^```bash\n/);
      expect(stdout.systemMessage).toContain('EXECUTION_MODE=background');

      // No <card> block — agents read CARD.meta.json directly
      expect(stdout.systemMessage).not.toContain('<card>');

      // additionalContext mirrors systemMessage
      expect(stdout.hookSpecificOutput?.additionalContext).toBe(stdout.systemMessage);
    });

    it('returns continue:false when card repo is inaccessible', async () => {
      mockExtractActionInput.mockReturnValue({
        cardId: 'card-123',
        executionId: 'execution-123',
        worktreeDirective: { kind: 'reuse' },
        actionName: 'Launch Claude',
        environment: 'default',
        executionMode: 'background',
        exitWhenDone: false,
        repoRoot: '/workspace',
        cardRepoPath: '/tmp/does-not-exist-xyz-123',
        configPath: '/tmp/config',
        extensionPath: '/tmp/extension',
        switchToInteractiveData: undefined,
        codingAgent: undefined,
        marketplacePath: '/test/marketplace'
      });

      const result = await hook(baseInput, context);

      const stdout = (result as { stdout: { continue?: boolean; systemMessage?: string; stopReason?: string } }).stdout;
      expect(stdout.continue).toBe(false);
      expect(stdout.stopReason).toMatch(/Card repository inaccessible/);
      expect(stdout.stopReason).toContain('/tmp/does-not-exist-xyz-123');
      expect(stdout.systemMessage).toContain('not accessible');
      expect(stdout.systemMessage).toContain('To resolve:');
      expect(stdout.systemMessage).toContain('CARD_REPO_PATH');
    });
  });

  describe('outside an action subprocess', () => {
    beforeEach(() => {
      mockExtractActionInput.mockImplementation(() => {
        throw new Error('Not in action subprocess');
      });
    });

    afterEach(() => {
      mockExtractActionInput.mockReset();
    });

    it('returns informational message when outside action subprocess', async () => {
      const result = await hook(baseInput, context);

      expect(result).toHaveProperty('_type', 'SubagentStart');
      const stdout = (result as { stdout: { systemMessage?: string } }).stdout;
      expect(stdout.systemMessage).toContain('not running inside an action subprocess');
    });
  });
});

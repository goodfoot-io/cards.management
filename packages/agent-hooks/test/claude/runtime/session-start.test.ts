/**
 * Tests for the SessionStart hook.
 *
 * @summary Tests for the SessionStart hook
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnStreamSyncWatcher } from '@cards.management/sdk/bin/spawn-stream-sync-watcher';
import { findAgentPid } from '@cards.management/sdk/process-tree';
import { writeSessionHeadSha } from '@cards.management/sessions/card-repo';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import hook, { resolveHeadSha } from '../../../src/claude/runtime/session-start.js';

const mockFindClaudePid = vi.mocked(findAgentPid);
const mockWriteSessionHeadSha = vi.mocked(writeSessionHeadSha);

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn()
}));

vi.mock('@cards.management/sdk/process-tree', () => ({
  findAgentPid: vi.fn()
}));

vi.mock('@cards.management/sessions/card-repo', () => ({
  writeSessionHeadSha: vi.fn()
}));

// The hook's watcher spawn now delegates entirely to spawnStreamSyncWatcher
// (its process/platform mechanics are covered by the sdk package's own
// spawn-stream-sync-watcher tests); these tests exercise only this hook's
// manifest-building and warn-not-throw wiring around that call.
vi.mock('@cards.management/sdk/bin/spawn-stream-sync-watcher', () => ({
  spawnStreamSyncWatcher: vi.fn(() => true)
}));

const logger = new Logger();

const SESSION_ID = 'sess-123';
const TRANSCRIPT_PATH = `/tmp/sessions/${SESSION_ID}.jsonl`;

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

describe('resolveHeadSha', () => {
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    realExecFileSync = real.execFileSync;
  });

  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(realExecFileSync as typeof execFileSync);
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('returns trimmed sha on success', async () => {
    const sha = resolveHeadSha(repoPath);
    const expectedSha = (await testRepo.getGit().revparse(['HEAD'])).trim();

    expect(sha).toBe(expectedSha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null when git command fails', () => {
    expect(resolveHeadSha('/tmp/not-a-repo')).toBeNull();
  });
});

describe('SessionStart Hook', () => {
  it('exports a valid hook function', () => {
    expect(hook).toBeDefined();
    expect(typeof hook).toBe('function');
  });

  it('has correct hookEventName metadata', () => {
    expect(hook.eventName).toBe('SessionStart');
  });

  describe('inside an action subprocess', () => {
    /** Minimal set of env vars required by extractActionInput. */
    let ACTION_ENV: Record<string, string>;

    beforeEach(async () => {
      ACTION_ENV = {
        CARD_ID: 'card-123',
        ACTION_NAME: 'Launch Claude',
        CARDS_EXECUTION_ID: 'execution-123',
        CARDS_WORKTREE_DIRECTIVE: '{"kind":"reuse"}',
        ENVIRONMENT: 'default',
        EXECUTION_MODE: 'background',
        EXIT_WHEN_DONE: 'false',
        REPO_ROOT: '/workspace',
        CARD_REPO_PATH: repoPath,
        CONFIG_PATH: '/tmp/config',
        EXTENSION_PATH: '/tmp/extension',
        MARKETPLACE_PATH: '/tmp/extension/dist/marketplace',
        WORKSPACE_PATH: '/workspace',
        BASE_BRANCH: 'main',
        WORKSPACE_BRANCH: 'cards/main-1/1'
      };
      for (const [key, value] of Object.entries(ACTION_ENV)) {
        process.env[key] = value;
      }
    });

    afterEach(() => {
      for (const key of Object.keys(ACTION_ENV)) {
        delete process.env[key];
      }
      vi.mocked(execFileSync).mockReset();
      mockFindClaudePid.mockReset();
      mockWriteSessionHeadSha.mockReset();
      vi.mocked(spawnStreamSyncWatcher).mockReset();
      vi.mocked(spawnStreamSyncWatcher).mockReturnValue(true);
    });

    it('returns XML context blocks in additionalContext', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      const realSha = (await testRepo.getGit().revparse(['HEAD'])).trim();
      vi.mocked(execFileSync).mockReturnValue(`${realSha}\n`);
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
      expect(result).toHaveProperty('stdout');

      const stdout = result!.stdout as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

      // Env block with EXECUTION_MODE
      expect(stdout.systemMessage).toMatch(/^```bash\n/);
      expect(stdout.systemMessage).toContain('EXECUTION_MODE=background');
      expect(stdout.systemMessage).toContain(`CARD_REPO_PATH=${repoPath}`);

      // No <card> block — agents read CARD.meta.json directly
      expect(stdout.systemMessage).not.toContain('<card>');
      expect(stdout.systemMessage).not.toContain('</card>');

      // additionalContext mirrors systemMessage
      const additional = stdout.hookSpecificOutput!.additionalContext!;
      expect(additional).toBe(stdout.systemMessage);
    });

    it('persists git HEAD sha via writeSessionHeadSha', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      const expectedSha = (await testRepo.getGit().revparse(['HEAD'])).trim();
      vi.mocked(execFileSync).mockReturnValue(`${expectedSha}\n`);
      const mockInput = { session_id: 'sess-sha' } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      expect(mockWriteSessionHeadSha).toHaveBeenCalledWith('sess-sha', expectedSha);
    });

    it('does not call writeSessionHeadSha when git fails', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      // Use a real directory that exists but is not a git repo
      const tmpDir = join(repoPath, '..', `no-git-${Date.now()}`);
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
      process.env['CARD_REPO_PATH'] = tmpDir;
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      const result = await hook(mockInput, context);

      expect(mockWriteSessionHeadSha).not.toHaveBeenCalled();
      const stdout = result!.stdout as { systemMessage?: string };
      expect(stdout.systemMessage).not.toContain('HEAD:');
    });

    it('persists CARDS_SESSION_ID via persistEnvVar', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = {
        session_id: 'sess-env-test',
        transcript_path: '/tmp/sessions/sess-env-test.jsonl'
      } as Parameters<typeof hook>[0];
      const mockPersistEnvVar = vi.fn();
      const context = { logger, persistEnvVar: mockPersistEnvVar, persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      expect(mockPersistEnvVar).toHaveBeenCalledWith('CARDS_SESSION_ID', 'sess-env-test');
    });

    it('calls findAgentPid when inside action subprocess', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      expect(mockFindClaudePid).toHaveBeenCalled();
    });

    it('warns and continues when findAgentPid returns null (PID-keyed entry is best-effort)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      mockFindClaudePid.mockResolvedValue(null);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      const result = await hook(mockInput, context);

      expect(mockFindClaudePid).toHaveBeenCalled();

      const stdout = result!.stdout as {
        continue?: boolean;
        systemMessage?: string;
        stopReason?: string;
      };
      expect(stdout.continue).not.toBe(false);
      expect(stdout.stopReason).toBeUndefined();

      const warnMatch = warnSpy.mock.calls.find(
        ([msg, meta]) =>
          typeof msg === 'string' &&
          /agent PID/i.test(msg) &&
          meta !== undefined &&
          (meta as Record<string, unknown>)['cardId'] === 'card-123' &&
          (meta as Record<string, unknown>)['cardRepoPath'] === repoPath &&
          (meta as Record<string, unknown>)['actionName'] === 'Launch Claude'
      );
      expect(
        warnMatch,
        `expected diagnostic warn with cardId/cardRepoPath/actionName; got: ${JSON.stringify(warnSpy.mock.calls)}`
      ).toBeDefined();
      warnSpy.mockRestore();
    });

    it('builds a Claude Code manifest from the transcript path and spawns the stream-sync-watcher', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      expect(spawnStreamSyncWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: expect.objectContaining({
            runtime: 'claude-code',
            streamType: 'claude-code-session',
            sessionId: SESSION_ID,
            cardId: 'card-123',
            monitorPid: 42,
            cardRepoPath: repoPath
          }),
          extensionPath: '/tmp/extension',
          logger
        })
      );
    });

    it('logs a success message only when the watcher was actually spawned', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      expect(
        infoSpy.mock.calls.some(([msg]) => typeof msg === 'string' && /spawned stream-sync-watcher/i.test(msg))
      ).toBe(true);
      infoSpy.mockRestore();
    });

    it('does not log spawn success when spawnStreamSyncWatcher reports it was skipped', async () => {
      vi.mocked(spawnStreamSyncWatcher).mockReturnValue(false);
      const infoSpy = vi.spyOn(logger, 'info');
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      const falseSuccess = infoSpy.mock.calls.find(
        ([msg]) => typeof msg === 'string' && /spawned stream-sync-watcher/i.test(msg)
      );
      expect(
        falseSuccess,
        `spawn was skipped but a success log was emitted: ${JSON.stringify(infoSpy.mock.calls)}`
      ).toBeUndefined();
      infoSpy.mockRestore();
    });

    it('warns and continues without spawning when the transcript path does not match the sessionId', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = {
        session_id: SESSION_ID,
        transcript_path: '/tmp/sessions/some-other-session.jsonl'
      } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
      expect(spawnStreamSyncWatcher).not.toHaveBeenCalled();
      const warnMatch = warnSpy.mock.calls.find(
        ([msg]) => typeof msg === 'string' && /stream-sync-watcher spawn failed/i.test(msg)
      );
      expect(
        warnMatch,
        `expected a warn about the manifest build failure; got: ${JSON.stringify(warnSpy.mock.calls)}`
      ).toBeDefined();
      warnSpy.mockRestore();
    });

    it('continues when the watcher spawn throws', async () => {
      vi.mocked(spawnStreamSyncWatcher).mockImplementation(() => {
        throw new Error('spawn failed');
      });
      mockFindClaudePid.mockResolvedValue(42);
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      // Should not throw — watcher spawn is best-effort
      const result = await hook(mockInput, context);
      expect(result).toHaveProperty('_type', 'SessionStart');
    });

    it('returns continue:false with stopReason when card repo is inaccessible', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      process.env['CARD_REPO_PATH'] = '/tmp/does-not-exist-xyz-123';
      vi.mocked(execFileSync).mockReturnValue('abc123\n');
      const mockInput = { session_id: SESSION_ID } as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
      const stdout = result!.stdout as {
        continue?: boolean;
        systemMessage?: string;
        stopReason?: string;
      };
      expect(stdout.continue).toBe(false);
      expect(stdout.stopReason).toMatch(/Card repository inaccessible/);
      expect(stdout.stopReason).toContain('/tmp/does-not-exist-xyz-123');
      expect(stdout.systemMessage).toContain('not accessible');
      expect(stdout.systemMessage).toContain('To resolve:');
      expect(stdout.systemMessage).toContain('CARD_REPO_PATH');
    });
  });

  describe('outside an action subprocess', () => {
    afterEach(() => {
      mockFindClaudePid.mockReset();
    });

    it('returns an error message when action env vars are missing', async () => {
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
      const stdout = result!.stdout as { systemMessage?: string };
      expect(stdout.systemMessage).toContain('not running inside an action subprocess');
    });

    it('does not call findAgentPid when outside action subprocess', async () => {
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger, persistEnvVar: vi.fn(), persistEnvVars: vi.fn() };

      await hook(mockInput, context);

      expect(mockFindClaudePid).not.toHaveBeenCalled();
    });
  });
});

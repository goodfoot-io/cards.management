/**
 * Tests for the SessionStart hook.
 *
 * @summary Tests for the SessionStart hook
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnStreamSyncWatcher } from '@cards.management/sdk/bin/spawn-stream-sync-watcher';
import { findAgentPid } from '@cards.management/sdk/process-tree';
import { TestGitWorkspace } from '@cards.management/test-utils';
import { Logger } from '@goodfoot/agent-hooks/codex';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import hook from '../../../src/codex/runtime/session-start.js';

const mockFindClaudePid = vi.mocked(findAgentPid);

vi.mock('@cards.management/sdk/process-tree', () => ({
  findAgentPid: vi.fn()
}));

// The hook's watcher spawn now delegates entirely to spawnStreamSyncWatcher
// (its process/platform mechanics are covered by the sdk package's own
// spawn-stream-sync-watcher tests); these tests exercise only this hook's
// manifest-building and warn-not-throw wiring around that call.
vi.mock('@cards.management/sdk/bin/spawn-stream-sync-watcher', () => ({
  spawnStreamSyncWatcher: vi.fn(() => true)
}));

const logger = new Logger();

const SESSION_ID = '019f38d0-20eb-7a10-b566-666001ec2821';
const ROLLOUT_PATH = `/tmp/.codex/sessions/rollout-2026-07-06T15-03-11-${SESSION_ID}.jsonl`;

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

describe('SessionStart Hook', () => {
  it('exports a valid hook function', () => {
    expect(hook).toBeDefined();
    expect(typeof hook).toBe('function');
  });

  it('has correct hookEventName metadata', () => {
    expect(hook.hookEventName).toBe('SessionStart');
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
      mockFindClaudePid.mockReset();
      vi.mocked(spawnStreamSyncWatcher).mockReset();
      vi.mocked(spawnStreamSyncWatcher).mockReturnValue(true);
    });

    it('returns XML context blocks in additionalContext', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
      expect(result).toHaveProperty('stdout');

      const stdout = (
        result as { stdout: { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } } }
      ).stdout;

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

    it('calls findAgentPid when inside action subprocess', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      const mockInput = { session_id: SESSION_ID, transcript_path: ROLLOUT_PATH } as Parameters<typeof hook>[0];
      const context = { logger };

      await hook(mockInput, context);

      expect(mockFindClaudePid).toHaveBeenCalled();
    });

    it('warns and continues when findAgentPid returns null (PID-keyed entry is best-effort)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      mockFindClaudePid.mockResolvedValue(null);
      const mockInput = { session_id: SESSION_ID, transcript_path: ROLLOUT_PATH } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(mockFindClaudePid).toHaveBeenCalled();

      const stdout = (result as { stdout: { continue?: boolean; systemMessage?: string; stopReason?: string } }).stdout;
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

    it('does not spawn the stream-sync-watcher when transcript_path is null', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      const warnSpy = vi.spyOn(logger, 'warn');
      // transcript_path is absent (null / undefined) — watcher guard is false
      const mockInput = { session_id: 'sess-no-transcript' } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      // Hook must succeed — no throw, normal SessionStart output
      expect(result).toHaveProperty('_type', 'SessionStart');
      const stdout = (result as { stdout: { continue?: boolean; stopReason?: string } }).stdout;
      expect(stdout.continue).not.toBe(false);
      expect(stdout.stopReason).toBeUndefined();

      // Watcher must NOT be spawned
      expect(spawnStreamSyncWatcher).not.toHaveBeenCalled();

      // A warning must be emitted explaining why the watcher was skipped
      const warnMatch = warnSpy.mock.calls.find(
        ([msg]) => typeof msg === 'string' && /agent PID|transcript watcher/i.test(msg)
      );
      expect(
        warnMatch,
        `expected a warn about skipped watcher; got: ${JSON.stringify(warnSpy.mock.calls)}`
      ).toBeDefined();
      warnSpy.mockRestore();
    });

    it('builds a Codex manifest from the rollout path and spawns the stream-sync-watcher', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      const mockInput = { session_id: SESSION_ID, transcript_path: ROLLOUT_PATH } as Parameters<typeof hook>[0];
      const context = { logger };

      await hook(mockInput, context);

      expect(spawnStreamSyncWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: expect.objectContaining({
            runtime: 'codex',
            streamType: 'codex-session',
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
      const mockInput = { session_id: SESSION_ID, transcript_path: ROLLOUT_PATH } as Parameters<typeof hook>[0];
      const context = { logger };

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
      const mockInput = { session_id: SESSION_ID, transcript_path: ROLLOUT_PATH } as Parameters<typeof hook>[0];
      const context = { logger };

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

    // This is the motivating fix: Codex sessions previously never spawned a
    // watcher at all. A rollout path that disagrees with the sessionId means
    // buildCodexManifest throws — the hook must warn (not crash the session)
    // and skip the spawn, exactly like a spawn-level failure.
    it('warns and continues without spawning when the rollout path does not match the sessionId', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      mockFindClaudePid.mockResolvedValue(42);
      const mockInput = {
        session_id: SESSION_ID,
        transcript_path: '/tmp/.codex/sessions/rollout-2026-07-06T15-03-11-some-other-id.jsonl'
      } as Parameters<typeof hook>[0];
      const context = { logger };

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
      const mockInput = { session_id: SESSION_ID, transcript_path: ROLLOUT_PATH } as Parameters<typeof hook>[0];
      const context = { logger };

      // Should not throw — watcher spawn is best-effort
      const result = await hook(mockInput, context);
      expect(result).toHaveProperty('_type', 'SessionStart');
    });

    it('returns continue:false with stopReason when card repo is inaccessible', async () => {
      mockFindClaudePid.mockResolvedValue(42);
      process.env['CARD_REPO_PATH'] = '/tmp/does-not-exist-xyz-123';
      const mockInput = { session_id: SESSION_ID } as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
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
    afterEach(() => {
      mockFindClaudePid.mockReset();
    });

    it('returns an error message when action env vars are missing', async () => {
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger };

      const result = await hook(mockInput, context);

      expect(result).toHaveProperty('_type', 'SessionStart');
      const stdout = (result as { stdout: { systemMessage?: string } }).stdout;
      expect(stdout.systemMessage).toContain('not running inside an action subprocess');
    });

    it('does not call findAgentPid when outside action subprocess', async () => {
      const mockInput = {} as Parameters<typeof hook>[0];
      const context = { logger };

      await hook(mockInput, context);

      expect(mockFindClaudePid).not.toHaveBeenCalled();
    });
  });
});

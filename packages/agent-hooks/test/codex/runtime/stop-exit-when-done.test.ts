/**
 * Tests for the Codex Stop exit-when-done hook.
 *
 * @summary Tests for the Codex Stop exit-when-done hook
 */

import path from 'node:path';
import { extractActionInput } from '@cards.management/sdk/config';
import {
  hasSessionExitWhenDoneNudgeFired,
  markSessionExitWhenDoneNudgeFired
} from '@cards.management/sessions/card-repo';
import { Logger } from '@goodfoot/agent-hooks/codex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import hook from '../../../src/codex/runtime/stop-exit-when-done.js';
import { isSessionIdle } from '../../../src/shared/session-idle.js';

vi.mock('@cards.management/sdk/config', () => ({
  extractActionInput: vi.fn()
}));
vi.mock('@cards.management/sessions/card-repo', () => ({
  hasSessionExitWhenDoneNudgeFired: vi.fn(),
  markSessionExitWhenDoneNudgeFired: vi.fn()
}));
vi.mock('../../../src/shared/session-idle.js', () => ({ isSessionIdle: vi.fn() }));

const mockExtractActionInput = vi.mocked(extractActionInput);
const mockHasNudged = vi.mocked(hasSessionExitWhenDoneNudgeFired);
const mockMarkNudged = vi.mocked(markSessionExitWhenDoneNudgeFired);
const mockIsSessionIdle = vi.mocked(isSessionIdle);
const logger = new Logger();
const actionInput = {
  cardId: 'main-453',
  executionId: 'execution-453',
  worktreeDirective: { kind: 'reuse' } as const,
  actionName: 'Launch',
  environment: 'default',
  executionMode: 'interactive' as const,
  exitWhenDone: true,
  repoRoot: '/workspace',
  cardRepoPath: '/cards/main-453',
  configPath: '/config',
  extensionPath: '/extension',
  switchToInteractiveData: undefined,
  codingAgent: 'codex' as const,
  marketplacePath: '/marketplace'
};
const input = { session_id: 'session-453' } as Parameters<typeof hook>[0];

describe('Codex Stop exit-when-done hook', () => {
  beforeEach(() => {
    mockExtractActionInput.mockReturnValue(actionInput);
    mockHasNudged.mockReturnValue(false);
    mockMarkNudged.mockReturnValue(undefined);
    mockIsSessionIdle.mockReturnValue(true);
  });

  afterEach(() => vi.clearAllMocks());

  it('is a matcher-less Stop hook that blocks with an installed absolute runbook path', async () => {
    expect(hook.hookEventName).toBe('Stop');

    const result = await hook(input, { logger });
    const stdout = result!.stdout as { decision?: string; reason?: string };
    const runbook = stdout.reason?.match(/`([^`]*shutdown\.md)`/)?.[1];

    expect(stdout.decision).toBe('block');
    expect(runbook).toBeDefined();
    expect(path.isAbsolute(runbook!)).toBe(true);
    expect(runbook).toContain('/skills/card/references/shutdown.md');
    expect(stdout.reason).toContain('a reminder for when work is done, not a signal to stop now');
    expect(stdout.reason).toContain('cards "$CARD_ID" shutdown --outcome success|blocked|error');
    expect(mockMarkNudged).toHaveBeenCalledWith(input.session_id);
  });

  it('consumes only its own first-event marker and suppresses repeated Stop events', async () => {
    expect(await hook(input, { logger })).toBeDefined();
    mockHasNudged.mockReturnValue(true);
    expect(await hook(input, { logger })).toBeUndefined();
    expect(mockMarkNudged).toHaveBeenCalledTimes(1);
  });

  it('does not inspect or write a marker when exit-when-done is disabled', async () => {
    mockExtractActionInput.mockReturnValue({ ...actionInput, exitWhenDone: false });
    expect(await hook(input, { logger })).toBeUndefined();
    expect(mockHasNudged).not.toHaveBeenCalled();
    expect(mockMarkNudged).not.toHaveBeenCalled();
  });

  it('does not consume the marker while the session has active work', async () => {
    mockIsSessionIdle.mockReturnValue(false);
    expect(await hook(input, { logger })).toBeUndefined();
    expect(mockHasNudged).not.toHaveBeenCalled();
  });

  it('fails open and logs when action context is missing', async () => {
    mockExtractActionInput.mockImplementation(() => {
      throw new Error('missing action context');
    });
    expect(await hook(input, { logger })).toBeUndefined();
  });

  it('fails open when the marker cannot be read', async () => {
    mockHasNudged.mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(await hook(input, { logger })).toBeUndefined();
    expect(mockMarkNudged).not.toHaveBeenCalled();
  });

  it('fails open when the marker cannot be written', async () => {
    mockMarkNudged.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(await hook(input, { logger })).toBeUndefined();
  });

  it('requires shutdown to be the sole tool call in the final assistant turn after all work is done', async () => {
    const result = await hook(input, { logger });
    const reason = (result!.stdout as { reason?: string }).reason;

    expect(reason).toContain('all subagents and background work are finished');
    expect(reason).toContain('sole tool call in your final assistant turn');
    expect(reason).toContain('Do not make any later tool call');
  });
});

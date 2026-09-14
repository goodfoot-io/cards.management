/**
 * Tests for the Claude Stop shutdown-drain readiness hook.
 *
 * @summary Tests for the Claude Stop shutdown-drain readiness hook
 */

import { clearPendingShutdownRequest, readPendingShutdownRequest } from '@cards.management/sdk/config';
import { Logger } from '@goodfoot/agent-hooks/claude-code';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import hook from '../../../src/claude/runtime/stop-shutdown-drain.js';
import { isSessionIdle } from '../../../src/shared/session-idle.js';

vi.mock('@cards.management/sdk/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk/config')>();
  return {
    ...actual,
    clearPendingShutdownRequest: vi.fn(),
    readPendingShutdownRequest: vi.fn()
  };
});
vi.mock('../../../src/shared/session-idle.js', () => ({ isSessionIdle: vi.fn() }));

const mockClearPendingShutdownRequest = vi.mocked(clearPendingShutdownRequest);
const mockReadPendingShutdownRequest = vi.mocked(readPendingShutdownRequest);
const runtimeSend = vi.fn(async (message: { type: string }) =>
  message.type === 'execution.workAdmission'
    ? {
        status: 'accepted' as const,
        messageId: 'work',
        workAdmission: { status: 'admitted' as const, workRevision: 4 }
      }
    : { status: 'accepted' as const, messageId: 'readiness' }
);
vi.mock('@cards.management/sdk/client/discovery', () => ({
  discoverApiInfo: vi.fn(async () => ({ host: '127.0.0.1', port: 1, accessToken: 'token' }))
}));
vi.mock('@cards.management/sdk/client/runtime/bootstrap', () => ({
  loadRuntimeCredential: vi.fn(() => ({ execution: { executionId: 'exec-1', launchRequestId: 'launch-1' } })),
  createRuntimeClientFromCredentialFile: vi.fn(() => ({
    connect: async () => ({ status: 'connected', synchronization: { workRevision: 7 } }),
    send: runtimeSend,
    close: async () => undefined
  }))
}));
vi.mock('@cards.management/sdk/client/runtime/outbox-store', () => ({
  createFileClientOutbox: vi.fn(() => ({})),
  resolveOutboxRoot: vi.fn(() => '/tmp/outbox')
}));
const mockIsSessionIdle = vi.mocked(isSessionIdle);
const logger = new Logger();

/** Minimal set of env vars required by extractActionInput. */
const ACTION_ENV = {
  CARD_ID: 'card-456',
  ACTION_NAME: 'Launch Claude',
  CARDS_EXECUTION_ID: 'execution-456',
  CARDS_WORKTREE_DIRECTIVE: '{"kind":"reuse"}',
  ENVIRONMENT: 'staging',
  EXECUTION_MODE: 'interactive',
  EXIT_WHEN_DONE: 'true',
  REPO_ROOT: '/workspace',
  CARD_REPO_PATH: '/workspace/.cards/repo',
  CONFIG_PATH: '/tmp/config',
  EXTENSION_PATH: '/tmp/extension',
  MARKETPLACE_PATH: '/tmp/extension/dist/marketplace',
  WORKSPACE_PATH: '/workspace',
  BASE_BRANCH: 'main',
  WORKSPACE_BRANCH: 'cards/main-1/1'
} as const;

const input = { session_id: 'session-456' } as Parameters<typeof hook>[0];

const pendingRequest = {
  version: 1 as const,
  requestId: 'shutdown-request-opaque-456',
  messageId: 'shutdown-message-456',
  outcome: 'success' as const
};

describe('Claude Stop shutdown-drain hook', () => {
  it('has correct hookEventName metadata', () => {
    expect(hook.eventName).toBe('Stop');
  });

  it('fails open when not inside an action subprocess', async () => {
    const preserved: Record<string, string | undefined> = {};
    for (const key of Object.keys(ACTION_ENV)) {
      preserved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      expect(await hook(input, { logger })).toBeNull();
      expect(mockReadPendingShutdownRequest).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries(preserved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  describe('inside an action subprocess', () => {
    beforeEach(() => {
      for (const [key, value] of Object.entries(ACTION_ENV)) {
        process.env[key] = value;
      }
      mockReadPendingShutdownRequest.mockReturnValue(undefined);
      mockIsSessionIdle.mockResolvedValue(true);
    });

    afterEach(() => {
      for (const key of Object.keys(ACTION_ENV)) {
        delete process.env[key];
      }
      vi.clearAllMocks();
    });

    it('is a no-op when no shutdown request is pending', async () => {
      expect(await hook(input, { logger })).toBeNull();
      expect(mockReadPendingShutdownRequest).toHaveBeenCalledWith(input.session_id);
      expect(mockIsSessionIdle).not.toHaveBeenCalled();
    });

    it('fails open when the pending-request marker cannot be read', async () => {
      mockReadPendingShutdownRequest.mockImplementation(() => {
        throw new Error('permission denied');
      });
      expect(await hook(input, { logger })).toBeNull();
      expect(mockIsSessionIdle).not.toHaveBeenCalled();
    });

    describe('with a pending shutdown request', () => {
      beforeEach(() => {
        mockReadPendingShutdownRequest.mockReturnValue(pendingRequest);
      });

      it('acknowledges readiness and clears the request once the strict idle authority reports drained', async () => {
        mockIsSessionIdle.mockResolvedValue(true);

        expect(await hook(input, { logger })).toBeNull();

        expect(mockIsSessionIdle).toHaveBeenCalledWith(input.session_id, { strict: true });
        expect(runtimeSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'execution.shutdownReadiness' }));
        expect(mockClearPendingShutdownRequest).toHaveBeenCalledWith(input.session_id, pendingRequest.requestId);
      });

      it('does not acknowledge while the strict idle authority reports background work', async () => {
        mockIsSessionIdle.mockResolvedValue(false);

        expect(await hook(input, { logger })).toBeNull();

        expect(runtimeSend).not.toHaveBeenCalled();
        expect(mockClearPendingShutdownRequest).not.toHaveBeenCalled();
      });

      it('fails closed when the strict idle authority throws', async () => {
        mockIsSessionIdle.mockRejectedValue(new Error('process-tree query failed'));

        expect(await hook(input, { logger })).toBeNull();
        expect(runtimeSend).not.toHaveBeenCalled();
      });

      it('leaves the request pending when runtime readiness is rejected', async () => {
        mockIsSessionIdle.mockResolvedValue(true);
        runtimeSend.mockRejectedValueOnce(new Error('connection lost'));

        expect(await hook(input, { logger })).toBeNull();
        expect(mockClearPendingShutdownRequest).not.toHaveBeenCalled();
      });
    });
  });
});

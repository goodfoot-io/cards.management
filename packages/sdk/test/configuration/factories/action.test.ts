/**
 * Tests for defineAction factory function.
 *
 * These tests verify the factory creates proper command objects with correct
 * metadata attachment and callable behavior.
 *
 * @summary Tests for defineAction factory function
 */

import { flushMicrotasks } from '@cards.management/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineAction } from '../../../src/config/factories/action.js';
import type { ActionContext, ActionInput } from '../../../src/config/inputs.js';
import type { ILogger } from '../../../src/config/logger.js';

describe('defineAction', () => {
  // Sample input and context for testing
  const mockInput: ActionInput = {
    cardId: 'card-123',
    actionName: 'Test Action',
    executionId: 'execution-1',
    worktreeDirective: { kind: 'reuse' },
    environment: 'default',
    executionMode: 'interactive',
    exitWhenDone: false,
    codingAgent: 'claude',
    repoRoot: '/workspace',
    cardRepoPath: '/workspace/.cards/card-123',
    configPath: '/config',
    extensionPath: '/ext',
    marketplacePath: '/test/marketplace'
  };

  const mockLogger: ILogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logError: vi.fn()
  };

  const mockContext: ActionContext = {
    logger: mockLogger,
    cwd: '/workspace',
    reportWorktreeAssignment: vi.fn(),
    onCancel: vi.fn(),
    onSwitchToInteractive: vi.fn()
  };

  describe('basic functionality', () => {
    it('returns a callable function', async () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Test Action' }, handler);

      expect(typeof command).toBe('function');
      await command(mockInput, mockContext);
      expect(handler).toHaveBeenCalledWith(mockInput, mockContext);
    });

    it('invokes handler with correct arguments', async () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch' }, handler);

      await command(mockInput, mockContext);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(mockInput, mockContext);
    });

    it('returns a promise that resolves when handler completes', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const command = defineAction({ actionName: 'Deploy' }, handler);

      const result = command(mockInput, mockContext);

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('metadata attachment', () => {
    it('attaches factoryType as "action"', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Test' }, handler);

      expect(command.factoryType).toBe('action');
    });

    it('attaches actionName from config', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch Claude' }, handler);

      expect(command.actionName).toBe('Launch Claude');
    });

    it('attaches description when provided', () => {
      const handler = vi.fn();
      const command = defineAction(
        {
          actionName: 'Deploy',
          description: 'Deploy to production'
        },
        handler
      );

      expect(command.description).toBe('Deploy to production');
    });

    it('leaves description undefined when not provided', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch' }, handler);

      expect(command.description).toBeUndefined();
    });

    it('attaches icon when provided', () => {
      const handler = vi.fn();
      const command = defineAction(
        {
          actionName: 'Launch',
          icon: './icons/launch.svg'
        },
        handler
      );

      expect(command.icon).toBe('./icons/launch.svg');
    });

    it('leaves icon undefined when not provided', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch' }, handler);

      expect(command.icon).toBeUndefined();
    });

    it('attaches supportsBackgroundMode when provided', () => {
      const handler = vi.fn();
      const command = defineAction(
        {
          actionName: 'Deploy',
          supportsBackgroundMode: true
        },
        handler
      );

      expect(command.supportsBackgroundMode).toBe(true);
    });

    it('leaves supportsBackgroundMode undefined when not provided', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch' }, handler);

      expect(command.supportsBackgroundMode).toBeUndefined();
    });

    it('attaches timeout when provided', () => {
      const handler = vi.fn();
      const command = defineAction(
        {
          actionName: 'Deploy',
          timeout: 60000
        },
        handler
      );

      expect(command.timeout).toBe(60000);
    });

    it('leaves timeout undefined when not provided', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch' }, handler);

      expect(command.timeout).toBeUndefined();
    });

    it('attaches id when provided', () => {
      const handler = vi.fn();
      const command = defineAction(
        {
          actionName: 'Launch Claude',
          id: 'launch-claude'
        },
        handler
      );

      expect(command.id).toBe('launch-claude');
    });

    it('leaves id undefined when not provided', () => {
      const handler = vi.fn();
      const command = defineAction({ actionName: 'Launch' }, handler);

      expect(command.id).toBeUndefined();
    });

    it('attaches all optional fields when provided', () => {
      const handler = vi.fn();
      const command = defineAction(
        {
          actionName: 'Deploy Application',
          description: 'Deploy to production',
          icon: './icons/deploy.svg',
          supportsBackgroundMode: true,
          timeout: 120000
        },
        handler
      );

      expect(command.factoryType).toBe('action');
      expect(command.actionName).toBe('Deploy Application');
      expect(command.description).toBe('Deploy to production');
      expect(command.icon).toBe('./icons/deploy.svg');
      expect(command.supportsBackgroundMode).toBe(true);
      expect(command.timeout).toBe(120000);
    });
  });

  describe('handler execution', () => {
    it('awaits async handlers', async () => {
      let executed = false;
      const handler = async () => {
        await flushMicrotasks();
        executed = true;
      };

      const command = defineAction({ actionName: 'Async Action' }, handler);

      await command(mockInput, mockContext);
      expect(executed).toBe(true);
    });

    it('supports synchronous handlers', async () => {
      let executed = false;
      const handler = () => {
        executed = true;
      };

      const command = defineAction({ actionName: 'Sync Action' }, handler);

      await command(mockInput, mockContext);
      expect(executed).toBe(true);
    });

    it('propagates handler errors', async () => {
      const error = new Error('Handler failed');
      const handler = vi.fn().mockRejectedValue(error);

      const command = defineAction({ actionName: 'Failing Action' }, handler);

      await expect(command(mockInput, mockContext)).rejects.toThrow('Handler failed');
    });

    it('propagates synchronous handler errors', async () => {
      const handler = () => {
        throw new Error('Sync error');
      };

      const command = defineAction({ actionName: 'Sync Failing Action' }, handler);

      await expect(command(mockInput, mockContext)).rejects.toThrow('Sync error');
    });
  });

  describe('type preservation', () => {
    it('preserves action name as literal type', () => {
      const handler = vi.fn();

      // Type preservation test: the return type should be ActionCommand<'Launch'>
      // not ActionCommand<string>. This is verified at compile time by TypeScript.
      const command = defineAction({ actionName: 'Launch' }, handler);

      // Runtime verification that the action name is correct
      expect(command.actionName).toBe('Launch');
    });
  });
});

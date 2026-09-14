/**
 * Tests for input type definitions.
 *
 * These are type-level tests that verify the structure and properties of
 * input types used by action and type lifecycle handlers.
 *
 * @summary Tests for input type definitions
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { ActionContext, ActionInput } from '../../src/config/inputs.js';
import type { ILogger } from '../../src/config/logger.js';

describe('inputs', () => {
  describe('ActionInput', () => {
    it('should have all required fields with correct types', () => {
      expectTypeOf<ActionInput>().toMatchTypeOf<{
        cardId: string;
        actionName: string;
        environment: string;
        executionMode: 'interactive' | 'background';
        repoRoot: string;
        cardRepoPath: string;
      }>();
    });

    it('should have optional codingAgent field', () => {
      expectTypeOf<ActionInput>().toMatchTypeOf<{
        codingAgent?: string;
      }>();
    });

    it('should have optional switchToInteractiveData field', () => {
      expectTypeOf<ActionInput>().toMatchTypeOf<{
        switchToInteractiveData?: unknown;
      }>();
    });

    it('should allow interactive execution mode', () => {
      const input: ActionInput = {
        cardId: 'card-123',
        actionName: 'Test Action',
        executionId: 'execution-1',
        worktreeDirective: { kind: 'reuse' },
        environment: 'default',
        executionMode: 'interactive',
        exitWhenDone: false,
        repoRoot: '/workspace',
        cardRepoPath: '/workspace/.cards/card-123',
        configPath: '/config',
        extensionPath: '/ext',
        marketplacePath: '/test/marketplace'
      };

      expectTypeOf(input.executionMode).toEqualTypeOf<'interactive' | 'background'>();
    });

    it('should allow background execution mode', () => {
      const input: ActionInput = {
        cardId: 'card-123',
        actionName: 'Test Action',
        executionId: 'execution-1',
        worktreeDirective: { kind: 'reuse' },
        environment: 'default',
        executionMode: 'background',
        exitWhenDone: false,
        repoRoot: '/workspace',
        cardRepoPath: '/workspace/.cards/card-123',
        configPath: '/config',
        extensionPath: '/ext',
        marketplacePath: '/test/marketplace'
      };

      expectTypeOf(input.executionMode).toEqualTypeOf<'interactive' | 'background'>();
    });

    it('should allow optional codingAgent', () => {
      const inputWithAgent: ActionInput = {
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

      const inputWithoutAgent: ActionInput = {
        cardId: 'card-123',
        actionName: 'Test Action',
        executionId: 'execution-1',
        worktreeDirective: { kind: 'reuse' },
        environment: 'default',
        executionMode: 'interactive',
        exitWhenDone: false,
        repoRoot: '/workspace',
        cardRepoPath: '/workspace/.cards/card-123',
        configPath: '/config',
        extensionPath: '/ext',
        marketplacePath: '/test/marketplace'
      };

      expectTypeOf(inputWithAgent.codingAgent).toEqualTypeOf<string | undefined>();
      expectTypeOf(inputWithoutAgent.codingAgent).toEqualTypeOf<string | undefined>();
    });
  });

  describe('ActionContext', () => {
    it('should have logger and cwd fields', () => {
      expectTypeOf<ActionContext>().toMatchTypeOf<{
        logger: ILogger;
        cwd: string;
      }>();
    });

    it('should have ILogger type for logger field', () => {
      expectTypeOf<ActionContext['logger']>().toEqualTypeOf<ILogger>();
    });

    it('should have string type for cwd field', () => {
      expectTypeOf<ActionContext['cwd']>().toEqualTypeOf<string>();
    });

    it('should have onCancel method', () => {
      expectTypeOf<ActionContext>().toHaveProperty('onCancel');
      expectTypeOf<ActionContext['onCancel']>().toBeFunction();
    });

    it('should have onSwitchToInteractive method', () => {
      expectTypeOf<ActionContext>().toHaveProperty('onSwitchToInteractive');
      expectTypeOf<ActionContext['onSwitchToInteractive']>().toBeFunction();
    });

    it('should be usable in handler signature', () => {
      const handler = async (input: ActionInput, context: ActionContext): Promise<void> => {
        context.logger.info('test', { cardId: input.cardId });
        context.onCancel(() => {});
        context.onSwitchToInteractive(() => ({ sessionId: 'abc' }));
        const configPath = `${context.cwd}/config.json`;
        expectTypeOf(configPath).toEqualTypeOf<string>();
      };

      expectTypeOf(handler).toMatchTypeOf<(input: ActionInput, context: ActionContext) => Promise<void>>();
    });

    it('should allow destructuring in handler', () => {
      const handler = async (
        _input: ActionInput,
        { logger, cwd, onCancel, onSwitchToInteractive }: ActionContext
      ): Promise<void> => {
        logger.info('test');
        onCancel(() => {});
        onSwitchToInteractive(() => ({}));
        expectTypeOf(logger).toEqualTypeOf<ILogger>();
        expectTypeOf(cwd).toEqualTypeOf<string>();
      };

      expectTypeOf(handler).parameters.toMatchTypeOf<[ActionInput, ActionContext]>();
    });
  });
});

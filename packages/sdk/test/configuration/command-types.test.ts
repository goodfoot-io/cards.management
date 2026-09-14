/**
 * Tests for command type definitions.
 *
 * These are type-level tests that verify the structure and generic type
 * preservation of command types used by factory functions.
 *
 * @summary Tests for command type definitions
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { ActionCommand } from '../../src/config/command-types.js';
import type { ActionContext, ActionInput } from '../../src/config/inputs.js';

describe('command-types', () => {
  describe('ActionCommand', () => {
    it('should be callable with ActionInput and ActionContext', () => {
      const fn = async (input: ActionInput, context: ActionContext) => {
        expectTypeOf(input).toEqualTypeOf<ActionInput>();
        expectTypeOf(context).toEqualTypeOf<ActionContext>();
      };
      const command = Object.assign(fn, {
        factoryType: 'action' as const,
        actionName: 'Test'
      });

      expectTypeOf(command).toBeCallableWith({} as ActionInput, {} as ActionContext);
    });

    it('should return Promise<void>', () => {
      const fn = async () => {};
      const command = Object.assign(fn, {
        factoryType: 'action' as const,
        actionName: 'Test'
      });

      expectTypeOf(command).returns.toEqualTypeOf<Promise<void>>();
    });

    it('should have factoryType property', () => {
      expectTypeOf<ActionCommand>().toHaveProperty('factoryType');
      expectTypeOf<ActionCommand['factoryType']>().toEqualTypeOf<'action'>();
    });

    it('should have actionName property', () => {
      expectTypeOf<ActionCommand>().toHaveProperty('actionName');
      expectTypeOf<ActionCommand['actionName']>().toEqualTypeOf<string>();
    });

    it('should have optional metadata properties', () => {
      expectTypeOf<ActionCommand>().toMatchTypeOf<{
        id?: string;
        description?: string;
        icon?: string;
        supportsBackgroundMode?: boolean;
        timeout?: number;
      }>();
    });

    it('should preserve literal action name type', () => {
      const fn = async () => {};
      const command: ActionCommand<'Launch Claude'> = Object.assign(fn, {
        factoryType: 'action' as const,
        actionName: 'Launch Claude' as const
      });

      expectTypeOf(command.actionName).toEqualTypeOf<'Launch Claude'>();
    });

    it('should default to string when no generic provided', () => {
      const fn = async () => {};
      const command: ActionCommand = Object.assign(fn, {
        factoryType: 'action' as const,
        actionName: 'Any Action Name'
      });

      expectTypeOf(command.actionName).toEqualTypeOf<string>();
    });

    it('should allow different literal types for different commands', () => {
      const launchFn = async () => {};
      const launchCommand: ActionCommand<'Launch'> = Object.assign(launchFn, {
        factoryType: 'action' as const,
        actionName: 'Launch' as const
      });

      const deployFn = async () => {};
      const deployCommand: ActionCommand<'Deploy'> = Object.assign(deployFn, {
        factoryType: 'action' as const,
        actionName: 'Deploy' as const
      });

      expectTypeOf(launchCommand.actionName).toEqualTypeOf<'Launch'>();
      expectTypeOf(deployCommand.actionName).toEqualTypeOf<'Deploy'>();
      expectTypeOf(launchCommand.actionName).not.toEqualTypeOf<'Deploy'>();
    });
  });

  describe('Generic type preservation across all commands', () => {
    it('should preserve literal types for action commands', () => {
      type Cmd = ActionCommand<'Build'>;

      expectTypeOf<Cmd['actionName']>().toEqualTypeOf<'Build'>();
    });

    it('should allow string as default generic', () => {
      type Cmd = ActionCommand;

      expectTypeOf<Cmd['actionName']>().toEqualTypeOf<string>();
    });
  });
});

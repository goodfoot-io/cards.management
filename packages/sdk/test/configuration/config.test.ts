/**
 * Tests for settings configuration types.
 *
 * These are primarily type-level tests that verify compile-time guarantees
 * using expectTypeOf from vitest. The tests ensure that ActionCommand and
 * related configuration types work correctly.
 *
 * @summary Tests for settings configuration types
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ActionCommand } from '../../src/config/command-types.js';
import type { EnvironmentConfig, SettingsConfig, StreamConfigDefinition } from '../../src/config/config.js';

// ============================================================================
// Type-Level Tests
// ============================================================================

describe('config types', () => {
  describe('ActionCommand', () => {
    it('should accept action command with required properties', () => {
      // Create mock command with action name
      const command: ActionCommand<'Launch'> = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand<'Launch'>;

      // Type assertions
      expectTypeOf(command).toEqualTypeOf<ActionCommand<'Launch'>>();
      expectTypeOf(command.actionName).toEqualTypeOf<'Launch'>();

      // Runtime assertion
      expect(command.actionName).toBe('Launch');
      expect(command.factoryType).toBe('action');
    });

    it('should preserve literal types for action names', () => {
      const command: ActionCommand<'SpecificAction'> = {
        factoryType: 'action',
        actionName: 'SpecificAction'
      } as ActionCommand<'SpecificAction'>;

      // The literal type should be preserved
      expectTypeOf(command.actionName).toEqualTypeOf<'SpecificAction'>();
    });

    it('should accept ActionCommand with default string parameter', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'AnyAction'
      } as ActionCommand;

      // Default string parameter allows any action name
      expectTypeOf(command).toEqualTypeOf<ActionCommand<string>>();
      expectTypeOf(command.actionName).toEqualTypeOf<string>();
    });

    it('should work with union types for action names', () => {
      type Actions = 'Launch' | 'Deploy' | 'Build';

      const command: ActionCommand<Actions> = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand<Actions>;

      expectTypeOf(command.actionName).toEqualTypeOf<Actions>();
    });

    it('should accept optional metadata properties', () => {
      const command: ActionCommand<'Launch'> = {
        factoryType: 'action',
        actionName: 'Launch',
        description: 'Launch the app',
        icon: 'rocket',
        supportsBackgroundMode: true,
        timeout: 30000,
        id: 'custom-id'
      } as ActionCommand<'Launch'>;

      expect(command.description).toBe('Launch the app');
      expect(command.icon).toBe('rocket');
      expect(command.supportsBackgroundMode).toBe(true);
      expect(command.timeout).toBe(30000);
      expect(command.id).toBe('custom-id');
    });
  });

  describe('StreamConfigDefinition', () => {
    it('should accept stream config with version and wwwRoot', () => {
      const streamConfig: StreamConfigDefinition = {
        version: 1,
        wwwRoot: './renderers/jsonl'
      };

      expect(streamConfig.version).toBe(1);
      expect(streamConfig.wwwRoot).toBe('./renderers/jsonl');
    });

    it('should verify version is required and is number type', () => {
      type ConfigType = StreamConfigDefinition;

      expectTypeOf<ConfigType>().toHaveProperty('version').toEqualTypeOf<number>();
    });

    it('should verify wwwRoot is required and is string type', () => {
      type ConfigType = StreamConfigDefinition;

      expectTypeOf<ConfigType>().toHaveProperty('wwwRoot').toEqualTypeOf<string>();
    });

    it('should accept stream config with all optional fields', () => {
      const streamConfig: StreamConfigDefinition = {
        version: 2,
        wwwRoot: './renderers/logs',
        entrypoint: 'index.html',
        maxLineLength: 1024,
        maxStreamSize: 1048576
      };

      expect(streamConfig.version).toBe(2);
      expect(streamConfig.wwwRoot).toBe('./renderers/logs');
      expect(streamConfig.entrypoint).toBe('index.html');
      expect(streamConfig.maxLineLength).toBe(1024);
      expect(streamConfig.maxStreamSize).toBe(1048576);
    });
  });

  describe('EnvironmentConfig', () => {
    it('should accept full environment configuration', () => {
      const command: ActionCommand<'Launch'> = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand<'Launch'>;

      const envConfig: EnvironmentConfig = {
        version: 1,
        description: 'Test environment',
        actions: [command]
      };

      expect(envConfig.version).toBe(1);
      expect(envConfig.description).toBe('Test environment');
      expect(envConfig.actions).toHaveLength(1);
    });

    it('should accept minimal environment with only actions', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand;

      const envConfig: EnvironmentConfig = {
        actions: [command]
      };

      expect(envConfig.actions).toHaveLength(1);
      expect(envConfig.version).toBeUndefined();
      expect(envConfig.description).toBeUndefined();
    });

    it('should verify actions is required in EnvironmentConfig', () => {
      // Type-level check that actions is required
      type EnvType = EnvironmentConfig;

      expectTypeOf<EnvType>().toHaveProperty('actions');
      expectTypeOf<EnvType['actions']>().toEqualTypeOf<ActionCommand[]>();
    });

    it('should accept empty actions array', () => {
      const envConfig: EnvironmentConfig = {
        actions: []
      };

      expect(envConfig.actions).toHaveLength(0);
    });

    it('should verify optional fields are actually optional', () => {
      // Type-level check that optional fields are optional
      type EnvType = EnvironmentConfig;

      expectTypeOf<EnvType['version']>().toEqualTypeOf<number | undefined>();
      expectTypeOf<EnvType['description']>().toEqualTypeOf<string | undefined>();
    });

    it('should accept environment with streams', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand;

      const streamConfig: StreamConfigDefinition = {
        version: 1,
        wwwRoot: './renderers/jsonl'
      };

      const envConfig: EnvironmentConfig = {
        actions: [command],
        streams: {
          jsonl: streamConfig
        }
      };

      expect(envConfig.streams?.['jsonl']).toBe(streamConfig);
      expect(envConfig.streams?.['jsonl']!.version).toBe(1);
    });

    it('should accept environment without streams', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand;

      const envConfig: EnvironmentConfig = {
        actions: [command]
      };

      expect(envConfig.streams).toBeUndefined();
    });

    it('should verify streams field is optional', () => {
      // Type-level check that streams is optional
      type EnvType = EnvironmentConfig;

      expectTypeOf<EnvType['streams']>().toEqualTypeOf<Record<string, StreamConfigDefinition> | undefined>();
    });

    it('should accept multiple stream definitions', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand;

      const envConfig: EnvironmentConfig = {
        actions: [command],
        streams: {
          jsonl: { version: 1, wwwRoot: './renderers/jsonl' },
          logs: { version: 2, wwwRoot: './renderers/logs' }
        }
      };

      expect(Object.keys(envConfig.streams ?? {})).toHaveLength(2);
      expect(envConfig.streams?.['jsonl']!.version).toBe(1);
      expect(envConfig.streams?.['logs']!.version).toBe(2);
    });
  });

  describe('SettingsConfig', () => {
    it('should accept multiple environments', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand;

      const config: SettingsConfig = {
        environments: {
          default: {
            actions: [command]
          },
          production: {
            version: 1,
            description: 'Production environment',
            actions: [command]
          }
        }
      };

      expect(Object.keys(config.environments)).toHaveLength(2);
      expect(config.environments['default']).toBeDefined();
      expect(config.environments['production']).toBeDefined();
    });

    it('should accept single environment', () => {
      const command: ActionCommand = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand;

      const config: SettingsConfig = {
        environments: {
          default: {
            actions: [command]
          }
        }
      };

      expect(Object.keys(config.environments)).toHaveLength(1);
      expect(config.environments['default']).toBeDefined();
    });

    it('should verify environments is required in SettingsConfig', () => {
      // Type-level check that environments is required
      type ConfigType = SettingsConfig;

      expectTypeOf<ConfigType>().toHaveProperty('environments');
      expectTypeOf<ConfigType['environments']>().toEqualTypeOf<Record<string, EnvironmentConfig>>();
    });

    it('should accept empty environments object', () => {
      const config: SettingsConfig = {
        environments: {}
      };

      expect(Object.keys(config.environments)).toHaveLength(0);
    });
  });

  describe('integration scenarios', () => {
    it('should support real-world configuration pattern', () => {
      // Simulate real-world usage with multiple actions and types
      const launchCommand: ActionCommand<'Launch'> = {
        factoryType: 'action',
        actionName: 'Launch',
        description: 'Launch the application',
        icon: 'play'
      } as ActionCommand<'Launch'>;

      const deployCommand: ActionCommand<'Deploy'> = {
        factoryType: 'action',
        actionName: 'Deploy',
        description: 'Deploy to production',
        supportsBackgroundMode: true
      } as ActionCommand<'Deploy'>;

      const config: SettingsConfig = {
        environments: {
          development: {
            version: 1,
            description: 'Development environment',
            actions: [launchCommand, deployCommand]
          },
          production: {
            version: 1,
            description: 'Production environment',
            actions: [deployCommand]
          }
        }
      };

      expect(config.environments['development']!.actions).toHaveLength(2);
      expect(config.environments['production']!.actions).toHaveLength(1);
    });

    it('should enforce type safety across nested structures', () => {
      const command: ActionCommand<'TestAction'> = {
        factoryType: 'action',
        actionName: 'TestAction'
      } as ActionCommand<'TestAction'>;

      // Verify types flow through the entire structure
      const env: EnvironmentConfig = { actions: [command] };
      const config: SettingsConfig = { environments: { default: env } };

      // When widened to EnvironmentConfig/SettingsConfig, the literal type becomes string
      expectTypeOf(config.environments['default']!.actions[0]!.actionName).toEqualTypeOf<string>();

      // But the command itself preserves the literal type
      expectTypeOf(command.actionName).toEqualTypeOf<'TestAction'>();
    });

    it('should preserve literal action names through configuration layers', () => {
      // Test that literal types are preserved through all layers
      type Config = SettingsConfig & {
        environments: {
          default: EnvironmentConfig & {
            actions: [ActionCommand<'SpecificAction'>];
          };
        };
      };

      const command: ActionCommand<'SpecificAction'> = {
        factoryType: 'action',
        actionName: 'SpecificAction'
      } as ActionCommand<'SpecificAction'>;

      const config: Config = {
        environments: {
          default: {
            actions: [command]
          }
        }
      };

      expectTypeOf(config.environments['default']!.actions[0].actionName).toEqualTypeOf<'SpecificAction'>();
    });

    it('should support configuration with streams alongside actions', () => {
      const command: ActionCommand<'Launch'> = {
        factoryType: 'action',
        actionName: 'Launch'
      } as ActionCommand<'Launch'>;

      const config: SettingsConfig = {
        environments: {
          default: {
            version: 1,
            description: 'Full environment with streams',
            actions: [command],
            streams: {
              jsonl: { version: 1, wwwRoot: './renderers/jsonl' }
            }
          }
        }
      };

      expect(config.environments['default']!.actions).toHaveLength(1);
      expect(config.environments['default']!.streams?.['jsonl']).toBeDefined();
      expect(config.environments['default']!.streams?.['jsonl']!.version).toBe(1);
    });
  });
});

/**
 * Type-level tests for schema types.
 *
 * These tests verify that the schema types enforce correct structure
 * for settings.json using TypeScript's type system.
 *
 * @summary Type-level tests for schema types
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { Action, Command, Environment, Settings, StreamDefinition } from '../../src/config/schema.js';

// ============================================================================
// Command Tests
// ============================================================================

describe('Command', () => {
  it('should require command property', () => {
    expectTypeOf<Command>().toMatchTypeOf<{ command: string }>();
  });

  it('should allow command property as string', () => {
    const cmd: Command = { command: 'node ./bin/test.js' };
    expectTypeOf(cmd.command).toBeString();
  });

  it('should allow optional timeout property', () => {
    const cmdWithTimeout: Command = {
      command: 'node ./bin/test.js',
      timeout: 30000
    };
    expectTypeOf(cmdWithTimeout.timeout).toEqualTypeOf<number | undefined>();
  });

  it('should allow omitting timeout property', () => {
    const cmdWithoutTimeout: Command = { command: 'node ./bin/test.js' };
    expectTypeOf(cmdWithoutTimeout).toMatchTypeOf<Command>();
  });
});

// ============================================================================
// Action Tests
// ============================================================================

describe('Action', () => {
  it('should require name and command properties', () => {
    expectTypeOf<Action>().toMatchTypeOf<{
      name: string;
      command: Command;
    }>();
  });

  it('should allow minimal action with only required fields', () => {
    const minimalAction: Action = {
      id: 'test-action',
      name: 'Test Action',
      command: { command: 'node ./bin/test.js' }
    };
    expectTypeOf(minimalAction).toMatchTypeOf<Action>();
  });

  it('should require id property', () => {
    const actionWithId: Action = {
      id: 'test-action',
      name: 'Test Action',
      command: { command: 'node ./bin/test.js' }
    };
    expectTypeOf(actionWithId.id).toEqualTypeOf<string>();
  });

  it('should allow optional description property', () => {
    const actionWithDescription: Action = {
      id: 'test-action',
      name: 'Test Action',
      description: 'A test action',
      command: { command: 'node ./bin/test.js' }
    };
    expectTypeOf(actionWithDescription.description).toEqualTypeOf<string | undefined>();
  });

  it('should allow optional icon property', () => {
    const actionWithIcon: Action = {
      id: 'test-action',
      name: 'Test Action',
      icon: 'rocket',
      command: { command: 'node ./bin/test.js' }
    };
    expectTypeOf(actionWithIcon.icon).toEqualTypeOf<string | undefined>();
  });

  it('should allow optional supportsBackgroundMode property', () => {
    const actionWithBackground: Action = {
      id: 'test-action',
      name: 'Test Action',
      command: { command: 'node ./bin/test.js' },
      supportsBackgroundMode: true
    };
    expectTypeOf(actionWithBackground.supportsBackgroundMode).toEqualTypeOf<boolean | undefined>();
  });

  it('should allow all properties together', () => {
    const fullAction: Action = {
      id: 'test-action',
      name: 'Test Action',
      description: 'A test action',
      icon: 'rocket',
      command: { command: 'node ./bin/test.js', timeout: 30000 },
      supportsBackgroundMode: true
    };
    expectTypeOf(fullAction).toMatchTypeOf<Action>();
  });
});

// ============================================================================
// StreamDefinition Tests
// ============================================================================

describe('StreamDefinition', () => {
  it('should require version and wwwRoot properties', () => {
    expectTypeOf<StreamDefinition>().toMatchTypeOf<{
      version: number;
      wwwRoot: string;
    }>();
  });

  it('should require version to be a number', () => {
    const streamDef: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session'
    };
    expectTypeOf(streamDef.version).toBeNumber();
  });

  it('should require wwwRoot to be a string', () => {
    const streamDef: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session'
    };
    expectTypeOf(streamDef.wwwRoot).toBeString();
  });

  it('should allow minimal stream definition with only required fields', () => {
    const minimalStream: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session'
    };
    expectTypeOf(minimalStream).toMatchTypeOf<StreamDefinition>();
  });

  it('should allow optional entrypoint property', () => {
    const streamWithEntrypoint: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session',
      entrypoint: 'index.html'
    };
    expectTypeOf(streamWithEntrypoint.entrypoint).toEqualTypeOf<string | undefined>();
  });

  it('should allow optional maxLineLength property', () => {
    const streamWithMaxLine: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session',
      maxLineLength: 1024
    };
    expectTypeOf(streamWithMaxLine.maxLineLength).toEqualTypeOf<number | undefined>();
  });

  it('should allow optional maxStreamSize property', () => {
    const streamWithMaxSize: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session',
      maxStreamSize: 1048576
    };
    expectTypeOf(streamWithMaxSize.maxStreamSize).toEqualTypeOf<number | undefined>();
  });

  it('should allow all properties together', () => {
    const fullStream: StreamDefinition = {
      version: 1,
      wwwRoot: './renderers/claude-session',
      entrypoint: 'index.html',
      maxLineLength: 1024,
      maxStreamSize: 1048576
    };
    expectTypeOf(fullStream).toMatchTypeOf<StreamDefinition>();
  });
});

// ============================================================================
// Environment Tests
// ============================================================================

describe('Environment', () => {
  it('should require version and actions properties', () => {
    expectTypeOf<Environment>().toMatchTypeOf<{
      version: number;
      actions: Action[];
    }>();
  });

  it('should allow minimal environment with only required fields', () => {
    const minimalEnv: Environment = {
      version: 1,
      actions: []
    };
    expectTypeOf(minimalEnv).toMatchTypeOf<Environment>();
  });

  it('should require actions to be an array', () => {
    const env: Environment = {
      version: 1,
      actions: [
        {
          id: 'test',
          name: 'Test',
          command: { command: 'node ./bin/test.js' }
        }
      ]
    };
    expectTypeOf(env.actions).toEqualTypeOf<Action[]>();
  });

  it('should allow optional description property', () => {
    const envWithDescription: Environment = {
      version: 1,
      description: 'Test environment',
      actions: []
    };
    expectTypeOf(envWithDescription.description).toEqualTypeOf<string | undefined>();
  });

  it('should allow optional streams property', () => {
    const envWithStreams: Environment = {
      version: 1,
      actions: [],
      streams: {
        logs: {
          version: 1,
          wwwRoot: './renderers/logs'
        }
      }
    };
    expectTypeOf(envWithStreams.streams).toEqualTypeOf<Record<string, StreamDefinition> | undefined>();
  });

  it('should allow streams to be a record of StreamDefinitions', () => {
    const env: Environment = {
      version: 1,
      actions: [],
      streams: {
        logs: {
          version: 1,
          wwwRoot: './renderers/logs'
        },
        metrics: {
          version: 1,
          wwwRoot: './renderers/metrics'
        }
      }
    };
    if (env.streams) {
      expectTypeOf(env.streams!['logs']!).toMatchTypeOf<StreamDefinition>();
      expectTypeOf(env.streams!['metrics']!).toMatchTypeOf<StreamDefinition>();
    }
  });

  it('should allow all properties together', () => {
    const fullEnv: Environment = {
      version: 1,
      description: 'Full environment',
      actions: [
        {
          id: 'test-action',
          name: 'Test Action',
          command: { command: 'node ./bin/test.js' }
        }
      ],
      streams: {
        logs: {
          version: 1,
          wwwRoot: './renderers/logs',
          entrypoint: 'index.html',
          maxLineLength: 1024,
          maxStreamSize: 1048576
        }
      }
    };
    expectTypeOf(fullEnv).toMatchTypeOf<Environment>();
  });
});

// ============================================================================
// Settings Tests
// ============================================================================

describe('Settings', () => {
  it('should require environments property', () => {
    expectTypeOf<Settings>().toMatchTypeOf<{
      environments: Record<string, Environment>;
    }>();
  });

  it('should allow environments to be a record of Environments', () => {
    const settings: Settings = {
      environments: {
        default: {
          version: 1,
          actions: []
        }
      }
    };
    expectTypeOf(settings.environments).toEqualTypeOf<Record<string, Environment>>();
  });

  it('should allow multiple environments', () => {
    const settings: Settings = {
      environments: {
        default: {
          version: 1,
          actions: []
        },
        production: {
          version: 1,
          actions: []
        }
      }
    };
    expectTypeOf(settings.environments['default']!).toMatchTypeOf<Environment>();
    expectTypeOf(settings.environments['production']!).toMatchTypeOf<Environment>();
  });

  it('should allow complex nested structure', () => {
    const settings: Settings = {
      environments: {
        default: {
          version: 1,
          description: 'Default environment',
          actions: [
            {
              id: 'launch',
              name: 'Launch Claude',
              description: 'Launch Claude in a new window',
              icon: 'rocket',
              command: { command: 'node ./bin/launch.js', timeout: 30000 },
              supportsBackgroundMode: true
            }
          ]
        }
      }
    };
    expectTypeOf(settings).toMatchTypeOf<Settings>();
  });
});

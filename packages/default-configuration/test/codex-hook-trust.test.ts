/**
 * Locks the Codex hook trust hash + key algorithm against ground-truth fixtures
 * captured from Codex 0.137.0 (see the card's spike note). The runtime and
 * assistant bundle hashes are install-path independent, so a drift in the
 * serialization pipeline — key order, omitted optionals, the `async`/`timeout`
 * normalization, or the event-label mapping — surfaces here rather than as a
 * silent review prompt at launch. The timeout / statusMessage regression
 * fixtures are likewise oracle-derived (see spike/hash-ground-truth), guarding
 * the fail-closed requirement that this module never seed a hash Codex won't
 * itself compute for a non-default handler field.
 *
 * @summary Tests the Codex hook trust hash + key helpers
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildPluginHooksState,
  commandHookHash,
  type HooksJson,
  hookEventKeyLabel,
  selectHashedCommand
} from '../src/lib/codex-hook-trust.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const codexRoot = path.resolve(here, '../../../codex');

/**
 * Reads and parses a bundled `hooks.json` from the repo's packaged Codex tree.
 *
 * @param relative - Path under `public/codex` (e.g. `runtime/hooks/hooks.json`).
 * @returns The parsed hooks object.
 */
function readBundleHooks(relative: string): HooksJson {
  return JSON.parse(readFileSync(path.join(codexRoot, relative), 'utf-8')) as HooksJson;
}

describe('codex-hook-trust', () => {
  it('hookEventKeyLabel maps every PascalCase event to its snake_case label', () => {
    expect(hookEventKeyLabel('PreToolUse')).toBe('pre_tool_use');
    expect(hookEventKeyLabel('PermissionRequest')).toBe('permission_request');
    expect(hookEventKeyLabel('PostToolUse')).toBe('post_tool_use');
    expect(hookEventKeyLabel('PreCompact')).toBe('pre_compact');
    expect(hookEventKeyLabel('PostCompact')).toBe('post_compact');
    expect(hookEventKeyLabel('SessionStart')).toBe('session_start');
    expect(hookEventKeyLabel('UserPromptSubmit')).toBe('user_prompt_submit');
    expect(hookEventKeyLabel('SubagentStart')).toBe('subagent_start');
    expect(hookEventKeyLabel('SubagentStop')).toBe('subagent_stop');
    expect(hookEventKeyLabel('Stop')).toBe('stop');
  });

  it('hookEventKeyLabel fails closed on an unknown event key', () => {
    expect(() => hookEventKeyLabel('Notification')).toThrow(/Unknown Codex hook event key/);
  });

  it('buildPluginHooksState reproduces the runtime bundle ground-truth keys + hashes', () => {
    const json = readBundleHooks('runtime/hooks/hooks.json');
    const state = buildPluginHooksState('runtime@local', 'hooks/hooks.json', json);

    expect(state).toEqual({
      'runtime@local:hooks/hooks.json:session_start:0:0': {
        trusted_hash: 'sha256:21d730d0414d7091677bd53ef201c488c18439fc3ac718785df55646241eaae8'
      },
      'runtime@local:hooks/hooks.json:session_start:1:0': {
        trusted_hash: 'sha256:6146bc10073c31e58aa110b6221c8876f1111120ff014cb6382dc556e27e38a9'
      },
      'runtime@local:hooks/hooks.json:subagent_start:0:0': {
        trusted_hash: 'sha256:0bd046db0832f7f396d80a6c048087a24b2d17ed59c9d6113ef07c02f3bf8fdd'
      },
      'runtime@local:hooks/hooks.json:subagent_stop:0:0': {
        trusted_hash: 'sha256:66e82567070ae6fb22862a19bcdb46ef3bd4517dca31c385705baf6e9aa56c99'
      },
      'runtime@local:hooks/hooks.json:stop:0:0': {
        trusted_hash: 'sha256:295405e4ed87f8b94dbe4959dd53247b1f0de243566a5926292fd56de2ba4f23'
      },
      'runtime@local:hooks/hooks.json:stop:0:1': {
        trusted_hash: 'sha256:902d29aba108bdf1301b3c0d7abd5f2e90bb1e90fcbe3ce49b64b8c2c4010bc0'
      }
    });
  });

  it('buildPluginHooksState reproduces the assistant bundle ground-truth key + hash', () => {
    const json = readBundleHooks('cards-assistant/hooks/hooks.json');
    const state = buildPluginHooksState('cards-assistant@local', 'hooks/hooks.json', json);

    expect(state).toEqual({
      'cards-assistant@local:hooks/hooks.json:session_start:0:0': {
        // Identical normalized command to runtime session_start:0:0 — same hash,
        // key differs only by plugin id.
        trusted_hash: 'sha256:21d730d0414d7091677bd53ef201c488c18439fc3ac718785df55646241eaae8'
      }
    });
  });

  it('forces the matcher to null for Stop even when the group declares one', () => {
    // A synthetic Stop group WITH a matcher must hash as if it had none.
    const withMatcher: HooksJson = {
      hooks: {
        Stop: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'CMD' }] }]
      }
    };
    const state = buildPluginHooksState('p@local', 'hooks/hooks.json', withMatcher);
    const hash = state['p@local:hooks/hooks.json:stop:0:0']!.trusted_hash;

    // Equals the hash of a Stop hook with no matcher (matcher dropped from JSON).
    expect(hash).toBe(commandHookHash('stop', null, { command: 'CMD' }));
    // And differs from the would-be hash if the matcher had been kept.
    expect(hash).not.toBe(commandHookHash('stop', 'ignored', { command: 'CMD' }));
  });

  it('keeps a SessionStart matcher (compact) — matches the known compact hash', () => {
    const compact: HooksJson = {
      hooks: {
        SessionStart: [
          {
            matcher: 'compact',
            hooks: [
              {
                type: 'command',
                command:
                  '"$(cat $HOME/.cards/VSCODE_NODE 2>/dev/null || echo node)" "${PLUGIN_ROOT}/hooks/session-start-after-compaction.mjs"'
              }
            ]
          }
        ]
      }
    };
    const state = buildPluginHooksState('runtime@local', 'hooks/hooks.json', compact);

    expect(state['runtime@local:hooks/hooks.json:session_start:0:0']!.trusted_hash).toBe(
      'sha256:f3768ee10f2ba13e29d615d8ca9b9809a3fb45213d671ed4fbf22fabae7bf0b6'
    );
  });

  it('skips prompt/agent handlers while keeping positional indices', () => {
    const mixed: HooksJson = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'prompt', command: 'IGNORED-PROMPT' },
              { type: 'command', command: 'CMD-A' },
              { type: 'agent', command: 'IGNORED-AGENT' },
              { type: 'command', command: 'CMD-B' }
            ]
          }
        ]
      }
    };
    const state = buildPluginHooksState('p@local', 'hooks/hooks.json', mixed);

    // Only the two command handlers are seeded, at their original positions 1 and 3.
    expect(Object.keys(state)).toEqual([
      'p@local:hooks/hooks.json:session_start:0:1',
      'p@local:hooks/hooks.json:session_start:0:3'
    ]);
    expect(state['p@local:hooks/hooks.json:session_start:0:1']!.trusted_hash).toBe(
      commandHookHash('session_start', null, { command: 'CMD-A' })
    );
    expect(state['p@local:hooks/hooks.json:session_start:0:3']!.trusted_hash).toBe(
      commandHookHash('session_start', null, { command: 'CMD-B' })
    );
  });

  it('skips an async command handler while a following command keeps its index', () => {
    // An async:true command handler is never trusted/run by Codex, so it seeds
    // no key — but its positional handler index must still be consumed.
    const withAsync: HooksJson = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'ASYNC-CMD', async: true },
              { type: 'command', command: 'SYNC-CMD' }
            ]
          }
        ]
      }
    };
    const state = buildPluginHooksState('p@local', 'hooks/hooks.json', withAsync);

    // Only the synchronous handler is seeded, and it keeps its original index 1.
    expect(Object.keys(state)).toEqual(['p@local:hooks/hooks.json:session_start:0:1']);
    expect(state['p@local:hooks/hooks.json:session_start:0:1']!.trusted_hash).toBe(
      commandHookHash('session_start', null, { command: 'SYNC-CMD' })
    );
  });

  it('threads a non-default timeout into the hash (oracle: timeout=30 vs default 600)', () => {
    // Oracle hashes generated by the Rust ground-truth harness (spike/hash-ground-truth):
    //   command_hook_hash_full("session_start", None, "CMD", Some(30)/None, None)
    const defaultHash = 'sha256:d5bc175a0abda4cdf9a23459c805477e9c3ecfe47df6c93d79c4ba533cb66fc4';
    const timeout30Hash = 'sha256:8fbb2f8fa93af6170686b0ea458de8478548992218e86d6e81bd3dad32774528';

    // An omitted timeout normalizes to Codex's 600 default.
    expect(commandHookHash('session_start', null, { command: 'CMD' })).toBe(defaultHash);
    expect(commandHookHash('session_start', null, { command: 'CMD', timeout: 600 })).toBe(defaultHash);

    // A declared non-default timeout changes the hash.
    const t30 = commandHookHash('session_start', null, { command: 'CMD', timeout: 30 });
    expect(t30).toBe(timeout30Hash);
    expect(t30).not.toBe(defaultHash);

    // It flows through buildPluginHooksState end-to-end.
    const json: HooksJson = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'CMD', timeout: 30 }] }]
      }
    };
    const state = buildPluginHooksState('p@local', 'hooks/hooks.json', json);
    expect(state['p@local:hooks/hooks.json:session_start:0:0']!.trusted_hash).toBe(timeout30Hash);
  });

  it('includes a declared statusMessage in the hashed identity (oracle-derived)', () => {
    // Oracle hash from the harness:
    //   command_hook_hash_full("session_start", None, "CMD", None, Some("Running"))
    const statusHash = 'sha256:d9938985342d4af2b9537fc253996cb532db89a28403ada9d23ba92bc3db466d';
    const defaultHash = 'sha256:d5bc175a0abda4cdf9a23459c805477e9c3ecfe47df6c93d79c4ba533cb66fc4';

    const withStatus = commandHookHash('session_start', null, {
      command: 'CMD',
      statusMessage: 'Running'
    });
    expect(withStatus).toBe(statusHash);
    // Omitting it (None) yields a different hash — statusMessage is part of identity.
    expect(withStatus).not.toBe(defaultHash);

    const json: HooksJson = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'CMD', statusMessage: 'Running' }] }]
      }
    };
    const state = buildPluginHooksState('p@local', 'hooks/hooks.json', json);
    expect(state['p@local:hooks/hooks.json:session_start:0:0']!.trusted_hash).toBe(statusHash);
  });

  it('fails closed when a command handler carries an unmodeled field', () => {
    // A field the trust hash does not model would be silently dropped from the
    // hashed identity, seeding a valid-but-wrong hash — so seeding must abort.
    const withUnknownField: HooksJson = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'x', frobnicate: true } as never] }]
      }
    };
    expect(() => buildPluginHooksState('p@local', 'hooks/hooks.json', withUnknownField)).toThrow(/frobnicate/);
    // The error names the positional location using the same snake_case event
    // label as the seeded hook key (not the PascalCase JSON key).
    expect(() => buildPluginHooksState('p@local', 'hooks/hooks.json', withUnknownField)).toThrow(/session_start:0:0/);
    expect(() => buildPluginHooksState('p@local', 'hooks/hooks.json', withUnknownField)).toThrow(
      /p@local.*hooks\/hooks\.json/
    );
  });

  it('validates unmodeled fields even on a skipped async handler', () => {
    // async:true handlers are skipped before seeding, but an unmodeled field on
    // one must still abort the launch — not slip through unseeded.
    const asyncWithUnknownField: HooksJson = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'x', async: true, frobnicate: true } as never] }]
      }
    };
    expect(() => buildPluginHooksState('p@local', 'hooks/hooks.json', asyncWithUnknownField)).toThrow(/frobnicate/);
  });

  it('does not trip the unmodeled-field guard on bundled hooks or modeled fixtures', () => {
    // The six bundled hooks carry only type+command.
    expect(() =>
      buildPluginHooksState('runtime@local', 'hooks/hooks.json', readBundleHooks('runtime/hooks/hooks.json'))
    ).not.toThrow();
    expect(() =>
      buildPluginHooksState(
        'cards-assistant@local',
        'hooks/hooks.json',
        readBundleHooks('cards-assistant/hooks/hooks.json')
      )
    ).not.toThrow();

    // The modeled timeout / statusMessage / async fields are all permitted.
    const modeled: HooksJson = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'A', timeout: 30 },
              { type: 'command', command: 'B', statusMessage: 'Running' },
              { type: 'command', command: 'C', async: true },
              { type: 'command', command: 'D', commandWindows: 'D-WIN' }
            ]
          }
        ]
      }
    };
    expect(() => buildPluginHooksState('p@local', 'hooks/hooks.json', modeled)).not.toThrow();
  });

  it('selectHashedCommand mirrors Codex per-host commandWindows selection', () => {
    const handler = { command: 'POSIX-CMD', commandWindows: 'WIN-CMD' };

    // On win32, commandWindows wins; elsewhere the plain command is used.
    expect(selectHashedCommand(handler, 'win32')).toBe('WIN-CMD');
    expect(selectHashedCommand(handler, 'linux')).toBe('POSIX-CMD');
    expect(selectHashedCommand(handler, 'darwin')).toBe('POSIX-CMD');

    // On win32 with no commandWindows, the plain command is used.
    expect(selectHashedCommand({ command: 'ONLY-POSIX' }, 'win32')).toBe('ONLY-POSIX');

    // commandWindows never appears in the hashed identity: on a non-win32 host
    // the selected command (POSIX-CMD) hashes identically whether or not a
    // commandWindows was declared.
    expect(commandHookHash('session_start', null, { command: 'POSIX-CMD' })).toBe(
      commandHookHash('session_start', null, { command: selectHashedCommand(handler, 'linux') })
    );
  });
});

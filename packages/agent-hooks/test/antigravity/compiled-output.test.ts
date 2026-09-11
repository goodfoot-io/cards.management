/**
 * Integration coverage for the compiled Antigravity runtime plugin output.
 *
 * Runs the real build end-to-end and pins the emitted `public/antigravity/runtime`
 * tree: the exact three-entry hooks.json matrix (registrations, relative
 * command paths, bounded timeouts, no matcher/PreToolUse entries), the exact
 * `bin/` bundle set, and the spawned-bundle invariants (clean load, inert
 * response, fail-closed failure marker) under an isolated Cards home.
 *
 * @summary Compiled Antigravity output must be complete, exact, and loadable
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_HOOK_REGISTRATIONS,
  ANTIGRAVITY_HOOK_TIMEOUT_SECONDS,
  antigravityHooksJson
} from '../../scripts/build.mjs';

const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const runtimeRoot = resolve(packageRoot, '../../antigravity/runtime');
const hooksJsonPath = join(runtimeRoot, 'hooks.json');
const binDir = join(runtimeRoot, 'bin');

const tempHomes: string[] = [];

/**
 * Isolated environment for spawned bundles: a disposable CARDS_HOME and HOME,
 * no Cards action variables unless a test sets them explicitly.
 *
 * @returns A minimal environment safe for spawning any compiled hook bundle.
 */
function isolatedHookEnvironment(): Record<string, string> {
  const cardsHome = mkdtempSync(join(tmpdir(), 'antigravity-hook-home-'));
  const home = mkdtempSync(join(tmpdir(), 'antigravity-hook-cards-'));
  tempHomes.push(cardsHome, home);
  return {
    HOME: home,
    CARDS_HOME: cardsHome,
    PATH: process.env['PATH'] ?? ''
  };
}

/**
 * A full Cards action environment pointing at an inaccessible card repository.
 *
 * @param env - Base environment to extend.
 * @returns The action environment with every required variable set to
 *   broken-but-present values.
 */
function brokenActionEnvironment(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    CARD_ID: 'main-453',
    ANTIGRAVITY_SESSION_ID: 'session-453',
    ACTION_NAME: 'Launch',
    ENVIRONMENT: 'default',
    EXECUTION_MODE: 'background',
    EXIT_WHEN_DONE: 'false',
    REPO_ROOT: '/nonexistent-repo',
    CARD_REPO_PATH: '/nonexistent-card-repo',
    CONFIG_PATH: '/nonexistent-config',
    EXTENSION_PATH: '/nonexistent-extension',
    MARKETPLACE_PATH: '/nonexistent-marketplace'
  };
}

const PINNED_HOOKS_JSON = {
  [ANTIGRAVITY_HOOK_NAME]: {
    PreInvocation: [
      { type: 'command', command: 'node bin/runtime-pre-invocation.mjs', timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS }
    ],
    PostInvocation: [
      { type: 'command', command: 'node bin/runtime-post-invocation.mjs', timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS }
    ],
    Stop: [{ type: 'command', command: 'node bin/runtime-stop.mjs', timeout: ANTIGRAVITY_HOOK_TIMEOUT_SECONDS }]
  }
};

describe('compiled Antigravity runtime output', () => {
  afterAll(() => {
    for (const home of tempHomes) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits exactly the pinned hooks.json document', () => {
    expect(existsSync(hooksJsonPath)).toBe(true);
    expect(JSON.parse(readFileSync(hooksJsonPath, 'utf8'))).toEqual(PINNED_HOOKS_JSON);
    expect(JSON.parse(readFileSync(hooksJsonPath, 'utf8'))).toEqual(antigravityHooksJson());
  });

  it('registers exactly the three pinned events with relative bin paths and bounded timeouts', () => {
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as Record<
      string,
      Record<string, Array<{ type: string; command: string; timeout: number }>>
    >;
    expect(Object.keys(hooks)).toEqual([ANTIGRAVITY_HOOK_NAME]);
    const events = hooks[ANTIGRAVITY_HOOK_NAME] ?? {};
    expect(Object.keys(events).sort()).toEqual(['PostInvocation', 'PreInvocation', 'Stop']);
    for (const registration of ANTIGRAVITY_HOOK_REGISTRATIONS) {
      const entries = events[registration.event];
      expect(entries).toHaveLength(1);
      const command = entries?.[0];
      expect(command?.type).toBe('command');
      expect(command?.command).toBe(`node bin/${registration.handler}`);
      expect(command?.command.startsWith('node bin/')).toBe(true);
      expect(typeof command?.timeout).toBe('number');
      expect(command?.timeout).toBeGreaterThanOrEqual(1);
      expect(command?.timeout).toBeLessThanOrEqual(300);
    }
  });

  it('ships no matcher or PreToolUse entries', () => {
    const raw = readFileSync(hooksJsonPath, 'utf8');
    expect(raw).not.toContain('matcher');
    expect(raw).not.toContain('PreToolUse');
    expect(raw).not.toContain('"decision"');
    expect(raw).not.toContain('"continue"');
  });

  it('emits exactly the pinned bin bundle set', () => {
    const emitted = readdirSync(binDir).sort();
    const expected = ANTIGRAVITY_HOOK_REGISTRATIONS.map((registration) => registration.handler).sort();
    expect(emitted).toEqual(expected);
  });

  it('every bundle loads cleanly and answers inertly outside a Cards action', () => {
    const failures: string[] = [];
    for (const handler of ANTIGRAVITY_HOOK_REGISTRATIONS.map((registration) => registration.handler)) {
      const bundle = join(binDir, handler);
      const result = spawnSync(process.execPath, [bundle], {
        input: '{}\n',
        encoding: 'utf8',
        env: isolatedHookEnvironment(),
        timeout: 15_000
      });
      if (/Dynamic require of/.test(result.stderr ?? '')) {
        failures.push(`${bundle}: ${result.stderr?.split('\n').slice(0, 4).join('\n')}`);
      }
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
    }
    expect(failures).toEqual([]);
  });

  it('the Stop bundle fails closed with a failure marker when the input is invalid', () => {
    const env = brokenActionEnvironment(isolatedHookEnvironment());
    const cardsHome = env['CARDS_HOME'] as string;
    const result = spawnSync(process.execPath, [join(binDir, 'runtime-stop.mjs')], {
      input: '{}\n',
      encoding: 'utf8',
      env,
      timeout: 15_000
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const failurePath = join(
      cardsHome,
      'antigravity',
      'runtime',
      'markers',
      'session-453',
      'unknown-conversation.failure'
    );
    expect(existsSync(failurePath)).toBe(true);
    const payload = JSON.parse(readFileSync(failurePath, 'utf8')) as { stage: string };
    expect(payload.stage).toBe('input');
  });

  it('the PreInvocation bundle fails closed with a failure marker when the input is invalid', () => {
    const env = brokenActionEnvironment(isolatedHookEnvironment());
    const cardsHome = env['CARDS_HOME'] as string;
    const result = spawnSync(process.execPath, [join(binDir, 'runtime-pre-invocation.mjs')], {
      input: `${JSON.stringify({ conversationId: 'conv-live-453' })}\n`,
      encoding: 'utf8',
      env,
      timeout: 15_000
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const failurePath = join(cardsHome, 'antigravity', 'runtime', 'markers', 'session-453', 'conv-live-453.failure');
    expect(existsSync(failurePath)).toBe(true);
  });
});

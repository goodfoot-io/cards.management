/**
 * Contract checks for the Antigravity session lib: CLI argument construction
 * (interactive `-i` / background `-p --output-format stream-json`, never
 * `--dangerously-skip-permissions`) and the pre-spawn refusal of blank model
 * or effort selections.
 *
 * @summary Antigravity session-lib argv and execution-control contract
 * @module
 */

import { describe, expect, it } from 'vitest';

describe('buildAntigravityArgs', () => {
  it('builds terminal-owned interactive argv from -i plus the prompt', async () => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');

    expect(buildAntigravityArgs('Load the `cards:card` skill.', 'interactive')).toEqual([
      '-i',
      'Load the `cards:card` skill.'
    ]);
  });

  it('builds child-owned background argv from -p plus the prompt with stream-json output', async () => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');

    expect(buildAntigravityArgs('Run the launch routing.', 'background')).toEqual([
      '-p',
      'Run the launch routing.',
      '--output-format',
      'stream-json'
    ]);
  });

  it('passes no prompt argument for a prompt-less interactive launch', async () => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');

    expect(buildAntigravityArgs(undefined, 'interactive')).toEqual(['-i']);
  });

  it('refuses a background launch without a prompt (nothing to run one-shot)', async () => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');

    expect(() => buildAntigravityArgs(undefined, 'background')).toThrow(/prompt/i);
  });

  it('never passes --dangerously-skip-permissions in either mode', async () => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');

    for (const executionMode of ['interactive', 'background'] as const) {
      const args = buildAntigravityArgs('prompt', executionMode);
      expect(args).not.toContain('--dangerously-skip-permissions');
    }
  });
});

describe('Antigravity action argument matrix', () => {
  it.each([
    ['interactive', undefined, {}, ['-i']],
    [
      'interactive',
      undefined,
      { model: 'gemini-3-pro', effort: 'high' },
      ['-i', '--model', 'gemini-3-pro', '--effort', 'high']
    ],
    ['interactive', 'prompt', {}, ['-i', 'prompt']],
    ['interactive', 'prompt', { model: 'gemini-3-pro' }, ['-i', 'prompt', '--model', 'gemini-3-pro']],
    ['interactive', 'prompt', { effort: 'high' }, ['-i', 'prompt', '--effort', 'high']],
    [
      'background',
      'prompt',
      { model: 'gemini-3-pro', effort: 'high' },
      ['-p', 'prompt', '--output-format', 'stream-json', '--model', 'gemini-3-pro', '--effort', 'high']
    ]
  ] as const)('builds %s prompt/control argv without silently dropping selections', async (mode, prompt, controls, expected) => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');
    expect(buildAntigravityArgs(prompt, mode, controls)).toEqual(expected);
  });

  it('rejects blank model/effort values and background mode without a prompt before spawn', async () => {
    const { buildAntigravityArgs } = await import('../src/lib/antigravity-session.js');
    expect(() => buildAntigravityArgs('prompt', 'interactive', { model: '' })).toThrow(/model/i);
    expect(() => buildAntigravityArgs('prompt', 'interactive', { effort: ' ' })).toThrow(/effort/i);
    expect(() => buildAntigravityArgs(undefined, 'background', { model: 'gemini-3-pro' })).toThrow(/prompt/i);
  });
});

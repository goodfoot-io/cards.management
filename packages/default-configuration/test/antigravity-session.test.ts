/**
 * Contract checks for the Antigravity session lib: CLI argument construction
 * (interactive `-i` / background `-p --output-format stream-json`, never
 * `--dangerously-skip-permissions`), the pre-spawn refusal of blank model
 * or effort selections, and the hook-failure reader's marker selection.
 *
 * @summary Antigravity session-lib argv, execution-control, and marker-reader contract
 * @module
 */

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('readAntigravityHookFailure marker selection', () => {
  const SESSION_ID = '9c1f4a52-6b3e-4d18-a7c0-51e2b8d94031';
  const CONVERSATION_ID = '3f7b2c11-8a4d-4e63-9b05-6c2d7e8f1a24';
  const PLACEHOLDER = 'unknown-conversation';
  const SCOPED = {
    stage: 'action-env',
    reason: '[action-env] the Cards action environment is missing or malformed'
  };
  const RETRIED = { stage: 'watcher-setup', reason: '[watcher-setup] spawn returned false' };

  /**
   * Lays out a real marker session directory under a fresh Cards home.
   *
   * @param markers - Marker file names mapped to their JSON payloads.
   * @returns The Cards home and the session directory it holds.
   */
  async function makeSessionDirectory(
    markers: Record<string, { stage: string; reason: string }>
  ): Promise<{ cardsHome: string; sessionDirectory: string }> {
    const cardsHome = await mkdtemp(join(tmpdir(), 'agy-marker-reader-'));
    const sessionDirectory = join(cardsHome, 'antigravity', 'runtime', 'markers', SESSION_ID);
    await mkdir(sessionDirectory, { recursive: true });
    for (const [name, payload] of Object.entries(markers)) {
      await writeFile(join(sessionDirectory, name), JSON.stringify(payload));
    }
    return { cardsHome, sessionDirectory };
  }

  /**
   * Reads one fixture with the real reader, restoring `CARDS_HOME` after.
   *
   * @param cardsHome - Cards home holding the marker fixture.
   * @returns The reader's formatted failure text.
   */
  async function readWithCardsHome(cardsHome: string): Promise<string | undefined> {
    const previous = process.env['CARDS_HOME'];
    process.env['CARDS_HOME'] = cardsHome;
    try {
      const { readAntigravityHookFailure } = await import('../src/lib/antigravity-session.js');
      return await readAntigravityHookFailure(SESSION_ID);
    } finally {
      if (previous === undefined) {
        delete process.env['CARDS_HOME'];
      } else {
        process.env['CARDS_HOME'] = previous;
      }
    }
  }

  it('surfaces the conversation-scoped marker when the placeholder sits beside it', async () => {
    const { cardsHome, sessionDirectory } = await makeSessionDirectory({
      [`${CONVERSATION_ID}.failure`]: SCOPED,
      [`${PLACEHOLDER}.failure`]: RETRIED
    });

    try {
      // Both names are on disk before the read, so what the assertion pins is
      // the reader's selection rather than which marker happened to exist: the
      // retry the transport writes can never shadow a scoped marker.
      await expect(access(join(sessionDirectory, `${CONVERSATION_ID}.failure`))).resolves.toBeUndefined();
      await expect(access(join(sessionDirectory, `${PLACEHOLDER}.failure`))).resolves.toBeUndefined();

      await expect(readWithCardsHome(cardsHome)).resolves.toBe(`${SCOPED.stage}: ${SCOPED.reason}`);
    } finally {
      await rm(cardsHome, { recursive: true, force: true });
    }
  });

  it('surfaces the placeholder marker when it is the only one the session holds', async () => {
    const { cardsHome } = await makeSessionDirectory({ [`${PLACEHOLDER}.failure`]: RETRIED });

    try {
      await expect(readWithCardsHome(cardsHome)).resolves.toBe(`${RETRIED.stage}: ${RETRIED.reason}`);
    } finally {
      await rm(cardsHome, { recursive: true, force: true });
    }
  });
});

/**
 * Reproduction coverage for the Claude root-turn admission gate.
 *
 * A Cards-launched session's first `UserPromptSubmit` arrives before the host
 * has written the session transcript, so the gate must read an absent
 * transcript as "no prior turns" rather than failing admission. Every case
 * here drives the shipped handler through its authority seam with a
 * `transcript_path` that deliberately does not exist, a state the earlier
 * witness for this handler could not reach: it pre-wrote its transcript and so
 * only ever exercised a mid-session turn.
 *
 * @summary Claude root-turn admission against an unwritten transcript
 * @module user-prompt-submit.test
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, userPromptSubmitHook } from '@goodfoot/agent-hooks/claude-code';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createClaudeTurnHandler } from '../../../src/claude/runtime/user-prompt-submit.js';
import type { WorkAuthority } from '../../../src/shared/work-authority.js';

const sessionId = 'sess-main-704';
const prompt = 'Fix the first-turn admission failure.';
const promptDigest = createHash('sha256').update(prompt).digest('hex');

let scratch: string;
let transcriptPath: string;
let context: { logger: Logger };
let admission: Mock<WorkAuthority['admit']>;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'claude-turn-admission-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  // A fresh path per case that is never written: the state a session's first
  // turn observes. The parent directory does exist, matching the incident
  // host's `<projects>/<slug>/<session>.jsonl` layout.
  transcriptPath = join(scratch, `transcript-${randomUUID()}.jsonl`);
  admission = vi.fn<WorkAuthority['admit']>(async () => ({ workRevision: 1 }));
  context = { logger: new Logger() };
});

function buildHook() {
  return userPromptSubmitHook(
    {},
    createClaudeTurnHandler(() => ({ admit: admission, observeRevision: async () => 1 }))
  );
}

function turnInput() {
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: scratch,
    prompt,
    hook_event_name: 'UserPromptSubmit' as const
  };
}

describe('a session whose transcript has not been written yet', () => {
  it('admits the first turn instead of stopping it', async () => {
    const result = await buildHook()(turnInput(), context);

    expect(admission).toHaveBeenCalledTimes(1);
    const stdout = result!.stdout as { continue?: boolean; stopReason?: string };
    expect(stdout.continue).not.toBe(false);
    expect(stdout.stopReason).toBeUndefined();
  });

  it('reads the absent transcript as position zero in the boundary identity', async () => {
    await buildHook()(turnInput(), context);

    const boundary = `claude:turn:${sessionId}:0:${promptDigest}`;
    expect(admission).toHaveBeenCalledWith({ cause: 'turn', messageId: boundary, requestId: boundary });
  });

  it('mints the same boundary identity when the same turn is retried', async () => {
    const hook = buildHook();
    await hook(turnInput(), context);
    await hook(turnInput(), context);

    const [first, second] = admission.mock.calls;
    expect(first).toBeDefined();
    expect(second![0]).toEqual(first![0]);
  });

  it('mints a distinct boundary identity once the transcript has grown', async () => {
    const hook = buildHook();
    await hook(turnInput(), context);
    writeFileSync(transcriptPath, 'a prior turn\n');
    await hook(turnInput(), context);

    const [first, second] = admission.mock.calls;
    expect(first).toBeDefined();
    expect(second![0].requestId).not.toBe(first![0].requestId);
  });
});

/**
 * Interactive Claude sessions finish through stream lifecycle metadata without a native result.
 * @summary Claude stream completion and accessible announcement regression checks
 */
import { describe, expect, it } from 'vitest';
import { claudeSessionProjector } from '../src/streams/claude-code-session/www/lib/project-session';
import { createCompletionAnnouncer } from '../src/streams/lib/session/announcements';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { assistant, line, source, user } from './fixtures/claude-projection';
import { streamMeta } from './helpers/stream-meta';

const interactive = [line(user('hello', 'prompt')), line(assistant('Hello', 'reply'))];

describe('Claude interactive stream completion', () => {
  it('finishes a transcript without result on metadata-only closure and announces once', () => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    const announce = createCompletionAnnouncer('Claude Code');
    const live = controller.update(
      source(interactive, { meta: streamMeta({ isActive: true, lineCount: 2 }) })
    ).projection;
    announce(live.rows, live.header?.status);
    const ended = controller.update(source(interactive, { meta: streamMeta({ isActive: false, lineCount: 2 }) }));
    expect(ended.kind).toBe('metadata');
    expect(ended.projection.header?.status).toBe('done');
    expect(announce(ended.projection.rows, ended.projection.header?.status)).toBe('Session ended');
    expect(announce(ended.projection.rows, ended.projection.header?.status)).toBeUndefined();
    controller.dispose();
  });

  it('keeps live and unavailable lifecycle metadata running, including after resume', () => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    for (const meta of [null, streamMeta({ isActive: true, lineCount: 2 })]) {
      expect(controller.update(source(interactive, { meta })).projection.header?.status).toBe('running');
    }
    expect(
      controller.update(source(interactive, { meta: streamMeta({ isActive: false, lineCount: 2 }) })).projection.header
        ?.status
    ).toBe('done');
    expect(
      controller.update(source(interactive, { meta: streamMeta({ isActive: true, lineCount: 2 }) })).projection.header
        ?.status
    ).toBe('running');
    controller.dispose();
  });

  it.each([
    ['success', 'done'],
    ['error_during_execution', 'error']
  ] as const)('preserves native %s result status regardless of stream liveness', (subtype, expected) => {
    const lines = [...interactive, line({ type: 'result', subtype })];
    for (const isActive of [true, false]) {
      const projected = replayTranscript(
        claudeSessionProjector,
        source(lines, { meta: streamMeta({ isActive, lineCount: 3 }) })
      );
      expect(projected.header?.status).toBe(expected);
    }
  });
});

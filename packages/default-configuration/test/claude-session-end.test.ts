/**
 * Interactive Claude sessions finish through stream lifecycle metadata without a native result.
 * @summary Claude stream completion and accessible announcement regression checks
 */
import { describe, expect, it } from 'vitest';
import { claudeSessionProjector } from '../src/streams/claude-code-session/www/lib/project-session';
import { createCompletionAnnouncer } from '../src/streams/lib/session/announcements';
import { createTranscriptProjection } from '../src/streams/lib/session/projection';
import { assistant, line, source, user } from './fixtures/claude-projection';

const interactive = [line(user('hello', 'prompt')), line(assistant('Hello', 'reply'))];

describe('Claude interactive stream completion', () => {
  it('finishes a transcript without result on metadata-only closure and announces once', () => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    const announce = createCompletionAnnouncer('Claude Code');
    const live = controller.update(source(interactive, { meta: { isActive: true, lineCount: 2 } })).projection;
    announce(live.rows, live.header?.status);
    const ended = controller.update(source(interactive, { meta: { isActive: false, lineCount: 2 } }));
    expect(ended.kind).toBe('metadata');
    expect(ended.projection.header?.status).toBe('done');
    expect(announce(ended.projection.rows, ended.projection.header?.status)).toBe('Session ended');
    expect(announce(ended.projection.rows, ended.projection.header?.status)).toBeUndefined();
    controller.dispose();
  });
});

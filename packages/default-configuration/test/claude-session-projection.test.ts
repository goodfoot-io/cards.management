/**
 * Native Claude reconciliation, provenance and semantic association conformance.
 * @summary Claude replay, boundaries, resets, identity and tool projection checks
 */
import { describe, expect, it } from 'vitest';
import { claudeSessionProjector } from '../src/streams/claude-code-session/www/lib/project-session';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { assistant, call, hook, line, parts, project, result, source, tools, user } from './fixtures/claude-projection';

const mixed = [
  { type: 'system', subtype: 'init', uuid: 'init', model: 'Claude', cwd: '/repo', tools: ['Bash'] },
  { type: 'mode', mode: 'normal' },
  user('hello', 'user'),
  call(),
  hook(),
  { type: 'user', isMeta: true, sourceToolUseID: 'call', message: { content: 'supplemental' } },
  result(),
  assistant('**complete**', 'answer'),
  { type: 'result', subtype: 'success' }
].map(line);

describe('Claude native projection conformance', () => {
  it.each([1, 2, 3, 7])('matches full replay with batches of %s and repeated snapshots', (size) => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    for (let end = 0; end <= mixed.length + size; end += size) {
      const current = source(mixed.slice(0, Math.min(end, mixed.length)));
      const incremental = controller.update(current).projection;
      expect(incremental).toEqual(replayTranscript(claudeSessionProjector, current));
      expect(controller.update(current).kind).toBe('unchanged');
    }
    controller.dispose();
  });
  it('handles overlap, prepend, truncation, equal-length replacement and explicit generation reset', () => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    const snapshots = [
      source(mixed.slice(4), { headLineNumber: 5 }),
      source(mixed.slice(2), { headLineNumber: 3 }),
      source(mixed),
      source(mixed.slice(0, 3)),
      source([line(user('replacement'))]),
      source([line(user('reset'))], { generation: 'two' })
    ];
    for (const snapshot of snapshots)
      expect(controller.update(snapshot).projection).toEqual(replayTranscript(claudeSessionProjector, snapshot));
    expect(parts(controller.update(snapshots.at(-1)!).projection.rows).every((part) => part.id.includes('two'))).toBe(
      true
    );
    expect(() => controller.update(source([], { sourceKey: 'other' }))).toThrow('source key');
    controller.dispose();
    expect(() => controller.update(source([]))).toThrow('disposed');
  });
  it('collapses verified UUID replay across batches while retaining every physical occurrence', () => {
    const message = line(user('same', 'uuid'));
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    controller.update(source([message]));
    const projected = controller.update(source([message, message])).projection;
    const frozen = JSON.stringify(projected);
    controller.update(source([message, message, message]));
    expect(JSON.stringify(projected)).toBe(frozen);
    const text = parts(projected.rows).filter((part) => part.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0]!.provenance.map((p) => p.lineNumber)).toEqual([1, 2]);
    expect(projected).toEqual(replayTranscript(claudeSessionProjector, source([message, message])));
  });
  it('keeps conflicting UUID reuse, distinct prompt UUIDs and ID-less identical records inspectable', () => {
    const projected = project([
      user('same', 'one'),
      user('same', 'two'),
      user('same'),
      user('same'),
      user('changed', 'one')
    ]);
    expect(parts(projected.rows).filter((part) => part.kind === 'text')).toHaveLength(5);
    expect(parts(projected.rows).some((part) => part.kind === 'raw' && part.reason === 'conflicting-id')).toBe(true);
    expect(new Set(parts(projected.rows).map((part) => part.id)).size).toBe(parts(projected.rows).length);
  });
  it('keeps source-scoped identities separate and retains absolute native block selectors', () => {
    const a = replayTranscript(claudeSessionProjector, source([line(user('text', 'uuid'))], { headLineNumber: 40 }));
    const b = replayTranscript(claudeSessionProjector, source([line(user('text', 'uuid'))], { sourceKey: 'another' }));
    const text = parts(a.rows).find((part) => part.kind === 'text')!;
    expect(text.provenance[0]).toMatchObject({
      sourceKey: 'card/claude/main',
      lineNumber: 40,
      nativeEventId: 'uuid',
      selector: 'message/content/0'
    });
    expect(parts(b.rows)[0]!.id).not.toBe(text.id);
  });
  it('patches late output onto one stable tool and preserves untouched historical row references', () => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    const initial = [line(user('question', 'u')), line(call())];
    const before = controller.update(source(initial)).projection;
    const after = controller.update(source([...initial, line(result())])).projection;
    expect(tools(after.rows)).toHaveLength(1);
    expect(tools(after.rows)[0]!.id).toBe(tools(before.rows)[0]!.id);
    expect(tools(after.rows)[0]!.data).toMatchObject({ output: 'done', status: 'complete' });
    expect(after.rows[0]).toBe(before.rows[0]);
  });
  it('reconciles an orphan result with a later or prepended call without duplicate output', () => {
    for (const values of [
      [result(), call()],
      [call(), result()]
    ]) {
      const projected = project(values);
      expect(tools(projected.rows)).toHaveLength(1);
      expect(tools(projected.rows)[0]!.data).toMatchObject({ name: 'Bash', output: 'done', status: 'complete' });
    }
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    const orphan = controller.update(source([line(result())], { headLineNumber: 2 })).projection;
    const backfill = controller.update(source([line(call()), line(result())])).projection;
    expect(tools(orphan.rows)[0]!.id).toBe(tools(backfill.rows)[0]!.id);
  });
  it('keeps real results richer than summaries, preserves error status and exposes repeated call IDs', () => {
    const projected = project([
      call(),
      { type: 'tool_use_summary', preceding_tool_use_ids: ['call'], summary: 'summary' },
      result('call', 'full error', true),
      call()
    ]);
    expect(tools(projected.rows)).toHaveLength(1);
    expect(tools(projected.rows)[0]!.data).toMatchObject({ output: 'full error', status: 'error' });
    expect(
      tools(projected.rows)[0]!.data.details.some((part) => part.kind === 'raw' && part.text.includes('summary'))
    ).toBe(true);
    expect(parts(projected.rows).some((part) => part.kind === 'raw' && part.reason === 'conflicting-id')).toBe(true);
  });
  it('keeps malformed JSON, malformed shapes and unsupported native blocks visible', () => {
    const projected = replayTranscript(
      claudeSessionProjector,
      source([
        '',
        '{bad',
        'null',
        line({ type: 'assistant', message: { content: 3 } }),
        line({ type: 'assistant', message: { content: [{ type: 'future', payload: 'retained' }] } })
      ])
    );
    expect(parts(projected.rows).filter((part) => part.kind === 'raw' && part.reason === 'malformed')).toHaveLength(3);
    expect(parts(projected.rows).some((part) => part.kind === 'raw' && part.text.includes('retained'))).toBe(true);
  });
  it('associates interleaved results by native ID through replay and every append boundary', () => {
    const values = [
      call('T9', 'Skill'),
      user('full skill instructions'),
      call('T10', 'Bash'),
      user('Summarized earlier work'),
      result('T10', 'native command output'),
      result('T9', 'skill ran')
    ].map(line);
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    for (let end = 1; end <= values.length; end++) {
      const snapshot = source(values.slice(0, end));
      expect(controller.update(snapshot).projection).toEqual(replayTranscript(claudeSessionProjector, snapshot));
    }
    const projected = controller.update(source(values)).projection;
    expect(tools(projected.rows).map((part) => [part.semanticKey, part.data.output])).toEqual([
      ['tool/T9', 'skill ran'],
      ['tool/T10', 'native command output']
    ]);
    expect(parts(projected.rows).flatMap((part) => (part.kind === 'text' ? [part.text] : []))).toEqual([
      'full skill instructions',
      'Summarized earlier work'
    ]);
    controller.dispose();
  });
  it('consumes native tool-result blocks even when their user record also contains supplemental text', () => {
    const values = [
      call('T9', 'Skill'),
      {
        type: 'user',
        isMeta: true,
        sourceToolUseID: 'T9',
        message: {
          content: [
            { type: 'text', text: 'full skill instructions' },
            { type: 'tool_result', tool_use_id: 'T9', content: 'skill ran' }
          ]
        }
      }
    ];
    expect(tools(project(values).rows)[0]!.data).toMatchObject({
      output: 'skill ran',
      supplemental: 'full skill instructions',
      status: 'complete'
    });
  });
  it('refreshes metadata-only sidecar facts without changing native content', () => {
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    const before = controller.update(source(mixed)).projection;
    const after = controller.update(
      source(mixed, { meta: { role: 'subagent', agentId: 'worker', lineCount: mixed.length, isActive: false } })
    );
    expect(after.kind).toBe('metadata');
    expect(after.projection.header.agentId).toBe('worker');
    expect(after.projection.rows).toEqual(before.rows);
  });
});

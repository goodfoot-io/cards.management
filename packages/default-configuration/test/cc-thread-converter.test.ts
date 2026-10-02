/**
 * Claude behavior preservation expressed as native semantic rows and rendered details.
 * Replaces vendor-role adaptation assertions while retaining provider-specific coverage.
 * @summary Claude hooks, supplements, grouping, statuses and safe rendered content
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PARTS,
  claudeDisclosureIds
} from '../src/streams/claude-code-session/www/components/expanded/ClaudePresentation';
import type { ClaudePayloads } from '../src/streams/claude-code-session/www/lib/project-session';
import { SessionContent } from '../src/streams/lib/session/SessionContent';
import { assistant, call, hook, parts, project, result, rowsDeep, tools, user } from './fixtures/claude-projection';

const attachment = (value: unknown) => ({ type: 'attachment', attachment: value });
const group = (values: unknown[]) =>
  project(values).rows.filter((row) => row.kind === 'provider' && row.providerKind === 'group');
const labels = (values: unknown[]) =>
  rowsDeep(project([assistant('start'), ...values]).rows)
    .filter((row) => row.kind === 'structural')
    .map((row) => row.label);
const render = (values: unknown[], open = true): string => {
  const projection = project(values);
  return renderToStaticMarkup(
    createElement(SessionContent<ClaudePayloads>, {
      rows: projection.rows,
      providerParts: CLAUDE_PARTS,
      providerRows: CLAUDE_PARTS,
      disclosures: {
        open: new Map([...claudeDisclosureIds(projection.rows)].map((id) => [id, open])),
        onOpenChange: () => undefined
      }
    })
  );
};

describe('Claude semantic preservation', () => {
  it.each([
    [call(), hook(), result()],
    [hook(), result(), call()],
    [result(), hook(), call()]
  ])('nests hooks once regardless of call/result delivery order', (...events) => {
    const projected = project(events);
    expect(tools(projected.rows)).toHaveLength(1);
    expect(tools(projected.rows)[0]!.data.hooks).toHaveLength(1);
    expect(
      parts(projected.rows).filter((part) => part.kind === 'provider' && part.providerKind === 'attachment')
    ).toHaveLength(0);
    expect(render(events)).toContain('hook body');
  });
  it.each([
    'hook_success',
    'hook_blocking_error',
    'hook_non_blocking_error',
    'hook_cancelled'
  ])('preserves orphan %s details', (type) => {
    const projected = project([hook('missing', type)]);
    expect(parts(projected.rows).some((part) => part.kind === 'provider' && part.providerKind === 'attachment')).toBe(
      true
    );
    expect(render([hook('missing', type)])).toContain('Check');
  });
  it('escalates a tool for a blocking hook and retains its reason and command', () => {
    const values = [call(), hook('call', 'hook_blocking_error'), result()];
    expect(tools(project(values).rows)[0]!.data.status).toBe('error');
    const html = render(values);
    expect(html).toContain('blocked by Check');
    expect(html).toContain('blocked');
    expect(html).toContain('check');
  });
  it('nests supplemental instructions only once a real result exists and preserves the native result too', () => {
    const supplemental = {
      type: 'user',
      isMeta: true,
      sourceToolUseID: 'call',
      message: { content: 'full instructions' }
    };
    expect(
      parts(project([call(), supplemental]).rows).some(
        (part) => part.kind === 'provider' && part.providerKind === 'prose'
      )
    ).toBe(true);
    const projected = project([call(), supplemental, result()]);
    expect(tools(projected.rows)[0]!.data).toMatchObject({ supplemental: 'full instructions', output: 'done' });
    expect(parts(projected.rows).some((part) => part.kind === 'provider' && part.providerKind === 'prose')).toBe(false);
    expect(render([supplemental])).toContain('full instructions');
  });
  it.each([
    ['T9', 'Skill', 'full skill instructions', 'skill ran'],
    ['T10', 'Bash', 'Summarized earlier work', 'native command output']
  ])('renders the native result for %s separately from user and supplemental content', (id, name, surrounding, output) => {
    const values = [
      call(id, name),
      user(surrounding),
      { type: 'user', isMeta: true, sourceToolUseID: id, message: { content: surrounding } },
      result(id, output)
    ];
    const projected = project(values);
    expect(tools(projected.rows)[0]!.data).toMatchObject({ output, supplemental: surrounding });
    expect(parts(projected.rows).some((part) => part.kind === 'text' && part.text === surrounding)).toBe(true);
    const html = render(values);
    expect(html).toContain(`<div class="session-label">Result</div><pre class="session-raw">${output}</pre>`);
    expect(html).toContain(
      `<div class="session-label">Supplemental content</div><pre class="session-raw">${surrounding}</pre>`
    );
    expect(html).not.toContain(`<div class="session-label">Result</div><pre class="session-raw">${surrounding}</pre>`);
  });
  it('retains an unqualified supplemental message as its own disclosure', () => {
    expect(render([{ type: 'user', isMeta: true, message: { content: 'orphan' } }])).toContain('Supplemental content');
  });
  it('pairs repeated tool names by call identity across separate turns', () => {
    const projected = project([
      call('one'),
      result('one', 'first'),
      user('again'),
      call('two'),
      result('two', 'second')
    ]);
    expect(tools(projected.rows).map((part) => part.data.output)).toEqual(['first', 'second']);
  });
  it('groups ambient turn context but keeps date changes outside that group', () => {
    const rows = project([
      assistant('start'),
      attachment({ type: 'team_context', agentName: 'one', teamName: 'team' }),
      attachment({ type: 'team_context', agentName: 'two', teamName: 'team' }),
      attachment({ type: 'date_change', newDate: '2026-06-03' })
    ]).rows;
    expect(rows.filter((row) => row.kind === 'provider' && row.providerKind === 'group')).toHaveLength(1);
    const dates = rows.at(-1)!.parts;
    expect(dates[0]).toMatchObject({ providerKind: 'attachment', data: { attachment: { type: 'date_change' } } });
  });
  it('groups the preamble above the first user while continuing to gather until assistant content', () => {
    const rows = project([
      { type: 'mode', mode: 'normal' },
      hook('SessionStart'),
      user('question'),
      attachment({ type: 'skill_listing', content: 'skill body', skillCount: 2 }),
      { type: 'ai-title', aiTitle: 'Fix it' },
      assistant('answer')
    ]).rows;
    expect(rows[0]).toMatchObject({ kind: 'provider', providerKind: 'group' });
    if (rows[0]?.kind === 'provider' && rows[0].providerKind === 'group')
      expect(rows[0].data.label).toBe('Session started · normal · "Fix it" · 2 skills · 1 hook');
    expect(rows[1]).toMatchObject({ kind: 'message', role: 'user' });
  });
  it('does not group boundaries and away summaries into the preamble', () => {
    const rows = project([
      { type: 'mode', mode: 'plan' },
      { type: 'system', subtype: 'init', tools: [] },
      { type: 'system', subtype: 'away_summary', content: 'away' },
      assistant('answer')
    ]).rows;
    expect(rowsDeep(rows).filter((row) => row.kind === 'structural' && row.tone === 'boundary')).toHaveLength(2);
    expect(group([assistant('first')])).toHaveLength(0);
    expect(group([{ type: 'mode', mode: 'plan' }])).toHaveLength(1);
  });
  it('deduplicates coordination changes independently and keeps ordinary repeated prompts', () => {
    expect(
      labels([
        { type: 'mode', mode: 'one' },
        { type: 'mode', mode: 'one' },
        { type: 'ai-title', aiTitle: 'title' },
        { type: 'mode', mode: 'two' }
      ])
    ).toEqual(['Mode: one', 'Title: "title"', 'Mode: two']);
    expect(
      parts(project([user('same', '1'), user('same', '2')]).rows).filter((part) => part.kind === 'text')
    ).toHaveLength(2);
  });
  it('keeps coordination-only user records outside the gathered service preamble', () => {
    const rows = project([user('{"from":"user","type":"task_id"}'), { type: 'mode', mode: 'normal' }]).rows;
    expect(rows).toHaveLength(2);
  });
  it('separates coordination status from genuine prose in the same assistant event', () => {
    const rows = rowsDeep(
      project([
        user('Review'),
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '{"from":"reviewer","type":"approval"}' },
              { type: 'text', text: 'Looks good to merge.' }
            ]
          }
        }
      ]).rows
    );
    expect(rows.some((row) => row.kind === 'structural' && row.label === 'reviewer: approval')).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.kind === 'message' &&
          row.parts.some((part) => part.kind === 'text' && part.text === 'Looks good to merge.')
      )
    ).toBe(true);
  });
  it('suppresses an idle-only assistant event and labels user coordination', () => {
    expect(project([assistant('{"type":"idle_notification"}')]).rows).toHaveLength(0);
    expect(
      rowsDeep(project([user('{"from":"user","type":"task_id"}')]).rows).some(
        (row) => row.kind === 'structural' && row.label === 'user: task id'
      )
    ).toBe(true);
  });
  it.each([
    [{ type: 'system', subtype: 'init', model: 'Claude', cwd: '/repo', tools: ['Bash'] }, 'Session started · 1 tool'],
    [
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1234 } },
      'Context compacted (manual) · 1,234 tokens'
    ],
    [{ type: 'system', subtype: 'status', status: 'compacting' }, 'Compacting context…'],
    [{ type: 'system', subtype: 'turn_duration', durationMs: 1234, messageCount: 1 }, 'Turn · 1.2s · 1 message'],
    [{ type: 'system', subtype: 'turn_duration', durationMs: 2000, messageCount: 2 }, 'Turn · 2.0s · 2 messages'],
    [
      { type: 'system', subtype: 'files_persisted', files: ['one'], failed: ['two'] },
      'Files persisted: 1 saved, 1 failed'
    ],
    [
      { type: 'system', subtype: 'task_notification', task_id: 't', status: 'done', summary: 'finished' },
      'Task t: done — finished'
    ],
    [{ type: 'queue-operation', operation: 'enqueue', content: '<task>Build</task>' }, 'Queued: Build'],
    [{ type: 'queue-operation', operation: 'enqueue', content: '   ' }, 'Queued'],
    [{ type: 'queue-operation', operation: 'remove' }, 'Queue: remove'],
    [{ type: 'queue-operation', operation: 'dequeue' }, 'Queue: dequeue'],
    [{ type: 'worktree-state', worktreeSession: { worktreeName: 'work' } }, 'Worktree: work'],
    [{ type: 'bridge-session', bridgeSessionId: 'id' }, 'Bridge session id'],
    [{ type: 'auth_status', isAuthenticating: true }, 'Authenticating…'],
    [{ type: 'auth_status', error: 'expired' }, 'Auth error: expired']
  ])('preserves structural meaning for %j', (event, expected) => {
    expect(labels([event])).toContain(expected);
  });
  it('keeps queue previews short while making the complete prompt inspectable', () => {
    const content = 'x'.repeat(500);
    expect(labels([{ type: 'queue-operation', operation: 'enqueue', content }])[0]!.length).toBeLessThan(80);
    expect(
      parts(project([{ type: 'queue-operation', operation: 'enqueue', content }]).rows).some(
        (part) => part.kind === 'raw' && part.text.includes(content)
      )
    ).toBe(true);
  });
  it('preserves progress tool summaries and suppresses known non-agent progress', () => {
    expect(
      labels([
        {
          type: 'progress',
          data: { type: 'agent_progress', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] }
        }
      ])[0]
    ).toContain('↳ Bash');
    expect(project([{ type: 'progress', data: { type: 'other_progress' } }]).rows).toHaveLength(0);
  });
  it.each(['hook_started', 'hook_progress', 'hook_response'])('suppresses internal system %s', (subtype) => {
    expect(project([{ type: 'system', subtype }]).rows).toHaveLength(0);
  });
  it('preserves header facts and distinguishes running, completed and error transcripts', () => {
    expect(project([{ type: 'system', subtype: 'init', model: 'Claude', cwd: '/repo' }]).header).toMatchObject({
      model: 'Claude',
      cwd: '/repo',
      status: 'running'
    });
    expect(
      project([{ type: 'result', subtype: 'success', num_turns: 2, duration_ms: 1000, total_cost_usd: 0.2 }]).header
        .status
    ).toBe('done');
    expect(
      labels([{ type: 'result', subtype: 'success', num_turns: 2, duration_ms: 1000, total_cost_usd: 0.2 }])
    ).toContain('Session complete · 2 turns · 1s · $0.2000');
    expect(project([{ type: 'result', subtype: 'error_max_turns' }]).header.status).toBe('error');
  });
  it('keeps source timestamps in native details without using them for identity or order', () => {
    const projected = project([
      { ...user('later'), timestamp: '2026-01-02' },
      { ...assistant('earlier'), timestamp: '2026-01-01' }
    ]);
    expect(parts(projected.rows).flatMap((part) => (part.kind === 'text' ? [part.text] : []))).toEqual([
      'later',
      'earlier'
    ]);
    expect(parts(projected.rows).some((part) => part.kind === 'raw' && part.text.includes('2026-01-02'))).toBe(true);
  });
  it.each([
    { type: 'system', subtype: 'future' },
    { type: 'future-record', payload: 1 },
    { type: 'queue-operation', operation: 'future' }
  ])('retains unsupported record %j', (event) => {
    expect(parts(project([event]).rows).some((part) => part.kind === 'raw' && part.reason === 'unknown')).toBe(true);
  });
  it.each([
    { type: 'skill_listing', names: 'oops' },
    { type: 'invoked_skills', skills: 'oops' },
    { type: 'command_permissions', allowedTools: 'oops' },
    { type: 'skill_listing', names: [null] },
    { type: 'invoked_skills', skills: [null] },
    { type: 'invoked_skills', skills: [{ name: { bad: true } }] },
    { type: 'command_permissions', allowedTools: [null] },
    { type: 'command_permissions' },
    { type: 'deferred_tools_delta', addedNames: 'oops' },
    { type: 'mcp_instructions_delta', addedBlocks: 'oops' },
    { type: 'agent_listing_delta', addedTypes: 'oops' },
    { type: 'dynamic_skill', skillNames: 'oops' },
    { type: 'task_reminder', content: 'oops' }
  ])('keeps malformed known attachment %j inspectable without invoking its typed presenter', (payload) => {
    const values = [assistant('start'), attachment(payload)];
    expect(() => render(values)).not.toThrow();
    const leaves = parts(project(values).rows);
    expect(leaves.some((part) => part.kind === 'provider' && part.providerKind === 'attachment')).toBe(false);
    expect(
      leaves.some((part) => part.kind === 'raw' && part.reason === 'malformed' && part.text.includes(payload.type))
    ).toBe(true);
    expect(render(values)).toContain('Malformed attachment');
  });
  it('bounds malformed known attachment details without losing the native record', () => {
    const payload = { type: 'skill_listing', names: 'x'.repeat(5 * 1024 * 1024) };
    const values = [assistant('start'), attachment(payload)];
    const html = render(values);
    expect(html).toContain('Characters 1–4096');
    expect(html.length).toBeLessThan(70000);
    expect(parts(project(values).rows).some((part) => part.kind === 'raw' && part.text.includes(payload.names))).toBe(
      true
    );
  });
  it('renders Markdown and reasoning safely while preserving native details', () => {
    const html = render([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'because' },
            { type: 'text', text: '**strong** <script>bad()</script> [unsafe](javascript:bad)' }
          ]
        }
      }
    ]);
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('because');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('Raw details');
  });
  it('bounds oversized result/raw rendering and honors collapsed controlled details', () => {
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const values = [call(), result('call', huge), { type: 'future', payload: huge }];
    const closed = render(values, false);
    const open = render(values);
    expect(closed).not.toContain('xxxx');
    expect(open).toContain('of 5242880');
    expect(open.length).toBeLessThan(100000);
  });
});

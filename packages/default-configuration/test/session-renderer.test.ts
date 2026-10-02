/**
 * Render-only session preservation, trust-boundary and composition checks.
 * @summary Cards session content contract
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionContent, type SessionContentProps } from '../src/streams/lib/session/SessionContent';
import type { SessionRow } from '../src/streams/lib/session/types';

const row: SessionRow = {
  id: 'row',
  kind: 'message',
  role: 'user',
  anchor: 'turn',
  provenance: [{ sourceKey: 'parent', generation: 'one', lineNumber: 1, selector: 'record' }],
  parts: [
    {
      id: 'text',
      kind: 'text',
      text: 'Hello **reader** <script>evil()</script> [bad](javascript:evil)',
      provenance: []
    }
  ]
};
function render(props: Partial<SessionContentProps> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionContent<Record<string, unknown>>, {
      rows: [row],
      disclosures: { open: new Map(), onOpenChange: () => undefined },
      ...props
    })
  );
}

describe('session content', () => {
  it('renders Markdown with inert HTML and unsafe links', () => {
    const html = render();
    expect(html).toContain('<strong>reader</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('data-session-id="text"');
  });

  it('honors controlled disclosure state and bounds oversized raw inspection', () => {
    const raw: SessionRow = {
      ...row,
      parts: [
        {
          id: 'raw',
          kind: 'raw',
          label: 'Unknown record',
          reason: 'unknown',
          text: 'x'.repeat(5 * 1024 * 1024),
          provenance: []
        }
      ]
    };
    const closed = render({ rows: [raw] });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('xxxx');
    const open = render({
      rows: [raw],
      disclosures: { open: new Map([['raw', true]]), onOpenChange: () => undefined }
    });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('of 5242880');
    expect(open).toContain('Next');
    expect(open.length).toBeLessThan(70000);
  });

  it('inserts only witnessed anchors or explicit sections without discovering a child', () => {
    const html = render({
      insertions: [
        {
          placementId: 'witness',
          childSourceKey: 'child',
          label: 'Child',
          placement: { kind: 'witnessed', parentSourceKey: 'parent', rowId: 'row', partId: 'text', position: 'after' }
        },
        {
          placementId: 'missing',
          childSourceKey: 'other',
          label: 'Other',
          placement: { kind: 'witnessed', parentSourceKey: 'parent', rowId: 'missing', position: 'after' }
        },
        {
          placementId: 'section',
          childSourceKey: 'section-child',
          label: 'Section',
          placement: { kind: 'section', position: 'end' }
        }
      ],
      renderInsertion: (insertion) => `content-${insertion.placementId}`,
      disclosures: {
        open: new Map([
          ['witness', true],
          ['missing', true],
          ['section', true]
        ]),
        onOpenChange: () => undefined
      }
    });
    expect(html).toContain('content-witness');
    expect(html).toContain('content-section');
    expect(html).not.toContain('content-missing');
    expect(html.indexOf('Hello')).toBeLessThan(html.indexOf('content-witness'));
    expect(html).not.toContain('role="log"');
  });

  it('dispatches typed provider rows and parts through ordinary React renderers', () => {
    const html = render({
      rows: [{ ...row, kind: 'provider', providerKind: 'hook', data: { label: 'Hook row' }, parts: [] }],
      providerRows: { hook: ({ data }) => String((data as { label: string }).label) }
    });
    expect(html).toContain('Hook row');
  });
  it('preserves shared parts alongside a provider-specific row presentation', () => {
    const html = render({
      rows: [{ ...row, kind: 'provider', providerKind: 'hook', data: 'Hook' }],
      providerRows: { hook: () => 'Provider heading' }
    });
    expect(html).toContain('Provider heading');
    expect(html).toContain('<strong>reader</strong>');
  });

  it('keeps coordinate groups stable when earlier native history arrives', () => {
    const later: SessionRow = {
      ...row,
      id: 'later',
      provenance: [{ sourceKey: 'parent', generation: 'one', lineNumber: 150, selector: 'record' }]
    };
    const alone = render({ rows: [later] });
    const prepended = render({ rows: [row, later] });
    const batch = alone.match(/class="session-batch"[^>]*data-session-id="([^"]+)"/);
    expect(batch).not.toBeNull();
    expect(prepended).toContain(batch![0]);
    expect(prepended).toContain('data-session-id="later"');
  });
  it('bounds a five-megabyte completed tool result while retaining its input and status', () => {
    const tool: SessionRow = {
      ...row,
      parts: [
        {
          id: 'tool',
          kind: 'tool',
          callId: 'call',
          name: 'Read file',
          input: 'file.txt',
          output: 'y'.repeat(5 * 1024 * 1024),
          status: 'complete',
          provenance: []
        }
      ]
    };
    const html = render({
      rows: [tool],
      disclosures: { open: new Map([['tool', true]]), onOpenChange: () => undefined }
    });
    expect(html).toContain('Read file · complete');
    expect(html).toContain('file.txt');
    expect(html).toContain('of 5242880');
    expect(html.length).toBeLessThan(70000);
  });
  it('keeps a Unicode character intact across bounded inspection page edges', () => {
    const unicode: SessionRow = {
      ...row,
      parts: [
        {
          id: 'unicode',
          kind: 'raw',
          label: 'Unicode detail',
          reason: 'detail',
          text: `${'x'.repeat(4095)}😀rest`,
          provenance: []
        }
      ]
    };
    const html = render({
      rows: [unicode],
      disclosures: { open: new Map([['unicode', true]]), onOpenChange: () => undefined }
    });
    expect(html).toContain('😀');
    expect(html).not.toContain('rest');
  });
});

// These integration witnesses use the actual React/MessageScroller browser bundle,
// not DOM or framework mocks. Bun and the browser skill's agent-browser CLI are required.
// Each 250 ms settle allows the primitive's 180 ms programmatic-scroll guard and resize frames to finish.
describe('mounted session interaction', () => {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const session = `session-review-${process.pid}`;
  let directory: string;
  let server: Server;
  let origin: string;

  async function browser(...args: string[]): Promise<string> {
    const result = await promisify(execFile)('agent-browser', ['--session', session, ...args]);
    return result.stdout;
  }

  async function evaluate<T>(script: string): Promise<T> {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn('agent-browser', ['--session', session, 'eval', '--stdin']);
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolveOutput(output);
        else reject(new Error(errors || output));
      });
      child.stdin.end(script);
    });
    return JSON.parse(output) as T;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cards-session-review-'));
    await symlink(resolve(packageDirectory, '../../..', 'node_modules'), join(directory, 'node_modules'), 'junction');
    const viewportPath = JSON.stringify(join(packageDirectory, 'src/streams/lib/session/SessionViewport.tsx'));
    const contentPath = JSON.stringify(join(packageDirectory, 'src/streams/lib/session/SessionContent.tsx'));
    const claudePath = JSON.stringify(
      join(packageDirectory, 'src/streams/claude-code-session/www/components/expanded/ExpandedView.tsx')
    );
    const providerViews = [
      'codex-session/www/components/expanded/CodexExpandedView.tsx',
      'opencode-session/www/components/expanded/OpencodeExpandedView.tsx',
      'antigravity-session/www/components/expanded/AntigravityExpandedView.tsx'
    ].map((path) => JSON.stringify(join(packageDirectory, 'src/streams', path)));
    await writeFile(
      join(directory, 'main.jsx'),
      `
      import React, { useState, useRef } from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionViewport } from ${viewportPath};
      import { SessionContent } from ${contentPath};
      import { ClaudeSourceView } from ${claudePath};
      import { CodexSourceView } from ${providerViews[0]};
      import { OpencodeSourceView } from ${providerViews[1]};
      import { AntigravitySourceView } from ${providerViews[2]};
      function ProviderApp() {
        const [sourceKey, setSourceKey] = useState('first');
        const [generation, setGeneration] = useState('one');
        const [lines, setLines] = useState([JSON.stringify({type:'future_record',value:'initial raw'})]);
        const [meta, setMeta] = useState(null);
        window.providerHarness = {
          switch: key => setSourceKey(key), reset: value => setGeneration(value),
          metadata: () => setMeta({lineCount:lines.length,isActive:false}),
          append: () => setLines(previous => [...previous, JSON.stringify({type:'future_record',value:'appended raw'})])
        };
        const View = location.search === '?codex' ? CodexSourceView : location.search === '?opencode' ? OpencodeSourceView : AntigravitySourceView;
        return <View source={{sourceKey,generation,filename:'fixture',lines,headLineNumber:1,meta,isLoading:false,error:null}} />;
      }
      function ClaudeApp() {
        const [lines, setLines] = useState(() => [
          {type:'assistant',uuid:'call-event',message:{content:[{type:'tool_use',id:'call',name:'Bash',input:{command:'pwd'}}]}},
          {type:'attachment',uuid:'hook-event',attachment:{type:'hook_success',hookName:'Check',toolUseID:'call',hookEvent:'PostToolUse',stdout:'a'.repeat(4096)+'b'.repeat(95904),stderr:'',content:'',exitCode:0}}
        ].map(value => JSON.stringify(value)));
        window.claudeHarness = {
          append: () => setLines(previous => [...previous, JSON.stringify({type:'user',uuid:'result-event',message:{content:[{type:'tool_result',tool_use_id:'call',content:'done'}]}})]),
          malformed: () => setLines([
            {type:'assistant', message:{content:'start'}},
            ...[{type:'skill_listing',names:'oops'}, {type:'invoked_skills',skills:'oops'}, {type:'command_permissions',allowedTools:'oops'}].map(attachment => ({type:'attachment',attachment}))
          ].map(value => JSON.stringify(value)))
        };
        return <ClaudeSourceView source={{sourceKey:'test/claude',generation:'one',filename:'fixture',lines,headLineNumber:1,meta:null,isLoading:false,error:null}} />;
      }
      const makeRow = n => ({ id: 'row-' + n, kind: 'message', role: 'user', anchor: 'turn',
        provenance: [{ sourceKey: 'main', generation: 'one', lineNumber: n, selector: 'record' }],
        parts: [{ id: 'text-' + n, kind: 'text', text: 'Message ' + n, provenance: [] },
          { id: 'raw-' + n, kind: 'raw', label: 'Details ' + n, reason: 'detail',
            text: 'a'.repeat(4096) + 'b'.repeat(4096) + 'c'.repeat(40960), provenance: [] }] });
      const childRows = [{ ...makeRow(1), id: 'child-row', provenance: [{ sourceKey: 'child', generation: 'one', lineNumber: 1, selector: 'record' }], parts: [{ id: 'child-text', kind: 'text', text: 'Child output', provenance: [] }] }];
      const insertions = [{ placementId: 'child-placement', childSourceKey: 'child', label: 'Child activity', placement: { kind: 'section', position: 'end' } }];
      function App() {
        const [rows, setRows] = useState(() => Array.from({ length: 50 }, (_, i) => makeRow(i + 1)));
        const [open, setOpen] = useState(new Map());
        const handle = useRef(null);
        const disclosures = { open, onOpenChange: (id, value) => setOpen(previous => new Map(previous).set(id, value)) };
        window.sessionHarness = {
          append: () => setRows(previous => [...previous, makeRow(previous.length + 1)]),
          regroup: () => setRows(previous => previous.map(row => row.parts[0].id === 'text-40' ? { ...row, id: row.id + '-regrouped' } : row)),
          toggle: id => setOpen(previous => new Map(previous).set(id, !previous.get(id))),
          follow: () => handle.current.followLatest(),
          navigate: id => handle.current.navigateTo(id),
          capture: () => handle.current.captureAnchor()
        };
        return <SessionViewport rows={rows} viewportRef={handle} disclosures={disclosures} insertions={insertions}
          renderInsertion={() => <SessionContent rows={childRows} disclosures={disclosures} />} />;
      }
      window.sessionErrors = [];
      addEventListener('error', event => window.sessionErrors.push(event.message));
      createRoot(document.getElementById('root')).render(location.search === '?claude' ? <ClaudeApp /> : location.search ? <ProviderApp /> : <App />);
    `
    );
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><link rel="icon" href="data:,"><link rel="stylesheet" href="main.css"><style>html,body,#root{height:100%;margin:0}:root{--vscode-font-size:13px;--stream-content-max-width:900px}</style></head><body><div id="root"></div><script>window.__STREAM_INIT__={primary:"fixture",files:{},availableFiles:[],mode:"expanded",themeKind:"dark",cssVariables:{}}</script><script type="module" src="main.js"></script></body></html>'
    );
    await promisify(execFile)(
      'yarn',
      [
        'exec',
        'bun',
        'build',
        join(directory, 'main.jsx'),
        '--outdir',
        directory,
        '--target',
        'browser',
        '--production'
      ],
      { cwd: packageDirectory }
    );
    server = createServer(async (request, response) => {
      const filename = request.url === '/main.js' ? 'main.js' : request.url === '/main.css' ? 'main.css' : 'index.html';
      response.setHeader(
        'Content-Type',
        filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html'
      );
      response.end(await readFile(join(directory, filename)));
    });
    await new Promise<void>((resolveListening) => server.listen(0, '127.0.0.1', resolveListening));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Browser test server did not bind a TCP port');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30000);

  beforeEach(async () => {
    await browser('open', origin);
    await browser('wait', '--text', 'Details 50');
  });

  afterAll(async () => {
    try {
      await browser('close');
    } finally {
      await new Promise<void>((resolveClosed) => (server ? server.close(() => resolveClosed()) : resolveClosed()));
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'codex',
    'opencode',
    'antigravity'
  ])('retains %s disclosures on append and metadata but clears source and generation state', async (provider) => {
    await browser('open', `${origin}/?${provider}`);
    const result = await evaluate<{
      appended: string;
      metadata: string;
      switchedBack: string;
      resetBack: string;
      errors: string[];
    }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      const button = () => document.querySelector('[data-session-disclosure] button');
      await frame(); button().click(); await frame();
      providerHarness.append(); await frame(); const appended = button().getAttribute('aria-expanded');
      providerHarness.metadata(); await frame(); const metadata = button().getAttribute('aria-expanded');
      providerHarness.switch('second'); await frame(); providerHarness.switch('first'); await frame();
      const switchedBack = button().getAttribute('aria-expanded');
      button().click(); await frame(); providerHarness.reset('two'); await frame(); providerHarness.reset('one'); await frame();
      return {appended, metadata, switchedBack, resetBack:button().getAttribute('aria-expanded'), errors:sessionErrors};
    })()`);
    expect(result).toEqual({
      appended: 'true',
      metadata: 'true',
      switchedBack: 'false',
      resetBack: 'false',
      errors: []
    });
  });

  it('keeps the parent scroller registered while child content opens, appends and closes', async () => {
    const result = await evaluate<{
      during: number;
      after: number;
      openAnchor: string;
      openGap: number;
      anchor: string;
      gap: number;
      errors: string[];
    }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      sessionHarness.toggle('child-placement'); await frame();
      const during = document.querySelectorAll('[data-message-scroller-spacer]').length;
      sessionHarness.navigate('text-10'); await frame(); const openAnchor = sessionHarness.capture()?.id;
      sessionHarness.follow(); await frame(); sessionHarness.append(); await frame();
      const openViewport = document.querySelector('.session-viewport');
      const openGap = openViewport.scrollHeight - openViewport.clientHeight - openViewport.scrollTop;
      sessionHarness.toggle('child-placement'); await frame();
      const after = document.querySelectorAll('[data-message-scroller-spacer]').length;
      sessionHarness.navigate('text-20'); await frame(); const anchor = sessionHarness.capture()?.id;
      sessionHarness.follow(); await frame(); sessionHarness.append(); await frame();
      const viewport = document.querySelector('.session-viewport');
      return { during, after, openAnchor, openGap, anchor, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop, errors: sessionErrors };
    })()`);
    expect(result).toEqual({
      during: 1,
      after: 1,
      openAnchor: 'text-10',
      openGap: 0,
      anchor: 'text-20',
      gap: 0,
      errors: []
    });
  });

  it('retains the raw page, exact focused pager and selected text when a parent row regroups', async () => {
    const result = await evaluate<{ page: string; focus: string; selection: string; errors: string[] }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      sessionHarness.toggle('raw-40'); sessionHarness.navigate('raw-40'); await frame();
      const raw = document.querySelector('[data-session-disclosure="raw-40"]');
      const next = [...raw.querySelectorAll('button')].find(button => button.textContent === 'Next');
      next.click(); await frame(); next.focus();
      const text = raw.querySelector('pre').firstChild;
      document.getSelection().setBaseAndExtent(text, 10, text, 18); await frame();
      sessionHarness.regroup(); await frame();
      const current = document.querySelector('[data-session-disclosure="raw-40"]');
      return { page: current.querySelector('.session-inspection-controls span').textContent, focus: document.activeElement.textContent, selection: document.getSelection().toString(), errors: sessionErrors };
    })()`);
    expect(result).toEqual({
      page: 'Characters 4097–8192 of 49152',
      focus: 'Next',
      selection: 'bbbbbbbb',
      errors: []
    });
  });

  it('retains hook inspection when a pending call receives its result and adopts the hook', async () => {
    await browser('open', `${origin}/?claude`);
    await browser('wait', '--text', 'Check');
    const result = await evaluate<{
      page: string;
      focus: string;
      selection: string;
      open: string;
      spacers: number;
      errors: string[];
    }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      const buttons = () => [...document.querySelectorAll('button')];
      buttons().find(button => button.textContent.includes('Bash')).click();
      buttons().find(button => button.textContent.includes('Check')).click(); await frame();
      const hook = buttons().find(button => button.textContent.includes('Check')).closest('[data-session-disclosure]');
      const id = hook.getAttribute('data-session-disclosure');
      const next = [...hook.querySelectorAll('button')].find(button => button.textContent === 'Next');
      next.click(); await frame(); next.focus();
      const text = hook.querySelector('pre').firstChild;
      document.getSelection().setBaseAndExtent(text, 10, text, 18); await frame();
      claudeHarness.append(); await frame();
      const current = [...document.querySelectorAll('[data-session-disclosure]')].find(element => element.getAttribute('data-session-disclosure') === id);
      return { page: current.querySelector('.session-inspection-controls span').textContent, focus: document.activeElement.textContent, selection: document.getSelection().toString(), open: current.querySelector('button').getAttribute('aria-expanded'), spacers: document.querySelectorAll('[data-message-scroller-spacer]').length, errors: sessionErrors };
    })()`);
    expect(result).toEqual({
      page: 'Characters 4097–8192 of 100000',
      focus: 'Next',
      selection: 'bbbbbbbb',
      open: 'true',
      spacers: 1,
      errors: []
    });
  });

  it('reveals an inspected hook adopted by a closed tool once and respects a later user collapse', async () => {
    await browser('open', `${origin}/?claude`);
    await browser('wait', '--text', 'Check');
    const result = await evaluate<{
      before: string;
      page: string | null;
      focus: string;
      selection: string;
      open: string | null;
      visible: boolean;
      toolOpen: string;
      afterCollapse: string;
      hiddenAfterCollapse: boolean;
      errors: string[];
    }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      const buttons = () => [...document.querySelectorAll('button')];
      const tool = () => buttons().find(button => button.textContent.includes('Bash'));
      const before = tool().getAttribute('aria-expanded');
      buttons().find(button => button.textContent.includes('Check')).click(); await frame();
      const hook = buttons().find(button => button.textContent.includes('Check')).closest('[data-session-disclosure]');
      const id = hook.getAttribute('data-session-disclosure');
      const current = () => [...document.querySelectorAll('[data-session-disclosure]')].find(element => element.getAttribute('data-session-disclosure') === id);
      const next = [...hook.querySelectorAll('button')].find(button => button.textContent === 'Next');
      next.click(); await frame(); next.focus();
      const text = hook.querySelector('pre').firstChild;
      document.getSelection().setBaseAndExtent(text, 10, text, 18); await frame();
      claudeHarness.append(); await frame();
      const adopted = current();
      const state = {before, page: adopted?.querySelector('.session-inspection-controls span')?.textContent ?? null,
        focus: document.activeElement.tagName === 'BODY' ? 'BODY' : document.activeElement.textContent,
        selection: document.getSelection().toString(), open: adopted?.querySelector('button').getAttribute('aria-expanded') ?? null,
        visible: !!adopted?.querySelector('pre')?.getClientRects().length, toolOpen: tool().getAttribute('aria-expanded')};
      if (state.toolOpen === 'true') tool().click(); await frame();
      claudeHarness.append(); await frame();
      return {...state, afterCollapse: tool().getAttribute('aria-expanded'), hiddenAfterCollapse: !current(), errors: sessionErrors};
    })()`);
    expect(result).toEqual({
      before: 'false',
      page: 'Characters 4097–8192 of 100000',
      focus: 'Next',
      selection: 'bbbbbbbb',
      open: 'true',
      visible: true,
      toolOpen: 'true',
      afterCollapse: 'false',
      hiddenAfterCollapse: true,
      errors: []
    });
  });

  it('opens malformed skill and permission records as raw details without crashing', async () => {
    await browser('open', `${origin}/?claude`);
    await browser('wait', '--text', 'Check');
    const result = await evaluate<{ labels: number; details: string[]; errors: string[] }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      claudeHarness.malformed(); await frame();
      const buttons = [...document.querySelectorAll('button')].filter(button => button.textContent === 'Malformed attachment');
      buttons.forEach(button => button.click()); await frame();
      return {labels: buttons.length, details: [...document.querySelectorAll('pre')].map(pre => pre.textContent), errors: sessionErrors};
    })()`);
    expect(result.labels).toBe(3);
    expect(result.details.map((text) => JSON.parse(text).attachment)).toEqual([
      { type: 'skill_listing', names: 'oops' },
      { type: 'invoked_skills', skills: 'oops' },
      { type: 'command_permissions', allowedTools: 'oops' }
    ]);
    expect(result.errors).toEqual([]);
  });

  it('keeps following when Space activates a disclosure but holds for viewport Space navigation', async () => {
    await evaluate(`(async () => {
      document.querySelector('[data-session-disclosure="raw-50"] button').focus();
      sessionHarness.follow();
      await new Promise(resolve => setTimeout(resolve, 250));
      return true;
    })()`);
    await browser('press', 'Space');
    const afterDisclosure = await evaluate<{ open: string; status: string; gap: number }>(`(async () => {
      sessionHarness.append(); await new Promise(resolve => setTimeout(resolve, 250));
      const viewport = document.querySelector('.session-viewport');
      return { open: document.querySelector('[data-session-disclosure="raw-50"] button').getAttribute('aria-expanded'), status: document.querySelector('[role="status"]').textContent, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop };
    })()`);
    expect(afterDisclosure).toEqual({ open: 'true', status: 'Following latest', gap: 0 });
    await evaluate(`document.querySelector('.session-viewport').focus(); sessionHarness.follow(); true`);
    await browser('press', 'Space');
    expect(await evaluate(`document.querySelector('[role="status"]').textContent`)).toBe('Reading history');
  });
});

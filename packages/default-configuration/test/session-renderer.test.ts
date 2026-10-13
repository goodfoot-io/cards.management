/**
 * Render-only session preservation, trust-boundary and composition checks.
 * @summary Cards session content contract
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

  it('keeps source and generation boundaries distinct when native coordinates return to an earlier bucket', () => {
    const positions = [
      ['first', 'one', 1],
      ['first', 'one', 2],
      ['first', 'one', 129],
      ['first', 'one', 3],
      ['second', 'one', 3],
      ['second', 'two', 3]
    ] as const;
    const rows: SessionRow[] = positions.map(([sourceKey, generation, lineNumber], index) => ({
      ...row,
      id: `position-${index}`,
      parts: [],
      provenance: [{ sourceKey, generation, lineNumber, selector: 'record' }]
    }));
    rows.push({ ...row, id: 'unqualified', parts: [], provenance: [] });
    const html = render({ rows });
    const batches = html.split('class="session-batch"').slice(1);
    expect(
      batches.map((batch) =>
        [...batch.matchAll(/data-session-id="(position-\d|unqualified)"/g)].map((match) => match[1])
      )
    ).toEqual([
      ['position-0', 'position-1'],
      ['position-2'],
      ['position-3'],
      ['position-4'],
      ['position-5'],
      ['unqualified']
    ]);
    const ids = batches.map((batch) => batch.match(/data-session-id="([^"]+)"/)![1]);
    expect(new Set(ids).size).toBe(batches.length);
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
      providerRows: {
        hook: { render: ({ data }) => String((data as { label: string }).label), disclosureKeys: () => [] }
      }
    });
    expect(html).toContain('Hook row');
  });
  it('preserves shared parts alongside a provider-specific row presentation', () => {
    const html = render({
      rows: [{ ...row, kind: 'provider', providerKind: 'hook', data: 'Hook' }],
      providerRows: { hook: { render: () => 'Provider heading', disclosureKeys: () => [] } }
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
    const leafStatePath = JSON.stringify(join(packageDirectory, 'src/streams/lib/session/leaf-view-state.ts'));
    const contentPath = JSON.stringify(join(packageDirectory, 'src/streams/lib/session/SessionContent.tsx'));
    const claudePath = JSON.stringify(
      join(packageDirectory, 'src/streams/claude-code-session/www/components/expanded/ExpandedView.tsx')
    );
    const providerViews = [
      'codex-session/www/components/expanded/CodexExpandedView.tsx',
      'opencode-session/www/components/expanded/OpencodeExpandedView.tsx',
      'antigravity-session/www/components/expanded/AntigravityExpandedView.tsx'
    ].map((path) => JSON.stringify(join(packageDirectory, 'src/streams', path)));
    const opencodeSmoke = JSON.stringify(
      (await readFile(join(packageDirectory, 'test/fixtures/opencode/smoke-session.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
    );
    await writeFile(
      join(directory, 'main.jsx'),
      `
      import React, { useState, useRef, useCallback, useContext, Suspense, startTransition } from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionViewport } from ${viewportPath};
      import { SessionContent, SessionDisclosure } from ${contentPath};
      import { LeafViewState } from ${leafStatePath};
      import { ClaudeSourceView } from ${claudePath};
      import { CodexSourceView } from ${providerViews[0]};
      import { OpencodeSourceView } from ${providerViews[1]};
      import { AntigravitySourceView } from ${providerViews[2]};
      const customRows = ['one', 'two', 'event', 'observer'].map(id => ({id, kind:'provider', providerKind:'custom', data:id, provenance:[{sourceKey:'custom',generation:'one',lineNumber:1,selector:'record'}], parts:[]}));
      function LeafProbe({label}) {
        const state = useContext(LeafViewState);
        window.leafRenders[label] = (window.leafRenders[label] ?? 0) + 1;
        return <small data-leaf-probe={label}>{state ? 'Owned inspection' : 'Missing inspection'}</small>;
      }
      const customRegistry = {custom: {
        disclosureKeys: (leaf, data) => data === 'observer' ? undefined : [data === 'event' ? 'nested-one' : 'nested-' + data],
        render: ({data, disclosures, layout}) => {
          window.customRenders[data] = (window.customRenders[data] ?? 0) + 1;
          if (data === 'observer') return <output>{[...disclosures.open.values()].filter(Boolean).length}</output>;
          if (data === 'event') return <button data-read="event" onClick={() => { window.eventRead = {value:disclosures.open.get('nested-one'),present:disclosures.open.has('nested-one')}; }}>Read latest</button>;
          return <><LeafProbe label={data} /><SessionDisclosure id={'nested-' + data} label={data} context={{disclosures,layout}}><p>{data} body</p></SessionDisclosure></>;
        }
      }};
      const customInsertions = [{placementId:'custom-child',childSourceKey:'child',label:'Custom child',placement:{kind:'witnessed',parentSourceKey:'custom',rowId:'one',position:'after'}}];
      const renderCustomInsertion = (entry, context) => <span data-child-value>{String(context.disclosures.open.get('nested-one'))}</span>;
      const never = new Promise(() => {});
      function Pending({active}) { if(active) throw never; return null; }
      function CustomApp() {
        const [open, setOpen] = useState(new Map());
        const [pending, setPending] = useState(false);
        const [rows, setRows] = useState(customRows);
        const onOpenChange = useCallback((id,value)=>setOpen(previous=>new Map(previous).set(id,value)), []);
        window.customHarness = {
          replaceTwo: () => setRows(previous => previous.map(row => row.id === 'two' ? {...row, parts:[{id:'two-raw',kind:'raw',label:'Changed raw',reason:'detail',text:'a'.repeat(4096)+'b'.repeat(4096)+'c'.repeat(40000),provenance:[]}]} : row)),
          false: () => setOpen(new Map([['nested-one',false]])),
          absent: () => setOpen(new Map()),
          speculative: () => startTransition(() => { setOpen(new Map([['nested-one',true]])); setPending(true); })
        };
        return <><SessionContent rows={rows} providerRows={customRegistry} insertions={location.search === '?custom-insertion' ? customInsertions : undefined} renderInsertion={renderCustomInsertion} disclosures={{open,onOpenChange}} /><Pending active={pending} /></>;
      }
      window.customRenders = {};
      window.leafRenders = {};
      function ProviderApp() {
        const [sourceKey, setSourceKey] = useState('first');
        const [generation, setGeneration] = useState('one');
        const [lines, setLines] = useState(() => location.search.startsWith('?opencode-smoke') ? [...${opencodeSmoke}, ...(location.search === '?opencode-smoke-long' ? [JSON.stringify({v:1,ts:'2026-09-01T10:01:18.020Z',seq:20,sessionId:'ses-opencode-1',type:'part',data:{id:'part-incremental-long',messageID:'msg-incremental-1',type:'text',text:Array.from({length:80},(_, i) => 'Long reply paragraph '+(i+1)).join('\\n\\n')}})] : [])] : location.search.endsWith('-history')
          ? Array.from({length:40}, (_, i) => JSON.stringify({type:'future_record',value:'history raw '+(i+1)}))
          : [JSON.stringify({type:'future_record',value:'initial raw'})]);
        const [meta, setMeta] = useState(null);
        window.providerHarness = {
          switch: key => setSourceKey(key), reset: value => setGeneration(value),
          identity: (key, id, provider, cwd) => { setSourceKey(key); setLines([JSON.stringify({type:'session_meta',payload:{id,model_provider:provider,cwd}}),JSON.stringify({type:'future_record',value:'raw'})]); },
          metadata: () => setMeta({lineCount:lines.length,isActive:false}),
          append: () => setLines(previous => [...previous, JSON.stringify({type:'future_record',value:'appended raw'})]),
          push: added => setLines(previous => [...previous, ...added])
        };
        const View = location.search.startsWith('?codex') ? CodexSourceView : location.search.startsWith('?opencode') ? OpencodeSourceView : AntigravitySourceView;
        return <View source={{sourceKey,generation,filename:'fixture',lines,headLineNumber:1,meta,isLoading:false,error:null}} />;
      }
      function ClaudeApp() {
        const [lines, setLines] = useState(() => [
          {type:'assistant',uuid:'call-event',message:{content:[{type:'tool_use',id:'call',name:'Bash',input:{command:'pwd'}}]}},
          {type:'attachment',uuid:'hook-event',attachment:{type:'hook_success',hookName:'Check',toolUseID:'call',hookEvent:'PostToolUse',stdout:'a'.repeat(4096)+'b'.repeat(95904),stderr:'',content:'',exitCode:0}}
        ].map(value => JSON.stringify(value)));
        window.claudeHarness = {
          append: () => setLines(previous => [...previous, JSON.stringify({type:'user',uuid:'result-event',message:{content:[{type:'tool_result',tool_use_id:'call',content:'done'}]}})]),
          group: () => setLines([
            {type:'assistant',uuid:'start',message:{content:'start'}},
            {type:'attachment',uuid:'team-one',attachment:{type:'team_context',agentName:'one',teamName:'test-team'}},
            {type:'attachment',uuid:'team-two',attachment:{type:'team_context',agentName:'two',teamName:'test-team'}}
          ].map(value => JSON.stringify(value))),
          appendText: () => setLines(previous => [...previous,JSON.stringify({type:'assistant',uuid:'next',message:{content:'appended'}})]),
          push: added => setLines(previous => [...previous, ...added]),
          malformed: () => setLines([
            {type:'assistant', message:{content:'start'}},
            ...[{type:'skill_listing',names:'oops'}, {type:'invoked_skills',skills:'oops'}, {type:'command_permissions',allowedTools:'oops'}].map(attachment => ({type:'attachment',attachment}))
          ].map(value => JSON.stringify(value)))
        };
        return <ClaudeSourceView source={{sourceKey:'test/claude',generation:'one',filename:'fixture',lines,headLineNumber:1,meta:null,isLoading:false,error:null}} />;
      }
      const readerChildRows = [{id:'child',kind:'message',role:'user',provenance:[],
        parts:[{id:'child-text',kind:'text',text:'nested content',provenance:[]}]}];
      const readerRows = ['first','last'].map((id,index) => ({
        id,anchor:id === 'last' ? 'turn' : undefined,kind:'provider',providerKind:'probe',data:id,parts:[],
        provenance:[{sourceKey:'fixture',generation:'one',lineNumber:index+1,selector:'record'}]
      }));
      const native = id => ({id,kind:'notice',label:'Native '+id,tone:'info',
        parts:[{id:id+'-raw',kind:'raw',label:'Native detail '+id,text:'native bounded code',reason:'unknown',provenance:[]}],
        provenance:[{sourceKey:'fixture',generation:'one',lineNumber:id === 'native-first' ? 0 : 4,selector:'record'}]
      });
      readerRows.unshift(native('native-first')); readerRows.push(native('native-last'));
      const readerRegistry = {probe:{
        disclosureKeys:(leaf,data) => ['detail-'+data],
        render:({data,disclosures,layout}) => <div style={{marginBlock:data === 'first' ? '6px' : '18px'}}>
          <button id={'focus-'+data}>Focus {data}</button>
          <div className="session-markdown"><pre id={'code-'+data}>START {'unbroken'.repeat(100)} END</pre></div>
          <span data-fixed={data} style={{position:'fixed',insetBlockStart:0,insetInlineEnd:0}}>custom positioned</span>
          <SessionDisclosure id={'detail-'+data} label={'Detail '+data} context={{disclosures,layout}}>
            <SessionContent rows={readerChildRows.map(row => ({...row,id:row.id+'-'+data,
              parts:row.parts.map(part => ({...part,id:part.id+'-'+data}))}))} disclosures={disclosures} />
          </SessionDisclosure>
        </div>
      }};
      function ReaderApp() {
        const [currentRows,setRows] = useState(readerRows);
        const [open,setOpen] = useState(new Map([
          ['detail-first',true],['detail-last',true],['native-first-raw',true],['native-last-raw',true]
        ]));
        const onOpenChange = useCallback((id,value) => setOpen(previous => new Map(previous).set(id,value)),[]);
        const handle = useRef(null);
        window.readerHarness = {
          hold:() => handle.current.hold(),navigate:id => handle.current.navigateTo(id),
          capture:() => handle.current.captureAnchor(),follow:() => handle.current.followLatest(),
          append:() => setRows(previous => [...previous,native('appended-'+previous.length)]),
          // The repeated native bucket moves the existing held row to a different batch owner.
          prepend:() => setRows(previous => [native('prepended'),...previous]),
          toggle:() => setOpen(previous => new Map(previous).set('native-first-raw',!previous.get('native-first-raw')))
        };
        return <>
          <SessionViewport rows={currentRows} disclosures={{open,onOpenChange}} providerRows={readerRegistry} viewportRef={handle} />
          <aside id="reader-caller"><SessionContent rows={readerChildRows} disclosures={{open,onOpenChange}} /></aside>
        </>;
      }

      const makeRow = n => ({ id: 'row-' + n, kind: 'message', role: 'user', anchor: 'turn',
        provenance: [{ sourceKey: 'main', generation: 'one', lineNumber: n, selector: 'record' }],
        parts: [{ id: 'text-' + n, kind: 'text', text: 'Message ' + n, provenance: [] },
          { id: 'raw-' + n, kind: 'raw', label: 'Details ' + n, reason: 'detail',
            text: 'a'.repeat(4096) + 'b'.repeat(4096) + 'c'.repeat(40960), provenance: [] }] });
      const childRows = [{ ...makeRow(1), id: 'child-row', provenance: [{ sourceKey: 'child', generation: 'one', lineNumber: 1, selector: 'record' }], parts: [{ id: 'child-text', kind: 'text', text: 'Child output', provenance: [] }] }];
      const insertions = [{ placementId: 'child-placement', childSourceKey: 'child', label: 'Child activity', placement: { kind: 'section', position: 'end' } }];
      function App({large = false, longTail = false}) {
        const [rows, setRows] = useState(() => Array.from({ length: large ? 1200 : 50 }, (_, i) => makeRow(i + 1))
          .map((row, i, all) => longTail && i === all.length - 1 ? {...row, parts:[{...row.parts[0], text:'Long newest turn. '.repeat(600)}, row.parts[1]]} : row));
        const [open, setOpen] = useState(new Map());
        const handle = useRef(null);
        const onOpenChange = useCallback((id,value) => setOpen(previous => new Map(previous).set(id,value)),[]);
        const disclosures = { open, onOpenChange };
        window.sessionHarness = {
          append: () => setRows(previous => [...previous, makeRow(previous.length + 1)]),
          replaceAnchor: id => setRows(previous => previous.map(row => row.parts[0].id === id ? {...row, id:row.id+'-replacement'} : row)),
          regroup: () => setRows(previous => previous.map(row => row.parts[0].id === 'text-40' ? { ...row, id: row.id + '-regrouped' } : row)),
          toggle: id => setOpen(previous => new Map(previous).set(id, !previous.get(id))),
          follow: () => handle.current.followLatest(),
          navigate: id => handle.current.navigateTo(id),
          capture: () => handle.current.captureAnchor()
        };
        return <SessionViewport rows={rows} viewportRef={handle} disclosures={disclosures} insertions={large ? undefined : insertions}
          renderInsertion={large ? undefined : () => <SessionContent rows={childRows} disclosures={disclosures} />} />;
      }
      window.sessionErrors = [];
      addEventListener('error', event => window.sessionErrors.push(event.message));
      createRoot(document.getElementById('root')).render(location.search === '?reader-native' ? <ReaderApp /> : location.search.startsWith('?custom') ? <React.StrictMode><Suspense fallback={<p>Pending</p>}><CustomApp /></Suspense></React.StrictMode> : location.search === '?viewport-cache' ? <App large /> : location.search === '?long-tail' ? <App longTail /> : location.search === '?claude' ? <ClaudeApp /> : location.search ? <ProviderApp /> : <App />);
    `
    );
    // The harness bundles no Tailwind, so it declares the layout utilities provider views use to bound their viewport.
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><link rel="icon" href="data:,"><link rel="stylesheet" href="main.css"><style>html,body,#root{height:100%;margin:0}.h-full{height:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.overflow-hidden{overflow:hidden}:root{--vscode-font-size:13px;--stream-content-max-width:900px}</style></head><body><div id="root"></div><script>window.__STREAM_INIT__={primary:"fixture",files:{},availableFiles:[],mode:"expanded",themeKind:"dark",cssVariables:{}}</script><script type="module" src="main.js"></script></body></html>'
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

  it.each([900, 320])('preserves the reader through native prepend and regroup at %ipx', async (width) => {
    await browser('set', 'viewport', String(width), '700');
    try {
      await browser('open', `${origin}/?reader-native`);
      await browser('wait', '--text', 'Native native-last');
      const result = await evaluate<{
        opening: { focus: string; intent: string; top: number; settledTop: number; gap: number };
        before: { top: number; focus: string; selection: string };
        steps: { action: string; top: number; focus: string; selection: string }[];
        followed: boolean;
        followedAppend: boolean;
        yielded: boolean;
        uniqueRows: boolean;
        errors: string[];
      }>(`(async () => {
        const settle = async () => { for(let i=0;i<6;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
        const root = document.querySelector('.session-viewport');
        const leaf = id => [...root.querySelectorAll('[data-session-id]')].find(element => element.dataset.sessionId === id);
        const top = element => element.getBoundingClientRect().top - root.getBoundingClientRect().top;
        const status = () => document.querySelector('.session-controls [role=status]').textContent;
        const opening = {focus:document.activeElement.tagName,intent:status(),top:top(leaf('last')),gap:root.scrollHeight - root.scrollTop - root.clientHeight};
        await settle(); opening.settledTop = top(leaf('last'));
        readerHarness.navigate('last'); await settle();
        document.querySelector('#focus-last').focus();
        const range = document.createRange(); range.selectNodeContents(document.querySelector('#code-last'));
        getSelection().removeAllRanges(); getSelection().addRange(range); await settle(); readerHarness.hold();
        const saved = readerHarness.capture();
        const state = () => ({top:top(leaf(saved.id)),focus:document.activeElement.id,selection:getSelection().toString()});
        const before = state(), steps = [];
        for(const action of ['toggle','append','prepend']) { readerHarness[action](); await settle(); steps.push({action,...state()}); }
        getSelection().removeAllRanges(); document.activeElement.blur(); await settle();
        readerHarness.follow(); await settle();
        const followed = root.scrollHeight - root.scrollTop - root.clientHeight < 1 && status() === 'Following latest';
        readerHarness.append(); await settle();
        const followedAppend = root.scrollHeight - root.scrollTop - root.clientHeight < 1 && status() === 'Following latest';
        root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-1})); root.scrollTop -= 40; await settle();
        const ids = [...root.querySelectorAll('.session-row[data-session-id]')].map(element => element.dataset.sessionId);
        return {opening,before,steps,followed,followedAppend,yielded:status() === 'Reading history',uniqueRows:new Set(ids).size === ids.length,errors:sessionErrors};
      })()`);
      expect(result.before.selection).toBe(`START ${'unbroken'.repeat(100)} END`);
      expect(result.before.focus).toBe('focus-last');
      for (const step of result.steps) {
        expect(Math.abs(step.top - result.before.top), step.action).toBeLessThan(1);
        expect(step.focus, step.action).toBe(result.before.focus);
        expect(step.selection, step.action).toBe(result.before.selection);
      }
      expect(result.opening.focus).toBe('BODY');
      // The newest turn fits a wide viewport, so it opens at the live end; a narrow one holds at the turn's start.
      if (width === 900) {
        expect(result.opening.intent).toBe('Following latest');
        expect(result.opening.gap).toBeLessThan(1);
      } else {
        expect(result.opening.intent).toBe('Reading history');
        expect(result.opening.top).toBeGreaterThan(-1);
        expect(result.opening.top).toBeLessThan(26);
      }
      expect(Math.abs(result.opening.settledTop - result.opening.top)).toBeLessThan(1);
      expect(result.followed).toBe(true);
      expect(result.followedAppend).toBe(true);
      expect(result.yielded).toBe(true);
      expect(result.uniqueRows).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      await browser('set', 'viewport', '1280', '720');
    }
  });

  it.each([900, 320])('preserves fully realized row painting and caller-owned composition at %ipx', async (width) => {
    await browser('set', 'viewport', String(width), '2200');
    try {
      await browser('open', `${origin}/?reader-native`);
      await browser('wait', '--text', 'Native native-last');
      await browser('press', 'Tab');
      const snapshots: {
        fixed: { delta: number; rightDelta: number }[];
        code: { length: number; overflow: number }[];
        focus: { visible: boolean; width: string; offset: string };
        selection: string;
        nested: { visibility: string; contain: string; intrinsic: string }[];
        caller: { visibility: string; contain: string; intrinsic: string };
      }[] = [];
      const screenshots: Buffer[] = [];
      for (const reference of [true, false]) {
        const snapshot = await evaluate<(typeof snapshots)[number]>(`(async () => {
          const root = document.querySelector('.session-viewport');
          document.documentElement.style.setProperty('--vscode-focusBorder','Highlight');
          const rows = [...root.querySelectorAll(':scope > .session-content > .session-batch > .session-row')];
          // Compare the old row's used containment with fully realized content, not its offscreen estimate.
          for(const row of rows) {
            for(const property of ['content-visibility','contain','contain-intrinsic-block-size']) row.style.removeProperty(property);
            if(${reference}) { row.style.contentVisibility = 'auto'; row.style.contain = 'none'; row.style.containIntrinsicBlockSize = 'auto 92px'; }
          }
          const settle = async () => { for(let i=0;i<6;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
          root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1})); root.scrollTop = 0;
          for(const element of root.querySelectorAll('.session-row > *, .session-part')) element.getBoundingClientRect();
          await settle(); readerHarness.navigate('native-last'); await settle();
          root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1})); root.scrollTop = 0;
          document.querySelector('#focus-last').focus();
          const range = document.createRange(); range.selectNodeContents(document.querySelector('#code-last'));
          getSelection().removeAllRanges(); getSelection().addRange(range); await settle();
          const style = element => { const css = getComputedStyle(element); return {visibility:css.contentVisibility,contain:css.contain,intrinsic:css.containIntrinsicBlockSize}; };
          const button = document.querySelector('#focus-last'), css = getComputedStyle(button);
          return {
            fixed:[...root.querySelectorAll('[data-fixed]')].map(element => {const child=element.getBoundingClientRect(),row=element.closest('.session-row').getBoundingClientRect();return {delta:child.top-row.top,rightDelta:child.right-row.right};}),
            code:[...root.querySelectorAll('.session-markdown pre')].map(element => ({length:element.textContent.length,overflow:element.scrollWidth-element.clientWidth})),
            focus:{visible:button.matches(':focus-visible'),width:css.outlineWidth,offset:css.outlineOffset},selection:getSelection().toString(),
            nested:[...root.querySelectorAll('.session-content .session-content .session-row')].map(style),caller:style(document.querySelector('#reader-caller .session-row'))
          };
        })()`);
        snapshots.push(snapshot);
        const screenshot = join(directory, `reader-paint-${width}-${reference}.png`);
        await browser('screenshot', screenshot);
        screenshots.push(await readFile(screenshot));
      }
      expect(snapshots[1]).toEqual(snapshots[0]);
      expect(screenshots[1]!.equals(screenshots[0]!)).toBe(true);
      expect(snapshots[1]!.fixed).toEqual([
        { delta: 0, rightDelta: 0 },
        { delta: 0, rightDelta: 0 }
      ]);
      expect(snapshots[1]!.code).toEqual([
        { length: 810, overflow: 0 },
        { length: 810, overflow: 0 }
      ]);
      expect(snapshots[1]!.focus).toEqual({ visible: true, width: '1px', offset: '2px' });
      expect(snapshots[1]!.selection).toBe(`START ${'unbroken'.repeat(100)} END`);
      expect(snapshots[1]!.nested).toHaveLength(2);
      for (const style of [...snapshots[1]!.nested, snapshots[1]!.caller])
        expect(style).toEqual({ visibility: 'auto', contain: 'none', intrinsic: 'auto 92px' });
    } finally {
      await browser('set', 'viewport', '1280', '720');
    }
  });

  it('keeps unchanged inspection consumers out of disclosure updates while changed rows and paging remain live', async () => {
    await browser('open', `${origin}/?custom`);
    await browser('wait', '--text', 'Owned inspection');
    const result = await evaluate<{
      before: number;
      afterOpen: number;
      afterChanged: number;
      expanded: string | null;
      page: string | null;
    }>(`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve,250));
      const before = window.leafRenders.two;
      document.querySelector('[data-session-disclosure="nested-one"] button').click(); await settle();
      const expanded = document.querySelector('[data-session-disclosure="nested-one"] button').getAttribute('aria-expanded');
      const afterOpen = window.leafRenders.two;
      customHarness.replaceTwo(); await settle(); const afterChanged = window.leafRenders.two;
      document.querySelector('[data-session-disclosure="two-raw"] button').click(); await settle();
      [...document.querySelector('[data-session-disclosure="two-raw"]').querySelectorAll('button')].find(button => button.textContent === 'Next').click(); await settle();
      return {before,afterOpen,afterChanged,expanded,page:document.querySelector('[data-session-disclosure="two-raw"] pre').textContent};
    })()`);
    expect(result.afterOpen).toBe(result.before);
    expect(result.afterChanged).toBeGreaterThan(result.afterOpen);
    expect(result.expanded).toBe('true');
    expect(result.page).toBe('b'.repeat(4096));
  });

  it('reuses a validated held anchor lookup across both layout frames and re-resolves detached targets', async () => {
    await browser('open', `${origin}/?viewport-cache`);
    await browser('wait', '--text', 'Details 1200');
    const result = await evaluate<{
      lookups: number;
      same: boolean;
      replacement: boolean;
      anchor: string;
      offset: number;
      followed: boolean;
      errors: string[];
    }>(`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve,250));
      sessionHarness.navigate('text-1100'); await settle();
      const root = document.querySelector('.session-viewport');
      const nativeQuery = root.querySelector.bind(root); let lookups = 0;
      root.querySelector = selector => { if(selector.includes('data-session-id')) lookups++; return nativeQuery(selector); };
      const before = sessionHarness.capture();
      sessionHarness.toggle('raw-1'); await settle();
      const same = Math.abs(sessionHarness.capture().offset - before.offset) < 1;
      const transactionLookups = lookups;
      const previous = nativeQuery('[data-session-id="text-1100"]');
      // Regroup the held native leaf between the existing restoration frames.
      sessionHarness.toggle('raw-2');
      await new Promise(resolve => requestAnimationFrame(resolve));
      sessionHarness.replaceAnchor('text-1100');
      await settle();
      const saved = sessionHarness.capture();
      sessionHarness.follow(); await settle();
      const followed = root.scrollHeight - root.clientHeight - root.scrollTop < 1;
      return {lookups:transactionLookups,same,replacement:lookups > transactionLookups && !previous.isConnected,anchor:saved.id,offset:Math.abs(saved.offset-before.offset),followed,errors:sessionErrors};
    })()`);
    expect(result.lookups).toBeLessThanOrEqual(2);
    expect(result.same).toBe(true);
    expect(result.replacement).toBe(true);
    expect(result.anchor).toBe('text-1100');
    expect(result.offset).toBeLessThan(1);
    expect(result.followed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('updates arbitrary nested disclosure owners and map observers without redrawing unrelated custom rows', async () => {
    await browser('open', `${origin}/?custom`);
    await browser('wait', '--text', 'two');
    const result = await evaluate<{
      eventRead: { value: boolean; present: boolean };
      before: Record<string, number>;
      after: Record<string, number>;
      expanded: string | null;
      count: string | null;
      body: boolean;
    }>(`(async () => {
      const before = {...window.customRenders};
      document.querySelector('[aria-expanded]').click();
      await new Promise(resolve => setTimeout(resolve, 250));
      document.querySelector('[data-read=event]').click();
      return {eventRead:window.eventRead,before,after:{...window.customRenders},expanded:document.querySelector('[aria-expanded]').getAttribute('aria-expanded'),count:document.querySelector('output').textContent,body:document.body.textContent.includes('one body')};
    })()`);
    expect(result.eventRead).toEqual({ value: true, present: true });
    expect(result.expanded).toBe('true');
    expect(result.body).toBe(true);
    expect(result.count).toBe('1');
    expect(result.after['one']).toBeGreaterThan(result.before['one']!);
    expect(result.after['event']).toBeGreaterThan(result.before['event']!);
    expect(result.after['observer']).toBeGreaterThan(result.before['observer']!);
    expect(result.after['two']).toBe(result.before['two']);
  });

  it('keeps absent, false, and interrupted-render event snapshots coherent in StrictMode', async () => {
    await browser('open', `${origin}/?custom`);
    await browser('wait', '--text', 'Read latest');
    const result = await evaluate<{
      falseRead: { value: boolean; present: boolean };
      absentRead: { present: boolean };
      speculativeRead: { present: boolean };
      counts: number[];
    }>(`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve, 250));
      const read = () => { document.querySelector('[data-read=event]').click(); return {...window.eventRead}; };
      const counts = [window.customRenders.event];
      window.customHarness.false(); await settle(); const falseRead = read(); counts.push(window.customRenders.event);
      window.customHarness.absent(); await settle(); const absentRead = read(); counts.push(window.customRenders.event);
      window.customHarness.speculative(); await settle(); const speculativeRead = read(); counts.push(window.customRenders.event);
      return {falseRead,absentRead,speculativeRead,counts};
    })()`);
    expect(result.falseRead).toEqual({ value: false, present: true });
    expect(result.absentRead).toEqual({ present: false });
    expect(result.speculativeRead).toEqual({ present: false });
    expect(result.counts[1]).toBeGreaterThan(result.counts[0]!);
    expect(result.counts[2]).toBeGreaterThan(result.counts[1]!);
    expect(result.counts[3]).toBeGreaterThan(result.counts[2]!);
  });

  it('refreshes arbitrary witnessed child content while unrelated custom owners skip', async () => {
    await browser('open', `${origin}/?custom-insertion`);
    await browser('wait', '--text', 'Custom child');
    const result = await evaluate<{
      before: number;
      after: number;
      child: string | null;
      expanded: string | null;
    }>(`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve,250));
      const before = window.customRenders.two;
      document.querySelector('[data-session-disclosure="custom-child"] button').click(); await settle();
      document.querySelector('[data-session-disclosure="nested-one"] button').click(); await settle();
      return {before,after:window.customRenders.two,child:document.querySelector('[data-child-value]').textContent,expanded:document.querySelector('[data-session-disclosure="custom-child"] button').getAttribute('aria-expanded')};
    })()`);
    expect(result.expanded).toBe('true');
    expect(result.child).toBe('true');
    expect(result.after).toBe(result.before);
  });

  it('updates nested Claude group attachment details and retains them through collapse and append', async () => {
    await browser('open', `${origin}/?claude`);
    const result = await evaluate<{
      rawOpen: string | null;
      retained: string | null;
      text: string;
      errors: string[];
    }>(`(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve,250));
      claudeHarness.group(); await settle();
      const group = [...document.querySelectorAll('.session-disclosure')].find(node => node.querySelector('button').textContent.includes('Context ·'));
      const button = group.querySelector('button'); button.click(); await settle();
      const attachment = [...group.querySelectorAll('button')].find(node => node !== button); attachment.click(); await settle();
      const raw = [...group.querySelectorAll('button')].find(node => node.textContent.includes('Raw attachment details')); raw.click(); await settle();
      const rawOpen = raw.getAttribute('aria-expanded');
      button.click(); await settle(); button.click(); await settle(); claudeHarness.appendText(); await settle();
      const retained = [...group.querySelectorAll('button')].find(node => node.textContent.includes('Raw attachment details'));
      return {rawOpen,retained:retained.getAttribute('aria-expanded'),text:group.textContent,errors:sessionErrors};
    })()`);
    expect(result.rawOpen).toBe('true');
    expect(result.retained).toBe('true');
    expect(result.text).toContain('test-team');
    expect(result.errors).toEqual([]);
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

  it('renders Codex historical header facts after append, metadata, and a supplied source change', async () => {
    await browser('open', `${origin}/?codex`);
    const result = await evaluate<{
      original: string;
      retained: string;
      replacement: string;
      stale: boolean;
      errors: string[];
    }>(`(async () => {
      const frame = () => new Promise(resolve => setTimeout(resolve, 250));
      providerHarness.identity('first', 'original-thread', 'original-provider', '/original'); await frame();
      const original = document.querySelector('[title="original-thread"]').textContent;
      providerHarness.append(); providerHarness.metadata(); await frame();
      const retained = document.querySelector('[title="original-thread"]').textContent;
      providerHarness.identity('second', 'replacement-thread', 'replacement-provider', '/replacement'); await frame();
      return {original,retained,replacement:document.querySelector('[title="replacement-thread"]').textContent,
        stale:document.body.textContent.includes('original-provider') || !!document.querySelector('[title="original-thread"]'),errors:sessionErrors};
    })()`);
    expect(result).toEqual({
      original: 'original',
      retained: 'original',
      replacement: 'replacem',
      stale: false,
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

  it.each([
    ['', 'Following latest'],
    ['?long-tail', 'Reading history'],
    ['?codex-history', 'Following latest'],
    ['?antigravity-history', 'Following latest'],
    ['?opencode-smoke', 'Following latest']
  ])('opens %s history at the live end when the newest turn fits, otherwise at the start of that turn', async (query, intent) => {
    if (query) {
      await browser('open', `${origin}/${query}`);
      if (query === '?long-tail') await browser('wait', '--text', 'Details 50');
      else await browser('wait', '.session-viewport .session-row');
    }
    const result = await evaluate<{
      opening: { status: string; gap: number; spacer: number; newestTop: number };
      held: string;
      returned: { status: string; gap: number };
    }>(`(async () => {
      const settle = async () => { for(let i=0;i<6;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
      await settle();
      const root = document.querySelector('.session-viewport');
      const status = () => document.querySelector('.session-controls [role=status]').textContent;
      const rows = [...root.querySelectorAll(':scope > .session-content > .session-batch > .session-row')];
      const bounds = root.getBoundingClientRect();
      const opening = {
        status: status(),
        gap: root.scrollHeight - root.scrollTop - root.clientHeight,
        spacer: root.querySelector('[data-message-scroller-spacer]').getBoundingClientRect().height,
        newestTop: rows.at(-1).getBoundingClientRect().top - bounds.top
      };
      root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-1})); root.scrollTop -= 200; await settle();
      const held = status();
      root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1})); root.scrollTop = root.scrollHeight; await settle();
      return {opening, held, returned:{status:status(),gap:root.scrollHeight - root.scrollTop - root.clientHeight}};
    })()`);
    // A start-aligned short tail is padded by MessageScroller's spacer, leaving the viewport empty below it.
    expect(result.opening.spacer).toBe(0);
    expect(result.opening.status).toBe(intent);
    if (query === '?long-tail') {
      expect(result.opening.newestTop).toBeGreaterThan(-1);
      expect(result.opening.newestTop).toBeLessThan(26);
    } else expect(result.opening.gap).toBeLessThan(1);
    expect(result.held).toBe('Reading history');
    expect(result.returned).toEqual({ status: 'Following latest', gap: 0 });
  });

  it.each([
    ['?opencode-smoke', 'fits', 'Following latest'],
    ['?opencode-smoke-long', 'outgrows', 'Reading history']
  ])('opens the real OpenCode %s view whose newest turn %s the viewport as %s', async (query, _fit, status) => {
    await browser('set', 'viewport', '1280', '1000');
    try {
      await browser('open', `${origin}/${query}`);
      await browser('wait', '--text', 'Incremental smoke event');
      const result = await evaluate<{
        status: string;
        gap: number;
        scrollTop: number;
        turn: string;
        turnTop: number;
        disclosureBelow: number;
      }>(`(async () => {
        for(let i=0;i<10;i++) await new Promise(resolve => requestAnimationFrame(resolve));
        const root = document.querySelector('.session-viewport');
        const turn = [...root.querySelectorAll('[data-session-turn="true"]')].at(-1);
        const disclosure = [...root.querySelectorAll('.session-row[data-session-id]')].at(-1).querySelector('button');
        return {
          status: document.querySelector('.session-controls [role=status]').textContent,
          gap: root.scrollHeight - root.scrollTop - root.clientHeight,
          scrollTop: root.scrollTop,
          turn: turn.textContent,
          turnTop: turn.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop,
          disclosureBelow: disclosure.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom
        };
      })()`);
      // The final assistant reply is the newest turn; the opening prompt is not, however long the session grows.
      expect(result.turn).toContain('Incremental smoke event');
      expect(result.status).toBe(status);
      if (status === 'Following latest') {
        expect(result.gap).toBe(0);
        expect(result.disclosureBelow).toBeLessThan(0);
      } else {
        expect(result.gap).toBeGreaterThan(0);
        expect(Math.abs(result.scrollTop - result.turnTop)).toBeLessThan(1);
      }
    } finally {
      await browser('set', 'viewport', '1280', '720');
    }
  });

  it.each([
    ['scrolling', 'Following latest'],
    ['End', 'Following latest'],
    ['selecting then scrolling', 'Reading history']
  ])('resumes following on reaching the live end by %s only while no text is selected', async (way, status) => {
    await browser('open', `${origin}/`);
    await browser('wait', '.session-viewport .session-row');
    const held = await evaluate<string>(`(async () => {
      const settle = async () => { for(let i=0;i<6;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
      const root = document.querySelector('.session-viewport');
      sessionHarness.follow(); await settle();
      root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-1})); root.scrollTop -= 300; await settle();
      if (${JSON.stringify(way)} === 'selecting then scrolling') {
        const range = document.createRange(); range.selectNodeContents(root.querySelector('.session-row'));
        getSelection().removeAllRanges(); getSelection().addRange(range); await settle();
      }
      if (${JSON.stringify(way)} === 'End') root.focus();
      else { root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:1})); root.scrollTop = root.scrollHeight; await settle(); }
      return document.querySelector('.session-controls [role=status]').textContent;
    })()`);
    if (way === 'End') {
      expect(held).toBe('Reading history');
      await browser('press', 'End');
    }
    const result = await evaluate<{
      reached: string;
      status: string;
      gap: number;
      moved: number;
      selection: boolean;
    }>(`(async () => {
      const settle = async () => { for(let i=0;i<6;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
      const root = document.querySelector('.session-viewport');
      // Keyboard scrolling animates, so wait for the position to rest rather than a fixed frame count.
      for (let still = 0, last = -1, frames = 0; still < 10 && frames < 300; frames++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        still = root.scrollTop === last ? still + 1 : 0; last = root.scrollTop;
      }
      const status = () => document.querySelector('.session-controls [role=status]').textContent;
      const reached = status(), before = root.scrollTop;
      sessionHarness.append(); await settle();
      return {reached, status:status(), gap:root.scrollHeight - root.scrollTop - root.clientHeight, moved:root.scrollTop - before, selection:!getSelection().isCollapsed};
    })()`);
    expect(result.reached).toBe(status);
    expect(result.status).toBe(status);
    if (status === 'Following latest') expect(result.gap).toBeLessThan(1);
    else {
      // The append lands below a held reader, so the view neither moves nor drops the selection.
      expect(result.selection).toBe(true);
      expect(Math.abs(result.moved)).toBeLessThan(1);
      expect(result.gap).toBeGreaterThan(0);
    }
    await evaluate('getSelection().removeAllRanges(); true');
  });

  it.each([
    ['moves by script while an append settles', 'append', 'Reading history'],
    ['moves by script with nothing settling', 'none', 'Reading history'],
    ['reaches the live end while an append settles', 'end', 'Following latest']
  ])('keeps a held reader where they scrolled when the reader %s', async (_case, mode, status) => {
    await browser('open', `${origin}/`);
    await browser('wait', '.session-viewport .session-row');
    const result = await evaluate<{ status: string; drift: number; gap: number }>(`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const settle = async () => { for(let i=0;i<8;i++) await frame(); };
      const root = document.querySelector('.session-viewport');
      sessionHarness.follow(); await settle();
      root.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-1})); root.scrollTop -= 900; await settle();
      let target;
      if (${JSON.stringify(mode)} === 'end') {
        // The append commits, its resize starts settlement in the next frame, and the reader lands on the
        // live end in the frame after, before settlement's own restoring callback runs.
        const content = root.querySelector('.session-content');
        await new Promise(resolve => { new MutationObserver((_, observer) => { observer.disconnect(); resolve(); }).observe(content, {childList:true, subtree:true}); sessionHarness.append(); });
        await frame(); await frame();
        root.scrollTop = root.scrollHeight; target = root.scrollTop;
      } else {
        // A scrollbar drag or find-in-page moves scrollTop without wheel, key or pointer events.
        root.scrollTop += 300; target = root.scrollTop;
        if (${JSON.stringify(mode)} === 'append') sessionHarness.append();
      }
      await settle();
      return {status:document.querySelector('.session-controls [role=status]').textContent, drift:root.scrollTop - target, gap:root.scrollHeight - root.scrollTop - root.clientHeight};
    })()`);
    expect(result.status).toBe(status);
    if (mode === 'end') expect(result.gap).toBeLessThan(1);
    else expect(Math.abs(result.drift)).toBeLessThan(1);
  });

  const codexLine = (payload: object): string =>
    JSON.stringify({ timestamp: '2026-09-01T10:00:00.000Z', type: 'response_item', payload });
  const opencodeTool = (seq: number, status: string): string =>
    JSON.stringify({
      v: 1,
      ts: '2026-09-01T10:02:00.000Z',
      seq,
      sessionId: 'ses-opencode-1',
      type: 'part',
      data: {
        id: 'part-tool-live',
        messageID: 'msg-incremental-1',
        type: 'tool',
        callID: 'call-grep-live',
        tool: 'grep',
        state: { status, input: { pattern: 'smoke' }, ...(status === 'completed' ? { result: 'one match' } : {}) }
      }
    });
  const opencodeLine = (seq: number, type: string, data: object): string =>
    JSON.stringify({ v: 1, ts: '2026-09-01T10:03:00.000Z', seq, sessionId: 'ses-opencode-1', type, data });
  const opencodeReply = (time: object): object => ({
    id: 'msg-live-reply',
    role: 'assistant',
    modelID: 'gpt-5',
    providerID: 'openai',
    path: { cwd: '/workspace/opencode' },
    time
  });
  const antigravityReply = (idx: number, content: string): string =>
    JSON.stringify({
      v: 1,
      idx,
      stepType: 15,
      status: 3,
      content,
      hash: createHash('sha256').update(content, 'utf8').digest('hex'),
      anomaly: null
    });

  it.each([
    {
      provider: 'Claude',
      query: '?claude',
      harness: 'claudeHarness',
      steps: [
        [
          [
            JSON.stringify({
              type: 'user',
              uuid: 'result-event',
              message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] }
            })
          ],
          'Bash completed'
        ]
      ]
    },
    {
      provider: 'Codex',
      query: '?codex-history',
      harness: 'providerHarness',
      steps: [
        [[codexLine({ type: 'function_call', call_id: 'live-1', name: 'shell', arguments: '{"command":"pwd"}' })], ''],
        [[codexLine({ type: 'function_call_output', call_id: 'live-1', output: '/workspace' })], 'shell completed']
      ]
    },
    {
      provider: 'OpenCode',
      query: '?opencode-smoke',
      harness: 'providerHarness',
      steps: [
        [[opencodeTool(20, 'pending')], ''],
        [[opencodeTool(21, 'completed')], 'grep completed']
      ]
    },
    {
      provider: 'OpenCode reply',
      query: '?opencode-smoke',
      harness: 'providerHarness',
      steps: [
        [
          [
            opencodeLine(30, 'message', opencodeReply({ created: 1780000003000 })),
            opencodeLine(31, 'part', {
              id: 'part-live-reply',
              messageID: 'msg-live-reply',
              type: 'text',
              text: 'Streaming'
            })
          ],
          ''
        ],
        [
          [
            opencodeLine(32, 'part', {
              id: 'part-live-reply',
              messageID: 'msg-live-reply',
              type: 'text',
              text: 'Streaming done.'
            })
          ],
          ''
        ],
        [
          [opencodeLine(33, 'message', opencodeReply({ created: 1780000003000, completed: 1780000003900 }))],
          'New reply from OpenCode'
        ]
      ]
    },
    {
      provider: 'Antigravity',
      query: '?antigravity-history',
      harness: 'providerHarness',
      steps: [[[antigravityReply(900, 'Antigravity finished the task.')], 'New reply from Antigravity']]
    }
  ] as const)('announces only completed $provider changes in the polite live region', async ({
    query,
    harness,
    steps
  }) => {
    await browser('open', `${origin}/${query}`);
    await browser('wait', '.session-viewport .session-row');
    const settle = 'for(let i=0;i<8;i++) await new Promise(resolve => requestAnimationFrame(resolve));';
    const announced = (): Promise<string> =>
      evaluate<string>(
        `(async () => { ${settle} return document.querySelector('[data-session-announcer]').textContent; })()`
      );
    expect(await announced()).toBe('');
    for (const [lines, expected] of steps) {
      await evaluate(`${harness}.push(${JSON.stringify(lines)}); true`);
      expect(await announced()).toBe(expected);
    }
  });

  it('coalesces a large native batch into one announcement and stays silent on the history open', async () => {
    await browser('open', `${origin}/?codex-history`);
    await browser('wait', '.session-viewport .session-row');
    const batch = Array.from({ length: 50 }, (_, index) => [
      codexLine({ type: 'function_call', call_id: `batch-${index}`, name: 'shell', arguments: '{}' }),
      codexLine({ type: 'function_call_output', call_id: `batch-${index}`, output: 'ok' })
    ]).flat();
    const result = await evaluate<{ opened: string; announcements: string[] }>(`(async () => {
      const settle = async () => { for(let i=0;i<8;i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
      await settle();
      const region = document.querySelector('[data-session-announcer]');
      const opened = region.textContent, announcements = [];
      const observer = new MutationObserver(() => { if (region.textContent) announcements.push(region.textContent); });
      observer.observe(region, { childList: true, characterData: true, subtree: true });
      providerHarness.push(${JSON.stringify(batch)}); await settle();
      observer.disconnect();
      return { opened, announcements };
    })()`);
    expect(result).toEqual({ opened: '', announcements: ['shell completed'] });
  });
});

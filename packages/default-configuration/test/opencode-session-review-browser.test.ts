/**
 * Real React and MessageScroller controls inspect OpenCode histories and independent native owners.
 * @summary OpenCode composed browser identity and bounded revision regressions
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function envelope(type: string, data: unknown): string {
  return JSON.stringify({ v: 1, type, data, sessionId: 'review', seq: 1 });
}
const historyCases = [
  ['session', 'meta', { runtime: 'opencode' }, 'Session metadata'],
  ['messageDetails', 'message', { id: 'm', role: 'assistant' }, 'Message details'],
  ['attachment', 'part', { id: 'p', messageID: 'm', type: 'file', filename: 'FIRST.txt' }, 'Attachment details'],
  ['editedFiles', 'part', { id: 'p', messageID: 'm', type: 'patch', files: ['FIRST.txt'] }, 'Patch details'],
  ['step', 'part', { id: 'p', messageID: 'm', type: 'step-start' }, 'Model step started'],
  ['event', 'part', { id: 'p', messageID: 'm', type: 'future' }, 'Unsupported OpenCode part (future)'],
  ['nativeDetails', 'part', { id: 'p', messageID: 'm', type: 'text', text: 'visible' }, 'OpenCode text part details']
] as const;

describe('OpenCode composed revision controls', () => {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const session = `opencode-review-${process.pid}`;
  let directory: string;
  let server: Server;
  let origin: string;

  async function browser(...args: string[]): Promise<string> {
    return (await promisify(execFile)('agent-browser', ['--session', session, ...args])).stdout;
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
      child.once('close', (code) => (code === 0 ? resolveOutput(output) : reject(new Error(errors || output))));
      child.stdin.end(script);
    });
    return JSON.parse(output) as T;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opencode-review-'));
    await symlink(resolve(packageDirectory, '../../..', 'node_modules'), join(directory, 'node_modules'), 'junction');
    await writeFile(
      join(directory, 'main.jsx'),
      `
      import React, {useState, useMemo, useRef} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {createTranscriptProjection} from ${JSON.stringify(resolve(packageDirectory, 'src/streams/lib/session/projection.ts'))};
      import {SessionViewport} from ${JSON.stringify(resolve(packageDirectory, 'src/streams/lib/session/SessionViewport.tsx'))};
      import {BoundedText,SessionDisclosure,SessionContent} from ${JSON.stringify(resolve(packageDirectory, 'src/streams/lib/session/SessionContent.tsx'))};
      import {opencodeSessionProjector} from ${JSON.stringify(resolve(packageDirectory, 'src/streams/opencode-session/www/lib/project-session.ts'))};
      import {OPENCODE_PRESENTATION,OpenCodeTool} from ${JSON.stringify(resolve(packageDirectory, 'src/streams/opencode-session/www/components/expanded/OpencodePresentation.tsx'))};
      function App() {
        const [source,setSource]=useState({sourceKey:'review',generation:'one',lines:[],headLineNumber:1,meta:null,filename:'review.jsonl',isLoading:false,error:null});
        const [open,setOpen]=useState(new Map());
        const [siblingLines,setSiblingLines]=useState([]);
        const siblingController=useMemo(()=>createTranscriptProjection(opencodeSessionProjector,'review/sibling'),[]);
        const siblingProjection=useMemo(()=>siblingController.update({...source,sourceKey:'review/sibling',lines:siblingLines}).projection,[source.generation,siblingLines]);
        const controller=useMemo(()=>createTranscriptProjection(opencodeSessionProjector,'review'),[]);
        const projection=useMemo(()=>controller.update(source).projection,[source]);
        const viewport=useRef();
        window.harness={
          load:(lines,sibling=[])=>flushSync(()=>{setOpen(new Map());setSiblingLines(sibling);setSource({...source,lines,generation:'one',headLineNumber:129});}),
          prepend:lines=>flushSync(()=>setSource({...source,lines:[...lines,...source.lines],headLineNumber:source.headLineNumber-lines.length})),
          append:line=>flushSync(()=>setSource({...source,lines:[...source.lines,line]})),
          reset:()=>flushSync(()=>{setOpen(new Map());setSource({...source,generation:source.generation+'x'});}),
          capture:()=>viewport.current.captureAnchor(),
          hold:()=>viewport.current.hold(),
          navigate:id=>viewport.current.navigateTo(id),
          projection
        };
        return <SessionViewport viewportRef={viewport} rows={[...projection.rows,...siblingProjection.rows]} disclosures={{open,onOpenChange:(id,value)=>setOpen(prior=>new Map(prior).set(id,value))}}
          providerParts={OPENCODE_PRESENTATION} providerRows={OPENCODE_PRESENTATION}
          renderTool={(part,context)=><OpenCodeTool part={part} leaf={part} context={context}/>} />;
      }
      function RowBookmarks() {
        const [line,setLine]=useState(129);
        const [open,setOpen]=useState(new Map());
        const viewport=useRef();
        const focus=useRef([]);
        const registry=useMemo(()=>Object.fromEntries(['first','second'].map(kind=>[kind,{
          disclosureKeys:leaf=>[leaf.id],
          render:({leaf,data,...context})=><SessionDisclosure id={leaf.id} label={data.label} context={context}><BoundedText text={data.text} id={leaf.id} context={context}/></SessionDisclosure>
        }])),[]);
        const rows=useMemo(()=>['first','second','fallback'].map(kind=>({id:kind,kind:'provider',providerKind:kind,anchor:'none',parts:[{id:kind+'-child',kind:'raw',label:'Child details',reason:'unknown',text:'child content',provenance:[]}],
          provenance:[{sourceKey:'rows',generation:'one',lineNumber:line,selector:kind}],data:{label:kind,text:'a'.repeat(4096)+'SELECTABLE_'+kind+'_'+ 'b'.repeat(800)}})),[line]);
        window.rowHarness={focus:focus.current,navigate:id=>viewport.current.navigateTo(id),regroup:()=>flushSync(()=>setLine(128)),capture:()=>viewport.current.captureAnchor(),hold:()=>viewport.current.hold()};
        return <SessionViewport viewportRef={viewport} rows={rows} providerRows={registry} layout={{onFocusChange:id=>focus.current.push(id)}} disclosures={{open,onOpenChange:(id,value)=>setOpen(prior=>new Map(prior).set(id,value))}}/>;
      }
      function CallbackOwnership() {
        const [owner,setOwner]=useState('A');
        const [extra,setExtra]=useState(false);
        const [layoutVersion,setLayoutVersion]=useState(0);
        const [mounted,setMounted]=useState(true);
        const [open,setOpen]=useState(new Map());
        const events=useRef([]);
        const callbacks=useMemo(()=>Object.fromEntries(['A','B','C'].map(name=>[name,(id,node)=>events.current.push({name,id,node})])),[]);
        const rows=useMemo(()=>['typed','fallback'].map(kind=>({id:kind,kind:'provider',providerKind:kind,anchor:'none',provenance:[],
          parts:[{id:kind+'-child',kind:'raw',label:'Child details',reason:'unknown',text:'x'.repeat(4096)+'CHILD_PAGE',provenance:[]}],
          data:{label:kind,text:'x'.repeat(4096)+'ROW_PAGE'}})),[]);
        const registry=useMemo(()=>({typed:{disclosureKeys:leaf=>[leaf.id],render:({leaf,data,...context})=><SessionDisclosure id={leaf.id} label={data.label} context={context}><BoundedText text={data.text} id={leaf.id} context={context}/></SessionDisclosure>}}),[]);
        window.callbackHarness={events:events.current,replace:name=>flushSync(()=>setOwner(name)),refresh:()=>flushSync(()=>setLayoutVersion(layoutVersion+1)),insert:()=>flushSync(()=>setExtra(true)),remove:()=>flushSync(()=>setExtra(false)),unmount:()=>flushSync(()=>setMounted(false))};
        return mounted?<SessionContent rows={extra?[...rows,{...rows[0],id:'inserted',parts:[]}]:rows} providerRows={registry} layout={{onAnchorElement:callbacks[owner]}}
          disclosures={{open,onOpenChange:(id,value)=>setOpen(prior=>new Map(prior).set(id,value))}}/>:null;
      }
      window.sessionErrors=[];
      addEventListener('error',e=>sessionErrors.push(e.message));
      createRoot(document.getElementById('root')).render(location.search==='?callback-ownership'?<CallbackOwnership/>:location.search==='?row-bookmarks'?<RowBookmarks/>:<App/>);
    `
    );
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><link rel="icon" href="data:,"><link rel="stylesheet" href="main.css"><style>html,body,#root{height:100%;margin:0}:root{--vscode-font-size:13px;--stream-content-max-width:900px}</style></head><body><div id="root"></div><script type="module" src="main.js"></script></body></html>'
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
      const name = request.url === '/main.js' ? 'main.js' : request.url === '/main.css' ? 'main.css' : 'index.html';
      response.setHeader(
        'Content-Type',
        name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'
      );
      response.end(await readFile(join(directory, name)));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Review server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  }, 30000);

  afterAll(async () => {
    try {
      await browser('close');
    } finally {
      await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(historyCases)(
    'inspects every exact %s update with bounded DOM and preserves selected revision/page/focus on append',
    async (_kind, type, data, label) => {
      await browser('open', origin);
      const result = await evaluate<{
        exact: boolean;
        maxInspectors: number;
        maxCharacters: number;
        maxNodes: number;
        selected: boolean;
        page: boolean;
        focus: boolean;
        prepend: boolean;
        sibling: boolean;
        errors: string[];
      }>(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,250));
      await wait();
      const lines=Array.from({length:1000},(_,revision)=>JSON.stringify({v:1,type:${JSON.stringify(type)},data:{...${JSON.stringify(data)},payload:'x'.repeat(5000),revision},sessionId:'review',seq:1}));
      harness.load(lines,lines); await wait();
      const owners=[...document.querySelectorAll('[data-session-disclosure]')].filter(e=>e.querySelector('button').textContent.trim()===${JSON.stringify(label)});
      const [owner,sibling]=owners;
      owner.querySelector('button').click(); sibling.querySelector('button').click(); await wait();
      const button=text=>[...owner.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      let exact=true,maxInspectors=0,maxCharacters=0,maxNodes=0;
      for(let index=0;index<lines.length;index++) {
        let value=owner.querySelector('pre.session-raw').textContent;maxCharacters=Math.max(maxCharacters,value.length);
        button('Next').click(); await new Promise(r=>setTimeout(r,0));
        value+=owner.querySelector('pre.session-raw').textContent;
        exact &&=value===lines[index];
        maxInspectors=Math.max(maxInspectors,owner.querySelectorAll('pre.session-raw').length);
        maxCharacters=Math.max(maxCharacters,[...owner.querySelectorAll('pre.session-raw')].reduce((n,e)=>n+e.textContent.length,0));
        maxNodes=Math.max(maxNodes,owner.querySelectorAll('*').length);
        if(index<lines.length-1){button('Next update').click();await new Promise(r=>setTimeout(r,0));}
      }
      button('Previous update').click(); await wait();
      button('Next').click(); await wait();
      const old=owner.querySelector('pre.session-raw').textContent;
      const focused=button('Previous update');focused.focus();
      harness.append(${JSON.stringify(envelope(type, { ...data, payload: 'z'.repeat(5000), revision: 1000 }))});await wait();
      const selected=owner.textContent.includes('Update 999 of 1001');
      const page=owner.querySelector('pre.session-raw').textContent===old;
      const focus=document.activeElement===focused;
      harness.prepend([${JSON.stringify(envelope(type, { ...data, payload: 'h'.repeat(5000), revision: -1 }))}]);await wait();
      const currentOwner=[...document.querySelectorAll('[data-session-disclosure]')].find(e=>e.dataset.sessionDisclosure===owner.dataset.sessionDisclosure);
      const currentFocus=[...currentOwner.querySelectorAll('button')].find(b=>b.textContent.trim()==='Previous update');
      const prepend=currentOwner.textContent.includes('Update 1000 of 1002')&&currentOwner.querySelector('pre.session-raw').textContent===old&&document.activeElement===currentFocus;
      currentOwner.querySelector('button').click();await wait();currentOwner.querySelector('button').click();await wait();
      const reopened=currentOwner.textContent.includes('Update 1000 of 1002')&&currentOwner.querySelector('pre.session-raw').textContent===old;
      return {exact,maxInspectors,maxCharacters,maxNodes,selected,page,focus,prepend:prepend&&reopened,prependDetails:{revision:currentOwner.textContent.includes('Update 1000 of 1002'),page:currentOwner.querySelector('pre.session-raw').textContent===old,focus:document.activeElement===currentFocus,reopened,activeText:document.activeElement?.textContent?.slice(0,80)},
        sibling:sibling.textContent.includes('Update 1 of 1000')&&sibling.textContent.includes('Characters 1–4096'),errors:sessionErrors};
    })()`);
      expect(result.exact).toBe(true);
      expect(result.maxInspectors).toBe(1);
      expect(result.maxCharacters).toBeLessThanOrEqual(4097);
      expect(result.maxNodes).toBeLessThan(30);
      expect(result.selected).toBe(true);
      expect(result.page).toBe(true);
      expect(result.focus).toBe(true);
      expect(result.prepend, JSON.stringify(result)).toBe(true);
      expect(result.sibling).toBe(true);
      expect(result.errors).toEqual([]);
    },
    60000
  );

  it.each([
    'first',
    'second',
    'fallback'
  ])('restores shared %s provider-row focus, selection, page and anchor across regrouping', async (kind) => {
    await browser('open', `${origin}/?row-bookmarks`);
    const result = await evaluate<{
      focus: boolean;
      selection: boolean;
      page: boolean;
      anchor: boolean;
      registered: number;
      errors: string[];
    }>(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,250));await wait();
      const owner=()=>document.querySelector('[data-session-disclosure="'+${JSON.stringify(kind)}+'"]');
      owner().querySelector('button').click();await wait();
      const control=text=>[...owner().querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      control('Next').click();await wait();control('Previous').focus();
      const node=owner().querySelector('pre').firstChild;
      const selection=document.getSelection();selection.setBaseAndExtent(node,5,node,15);await wait();
      const selected=selection.toString();const shown=node.textContent;
      rowHarness.navigate(${JSON.stringify(kind)});await wait();rowHarness.hold();
      const before=rowHarness.capture();rowHarness.regroup();await wait();const after=rowHarness.capture();
      return {focus:document.activeElement===control('Previous'),selection:selection.toString()===selected,page:owner().querySelector('pre').textContent===shown,
        anchor:before?.id===after?.id&&Math.abs(before.offset-after.offset)<0.1,
        anchors:[before,after],registered:document.querySelectorAll('[data-session-id="'+${JSON.stringify(kind)}+'"]').length,errors:sessionErrors};
    })()`);
    expect(result.anchor, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ focus: true, selection: true, page: true, anchor: true, registered: 1, errors: [] });
  });

  it.each([
    'typed',
    'fallback',
    'typed-child'
  ])('transfers the mounted %s anchor to the replacement callback before unmount', async (id) => {
    await browser('open', `${origin}/?callback-ownership`);
    const result = await evaluate<{
      events: string[];
      sameElement: boolean;
      inserted: string[];
      preserved: boolean;
      registered: number;
      errors: string[];
    }>(`(async()=>{
        const wait=()=>new Promise(r=>setTimeout(r,250));await wait();
        const id=${JSON.stringify(id)};
        const element=document.querySelector('[data-session-id="'+id+'"]');
        const owner=element.querySelector('[data-session-disclosure="'+id+'"]');
        owner.querySelector('button').click();await wait();
        const button=text=>[...owner.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
        button('Next').click();await wait();button('Previous').focus();
        const text=owner.querySelector('pre');const shown=text.textContent;
        const range=document.createRange();range.selectNodeContents(text);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const selected=selection.toString();
        callbackHarness.replace('B');await wait();
        callbackHarness.refresh();await wait();
        callbackHarness.insert();await wait();callbackHarness.remove();await wait();
        callbackHarness.replace('none');await wait();
        callbackHarness.replace('C');await wait();
        const preserved=document.activeElement===button('Previous')&&selection.toString()===selected&&text.textContent===shown;
        const registered=document.querySelectorAll('[data-session-id="'+id+'"]').length;
        callbackHarness.unmount();await wait();
        const events=callbackHarness.events.filter(event=>event.id===id);
        return {events:events.map(event=>event.name+':'+(event.node?'node':'null')),
          sameElement:events.filter(event=>event.node).every(event=>event.node===element),
          inserted:callbackHarness.events.filter(event=>event.id==='inserted').map(event=>event.name+':'+(event.node?'node':'null')),preserved,registered,errors:sessionErrors};
      })()`);
    expect(result).toEqual({
      events: ['A:node', 'A:null', 'B:node', 'B:null', 'C:node', 'C:null'],
      inserted: ['B:node', 'B:null'],
      sameElement: true,
      preserved: true,
      registered: 1,
      errors: []
    });
  });

  it('keeps a nested part as the focus owner inside a registered provider row', async () => {
    await browser('open', `${origin}/?row-bookmarks`);
    const result = await evaluate<string>(`(async()=>{
      await new Promise(r=>setTimeout(r,250));
      document.querySelector('[data-session-disclosure="first-child"] button').focus();
      return rowHarness.focus.at(-1);
    })()`);
    expect(result).toBe('first-child');
  });

  it('yields pending regroup restoration to explicit reader navigation', async () => {
    await browser('open', `${origin}/?row-bookmarks`);
    const result = await evaluate<{
      priorOffset: number;
      requestedOffset: number;
      settledOffset: number;
      requestedScroll: number;
      settledScroll: number;
      registered: number;
      visible: boolean;
      id: string;
      intent: string;
      errors: string[];
    }>(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,250));await wait();
      rowHarness.navigate('fallback');await wait();
      const root=document.querySelector('.session-viewport');
      const offset=element=>element.getBoundingClientRect().top-root.getBoundingClientRect().top;
      const priorOffset=offset(document.querySelector('[data-session-id="first"]'));
      rowHarness.regroup();rowHarness.navigate('first');
      const target=document.querySelector('[data-session-id="first"]');
      const requestedOffset=offset(target),requestedScroll=root.scrollTop;
      await wait();const settledOffset=offset(target);
      return {priorOffset,requestedOffset,settledOffset,requestedScroll,settledScroll:root.scrollTop,
        registered:root.querySelectorAll('[data-session-id="first"]').length,
        visible:settledOffset>=0&&settledOffset<root.clientHeight,id:target.dataset.sessionId,
        intent:document.querySelector('[role="status"]').textContent,errors:sessionErrors};
    })()`);
    expect(Math.abs(result.priorOffset)).toBeGreaterThan(1);
    expect(Math.abs(result.requestedOffset)).toBeLessThan(1);
    expect(Math.abs(result.settledOffset)).toBeLessThan(1);
    expect(Math.abs(result.settledOffset - result.requestedOffset)).toBeLessThan(1);
    expect(Math.abs(result.settledScroll - result.requestedScroll)).toBeLessThan(1);
    expect(result).toMatchObject({ registered: 1, visible: true, id: 'first', intent: 'Reading history', errors: [] });
  });

  it('fully inspects five MiB native input and result with one bounded revision mounted', async () => {
    await browser('open', origin);
    const result = await evaluate<{
      exact: boolean;
      maxCharacters: number;
      inspectors: number;
      errors: string[];
    }>(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,250));await wait();
      const envelope=data=>JSON.stringify({v:1,type:'part',data,sessionId:'review',seq:1});
      const base={type:'tool',id:'large-part',messageID:'m',callID:'call',tool:'read'};
      const input={payload:'i'.repeat(5*1024*1024),tail:'INPUT_END'};
      const output={payload:'r'.repeat(5*1024*1024),tail:'RESULT_END'};
      const lines=[envelope({...base,state:{status:'pending',input}}),envelope({...base,state:{status:'completed',input,output}})];
      harness.load(lines);await wait();
      const owner=[...document.querySelectorAll('[data-session-disclosure]')].find(e=>e.querySelector('button').textContent.trim()==='OpenCode tool event details');
      owner.querySelector('button').click();await wait();
      const button=text=>[...owner.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      let exact=true,maxCharacters=0;
      for(let revision=0;revision<lines.length;revision++){
        let joined='';
        do {
          const shown=owner.querySelector('pre.session-raw').textContent;
          joined+=shown;maxCharacters=Math.max(maxCharacters,shown.length);
          if(button('Next').disabled)break;
          button('Next').click();await new Promise(r=>setTimeout(r,0));
        }while(true);
        exact&&=joined===lines[revision];
        if(revision<lines.length-1){button('Next update').click();await wait();}
      }
      return {exact,maxCharacters,inspectors:owner.querySelectorAll('pre.session-raw').length,errors:sessionErrors};
    })()`);
    expect(result).toEqual({ exact: true, maxCharacters: 4096, inspectors: 1, errors: [] });
  }, 60000);

  it.each([
    'text',
    'tool'
  ])('keeps delimiter-bearing %s owners independent through details, pages, append, focus and anchors', async (type) => {
    const pairs = [
      ['a/b', 'c', 'FIRST.txt'],
      ['a', 'b/c', 'SECOND.txt']
    ];
    const lines = pairs.map(([messageID, identity, text], index) =>
      envelope(
        'part',
        type === 'text'
          ? { type, messageID, id: identity, text, payload: 'x'.repeat(5000) }
          : {
              type,
              messageID,
              id: `p${index}`,
              callID: identity,
              tool: 'read',
              state: { status: 'completed', input: { path: text } },
              payload: 'x'.repeat(5000)
            }
      )
    );
    await browser('open', origin);
    const result = await evaluate<{
      independent: boolean;
      pages: boolean;
      focus: boolean;
      anchor: boolean;
      stable: boolean;
      reset: boolean;
      errors: string[];
    }>(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,250));await wait();harness.load(${JSON.stringify(lines)});await wait();
      const detailOwners=()=>[...document.querySelectorAll('[data-session-disclosure]')].filter(e=>e.querySelector('button').textContent.includes('part details')||e.querySelector('button').textContent.includes('tool event details'));
      let [first,second]=detailOwners();
      first.querySelector('button').click();await wait();
      const independent=first.querySelector('button').getAttribute('aria-expanded')==='true'&&second.querySelector('button').getAttribute('aria-expanded')==='false';
      const next=[...first.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next');next.click();await wait();
      second.querySelector('button').click();await wait();
      const pages=first.textContent.includes('Characters 4097')&&second.textContent.includes('Characters 1–4096');
      if(${JSON.stringify(type)}==='tool'){
        const tools=[...document.querySelectorAll('[data-session-disclosure]')].filter(e=>e.querySelector('button').textContent.trim()==='read · completed');
        tools[0].querySelector('button').click();await wait();
        if(tools[1].querySelector('button').getAttribute('aria-expanded')!=='false')throw Error('Tool owner collision');
      }
      const focused=[...first.querySelectorAll('button')].find(b=>b.textContent.trim()==='Previous');focused.focus();harness.hold();const before=harness.capture();const ids=harness.projection.rows.flatMap(r=>r.parts).map(p=>p.id);
      harness.append(${JSON.stringify(lines[0])});await wait();
      const after=harness.capture();
      const focus=document.activeElement===focused;
      const anchor=before&&after&&before.id===after.id&&Math.abs(before.offset-after.offset)<2;
      const stable=JSON.stringify(ids)===JSON.stringify(harness.projection.rows.flatMap(r=>r.parts).map(p=>p.id))&&first.textContent.includes('Characters 4097')&&second.textContent.includes('Characters 1–4096');
      harness.reset();await wait();
      const reset=[...document.querySelectorAll('[data-session-disclosure] button[aria-expanded]')].every(b=>b.getAttribute('aria-expanded')==='false');
      return {independent,pages,focus,anchor:!!anchor,stable,reset,errors:sessionErrors};
    })()`);
    expect(result).toEqual({
      independent: true,
      pages: true,
      focus: true,
      anchor: true,
      stable: true,
      reset: true,
      errors: []
    });
  });
});

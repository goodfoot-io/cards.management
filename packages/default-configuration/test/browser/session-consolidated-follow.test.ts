/**
 * Mounts the production Claude HTML entry over a live main and subagent session and checks that
 * expanded mode follows appends from every source until the reader scrolls, while card-detail
 * mode never scrolls itself.
 * @summary Consolidated session follow and unfollow under real MessageScroller layout
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delegate, delegated, lines, prompt, reply, SESSION_ID, sidechain } from '../fixtures/claude-session-members';

/** Scroll position of the expanded viewport, or of the document in card detail. */
interface Position {
  status: string | null;
  gap: number;
  top: number;
  viewport: boolean;
  errors: string[];
}

// The page is its own parent, so an in-page host answers each source subscription with that
// source's coherent snapshot and appends live records through the published bridge messages.
describe('Consolidated session follow', () => {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const session = `session-consolidated-follow-${process.pid}`;
  const MAIN = 'SESSION.jsonl';
  const CHILD = 'SESSION/subagents/agent-A.jsonl';
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

  /**
   * Waits until text is mounted anywhere, including rows scrolled out of view.
   * @param text - Text to find.
   * @returns Resolves once mounted.
   */
  const rendered = (text: string): Promise<boolean> =>
    evaluate<boolean>(`(async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (document.body.textContent.includes(${JSON.stringify(text)})) return true;
        await new Promise(done => setTimeout(done, 25));
      }
      throw new Error('Text never rendered: ' + ${JSON.stringify(text)});
    })()`);

  /**
   * Appends records to one source, then reads the scroll position after layout settles.
   * @param relPath - Source receiving the records, or null to only read.
   * @param records - Native records to append.
   * @returns Follow status, distance from the end and scroll offset.
   */
  const appendThenRead = (relPath: string | null, records: readonly unknown[] = []): Promise<Position> =>
    evaluate<Position>(`(async () => {
      ${relPath ? `window.host.append(${JSON.stringify(relPath)}, ${JSON.stringify(lines(records))});` : ''}
      for (let frame = 0; frame < 12; frame++) await new Promise(done => requestAnimationFrame(done));
      await new Promise(done => setTimeout(done, 250));
      const root = document.querySelector('.session-viewport');
      const scroller = root ?? document.scrollingElement;
      return {
        status: document.querySelector('.session-controls [role=status]')?.textContent ?? null,
        gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        top: scroller.scrollTop,
        viewport: !!root,
        errors: rendererErrors
      };
    })()`);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cards-session-consolidated-follow-'));
    await symlink(join(packageDirectory, 'src'), join(directory, 'src'), 'junction');
    await promisify(execFile)(
      'yarn',
      [
        'exec',
        'bun',
        `--cwd=${directory}`,
        'run',
        join(packageDirectory, 'src/streams/claude-code-session/www/build.ts')
      ],
      { cwd: packageDirectory }
    );
    const html = await readFile(join(directory, 'dist/www/claude-code-session/index.html'), 'utf8');
    const mainLines = lines(
      Array.from({ length: 30 }, (_, index) => [
        prompt(`Question ${index + 1}`, `p${index}`),
        ...(index === 29 ? [delegate('TOOL-A', 'call-a'), delegated('TOOL-A', 'A', 'result-a')] : []),
        reply(`Answer ${index + 1}`, `r${index}`)
      ]).flat()
    );
    const childLines = lines(
      Array.from({ length: 5 }, (_, index) => sidechain('A', `Child step ${index + 1}`, `a${index}`))
    );
    server = createServer((request, response) => {
      const mode = request.url === '/compact' ? 'compact' : 'expanded';
      const ref = (relPath: string) => ({ cardId: 'card-1', streamType: 'claude-code-session', relPath });
      const identity = { cardId: 'card-1', streamType: 'claude-code-session', sessionId: SESSION_ID };
      const members = [
        { source: ref(MAIN), role: 'main' },
        { source: ref(CHILD), role: 'subagent', agentId: 'A' }
      ];
      const init = {
        session: identity,
        generation: 'gen-1',
        revision: 1,
        mode,
        descriptor: { session: identity, members, main: ref(MAIN), validity: 'ready' }
      };
      const sources = Object.fromEntries(
        [
          [MAIN, mainLines, { sessionId: SESSION_ID, role: 'main' }],
          [CHILD, childLines, { sessionId: SESSION_ID, role: 'subagent', agentId: 'A' }]
        ].map(([relPath, seed, binding]) => [
          relPath as string,
          {
            lines: seed,
            authority: {
              generation: 'gen-1',
              source: ref(relPath as string),
              version: { serverEpoch: 'server-1', sourceEpoch: 'source-1' },
              binding
            },
            meta: {
              version: 1,
              relPath,
              streamType: 'claude-code-session',
              runtime: 'claude-code',
              ...(binding as object),
              sourcePath: `/native/${relPath}`,
              startedAt: '2026-01-01T00:00:00.000Z',
              lineCount: (seed as string[]).length,
              createdAt: '2026-01-01T00:00:00.000Z',
              isActive: true
            }
          }
        ])
      );
      const safe = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');
      const host = `window.sources=${safe(sources)};window.posted=[];window.requests={};window.host={append(relPath,lines){const source=sources[relPath];const first=source.lines.length+1;source.lines.push(...lines);postMessage({type:'source:append',...source.authority,firstLineNumber:first,lines},'*')},status(relPath,state){postMessage({type:'source:status',...sources[relPath].authority,state},'*')},error(relPath,error){postMessage({type:'source:error',generation:'gen-1',requestId:requests[relPath],source:sources[relPath].authority.source,error},'*')}};addEventListener('message',event=>{const message=event.data;if(message?.type==='session:resync')posted.push(message.type);if(message?.type!=='source:subscribe')return;requests[message.source.relPath]=message.requestId;const source=sources[message.source.relPath];postMessage({type:'source:snapshot',...source.authority,requestId:message.requestId,meta:{...source.meta,lineCount:source.lines.length},lines:source.lines,firstLineNumber:1,totalLineCount:source.lines.length},'*')});`;
      const bootstrap = `<script>window.__STREAM_INIT__=${safe(init)};window.rendererErrors=[];addEventListener('error',event=>rendererErrors.push(event.message));${host}</script>`;
      response.setHeader('Content-Type', 'text/html');
      response.end(html.replace('<head>', `<head>${bootstrap}`));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Follow test server did not bind a TCP port');
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

  it('follows appends from the main and an open subagent until the reader scrolls away', async () => {
    await browser('set', 'viewport', '800', '600');
    await browser('open', `${origin}/expanded`);
    await browser('wait', '--text', 'Answer 30');
    const opening = await appendThenRead(null);
    expect(opening).toMatchObject({ status: 'Following latest', viewport: true, errors: [] });
    expect(opening.gap).toBeLessThan(1);

    const main = await appendThenRead(MAIN, [prompt('Question 31', 'p30'), reply('Answer 31', 'r30')]);
    expect(main.status).toBe('Following latest');
    expect(main.gap).toBeLessThan(1);
    expect(main.top).toBeGreaterThan(opening.top);

    // The subagent section sits at its delegation above the final reply; its growth still follows the end.
    await evaluate(
      `[...document.querySelectorAll('[data-session-disclosure]')].find(element => element.dataset.sessionDisclosure.startsWith('["session-member"')).querySelector(':scope > .session-disclosure-button').click(); true`
    );
    await rendered('Child step 5');
    const opened = await appendThenRead(null);
    const child = await appendThenRead(
      CHILD,
      Array.from({ length: 6 }, (_, index) => sidechain('A', `Child step ${index + 6}`, `a${index + 5}`))
    );
    await rendered('Child step 11');
    expect(child.status).toBe('Following latest');
    expect(child.gap).toBeLessThan(1);
    expect(child.top).toBeGreaterThan(opened.top);

    await evaluate(`(() => {
      const root = document.querySelector('.session-viewport');
      root.dispatchEvent(new WheelEvent('wheel', {bubbles: true, deltaY: -1}));
      root.scrollTop -= 300;
      return true;
    })()`);
    const held = await appendThenRead(null);
    expect(held.status).toBe('Reading history');
    const after = await appendThenRead(MAIN, [prompt('Question 32', 'p31'), reply('Answer 32', 'r31')]);
    expect(after.status).toBe('Reading history');
    expect(after.top).toBe(held.top);
    expect(after.gap).toBeGreaterThan(held.gap);
    expect(after.errors).toEqual([]);
  }, 60000);

  it('dims resynchronizing content in place and offers a keyboard-reachable Retry once paused', async () => {
    await browser('set', 'viewport', '800', '600');
    await browser('open', `${origin}/expanded`);
    await browser('wait', '--text', 'Answer 30');
    /**
     * Reads the main content's staleness, opacity and the geometry a layout jump would move.
     * @returns Staleness, computed opacity, scroll offset, scroll height and a row's position.
     */
    const read = (): Promise<{ stale: boolean; opacity: string; top: number; height: number; row: number }> =>
      evaluate(`(async () => {
        for (let frame = 0; frame < 6; frame++) await new Promise(done => requestAnimationFrame(done));
        await new Promise(done => setTimeout(done, 200));
        const content = document.querySelector('.session-source-content');
        const viewport = document.querySelector('.session-viewport');
        const row = [...document.querySelectorAll('.session-row')].find(element => element.textContent.includes('Answer 30'));
        return {
          stale: content.hasAttribute('data-stale'),
          opacity: getComputedStyle(content).opacity,
          top: viewport.scrollTop,
          height: viewport.scrollHeight,
          row: row.getBoundingClientRect().top
        };
      })()`);
    const before = await read();
    expect(before).toMatchObject({ stale: false, opacity: '1' });
    await evaluate(`window.host.status(${JSON.stringify(MAIN)}, 'resynchronizing'); true`);
    const stale = await read();
    expect(stale).toEqual({ ...before, stale: true, opacity: '0.8' });
    await evaluate(`window.host.status(${JSON.stringify(MAIN)}, 'ready'); true`);
    expect(await read()).toEqual(before);

    await evaluate(`window.host.error(${JSON.stringify(MAIN)}, 'resync-overflow'); true`);
    await browser('wait', '.session-retry');
    const retry = await evaluate<{ label: string; minHeight: string; cursor: string; focused: boolean }>(`(() => {
      const button = document.querySelector('.session-retry');
      button.focus();
      const style = getComputedStyle(button);
      return { label: button.getAttribute('aria-label'), minHeight: style.minHeight, cursor: style.cursor, focused: document.activeElement === button };
    })()`);
    // Themed like the window controls: a full-height pointer target (theme colours are host-supplied).
    expect(retry).toMatchObject({ focused: true, minHeight: '24px', cursor: 'pointer' });
    expect(retry.label).toMatch(/^Retry \S/);
    await browser('press', 'Enter');
    await browser('wait', '--text', 'Answer 30');
    const after = await evaluate<{ posted: string[]; retry: boolean; error: boolean; errors: string[] }>(`(async () => {
      for (let frame = 0; frame < 6; frame++) await new Promise(done => requestAnimationFrame(done));
      return {
        posted,
        retry: !!document.querySelector('.session-retry'),
        // The bundled renderer inlines its copy, so look only at rendered notices.
        error: [...document.querySelectorAll('.session-notice')].some(notice => notice.textContent.includes('Live updates overflowed')),
        errors: rendererErrors
      };
    })()`);
    expect(after).toMatchObject({ retry: false, error: false, errors: [] });
    expect(after.posted).toContain('session:resync');
  }, 60000);

  it('never auto-follows in card detail, where the host timeline owns scrolling', async () => {
    await browser('set', 'viewport', '800', '600');
    await browser('open', `${origin}/compact`);
    await browser('wait', '--text', 'Answer 30');
    const opening = await appendThenRead(null);
    expect(opening).toMatchObject({ status: null, viewport: false, top: 0, errors: [] });
    const after = await appendThenRead(MAIN, [prompt('Question 31', 'p30'), reply('Answer 31', 'r30')]);
    await browser('wait', '--text', 'Answer 31');
    expect(after).toMatchObject({ status: null, viewport: false, top: 0, errors: [] });
  }, 60000);
});

/**
 * Mounts the production Claude HTML entry in card-detail mode under real Chromium layout and
 * observes the layout bridge exactly as a host does: from posted messages only.
 * @summary Compact session layout reports measured content and forwards outer scrolling
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorKey } from '../../src/streams/lib/session/layout-bridge';
import { call, result } from '../fixtures/claude-projection';
import { lines, prompt, reply, SESSION_ID } from '../fixtures/claude-session-members';

/** Layout message as the in-page host recorded it. */
interface Sent {
  type: string;
  revision?: number;
  height?: number;
  command?: { kind: string; key?: string; deltaY?: number };
}

// Uses the real Bun HTML build and agent-browser; the page is its own parent, so an in-page host
// answers subscriptions, issues the handshake and records every renderer layout message.
describe('Compact session layout bridge', () => {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const session = `session-compact-layout-${process.pid}`;
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
   * Recorded layout messages after two animation frames, so scheduled reports have flushed.
   * @returns Every layout message posted so far, in order.
   */
  const sent = (): Promise<Sent[]> =>
    evaluate<Sent[]>(
      `new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(window.sent))))`
    );

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cards-session-compact-layout-'));
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
    // One native tool call inside the final page gives the reader a disclosure to anchor on.
    const seed = lines(
      Array.from({ length: 40 }, (_, index) => [
        prompt(`Question ${index + 1}`, `p${index}`),
        reply(`Answer ${index + 1}`, `r${index}`),
        ...(index === 34 ? [call('T1'), result('T1', 'tool output')] : [])
      ]).flat()
    );
    server = createServer((_request, response) => {
      const source = { cardId: 'card-1', streamType: 'claude-code-session', relPath: 'main.jsonl' };
      const identity = { cardId: 'card-1', streamType: 'claude-code-session', sessionId: SESSION_ID };
      const init = {
        session: identity,
        generation: 'gen-1',
        revision: 1,
        mode: 'compact',
        descriptor: { session: identity, members: [{ source, role: 'main' }], main: source, validity: 'ready' }
      };
      const authority = {
        generation: 'gen-1',
        source,
        version: { serverEpoch: 'server-1', sourceEpoch: 'source-1' },
        binding: { sessionId: SESSION_ID, role: 'main' }
      };
      const meta = {
        version: 1,
        relPath: 'main.jsonl',
        streamType: 'claude-code-session',
        runtime: 'claude-code',
        sessionId: SESSION_ID,
        role: 'main',
        sourcePath: '/native/main.jsonl',
        startedAt: '2026-01-01T00:00:00.000Z',
        lineCount: seed.length,
        createdAt: '2026-01-01T00:00:00.000Z',
        isActive: false
      };
      const safe = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');
      const host = `window.sent=[];window.host={handshake(token){postMessage({type:'layout:handshake',generation:'gen-1',token},'*')}};addEventListener('message',event=>{const message=event.data;if(typeof message?.type==='string'&&message.type.startsWith('layout:')&&message.type!=='layout:handshake')sent.push(message);if(message?.type!=='source:subscribe')return;postMessage({type:'source:snapshot',...${safe(authority)},requestId:message.requestId,meta:${safe(meta)},lines:${safe(seed)},firstLineNumber:1,totalLineCount:${seed.length}},'*')});`;
      const bootstrap = `<script>window.__STREAM_INIT__=${safe(init)};window.rendererErrors=[];addEventListener('error',event=>rendererErrors.push(event.message));${host}</script>`;
      response.setHeader('Content-Type', 'text/html');
      response.end(html.replace('<head>', `<head>${bootstrap}`));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Compact layout test server did not bind a TCP port');
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

  it('reports measured content height with monotonic revisions and forwards outer scrolling', async () => {
    await browser('set', 'viewport', '800', '600');
    await browser('open', `${origin}/`);
    await browser('wait', '--text', 'Answer 40');
    await evaluate(`window.host.handshake('token-1'); true`);
    const initial = await sent();
    expect(initial.slice(0, 2).map((message) => message.type)).toEqual(['layout:ready', 'layout:size']);
    const geometry = await evaluate<{
      content: number;
      viewport: number;
      innerScroll: string[];
      errors: string[];
    }>(`(() => ({
      content: Math.ceil(document.querySelector('#stream-root').firstElementChild.getBoundingClientRect().height),
      viewport: innerHeight,
      innerScroll: [...document.querySelectorAll('*')].filter(element => {
        const style = getComputedStyle(element);
        return /(auto|scroll|hidden)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1 && element !== document.documentElement && element !== document.body && element.id !== 'stream-root';
      }).map(element => element.className),
      errors: rendererErrors
    }))()`);
    const firstSize = initial.filter((message) => message.type === 'layout:size').at(-1)!;
    expect(firstSize.height).toBe(geometry.content);
    expect(firstSize.height).toBeLessThan(geometry.viewport);
    expect(geometry.innerScroll).toEqual([]);
    expect(geometry.errors).toEqual([]);

    // The host resizing the iframe viewport never feeds back into the reported height.
    await browser('set', 'viewport', '800', '250');
    const resized = await sent();
    expect(resized.filter((message) => message.type === 'layout:size')).toEqual(
      initial.filter((message) => message.type === 'layout:size')
    );

    await browser('find', 'role', 'button', 'click', '--name', 'Show conversation');
    await browser('wait', '--text', 'Question 31');
    const expanded = await sent();
    const sizes = expanded.filter((message) => message.type === 'layout:size');
    const revisions = sizes.map((message) => message.revision!);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(sizes.at(-1)!.height).toBeGreaterThan(firstSize.height!);
    // Every anchor precedes the size of its own revision.
    expanded.forEach((message, index) => {
      if (message.type !== 'layout:anchor') return;
      const size = expanded.findIndex((other) => other.type === 'layout:size' && other.revision === message.revision);
      expect(size).toBeGreaterThan(index);
    });

    const before = expanded.length;
    await browser('mouse', 'move', '200', '100');
    await browser('mouse', 'wheel', '120');
    await evaluate(`document.activeElement?.blur(); true`);
    await browser('press', 'PageDown');
    const scrolled = (await sent()).slice(before).filter((message) => message.type === 'layout:scroll');
    expect(scrolled.map((message) => message.command)).toEqual([
      { kind: 'delta', deltaY: 120 },
      { kind: 'key', key: 'page-down' }
    ]);
    expect(await evaluate<number>('scrollY')).toBe(0);
  }, 30000);

  it('keeps an activated disclosure control as the anchor when earlier rows load above it', async () => {
    await browser('set', 'viewport', '800', '4000');
    await browser('open', `${origin}/`);
    await browser('wait', '--text', 'Answer 40');
    await evaluate(`window.host.handshake('token-2'); true`);
    await browser('find', 'role', 'button', 'click', '--name', 'Show conversation');
    await browser('wait', '--text', 'Question 31');
    await browser('find', 'role', 'button', 'click', '--name', 'Bash');
    await browser('wait', '--text', 'tool output');
    const before = (await sent()).length;
    const control = await evaluate<{ id: string; top: number }>(`(() => {
      const disclosure = [...document.querySelectorAll('[data-session-disclosure]')].find(element => element.textContent.includes('tool output'));
      return {id: disclosure.getAttribute('data-session-disclosure'), top: disclosure.querySelector(':scope > .session-disclosure-button').getBoundingClientRect().top};
    })()`);
    await browser('find', 'role', 'button', 'click', '--name', 'Show earlier');
    await browser('wait', '--text', 'Question 22');
    const after = (await sent()).slice(before);
    const moved = await evaluate<number>(`(() => {
      const disclosure = document.querySelector('[data-session-disclosure="' + CSS.escape(${JSON.stringify(control.id)}) + '"]');
      return disclosure.querySelector(':scope > .session-disclosure-button').getBoundingClientRect().top;
    })()`);
    const anchors = after.filter((message) => message.type === 'layout:anchor') as Array<
      Sent & { key: string; delta: number }
    >;
    expect(anchors.map((message) => message.key)).toEqual([anchorKey(control.id)]);
    expect(anchors[0]!.delta).toBe(Math.round(moved - control.top));
    expect(anchors[0]!.delta).toBeGreaterThan(0);
    const size = after.findIndex(
      (message) => message.type === 'layout:size' && message.revision === anchors[0]!.revision
    );
    expect(size).toBeGreaterThan(after.indexOf(anchors[0]!));
  }, 30000);
});

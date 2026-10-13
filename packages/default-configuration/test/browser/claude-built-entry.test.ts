/**
 * Mounts the production Claude HTML entry with native host bootstrap and append messages.
 * The committed lifecycle fixture guards the bundle consumed by expanded stream panels,
 * including the distinction between tool output and supplemental instructions.
 * @summary Built Claude entry preserves the full-lifecycle T9 result
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Uses the real Bun HTML build and agent-browser, without replacing React, the SDK store,
// projection or presentation. The isolated output cannot overwrite a workspace publication.
describe('Claude production built entry', () => {
  const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const session = `claude-built-entry-${process.pid}`;
  let directory: string;
  let server: Server;
  let origin: string;
  let lines: string[];

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
    directory = await mkdtemp(join(tmpdir(), 'cards-claude-built-entry-'));
    // Only the input is linked. The unmodified production build writes into temporary dist/.
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
    lines = (await readFile(join(packageDirectory, 'test/fixtures/cc-thread-converter/full-lifecycle.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n');
    server = createServer((request, response) => {
      const seed = request.url === '/live' ? lines.slice(0, 34) : lines;
      const init = {
        primary: 'fixture.jsonl',
        mode: 'expanded',
        availableFiles: ['fixture.jsonl'],
        files: { 'fixture.jsonl': { lines: seed, meta: { lineCount: seed.length, isActive: request.url === '/live' } } }
      };
      const bootstrap = `<script>window.__STREAM_INIT__=${JSON.stringify(init).replaceAll('<', '\\u003c')};window.rendererErrors=[];addEventListener('error',event=>rendererErrors.push(event.message));</script>`;
      response.setHeader('Content-Type', 'text/html');
      response.end(html.replace('<head>', `<head>${bootstrap}`));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Built-entry test server did not bind a TCP port');
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

  it.each(['snapshot', 'live'])('keeps T9 native output under Result through the %s entry path', async (mode) => {
    await browser('open', `${origin}/${mode}`);
    await browser('wait', '--text', mode === 'live' ? 'Skill · pending' : 'Skill · complete');
    await browser(
      'find',
      'role',
      'button',
      'click',
      '--name',
      mode === 'live' ? 'Skill · pending' : 'Skill · complete'
    );
    if (mode === 'live') {
      const messages = lines
        .slice(34)
        .map((line, index) => ({ type: 'stream:line', filename: 'fixture.jsonl', lineNumber: index + 35, line }));
      await evaluate(`${JSON.stringify(messages)}.forEach(message => window.postMessage(message, '*')); true`);
      await browser('wait', '--text', 'skill ran');
    }
    const result = await evaluate<{
      nativeId: string | null;
      result: string | null;
      supplemental: string | null;
      open: string | null;
      nativeViewport: boolean;
      errors: string[];
    }>(`(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Skill · complete');
      const tool = button?.closest('[data-session-disclosure]');
      const body = tool?.querySelector(':scope > .session-disclosure-body');
      const region = label => [...(body?.children ?? [])].find(element => element.classList.contains('session-label') && element.textContent === label)?.nextElementSibling?.textContent ?? null;
      return {nativeId: tool ? JSON.parse(tool.getAttribute('data-session-disclosure')).at(-1) : null, result: region('Result'), supplemental: region('Supplemental content'), open: button?.getAttribute('aria-expanded') ?? null, nativeViewport: !!document.querySelector('.session-viewport'), errors: rendererErrors};
    })()`);
    expect(result).toEqual({
      nativeId: 'T9',
      result: 'skill ran',
      supplemental: 'orphaned instructions\n\nfull skill instructions',
      open: 'true',
      nativeViewport: true,
      errors: []
    });
    expect(result.result).not.toContain('full skill instructions');
  }, 15000);
});

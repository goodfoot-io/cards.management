/**
 * Real-filesystem and real-process tests for detached-child output capture.
 * @summary Verifies detached-child combined-output capture behavior.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DETACHED_CHILD_LOG_FILENAME,
  DETACHED_CHILD_RECORD_PREFIX,
  type DetachedChildOutputCapture,
  prepareDetachedChildOutputCapture,
  resolveDetachedChildOutputPath
} from '../../src/config/detached-child-output.js';

const ENV_KEYS = ['CARDS_DETACHED_STDERR_LOG_FILE', 'CARDS_HOOKS_LOG_FILE', 'CARDS_LOG_DIR', 'REPO_ROOT'] as const;

interface AttributionRecord {
  phase: 'spawn' | 'started';
  correlationId: string;
  cardId: string;
  sessionId: string | null;
  childKind: string;
  pid?: number;
  timestamp: string;
}

function requireCapture(result: ReturnType<typeof prepareDetachedChildOutputCapture>): DetachedChildOutputCapture {
  expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

function readRecords(filePath: string): AttributionRecord[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(DETACHED_CHILD_RECORD_PREFIX))
    .map((line) => JSON.parse(line.slice(DETACHED_CHILD_RECORD_PREFIX.length)) as AttributionRecord);
}

async function runDetached(args: string[], capture: DetachedChildOutputCapture): Promise<number | null> {
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', capture.fd, capture.fd]
  });
  capture.close();
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

describe('detached-child output capture', () => {
  let tempDir: string;
  let savedCwd: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-detached-output-'));
    savedCwd = process.cwd();
    for (const key of ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) savedEnv[key] = value;
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.chdir(savedCwd);
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('uses the exact-file tier above every other source', () => {
    const exact = path.join(tempDir, 'exact.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = exact;
    process.env['CARDS_LOG_DIR'] = path.join(tempDir, 'shared');
    process.env['REPO_ROOT'] = path.join(tempDir, 'repo');

    expect(resolveDetachedChildOutputPath()).toEqual({ ok: true, path: exact });
  });

  it('uses the shared log directory when the exact-file tier is empty', () => {
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = '';
    process.env['CARDS_LOG_DIR'] = tempDir;
    process.env['REPO_ROOT'] = path.join(tempDir, 'repo');

    expect(resolveDetachedChildOutputPath()).toEqual({
      ok: true,
      path: path.join(tempDir, DETACHED_CHILD_LOG_FILENAME)
    });
  });

  it('uses the main-repository default and ignores CARDS_HOOKS_LOG_FILE', () => {
    process.env['CARDS_HOOKS_LOG_FILE'] = path.join(tempDir, 'structured.jsonl');
    process.env['REPO_ROOT'] = tempDir;

    expect(resolveDetachedChildOutputPath()).toEqual({
      ok: true,
      path: path.join(tempDir, '.cards', 'logs', DETACHED_CHILD_LOG_FILENAME)
    });
  });

  it('retains a safe reason when the main repository cannot resolve', () => {
    process.chdir(tempDir);

    const result = resolveDetachedChildOutputPath();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('detached-child log path is disabled');
      expect(result.reason).not.toMatch(/[\r\n]/u);
    }
  });

  it('creates parent directories and a new owner-only append file', () => {
    const logPath = path.join(tempDir, 'nested', 'deep', 'capture.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;

    const capture = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'main-456',
        sessionId: 'session-1',
        childKind: 'watcher'
      })
    );
    capture.close();

    expect(fs.existsSync(logPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    }
  });

  it('appends stable single-line spawn records without replacing existing output', () => {
    const logPath = path.join(tempDir, 'capture.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;
    fs.writeFileSync(logPath, 'existing raw output\n', 'utf8');

    const first = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'card\r\n"\\雪',
        sessionId: null,
        childKind: 'wrapper'
      })
    );
    first.close();
    const second = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'second',
        sessionId: 'session',
        childKind: 'watcher'
      })
    );
    second.close();

    const content = fs.readFileSync(logPath, 'utf8');
    expect(content.startsWith('existing raw output\n')).toBe(true);
    expect(content.split('\n')).toHaveLength(4);
    const records = readRecords(logPath);
    expect(records).toHaveLength(2);
    expect(Object.keys(records[0]!)).toEqual([
      'phase',
      'correlationId',
      'cardId',
      'sessionId',
      'childKind',
      'timestamp'
    ]);
    expect(records[0]).toMatchObject({
      phase: 'spawn',
      correlationId: first.correlationId,
      cardId: 'card\r\n"\\雪',
      sessionId: null,
      childKind: 'wrapper'
    });
    expect(records[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('bounds every supplied identity by Unicode code points with a marker', () => {
    const logPath = path.join(tempDir, 'capture.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;
    const oversized = '🧪'.repeat(600);

    const capture = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: oversized,
        sessionId: oversized,
        childKind: oversized
      })
    );
    capture.close();

    const record = readRecords(logPath)[0]!;
    for (const value of [record.cardId, record.sessionId!, record.childKind]) {
      expect(Array.from(value)).toHaveLength(512);
      expect(value.endsWith('...[truncated]')).toBe(true);
    }
    expect(capture.preloadArg.length).toBeLessThan(25_000);
  });

  it('returns an open failure and leaves no descriptor to close', () => {
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = tempDir;

    const result = prepareDetachedChildOutputCapture({
      cardId: 'main-456',
      sessionId: null,
      childKind: 'wrapper'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('unable to prepare detached-child output');
      expect(result.reason).not.toMatch(/[\r\n]/u);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a non-regular character device target', () => {
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = '/dev/full';

    const result = prepareDetachedChildOutputCapture({
      cardId: 'main-456',
      sessionId: null,
      childKind: 'wrapper'
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('capture target is not a regular file');
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO target without blocking', () => {
    const fifoPath = path.join(tempDir, 'capture.fifo');
    const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    expect(mkfifo.status, mkfifo.stderr).toBe(0);
    const moduleUrl = new URL('../../src/config/detached-child-output.ts', import.meta.url).href;
    const source =
      `import{prepareDetachedChildOutputCapture as p}from${JSON.stringify(moduleUrl)};` +
      `console.log(JSON.stringify(p({cardId:'main-456',sessionId:null,childKind:'wrapper'})))`;

    const child = spawnSync(process.execPath, ['--import=tsx', '--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: { ...process.env, CARDS_DETACHED_STDERR_LOG_FILE: fifoPath },
      timeout: 2_000
    });

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout) as unknown).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unable to prepare detached-child output')
    });
  });

  it.skipIf(process.platform === 'win32')('reports a short parent attribution write as a preparation failure', () => {
    const logPath = path.join(tempDir, 'size-limited.log');
    fs.writeFileSync(logPath, Buffer.alloc(1_000, 'x'));
    const moduleUrl = new URL('../../src/config/detached-child-output.ts', import.meta.url).href;
    const source =
      `process.on('SIGXFSZ',()=>{});` +
      `const{prepareDetachedChildOutputCapture:p}=await import(${JSON.stringify(moduleUrl)});` +
      `console.log(JSON.stringify(p({cardId:'main-456',sessionId:null,childKind:'wrapper'})))`;

    const child = spawnSync(
      'bash',
      [
        '-c',
        'ulimit -f 1; exec "$@"',
        'short-write-test',
        process.execPath,
        '--import=tsx',
        '--input-type=module',
        '-e',
        source
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CARDS_DETACHED_STDERR_LOG_FILE: logPath },
        timeout: 2_000
      }
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout) as unknown).toMatchObject({
      ok: false,
      reason: expect.stringContaining('short attribution write')
    });
    expect(fs.statSync(logPath).size).toBe(1_024);
  });

  it('closes its descriptor idempotently', () => {
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = path.join(tempDir, 'capture.log');
    const capture = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'main-456',
        sessionId: null,
        childKind: 'wrapper'
      })
    );

    expect(() => {
      capture.close();
      capture.close();
    }).not.toThrow();
    expect(() => fs.writeSync(capture.fd, 'after close')).toThrow();
  });

  it('keeps close fail-open when the descriptor was already closed externally', () => {
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = path.join(tempDir, 'capture.log');
    const capture = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'main-456',
        sessionId: null,
        childKind: 'wrapper'
      })
    );
    fs.closeSync(capture.fd);

    expect(() => {
      capture.close();
      capture.close();
    }).not.toThrow();
  });

  it('attributes a child before an unresolvable main import and preserves the raw error', async () => {
    const logPath = path.join(tempDir, 'capture.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;
    const capture = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'main-456',
        sessionId: 'session-1',
        childKind: 'watcher'
      })
    );

    const exitCode = await runDetached([capture.preloadArg, path.join(tempDir, 'missing-main.mjs')], capture);

    expect(exitCode).not.toBe(0);
    const content = fs.readFileSync(logPath, 'utf8');
    const records = readRecords(logPath);
    expect(records.map(({ phase }) => phase)).toEqual(['spawn', 'started']);
    expect(records[1]).toMatchObject({
      correlationId: capture.correlationId,
      cardId: 'main-456',
      sessionId: 'session-1',
      childKind: 'watcher'
    });
    expect(records[1]!.pid).toEqual(expect.any(Number));
    expect(content.indexOf(DETACHED_CHILD_RECORD_PREFIX)).toBeLessThan(content.indexOf('ERR_MODULE_NOT_FOUND'));
    expect(content).toContain('ERR_MODULE_NOT_FOUND');
  });

  it.skipIf(process.platform === 'win32')(
    'continues into the main module when the child attribution write fails',
    async () => {
      const logPath = path.join(tempDir, 'capture.log');
      const markerPath = path.join(tempDir, 'main-loaded');
      process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;
      const capture = requireCapture(
        prepareDetachedChildOutputCapture({
          cardId: 'main-456',
          sessionId: null,
          childKind: 'wrapper'
        })
      );
      capture.close();
      const fullFd = fs.openSync('/dev/full', fs.constants.O_WRONLY);
      const mainSource = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(markerPath)},'loaded')`;
      const child = spawn(process.execPath, [capture.preloadArg, '--input-type=module', '-e', mainSource], {
        stdio: ['ignore', 'ignore', fullFd]
      });
      fs.closeSync(fullFd);

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(markerPath, 'utf8')).toBe('loaded');
      expect(readRecords(logPath).map(({ phase }) => phase)).toEqual(['spawn']);
    }
  );

  it('retains the parent delimiter when Node rejects a flag before the preload', async () => {
    const logPath = path.join(tempDir, 'capture.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;
    const capture = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'main-456',
        sessionId: null,
        childKind: 'wrapper'
      })
    );

    const exitCode = await runDetached(['--cards-deliberately-invalid-flag', capture.preloadArg, '-e', ''], capture);

    expect(exitCode).not.toBe(0);
    expect(readRecords(logPath).map(({ phase }) => phase)).toEqual(['spawn']);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('bad option');
  });

  it('keeps attribution records intact for concurrent detached writers', async () => {
    const logPath = path.join(tempDir, 'capture.log');
    process.env['CARDS_DETACHED_STDERR_LOG_FILE'] = logPath;
    const first = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'card-one',
        sessionId: null,
        childKind: 'watcher'
      })
    );
    const second = requireCapture(
      prepareDetachedChildOutputCapture({
        cardId: 'card-two',
        sessionId: null,
        childKind: 'wrapper'
      })
    );
    const rawWriter = "import{writeSync}from'node:fs';writeSync(1,'raw stdout\\n');writeSync(2,'raw stderr\\n')";

    const exits = await Promise.all([
      runDetached([first.preloadArg, '--input-type=module', '-e', rawWriter], first),
      runDetached([second.preloadArg, '--input-type=module', '-e', rawWriter], second)
    ]);

    expect(exits).toEqual([0, 0]);
    const records = readRecords(logPath);
    expect(records).toHaveLength(4);
    expect(records.filter(({ phase }) => phase === 'spawn')).toHaveLength(2);
    expect(records.filter(({ phase }) => phase === 'started')).toHaveLength(2);
    expect(new Set(records.map(({ correlationId }) => correlationId))).toEqual(
      new Set([first.correlationId, second.correlationId])
    );
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content.match(/raw stdout/gmu)).toHaveLength(2);
    expect(content.match(/raw stderr/gmu)).toHaveLength(2);
  });
});

/**
 * Spawned watcher integration over authenticated runtime WebSockets.
 * @summary Runtime-native stream-sync watcher binary tests
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRuntimeCredentialFile } from '../../src/client/runtime/credential-file.js';
import type { RuntimeCredentialFile } from '../../src/protocol/index.js';
import { type SessionSyncManifest, serializeManifest } from '../../src/transcript-sync/manifest.js';
import { FakeRuntimeServer } from '../client/runtime/fakeServer.js';
import { TEST_OWNERSHIP, TEST_SCOPE } from '../client/runtime/index.js';

const watcherSource = resolve(import.meta.dirname, '../../src/bin/stream-sync-watcher.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

describe('stream-sync-watcher binary integration', () => {
  let base: string;
  let cardRepoPath: string;
  let sourceDir: string;
  let cardsHome: string;
  let credentialPath: string;
  let sessionId: string;
  let server: FakeRuntimeServer;
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'ssw-runtime-'));
    cardRepoPath = join(base, 'card');
    sourceDir = join(base, 'source');
    cardsHome = join(base, 'cards-home');
    credentialPath = join(base, 'credentials', 'handoff.json');
    sessionId = `session-${Date.now()}`;
    for (const directory of [cardRepoPath, sourceDir, cardsHome, join(base, 'credentials')])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    execFileSync('git', ['init', '-b', 'main'], { cwd: cardRepoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: cardRepoPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: cardRepoPath });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: cardRepoPath });
    server = await FakeRuntimeServer.start();
    writeFileSync(
      join(cardsHome, 'cards-api.json'),
      JSON.stringify({
        host: '127.0.0.1',
        port: server.port,
        accessToken: 'token',
        pid: process.pid,
        startedAt: new Date().toISOString()
      })
    );
    const roles = ['runtime-wrapper', 'agent-handler', 'agent-hook', 'watcher', 'cli'] as const;
    const credential: RuntimeCredentialFile = {
      version: 1,
      requestId: 'req-1',
      execution: { executionId: 'exec-1', launchRequestId: 'req-1' },
      scope: TEST_SCOPE,
      ownership: TEST_OWNERSHIP,
      credentials: roles.map((role, index) => ({
        credentialId: `credential-${index}`,
        requestId: 'req-1',
        executionId: 'exec-1',
        role,
        producerId: role === 'watcher' ? 'watcher-producer' : `${role}-${index}`,
        secret: `secret-${index}`,
        issuedAt: 1
      }))
    };
    writeRuntimeCredentialFile(credentialPath, credential);
  });

  afterEach(async () => {
    if (child?.exitCode === null) child.kill('SIGKILL');
    await server.stop();
    rmSync(base, { recursive: true, force: true });
  });

  function manifest(monitorPid: number): SessionSyncManifest {
    return {
      version: 1,
      sessionId,
      cardId: TEST_SCOPE.cardId,
      runtime: 'claude-code',
      streamType: 'claude-code-session',
      watchRoot: sourceDir,
      sources: [{ pattern: `${sessionId}.jsonl`, role: 'main', mode: 'jsonl-tail' }],
      monitorPid,
      cardRepoPath
    };
  }

  function launch(monitorPid: number): ChildProcess {
    child = spawn(process.execPath, [tsxCli, watcherSource, serializeManifest(manifest(monitorPid))], {
      env: { ...process.env, CARDS_HOME: cardsHome, CARDS_RUNTIME_CREDENTIAL_FILE: credentialPath },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return child;
  }

  async function waitFor(type: string): Promise<void> {
    await vi.waitFor(() => expect(server.received.some((message) => message.type === type)).toBe(true), {
      timeout: 10_000
    });
  }

  async function exit(proc: ChildProcess): Promise<number | null> {
    return new Promise((resolveExit) => proc.once('exit', resolveExit));
  }

  it('accepts stop only after custody and emits one correlated result', async () => {
    writeFileSync(join(sourceDir, `${sessionId}.jsonl`), '{"type":"init"}\n');
    const proc = launch(process.pid);
    await waitFor('watcher.telemetry');
    server.sendWatcherStop('stop-1', sessionId);
    expect(await exit(proc)).toBe(0);
    expect(server.received.filter((message) => message.type === 'execution.commandCustody')).toHaveLength(1);
    expect(server.received.filter((message) => message.type === 'watcher.stopResult')).toHaveLength(1);
    expect(readFileSync(join(cardRepoPath, 'streams', 'claude-code-session', `${sessionId}.jsonl`), 'utf8')).toContain(
      'init'
    );
  }, 60_000);

  it('flush sentinel finalizes and exits cleanly', async () => {
    writeFileSync(join(sourceDir, `${sessionId}.jsonl`), '{"type":"sentinel"}\n');
    const proc = launch(process.pid);
    await waitFor('runtime.register');
    const destination = join(cardRepoPath, 'streams', 'claude-code-session');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, `${sessionId}.flush`), '');
    expect(await exit(proc)).toBe(0);
    expect(readFileSync(join(destination, `${sessionId}.jsonl`), 'utf8')).toContain('sentinel');
  }, 60_000);

  it('live tails a source directory created after startup', async () => {
    rmSync(sourceDir, { recursive: true, force: true });
    const proc = launch(process.pid);
    await waitFor('runtime.register');
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, `${sessionId}.jsonl`), 'line1\n');
    const destination = join(cardRepoPath, 'streams', 'claude-code-session', `${sessionId}.jsonl`);
    await vi.waitFor(() => expect(readFileSync(destination, 'utf8')).toContain('line1'), { timeout: 15_000 });
    server.sendWatcherStop('stop-live', sessionId);
    expect(await exit(proc)).toBe(0);
  }, 60_000);

  it('process death triggers final flush', async () => {
    writeFileSync(join(sourceDir, `${sessionId}.jsonl`), 'dead\n');
    const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const proc = launch(victim.pid!);
    await waitFor('runtime.register');
    victim.kill('SIGKILL');
    expect(await exit(proc)).toBe(0);
    expect(readFileSync(join(cardRepoPath, 'streams', 'claude-code-session', `${sessionId}.jsonl`), 'utf8')).toContain(
      'dead'
    );
  }, 60_000);
});

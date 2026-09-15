/**
 * Authenticated runtime shutdown CLI integration checks.
 * @summary Runtime-native shutdown CLI tests
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRuntimeCredentialFile } from '../../src/client/runtime/credential-file.js';
import type { RuntimeCredentialFile } from '../../src/protocol/index.js';
import { FakeRuntimeServer, type FakeRuntimeServerScript } from '../client/runtime/fakeServer.js';
import { TEST_OWNERSHIP, TEST_SCOPE } from '../client/runtime/index.js';

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

describe('cards shutdown verb', () => {
  let root: string;
  let cardsHome: string;
  let credentialPath: string;
  let sessionId: string;
  let server: FakeRuntimeServer | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cards-shutdown-runtime-'));
    cardsHome = join(root, 'cards-home');
    credentialPath = join(root, 'credentials', 'handoff.json');
    sessionId = `session-${Date.now()}`;
    mkdirSync(cardsHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'credentials'), { mode: 0o700 });
    const roles = ['runtime-wrapper', 'agent-handler', 'agent-hook', 'watcher', 'cli'] as const;
    const execution = { executionId: 'exec-1', launchRequestId: 'req-1' } as const;
    const value: RuntimeCredentialFile = {
      version: 1,
      requestId: execution.launchRequestId,
      execution,
      scope: TEST_SCOPE,
      ownership: TEST_OWNERSHIP,
      credentials: roles.map((role, index) => ({
        credentialId: `credential-${index}`,
        requestId: execution.launchRequestId,
        executionId: execution.executionId,
        role,
        producerId: `${role}-1`,
        secret: `secret-${index}`,
        issuedAt: 1
      }))
    };
    writeRuntimeCredentialFile(credentialPath, value);
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<{ stderr: string; status: number }> {
    const child = spawn(process.execPath, [tsxCli, 'src/bin/cards.ts', 'test-card', 'shutdown', ...args], {
      cwd: join(import.meta.dirname, '..', '..'),
      env: {
        ...process.env,
        CARDS_HOME: cardsHome,
        CARDS_RUNTIME_CREDENTIAL_FILE: credentialPath,
        CARDS_SESSION_ID: sessionId
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const status = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
    return { stderr, status };
  }

  async function startRuntime(script: FakeRuntimeServerScript = {}): Promise<FakeRuntimeServer> {
    server = await FakeRuntimeServer.start(script);
    writeFileSync(
      join(cardsHome, 'cards-api.json'),
      JSON.stringify({
        host: '127.0.0.1',
        port: server.port,
        accessToken: 'access-token',
        pid: process.pid,
        startedAt: new Date().toISOString()
      })
    );
    return server;
  }

  it('exits successfully only after durable acceptance and persists no socket address', async () => {
    await startRuntime();
    expect(await runCli(['--outcome', 'blocked', '--message', 'waiting'])).toEqual({ stderr: '', status: 0 });
    const request = server?.received.find((item) => item.type === 'execution.shutdownRequest');
    expect(request).toMatchObject({
      requestId: expect.any(String),
      messageId: expect.any(String),
      execution: { executionId: 'exec-1' },
      producer: { role: 'cli', producerId: 'cli-1' },
      payload: { outcome: 'blocked', message: 'waiting' }
    });
    const markerPath = join(cardsHome, 'card-repo-commits', `${encodeURIComponent(sessionId)}.shutdown-request.json`);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({ requestId: request?.requestId, messageId: request?.messageId, outcome: 'blocked' });
    expect(marker).not.toHaveProperty('socketPath');
  });

  it('reuses stable ids after an uncertain short-lived attempt', async () => {
    expect((await runCli([])).status).not.toBe(0);
    const markerPath = join(cardsHome, 'card-repo-commits', `${encodeURIComponent(sessionId)}.shutdown-request.json`);
    const initial = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    expect((await runCli([])).status).not.toBe(0);
    const replay = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    expect(replay).toMatchObject({ requestId: initial['requestId'], messageId: initial['messageId'] });
  });

  it('fails closed without runtime while retaining the retry id', async () => {
    const result = await runCli([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('runtime unavailable');
    const markerPath = join(cardsHome, 'card-repo-commits', `${encodeURIComponent(sessionId)}.shutdown-request.json`);
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ requestId: expect.any(String) });
  });

  it('rejects invalid outcomes before creating pending state', async () => {
    const result = await runCli(['--outcome', 'maybe']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid --outcome');
  });

  it('names the failing hop when the connection closes before registration', async () => {
    await startRuntime({ closeBeforeRegistration: true });
    const result = await runCli([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the connection closed before registration');
  });

  it('names the refusal reason when registration is refused', async () => {
    await startRuntime({ registration: { status: 'refused', reason: 'stale-generation' } });
    const result = await runCli([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('stale-generation');
  });
});

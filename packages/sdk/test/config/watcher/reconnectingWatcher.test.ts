/**
 * Runtime-native watcher producer integration checks.
 * @summary Authenticated reconnecting watcher tests
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRuntimeCredentialFile } from '../../../src/client/runtime/credential-file.js';
import { createReconnectingWatcher } from '../../../src/config/watcher/reconnectingWatcher.js';
import type { RuntimeCredentialFile } from '../../../src/protocol/index.js';
import { FakeRuntimeServer } from '../../client/runtime/fakeServer.js';
import { TEST_OWNERSHIP, TEST_SCOPE } from '../../client/runtime/index.js';

describe('reconnecting runtime watcher', () => {
  let root: string;
  let server: FakeRuntimeServer;
  const previous = { ...process.env };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'runtime-watcher-'));
    const cardsHome = join(root, 'cards-home');
    const credentialDir = join(root, 'credentials');
    mkdirSync(cardsHome, { mode: 0o700 });
    mkdirSync(credentialDir, { mode: 0o700 });
    server = await FakeRuntimeServer.start();
    writeFileSync(
      join(cardsHome, 'cards-api.json'),
      JSON.stringify({
        host: '127.0.0.1',
        port: server.port,
        accessToken: 'token',
        pid: 1,
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
    const credentialPath = join(credentialDir, 'handoff.json');
    writeRuntimeCredentialFile(credentialPath, credential);
    process.env['CARDS_HOME'] = cardsHome;
    process.env['CARDS_RUNTIME_CREDENTIAL_FILE'] = credentialPath;
  });

  afterEach(async () => {
    process.env = { ...previous };
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('sends health and logs as disposable authenticated telemetry', async () => {
    const handle = await createReconnectingWatcher({ watcherId: 'watcher-1', cardId: TEST_SCOPE.cardId, metadata: {} });
    handle.ctx.emit({ type: 'watching', data: null });
    handle.ctx.logger.info('watching now');
    await vi.waitFor(() => {
      expect(server.received.some((message) => message.type === 'watcher.telemetry')).toBe(true);
      expect(server.received.some((message) => message.type === 'runtime.log')).toBe(true);
    });
    handle.shutdown();
  });

  it('takes command custody before emitting one correlated durable stop result', async () => {
    const handle = await createReconnectingWatcher({ watcherId: 'watcher-1', cardId: TEST_SCOPE.cardId, metadata: {} });
    const stop = vi.fn(async () => undefined);
    handle.ctx.onControl('stop', stop);
    server.sendWatcherStop('stop-command-1', 'watcher-1');
    await vi.waitFor(() =>
      expect(server.received.some((message) => message.type === 'execution.commandCustody')).toBe(true)
    );
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await handle.waitForStop();
    expect(stop).toHaveBeenCalledOnce();
    const messages = server.received.filter(
      (message) => message.type === 'execution.commandCustody' || message.type === 'watcher.stopResult'
    );
    expect(messages.map((message) => message.type)).toEqual(['execution.commandCustody', 'watcher.stopResult']);
    expect(messages[1]).toMatchObject({
      messageId: 'stop-command-1:watcher:stop-result',
      causationId: 'stop-command-1',
      payload: { watcherId: 'watcher-1', disposition: 'stopped' }
    });
    handle.shutdown();
  });
});

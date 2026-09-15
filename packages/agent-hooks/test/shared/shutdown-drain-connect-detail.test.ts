/**
 * The agent-hook shutdown drain must surface the runtime client's connect
 * diagnostic instead of collapsing every failed connect to a bare status word.
 * @summary Shutdown drain connect diagnostics
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntimeCredentialFile } from '@cards.management/sdk/client/runtime';
import type { RuntimeCredentialFile } from '@cards.management/sdk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { deliverShutdownReadiness } from '../../src/shared/shutdown-drain.js';

describe('deliverShutdownReadiness connect diagnostics', () => {
  let root: string;
  let discoveryPath: string;
  let credentialPath: string;
  let server: WebSocketServer | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shutdown-drain-detail-'));
    discoveryPath = join(root, 'cards-api.json');
    credentialPath = join(root, 'credentials', 'handoff.json');
    mkdirSync(join(root, 'credentials'), { mode: 0o700 });
    const execution = { executionId: 'exec-1', launchRequestId: 'req-1' } as const;
    const roles = ['runtime-wrapper', 'agent-handler', 'agent-hook', 'watcher', 'cli'] as const;
    const value: RuntimeCredentialFile = {
      version: 1,
      requestId: execution.launchRequestId,
      execution,
      scope: { repositoryId: 'repo-1', workspacePath: '/workspace', cardId: 'card-1' },
      ownership: { ownerId: 'owner-1', generation: 1 },
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
    process.env['CARDS_RUNTIME_CREDENTIAL_FILE'] = credentialPath;
    process.env['CARDS_HOME'] = join(root, 'cards-home');
  });

  afterEach(async () => {
    delete process.env['CARDS_RUNTIME_CREDENTIAL_FILE'];
    delete process.env['CARDS_HOME'];
    delete process.env['CARDS_DISCOVERY_PATH'];
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reports why the connection failed when the socket closes before registration', async () => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP address');
    server.on('connection', (socket: WsSocket) => {
      socket.on('message', (raw: Buffer) => {
        const type = (JSON.parse(String(raw)) as { type?: string }).type;
        if (type === 'runtime.register' || type === 'runtime.resume') socket.terminate();
      });
    });
    writeFileSync(
      discoveryPath,
      JSON.stringify({ host: '127.0.0.1', port: address.port, accessToken: 'access-token' })
    );
    process.env['CARDS_DISCOVERY_PATH'] = discoveryPath;

    let message = '';
    try {
      await deliverShutdownReadiness('ses-1', {
        version: 1,
        requestId: 'req-1',
        messageId: 'msg-1',
        outcome: 'success'
      });
      expect.unreachable('delivery must not succeed against a socket that closes before registration');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('the connection closed before registration');
  });
});

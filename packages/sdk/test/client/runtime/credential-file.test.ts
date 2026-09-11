/**
 * Contract checks for protected runtime credential handoff and role selection.
 * @summary Runtime credential-file contract tests
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadRuntimeCredential,
  readRuntimeCredentialFile,
  writeRuntimeCredentialFile
} from '../../../src/client/runtime/index.js';
import { CARDS_ENV_VARS, getRuntimeCredentialFilePath } from '../../../src/config/env.js';
import type { RuntimeCredentialFile } from '../../../src/protocol/index.js';

const FILE: RuntimeCredentialFile = {
  version: 1,
  requestId: 'request-1',
  execution: { executionId: 'execution-1', launchRequestId: 'request-1' },
  scope: { repositoryId: 'github.com/cards/test', workspacePath: '/workspace', cardId: 'main-672' },
  credentials: [
    {
      credentialId: 'wrapper-credential',
      requestId: 'request-1',
      executionId: 'execution-1',
      role: 'runtime-wrapper',
      producerId: 'wrapper-1',
      secret: 'wrapper-secret',
      issuedAt: 1
    },
    {
      credentialId: 'agent-credential',
      requestId: 'request-1',
      executionId: 'execution-1',
      role: 'agent-handler',
      producerId: 'agent-1',
      secret: 'agent-secret',
      issuedAt: 1
    },
    {
      credentialId: 'hook-credential',
      requestId: 'request-1',
      executionId: 'execution-1',
      role: 'agent-hook',
      producerId: 'hook-1',
      secret: 'hook-secret',
      issuedAt: 1
    }
  ]
};

describe('runtime credential file', () => {
  let directory: string;
  let credentialPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cards-runtime-credential-'));
    credentialPath = join(directory, 'credential.json');
  });

  afterEach(async () => {
    delete process.env[CARDS_ENV_VARS.RUNTIME_CREDENTIAL_FILE];
    await rm(directory, { recursive: true, force: true });
  });

  it('atomically writes a strict owner-only credential file and reads it back', async () => {
    writeRuntimeCredentialFile(credentialPath, FILE);

    expect(JSON.parse(readFileSync(credentialPath, 'utf8'))).toEqual(FILE);
    if (process.platform !== 'win32') expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(readRuntimeCredentialFile(credentialPath)).toEqual(FILE);
  });

  it('loads only the explicitly requested role through the path-only environment key', () => {
    writeRuntimeCredentialFile(credentialPath, FILE);
    process.env[CARDS_ENV_VARS.RUNTIME_CREDENTIAL_FILE] = credentialPath;

    expect(getRuntimeCredentialFilePath()).toBe(credentialPath);
    expect(loadRuntimeCredential('agent-handler')).toEqual({
      execution: FILE.execution,
      scope: FILE.scope,
      credential: FILE.credentials[1]
    });
    expect(Object.values(process.env)).not.toContain('agent-secret');
  });

  it('rejects files accessible by group or other users where POSIX modes are supported', async () => {
    if (process.platform === 'win32') return;
    writeFileSync(credentialPath, JSON.stringify(FILE), { mode: 0o600 });
    await chmod(credentialPath, 0o640);

    expect(() => readRuntimeCredentialFile(credentialPath)).toThrow(/permissions/i);
  });

  it('rejects symbolic links instead of following a credential path through another inode', () => {
    const target = join(directory, 'target.json');
    writeFileSync(target, JSON.stringify(FILE), { mode: 0o600 });
    symlinkSync(target, credentialPath);

    expect(() => readRuntimeCredentialFile(credentialPath)).toThrow(/symbolic link/i);
    expect(() => writeRuntimeCredentialFile(credentialPath, FILE)).toThrow(/symbolic link|exist/i);
  });

  it('rejects permissive or symbolic-link parent directories', async () => {
    if (process.platform !== 'win32') {
      await chmod(directory, 0o755);
      expect(() => writeRuntimeCredentialFile(credentialPath, FILE)).toThrow(/directory.*permissions/i);
      await chmod(directory, 0o700);
    }

    const realParent = join(directory, 'real');
    const linkedParent = join(directory, 'linked');
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent);
    expect(() => writeRuntimeCredentialFile(join(linkedParent, 'credential.json'), FILE)).toThrow(/symbolic link/i);
  });

  it('rejects mismatched request and execution identity bindings', () => {
    writeFileSync(credentialPath, JSON.stringify({ ...FILE, requestId: 'different-request' }), { mode: 0o600 });

    expect(() => readRuntimeCredentialFile(credentialPath)).toThrow(/invalid runtime credential file/i);
  });

  it('rejects duplicate, missing, and non-child role credentials', () => {
    writeFileSync(
      credentialPath,
      JSON.stringify({ ...FILE, credentials: [FILE.credentials[0], FILE.credentials[0]] }),
      { mode: 0o600 }
    );
    expect(() => readRuntimeCredentialFile(credentialPath)).toThrow(/invalid runtime credential file/i);

    writeFileSync(
      credentialPath,
      JSON.stringify({
        ...FILE,
        credentials: [...FILE.credentials.slice(0, 2), { ...FILE.credentials[2], role: 'extension-dispatcher' }]
      }),
      { mode: 0o600 }
    );
    expect(() => readRuntimeCredentialFile(credentialPath)).toThrow(/invalid runtime credential file/i);
  });

  it('rejects a non-regular credential path before reading it', () => {
    mkdirSync(credentialPath, { mode: 0o700 });
    expect(() => readRuntimeCredentialFile(credentialPath)).toThrow(/regular file/i);
  });
});

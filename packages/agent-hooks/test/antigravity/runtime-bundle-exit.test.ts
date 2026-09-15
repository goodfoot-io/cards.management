/**
 * Process-lifecycle coverage for the compiled Antigravity runtime bundles.
 *
 * The leak signature from card main-707: every `PreInvocation` invocation left
 * one `node bin/runtime-pre-invocation.mjs` process behind, reparented to init,
 * idle at 0% CPU, surviving SIGTERM — hundreds of them until the box ran out
 * of memory. The defect lives in the seam the handler tests stub out
 * (`workAuthority`) and the compiled-output tests bypass (inert foreign
 * classification): a real Cards action session whose admission opens a real
 * runtime connection.
 *
 * These tests run the real compiled bundle end-to-end against a standalone
 * loopback WebSocket server speaking the runtime protocol: a valid Cards
 * action environment, a minted runtime credential file, a discovery document,
 * and a valid invocation input. The handler deterministically completes
 * admission and then fails closed at watcher setup (the extension path does
 * not exist, so no watcher can spawn) — an exit the process must reach on its
 * own. A bundle that finishes its invocation and then lingers, holding open
 * whatever its work opened, is the leak this suite exists to catch.
 *
 * @summary Compiled runtime bundles must terminate after their invocation
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeCredentialFile } from '@cards.management/sdk/client/runtime';
import type { ChildRuntimeCredentialRole } from '@cards.management/sdk/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const binDir = resolve(packageRoot, '../../antigravity/runtime/bin');
const serverFixture = join(packageRoot, 'test', 'antigravity', 'fixtures', 'runtime-server.mjs');

const SESSION_ID = 'session-707';
const CONVERSATION_ID = 'conv-707';
const EXECUTION_ID = 'exec-707';
const REQUEST_ID = 'req-707';

const tempRoots: string[] = [];
const spawnedServers: Array<{ kill(): void }> = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'antigravity-bundle-exit-'));
  tempRoots.push(root);
  return root;
}

/**
 * Starts the standalone fake runtime server and waits for its port.
 *
 * @returns The server's loopback port and a handle that stops it.
 */
async function startFakeRuntimeServer(): Promise<{ port: number; stop(): void }> {
  const child = spawn(process.execPath, [serverFixture], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawnedServers.push(child);
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /PORT (\d+)\n/.exec(buffered);
      if (match) resolvePort(Number(match[1]));
    });
    child.once('exit', (code) => rejectPort(new Error(`fake runtime server exited early (${String(code)})`)));
  });
  return { port, stop: () => child.kill() };
}

/**
 * Mints a valid runtime credential file carrying every child role, bound to
 * the test execution identity, inside a fresh owner-only directory.
 *
 * @param root - Temporary tree root.
 * @returns The credential file path for `CARDS_RUNTIME_CREDENTIAL_FILE`.
 */
function mintRuntimeCredentialFile(root: string): string {
  const credentialDir = join(root, 'runtime-credentials');
  mkdirSync(credentialDir, { mode: 0o700 });
  chmodSync(credentialDir, 0o700);
  const credentialPath = join(credentialDir, 'credential.json');
  const credential = (role: ChildRuntimeCredentialRole) => ({
    credentialId: `${role}-credential`,
    requestId: REQUEST_ID,
    executionId: EXECUTION_ID,
    role,
    producerId: 'hook-producer',
    secret: 'test-secret',
    issuedAt: 0
  });
  writeRuntimeCredentialFile(credentialPath, {
    version: 1,
    execution: { executionId: EXECUTION_ID, launchRequestId: REQUEST_ID },
    scope: { repositoryId: 'github.com/org/repo', workspacePath: join(root, 'workspace'), cardId: 'main-453' },
    ownership: { ownerId: 'fake-runtime-server', generation: 1 },
    requestId: REQUEST_ID,
    credentials: (
      ['runtime-wrapper', 'agent-handler', 'agent-hook', 'watcher', 'cli'] as ChildRuntimeCredentialRole[]
    ).map(credential)
  });
  return credentialPath;
}

/**
 * Builds the full Cards action environment for one bundle spawn: isolated
 * homes, a valid action envelope (the classification a real Cards launch
 * exports), a discovery document pointing at the fake runtime server, and a
 * minted credential handoff.
 *
 * @param root - Temporary tree root.
 * @param runtimePort - Fake runtime server port.
 * @returns The spawn environment.
 */
function actionEnvironment(root: string, runtimePort: number): Record<string, string> {
  const cardsHome = join(root, 'cards-home');
  const home = join(root, 'home');
  const cardRepoPath = join(root, 'cards', 'main-453');
  mkdirSync(cardsHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  mkdirSync(cardRepoPath, { recursive: true });
  writeFileSync(
    join(cardRepoPath, 'CARD.meta.json'),
    JSON.stringify({ id: 'main-453', title: 'Bundle exit fixture', status: 'active' })
  );
  const discoveryPath = join(cardsHome, 'cards-api.json');
  writeFileSync(
    discoveryPath,
    JSON.stringify({ host: '127.0.0.1', port: runtimePort, accessToken: 'test-access-token' })
  );
  const credentialPath = mintRuntimeCredentialFile(root);
  return {
    HOME: home,
    CARDS_HOME: cardsHome,
    PATH: process.env['PATH'] ?? '',
    CARD_ID: 'main-453',
    ANTIGRAVITY_SESSION_ID: SESSION_ID,
    ACTION_NAME: 'Launch',
    ENVIRONMENT: 'default',
    EXECUTION_MODE: 'background',
    EXIT_WHEN_DONE: 'false',
    CODING_AGENT: 'antigravity-cli',
    CARDS_EXECUTION_ID: EXECUTION_ID,
    CARDS_WORKTREE_DIRECTIVE: JSON.stringify({ kind: 'reuse' }),
    REPO_ROOT: join(root, 'main-repo'),
    CARD_REPO_PATH: cardRepoPath,
    CONFIG_PATH: join(root, 'config'),
    EXTENSION_PATH: join(root, 'extension'),
    MARKETPLACE_PATH: join(root, 'marketplace'),
    WORKSPACE_PATH: join(root, 'workspace'),
    BASE_BRANCH: 'main',
    WORKSPACE_BRANCH: 'cards/main-453/1',
    CARDS_DISCOVERY_PATH: discoveryPath,
    CARDS_RUNTIME_CREDENTIAL_FILE: credentialPath
  };
}

/**
 * Builds the pinned PreInvocation host input for the fixture tree.
 *
 * @param root - Temporary tree root.
 * @returns The stdin document.
 */
function preInvocationInput(root: string): Record<string, unknown> {
  return {
    conversationId: CONVERSATION_ID,
    workspacePaths: [join(root, 'workspace')],
    transcriptPath: join(root, 'home', '.gemini', 'antigravity-cli', 'conversations', `${CONVERSATION_ID}.db`),
    artifactDirectoryPath: join(root, 'artifacts', CONVERSATION_ID),
    modelName: 'gemini-3-pro',
    invocationNum: 0,
    initialNumSteps: 3
  };
}

describe('compiled runtime bundle process lifecycle', () => {
  let root: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    const runtime = await startFakeRuntimeServer();
    root = makeTempRoot();
    env = actionEnvironment(root, runtime.port);
  });

  afterAll(() => {
    for (const server of spawnedServers) server.kill();
    for (const temp of tempRoots) rmSync(temp, { recursive: true, force: true });
  });

  it('the PreInvocation bundle terminates on its own after completing admission', () => {
    const result = spawnSync(process.execPath, [join(binDir, 'runtime-pre-invocation.mjs')], {
      input: `${JSON.stringify(preInvocationInput(root))}\n`,
      env,
      encoding: 'utf8',
      cwd: binDir,
      timeout: 20_000
    });

    const stderr = result.stderr ?? '';
    expect(stderr).toContain('[antigravity-cards-hooks] failure at');
    expect(stderr).not.toContain('work admission failed');
    expect(
      existsSync(
        join(env['CARDS_HOME'] as string, 'antigravity', 'runtime', 'markers', SESSION_ID, `${CONVERSATION_ID}.failure`)
      )
    ).toBe(true);

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('the PostInvocation sibling terminates on its own without any admission', () => {
    const result = spawnSync(process.execPath, [join(binDir, 'runtime-post-invocation.mjs')], {
      input: `${JSON.stringify(preInvocationInput(root))}\n`,
      env,
      encoding: 'utf8',
      cwd: binDir,
      timeout: 20_000
    });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
  });
});

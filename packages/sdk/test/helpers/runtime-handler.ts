/**
 * Runs a real handler process against a real local runtime server: writes the
 * protected credential handoff and the API discovery file the handler reads,
 * spawns a `tsx` script, and reports how it exited.
 * @summary Real handler process harness backed by the fake runtime server
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeRuntimeCredentialFile } from '../../src/client/runtime/index.js';
import type { RuntimeCredentialFile } from '../../src/protocol/index.js';
import { FakeRuntimeServer } from '../client/runtime/fakeServer.js';
import { TEST_OWNERSHIP, TEST_SCOPE } from '../client/runtime/index.js';

/** Absolute path of the SDK sources, for handler scripts to import. */
export const SDK_SOURCE = resolve(__dirname, '../../src');

/** The handoff every harness handler receives, bound to the fake server's `TEST_EXECUTION`. */
export const HANDLER_CREDENTIAL: RuntimeCredentialFile = {
  version: 1,
  requestId: 'req-1',
  execution: { executionId: 'exec-1', launchRequestId: 'req-1' },
  scope: TEST_SCOPE,
  ownership: TEST_OWNERSHIP,
  credentials: [
    {
      credentialId: 'agent-credential',
      requestId: 'req-1',
      executionId: 'exec-1',
      role: 'agent-handler',
      producerId: 'agent-1',
      secret: 'agent-secret',
      issuedAt: 1
    }
  ]
};

/** A started handler process. */
export interface HandlerRun {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** A temp directory, a running fake runtime server, and the env that points a handler at both. */
export interface HandlerHarness {
  readonly dir: string;
  readonly server: FakeRuntimeServer;
  /** Env carrying the credential, discovery and Cards home paths. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Writes `source` as a handler script and spawns it.
   * @param source - Module source; imports resolve against {@link SDK_SOURCE}.
   * @param env - Env merged over the harness env.
   * @returns The process and its exit.
   */
  start(source: string, env?: NodeJS.ProcessEnv): HandlerRun;
  /** Stops the server, ends any live handler it spawned, and removes the directory. */
  dispose(): Promise<void>;
}

/**
 * Starts a fake runtime server and prepares a handler environment for it.
 * @returns A harness whose handlers authenticate to the server as `agent-handler`.
 */
export async function startHandlerHarness(): Promise<HandlerHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'cards-handler-'));
  const protectedDir = join(dir, 'credential');
  mkdirSync(protectedDir, { mode: 0o700 });
  const credentialPath = join(protectedDir, 'credential.json');
  writeRuntimeCredentialFile(credentialPath, HANDLER_CREDENTIAL);
  const server = await FakeRuntimeServer.start();
  const discoveryPath = join(dir, 'cards-api.json');
  writeFileSync(
    discoveryPath,
    JSON.stringify({
      host: '127.0.0.1',
      port: server.port,
      accessToken: 'access-token',
      pid: process.pid,
      startedAt: '2026-10-05T17:40:12.031Z'
    })
  );
  const cardsHome = join(dir, 'home');
  mkdirSync(cardsHome);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARDS_HOOKS_LOG_FILE: join(dir, 'hooks.log'),
    CARDS_RUNTIME_CREDENTIAL_FILE: credentialPath,
    CARDS_DISCOVERY_PATH: discoveryPath,
    CARDS_HOME: cardsHome
  };
  const children: ChildProcess[] = [];
  let scripts = 0;
  return {
    dir,
    server,
    env,
    start(source, extra = {}) {
      const script = join(dir, `handler-${scripts++}.mts`);
      writeFileSync(script, source);
      const child = spawn(process.execPath, ['--import=tsx', script], {
        cwd: dir,
        stdio: 'ignore',
        env: { ...env, ...extra }
      });
      children.push(child);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      );
      return { child, exited };
    },
    async dispose() {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

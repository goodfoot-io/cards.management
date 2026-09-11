/**
 * Real-process coverage for bounded, owned-tree Antigravity termination.
 *
 * Antigravity sessions are launched detached on POSIX into a launcher-owned
 * process group; these checks pin the graceful-then-forced drain the
 * cancellation, shutdown, and timeout paths rely on.
 *
 * @summary Antigravity termination controller behavior
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

type TerminationResult = 'graceful' | 'forced' | 'failed';
type SignalTree = (child: ChildProcess, signal: NodeJS.Signals) => void | Promise<void>;
type TerminationController = {
  terminate(reason: 'cancel' | 'shutdown'): Promise<TerminationResult>;
};

const children = new Set<ChildProcess>();
const descendantPids = new Set<number>();

function launch(source: string, options: { detached?: boolean; stdout?: 'pipe' | 'ignore' } = {}): ChildProcess {
  const child = spawn(process.execPath, ['-e', source], {
    detached: options.detached ?? process.platform !== 'win32',
    stdio: ['ignore', options.stdout ?? 'ignore', 'ignore']
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

async function controller(
  child: ChildProcess,
  options: { gracefulTimeoutMs: number; forceTimeoutMs: number; signalTree?: SignalTree }
): Promise<TerminationController> {
  const { createAntigravityTerminationController } = await import('../src/lib/antigravity-termination.js');
  return createAntigravityTerminationController(child, options);
}

async function waitForOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
    child.once('error', reject);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  children.clear();
  descendantPids.clear();
});

describe('Antigravity termination controller', () => {
  it('reports graceful when the owned process exits after TERM and before the deadline', async () => {
    const child = launch("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1e9)");
    const termination = await controller(child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 });

    await expect(termination.terminate()).resolves.toBe('graceful');
  });

  it('forces a TERM-ignoring process and still resolves within the configured bound', async () => {
    const child = launch(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1e9)",
      {
        stdout: 'pipe'
      }
    );
    await waitForOutput(child);
    const termination = await controller(child, { gracefulTimeoutMs: 50, forceTimeoutMs: 500 });
    const startedAt = Date.now();

    await expect(termination.terminate()).resolves.toBe('forced');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === 'win32')(
    'reaps a surviving descendant in the launcher-owned process group',
    async () => {
      const wrapper = launch(
        `const { spawn } = require('node:child_process');
       const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\\\n'); setInterval(() => {}, 1e9)"],
         { stdio: ['ignore', 'pipe', 'ignore'] });
       process.on('SIGTERM', () => process.exit(0));
       descendant.stdout.once('data', () => process.stdout.write(String(descendant.pid) + '\\n'));
       setInterval(() => {}, 1e9);`,
        { detached: true, stdout: 'pipe' }
      );
      const pidText = await waitForOutput(wrapper);
      const descendantPid = Number(pidText);
      descendantPids.add(descendantPid);
      const termination = await controller(wrapper, { gracefulTimeoutMs: 50, forceTimeoutMs: 500 });

      await expect(termination.terminate()).resolves.toBe('forced');
      await waitForExit(descendantPid);
      expect(isAlive(descendantPid)).toBe(false);
    }
  );

  it('deduplicates concurrent termination requests onto one promise', async () => {
    const child = launch("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1e9)");
    const termination = await controller(child, { gracefulTimeoutMs: 500, forceTimeoutMs: 500 });

    const first = termination.terminate();
    const second = termination.terminate();

    expect(second).toBe(first);
    await expect(first).resolves.toBe('graceful');
  });

  it('reports failed when signalling the owned tree fails', async () => {
    const child = launch('setInterval(() => {}, 1e9)');
    const signalTree: SignalTree = () => {
      throw new Error('injected signal delivery failure');
    };
    const termination = await controller(child, { gracefulTimeoutMs: 50, forceTimeoutMs: 50, signalTree });

    await expect(termination.terminate()).resolves.toBe('failed');
  });
});

/**
 * Observation credits survive bounded results until underlying work settles.
 * @summary Observation credit lifetime and admission tests
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createNodeSessionPlatform,
  createObservationResources,
  type ObservationProbeEvent,
  runBoundedCommand,
  runNodeIdentityProbe,
  type SessionExecFile
} from '../src/process-identity.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error('Timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('bounded observation resources', () => {
  it('keeps read credits until the underlying work settles after its scope closes', async () => {
    const resources = createObservationResources({ maxReads: 2 });
    const scope = resources.createScope({ mode: 'routine' });
    const gate = deferred();
    let started = 0;
    const read = () =>
      scope.read(new AbortController().signal, async () => {
        started++;
        await gate.promise;
      });
    const first = read();
    const second = read();
    await waitUntil(() => started === 2);
    const third = read().catch(() => undefined);
    scope.close();
    await third;
    expect(scope.settled).toBe(false);
    expect(started).toBe(2);
    gate.resolve();
    await Promise.all([first, second]);
    await scope.whenSettled();
    expect(scope.settled).toBe(true);
  });

  it('checks the monotonic deadline before transferring a freed probe credit', async () => {
    const scope = createObservationResources().createScope({ mode: 'routine' });
    const signal = new AbortController().signal;
    const first = await scope.acquireProbe(signal);
    expect(first).not.toBeNull();
    const next = scope.acquireProbe(signal, performance.now() + 5);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    first?.notStarted();
    expect(await next).toBeNull();
    scope.close();
    await scope.whenSettled();
  });

  it('supports the parent fallback partition with four routine credits and no emergency credit', async () => {
    const pool = createObservationResources({ maxRoutineProbes: 4, maxEmergencyProbes: 0 });
    const routine = pool.createScope({ mode: 'routine' });
    const emergency = pool.createScope({ mode: 'emergency' });
    const signal = new AbortController().signal;
    const leases = await Promise.all(Array.from({ length: 4 }, () => routine.acquireProbe(signal)));
    expect(leases.every((lease) => lease !== null)).toBe(true);
    expect(await emergency.acquireProbe(signal, performance.now() + 10)).toBeNull();
    const next = routine.acquireProbe(signal, performance.now() + 1_000);
    leases[0]?.notStarted();
    const nextLease = await next;
    expect(nextLease).not.toBeNull();
    for (const lease of leases.slice(1)) lease?.notStarted();
    nextLease?.notStarted();
    routine.close();
    emergency.close();
    await Promise.all([routine.whenSettled(), emergency.whenSettled()]);
    expect(() => createObservationResources({ maxRoutineProbes: 0, maxEmergencyProbes: 0 })).toThrow(RangeError);
  });

  it('holds a routine probe until native exit while an emergency credit remains available', async () => {
    const events: ObservationProbeEvent[] = [];
    const resources = createObservationResources({ onProbeEvent: (event) => events.push(event) });
    const routine = resources.createScope({ mode: 'routine' });
    const emergency = resources.createScope({ mode: 'emergency' });
    const lease = await routine.acquireProbe(new AbortController().signal);
    expect(lease).not.toBeNull();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      lease?.started(child);
      routine.close();
      expect(routine.settled).toBe(false);
      const emergencyLease = await emergency.acquireProbe(new AbortController().signal);
      expect(emergencyLease).not.toBeNull();
      emergencyLease?.notStarted();
      emergency.close();
      await emergency.whenSettled();
      expect(events.some((event) => event.mode === 'routine' && event.phase === 'started')).toBe(true);
      child.kill('SIGKILL');
      await routine.whenSettled();
      expect(events.some((event) => event.mode === 'routine' && event.phase === 'exited')).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('keeps the credit when a real child reports an IPC error while its PID remains live', async () => {
    const scope = createObservationResources().createScope({ mode: 'routine' });
    const signal = new AbortController().signal;
    const lease = await scope.acquireProbe(signal);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    try {
      lease?.started(child);
      const failed = new Promise<void>((resolve) => child.once('error', () => resolve()));
      child.disconnect();
      child.send({ ignored: true });
      await failed;
      expect(child.pid).toBeDefined();
      expect(scope.settled).toBe(false);
      expect(await scope.acquireProbe(signal, performance.now() + 20)).toBeNull();
      scope.close();
      child.kill('SIGKILL');
      await scope.whenSettled();
      expect(scope.settled).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reserves and reports real OS probes from the bounded command path', async () => {
    const events: ObservationProbeEvent[] = [];
    const scope = createObservationResources({ onProbeEvent: (event) => events.push(event) }).createScope({
      mode: 'routine'
    });
    const result = await runBoundedCommand(process.execPath, ['-e', "process.stdout.write('observed')"], {
      timeoutMs: 2_000,
      scope
    });
    expect(result.stdout).toBe('observed');
    expect(result.exitCode).toBe(0);
    scope.close();
    await scope.whenSettled();
    expect(events.map((event) => event.phase)).toEqual(['started', 'exited']);
    expect(events[0]?.pid).toBe(result.pid);
  });

  it('does not start a bounded command after its observation scope is closed', async () => {
    const scope = createObservationResources().createScope({ mode: 'routine' });
    scope.close();
    const result = await runBoundedCommand(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2_000, scope });
    expect(result.pid).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.outputComplete).toBe(false);
  });

  it('accounts for a real session identity probe in its assignment scope', async () => {
    const events: ObservationProbeEvent[] = [];
    const scope = createObservationResources({ onProbeEvent: (event) => events.push(event) }).createScope({
      mode: 'routine'
    });
    const result = await runNodeIdentityProbe(process.execPath, ['-e', "process.stdout.write('identity')"], 2_000, {
      scope
    });
    expect(result).toMatchObject({ stdout: 'identity', failed: false });
    scope.close();
    await scope.whenSettled();
    expect(events.map((event) => event.phase)).toEqual(['started', 'exited']);
  });

  it('applies the implicit platform scope to native probe lifetimes', async () => {
    const children: ReturnType<typeof spawn>[] = [];
    const exec: SessionExecFile = (_command, _args, _options, callback) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.stdout.write('4200 4100 4100 0xabc S Mon Jan 5 10:00:00 2026\\n'); setInterval(() => {}, 1000)"
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      children.push(child);
      child.stdout?.once('data', (chunk: Buffer) => callback(null, chunk.toString()));
      return child;
    };
    const platform = createNodeSessionPlatform({ platform: 'darwin', execFile: exec });
    try {
      expect(await platform.enumerate()).not.toBe('unknown');
      expect(await platform.enumerate(50)).toBe('unknown');
      expect(children).toHaveLength(1);
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        })
      );
    }
  });

  it('keeps an injected real probe callback tracked after its bounded result', async () => {
    const gate = deferred();
    const scope = createObservationResources().createScope({ mode: 'routine' });
    const exec: SessionExecFile = (command, args, _options, callback) => {
      const child = spawn(command, [...args], { stdio: 'ignore' });
      child.once('close', () => {
        void gate.promise.then(() => callback(null, 'complete'));
      });
      return child;
    };
    const result = await runNodeIdentityProbe(process.execPath, ['-e', ''], 100, { scope, execFile: exec });
    expect(result.failed).toBe(true);
    scope.close();
    expect(scope.settled).toBe(false);
    gate.resolve();
    await scope.whenSettled();
    expect(scope.settled).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')(
    'bounds a 1,000-PID traversal and stops after its timeout while real reads are held',
    async () => {
      const scope = createObservationResources().createScope({ mode: 'routine' });
      const gate = deferred();
      let started = 0;
      let active = 0;
      let peak = 0;
      const platform = createNodeSessionPlatform({
        platform: 'linux',
        scope,
        linuxFiles: {
          async readText(path) {
            if (path.endsWith('/boot_id')) return readFile('/proc/sys/kernel/random/boot_id', 'utf8');
            started++;
            active++;
            peak = Math.max(peak, active);
            try {
              const stat = await readFile('/proc/self/stat', 'utf8');
              await gate.promise;
              return stat;
            } finally {
              active--;
            }
          },
          async readDirectory() {
            return Array.from({ length: 1_000 }, (_, index) => String(index + 2));
          }
        }
      });
      const result = platform.enumerate(1_500);
      try {
        await waitUntil(() => started >= 4);
        expect(started).toBe(4);
        expect(await result).toBe('unknown');
        expect(peak).toBe(4);
        scope.close();
        expect(scope.settled).toBe(false);
      } finally {
        gate.resolve();
        scope.close();
        await scope.whenSettled();
      }
      expect(active).toBe(0);
      expect(started).toBe(4);
    }
  );

  it.skipIf(process.platform !== 'linux')(
    'partitions four worker pools and one fallback pool to twenty reads',
    async () => {
      const gate = deferred();
      let started = 0;
      let active = 0;
      let peak = 0;
      const scopes = Array.from({ length: 5 }, () => createObservationResources().createScope({ mode: 'routine' }));
      const results = scopes.map((scope) =>
        createNodeSessionPlatform({
          platform: 'linux',
          scope,
          linuxFiles: {
            async readText(path) {
              if (path.endsWith('/boot_id')) return readFile('/proc/sys/kernel/random/boot_id', 'utf8');
              started++;
              active++;
              peak = Math.max(peak, active);
              try {
                const stat = await readFile('/proc/self/stat', 'utf8');
                await gate.promise;
                return stat;
              } finally {
                active--;
              }
            },
            async readDirectory() {
              return Array.from({ length: 1_000 }, (_, index) => String(index + 2));
            }
          }
        }).enumerate(2_000)
      );
      try {
        await waitUntil(() => started >= 20);
        expect(started).toBe(20);
        expect(await Promise.all(results)).toEqual(Array(5).fill('unknown'));
        expect(scopes.every((scope) => !scope.settled)).toBe(true);
        expect(peak).toBe(20);
      } finally {
        for (const scope of scopes) scope.close();
        gate.resolve();
        await Promise.all(scopes.map((scope) => scope.whenSettled()));
      }
      expect(started).toBe(20);
      expect(active).toBe(0);
    }
  );
});

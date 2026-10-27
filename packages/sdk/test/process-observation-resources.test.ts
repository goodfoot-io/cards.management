/**
 * Observation credits survive bounded results until underlying work settles.
 * @summary Observation credit lifetime and admission tests
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createNodeSessionPlatform,
  createObservationResources,
  type ObservationProbeEvent
} from '../src/process-identity.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error('Timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('bounded observation resources', () => {
  it.skip('keeps read credits until the underlying work settles after its scope closes', async () => {
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

  it.skip('checks the monotonic deadline before transferring a freed probe credit', async () => {
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

  it.skip('holds a routine probe until native exit while an emergency credit remains available', async () => {
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

  it.skip('bounds a 1,000-PID traversal and stops after its timeout while real reads are held', async () => {
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
    const result = platform.enumerate(100);
    await waitUntil(() => started === 4);
    expect(await result).toBe('unknown');
    expect(started).toBe(4);
    expect(peak).toBe(4);
    scope.close();
    expect(scope.settled).toBe(false);
    gate.resolve();
    await scope.whenSettled();
    expect(active).toBe(0);
    expect(started).toBe(4);
  });
});

/**
 * Stable process identity witnesses shared by all shipped agent launchers.
 * @summary Stable process identity witnesses
 * @module
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityTerminationController } from '../src/lib/antigravity-termination.js';
import { createClaudeTerminationController } from '../src/lib/claude-termination.js';
import { createCodexTerminationController } from '../src/lib/codex-termination.js';
import { createOpencodeTerminationController } from '../src/lib/opencode-termination.js';
import {
  createOwnedTreeTerminator,
  createProcessTreeAuthority,
  type OwnedProcessIdentity,
  type ProcessTreeAuthority
} from '../src/lib/process-tree-termination.js';

const owned: OwnedProcessIdentity = { processId: 42, bootId: 'boot-a', startedAtToken: 'start-a', groupId: 42 };
const recycled: OwnedProcessIdentity = { ...owned, startedAtToken: 'start-b' };
const child = { pid: owned.processId } as ChildProcess;

const factories = [
  [
    'Claude',
    (authority: ProcessTreeAuthority) =>
      createClaudeTerminationController(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 1, authority }).terminate(
        'shutdown'
      )
  ],
  [
    'Codex',
    (authority: ProcessTreeAuthority) =>
      createCodexTerminationController(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 1, authority }).terminate(
        'shutdown'
      )
  ],
  [
    'OpenCode',
    (authority: ProcessTreeAuthority) =>
      createOpencodeTerminationController(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 1, authority }).terminate(
        'shutdown'
      )
  ],
  [
    'Antigravity',
    (authority: ProcessTreeAuthority) =>
      createAntigravityTerminationController(child, { gracefulTimeoutMs: 0, forceTimeoutMs: 1, authority }).terminate()
  ]
] as const;

describe.each(factories)('%s stable process identity', (_name, terminate) => {
  it('fails closed without signalling when the pid now names a recycled process', async () => {
    const identify = vi.fn().mockResolvedValueOnce(owned).mockResolvedValue(recycled);
    const signal = vi.fn(async () => 'sent' as const);
    await expect(terminate({ identify, signal })).resolves.toBe('failed');
    expect(identify).toHaveBeenCalledWith(owned.processId);
    expect(signal).not.toHaveBeenCalled();
  });

  it('signals the matching owned tree exactly once', async () => {
    let alive = true;
    const identify = vi.fn(async () => (alive ? owned : null));
    const signal = vi.fn(async (_identity: OwnedProcessIdentity) => {
      alive = false;
      return 'sent' as const;
    });
    await expect(terminate({ identify, signal })).resolves.toBe('graceful');
    expect(signal).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith(owned, 'SIGTERM');
  });
});

describe.skipIf(process.platform === 'win32')('production process-tree authority', () => {
  const launched: ChildProcess[] = [];
  const grandchildren: number[] = [];

  afterEach(() => {
    for (const pid of [...launched.map((child) => child.pid), ...grandchildren])
      try {
        if (pid !== undefined) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, which is what the test wanted.
      }
    launched.length = 0;
    grandchildren.length = 0;
  });

  /**
   * Launches an agent stand-in that shares this process's group, as provider roots do, with one child of its own.
   * @returns The root and its child's pid.
   */
  async function launchTree(): Promise<{ root: ChildProcess; grandchild: number }> {
    const root = spawn(
      process.execPath,
      [
        '-e',
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 1000);"
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    launched.push(root);
    const grandchild = await new Promise<number>((resolve, reject) => {
      root.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      root.once('exit', () => reject(new Error('tree root exited before reporting its child')));
    });
    grandchildren.push(grandchild);
    return { root, grandchild };
  }

  it('lists the root and its descendants, never the launcher that shares their group', async () => {
    const { root, grandchild } = await launchTree();
    const authority = createProcessTreeAuthority();
    const identity = await authority.identify(root.pid as number);
    expect(identity).not.toBeNull();
    expect(identity?.groupId).toBe((await authority.identify(process.pid))?.groupId);

    const members = await authority.members?.(identity as OwnedProcessIdentity);

    expect(members?.map((member) => member.processId).sort()).toEqual([root.pid, grandchild].sort());
  });

  it('stops the whole tree gracefully and leaves the launcher running', async () => {
    const { root, grandchild } = await launchTree();
    const exited = new Promise((resolve) => root.once('exit', resolve));
    const terminate = createOwnedTreeTerminator(root.pid, { gracefulTimeoutMs: 5_000, forceTimeoutMs: 5_000 });

    await expect(terminate()).resolves.toBe('graceful');

    await exited;
    expect(() => process.kill(grandchild, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});

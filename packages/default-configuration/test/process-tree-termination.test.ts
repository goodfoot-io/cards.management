/**
 * Stable process identity witnesses shared by all shipped agent launchers.
 * @summary Stable process identity witnesses
 * @module
 */
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createAntigravityTerminationController } from '../src/lib/antigravity-termination.js';
import { createClaudeTerminationController } from '../src/lib/claude-termination.js';
import { createCodexTerminationController } from '../src/lib/codex-termination.js';
import { createOpencodeTerminationController } from '../src/lib/opencode-termination.js';
import type { OwnedProcessIdentity, ProcessTreeAuthority } from '../src/lib/process-tree-termination.js';

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

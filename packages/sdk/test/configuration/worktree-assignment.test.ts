/** Real client deadline checks with discovery held at a controlled boundary.
 * @summary Assignment expiry aborts stalled reconnect without a later send
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeClient, type RuntimeClient, type RuntimeConnectTarget } from '../../src/client/runtime/index.js';
import { createWorktreeAssignmentCallback } from '../../src/config/worktree-assignment.js';
import {
  MemoryOutbox,
  makeAcceptingAuthorities,
  makeCredential,
  makeIdentity,
  TEST_EXECUTION
} from '../client/runtime/index.js';

let client: RuntimeClient | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await client?.close();
  client = undefined;
});

describe('assignment total deadline', () => {
  it('expires at 120 seconds during discovery and never sends after the discovery later resolves', async () => {
    vi.useFakeTimers();
    let release!: (target: RuntimeConnectTarget | null) => void;
    let attempts = 0;
    const outbox = new MemoryOutbox();
    client = createRuntimeClient({
      identity: makeIdentity({ producer: { role: 'agent-handler', producerId: 'handler' } }),
      credential: makeCredential(),
      outbox,
      authorities: makeAcceptingAuthorities(),
      capabilities: { switchToInteractive: false },
      onMessage: () => undefined,
      discover: () => {
        attempts++;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    const errors: unknown[] = [];
    const pending = createWorktreeAssignmentCallback(client, TEST_EXECUTION, 'req-1', (error) => errors.push(error))();
    const rejected = expect(pending).rejects.toThrow('within 120 seconds');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(client.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(client.state).toBe('disconnected');
    release({ host: '127.0.0.1', port: 1, accessToken: 'unused' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(1);
    expect((await outbox.scanAll()).records).toEqual([]);
    expect(errors).toEqual([]);
  });
});

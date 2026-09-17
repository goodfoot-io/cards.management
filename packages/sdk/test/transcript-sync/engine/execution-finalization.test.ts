/**
 * Ensures every required watcher publishes its own persisted close before completion.
 * @summary Execution-scoped transcript finalization evidence
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readExecutionFinalization,
  recordExecutionFinalization,
  registerExecutionFinalization
} from '../../../src/transcript-sync/engine/execution-finalization.js';
import type { SessionSyncManifest } from '../../../src/transcript-sync/manifest.js';

const manifest = { sessionId: 'session-1', streamType: 'codex-session' } as SessionSyncManifest;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cards-finalization-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('execution-local finalization receipts', () => {
  it('marks missing watchers as not required only when nothing was registered', async () => {
    expect(await readExecutionFinalization(join(directory, 'none'))).toBe('not-required');
    const receipt = registerExecutionFinalization(manifest, directory)!;
    expect(JSON.parse(await readFile(receipt, 'utf8')).status).toBe('pending');
    expect(await readExecutionFinalization(directory)).toBe('incomplete');
  });
  it('requires every spawned watcher to publish a successful close', async () => {
    const first = registerExecutionFinalization(manifest, directory)!;
    const second = registerExecutionFinalization(manifest, directory)!;
    await recordExecutionFinalization(manifest, true, first);
    expect(await readExecutionFinalization(directory)).toBe('incomplete');
    await recordExecutionFinalization(manifest, true, second);
    expect(await readExecutionFinalization(directory)).toBe('complete');
  });
  it('never treats a degraded close as complete', async () => {
    const file = registerExecutionFinalization(manifest, directory)!;
    await recordExecutionFinalization(manifest, false, file);
    expect(await readExecutionFinalization(directory)).toBe('incomplete');
  });
  it('does not borrow completion from a same-card sibling execution', async () => {
    const ending = join(directory, 'ending');
    const sibling = join(directory, 'sibling');
    registerExecutionFinalization(manifest, ending);
    const file = registerExecutionFinalization(manifest, sibling)!;
    await recordExecutionFinalization(manifest, true, file);
    expect(await readExecutionFinalization(ending)).toBe('incomplete');
  });
  it('refuses to fulfill another session obligation', async () => {
    const file = registerExecutionFinalization(manifest, directory)!;
    await expect(recordExecutionFinalization({ ...manifest, sessionId: 'other' }, true, file)).rejects.toThrow(
      'does not match'
    );
    expect(await readExecutionFinalization(directory)).toBe('incomplete');
  });
  it('fails closed on malformed persisted evidence', async () => {
    const file = registerExecutionFinalization(manifest, directory)!;
    await writeFile(file, '{');
    expect(await readExecutionFinalization(directory)).toBe('incomplete');
  });
});

/**
 * Per-execution evidence that required transcript watchers finalized.
 * Parents record obligations before spawn; watchers fulfill them only after
 * persisting their session close. Nothing enumerates sibling card sessions.
 * @summary Execution-local transcript finalization receipts
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { SessionSyncManifest } from '../manifest.js';

/** Inherited by descendants of an owned action wrapper. */
export const EXECUTION_FINALIZATION_DIR_ENV = 'CARDS_EXECUTION_FINALIZATION_DIR';
/** Passed to one watcher, never inherited by sibling watcher launches. */
export const SESSION_FINALIZATION_FILE_ENV = 'CARDS_SESSION_FINALIZATION_FILE';

interface FinalizationReceipt {
  readonly version: 1;
  readonly sessionId: string;
  readonly streamType: string;
  readonly status: 'pending' | 'complete' | 'incomplete';
}

/**
 * Records required work before its watcher starts.
 * @param manifest - Session requiring a final transcript drain.
 * @param directory - Wrapper-owned directory; absent for unowned attach sessions.
 * @returns A unique receipt path, or undefined outside a wrapper.
 * @throws When the directory is not absolute or the required receipt cannot be persisted.
 */
export function registerExecutionFinalization(
  manifest: SessionSyncManifest,
  directory = process.env[EXECUTION_FINALIZATION_DIR_ENV]
): string | undefined {
  if (directory === undefined) return undefined;
  if (!isAbsolute(directory)) throw new Error('Execution finalization directory must be absolute');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${randomUUID()}.json`);
  const fd = openSync(file, 'wx', 0o600);
  try {
    const receipt: FinalizationReceipt = {
      version: 1,
      sessionId: manifest.sessionId,
      streamType: manifest.streamType,
      status: 'pending'
    };
    writeFileSync(fd, JSON.stringify(receipt));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return file;
}

/**
 * Publishes evidence after the required persisted session close.
 * @param manifest - Identity bound to this watcher's obligation.
 * @param complete - Whether required stream work completed without failure.
 * @param file - Receipt supplied to this watcher by its parent.
 */
export async function recordExecutionFinalization(
  manifest: SessionSyncManifest,
  complete: boolean,
  file = process.env[SESSION_FINALIZATION_FILE_ENV]
): Promise<void> {
  if (file === undefined) return;
  if (!isAbsolute(file)) throw new Error('Session finalization file must be absolute');
  const receipt = JSON.parse(await readFile(file, 'utf8')) as FinalizationReceipt;
  if (receipt.version !== 1 || receipt.sessionId !== manifest.sessionId || receipt.streamType !== manifest.streamType)
    throw new Error('Session finalization receipt does not match the watcher');
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...receipt, status: complete ? 'complete' : 'incomplete' }), {
    mode: 0o600,
    flag: 'wx',
    flush: true
  });
  await rename(temporary, file);
}

/**
 * Reads only this execution's required finalization evidence.
 * @param directory - Ending wrapper's private receipt directory.
 * @returns Complete only when every obligation explicitly completed.
 */
export async function readExecutionFinalization(
  directory: string
): Promise<'complete' | 'incomplete' | 'not-required'> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-required' : 'incomplete';
  }
  if (names.length === 0) return 'not-required';
  try {
    const receipts = await Promise.all(
      names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as FinalizationReceipt)
    );
    return receipts.every(
      (receipt) =>
        receipt.version === 1 &&
        typeof receipt.sessionId === 'string' &&
        typeof receipt.streamType === 'string' &&
        receipt.status === 'complete'
    )
      ? 'complete'
      : 'incomplete';
  } catch {
    return 'incomplete';
  }
}

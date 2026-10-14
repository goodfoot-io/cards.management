/**
 * Cost of verified checkout removal on a checkout of 7,277 entries, the size
 * the plan's cost model uses, under both witnesses. The `hash` run reads every
 * regular file three times (snapshot, pre-move check, committed re-verify), so
 * the gap between the two runs is the price Windows and FAT/SMB/NFS volumes pay.
 * @summary Verified removal throughput under the change-time and hash witnesses
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, test } from 'vitest';
import { type CheckoutWitness, removeQuarantinedCheckout } from '../src/checkout-removal.js';

const DIRECTORIES = 277;
const FILES_PER_DIRECTORY = 25;
// The Git marker, 74 root files, 277 directories and their 6,925 files: 7,277 entries.
const ROOT_FILES = 74;
const AGED = new Date('2020-01-01T00:00:00Z');

const parent = mkdtempSync(join(tmpdir(), 'cards-removal-bench-'));
const ITERATIONS = 5;
let round = 0;
// Checkouts are built ahead of each cycle so iterations time removal alone.
const prepared: string[] = [];

/** Builds one fresh aged checkout of 7,277 entries and queues it. */
function buildCheckout(): void {
  const root = join(parent, `${String(++round)}.deleting-bench`);
  prepared.push(root);
  mkdirSync(root);
  writeFileSync(join(root, '.git'), 'gitdir: /repo/.git/worktrees/1\n');
  for (let file = 0; file < ROOT_FILES; file++) {
    const target = join(root, `root-${String(file)}.txt`);
    writeFileSync(target, 'x'.repeat(512));
    utimesSync(target, AGED, AGED);
  }
  for (let directory = 0; directory < DIRECTORIES; directory++) {
    const path = join(root, `d${String(directory)}`);
    mkdirSync(path);
    for (let file = 0; file < FILES_PER_DIRECTORY; file++) {
      const target = join(path, `f${String(file)}.ts`);
      writeFileSync(target, `export const value = ${String(file)};\n`.repeat(40));
      utimesSync(target, AGED, AGED);
    }
  }
}

/**
 * Removes the prepared checkout under one witness.
 * @param witness - The witness to force.
 */
async function removeWith(witness: CheckoutWitness): Promise<void> {
  const root = prepared.shift();
  if (root === undefined) throw new Error('No prepared checkout left');
  await removeQuarantinedCheckout(
    { root, holding: `${root}.held`, restoreTo: join(parent, 'restored') },
    { prove: async () => undefined, requireCurrent: () => undefined, witness }
  );
}

describe('verified removal of 7,277 entries', () => {
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  test('ctime and hash witnesses', async ({ bench }) => {
    // Checkouts are queued before each benchmark's cycle so iterations time removal alone.
    const fnOpts = {
      beforeAll: () => {
        while (prepared.length < ITERATIONS + 1) buildCheckout();
      }
    };
    await bench.compare(
      bench('ctime witness', fnOpts, () => removeWith('ctime')),
      bench('hash witness', fnOpts, () => removeWith('hash')),
      { iterations: ITERATIONS, time: 0, warmupIterations: 1, warmupTime: 0 }
    );
  });
});

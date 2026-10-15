/**
 * Child-process harness for the teardown unhandled-rejection regression test.
 *
 * Why: the regression must observe the *process-fatal* consequence of an
 * abort-induced unhandled rejection, which only manifests as a non-zero exit in
 * a real Node process running under the default `unhandledRejection` mode (the
 * same mode the extension test host uses). Asserting inside the same vitest
 * process is insufficient because all `unhandledRejection` listeners fire
 * regardless — only the crash distinguishes fixed from broken.
 *
 * Behavior: this harness exercises the SLOW-TO-CLOSE child path that the racy
 * `setTimeout(0)` guard could not survive. It installs a pre-commit hook that
 * sleeps ~0.6s, kicks off an abandoned (never-awaited, no-catch) `git.commit()`
 * that spawns that slow child, then calls `destroy()` ~120ms in — while the child
 * is still alive. The abort plugin sends SIGINT, but the task promise rejects only
 * when the child's async `close` fires, hundreds of ms after the guard ran. With a
 * timing-based listener removal the `GitPluginError(plugin='abort')` rejection
 * escapes and Node terminates this process non-zero before the sentinel is
 * reached; with the process-lifetime guard it is contained, the sentinel prints,
 * and the process exits 0.
 *
 * @summary Reproduce a slow-to-close teardown abort rejection in an isolated process
 * @module sdk/test/testing/abortUnhandledRejectionChild
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { TestCardRepository } from '../../src/testing/TestCardRepository.js';

/** Sentinel printed only if the process survives the contained abort rejection. */
const POST_ABORT_SENTINEL = 'POST_ABORT_SENTINEL_REACHED';

async function main(): Promise<void> {
  const repo = new TestCardRepository();
  await repo.create();

  // Use getCardGit() directly (no createCard) so the in-flight client is bound
  // to the helper's shared abort signal. getCardGit() requires the directory to
  // exist, so create it first.
  const cardId = 'regression-card';
  const cardPath = path.join(repo.getPath(), cardId);
  await mkdir(cardPath, { recursive: true });
  const git = repo.getCardGit(cardId);

  await git.raw(['init', '--initial-branch=main']);
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');

  // Install a pre-commit hook that sleeps ~0.6s, so the git child stays alive
  // well past any fixed `setTimeout(0)` removal window. The client was created
  // with `allowUnsafeHooksPath`, so point core.hooksPath at our hooks dir.
  const hooksDir = path.join(cardPath, '.githooks');
  await mkdir(hooksDir, { recursive: true });
  const preCommit = path.join(hooksDir, 'pre-commit');
  await writeFile(preCommit, '#!/bin/sh\nsleep 0.6\n');
  await chmod(preCommit, 0o755);
  await git.addConfig('core.hooksPath', hooksDir);

  // Stage a real change so `commit` actually runs the (slow) pre-commit hook.
  await writeFile(path.join(cardPath, 'tracked.txt'), 'content\n');
  await git.add('tracked.txt');

  // Abandoned in-flight git work: a never-awaited, no-catch commit whose slow
  // pre-commit hook keeps the git child alive. This mirrors a test that times out
  // mid-operation — exactly the path that turns abort() into an unhandled
  // rejection when the child is still closing.
  async function abandoned(): Promise<void> {
    await git.commit('slow commit');
  }
  void abandoned();

  // Let the commit spawn its slow child, then tear down while the child is still
  // alive (well before the ~0.6s hook completes).
  await new Promise((resolve) => setTimeout(resolve, 120));
  repo.destroy();

  // Give the SIGINT'd child ample time to close and surface its (now-contained)
  // abort rejection. If the guard fails to contain it, the process exits non-zero
  // before the sentinel below is reached.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Use stdout (not console) for the survival sentinel; the test reads it from
  // the child's piped stdout.
  process.stdout.write(`${POST_ABORT_SENTINEL}\n`);
  process.exit(0);
}

void main();

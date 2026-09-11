/**
 * Child harness for {@link createIsolatedGitHome}'s exit cleanup.
 *
 * Creates a private home, reports its path, and exits with the status given as
 * the first argument, so a parent can prove the home is removed for a passing
 * run and a failing one alike. The cleanup is registered on `exit`, so no
 * in-process assertion can observe it.
 *
 * The path is written with `fs.writeSync` rather than `process.stdout.write`
 * because a pipe write queued before an explicit `process.exit` is not
 * guaranteed to flush, which would leave the parent with an empty path and a
 * vacuously passing assertion.
 *
 * @summary Report a private home path, then exit with a caller-chosen status
 * @module test-utils/test/vitest/gitHomeIsolationChild
 */

import fs from 'node:fs';
import { createIsolatedGitHome } from '../../src/vitest/gitHomeIsolation.js';

const exitCode = Number.parseInt(process.argv[2] ?? '0', 10);
const home = createIsolatedGitHome();

fs.writeSync(1, home.path);
process.exit(exitCode);

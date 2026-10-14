/**
 * Vitest per-file setup that gives every test file its own empty HOME.
 *
 * The hook handlers resolve global state from the user's home directory:
 * `~/.cards` (subagent tracking, card repositories), `~/.claude/settings.json`
 * (install-scope detection) and `~/.config/opencode/opencode.json` (the
 * OpenCode state anchor). Tests that exercise those paths must neither read the
 * developer's real state nor write into it, and a cached result must not depend
 * on it. Pointing HOME and the config-directory selectors at a directory owned
 * by the test file makes those reads hermetic. Suites that need a more specific
 * home still override HOME themselves and restore this value afterwards.
 *
 * @summary Per-test-file owned HOME for hermetic global-state resolution
 * @module test/setup/isolate-home
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const ownedHome = mkdtempSync(join(tmpdir(), 'agent-hooks-test-home-'));

process.env['HOME'] = ownedHome;
process.env['XDG_CONFIG_HOME'] = join(ownedHome, '.config');
process.env['XDG_DATA_HOME'] = join(ownedHome, '.local', 'share');
process.env['XDG_CACHE_HOME'] = join(ownedHome, '.cache');
process.env['CLAUDE_CONFIG_DIR'] = join(ownedHome, '.claude');

afterAll(() => {
  rmSync(ownedHome, { recursive: true, force: true });
});

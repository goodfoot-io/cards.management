/**
 * {@link createIsolatedGitHome} has to hold two properties for the suites that
 * adopt it: a real `git config --global` write must land in the private home
 * rather than wherever the developer's environment pointed, and the private
 * home must not outlive the runner that created it.
 *
 * Both are checked against the real `git` binary and the real filesystem. The
 * cleanup half runs in a child process because the cleanup is registered on
 * `exit` — an in-process assertion would observe the home before it is
 * removed, regardless of whether the hook works.
 *
 * @summary Private Git homes must capture global config writes and be removed on exit
 * @module test-utils/test/vitest/gitHomeIsolation
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedGitHome, GIT_HOME_PREFIX, type IsolatedGitHome } from '../../src/vitest/gitHomeIsolation.js';

const execFileAsync = promisify(execFile);

const CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gitHomeIsolationChild.ts');

/** A trust directory no real configuration could plausibly already contain. */
const PROBE_DIRECTORY = '/probe/safe-directory-target';

/** Distinctive contents so an edited canary is unmistakable in a diff. */
const CANARY_CONFIG = '[user]\n\tname = Canary Developer\n\temail = canary@example.test\n';

describe('createIsolatedGitHome', () => {
  const scratchDirs: string[] = [];
  const homes: IsolatedGitHome[] = [];

  /**
   * Creates a temporary directory that the test removes afterwards.
   *
   * @param label - Short description used in the directory name.
   * @returns Absolute path to the new directory.
   */
  function scratch(label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cards-test-${label}-`));
    scratchDirs.push(dir);
    return dir;
  }

  /**
   * Creates a private home tracked for teardown.
   *
   * @returns The private home.
   */
  function isolatedHome(): IsolatedGitHome {
    const home = createIsolatedGitHome();
    homes.push(home);
    return home;
  }

  afterEach(() => {
    for (const home of homes.splice(0)) home.dispose();
    for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a real global Git config write inside the private home', async () => {
    // Canaries stand in for a developer's ambient configuration, one per
    // variable that decides where Git looks. Each is seeded so an added entry
    // would show up as changed bytes.
    const ambientHome = scratch('ambient-home');
    const ambientUserProfile = scratch('ambient-userprofile');
    const ambientXdg = scratch('ambient-xdg');
    const canaries = [
      path.join(ambientHome, '.gitconfig'),
      path.join(ambientUserProfile, '.gitconfig'),
      path.join(ambientXdg, 'git', 'config')
    ];
    for (const canary of canaries) {
      fs.mkdirSync(path.dirname(canary), { recursive: true });
      fs.writeFileSync(canary, CANARY_CONFIG);
    }

    const home = isolatedHome();

    // Two steps, mirroring how a runner builds a worker environment: the
    // ambient configuration the worker would otherwise inherit, then the
    // private home applied over it.
    const ambientEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: ambientHome,
      USERPROFILE: ambientUserProfile,
      XDG_CONFIG_HOME: ambientXdg
    };
    await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', PROBE_DIRECTORY], {
      env: { ...ambientEnv, ...home.env }
    });

    // Git picks between the home and XDG locations depending on which exists
    // first, so the probe may legitimately land at either — but exactly one,
    // and only inside the private home.
    const targets = [path.join(home.path, '.gitconfig'), path.join(home.env.XDG_CONFIG_HOME, 'git', 'config')].filter(
      (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes(PROBE_DIRECTORY)
    );
    expect(targets).toHaveLength(1);

    for (const canary of canaries) {
      expect(fs.readFileSync(canary, 'utf-8')).toBe(CANARY_CONFIG);
    }
  });

  it('removes the private home when the runner exits', async () => {
    // A failing run must clean up as thoroughly as a passing one: the failure
    // path is where a leaked home is most likely, since it is the path a
    // caller cannot tidy up by hand.
    for (const exitCode of [0, 1]) {
      const reportedPath = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', CHILD_SCRIPT, String(exitCode)], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => {
          if (code === exitCode) resolve(stdout);
          else reject(new Error(`child exited ${code}, expected ${exitCode}:\n${stderr}`));
        });
      });

      expect(path.basename(reportedPath).startsWith(GIT_HOME_PREFIX)).toBe(true);
      expect(fs.existsSync(reportedPath)).toBe(false);
    }
  });

  it('removes the private home on dispose', () => {
    const home = createIsolatedGitHome();
    expect(fs.existsSync(home.path)).toBe(true);

    home.dispose();

    expect(fs.existsSync(home.path)).toBe(false);
  });
});

/**
 * Tests for the manifest-driven `spawnStreamSyncWatcher` helper.
 *
 * Covers a single JSON argv entry (the serialized manifest), shell-less spawn
 * on both platforms, and the win32/POSIX resolution branches. `node:child_process`
 * and `node:fs` are mocked so no real process is spawned.
 *
 * @summary Unit tests for spawnStreamSyncWatcher
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSyncManifest } from '../../src/transcript-sync/manifest.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn()
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn()
}));

vi.mock('../../src/bin/detached-node.js', () => ({
  resolveDetachedNodeInterpreter: vi.fn()
}));

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveDetachedNodeInterpreter } from '../../src/bin/detached-node.js';
import {
  resolveStreamSyncWatcher,
  spawnStreamSyncWatcher,
  streamSyncWatcherWrapperName
} from '../../src/bin/spawn-stream-sync-watcher.js';

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
const mockExistsSync = vi.mocked(existsSync);
const mockResolveDetachedNodeInterpreter = vi.mocked(resolveDetachedNodeInterpreter);

function makeManifest(overrides: Partial<SessionSyncManifest> = {}): SessionSyncManifest {
  return {
    version: 1,
    sessionId: 'sess-abc',
    cardId: 'main-99',
    runtime: 'claude-code',
    streamType: 'claude-code-session',
    watchRoot: '/tmp/sessions',
    sources: [{ pattern: 'sess-abc.jsonl', role: 'main', mode: 'jsonl-tail' }],
    monitorPid: 42000,
    cardRepoPath: '/tmp/card-repos/main-99',
    ...overrides
  };
}

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}

function makeLogger() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe('spawnStreamSyncWatcher', () => {
  let savedPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
  }

  describe('wrapper naming and resolution', () => {
    it('uses the extension-less name on non-win32', () => {
      setPlatform('linux');
      expect(streamSyncWatcherWrapperName()).toBe('stream-sync-watcher');
    });

    it('uses the .cmd name on win32', () => {
      setPlatform('win32');
      expect(streamSyncWatcherWrapperName()).toBe('stream-sync-watcher.cmd');
    });

    it('resolves an absolute path under the given bin directory', () => {
      setPlatform('linux');
      expect(resolveStreamSyncWatcher('/ext/dist/bin')).toBe('/ext/dist/bin/stream-sync-watcher');
    });
  });

  describe('POSIX', () => {
    beforeEach(() => setPlatform('linux'));

    it('spawns with a single JSON argv entry when the absolute wrapper exists', () => {
      mockExistsSync.mockReturnValue(true);
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child as never);

      const manifest = makeManifest();
      const result = spawnStreamSyncWatcher({ manifest, extensionPath: '/ext', logger: makeLogger() });

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        '/ext/dist/bin/stream-sync-watcher',
        [JSON.stringify(manifest)],
        expect.objectContaining({ detached: false, stdio: 'ignore' })
      );
      expect(child.unref).toHaveBeenCalledOnce();
    });

    it('uses the bare wrapper name (PATH resolution) when no extensionPath is given', () => {
      mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as never);
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child as never);

      const manifest = makeManifest();
      spawnStreamSyncWatcher({ manifest, logger: makeLogger() });

      expect(mockSpawn).toHaveBeenCalledWith(
        'stream-sync-watcher',
        [JSON.stringify(manifest)],
        expect.objectContaining({ detached: false, stdio: 'ignore' })
      );
    });

    it('skips the spawn and logs an error when the absolute wrapper does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const logger = makeLogger();

      const result = spawnStreamSyncWatcher({ manifest: makeManifest(), extensionPath: '/ext', logger });

      expect(result).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not resolvable'), expect.any(Object));
    });

    it('never throws when no logger is supplied on a skipped spawn', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => spawnStreamSyncWatcher({ manifest: makeManifest(), extensionPath: '/ext' })).not.toThrow();
    });
  });

  describe('win32', () => {
    beforeEach(() => setPlatform('win32'));

    it('skips the spawn when no Node interpreter can be resolved', () => {
      mockResolveDetachedNodeInterpreter.mockReturnValue(null);
      const logger = makeLogger();

      const result = spawnStreamSyncWatcher({ manifest: makeManifest(), extensionPath: '/ext', logger });

      expect(result).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('no usable Node interpreter'),
        expect.any(Object)
      );
    });

    it('spawns node.exe directly with the sibling .mjs and no shell when resolution succeeds', () => {
      // node:path's isAbsolute() uses the POSIX implementation under a Linux
      // test runner even with process.platform stubbed to 'win32', so a
      // `C:\...` watcher path is not seen as absolute here — the code takes
      // the `where`-lookup branch. Mock that lookup to resolve the same path
      // real win32 `where` output would produce for an absolute `.cmd` arg.
      mockResolveDetachedNodeInterpreter.mockReturnValue('C:\\node.exe');
      mockSpawnSync.mockReturnValue({
        status: 0,
        error: undefined,
        stdout: 'C:\\ext\\dist\\bin\\stream-sync-watcher.cmd\n'
      } as never);
      mockExistsSync.mockReturnValue(true);
      const child = makeFakeChild();
      mockSpawn.mockReturnValue(child as never);

      const manifest = makeManifest();
      const result = spawnStreamSyncWatcher({
        manifest,
        extensionPath: 'C:\\ext',
        logger: makeLogger()
      });

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        'C:\\node.exe',
        ['C:\\ext\\dist\\bin\\stream-sync-watcher.mjs', JSON.stringify(manifest)],
        expect.objectContaining({ detached: false, stdio: 'ignore', windowsHide: true })
      );
    });

    it('skips the spawn when the sibling .mjs cannot be resolved', () => {
      mockResolveDetachedNodeInterpreter.mockReturnValue('C:\\node.exe');
      mockSpawnSync.mockReturnValue({
        status: 0,
        error: undefined,
        stdout: 'C:\\ext\\dist\\bin\\stream-sync-watcher.cmd\n'
      } as never);
      mockExistsSync.mockReturnValue(false);
      const logger = makeLogger();

      const result = spawnStreamSyncWatcher({ manifest: makeManifest(), extensionPath: 'C:\\ext', logger });

      expect(result).toBe(false);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('.mjs not resolvable'), expect.any(Object));
    });
  });
});

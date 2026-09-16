/**
 * Tests for isSessionIdle and backing subagent-tracking storage operations.
 *
 * Phase 3 contract tests for isSessionIdle and backing subagent-tracking
 * storage operations. All tests are live and passing.
 *
 * @summary Contract tests for session-idle and subagent tracking
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addActiveSubagent, removeActiveSubagent } from '@cards.management/sessions/card-repo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSessionIdle } from '../../src/shared/session-idle.js';

/** Directory where per-session subagent files are stored (documented contract). */
const SUBAGENTS_DIR = join(homedir(), '.cards', 'card-repo-commits');

function uniqueSessionId(): string {
  return `test-idle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function subagentsPath(sessionId: string): string {
  return join(SUBAGENTS_DIR, `${sessionId}.subagents`);
}

describe('isSessionIdle', () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const sid of sessionIds) {
      try {
        rmSync(subagentsPath(sid), { force: true, recursive: true });
      } catch {
        // Best-effort cleanup — ignore if path does not exist or is locked.
      }
    }
    sessionIds.length = 0;
  });

  describe('empty session', () => {
    it('returns true when no subagents file exists', () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      expect(isSessionIdle(sessionId)).toBe(true);
    });
  });

  describe('active subagents', () => {
    it('returns false after adding an active subagent', async () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      await addActiveSubagent(sessionId, 'agent-1');

      expect(isSessionIdle(sessionId)).toBe(false);
    });

    it('returns true after all subagents are removed', async () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      await addActiveSubagent(sessionId, 'agent-1');
      await removeActiveSubagent(sessionId, 'agent-1');

      expect(isSessionIdle(sessionId)).toBe(true);
    });
  });

  describe('idempotency', () => {
    it('addActiveSubagent is idempotent — adding the same agent twice results in one entry, and session is not idle', async () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      await addActiveSubagent(sessionId, 'agent-1');
      await addActiveSubagent(sessionId, 'agent-1');

      // Session should still not be idle — agent-1 exists.
      expect(isSessionIdle(sessionId)).toBe(false);

      // Removing once should make it idle, proving only one entry was recorded.
      await removeActiveSubagent(sessionId, 'agent-1');

      expect(isSessionIdle(sessionId)).toBe(true);
    });

    it('removeActiveSubagent is idempotent — removing a non-existent agent does not throw, and session remains idle', async () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      // Must not throw for an agent that was never added.
      await expect(removeActiveSubagent(sessionId, 'nonexistent-agent')).resolves.toBeUndefined();

      expect(isSessionIdle(sessionId)).toBe(true);
    });
  });

  describe('fail-open error handling', () => {
    it('returns true when the underlying file read encounters an unexpected error (EISDIR)', () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      // Create a directory at the expected file path. When the implementation
      // reads this path as a file, the OS returns EISDIR, which is not ENOENT
      // so the storage layer propagates it. The fail-open wrapper in
      // isSessionIdle catches it and returns true.
      mkdirSync(subagentsPath(sessionId), { recursive: true });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(isSessionIdle(sessionId)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        'isSessionIdle: error reading subagent state, treating as idle:',
        expect.objectContaining({ code: 'EISDIR' })
      );
      warn.mockRestore();
    });

    it('returns true when the subagents file contains malformed JSON', () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      mkdirSync(SUBAGENTS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(subagentsPath(sessionId), '{ not valid json [');

      // Malformed JSON causes a parse error, which the fail-open wrapper
      // catches and treats as idle.
      expect(isSessionIdle(sessionId)).toBe(true);
    });
  });

  describe('wrong-shape store content', () => {
    it.each([
      ['{}'],
      ['"a string"'],
      ['42']
    ])('stays enabled — returns true (not wedged false) for stored JSON %s', (content) => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      mkdirSync(SUBAGENTS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(subagentsPath(sessionId), content);

      // Regression: valid-JSON-but-wrong-shape content used to be cast to
      // string[], making getActiveSubagentCount return undefined and
      // isSessionIdle permanently false — exit-when-done never fired.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(isSessionIdle(sessionId)).toBe(true);
      warn.mockRestore();
    });

    it('detection still evaluates later valid state after wrong-shape content', async () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      mkdirSync(SUBAGENTS_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(subagentsPath(sessionId), '{}');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      // Wrong shape degrades to empty — idle.
      expect(isSessionIdle(sessionId)).toBe(true);

      // A subsequent dispatch rewrites a canonical array and is honored.
      await addActiveSubagent(sessionId, 'agent-1');
      expect(isSessionIdle(sessionId)).toBe(false);

      await removeActiveSubagent(sessionId, 'agent-1');
      expect(isSessionIdle(sessionId)).toBe(true);

      warn.mockRestore();
    });
  });

  describe('concurrent add/remove sequences', () => {
    it('produces correct idle state across interleaved add and remove operations', async () => {
      const sessionId = uniqueSessionId();
      sessionIds.push(sessionId);

      // Dispatch two subagents.
      await addActiveSubagent(sessionId, 'agent-a');
      await addActiveSubagent(sessionId, 'agent-b');

      // Remove A — session should NOT be idle because B remains.
      await removeActiveSubagent(sessionId, 'agent-a');
      expect(isSessionIdle(sessionId)).toBe(false);

      // Remove B — session should now be idle.
      await removeActiveSubagent(sessionId, 'agent-b');
      expect(isSessionIdle(sessionId)).toBe(true);
    });
  });
});

/**
 * The pending shutdown request marker's lifecycle must be traceable from
 * durable evidence: creation and consumption are journaled, so a marker that
 * disappears between two `cards shutdown` attempts leaves a record of when and
 * by which request identity it was consumed.
 * @summary Pending shutdown request lifecycle journal
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGlobalCardsConfigDir } from '../../src/cards-config.js';
import {
  clearPendingShutdownRequest,
  readPendingShutdownRequest,
  writePendingShutdownRequest
} from '../../src/config/shutdown.js';

function journalPath(): string {
  return join(resolveGlobalCardsConfigDir(), 'card-repo-commits', 'shutdown-requests.ndjson');
}

describe('pending shutdown request lifecycle journal', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shutdown-lifecycle-'));
    previousHome = process.env['CARDS_HOME'];
    process.env['CARDS_HOME'] = root;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['CARDS_HOME'];
    else process.env['CARDS_HOME'] = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('journals creation and consumption of the pending request marker', () => {
    writePendingShutdownRequest('ses-1', {
      version: 1,
      requestId: 'req-1',
      messageId: 'msg-1',
      outcome: 'success',
      message: 'finishing up'
    });
    expect(readPendingShutdownRequest('ses-1')).toMatchObject({ requestId: 'req-1' });

    const created = readFileSync(journalPath(), 'utf8').trim().split('\n');
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0] ?? '{}')).toMatchObject({
      event: 'created',
      sessionId: 'ses-1',
      requestId: 'req-1',
      messageId: 'msg-1'
    });

    clearPendingShutdownRequest('ses-1', 'req-1');
    expect(readPendingShutdownRequest('ses-1')).toBeUndefined();

    const cleared = readFileSync(journalPath(), 'utf8').trim().split('\n');
    expect(cleared).toHaveLength(2);
    expect(JSON.parse(cleared[1] ?? '{}')).toMatchObject({
      event: 'cleared',
      sessionId: 'ses-1',
      requestId: 'req-1'
    });
  });

  it('keeps the journal when the marker itself is consumed and removed', () => {
    writePendingShutdownRequest('ses-2', { version: 1, requestId: 'req-2', messageId: 'msg-2', outcome: 'blocked' });
    clearPendingShutdownRequest('ses-2', 'req-2');
    const marker = join(
      resolveGlobalCardsConfigDir(),
      'card-repo-commits',
      `${encodeURIComponent('ses-2')}.shutdown-request.json`
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(journalPath())).toBe(true);
  });

  it('does not journal a clearing that did not happen', () => {
    writePendingShutdownRequest('ses-3', { version: 1, requestId: 'req-3', messageId: 'msg-3', outcome: 'error' });
    clearPendingShutdownRequest('ses-3', 'some-other-request');
    expect(readPendingShutdownRequest('ses-3')).toMatchObject({ requestId: 'req-3' });
    expect(readFileSync(journalPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

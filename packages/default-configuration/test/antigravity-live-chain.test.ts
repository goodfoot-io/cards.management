/**
 * Live-chain composition for Antigravity transcript delivery: real hook
 * input and registration, the hook-owned SDK manifest adapter, serialization
 * and watcher attach, destination records, default stream registration, and
 * renderer output.
 *
 * @summary Antigravity hook-to-renderer composition
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionInput } from '@cards.management/sdk/config';
import { resolveTranscriptPath } from '@cards.management/sdk/session-resolver';
import {
  parseManifest,
  type SessionSyncManifest,
  type SqlitePollSourceSpec,
  serializeManifest
} from '@cards.management/sdk/transcript-sync';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAntigravityHandlerDeps } from '../../agent-hooks/src/antigravity/internal/deps.js';
import { handlePreInvocation } from '../../agent-hooks/src/antigravity/internal/handlers.js';
import { dispatchAntigravityHook } from '../../agent-hooks/src/antigravity/internal/transport.js';
import { SqlitePollEngine } from '../../sdk/src/transcript-sync/engine/sqlite-poll.js';
import {
  buildAssistantPayload,
  buildUserPayload,
  createConversationDb,
  type FixtureConversationDb
} from '../../sdk/test/transcript-sync/fixtures/antigravity-db.js';
import settingsConfig from '../settings.config.js';
import { renderAntigravityTranscript } from '../src/streams/antigravity-session/www/lib/render-transcript.js';

const SESSION_ID = 'agy-live-chain-session';
const CONVERSATION_ID = '8724cd98-6b07-4080-82d3-1c617be236bf';

describe('Antigravity live transcript chain', () => {
  let root = '';
  let db: FixtureConversationDb | undefined;
  const savedEnv = new Map<string, string | undefined>();

  afterEach(async () => {
    db?.close();
    db = undefined;
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
    if (root.length > 0) await rm(root, { recursive: true, force: true });
  });

  it('renders records emitted from the manifest produced by a real PreInvocation', async () => {
    root = await mkdtemp(join(tmpdir(), 'agy-live-chain-'));
    const cardsHome = join(root, 'cards-home');
    const cardRepoPath = join(root, 'cards', 'main-645');
    const workspacePath = join(root, 'workspace');
    const conversationsDir = join(root, 'conversations');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await Promise.all([
      mkdir(cardsHome, { recursive: true }),
      mkdir(cardRepoPath, { recursive: true }),
      mkdir(workspacePath, { recursive: true }),
      mkdir(conversationsDir, { recursive: true })
    ]);
    await writeFile(join(cardRepoPath, 'CARD.meta.json'), JSON.stringify({ id: 'main-645', status: 'active' }));
    db = createConversationDb(conversationsDir, CONVERSATION_ID);
    db.setTrajectoryMeta(CONVERSATION_ID);

    for (const [name, value] of [
      ['CARDS_HOME', cardsHome],
      ['CARD_ID', 'main-645'],
      // Empty string: the resolver treats it as absent, so a launcher-set
      // CARDS_TRANSCRIPT_PATH in the outer session cannot shadow the fixture
      // store this test exercises.
      ['CARDS_TRANSCRIPT_PATH', ''],
      ['ANTIGRAVITY_SESSION_ID', SESSION_ID]
    ] as const) {
      savedEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const actionInput: ActionInput = {
      cardId: 'main-645',
      actionName: 'Launch',
      environment: 'default',
      executionMode: 'interactive',
      exitWhenDone: false,
      codingAgent: 'antigravity-cli',
      switchToInteractiveData: undefined,
      repoRoot: root,
      cardRepoPath,
      configPath: join(root, 'config'),
      extensionPath: join(root, 'extension'),
      marketplacePath: join(root, 'marketplace')
    };
    let serializedManifest = '';
    const defaults = defaultAntigravityHandlerDeps();
    const deps = {
      ...defaults,
      // This composition begins after durable admission; authenticate that
      // boundary through the handler seam so the test can exercise the later
      // manifest, watcher, and renderer chain without a synthetic credential.
      workAuthority: {
        admit: async () => ({ workRevision: 1 }),
        observeRevision: async () => 1
      },
      cardsConfigDir: () => cardsHome,
      loadActionInput: () => actionInput,
      resolveSessionId: () => SESSION_ID,
      findMonitorPid: async () => 4242,
      conversationDbPath: () => db!.path,
      spawnWatcher: ({ manifest }: { manifest: SessionSyncManifest }) => {
        serializedManifest = serializeManifest(manifest);
        return true;
      },
      runReconciliationSweep: async () => {}
    };

    await dispatchAntigravityHook(
      {
        conversationId: CONVERSATION_ID,
        workspacePaths: [workspacePath],
        transcriptPath: join(root, 'host-stream.jsonl'),
        artifactDirectoryPath: join(root, 'artifacts'),
        modelName: 'gemini-3-pro',
        invocationNum: 1,
        initialNumSteps: 0
      },
      handlePreInvocation,
      deps
    );

    expect(await resolveTranscriptPath(SESSION_ID, workspacePath)).toBe(db.path);
    const manifest = parseManifest(serializedManifest);
    expect(manifest).toMatchObject({
      version: 2,
      runtime: 'antigravity',
      streamType: 'antigravity-session',
      sources: [{ mode: 'sqlite-poll', conversationId: CONVERSATION_ID }]
    });
    expect(settingsConfig.environments.default?.streams?.[manifest.streamType]).toBeDefined();

    const spec = manifest.sources[0] as SqlitePollSourceSpec;
    const destination = join(cardRepoPath, 'streams', manifest.streamType, `${spec.pattern}.jsonl`);
    const engine = new SqlitePollEngine({
      manifest,
      spec,
      destPath: destination,
      warnFn: () => {},
      now: () => Date.now(),
      sleep: () => Promise.resolve()
    });
    await engine.attach();
    db.insertStep({ idx: 20, stepType: 15, status: 3, payload: buildAssistantPayload('answer'), format: 0 });
    db.insertStep({ idx: 10, stepType: 14, status: 3, payload: buildUserPayload('question'), format: 0 });
    const outcome = await engine.pollOnce();
    expect(outcome.kind).toBe('ok');

    const rendered = renderAntigravityTranscript((await readFile(destination, 'utf-8')).split('\n'));
    expect(rendered).toEqual([
      { kind: 'step', idx: 10, stepType: 14, status: 3, content: 'question' },
      { kind: 'step', idx: 20, stepType: 15, status: 3, content: 'answer' }
    ]);
  });
});

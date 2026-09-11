/**
 * Tests for card CLI binary functions.
 *
 * Uses a real HTTP server for API calls and a real git workspace for branch
 * detection. Only homedir is mocked since tests have no Cards discovery file.
 *
 * @summary Tests for card CLI binary functions
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir as realTmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { forceRemoveSync } from '../helpers/forceRemove.js';

/**
 * Absolute path to the tsx CLI entrypoint. Spawned via `process.execPath`
 * (node) so it works cross-platform, unlike spawning the `tsx` shim which is
 * a `.cmd` on Windows and not resolvable by `execFileSync`.
 */
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: vi.fn(() => process.env['MOCK_HOMEDIR'] || '/tmp')
  };
});

// Mock the worktree-outfit orchestrator so createCard's binding side-effect is
// observable without registering branches, installing hooks, or spawning
// detached watcher processes. The real outfit path has its own suite.
const outfitWorktreeForCard = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@cards.management/sdk/worktree-for-card', () => ({
  outfitWorktreeForCard: (...args: unknown[]) => outfitWorktreeForCard(...args)
}));

// Mock the candidate-set reads/removals so the run-from-outside fallback is
// driven deterministically without touching the global cards config dir.
const readUnboundCandidates = vi.fn<
  (...args: unknown[]) => Promise<{ worktreeDir: string; sessionId: string; transcriptPath: string }[]>
>(() => Promise.resolve([]));
const removeUnboundCandidate = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@cards.management/sdk/unbound-worktree-candidates', () => ({
  readUnboundCandidates: (...args: unknown[]) => readUnboundCandidates(...args),
  removeUnboundCandidate: (...args: unknown[]) => removeUnboundCandidate(...args)
}));

// resolveExtensionPath is invoked only to build compiledScriptPaths for the
// (mocked) outfit call; stub it so it never touches the real install.
vi.mock('@cards.management/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cards.management/sdk')>();
  return {
    ...actual,
    resolveExtensionPath: vi.fn(() => Promise.resolve('/tmp/ext-install'))
  };
});

import {
  applyJsonPath,
  attachCard,
  connectClient,
  createCard,
  executeAction,
  listCards,
  listVariableGroups,
  parseCardCreateInput,
  searchCards,
  variableGroupCommand
} from '../../src/bin/cards.js';

/**
 * Collects the full request body as a string.
 *
 * @param req - Incoming HTTP request to read.
 * @returns The complete body content.
 */
function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

/**
 * Restores an environment variable to a previously-saved value, deleting it when
 * the saved value is `undefined` (i.e. it was unset before the test).
 *
 * @param key - Environment variable name.
 * @param saved - The value captured before the test mutated it.
 */
function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = saved;
  }
}

describe('card binary', () => {
  let testDir: string;
  let server: Server;

  /** Cards stored in the test server, keyed by ID. */
  let cards: Map<string, Record<string, unknown>>;
  /** Environment action summaries returned by GET /environments. */
  let environments: Array<Record<string, unknown>>;
  /** Branches registered via POST /cards/:id/branches. */
  let branches: Map<string, Array<{ name: string }>>;
  /** Commits registered via POST /cards/:id/commits. */
  let commits: Map<string, string[]>;
  /** Counter for auto-generated card IDs. */
  let cardCounter: number;
  /** Files stored via PUT /cards/:id/fs/:path, keyed by `${cardId}/${filePath}`. */
  let files: Map<string, string>;
  /** Bodies received via POST /cards/:id/actions/:name. */
  let actionRequests: Array<{ cardId: string; actionName: string; body: Record<string, unknown> | undefined }>;
  /** Response returned by the action endpoint. */
  let actionResult: Record<string, unknown>;
  /** CardIds received via DELETE /internal/cards/:cardId/watchers. */
  let deletedWatcherCardIds: string[];
  /** Controls whether DELETE /internal/cards/:cardId/watchers returns 200 or 503. */
  let watcherRegistryAvailable: boolean;
  /** Active watchers by sessionId for GET /internal/watchers/:watcherId. */
  let activeWatchers: Map<string, { watcherId: string; cardId: string; metadata: Record<string, unknown> }>;
  /** Controls the DELETE response body (stopped/timedOut) for watcher teardown tests. */
  let watcherDeleteResponse: { stopped: string[]; timedOut: string[] };
  /** Workspace paths received by GET /variable-groups. */
  let variableGroupWorkspacePaths: Array<string | null>;
  /** Controls whether variable-group discovery succeeds. */
  let variableGroupRequestFails: boolean;
  /** Saved env around each test so inherited Cards-home overrides are restored. */
  let savedCardsHome: string | undefined;
  let savedXdgDataHome: string | undefined;
  let savedXdgConfigHome: string | undefined;

  beforeEach(async () => {
    cards = new Map();
    environments = [];
    branches = new Map();
    commits = new Map();
    files = new Map();
    actionRequests = [];
    actionResult = { success: true, exitCode: 0 };
    deletedWatcherCardIds = [];
    watcherRegistryAvailable = true;
    activeWatchers = new Map();
    watcherDeleteResponse = { stopped: [], timedOut: [] };
    variableGroupWorkspacePaths = [];
    variableGroupRequestFails = false;
    cardCounter = 0;

    // Create temp directory for homedir mock
    testDir = join(realTmpdir(), `card-bin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.cards'), { recursive: true });
    process.env['MOCK_HOMEDIR'] = testDir;
    // resolveGlobalCardsConfigDir() resolves $CARDS_HOME → $XDG_DATA_HOME/.cards →
    // $XDG_CONFIG_HOME/.cards → ~/.cards. Mocking homedir only covers the last
    // fallback; an inherited CARDS_HOME or XDG_* (e.g. on CI runners) would steer
    // discovery away from testDir and fail with "API discovery failed". Pin
    // CARDS_HOME (highest precedence) to the test's .cards dir and clear the XDG
    // overrides so discovery is hermetic regardless of the host environment.
    savedCardsHome = process.env['CARDS_HOME'];
    savedXdgDataHome = process.env['XDG_DATA_HOME'];
    savedXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    process.env['CARDS_HOME'] = join(testDir, '.cards');
    delete process.env['XDG_DATA_HOME'];
    delete process.env['XDG_CONFIG_HOME'];

    // Start a minimal HTTP server that handles the card API endpoints
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const method = req.method ?? 'GET';

      // GET /variable-groups
      if (method === 'GET' && url.pathname === '/variable-groups') {
        variableGroupWorkspacePaths.push(url.searchParams.get('workspacePath'));
        if (variableGroupRequestFails) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Variable group discovery unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'shared-tools', name: 'Shared tools', variableCount: 2, secretCount: 1 }]));
        return;
      }

      // GET /environments
      if (method === 'GET' && url.pathname === '/environments') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(environments));
        return;
      }

      // GET /cards (list)
      if (method === 'GET' && url.pathname === '/cards') {
        const workspacePath = url.searchParams.get('workspacePath');
        if (!workspacePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'workspacePath query parameter is required' }));
          return;
        }
        let results = [...cards.values()];
        const status = url.searchParams.get('status');
        if (status) {
          results = results.filter((c) => c['status'] === status);
        }
        const tags = url.searchParams.getAll('tag');
        if (tags.length > 0) {
          results = results.filter(
            (c) => Array.isArray(c['tags']) && tags.every((t) => (c['tags'] as string[]).includes(t))
          );
        }
        const search = url.searchParams.get('search');
        if (search) {
          const term = search.toLowerCase();
          results = results.filter((c) => typeof c['title'] === 'string' && c['title'].toLowerCase().includes(term));
        }
        const limit = url.searchParams.get('limit');
        if (limit) {
          results = results.slice(0, parseInt(limit, 10));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
        return;
      }

      // GET /cards/:id
      const getCardMatch = url.pathname.match(/^\/cards\/([^/]+)$/);
      if (method === 'GET' && getCardMatch) {
        const cardId = getCardMatch[1]!;
        const card = cards.get(cardId);
        if (!card) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }

      // POST /cards (create)
      if (method === 'POST' && url.pathname === '/cards') {
        const body = JSON.parse(await collectBody(req)) as Record<string, unknown>;
        cardCounter++;
        const id = `test-${cardCounter}`;
        const card = {
          id,
          ...body,
          status: 'todo',
          repositoryPath: '/tmp/test-repo',
          createdAt: new Date().toISOString()
        };
        cards.set(id, card);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }

      // POST /cards/:id/branches
      const branchMatch = url.pathname.match(/^\/cards\/([^/]+)\/branches$/);
      if (method === 'POST' && branchMatch) {
        const cardId = branchMatch[1]!;
        const body = JSON.parse(await collectBody(req)) as { name: string };
        const cardBranches = branches.get(cardId) ?? [];
        cardBranches.push({ name: body.name });
        branches.set(cardId, cardBranches);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      // POST /cards/:id/commits
      const commitMatch = url.pathname.match(/^\/cards\/([^/]+)\/commits$/);
      if (method === 'POST' && commitMatch) {
        const cardId = commitMatch[1]!;
        const body = JSON.parse(await collectBody(req)) as { sha: string };
        const cardCommits = commits.get(cardId) ?? [];
        cardCommits.push(body.sha);
        commits.set(cardId, cardCommits);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sha: body.sha, cardId, createdAt: new Date().toISOString() }));
        return;
      }

      // PUT /cards/:id/fs/:path (generic file write)
      const fsMatch = url.pathname.match(/^\/cards\/([^/]+)\/fs\/(.+)$/);
      if (method === 'PUT' && fsMatch) {
        const cardId = fsMatch[1]!;
        const filePath = fsMatch[2]!;
        const raw = await collectBody(req);
        const body = JSON.parse(raw) as string;
        files.set(`${cardId}/${filePath}`, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      // POST /cards/:id/actions/:name
      const actionMatch = url.pathname.match(/^\/cards\/([^/]+)\/actions\/([^/]+)$/);
      if (method === 'POST' && actionMatch) {
        const raw = await collectBody(req);
        actionRequests.push({
          cardId: actionMatch[1]!,
          actionName: actionMatch[2]!,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(actionResult));
        return;
      }

      // GET /internal/watchers/:watcherId
      const getWatcherMatch = url.pathname.match(/^\/internal\/watchers\/([^/]+)$/);
      if (method === 'GET' && getWatcherMatch) {
        const watcherId = decodeURIComponent(getWatcherMatch[1]!);
        if (!watcherRegistryAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Watcher registry not configured' }));
          return;
        }
        const watcher = activeWatchers.get(watcherId);
        if (!watcher) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(watcher));
        return;
      }

      // DELETE /internal/cards/:cardId/watchers
      const deleteWatchersMatch = url.pathname.match(/^\/internal\/cards\/([^/]+)\/watchers$/);
      if (method === 'DELETE' && deleteWatchersMatch) {
        const cardId = deleteWatchersMatch[1]!;
        if (!watcherRegistryAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Watcher registry not configured' }));
          return;
        }
        deletedWatcherCardIds.push(cardId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(watcherDeleteResponse));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const port = (server.address() as AddressInfo).port;

    // Write discovery file pointing to test server
    writeFileSync(
      join(testDir, '.cards', 'cards-api.json'),
      JSON.stringify({
        host: 'localhost',
        port,
        accessToken: 'test-token',
        pid: 12345,
        startedAt: '2024-01-01T00:00:00Z'
      })
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    forceRemoveSync(testDir);
    delete process.env['MOCK_HOMEDIR'];
    restoreEnv('CARDS_HOME', savedCardsHome);
    restoreEnv('XDG_DATA_HOME', savedXdgDataHome);
    restoreEnv('XDG_CONFIG_HOME', savedXdgConfigHome);
  });

  describe('connectClient', () => {
    it('returns a client when discovery succeeds', async () => {
      const client = await connectClient();
      expect(client).toBeDefined();
    });

    it('throws when discovery file is missing', async () => {
      rmSync(join(testDir, '.cards', 'cards-api.json'));
      await expect(connectClient()).rejects.toThrow('API discovery failed');
    });
  });

  describe('parseCardCreateInput', () => {
    it('parses valid input with required fields', () => {
      const result = parseCardCreateInput('{"title":"Test"}');
      expect(result.data.title).toBe('Test');
      expect(result.inputKeys).toEqual(new Set(['title']));
    });

    it('parses optional fields', () => {
      const result = parseCardCreateInput(
        JSON.stringify({
          title: 'Test',
          tags: ['bug'],
          environment: 'staging',
          gates: { planRequired: true, mergeRequestRequired: false }
        })
      );
      expect(result.data.tags).toEqual(['bug']);
      expect(result.data.environment).toBe('staging');
      expect(result.data.gates).toEqual({ planRequired: true, mergeRequestRequired: false });
    });

    it('tracks all caller-provided keys in inputKeys', () => {
      const result = parseCardCreateInput(JSON.stringify({ title: 'Test', tags: ['bug'], environment: 'staging' }));
      expect(result.inputKeys).toEqual(new Set(['title', 'tags', 'environment']));
    });

    it('throws on empty input', () => {
      expect(() => parseCardCreateInput('')).toThrow('expected JSON on stdin');
    });

    it('throws on invalid JSON', () => {
      expect(() => parseCardCreateInput('{not json')).toThrow('invalid JSON');
    });

    it('throws on missing title', () => {
      expect(() => parseCardCreateInput('{"tags":["bug"]}')).toThrow('missing required field "title"');
    });

    it('throws on empty title', () => {
      expect(() => parseCardCreateInput('{"title":"  "}')).toThrow('missing required field "title"');
    });

    it('throws on a single unknown field listing it and valid fields', () => {
      expect(() => parseCardCreateInput('{"title":"Test","description":"Token refresh fails"}')).toThrow(
        'unknown fields: "description". valid fields: title, tags, environment, gates, relations'
      );
    });

    it('throws on multiple unknown fields listing them and valid fields', () => {
      expect(() => parseCardCreateInput('{"title":"Test","description":"desc","plan":"do it","extra":1}')).toThrow(
        'unknown fields: "description", "plan", "extra". valid fields: title, tags, environment, gates, relations'
      );
    });

    it('accepts all valid fields without throwing', () => {
      expect(() =>
        parseCardCreateInput(
          JSON.stringify({
            title: 'Test',
            tags: ['bug'],
            environment: 'staging',
            gates: { planRequired: true, mergeRequestRequired: false },
            relations: [{ type: 'related', cardId: 'main-001' }]
          })
        )
      ).not.toThrow();
    });
  });

  describe('getCard', () => {
    it('adds invocation-ready actions from the card environment', async () => {
      const card = { id: 'card-actions', title: 'Action Card', status: 'active', environment: 'staging' };
      cards.set('card-actions', card);
      environments = [
        {
          name: 'staging',
          actions: [
            {
              id: 'launch',
              name: 'Launch',
              description: 'Start an implementation agent',
              icon: '/workspace/icons/launch.svg',
              supportsBackgroundMode: true,
              allowConcurrent: false
            }
          ]
        }
      ];

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { getCard: getCardFn } = await import('../../src/bin/cards.js');
        await getCardFn('card-actions');
        expect(logSpy).toHaveBeenCalledWith(
          JSON.stringify(
            {
              ...card,
              actions: [
                {
                  id: 'launch',
                  name: 'Launch',
                  description: 'Start an implementation agent',
                  supportsBackgroundMode: true
                }
              ]
            },
            null,
            2
          )
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('returns an empty actions array when the card environment is unresolved', async () => {
      const card = { id: 'card-missing-env', title: 'Orphaned Card', status: 'active', environment: 'removed' };
      cards.set('card-missing-env', card);
      environments = [{ name: 'default', actions: [] }];

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { getCard: getCardFn } = await import('../../src/bin/cards.js');
        await getCardFn('card-missing-env');
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ...card, actions: [] }, null, 2));
      } finally {
        logSpy.mockRestore();
      }
    });

    it('applies JSONPath after enriching the card with actions', async () => {
      cards.set('card-action-path', {
        id: 'card-action-path',
        title: 'Path Card',
        status: 'active',
        environment: 'default'
      });
      environments = [{ name: 'default', actions: [{ id: 'review', name: 'Review' }] }];

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { getCard: getCardFn } = await import('../../src/bin/cards.js');
        await getCardFn('card-action-path', '$.actions');
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify([{ id: 'review', name: 'Review' }], null, 2));
      } finally {
        logSpy.mockRestore();
      }
    });

    it('fetches and prints card JSON to stdout', async () => {
      const card = { id: 'card-1', title: 'Test Card', status: 'todo' };
      cards.set('card-1', card);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { getCard: getCardFn } = await import('../../src/bin/cards.js');
        await getCardFn('card-1');
        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ...card, actions: [] }, null, 2));
      } finally {
        logSpy.mockRestore();
      }
    });

    it('applies JSONPath expression and prints scalar raw', async () => {
      const card = { id: 'card-2', title: 'Test', repositoryPath: '/repos/card-2' };
      cards.set('card-2', card);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { getCard: getCardFn } = await import('../../src/bin/cards.js');
        await getCardFn('card-2', '$.repositoryPath');
        expect(logSpy).toHaveBeenCalledWith('/repos/card-2');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('applyJsonPath', () => {
    it('returns scalar string raw for single match', () => {
      expect(applyJsonPath({ repositoryPath: '/x' }, '$.repositoryPath')).toBe('/x');
    });

    it('serializes object results as pretty JSON', () => {
      expect(applyJsonPath({ gates: { planRequired: true } }, '$.gates')).toBe(
        JSON.stringify({ planRequired: true }, null, 2)
      );
    });

    it('returns array of matches for multi-match expressions', () => {
      const result = applyJsonPath({ items: [{ n: 1 }, { n: 2 }] }, '$.items[*].n');
      expect(result).toBe(JSON.stringify([1, 2], null, 2));
    });

    it('stringifies numeric and boolean scalars', () => {
      expect(applyJsonPath({ n: 42 }, '$.n')).toBe('42');
      expect(applyJsonPath({ b: true }, '$.b')).toBe('true');
    });
  });

  describe('executeAction', () => {
    it('calls server and prints result to stdout', async () => {
      cards.set('card-1', { id: 'card-1', title: 'Test', status: 'todo' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await executeAction('card-1', 'launch');
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as { success: boolean; exitCode: number };
        expect(output.success).toBe(true);
        expect(output.exitCode).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('omits the request body when no execution mode is given', async () => {
      cards.set('card-1', { id: 'card-1', title: 'Test', status: 'todo' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await executeAction('card-1', 'launch');
        expect(actionRequests).toEqual([{ cardId: 'card-1', actionName: 'launch', body: undefined }]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('sends "background" mode in the request body when background is set', async () => {
      cards.set('card-1', { id: 'card-1', title: 'Test', status: 'todo' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await executeAction('card-1', 'launch', { background: true });
        expect(actionRequests).toEqual([{ cardId: 'card-1', actionName: 'launch', body: { mode: 'background' } }]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('sends exitWhenDone in the request body when exit-when-done is set', async () => {
      cards.set('card-1', { id: 'card-1', title: 'Test', status: 'todo' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await executeAction('card-1', 'launch', { exitWhenDone: true });
        expect(actionRequests).toEqual([{ cardId: 'card-1', actionName: 'launch', body: { exitWhenDone: true } }]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('combines background and exitWhenDone in the request body', async () => {
      cards.set('card-1', { id: 'card-1', title: 'Test', status: 'todo' });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await executeAction('card-1', 'launch', { background: true, exitWhenDone: true });
        expect(actionRequests).toEqual([
          { cardId: 'card-1', actionName: 'launch', body: { mode: 'background', exitWhenDone: true } }
        ]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('forwards an explicit coding agent with the other action options', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await executeAction('card-1', 'launch', {
          background: true,
          exitWhenDone: true,
          selectedAgent: 'opencode-cli'
        });
        expect(actionRequests).toEqual([
          {
            cardId: 'card-1',
            actionName: 'launch',
            body: { mode: 'background', exitWhenDone: true, selectedAgent: 'opencode-cli' }
          }
        ]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('sets a non-zero process exit status when an explicit-agent action fails', async () => {
      const originalExitCode = process.exitCode;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      actionResult = { success: false, exitCode: 0, error: 'codex-cli is unavailable' };
      try {
        await executeAction('card-1', 'launch', { selectedAgent: 'codex-cli' });
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = originalExitCode;
        logSpy.mockRestore();
      }
    });

    it('leaves process exit status unchanged for a failed default-agent action', async () => {
      const originalExitCode = process.exitCode;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      actionResult = { success: false, exitCode: 0, error: 'default launch failed' };
      try {
        await executeAction('card-1', 'launch');
        expect(process.exitCode).toBe(originalExitCode);
      } finally {
        process.exitCode = originalExitCode;
        logSpy.mockRestore();
      }
    });
  });

  describe('listCards', () => {
    it('lists all cards for a workspace path', async () => {
      cards.set('card-1', { id: 'card-1', title: 'First', status: 'todo', tags: [] });
      cards.set('card-2', { id: 'card-2', title: 'Second', status: 'active', tags: ['bug'] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await listCards(['--workspace-path', '/tmp/workspace']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as unknown[];
        expect(output).toHaveLength(2);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('filters by status', async () => {
      cards.set('card-1', { id: 'card-1', title: 'First', status: 'todo', tags: [] });
      cards.set('card-2', { id: 'card-2', title: 'Second', status: 'active', tags: [] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await listCards(['--workspace-path', '/tmp/workspace', '--status', 'todo']);
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string }>;
        expect(output).toHaveLength(1);
        expect(output[0]!.id).toBe('card-1');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('respects limit', async () => {
      cards.set('card-1', { id: 'card-1', title: 'First', status: 'todo', tags: [] });
      cards.set('card-2', { id: 'card-2', title: 'Second', status: 'todo', tags: [] });
      cards.set('card-3', { id: 'card-3', title: 'Third', status: 'todo', tags: [] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await listCards(['--workspace-path', '/tmp/workspace', '--limit', '2']);
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as unknown[];
        expect(output).toHaveLength(2);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('throws on missing workspace path when not in git repo', async () => {
      const origCwd = process.cwd();
      try {
        process.chdir('/tmp');
        await expect(listCards([])).rejects.toThrow('could not detect workspace path');
      } finally {
        process.chdir(origCwd);
      }
    });

    it('throws on invalid limit', async () => {
      await expect(listCards(['--workspace-path', '/tmp', '--limit', 'abc'])).rejects.toThrow(
        '--limit must be a positive integer'
      );
    });

    it('throws on invalid offset', async () => {
      await expect(listCards(['--workspace-path', '/tmp', '--offset', '-1'])).rejects.toThrow(
        '--offset must be a non-negative integer'
      );
    });
  });

  describe('listVariableGroups', () => {
    it('routes the exact variable-group list spelling', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await variableGroupCommand(['list', '--workspace-path', '/tmp/workspace']);
        expect(variableGroupWorkspacePaths).toEqual(['/tmp/workspace']);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('prints JSON and passes an explicit workspace override to discovery', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await listVariableGroups(['--workspace-path', '/tmp/workspace with spaces']);
        expect(variableGroupWorkspacePaths).toEqual(['/tmp/workspace with spaces']);
        expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual([
          { id: 'shared-tools', name: 'Shared tools', variableCount: 2, secretCount: 1 }
        ]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('detects the current git workspace when no override is supplied', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await listVariableGroups([]);
        const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        expect(variableGroupWorkspacePaths).toEqual([realpathSync(gitRoot)]);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('surfaces discovery failures', async () => {
      variableGroupRequestFails = true;
      await expect(listVariableGroups(['--workspace-path', '/tmp/workspace'])).rejects.toThrow(
        'Variable group discovery unavailable'
      );
    });
  });

  describe('searchCards', () => {
    it('passes text query to server as search parameter', async () => {
      cards.set('card-1', {
        id: 'card-1',
        title: 'Login Bug',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });
      cards.set('card-2', {
        id: 'card-2',
        title: 'Unrelated Feature',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await searchCards(['login bug', '--workspace-path', '/tmp/workspace']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string }>;
        expect(output).toHaveLength(1);
        expect(output[0]!.id).toBe('card-1');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('sends stored tags to server and filters results', async () => {
      cards.set('card-1', {
        id: 'card-1',
        title: 'Bug Report',
        status: 'todo',
        tags: ['bug'],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });
      cards.set('card-2', {
        id: 'card-2',
        title: 'Feature Request',
        status: 'todo',
        tags: ['feature'],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await searchCards(['#bug', '--workspace-path', '/tmp/workspace']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string }>;
        expect(output).toHaveLength(1);
        expect(output[0]!.id).toBe('card-1');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('applies derived tag filtering client-side', async () => {
      cards.set('card-1', {
        id: 'card-1',
        title: 'Planning Card',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: true, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });
      cards.set('card-2', {
        id: 'card-2',
        title: 'Normal Card',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // 'planning' is a derived tag — not sent to server, filtered client-side
        await searchCards(['#planning', '--workspace-path', '/tmp/workspace']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string }>;
        expect(output).toHaveLength(1);
        expect(output[0]!.id).toBe('card-1');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('applies @relation filtering client-side', async () => {
      cards.set('card-1', {
        id: 'card-1',
        title: 'Related',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [{ type: 'related', cardId: 'card-2' }],
        incomingRelations: []
      });
      cards.set('card-2', {
        id: 'card-2',
        title: 'Target',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: [{ type: 'related', cardId: 'card-1' }]
      });
      cards.set('card-3', {
        id: 'card-3',
        title: 'Unrelated',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await searchCards(['@card-2', '--workspace-path', '/tmp/workspace']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string }>;
        const ids = output.map((c) => c.id).sort();
        expect(ids).toEqual(['card-1', 'card-2']);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('passes --status and --limit flags through to server', async () => {
      cards.set('card-1', {
        id: 'card-1',
        title: 'First',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });
      cards.set('card-2', {
        id: 'card-2',
        title: 'Second',
        status: 'active',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });
      cards.set('card-3', {
        id: 'card-3',
        title: 'Third',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await searchCards(['--workspace-path', '/tmp/workspace', '--status', 'todo', '--limit', '1']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string; status: string }>;
        expect(output).toHaveLength(1);
        expect(output[0]!.status).toBe('todo');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('returns all cards when called with no query', async () => {
      cards.set('card-1', {
        id: 'card-1',
        title: 'First',
        status: 'todo',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });
      cards.set('card-2', {
        id: 'card-2',
        title: 'Second',
        status: 'active',
        tags: [],
        isPinned: false,
        order: 0,
        repositoryId: 'test',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        gates: { planRequired: false, planApproved: false, mergeRequestRequired: false, mergeApproved: false },
        isMerged: null,
        relations: [],
        incomingRelations: []
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await searchCards(['--workspace-path', '/tmp/workspace']);
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ id: string }>;
        expect(output).toHaveLength(2);
        // Output is CardListSummary objects with flattened gate fields
        const first = output[0] as Record<string, unknown>;
        expect(first).toHaveProperty('planRequired');
        expect(first).toHaveProperty('planApproved');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('help mechanisms', () => {
    const cardBinPath = fileURLToPath(new URL('../../src/bin/cards.ts', import.meta.url));

    function runCard(args: string[]): { stdout: string; stderr: string; exitCode: number } {
      try {
        const stdout = execFileSync(process.execPath, [tsxCli, cardBinPath, ...args], {
          encoding: 'utf8'
        });
        return { stdout, stderr: '', exitCode: 0 };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; status?: number };
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 };
      }
    }

    it('card help prints help text and exits 0', () => {
      const result = runCard(['help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: card');
    });

    it('card list --help prints help text and exits 0', () => {
      const result = runCard(['list', '--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: card');
    });

    it('card search -h prints help text and exits 0', () => {
      const result = runCard(['search', '-h']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: card');
    });

    it('action help lists the coding-agent flag and supported IDs', () => {
      const result = runCard(['card-1', 'action', '--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--agent <id>');
      expect(result.stdout).toContain('claude-code-cli, codex-cli, opencode-cli, or antigravity-cli');
    });

    it('rejects a missing coding-agent value before API discovery', () => {
      const result = runCard(['card-1', 'action', 'launch', '--agent']);
      expect(result).toEqual({ stdout: '', stderr: 'card: flag --agent requires a value\n', exitCode: 1 });
    });

    it('does not consume a following flag as the coding-agent value', () => {
      const result = runCard(['card-1', 'action', 'launch', '--agent', '--background']);
      expect(result).toEqual({ stdout: '', stderr: 'card: flag --agent requires a value\n', exitCode: 1 });
    });

    it('rejects an unknown coding agent before API discovery', () => {
      const result = runCard(['card-1', 'action', 'launch', '--agent', 'unknown-cli']);
      expect(result).toEqual({
        stdout: '',
        stderr:
          'card: invalid coding agent "unknown-cli"; expected one of: claude-code-cli, codex-cli, opencode-cli, antigravity-cli\n',
        exitCode: 1
      });
    });
  });

  describe('createCard', () => {
    /**
     * Replaces process.stdin with a Readable that emits the given string,
     * calls the async function, then restores the original stdin.
     *
     * @param input - String to push onto the fake stdin stream.
     * @param fn - Async function to execute while stdin is replaced.
     * @returns The result of `fn`.
     */
    async function withStdin<T>(input: string, fn: () => Promise<T>): Promise<T> {
      const original = process.stdin;
      const fake = new Readable({ read() {} });
      Object.defineProperty(process, 'stdin', { value: fake, writable: true, configurable: true });
      fake.push(input);
      fake.push(null);
      try {
        return await fn();
      } finally {
        Object.defineProperty(process, 'stdin', { value: original, writable: true, configurable: true });
      }
    }

    // The ambient-cwd createCard tests below assume resolveBindTarget's
    // cwd-primary leg finds NO linked worktree (so creation is untracked and
    // prints the result JSON). That holds in a normal checkout, but `yarn
    // validate` can run from inside a linked git worktree (git-dir ≠
    // common-dir), where the bind gate instead refuses for lack of a recorded
    // parent branch and createCard prints nothing. Pin cwd to a non-git temp
    // dir so these tests are independent of where the suite is invoked. The
    // nested "worktree binding" describe chdirs into its own real repos and
    // restores to this pinned cwd via its own afterEach.
    let createCwdOrig: string;
    let createCwdTmp: string;
    beforeEach(() => {
      createCwdOrig = process.cwd();
      createCwdTmp = realpathSync(mkdtempSync(join(realTmpdir(), 'card-bin-create-')));
      process.chdir(createCwdTmp);
    });
    afterEach(() => {
      process.chdir(createCwdOrig);
      forceRemoveSync(createCwdTmp);
    });

    it('returns only server-generated fields plus repositoryPath', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await withStdin(JSON.stringify({ title: 'Test', tags: ['bug'] }), () =>
          createCard(['--workspace-path', '/tmp/workspace'])
        );
        expect(logSpy).toHaveBeenCalledOnce();
        const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
        // Server-generated fields present
        expect(output['id']).toBe('test-1');
        expect(output['status']).toBe('todo');
        expect(output['repositoryPath']).toBe('/tmp/test-repo');
        expect(output['createdAt']).toBeDefined();
        // Caller-provided fields omitted
        expect(output).not.toHaveProperty('title');
        expect(output).not.toHaveProperty('tags');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('does not write any files to the card repository', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await withStdin(JSON.stringify({ title: 'Test', tags: ['bug'] }), () =>
          createCard(['--workspace-path', '/tmp/workspace'])
        );
        expect(files.size).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    });

    describe('worktree binding', () => {
      /** A main repo + linked worktree createCard is invoked from in binding tests. */
      let base: string;
      let mainRepo: string;
      let linkedWorktree: string;
      let origCwd: string;
      let savedSessionId: string | undefined;
      let savedTranscript: string | undefined;
      let savedExitCode: typeof process.exitCode;

      /**
       * Creates a real linked git worktree (git-dir ≠ common-dir) so the
       * cwd-primary leg of resolveBindTarget treats it as a bind target. Records
       * `branch.<name>.cardsParent` so parent-branch resolution succeeds.
       */
      function makeLinkedWorktree(): void {
        mainRepo = join(base, 'main');
        execFileSync('git', ['init', '-q', '-b', 'main', mainRepo]);
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: mainRepo });
        const linkedRaw = join(base, 'linked');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/x', linkedRaw], { cwd: mainRepo });
        // Use the git-canonical toplevel — the path resolveBindTarget records.
        // git resolves symlinks like realpath, so deriving it via `git rev-parse
        // --show-toplevel` matches the resolved identity. resolveBindTarget then
        // normalizes that output with `path.resolve` (git emits forward slashes
        // on Windows; the production code converts to a native path so it
        // compares equal to fs paths), so apply the same `resolve` here.
        linkedWorktree = resolve(
          execFileSync('git', ['-C', linkedRaw, 'rev-parse', '--show-toplevel'], {
            encoding: 'utf8'
          }).trim()
        );
        execFileSync('git', ['config', 'branch.feature/x.cardsParent', 'main'], { cwd: linkedWorktree });
      }

      beforeEach(() => {
        origCwd = process.cwd();
        savedSessionId = process.env['CARDS_SESSION_ID'];
        savedTranscript = process.env['CARDS_TRANSCRIPT_PATH'];
        savedExitCode = process.exitCode;
        base = realpathSync(
          (() => {
            const b = join(realTmpdir(), `card-bin-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            mkdirSync(b, { recursive: true });
            return b;
          })()
        );
        outfitWorktreeForCard.mockClear();
        outfitWorktreeForCard.mockResolvedValue(undefined);
        readUnboundCandidates.mockClear();
        readUnboundCandidates.mockResolvedValue([]);
        removeUnboundCandidate.mockClear();
      });

      afterEach(() => {
        process.chdir(origCwd);
        restoreEnv('CARDS_SESSION_ID', savedSessionId);
        restoreEnv('CARDS_TRANSCRIPT_PATH', savedTranscript);
        process.exitCode = savedExitCode;
        forceRemoveSync(base);
      });

      it('creates an untracked card without binding when cwd is the main worktree (not linked)', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-no-marker';
        try {
          makeLinkedWorktree();
          // Run from the MAIN worktree — git-dir equals common-dir, so it is
          // never a bind target, and the candidate set is empty.
          process.chdir(mainRepo);
          await withStdin(JSON.stringify({ title: 'Planning card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );
          expect(outfitWorktreeForCard).not.toHaveBeenCalled();
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });

      it('outfits the worktree (cwd-primary) with the binder env session + resolved parent branch', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-bind-ok';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/transcript.jsonl';
        try {
          makeLinkedWorktree();
          process.chdir(linkedWorktree);
          await withStdin(JSON.stringify({ title: 'Bound card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
          const [, boundDir, outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
            unknown,
            string,
            { cardId: string; parentBranch: string; sessionId: string; transcriptPath: string }
          ];
          expect(boundDir).toBe(linkedWorktree);
          expect(outfitOptions.cardId).toBe('test-1');
          expect(outfitOptions.parentBranch).toBe('main');
          expect(outfitOptions.sessionId).toBe('sess-bind-ok');
          expect(outfitOptions.transcriptPath).toBe('/tmp/transcript.jsonl');

          // stdout payload remains the create-result JSON.
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });

      it('cwd-primary binds with degraded (empty) transcript when no env var and no candidate record', async () => {
        // Regression: the old code refused when CARDS_SESSION_ID / CARDS_TRANSCRIPT_PATH were
        // absent. The new code resolves sessionId via the full chain (including PID fallback)
        // and resolves transcriptPath from CARDS_TRANSCRIPT_PATH → unbound-candidate → ''.
        // With no env var and no candidate, transcriptPath is '' and outfit is called with it.
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env['CARDS_SESSION_ID'];
        delete process.env['CARDS_TRANSCRIPT_PATH'];
        // No candidate for the cwd worktree: readUnboundCandidates returns [].
        readUnboundCandidates.mockResolvedValue([]);
        try {
          makeLinkedWorktree();
          process.chdir(linkedWorktree);
          await withStdin(JSON.stringify({ title: 'Degraded card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          // Card is minted and outfit is called; transcript streaming is degraded (empty path).
          expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
          const [, boundDir, outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
            unknown,
            string,
            { transcriptPath: string; sessionId: string }
          ];
          expect(boundDir).toBe(linkedWorktree);
          expect(outfitOptions.transcriptPath).toBe('');
          // sessionId is still resolved (PID-based fallback).
          expect(typeof outfitOptions.sessionId).toBe('string');
          expect(outfitOptions.sessionId.length).toBeGreaterThan(0);
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });

      it('cwd-primary falls back to candidate record when CARDS_TRANSCRIPT_PATH is absent', async () => {
        // Regression: previously, absent CARDS_TRANSCRIPT_PATH was a hard refuse. Now Leg 1
        // calls resolveTranscriptPath() which falls back to the unbound-candidate record.
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-leg1-fallback';
        delete process.env['CARDS_TRANSCRIPT_PATH'];
        try {
          makeLinkedWorktree();
          // A candidate record for the cwd worktree carries the transcript path.
          readUnboundCandidates.mockResolvedValue([
            {
              worktreeDir: linkedWorktree,
              sessionId: 'sess-leg1-fallback',
              transcriptPath: '/tmp/candidate-transcript.jsonl'
            }
          ]);
          process.chdir(linkedWorktree);
          await withStdin(JSON.stringify({ title: 'Fallback-from-candidate card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
          const [, boundDir, outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
            unknown,
            string,
            { transcriptPath: string; sessionId: string }
          ];
          expect(boundDir).toBe(linkedWorktree);
          // Transcript path comes from the candidate record, not the env var.
          expect(outfitOptions.transcriptPath).toBe('/tmp/candidate-transcript.jsonl');
          expect(outfitOptions.sessionId).toBe('sess-leg1-fallback');
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });

      it('creates an untracked card (no outfit) when the cwd linked worktree is already bound', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-current';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/transcript.jsonl';
        try {
          makeLinkedWorktree();
          mkdirSync(join(linkedWorktree, '.cards'), { recursive: true });
          writeFileSync(join(linkedWorktree, '.cards', 'CARD_ID'), 'main-007');
          process.chdir(linkedWorktree);
          await withStdin(JSON.stringify({ title: 'Untracked nested card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          // CARD_ID precedence (main-126): no outfit, untracked card created.
          expect(outfitWorktreeForCard).not.toHaveBeenCalled();
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });

      it('cwd-primary wins: binds the cwd worktree and ignores the candidate set entirely', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-cwd-primary';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/binder-transcript.jsonl';
        try {
          makeLinkedWorktree();
          // A DIFFERENT worktree is registered in the candidate set for this
          // session. The cwd-primary leg must win, so this entry is never read:
          // the bind targets the cwd worktree and the candidate is left in place.
          readUnboundCandidates.mockResolvedValue([
            { worktreeDir: '/wt/other-candidate', sessionId: 'sess-cwd-primary', transcriptPath: '/tmp/other.jsonl' }
          ]);
          process.chdir(linkedWorktree);
          await withStdin(JSON.stringify({ title: 'Cwd-primary card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
          const [, boundDir, outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
            unknown,
            string,
            { parentBranch: string; sessionId: string; transcriptPath: string }
          ];
          // The cwd worktree wins, not the candidate-set entry.
          expect(boundDir).toBe(linkedWorktree);
          // The cwd-primary leg uses the binder's OWN env transcript, not the
          // candidate's recorded transcript — proving the candidate was not read.
          expect(outfitOptions.transcriptPath).toBe('/tmp/binder-transcript.jsonl');
          expect(outfitOptions.parentBranch).toBe('main');
          // Post-bind cleanup drops the bound worktree (the cwd one), NEVER the
          // unrelated candidate-set entry — proving the candidate leg was skipped.
          expect(removeUnboundCandidate).toHaveBeenCalledWith('sess-cwd-primary', linkedWorktree);
          const removedDirs = removeUnboundCandidate.mock.calls.map((c) => c[1]);
          expect(removedDirs).not.toContain('/wt/other-candidate');
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });

      it('candidate-set fallback: single same-session candidate binds with a loud stderr notice', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-fallback';
        // No CARDS_TRANSCRIPT_PATH: resolveTranscriptPath falls through to the
        // candidate record, which carries the transcript recorded at worktree creation.
        delete process.env['CARDS_TRANSCRIPT_PATH'];
        try {
          makeLinkedWorktree();
          // The candidate is the linked worktree, but the binder runs from the
          // MAIN repo (not inside the worktree), so the fallback leg is taken.
          readUnboundCandidates.mockResolvedValue([
            { worktreeDir: linkedWorktree, sessionId: 'sess-fallback', transcriptPath: '/tmp/cand-transcript.jsonl' }
          ]);
          process.chdir(mainRepo);
          await withStdin(JSON.stringify({ title: 'Fallback card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
          const [, boundDir, outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
            unknown,
            string,
            { cardId: string; parentBranch: string; sessionId: string; transcriptPath: string }
          ];
          expect(boundDir).toBe(linkedWorktree);
          // The candidate's own transcript is used (it was recorded at worktree create time).
          expect(outfitOptions.transcriptPath).toBe('/tmp/cand-transcript.jsonl');
          expect(outfitOptions.sessionId).toBe('sess-fallback');
          // Candidate removed on success.
          expect(removeUnboundCandidate).toHaveBeenCalledWith('sess-fallback', linkedWorktree);
          // Loud stderr notice naming the worktree.
          const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
          expect(diagnostic).toContain(linkedWorktree);
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          errSpy.mockRestore();
          logSpy.mockRestore();
        }
      });

      it('candidate-set fallback: 2+ candidates refuse-and-list, no card minted', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-ambiguous';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/binder-transcript.jsonl';
        try {
          mainRepo = join(base, 'main');
          execFileSync('git', ['init', '-q', '-b', 'main', mainRepo]);
          readUnboundCandidates.mockResolvedValue([
            { worktreeDir: '/wt/one', sessionId: 'sess-ambiguous', transcriptPath: '/tmp/t1.jsonl' },
            { worktreeDir: '/wt/two', sessionId: 'sess-ambiguous', transcriptPath: '/tmp/t2.jsonl' }
          ]);
          process.chdir(mainRepo);
          await withStdin(JSON.stringify({ title: 'Ambiguous card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          expect(cards.size).toBe(0);
          expect(outfitWorktreeForCard).not.toHaveBeenCalled();
          expect(process.exitCode).not.toBe(0);
          expect(logSpy).not.toHaveBeenCalled();
          const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
          expect(diagnostic).toContain('/wt/one');
          expect(diagnostic).toContain('/wt/two');
        } finally {
          errSpy.mockRestore();
          logSpy.mockRestore();
        }
      });

      it('candidate-set fallback: wrong-session candidates are filtered out (untracked card)', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env['CARDS_SESSION_ID'] = 'sess-binder';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/binder-transcript.jsonl';
        try {
          mainRepo = join(base, 'main');
          execFileSync('git', ['init', '-q', '-b', 'main', mainRepo]);
          readUnboundCandidates.mockResolvedValue([
            { worktreeDir: '/wt/other', sessionId: 'sess-someone-else', transcriptPath: '/tmp/t.jsonl' }
          ]);
          process.chdir(mainRepo);
          await withStdin(JSON.stringify({ title: 'Untracked card' }), () =>
            createCard(['--workspace-path', '/tmp/workspace'])
          );

          // No same-session candidate → untracked card, no outfit.
          expect(outfitWorktreeForCard).not.toHaveBeenCalled();
          const output = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
          expect(output['id']).toBe('test-1');
        } finally {
          logSpy.mockRestore();
        }
      });
    });
  });

  describe('attachCard', () => {
    /** A main repo + linked worktree that attachCard is invoked from in binding tests. */
    let base: string;
    let mainRepo: string;
    let linkedWorktree: string;
    let origCwd: string;
    let savedSessionId: string | undefined;
    let savedTranscript: string | undefined;
    /** Spy on process.exit so gate failures throw instead of killing the process. */
    let exitSpy: ReturnType<typeof vi.spyOn>;

    /**
     * Creates a real linked git worktree (git-dir ≠ common-dir) so
     * resolveLinkedWorktreeDir treats it as a bind target. Records
     * `branch.<name>.cardsParent` so parent-branch resolution succeeds.
     *
     * @param root0 - Options object.
     * @param root0.withParentConfig - Whether to configure `cardsParent` for the branch (default: true).
     */
    function makeLinkedWorktree({ withParentConfig = true }: { withParentConfig?: boolean } = {}): void {
      mainRepo = join(base, 'main');
      execFileSync('git', ['init', '-q', '-b', 'main', mainRepo]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: mainRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: mainRepo });
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: mainRepo });
      const linkedRaw = join(base, 'linked');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/bind', linkedRaw], { cwd: mainRepo });
      // Use the git-canonical toplevel — the path resolveBindTarget records.
      // git resolves symlinks like realpath, so deriving it via `git rev-parse
      // --show-toplevel` matches the resolved identity. resolveBindTarget then
      // normalizes that output with `path.resolve` (git emits forward slashes
      // on Windows; the production code converts to a native path so it
      // compares equal to fs paths), so apply the same `resolve` here.
      linkedWorktree = resolve(
        execFileSync('git', ['-C', linkedRaw, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8'
        }).trim()
      );
      if (withParentConfig) {
        execFileSync('git', ['config', 'branch.feature/bind.cardsParent', 'main'], { cwd: linkedWorktree });
      }
    }

    beforeEach(() => {
      origCwd = process.cwd();
      savedSessionId = process.env['CARDS_SESSION_ID'];
      savedTranscript = process.env['CARDS_TRANSCRIPT_PATH'];
      base = realpathSync(
        (() => {
          const b = join(realTmpdir(), `card-bin-bind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
          mkdirSync(b, { recursive: true });
          return b;
        })()
      );
      outfitWorktreeForCard.mockClear();
      outfitWorktreeForCard.mockResolvedValue(undefined);
      removeUnboundCandidate.mockClear();
      readUnboundCandidates.mockClear();
      readUnboundCandidates.mockResolvedValue([]);
      // Stub process.exit so gate failures throw instead of killing the test process.
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`);
      });
    });

    afterEach(() => {
      exitSpy.mockRestore();
      // Post-connection gates set `process.exitCode` (instead of a libuv-racing
      // synchronous `process.exit`) and return; clear it so it does not leak
      // into sibling tests or fail the runner with a non-zero exit.
      process.exitCode = undefined;
      process.chdir(origCwd);
      restoreEnv('CARDS_SESSION_ID', savedSessionId);
      restoreEnv('CARDS_TRANSCRIPT_PATH', savedTranscript);
      forceRemoveSync(base);
    });

    it('Gate 1: refuses with exit 1 when cwd is the main worktree (not a linked worktree)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        makeLinkedWorktree();
        process.chdir(mainRepo);
        await expect(attachCard('main-001')).rejects.toThrow('process.exit(1)');
        const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(diagnostic).toContain('not in a linked worktree');
        expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });

    it('Gate 2: refuses with exit 1 and names the existing card when worktree is already bound', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        makeLinkedWorktree();
        mkdirSync(join(linkedWorktree, '.cards'), { recursive: true });
        writeFileSync(join(linkedWorktree, '.cards', 'CARD_ID'), 'main-007\n');
        process.chdir(linkedWorktree);
        process.env['CARDS_SESSION_ID'] = 'sess-gate2';
        await expect(attachCard('main-001')).rejects.toThrow('process.exit(1)');
        const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(diagnostic).toContain('already bound to card main-007');
        expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });

    it('Gate 3: refuses with exit code 1 when the card is not found in the API', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        makeLinkedWorktree();
        process.chdir(linkedWorktree);
        process.env['CARDS_SESSION_ID'] = 'sess-gate3';
        // 'nonexistent-card' is not in the test server's card map. Gate 3 runs
        // AFTER `connectClient()` opens a CardsClient socket, so it must set
        // `process.exitCode` and return (not synchronously `process.exit`, which
        // races libuv teardown → 0xC0000409 on Windows). The function resolves.
        await expect(attachCard('nonexistent-card')).resolves.toBeUndefined();
        expect(process.exitCode).toBe(1);
        const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(diagnostic).toContain('card "nonexistent-card" not found');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });

    it('Gate 4: refuses with exit code 1 when no parent branch can be determined', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // withParentConfig=false: branch.feature/bind.cardsParent is not set,
        // and no --parent-branch flag is passed, so resolution refuses.
        makeLinkedWorktree({ withParentConfig: false });
        cards.set('main-001', { id: 'main-001', title: 'Bind Target', status: 'active', repositoryPath: '/tmp/repo' });
        process.chdir(linkedWorktree);
        process.env['CARDS_SESSION_ID'] = 'sess-gate4';
        // Gate 4 is also post-connection: set exit code + return, not process.exit.
        await expect(attachCard('main-001')).resolves.toBeUndefined();
        expect(process.exitCode).toBe(1);
        const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        // The gate 4 message begins with 'cards attach:' and contains the refusal reason.
        expect(diagnostic).toMatch(/cards attach:/);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(outfitWorktreeForCard).not.toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });

    it('success: outfits worktree, outputs context blocks, and removes candidate record', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        makeLinkedWorktree();
        cards.set('main-001', {
          id: 'main-001',
          title: 'Bind Target',
          status: 'active',
          repositoryPath: '/tmp/test-card-repo'
        });
        process.chdir(linkedWorktree);
        process.env['CARDS_SESSION_ID'] = 'sess-bind-success';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/transcript.jsonl';

        await attachCard('main-001');

        expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
        const [, boundDir, outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
          unknown,
          string,
          { cardId: string; parentBranch: string; sessionId: string; transcriptPath: string }
        ];
        expect(boundDir).toBe(linkedWorktree);
        expect(outfitOptions.cardId).toBe('main-001');
        expect(outfitOptions.parentBranch).toBe('main');
        expect(outfitOptions.sessionId).toBe('sess-bind-success');
        expect(outfitOptions.transcriptPath).toBe('/tmp/transcript.jsonl');
        // Candidate record removed after successful bind.
        expect(removeUnboundCandidate).toHaveBeenCalledWith('sess-bind-success', linkedWorktree);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('success with --parent-branch override: uses the supplied branch instead of git config', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // withParentConfig=false to prove the override bypasses git config lookup.
        makeLinkedWorktree({ withParentConfig: false });
        cards.set('main-002', {
          id: 'main-002',
          title: 'Override Target',
          status: 'active',
          repositoryPath: '/tmp/test-card-repo'
        });
        process.chdir(linkedWorktree);
        process.env['CARDS_SESSION_ID'] = 'sess-parent-override';
        process.env['CARDS_TRANSCRIPT_PATH'] = '/tmp/transcript.jsonl';

        await attachCard('main-002', 'main');

        expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
        const [, , outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
          unknown,
          string,
          { cardId: string; parentBranch: string }
        ];
        expect(outfitOptions.cardId).toBe('main-002');
        expect(outfitOptions.parentBranch).toBe('main');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('success with degraded transcript: emits warning to stderr and still outfits', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        makeLinkedWorktree();
        cards.set('main-003', {
          id: 'main-003',
          title: 'Degraded Target',
          status: 'active',
          repositoryPath: '/tmp/test-card-repo'
        });
        process.chdir(linkedWorktree);
        process.env['CARDS_SESSION_ID'] = 'sess-degraded';
        // No CARDS_TRANSCRIPT_PATH and no candidate record → degraded path.
        delete process.env['CARDS_TRANSCRIPT_PATH'];
        readUnboundCandidates.mockResolvedValue([]);

        await attachCard('main-003');

        // outfit is still called (degraded, not refused).
        expect(outfitWorktreeForCard).toHaveBeenCalledOnce();
        const [, , outfitOptions] = outfitWorktreeForCard.mock.calls[0]! as [
          unknown,
          string,
          { transcriptPath: string }
        ];
        expect(outfitOptions.transcriptPath).toBe('');
        // Warning emitted to stderr.
        const diagnostic = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(diagnostic).toContain('transcript path could not be resolved');
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });
});

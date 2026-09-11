import { PLANS_PREFIX } from '@cards.management/sdk/card-repo-layout';
import { TestHttpClient } from '@cards.management/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardsClient } from '../../src/client/cardsClient.js';
import { ApiError } from '../../src/client/types/errors.js';
import type { EnvironmentsResponse, StreamMeta, VariableGroupsResponse } from '../../src/protocol/index.js';

/**
 * Exercises cards client behavior in the client area through focused scenarios.
 * The cases lock in edge handling and regression coverage so refactors preserve expected state
 * transitions and output.
 *
 * @summary Tests cards client behavior in client
 */

describe('CardsClient', () => {
  const options = {
    baseUrl: 'http://localhost:3000',
    accessToken: 'test-token'
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and configuration', () => {
    it('should create client without DI (backward compatible)', () => {
      const client = new CardsClient(options);
      expect(client).toBeInstanceOf(CardsClient);
    });

    it('should create client with HttpClient injection', () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      expect(client).toBeInstanceOf(CardsClient);
    });

    it('should return false from hasHttpClient when no client injected', () => {
      const client = new CardsClient(options);
      expect(client.hasHttpClient()).toBe(false);
    });

    it('should return true from hasHttpClient when client injected', () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      expect(client.hasHttpClient()).toBe(true);
    });

    it('should return configured base URL', () => {
      const client = new CardsClient(options);
      expect(client.getBaseUrl()).toBe('http://localhost:3000');
    });
  });

  describe('Variable Group Operations', () => {
    it.skip('GETs safe variable-group summaries for the encoded configured workspace', async () => {
      const httpClient = new TestHttpClient();
      const expected: VariableGroupsResponse = [
        {
          id: 'shared-tools',
          name: 'Shared tools',
          description: 'Common tool credentials',
          variableCount: 2,
          secretCount: 1
        }
      ];
      const workspacePath = '/workspace/project with spaces';
      httpClient.responses.set(
        `http://localhost:3000/variable-groups?workspacePath=${encodeURIComponent(workspacePath)}`,
        expected
      );
      const client = new CardsClient({ ...options, workspacePath }, httpClient);

      await expect(client.listVariableGroups()).resolves.toEqual(expected);
      expect(httpClient.requests).toEqual([
        {
          method: 'GET',
          url: `http://localhost:3000/variable-groups?workspacePath=${encodeURIComponent(workspacePath)}`
        }
      ]);
    });
  });

  describe('Card Operations', () => {
    it('should GET /cards when listing cards', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.listCards();
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards')
      });
    });

    it('should GET /cards with status filter', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.listCards({ status: 'active' });
      expect(httpClient.requests).toHaveLength(1);
      expect(httpClient.requests[0]?.url).toContain('status=active');
    });

    it('should GET /cards/:id when fetching single card', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getCard('card-123');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-123')
      });
    });

    it('should POST /cards when creating card', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const data = { title: 'Test Card' };
      await client.createCard(data);
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/cards'),
        body: data
      });
    });

    it('should PATCH /cards/:id when updating card', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const data = { title: 'Updated Title' };
      await client.updateCard('card-123', data);
      expect(httpClient.requests[0]).toMatchObject({
        method: 'PATCH',
        url: expect.stringContaining('/cards/card-123'),
        body: data
      });
    });

    it('should DELETE /cards/:id when deleting card', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.deleteCard('card-123');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'DELETE',
        url: expect.stringContaining('/cards/card-123')
      });
    });
  });

  describe('Attachment Operations', () => {
    it('should PUT /cards/:id/attachments/:filename when uploading', async () => {
      const client = new CardsClient(options);
      const base64Data = 'dGVzdCBjb250ZW50'; // "test content" in base64

      // Mock fetch for binary PUT
      const mockResponse = { id: 'att-123', name: 'test.txt', size: 12 };
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response);

      const result = await client.uploadAttachment('card-123', 'test.txt', base64Data);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/cards/card-123/attachments/test.txt'),
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/octet-stream'
          })
        })
      );
      expect(result).toEqual(mockResponse);
      vi.restoreAllMocks();
    });

    it('should GET /cards/:id/attachments/:attachmentId when downloading attachment', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const mockBlob = new Blob(['attachment content'], { type: 'application/octet-stream' });
      // Mock fetch to return blob
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => mockBlob
      } as Response);
      const result = await client.getAttachment('card-123', 'attachment-456');
      expect(result).toEqual(mockBlob);
      vi.restoreAllMocks();
    });

    it('should throw ApiError on 404 when downloading attachment', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      // Mock fetch to return 404
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Attachment not found' })
      } as Response);
      await expect(client.getAttachment('card-123', 'attachment-456')).rejects.toThrow();
      vi.restoreAllMocks();
    });

    it('should GET /cards/:id/attachments when listing attachments', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.listAttachments('card-123');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-123/attachments')
      });
    });

    it('should return array of AttachmentResponse when listing attachments', async () => {
      const httpClient = new TestHttpClient();
      const expectedAttachments = [
        {
          id: 'att-1',
          originalName: 'file.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          createdAt: '2024-01-01T00:00:00Z'
        },
        { id: 'att-2', originalName: 'image.png', mimeType: 'image/png', size: 2048, createdAt: '2024-01-02T00:00:00Z' }
      ];
      httpClient.responses.set('http://localhost:3000/cards/card-123/attachments', expectedAttachments);
      const client = new CardsClient(options, httpClient);
      const result = await client.listAttachments('card-123');
      expect(result).toEqual(expectedAttachments);
    });
  });

  describe('Timeline Operations', () => {
    it('should GET /cards/:id/timeline when fetching timeline', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getTimeline('card-123');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-123/timeline')
      });
    });

    it('should GET /cards/:id/timeline with pagination', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getTimeline('card-123', { before: '2024-01-01T00:00:00Z', limit: 10 });
      expect(httpClient.requests).toHaveLength(1);
      const requestUrl = httpClient.requests[0]?.url;
      expect(requestUrl).toContain('/cards/card-123/timeline');
      expect(requestUrl).toContain('before=');
      expect(requestUrl).toContain('limit=10');
    });
  });

  describe('File Operations', () => {
    it('should PUT /cards/:id/fs/:path when putting file', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.putFile('card-1', `${PLANS_PREFIX}initial.md`, '# My Plan');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'PUT',
        url: `http://localhost:3000/cards/card-1/fs/${encodeURIComponent(`${PLANS_PREFIX}initial.md`)}`,
        body: '# My Plan'
      });
    });
  });

  describe('path segment encoding', () => {
    const hostileCardId = 'a b/../c';
    const encodedHostileCardId = 'a%20b%2F..%2Fc';

    it('should leave a plain cardId unchanged on the wire', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getCard('card-123');
      expect(httpClient.requests[0]?.url).toBe('http://localhost:3000/cards/card-123');
    });

    it('should encode cardId so reserved characters cannot alter the route shape', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getCard(hostileCardId);
      expect(new URL(httpClient.requests[0]!.url).pathname).toBe(`/cards/${encodedHostileCardId}`);
    });

    it('should encode attachmentId as a single path segment', async () => {
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['attachment content'])
      } as Response);
      await client.getAttachment('card-123', 'att#1?id x');
      const requestUrl = String(fetchSpy.mock.calls[0]?.[0]);
      expect(new URL(requestUrl).pathname).toBe('/cards/card-123/attachments/att%231%3Fid%20x');
      vi.restoreAllMocks();
    });

    it('should encode a hostile filePath so reserved characters cannot alter the route shape', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.putFile('card-123', 'notes#3.md', 'content');
      expect(new URL(httpClient.requests[0]!.url).pathname).toBe('/cards/card-123/fs/notes%233.md');
    });

    it('should percent-encode slashes in a multi-segment filePath for the fs catch-all to decode once', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.putFile('card-123', 'a b/50%.md', 'content');
      expect(new URL(httpClient.requests[0]!.url).pathname).toBe('/cards/card-123/fs/a%20b%2F50%25.md');
    });

    const cardIdCallers: Array<[string, (client: CardsClient, cardId: string) => Promise<unknown>]> = [
      ['updateCard', (client, cardId) => client.updateCard(cardId, { title: 'x' })],
      ['deleteCard', (client, cardId) => client.deleteCard(cardId)],
      ['listAttachments', (client, cardId) => client.listAttachments(cardId)],
      ['getTimeline', (client, cardId) => client.getTimeline(cardId)],
      ['putFile', (client, cardId) => client.putFile(cardId, 'PLAN.md', 'content')],
      ['approveGate', (client, cardId) => client.approveGate(cardId, 'plan')],
      ['getBranches', (client, cardId) => client.getBranches(cardId)],
      ['addBranch', (client, cardId) => client.addBranch(cardId, { name: 'feature/test', parentBranch: 'main' })],
      ['removeBranch', (client, cardId) => client.removeBranch(cardId, 'feature/test')],
      ['listStreams', (client, cardId) => client.listStreams(cardId)],
      ['getStream', (client, cardId) => client.getStream(cardId, 'claude-session', 'session.log')],
      ['executeAction', (client, cardId) => client.executeAction(cardId, 'launch')]
    ];

    it.each(cardIdCallers)('encodes the cardId segment in %s', async (_method, call) => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await call(client, hostileCardId);
      const url = httpClient.requests[0]!.url;
      expect(url).toContain(encodedHostileCardId);
      expect(url).not.toContain(`/${hostileCardId}`);
    });
  });

  describe('Gate Operations', () => {
    it('should POST /cards/:id/gates/:gateName/approve when approving gate', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.approveGate('card-123', 'mergeRequest');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/cards/card-123/gates/mergeRequest/approve')
      });
    });
  });

  describe('Branch Operations', () => {
    it('should GET /cards/:id/branches when getting branches', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getBranches('card-123');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-123/branches')
      });
    });

    it('should GET /cards/:id/branches with workspacePath query param', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getBranches('card-123', { workspacePath: '/workspace' });
      expect(httpClient.requests).toHaveLength(1);
      expect(httpClient.requests[0]?.url).toContain('workspacePath=%2Fworkspace');
    });

    it('should POST /cards/:id/branches with name and worktree when adding branch', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.addBranch('card-123', { name: 'feature/test', parentBranch: 'main', worktree: '/path/to/worktree' });
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/cards/card-123/branches'),
        body: { name: 'feature/test', parentBranch: 'main', worktree: '/path/to/worktree' }
      });
    });

    it('should DELETE /cards/:id/branches/:name when removing branch', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.removeBranch('card-123', 'feature/test');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'DELETE',
        url: expect.stringContaining('/cards/card-123/branches/feature%2Ftest')
      });
    });

    it('should URL-encode branch name with slashes when removing', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.removeBranch('card-123', 'feature/sub/branch');
      expect(httpClient.requests[0]).toMatchObject({
        method: 'DELETE',
        url: expect.stringContaining('feature%2Fsub%2Fbranch')
      });
    });

    it('should throw ApiError on server error response', async () => {
      const client = new CardsClient(options);

      // Mock fetch to return 404 — fresh Response per call since body is single-use
      vi.spyOn(global, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'Card not found', code: 'NOT_FOUND' }), {
          status: 404,
          statusText: 'Not Found'
        });
      });

      const err = await client.getBranches('card-123').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('Card not found');
      expect((err as ApiError).code).toBe('NOT_FOUND');
      vi.restoreAllMocks();
    });
  });

  describe('Tag Operations', () => {
    it('should GET /tags when fetching tags', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getTags();
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/tags')
      });
    });
  });

  describe('Environment Operations', () => {
    it('should GET /environments when fetching environments', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.getEnvironments();
      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/environments')
      });
    });

    it('should return complete action metadata for the configured workspace', async () => {
      const httpClient = new TestHttpClient();
      const expectedEnvironments: EnvironmentsResponse = [
        {
          name: 'production',
          description: 'Production workflows',
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
      httpClient.responses.set(
        'http://localhost:3000/environments?workspacePath=%2Fworkspace%2Fproject',
        expectedEnvironments
      );
      const client = new CardsClient({ ...options, workspacePath: '/workspace/project' }, httpClient);
      const result = await client.getEnvironments();
      expect(result).toEqual(expectedEnvironments);
      expect(httpClient.requests[0]?.url).toBe(
        'http://localhost:3000/environments?workspacePath=%2Fworkspace%2Fproject'
      );
    });
  });

  describe('Stream Operations', () => {
    it('listStreams calls GET /cards/:cardId/streams', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const mockStreams: StreamMeta[] = [
        {
          version: 1,
          relPath: 'session.log',
          streamType: 'claude-session',
          runtime: 'claude-code',
          sessionId: 'session-1',
          role: 'main',
          sourcePath: '/tmp/session.log',
          startedAt: '2024-01-01T00:00:00Z',
          createdAt: '2024-01-01T00:00:00Z',
          isActive: false,
          lineCount: 100
        }
      ];

      httpClient.responses.set('http://localhost:3000/cards/card-1/streams', mockStreams);

      const result = await client.listStreams('card-1');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-1/streams')
      });
      expect(result).toEqual(mockStreams);
    });

    it('listStreams returns empty array when no streams', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      httpClient.responses.set('http://localhost:3000/cards/card-1/streams', []);

      const result = await client.listStreams('card-1');

      expect(result).toEqual([]);
    });

    it('getStream calls GET /cards/:cardId/streams/:streamType/*relPath', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const mockStream = {
        meta: {
          relPath: 'session.log',
          streamType: 'claude-session',
          status: 'completed',
          createdAt: '2024-01-01T00:00:00Z',
          lineCount: 2
        },
        lines: ['line 1', 'line 2']
      };

      httpClient.responses.set('http://localhost:3000/cards/card-1/streams/claude-session/session.log', mockStream);

      const result = await client.getStream('card-1', 'claude-session', 'session.log');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-1/streams/claude-session/session.log')
      });
      expect(result).toEqual(mockStream);
    });

    it('getStream appends ?tail=N when a tail is provided', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const mockStream = {
        meta: { relPath: 'session.log', streamType: 'claude-session', lineCount: 2460 },
        lines: ['line 2459', 'line 2460']
      };
      httpClient.responses.set(
        'http://localhost:3000/cards/card-1/streams/claude-session/session.log?tail=50',
        mockStream
      );

      const result = await client.getStream('card-1', 'claude-session', 'session.log', 50);

      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('tail=50')
      });
      // meta.lineCount still reports the full stream even though only the tail
      // was returned.
      expect(result.meta.lineCount).toBe(2460);
      expect(result.lines).toHaveLength(2);
    });

    it('getStream omits the tail query param when no tail is provided', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      httpClient.responses.set('http://localhost:3000/cards/card-1/streams/claude-session/session.log', {
        meta: {},
        lines: []
      });

      await client.getStream('card-1', 'claude-session', 'session.log');

      expect(httpClient.requests[0]!.url).not.toContain('tail=');
    });

    it('getStream encodes filename in URL', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      httpClient.responses.set('http://localhost:3000/cards/card-1/streams/claude-session/file%20with%20spaces.log', {
        meta: {},
        lines: []
      });

      await client.getStream('card-1', 'claude-session', 'file with spaces.log');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-1/streams/claude-session/file%20with%20spaces.log')
      });
    });

    it('getStream encodes streamType in URL', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      httpClient.responses.set('http://localhost:3000/cards/card-1/streams/type%2Fwith%2Fslashes/session.log', {
        meta: {},
        lines: []
      });

      await client.getStream('card-1', 'type/with/slashes', 'session.log');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-1/streams/type%2Fwith%2Fslashes/session.log')
      });
    });

    it('getStream encodes a nested relPath per-segment, keeping the separating slashes literal', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const nestedUrl =
        'http://localhost:3000/cards/card-1/streams/claude-session/session%20abc/subagents/agent%20one.jsonl';
      httpClient.responses.set(nestedUrl, { meta: {}, lines: [] });

      await client.getStream('card-1', 'claude-session', 'session abc/subagents/agent one.jsonl');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'GET',
        url: expect.stringContaining('/cards/card-1/streams/claude-session/session%20abc/subagents/agent%20one.jsonl')
      });
    });

    it('getStream throws ApiError on 404', async () => {
      const client = new CardsClient(options);
      const errorResponse = new Response(JSON.stringify({ error: 'Stream not found' }), {
        status: 404,
        statusText: 'Not Found'
      });

      // Mock fetch to return 404
      vi.spyOn(global, 'fetch').mockResolvedValue(errorResponse);

      await expect(client.getStream('card-1', 'claude-session', 'nonexistent.log')).rejects.toThrow(ApiError);

      vi.restoreAllMocks();
    });
  });

  describe('Action Operations', () => {
    it('executeAction sends POST to /cards/:id/actions/:name and returns ActionResult', async () => {
      const httpClient = new TestHttpClient();
      const expectedResult = { success: true, exitCode: 0 };
      httpClient.responses.set('http://localhost:3000/cards/card-123/actions/launch', expectedResult);
      const client = new CardsClient(options, httpClient);

      const result = await client.executeAction('card-123', 'launch');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/cards/card-123/actions/launch')
      });
      expect(httpClient.requests[0]!.body).toBeUndefined();
      expect(result).toEqual(expectedResult);
    });

    it('executeAction sends the execution mode in the request body when provided', async () => {
      const httpClient = new TestHttpClient();
      httpClient.responses.set('http://localhost:3000/cards/card-123/actions/chat', { success: true, exitCode: 0 });
      const client = new CardsClient(options, httpClient);

      await client.executeAction('card-123', 'chat', 'interactive');

      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/cards/card-123/actions/chat'),
        body: { mode: 'interactive' }
      });
    });

    it('executeAction serializes a selected coding agent without changing omitted requests', async () => {
      const httpClient = new TestHttpClient();
      httpClient.responses.set('http://localhost:3000/cards/card-123/actions/launch', { success: true, exitCode: 0 });
      const client = new CardsClient(options, httpClient);

      await client.executeAction('card-123', 'launch', undefined, false, 'codex-cli');

      expect(httpClient.requests[0]?.body).toEqual({ selectedAgent: 'codex-cli' });
    });
  });

  describe('Compare Operations', () => {
    it('should POST /compare with branch-range request body', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const request = { baseRef: 'main', compareRef: 'feature/my-card' };
      await client.setCompare(request);
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/compare'),
        body: request
      });
    });

    it('should POST /compare with dynamic request body', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const request = { baseRef: 'main', repositoryPath: '/workspace/repo' };
      await client.setCompare(request);
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/compare'),
        body: request
      });
    });

    it('should POST /compare with fixed-attribution request body', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const request = { compareRef: 'feature/my-card', attributionShas: ['abc123', 'def456'] };
      await client.setCompare(request);
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: expect.stringContaining('/compare'),
        body: request
      });
    });

    it('should return null when GET /compare returns 204', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
      const result = await client.getCompare();
      expect(result).toBeNull();
    });

    it('should return state when GET /compare returns 200', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      const state = { mode: 'branch-range' as const, baseRef: 'main', compareRef: 'feature/my-card' };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      const result = await client.getCompare();
      expect(result).toEqual(state);
    });

    it('should DELETE /compare when clearing compare', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);
      await client.clearCompare();
      expect(httpClient.requests[0]).toMatchObject({
        method: 'DELETE',
        url: expect.stringContaining('/compare')
      });
    });
  });

  describe('network retry behavior', () => {
    it('should pass AbortSignal to fetch when using default HTTP client', async () => {
      const client = new CardsClient(options);
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => []
      } as Response);

      await client.listCards();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal)
        })
      );
    });

    it('should not apply timeout when HttpClient is injected', async () => {
      const httpClient = new TestHttpClient();
      const client = new CardsClient(options, httpClient);

      await client.listCards();

      // TestHttpClient handles the request directly, no fetch() call
      expect(httpClient.requests).toHaveLength(1);
    });

    it('should retry network errors and eventually succeed', async () => {
      vi.useFakeTimers();
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch');

      // Two failures (timeout + connection refused), then success
      fetchSpy
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'card-1' }] } as Response);

      const promise = client.listCards();
      await vi.advanceTimersByTimeAsync(3000); // first retry delay
      await vi.advanceTimersByTimeAsync(6000); // second retry delay (doubled)
      const result = await promise;

      expect(result).toEqual([{ id: 'card-1' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('should retry on timeout and succeed on later attempt', async () => {
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch');

      // First attempt times out, second succeeds
      fetchSpy
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
        .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'card-1' }] } as Response);

      const result = await client.listCards();
      expect(result).toEqual([{ id: 'card-1' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should retry non-timeout network errors', async () => {
      vi.useFakeTimers();
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch');

      // TypeError (connection refused) then success
      fetchSpy
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'card-2' }] } as Response);

      const promise = client.listCards();
      await vi.advanceTimersByTimeAsync(3000); // past first retry delay
      const result = await promise;

      expect(result).toEqual([{ id: 'card-2' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('should not retry ApiError (server responded)', async () => {
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400, statusText: 'Bad Request' });
      });

      await expect(client.listCards()).rejects.toThrow(ApiError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should reset retry delay after a successful request', async () => {
      vi.useFakeTimers();
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch');

      // First call: one failure then success
      fetchSpy
        .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
        .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);
      const promise1 = client.listCards();
      await vi.advanceTimersByTimeAsync(3000);
      await promise1;

      // Second call: succeeds immediately (retry delay was reset)
      fetchSpy.mockReset();
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);
      const promise2 = client.listCards();
      await promise2;

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('should not carry retry state across separate API calls', async () => {
      const client = new CardsClient(options);
      const fetchSpy = vi.spyOn(global, 'fetch');

      // First API call fails with server error (not retried)
      fetchSpy.mockImplementation(async () => {
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
          statusText: 'Internal Server Error'
        });
      });
      await expect(client.listCards()).rejects.toThrow(ApiError);

      // Second API call should succeed on first attempt
      fetchSpy.mockReset();
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);
      await client.listCards();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should apply timeout to uploadAttachment direct fetch call', async () => {
      const client = new CardsClient(options);
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'att-1', name: 'test.txt', size: 4 })
      } as Response);

      await client.uploadAttachment('card-1', 'test.txt', new Blob(['test']));

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal)
        })
      );
    });

    it('should apply timeout to getAttachment direct fetch call', async () => {
      // getAttachment uses direct fetch (not httpClient), so DI client is ignored
      const client = new CardsClient(options);
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => new Blob(['data'])
      } as Response);

      await client.getAttachment('card-1', 'att-1');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal)
        })
      );
    });
  });
});

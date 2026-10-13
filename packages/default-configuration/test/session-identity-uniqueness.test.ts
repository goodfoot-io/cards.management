/**
 * Every rendered row, part and nested leaf owns disclosure, focus, paging and scroll-anchor state by
 * its ID, so a projection that repeats an ID silently shares that state between unrelated leaves.
 * @summary Cross-provider display identity uniqueness over native fixtures
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { antigravitySessionProjector } from '../src/streams/antigravity-session/www/lib/project-session';
import { claudeSessionProjector } from '../src/streams/claude-code-session/www/lib/project-session';
import { codexSessionProjector } from '../src/streams/codex-session/www/lib/project-session';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import type { NativeTranscriptSource } from '../src/streams/lib/session/types';
import { opencodeSessionProjector } from '../src/streams/opencode-session/www/lib/project-session';
import { nativeFixture as antigravityFixture } from './fixtures/antigravity-projection';

const fixtures = (directory: string): [string, string[]][] =>
  readdirSync(new URL(`./fixtures/${directory}/`, import.meta.url))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => [
      `${directory}/${name}`,
      readFileSync(new URL(`./fixtures/${directory}/${name}`, import.meta.url), 'utf8')
        .trimEnd()
        .split('\n')
    ]);

const claudeUser = (text: string, uuid: string): string =>
  JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } });

const PROVIDERS = [
  {
    name: 'Claude',
    projector: claudeSessionProjector,
    transcripts: [
      ...fixtures('cc-thread-converter'),
      [
        'coordination witnesses',
        [
          claudeUser('<command-name>/clear</command-name><command-args>x</command-args>', 'command'),
          claudeUser(
            '<teammate-message teammate_id="lead" summary="Status">Carry on with the plan.</teammate-message>',
            'teammate'
          )
        ]
      ]
    ] as [string, string[]][]
  },
  { name: 'Codex', projector: codexSessionProjector, transcripts: fixtures('codex-session') },
  { name: 'OpenCode', projector: opencodeSessionProjector, transcripts: fixtures('opencode') },
  {
    name: 'Antigravity',
    projector: antigravitySessionProjector,
    transcripts: [['captured destination records', antigravityFixture]] as [string, string[]][]
  }
] as const;

/** Collects every leaf-shaped node, including grouped rows and parts nested in provider payloads.
 * @param value - Projected rows or any nested payload value.
 * @param ids - Accumulates leaf IDs in traversal order.
 * @returns The same accumulator.
 */
function leafIds(value: unknown, ids: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) leafIds(item, ids);
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['id'] === 'string' && typeof record['kind'] === 'string') ids.push(record['id']);
    for (const nested of Object.values(record)) leafIds(nested, ids);
  }
  return ids;
}

const source = (lines: readonly string[]): NativeTranscriptSource => ({
  sourceKey: 'card/identity',
  generation: 'one',
  filename: 'native.jsonl',
  lines: lines.slice(),
  headLineNumber: 1,
  meta: null,
  isLoading: false,
  error: null
});

const duplicates = (ids: readonly string[]): string[] => ids.filter((id, index) => ids.indexOf(id) !== index);

const CASES = PROVIDERS.flatMap(({ name, projector, transcripts }) =>
  transcripts.map(([label, lines]) => ({ name, label, projector: projector as typeof claudeSessionProjector, lines }))
);

describe('session display identity', () => {
  it.each(CASES)('keeps every $name row, part and nested leaf ID unique in $label', ({ projector, lines }) => {
    const ids = leafIds(replayTranscript(projector, source(lines)).rows);
    expect(ids.length).toBeGreaterThan(0);
    expect(duplicates(ids)).toEqual([]);
  });

  it.each(CASES)('keeps $name IDs unique after every single-line append of $label and ends on the full replay', ({
    projector,
    lines
  }) => {
    const controller = createTranscriptProjection(projector, 'card/identity');
    try {
      let ids: string[] = [];
      for (let count = 1; count <= lines.length; count++) {
        ids = leafIds(controller.update(source(lines.slice(0, count))).projection.rows);
        expect({ count, duplicates: duplicates(ids) }).toEqual({ count, duplicates: [] });
      }
      expect(ids).toEqual(leafIds(replayTranscript(projector, source(lines)).rows));
    } finally {
      controller.dispose();
    }
  });
});

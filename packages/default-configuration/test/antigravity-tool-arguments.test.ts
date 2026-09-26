// @vitest-environment jsdom

/**
 * Regression coverage for lazy inspection of native Antigravity tool arguments.
 * @summary Tool arguments serialize only inside an open disclosure
 * @module
 */

import { createHash } from 'node:crypto';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { AntigravitySessionView } from '../src/streams/antigravity-session/www/components/expanded/AntigravitySessionView';
import type { AntigravityPayloads } from '../src/streams/antigravity-session/www/lib/project-session';
import { antigravitySessionProjector } from '../src/streams/antigravity-session/www/lib/project-session';
import { replayTranscript } from '../src/streams/lib/session/projection';
import type { NativeTranscriptSource, SessionProjection } from '../src/streams/lib/session/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_KEY = 'card/antigravity/tool-arguments';

/** Builds a complete native transcript snapshot for the captured fixture lines.
 * @param lines - Native JSONL records with their physical source order.
 * @returns A settled Antigravity transcript source.
 */
function source(lines: readonly string[]): NativeTranscriptSource {
  return {
    sourceKey: SOURCE_KEY,
    generation: 'generation-1',
    filename: 'conversation.jsonl',
    lines,
    headLineNumber: 1,
    meta: null,
    isLoading: false,
    error: null
  };
}

/** Encodes one native Antigravity tool-call record with its pinned content hash.
 * @returns A valid destination JSONL record for a command invocation.
 */
function nativeToolLine(): string {
  const content = JSON.stringify({ tool: 'run_command', arguments: { command: 'echo ready' } });
  return JSON.stringify({
    v: 1,
    idx: 1,
    stepType: 132,
    status: 3,
    content,
    hash: createHash('sha256').update(content, 'utf8').digest('hex'),
    anomaly: null
  });
}

/** Projects a real native tool record while injecting an observable stable argument identity.
 * @param argumentsValue - Tool input value whose serialization can be observed by the test.
 * @returns An Antigravity projection retaining the instrumented native payload.
 */
function toolProjection(argumentsValue: unknown): SessionProjection<AntigravityPayloads> {
  const projection = replayTranscript(antigravitySessionProjector, source([nativeToolLine()]));
  return {
    ...projection,
    rows: projection.rows.map((row) =>
      row.kind === 'provider' && row.providerKind === 'toolCall'
        ? { ...row, data: { ...row.data, arguments: argumentsValue } }
        : row
    )
  };
}

describe('Antigravity tool argument inspection', () => {
  it('does not serialize a closed disclosure and memoizes open content for a stable argument value', async () => {
    let serializationCount = 0;
    const argumentsValue = {
      command: 'echo ready',
      diagnostics: 'x'.repeat(5 * 1024 * 1024),
      toJSON: () => {
        serializationCount++;
        return { command: 'echo ready', diagnostics: 'x'.repeat(5 * 1024 * 1024) };
      }
    };
    const projection = toolProjection(argumentsValue);
    const toolRow = projection.rows.find((row) => row.kind === 'provider' && row.providerKind === 'toolCall');
    expect(toolRow).toBeDefined();

    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (open: boolean): ReactElement =>
      createElement(AntigravitySessionView, {
        source: source([nativeToolLine()]),
        projection,
        disclosures: {
          open: new Map(open && toolRow ? [[toolRow.id, true] as const] : []),
          onOpenChange: () => {}
        }
      });

    try {
      await act(async () => root.render(render(false)));
      expect(serializationCount).toBe(0);
      expect(container.textContent).toContain('Tool arguments');
      expect(container.textContent).not.toContain('echo ready');

      await act(async () => root.render(render(true)));
      expect(serializationCount).toBe(1);
      expect(container.textContent).toContain('echo ready');
      expect(container.textContent!.length).toBeLessThan(70000);

      await act(async () => root.render(render(true)));
      expect(serializationCount).toBe(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

/**
 * Fixture-first preservation checks for Antigravity's native expanded session.
 * The input records are destination JSONL, not Claude-shaped adapter messages.
 * @summary Antigravity native projection and rendered-content contract
 * @module
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AntigravitySessionView } from '../src/streams/antigravity-session/www/components/expanded/AntigravitySessionView';
import type { AntigravityPayloads, AntigravityRow } from '../src/streams/antigravity-session/www/lib/project-session';
import { antigravitySessionProjector } from '../src/streams/antigravity-session/www/lib/project-session';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import type { NativeTranscriptSource, SessionProjection } from '../src/streams/lib/session/types';
import { nativeFixture, recordLine } from './fixtures/antigravity-projection';
import { streamMeta } from './helpers/stream-meta';

const source = (lines: readonly string[], extra: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource => ({
  sourceKey: 'card/antigravity/conversation-1',
  generation: 'generation-1',
  filename: 'conversation-1.jsonl',
  lines,
  headLineNumber: 1,
  meta: null,
  isLoading: false,
  error: null,
  ...extra
});

function describeRows(rows: readonly AntigravityRow[]): unknown[] {
  return rows.map((row) => {
    if (row.kind === 'provider' && row.providerKind === 'toolCall') {
      return {
        kind: row.kind,
        providerKind: row.providerKind,
        idx: row.data.idx,
        stepType: row.data.stepType,
        status: row.data.status,
        name: row.data.name,
        arguments: row.data.arguments
      };
    }
    if (row.kind === 'structural') {
      return {
        kind: row.kind,
        label: row.label,
        tone: row.tone,
        parts: row.parts.map((part) =>
          part.kind === 'provider'
            ? { kind: part.kind, providerKind: part.providerKind, data: part.data }
            : {
                kind: part.kind,
                label: part.kind === 'raw' ? part.label : undefined,
                text: part.kind === 'raw' ? part.text : undefined
              }
        )
      };
    }
    return {
      kind: row.kind,
      role: row.kind === 'message' ? row.role : undefined,
      label: row.kind === 'message' ? row.label : undefined,
      parts: row.parts.map((part) => (part.kind === 'text' ? { kind: part.kind, text: part.text } : part.kind))
    };
  });
}

function openedDisclosures(rows: readonly AntigravityRow[]): ReadonlyMap<string, boolean> {
  return new Map(
    rows.flatMap((row) => [[row.id, true] as const, ...row.parts.map((part) => [part.id, true] as const)])
  );
}

function renderProjection(projection: SessionProjection<AntigravityPayloads>): string {
  return renderToStaticMarkup(
    createElement(AntigravitySessionView, {
      source: source(nativeFixture),
      projection,
      disclosures: { open: openedDisclosures(projection.rows), onOpenChange: () => {} }
    })
  );
}

describe('Antigravity native session projection', () => {
  it('projects fixture records into explicit messages, tool calls, anomalies, and inspectable unknown content', () => {
    const projection = replayTranscript(antigravitySessionProjector, source(nativeFixture));

    expect(describeRows(projection.rows)).toEqual([
      {
        kind: 'message',
        role: 'user',
        label: 'You · step 10 · status 3',
        parts: [{ kind: 'text', text: 'What is the answer?' }]
      },
      {
        kind: 'message',
        role: 'assistant',
        label: 'Antigravity · step 20 · status 3',
        parts: [{ kind: 'text', text: 'The answer is **42**.' }]
      },
      {
        kind: 'provider',
        providerKind: 'toolCall',
        idx: 30,
        stepType: 132,
        status: 3,
        name: 'run_command',
        arguments: { command: 'echo ready' }
      },
      {
        kind: 'message',
        role: 'assistant',
        label: 'Antigravity · step 31 · status 3',
        parts: [{ kind: 'text', text: 'The command reported `ready`.' }]
      },
      {
        kind: 'structural',
        label: 'Unsupported Antigravity step · type 99 · step 40',
        tone: 'info',
        parts: [{ kind: 'raw', label: 'Raw Antigravity record', text: nativeFixture[5]! }]
      },
      {
        kind: 'structural',
        label: 'Unreadable content (format unknown) · step 50',
        tone: 'error',
        parts: [
          {
            kind: 'provider',
            providerKind: 'anomaly',
            data: {
              kind: 'format-unknown',
              idx: 50,
              stepType: 132,
              status: 3,
              detail: 'unwitnessed step_format 9',
              withheldBytes: 6
            }
          }
        ]
      },
      {
        kind: 'structural',
        label: 'Partial flush · step 60',
        tone: 'info',
        parts: [
          {
            kind: 'provider',
            providerKind: 'anomaly',
            data: {
              kind: 'flush-partial',
              idx: 60,
              stepType: 15,
              status: 1,
              detail: 'flushed before terminal state',
              content: 'partial response'
            }
          }
        ]
      },
      {
        kind: 'message',
        role: 'assistant',
        label: 'Antigravity · step 60 · status 3',
        parts: [{ kind: 'text', text: 'completed response' }]
      },
      {
        kind: 'message',
        role: 'assistant',
        label: 'Antigravity · step 70 · status 3',
        parts: [{ kind: 'text', text: 'original response' }]
      },
      {
        kind: 'structural',
        label: 'Host drift · step 70',
        tone: 'error',
        parts: [
          {
            kind: 'provider',
            providerKind: 'anomaly',
            data: {
              kind: 'host-drift',
              idx: 70,
              stepType: 15,
              status: 3,
              detail: 'step 70 changed after terminal emission',
              content: 'revised response'
            }
          }
        ]
      },
      {
        kind: 'structural',
        label: 'Host drift · schema changed',
        tone: 'error',
        parts: [
          {
            kind: 'provider',
            providerKind: 'anomaly',
            data: {
              kind: 'schema-drift',
              detail: 'schema fingerprint changed',
              content: 'schema fingerprint changed'
            }
          }
        ]
      },
      {
        kind: 'structural',
        label: 'Malformed stream record (unsupported record version 2 (expected 1))',
        tone: 'error',
        parts: [
          {
            kind: 'raw',
            label: 'Malformed Antigravity record',
            text: nativeFixture[12]!
          }
        ]
      },
      {
        kind: 'structural',
        label: 'Malformed stream record (line is not valid JSON)',
        tone: 'error',
        parts: [{ kind: 'raw', label: 'Malformed Antigravity record', text: nativeFixture[13]! }]
      }
    ]);

    const duplicate = projection.rows.find(
      (row) => row.kind === 'message' && row.label?.startsWith('Antigravity · step 20')
    );
    expect(duplicate?.provenance.map((origin) => origin.lineNumber)).toEqual([1, 3]);
    expect(duplicate?.provenance.every((origin) => origin.nativeEventId === '20')).toBe(true);
    expect(duplicate?.provenance.every((origin) => origin.sourceKey === 'card/antigravity/conversation-1')).toBe(true);
  });

  it('renders native meaning, tool arguments, anomaly evidence, withheld payloads, and raw unsupported records', () => {
    const projection = replayTranscript(antigravitySessionProjector, source(nativeFixture));
    const html = renderProjection(projection);

    expect(html).toContain('What is the answer?');
    expect(html).toContain('The answer is <strong>42</strong>.');
    expect(html).toContain('run_command');
    expect(html).toContain('echo ready');
    expect(html).toContain('The command reported');
    expect(html).toContain('captured future-step payload');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('flushed before terminal state');
    expect(html).toContain('partial response');
    expect(html).toContain('original response');
    expect(html).toContain('revised response');
    expect(html).toContain('schema fingerprint changed');
    expect(html).toContain('Malformed stream record');
    expect(html).toContain('6 bytes of undecodable content withheld');
    expect(html).not.toContain('HIDDEN');
  });

  it('produces the same semantics for single-line, varied-batch, duplicate-snapshot, and full replay delivery', () => {
    const controller = createTranscriptProjection(antigravitySessionProjector, 'card/antigravity/conversation-1');
    let incremental: SessionProjection<AntigravityPayloads> | undefined;
    for (let end = 1; end <= nativeFixture.length; end++) {
      incremental = controller.update(source(nativeFixture.slice(0, end))).projection;
      expect(controller.update(source(nativeFixture.slice(0, end))).kind).toBe('unchanged');
    }
    const replay = replayTranscript(antigravitySessionProjector, source(nativeFixture));
    expect(describeRows(incremental!.rows)).toEqual(describeRows(replay.rows));

    const varied = createTranscriptProjection(antigravitySessionProjector, 'card/antigravity/conversation-1');
    let batched = varied.update(source(nativeFixture.slice(0, 4))).projection;
    batched = varied.update(source(nativeFixture.slice(0, 9))).projection;
    batched = varied.update(source(nativeFixture)).projection;
    expect(describeRows(batched.rows)).toEqual(describeRows(replay.rows));
    controller.dispose();
    varied.dispose();
  });

  it('uses absolute line provenance and explicitly supplied generations for replacement snapshots', () => {
    const controller = createTranscriptProjection(antigravitySessionProjector, 'card/antigravity/conversation-1');
    const first = controller.update(source(nativeFixture.slice(0, 2), { headLineNumber: 40 })).projection;
    expect(first.rows[0]?.provenance[0]?.lineNumber).toBe(41);

    const reset = controller.update(
      source([recordLine(7, 15, 3, 'new generation')], { generation: 'generation-2', headLineNumber: 1 })
    );
    expect(reset.kind).toBe('reset');
    expect(describeRows(reset.projection.rows)).toEqual([
      {
        kind: 'message',
        role: 'assistant',
        label: 'Antigravity · step 7 · status 3',
        parts: [{ kind: 'text', text: 'new generation' }]
      }
    ]);
    controller.dispose();
  });

  it('keeps stream liveness ahead of parse errors and treats named anomalies as designed events', () => {
    const malformed = ['not JSON'];
    const active = replayTranscript(
      antigravitySessionProjector,
      source(malformed, { meta: streamMeta({ lineCount: 1, isActive: true }) })
    );
    const settledError = replayTranscript(
      antigravitySessionProjector,
      source(malformed, { meta: streamMeta({ lineCount: 1, isActive: false }) })
    );
    const anomalyOnly = replayTranscript(
      antigravitySessionProjector,
      source([recordLine(1, 15, 3, 'revised', { kind: 'host-drift', detail: 'host changed this step' })], {
        meta: streamMeta({ lineCount: 1, isActive: false })
      })
    );

    expect(active.header.status).toBe('running');
    expect(settledError.header.status).toBe('error');
    expect(anomalyOnly.header.status).toBe('done');
  });
});

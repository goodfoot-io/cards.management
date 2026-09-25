/**
 * Frozen Claude fixture semantics survive retirement of the vendor message format.
 * Goldens retain the prior text, reasoning, structural labels, attachments, tools and native anomalies.
 * @summary Claude golden semantic preservation and fixture replay equivalence
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSessionProjector } from '../src/streams/claude-code-session/www/lib/project-session';
import { createTranscriptProjection, replayTranscript } from '../src/streams/lib/session/projection';
import { parts, rowsDeep, source, tools } from './fixtures/claude-projection';

const directory = join(new URL('.', import.meta.url).pathname, 'fixtures/cc-thread-converter');
const fixtures = readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
interface SemanticGolden {
  header: { model: string; cwd: string; status: string };
  text: string[];
  reasoning: string[];
  labels: string[];
  attachments: unknown[];
  outputs: string[];
  supplemental: string[];
  tools: { name: string; input: unknown }[];
  raw: unknown[];
}

describe('Claude native golden fixtures', () => {
  it.each(fixtures)('%s preserves every frozen semantic witness', (name) => {
    const native = source(readFileSync(join(directory, name), 'utf8').split('\n'));
    const projection = replayTranscript(claudeSessionProjector, native);
    const golden = JSON.parse(
      readFileSync(join(directory, '.goldens', `${name}.golden.json`), 'utf8')
    ) as SemanticGolden;
    expect(projection.header).toMatchObject(golden.header);
    const leaves = parts(projection.rows);
    for (const kind of ['text', 'reasoning'] as const)
      expect(
        leaves.flatMap((part) =>
          (part.kind === 'text' || part.kind === 'reasoning') && part.kind === kind ? part.text.split('\n\n') : []
        )
      ).toEqual(golden[kind]);
    const labels = rowsDeep(projection.rows).flatMap((row) =>
      row.kind === 'structural'
        ? [row.label]
        : row.kind === 'provider' && row.providerKind === 'group'
          ? [row.data.label]
          : []
    );
    for (const label of golden.labels) expect(labels).toContain(label);
    const toolParts = tools(projection.rows);
    const attachments = [...leaves, ...toolParts.flatMap((part) => part.data.hooks)]
      .filter((part) => part.kind === 'provider' && part.providerKind === 'attachment')
      .map((part) => part.data.attachment);
    for (const attachment of golden.attachments) expect(attachments).toContainEqual(attachment);
    const outputs = [
      ...toolParts.map((part) => part.data.output ?? ''),
      ...leaves
        .filter((part) => part.kind === 'provider' && part.providerKind === 'prose')
        .map((part) => part.data.text)
    ];
    for (const output of golden.outputs) expect(outputs).toContain(output);
    const supplemental = toolParts.map((part) => part.data.supplemental ?? '').join('\n\n');
    for (const text of golden.supplemental) expect(supplemental).toContain(text);
    for (const tool of golden.tools)
      expect(toolParts.map((part) => ({ name: part.data.name, input: part.data.input }))).toContainEqual(tool);
    const raw = leaves
      .filter((part) => part.kind === 'raw')
      .map((part) => {
        try {
          return JSON.parse(part.text);
        } catch {
          return part.text;
        }
      });
    for (const value of golden.raw) expect(raw).toContainEqual(value);
  });
  it.each(fixtures)('%s has identical one-line incremental and full-replay semantics', (name) => {
    const lines = readFileSync(join(directory, name), 'utf8').split('\n');
    const controller = createTranscriptProjection(claudeSessionProjector, 'card/claude/main');
    for (let end = 1; end <= lines.length; end++) {
      const snapshot = source(lines.slice(0, end));
      expect(controller.update(snapshot).projection).toEqual(replayTranscript(claudeSessionProjector, snapshot));
    }
    controller.dispose();
  });
});

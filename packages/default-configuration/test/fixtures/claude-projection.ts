/**
 * Shared native fixtures and semantic traversal helpers for Claude preservation checks.
 * @summary Claude native projection test fixtures
 */
import {
  type ClaudePart,
  type ClaudeRow,
  claudeSessionProjector
} from '../../src/streams/claude-code-session/www/lib/project-session';
import { replayTranscript } from '../../src/streams/lib/session/projection';
import type { NativeTranscriptSource } from '../../src/streams/lib/session/types';

export const source = (lines: string[], extra: Partial<NativeTranscriptSource> = {}): NativeTranscriptSource => ({
  sourceKey: 'card/claude/main',
  generation: 'one',
  filename: 'main.jsonl',
  lines,
  headLineNumber: 1,
  meta: null,
  isLoading: false,
  error: null,
  ...extra
});
export const line = (value: unknown): string => JSON.stringify(value);
export const user = (text: string, uuid?: string) => ({
  type: 'user',
  uuid,
  message: { content: [{ type: 'text', text }] }
});
export const assistant = (text: string, uuid?: string) => ({
  type: 'assistant',
  uuid,
  message: { content: [{ type: 'text', text }] }
});
export const call = (id = 'call', name = 'Bash') => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input: { command: 'pwd' } }] }
});
export const result = (id = 'call', text = 'done', error = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] }
});
export const hook = (id = 'call', type = 'hook_success') => ({
  type: 'attachment',
  attachment: {
    type,
    toolUseID: id,
    hookName: 'Check',
    hookEvent: 'PostToolUse',
    stdout: 'hook body',
    stderr: '',
    content: '',
    exitCode: 0,
    blockingError: { blockingError: 'blocked', command: 'check' }
  }
});
export const project = (values: unknown[]) => replayTranscript(claudeSessionProjector, source(values.map(line)));
/**
 * Visits provider groups without translating leaves into a vendor message format.
 * @param rows - Root semantic rows for one Claude source.
 * @returns Root rows followed by their grouped descendants.
 */
export function rowsDeep(rows: readonly ClaudeRow[]): ClaudeRow[] {
  return rows.flatMap((row) => [
    row,
    ...(row.kind === 'provider' && row.providerKind === 'group' ? rowsDeep(row.data.rows) : [])
  ]);
}
export const parts = (rows: readonly ClaudeRow[]): ClaudePart[] => rowsDeep(rows).flatMap((row) => row.parts);
export const tools = (rows: readonly ClaudeRow[]) =>
  parts(rows).filter((part) => part.kind === 'provider' && part.providerKind === 'tool');

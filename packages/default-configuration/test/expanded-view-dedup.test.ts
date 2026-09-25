/**
 * UUID double-write regressions exercise the native expanded projector directly.
 * @summary Expanded Claude replay preserves one semantic event and tool call
 */
import { describe, expect, it } from 'vitest';
import { parts, project, tools, user } from './fixtures/claude-projection';

const assistant = {
  uuid: 'a-1',
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'building now' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }
    ]
  }
};
describe('expanded view UUID double writes', () => {
  it('does not double non-adjacent UUID-bearing prompts, prose or tools', () => {
    const prompt = user('run the build', 'u-1');
    const projected = project([prompt, assistant, prompt, assistant]);
    expect(projected.rows).toHaveLength(2);
    expect(parts(projected.rows).flatMap((part) => (part.kind === 'text' ? [part.text] : []))).toEqual([
      'run the build',
      'building now'
    ]);
    expect(tools(projected.rows)).toHaveLength(1);
  });
  it('does not concatenate adjacent same-author replay into duplicate content', () => {
    const projected = project([assistant, assistant]);
    expect(projected.rows).toHaveLength(1);
    expect(parts(projected.rows).filter((part) => part.kind === 'text')).toHaveLength(1);
    expect(tools(projected.rows)).toHaveLength(1);
  });
});

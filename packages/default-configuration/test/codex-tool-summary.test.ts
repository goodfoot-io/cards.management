/**
 * Tests for the collapsed-header preview generator used by Codex tool rows.
 *
 * @summary Unit tests for Codex tool-call preview summarization
 */

import { describe, expect, it } from 'vitest';
import { summarizeCodexTool } from '../src/streams/codex-session/www/lib/tool-summary';

describe('summarizeCodexTool — shell / local_shell_call', () => {
  it('truncates a long joined shell command to 80 chars', () => {
    const command =
      'find /workspace/very/deep/path/that/goes/on -type f -name "*.ts" -not -path "*/node_modules/*" -print';
    const result = summarizeCodexTool('shell', command);
    expect(result.length).toBeLessThanOrEqual(81); // 80 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
    expect(command.startsWith(result.slice(0, -1))).toBe(true);
  });

  it('returns a short shell command unchanged', () => {
    expect(summarizeCodexTool('shell', 'ls -la')).toBe('ls -la');
  });

  it('truncates a long local_shell_call command to 80 chars', () => {
    const command = 'x'.repeat(200);
    const result = summarizeCodexTool('local_shell_call', command);
    expect(result).toBe(`${'x'.repeat(80)}…`);
  });
});

describe('summarizeCodexTool — apply_patch', () => {
  it('extracts the path from an Update File marker in a multi-line patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/streams/codex-session/www/lib/parser.ts',
      '@@ function parseCodexLine',
      '-  return old;',
      '+  return updated;',
      '*** End Patch'
    ].join('\n');
    expect(summarizeCodexTool('apply_patch', patch)).toBe('src/streams/codex-session/www/lib/parser.ts');
  });

  it('extracts the path from an Add File marker', () => {
    const patch = ['*** Begin Patch', '*** Add File: src/new-module.ts', '+export const x = 1;', '*** End Patch'].join(
      '\n'
    );
    expect(summarizeCodexTool('apply_patch', patch)).toBe('src/new-module.ts');
  });

  it('extracts the path from a Delete File marker', () => {
    const patch = ['*** Begin Patch', '*** Delete File: src/old-module.ts', '*** End Patch'].join('\n');
    expect(summarizeCodexTool('apply_patch', patch)).toBe('src/old-module.ts');
  });

  it('extracts only the first changed path when a patch touches multiple files', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Update File: src/b.ts',
      '@@',
      '-old2',
      '+new2',
      '*** End Patch'
    ].join('\n');
    expect(summarizeCodexTool('apply_patch', patch)).toBe('src/a.ts');
  });

  it('falls back to "patch" when no file marker is present', () => {
    expect(summarizeCodexTool('apply_patch', 'not a real patch body')).toBe('patch');
  });
});

describe('summarizeCodexTool — update_plan', () => {
  it('always returns "plan update" regardless of arguments content', () => {
    expect(summarizeCodexTool('update_plan', '{"plan":[{"step":"do X","status":"pending"}]}')).toBe('plan update');
  });
});

describe('summarizeCodexTool — web_search_call / tool_search_call', () => {
  it('truncates a long web_search_call query to 80 chars', () => {
    const query = 'a'.repeat(200);
    expect(summarizeCodexTool('web_search_call', query)).toBe(`${'a'.repeat(80)}…`);
  });

  it('returns a short web_search_call query unchanged', () => {
    expect(summarizeCodexTool('web_search_call', 'rust lifetimes')).toBe('rust lifetimes');
  });

  it('truncates a long tool_search_call arguments text to 80 chars', () => {
    const args = 'b'.repeat(200);
    expect(summarizeCodexTool('tool_search_call', args)).toBe(`${'b'.repeat(80)}…`);
  });
});

describe('summarizeCodexTool — image_generation_call', () => {
  it('truncates a long image prompt to 60 chars', () => {
    const prompt = 'a gray tabby cat hugging an otter under a rainbow in a meadow full of flowers and butterflies';
    const result = summarizeCodexTool('image_generation_call', prompt);
    expect(result).toBe(`${prompt.slice(0, 60)}…`);
  });

  it('returns a short image prompt unchanged', () => {
    expect(summarizeCodexTool('image_generation_call', 'a cat')).toBe('a cat');
  });
});

describe('summarizeCodexTool — mcp__ tool names', () => {
  it('renders a three-part mcp name as server.tool', () => {
    expect(summarizeCodexTool('mcp__github__list_prs', '{"state":"open"}')).toBe('github.list_prs');
  });

  it('rejoins extra __-separated parts into the tool half', () => {
    expect(summarizeCodexTool('mcp__plugin_vscode_vscode__execute_command', '{}')).toBe(
      'plugin_vscode_vscode.execute_command'
    );
  });

  it('falls back to truncated arguments when the mcp name has fewer than 3 parts', () => {
    const argumentsText = 'c'.repeat(80);
    expect(summarizeCodexTool('mcp__onlyserver', argumentsText)).toBe(`${'c'.repeat(60)}…`);
  });
});

describe('summarizeCodexTool — default fallback', () => {
  it('truncates unrecognized tool name arguments to 60 chars', () => {
    const args = 'd'.repeat(200);
    expect(summarizeCodexTool('custom_tool_call', args)).toBe(`${'d'.repeat(60)}…`);
  });

  it('returns short arguments for an unrecognized tool name unchanged', () => {
    expect(summarizeCodexTool('future_unknown_tool', 'short text')).toBe('short text');
  });
});

describe('summarizeCodexTool — exec_command', () => {
  it('truncates exec_command arguments like shell', () => {
    expect(summarizeCodexTool('exec_command', 'git status --short')).toBe('git status --short');
  });
});

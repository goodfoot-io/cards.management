/**
 * Generated registration witnesses for Claude and Codex work admission.
 * @summary Generated work-admission registration tests
 * @module work-admission-registration.test
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function hooks(platform: 'claude' | 'codex'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `../../${platform}/runtime/hooks/hooks.json`), 'utf8')
  ) as Record<string, unknown>;
}

describe('generated work admission registrations', () => {
  it.each(['claude', 'codex'] as const)('ships root and child boundaries for %s', (platform) => {
    const document = hooks(platform) as { hooks?: Record<string, unknown> };
    expect(document.hooks?.['UserPromptSubmit']).toBeDefined();
    expect(document.hooks?.['SubagentStart']).toBeDefined();
    expect(readFileSync(resolve(process.cwd(), `../../${platform}/runtime/hooks/hooks.json`), 'utf8')).toContain(
      'user-prompt-submit'
    );
    expect(readFileSync(resolve(process.cwd(), `../../${platform}/runtime/hooks/hooks.json`), 'utf8')).toContain(
      'subagent-start'
    );
  });
});

/**
 * Codex tool summaries displayed in collapsed native tool disclosures.
 *
 * Codex native parsing resolves `name` and `argumentsText` before presentation;
 * this helper keeps command, patch, search, and MCP summaries readable.
 *
 * @summary One-line summaries for Codex native tool rows
 * @module streams/codex-session/www/lib/tool-summary
 */

import { truncate } from '../../../lib/markdown';

/** Matches the first per-file marker line in an `apply_patch` patch body. */
const PATCH_FILE_MARKER_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m;

/**
 * Parses the first changed file path out of an `apply_patch` patch body.
 *
 * Scans for the first `*** Update File:`, `*** Add File:`, or `*** Delete
 * File:` marker line (the Codex patch format's per-file headers) and returns
 * the path that follows.
 *
 * @param patchText - The raw patch text (the `apply_patch` argumentsText).
 * @returns The first changed file path, or `undefined` when unparseable.
 */
function firstPatchPath(patchText: string): string | undefined {
  const match = PATCH_FILE_MARKER_RE.exec(patchText);
  const path = match?.[1];
  return path === undefined ? undefined : path.trim();
}

/**
 * Splits an MCP tool name (`mcp__<server>__<tool>`) into a `server.tool`
 * display form.
 *
 * @param name - The tool name (e.g. `mcp__github__list_prs`).
 * @returns The `server.tool` display string, or `undefined` when the name has fewer than 3 `__`-separated parts.
 */
function mcpDisplayName(name: string): string | undefined {
  const parts = name.split('__');
  if (parts.length < 3) return undefined;
  const [, server, ...toolParts] = parts;
  return `${server}.${toolParts.join('__')}`;
}

/**
 * Produces the collapsed-header preview string for a Codex tool_call row.
 *
 * @param name - The tool_call's resolved `name` field (e.g. `shell`, `apply_patch`, `mcp__server__tool`).
 * @param argumentsText - The tool_call's already-formatted `argumentsText`.
 * @returns A short, human-readable preview string.
 */
export function summarizeCodexTool(name: string, argumentsText: string): string {
  if (name === 'shell' || name === 'local_shell_call' || name === 'exec_command') {
    return truncate(argumentsText, 80);
  }
  if (name === 'apply_patch') {
    return firstPatchPath(argumentsText) ?? 'patch';
  }
  if (name === 'update_plan') {
    return 'plan update';
  }
  if (name === 'web_search_call' || name === 'tool_search_call') {
    return truncate(argumentsText, 80);
  }
  if (name === 'image_generation_call') {
    return truncate(argumentsText, 60);
  }
  if (name.startsWith('mcp__')) {
    const display = mcpDisplayName(name);
    if (display !== undefined) return display;
  }
  return truncate(argumentsText, 60);
}

/**
 * Codex provider seam for the consolidated session renderer.
 *
 * Codex rollouts reference other threads but record no witnessed delegation chain, so other
 * members render as labeled session-member sections.
 *
 * @summary Codex session adapter
 * @module codex-session/www/session-adapter
 */

import type { SessionProviderAdapter } from '../../lib/session/adapter';
import { CodexCompactView } from './components/compact/CodexCompactView';
import { codexDisclosureIds } from './components/expanded/CodexExpandedView';
import { CODEX_PARTS, CODEX_ROWS } from './components/expanded/CodexPresentation';
import { extractCodexLinkage } from './lib/extract-linkage';
import { type CodexPayloads, codexSessionProjector } from './lib/project-session';

/** Codex parsing, references-only linkage and presentation for the shared renderer. */
export const codexSessionAdapter: SessionProviderAdapter<CodexPayloads> = {
  provider: 'codex',
  agentName: 'Codex',
  projector: codexSessionProjector,
  extractLinkage: extractCodexLinkage,
  providerParts: CODEX_PARTS,
  providerRows: CODEX_ROWS,
  disclosureIds: codexDisclosureIds,
  header: ({ header }) => ({
    model: header.model ?? '',
    cwd: header.cwd ?? '',
    status: header.status === 'done' ? 'success' : (header.status ?? 'running'),
    provider: header.provider,
    threadId: header.threadId
  }),
  emptyText: 'No Codex session activity yet.',
  Summary: CodexCompactView
};

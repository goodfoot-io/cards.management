/**
 * Claude Code provider seam for the consolidated session renderer.
 *
 * Claude records witnessed delegation: an Agent call joined to its structured result names the
 * child's native agent identity, so subagents attach at their delegation rows.
 *
 * @summary Claude session adapter
 * @module claude-code-session/www/session-adapter
 */

import type { SessionProviderAdapter } from '../../lib/session/adapter';
import { CompactView } from './components/compact/CompactView';
import { CLAUDE_PARTS, claudeDisclosureIds } from './components/expanded/ClaudePresentation';
import { hookToolOwners } from './components/expanded/ExpandedView';
import { extractClaudeLinkage } from './lib/extract-linkage';
import { type ClaudePayloads, claudeSessionProjector } from './lib/project-session';

/** Claude parsing, witnessed linkage, hook adoption and presentation for the shared renderer. */
export const claudeSessionAdapter: SessionProviderAdapter<ClaudePayloads> = {
  provider: 'claude-code',
  agentName: 'Claude Code',
  projector: claudeSessionProjector,
  extractLinkage: extractClaudeLinkage,
  providerParts: CLAUDE_PARTS,
  providerRows: CLAUDE_PARTS,
  nestedRows: (row) => (row.kind === 'provider' && row.providerKind === 'group' ? row.data.rows : undefined),
  disclosureIds: claudeDisclosureIds,
  adoptions: hookToolOwners,
  header: ({ header }) => ({
    model: header.model ?? '',
    cwd: header.cwd ?? '',
    status: header.status === 'done' ? 'success' : (header.status ?? 'running'),
    agentId: header.agentId
  }),
  emptyText: 'No output yet.',
  Summary: CompactView
};

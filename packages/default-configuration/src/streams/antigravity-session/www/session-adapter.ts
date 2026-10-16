/**
 * Antigravity provider seam for the consolidated session renderer.
 *
 * The synced Antigravity trajectory is main-only: it records no delegation, and no
 * sub-trajectory is fabricated to make it look like providers that do.
 *
 * @summary Antigravity session adapter
 * @module antigravity-session/www/session-adapter
 */

import type { SessionProviderAdapter } from '../../lib/session/adapter';
import { AntigravityCompactView } from './components/compact/AntigravityCompactView';
import { antigravityDisclosureIds } from './components/expanded/AntigravityExpandedView';
import { ANTIGRAVITY_PARTS, ANTIGRAVITY_ROWS } from './components/expanded/AntigravitySessionView';
import { extractAntigravityLinkage } from './lib/extract-linkage';
import { type AntigravityPayloads, antigravitySessionProjector } from './lib/project-session';

/** Antigravity parsing, main-only linkage and presentation for the shared renderer. */
export const antigravitySessionAdapter: SessionProviderAdapter<AntigravityPayloads> = {
  provider: 'antigravity',
  agentName: 'Antigravity',
  projector: antigravitySessionProjector,
  extractLinkage: extractAntigravityLinkage,
  providerParts: ANTIGRAVITY_PARTS,
  providerRows: ANTIGRAVITY_ROWS,
  disclosureIds: antigravityDisclosureIds,
  header: ({ header }) => ({
    model: '',
    cwd: '',
    status: header.status === 'done' ? 'success' : (header.status ?? 'running')
  }),
  emptyText: 'No Antigravity session activity yet.',
  Summary: AntigravityCompactView
};

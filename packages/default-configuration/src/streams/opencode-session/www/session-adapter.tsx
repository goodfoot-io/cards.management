/**
 * OpenCode provider seam for the consolidated session renderer.
 *
 * OpenCode exports reference child sessions without proving immediate ancestry, so other
 * members render as labeled session-member sections.
 *
 * @summary OpenCode session adapter
 * @module opencode-session/www/session-adapter
 */

import type { SessionProviderAdapter } from '../../lib/session/adapter';
import { OpencodeCompactView } from './components/compact/OpencodeCompactView';
import {
  OPENCODE_PRESENTATION,
  OpenCodeTool,
  opencodeDisclosureIds,
  opencodeHeaderDisplay
} from './components/expanded/OpencodePresentation';
import { extractOpencodeLinkage } from './lib/extract-linkage';
import { type OpencodePayloads, opencodeSessionProjector } from './lib/project-session';

/** OpenCode parsing, references-only linkage and presentation for the shared renderer. */
export const opencodeSessionAdapter: SessionProviderAdapter<OpencodePayloads> = {
  provider: 'opencode',
  agentName: 'OpenCode',
  projector: opencodeSessionProjector,
  extractLinkage: extractOpencodeLinkage,
  providerParts: OPENCODE_PRESENTATION,
  providerRows: OPENCODE_PRESENTATION,
  renderTool: (part, context) => <OpenCodeTool part={part} leaf={part} context={context} />,
  disclosureIds: opencodeDisclosureIds,
  header: ({ header, rows }) => {
    const identity = opencodeHeaderDisplay(rows);
    return {
      model: header.model ?? '',
      cwd: header.cwd ?? '',
      status: header.status === 'done' ? 'success' : (header.status ?? 'running'),
      provider: identity.provider,
      threadId: identity.sessionId
    };
  },
  emptyText: 'No output yet.',
  Summary: OpencodeCompactView
};

/**
 * Typed provider registry for Cards-owned Codex session rows.
 * This fixture-bootstrap stub is replaced with the native presentation implementation.
 * @summary Codex semantic-part renderers
 * @module components/expanded/CodexPresentation
 */

import type { SessionProviderRegistry } from '../../../../lib/session/SessionContent';
import type { CodexPayloads } from '../../lib/project-session';

/** Provider renderer registry reserved for native Codex presentation. */
export const CODEX_PARTS = {} as unknown as SessionProviderRegistry<CodexPayloads>;

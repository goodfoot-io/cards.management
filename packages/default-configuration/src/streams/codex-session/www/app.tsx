/**
 * Entry point for the codex-session stream renderer: mounts the consolidated session renderer
 * with the Codex provider adapter.
 *
 * @summary Codex session renderer entry point
 */

import { mountSessionRenderer } from '../../lib/session/mount';
import { codexSessionAdapter } from './session-adapter';

mountSessionRenderer(codexSessionAdapter);

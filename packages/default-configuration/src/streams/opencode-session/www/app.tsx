/**
 * Entry point for the opencode-session stream renderer: mounts the consolidated session renderer
 * with the OpenCode provider adapter.
 *
 * @summary OpenCode session renderer entry point
 */

import { mountSessionRenderer } from '../../lib/session/mount';
import { opencodeSessionAdapter } from './session-adapter';

mountSessionRenderer(opencodeSessionAdapter);

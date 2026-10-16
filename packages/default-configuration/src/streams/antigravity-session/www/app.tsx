/**
 * Entry point for the antigravity-session stream renderer: mounts the consolidated session renderer
 * with the Antigravity provider adapter.
 *
 * @summary Antigravity session renderer entry point
 */

import { mountSessionRenderer } from '../../lib/session/mount';
import { antigravitySessionAdapter } from './session-adapter';

mountSessionRenderer(antigravitySessionAdapter);

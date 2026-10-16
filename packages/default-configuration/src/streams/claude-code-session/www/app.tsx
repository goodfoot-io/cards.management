/**
 * Entry point for the claude-code-session stream renderer: mounts the consolidated session renderer
 * with the Claude Code provider adapter.
 *
 * @summary Claude Code session renderer entry point
 */

import { mountSessionRenderer } from '../../lib/session/mount';
import { claudeSessionAdapter } from './session-adapter';

mountSessionRenderer(claudeSessionAdapter);

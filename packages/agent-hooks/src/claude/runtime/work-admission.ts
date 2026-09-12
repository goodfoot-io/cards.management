/**
 * Claude's injected turn and SubagentStart admission boundaries.
 * @summary Claude durable work admission
 * @module work-admission
 */
import type { WorkAuthority, WorkBoundary } from '../../shared/work-authority.js';

/**
 * Admits a Claude boundary before downstream hook work.
 * @param _authority - Injected authority.
 * @param _boundary - Stable host boundary.
 */
export async function admitClaudeBoundary(_authority: WorkAuthority, _boundary: WorkBoundary): Promise<void> {
  await _authority.admit(_boundary);
}

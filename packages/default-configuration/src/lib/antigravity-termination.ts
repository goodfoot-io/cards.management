/**
 * Bounded termination for a stable, launcher-owned Antigravity process tree.
 * @summary Stable Antigravity process-tree termination
 * @module
 */
import type { ChildProcess } from 'node:child_process';
import {
  createOwnedTreeTerminator,
  createProcessTreeAuthority,
  type OwnedProcessIdentity,
  type OwnedTreeTerminationOptions,
  type OwnedTreeTerminationResult,
  type ProcessTreeAuthority
} from './process-tree-termination.js';

export type AntigravityTerminationResult = OwnedTreeTerminationResult;

export interface AntigravityTerminationOptions extends OwnedTreeTerminationOptions {
  /** Test seam applied only after the stable identity has been revalidated. */
  readonly signalTree?: (child: ChildProcess, signal: NodeJS.Signals) => void | Promise<void>;
}

export interface AntigravityTerminationController {
  terminate(): Promise<AntigravityTerminationResult>;
}

/**
 * Captures the spawned root identity immediately and creates one idempotent terminator.
 * @param child - Spawned root process.
 * @param options - Identity authority and escalation deadlines.
 * @returns A controller shared by every termination request.
 */
export function createAntigravityTerminationController(
  child: ChildProcess,
  options: AntigravityTerminationOptions
): AntigravityTerminationController {
  let authority = options.authority;
  if (options.signalTree) {
    const base = authority ?? createProcessTreeAuthority();
    const signalTree = options.signalTree;
    authority = {
      identify: (processId: number) => base.identify(processId),
      members: (identity: OwnedProcessIdentity) => base.members?.(identity) ?? Promise.resolve([identity]),
      async signal(identity: OwnedProcessIdentity, signal: NodeJS.Signals) {
        const current = await base.identify(identity.processId);
        if (current === null) return 'exited';
        if (current.bootId !== identity.bootId || current.startedAtToken !== identity.startedAtToken) return 'refused';
        try {
          await signalTree(child, signal);
          return 'sent';
        } catch {
          return 'refused';
        }
      }
    } satisfies ProcessTreeAuthority;
  }
  const terminate = createOwnedTreeTerminator(child.pid, { ...options, authority });
  return {
    terminate() {
      return terminate();
    }
  };
}

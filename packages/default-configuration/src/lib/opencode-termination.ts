/**
 * Bounded termination for a stable, launcher-owned Opencode process tree.
 * @summary Stable Opencode process-tree termination
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

export type OpencodeTerminationResult = OwnedTreeTerminationResult;
export type OpencodeTerminationReason = 'cancel' | 'shutdown';
export interface OpencodeTerminationOptions extends OwnedTreeTerminationOptions {
  /** Test seam applied only after the stable identity has been revalidated. */
  readonly signalTree?: (child: ChildProcess, signal: NodeJS.Signals) => void | Promise<void>;
}

export interface OpencodeTerminationController {
  terminate(reason: 'cancel' | 'shutdown'): Promise<OpencodeTerminationResult>;
}

/**
 * Captures the spawned root identity immediately and creates one idempotent terminator.
 * @param child - Spawned root process.
 * @param options - Identity authority and escalation deadlines.
 * @returns A controller shared by every termination request.
 */
export function createOpencodeTerminationController(
  child: ChildProcess,
  options: OpencodeTerminationOptions
): OpencodeTerminationController {
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
    terminate(_reason: 'cancel' | 'shutdown') {
      return terminate();
    }
  };
}

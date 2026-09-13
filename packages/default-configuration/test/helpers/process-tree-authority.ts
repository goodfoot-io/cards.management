/**
 * Stable process identity authority for session tests whose child process is synthetic.
 * @summary Synthetic stable process identity authority
 * @module
 */
import type { OwnedProcessIdentity, ProcessTreeAuthority } from '../../src/lib/process-tree-termination.js';

/**
 * Creates a stable authority while preserving process.kill signal assertions.
 * @returns An isolated authority for one synthetic launcher process tree.
 */
export function createSyntheticProcessTreeAuthority(): ProcessTreeAuthority {
  const identities = new Map<number, OwnedProcessIdentity>();
  const exited = new Set<number>();
  return {
    async identify(processId) {
      if (exited.has(processId)) return null;
      let identity = identities.get(processId);
      if (!identity) {
        identity = { processId, bootId: 'test-boot', startedAtToken: `test-start-${processId}`, groupId: processId };
        identities.set(processId, identity);
      }
      return identity;
    },
    async members(identity) {
      return [identity];
    },
    async signal(identity, signal) {
      try {
        process.kill(process.platform === 'win32' ? identity.processId : -identity.groupId, signal);
      } catch {
        // Synthetic PIDs do not exist in the host process table. Delivery is
        // represented by the state transition below; spies still observe the
        // attempted platform signal.
      }
      exited.add(identity.processId);
      return 'sent';
    }
  };
}

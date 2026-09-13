/**
 * Stable-identity process-tree termination shared by agent launchers.
 * @summary Fail-closed launcher-owned process-tree termination
 * @module
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface OwnedProcessIdentity {
  readonly processId: number;
  readonly bootId: string;
  readonly startedAtToken: string;
  readonly groupId: number;
}

export interface ProcessTreeAuthority {
  identify(processId: number): Promise<OwnedProcessIdentity | null>;
  members?(identity: OwnedProcessIdentity): Promise<readonly OwnedProcessIdentity[] | null>;
  signal(identity: OwnedProcessIdentity, signal: NodeJS.Signals): Promise<'sent' | 'exited' | 'refused'>;
}

export interface OwnedTreeTerminationOptions {
  readonly gracefulTimeoutMs: number;
  readonly forceTimeoutMs: number;
  readonly authority?: ProcessTreeAuthority;
}

export type OwnedTreeTerminationResult = 'graceful' | 'forced' | 'failed';

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function run(command: string, args: readonly string[]): Promise<{ stdout: string; failed: boolean }> {
  return new Promise((resolve) =>
    execFile(command, args, (error, stdout) => resolve({ stdout: String(stdout), failed: error !== null }))
  );
}

/**
 * Creates the production stable process identity and signaling authority.
 * @returns The current-platform authority.
 */
export function createProcessTreeAuthority(): ProcessTreeAuthority {
  const authority: ProcessTreeAuthority = {
    async identify(processId) {
      if (!Number.isSafeInteger(processId) || processId < 1) return null;
      if (process.platform === 'win32') {
        const query = await run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${processId}").CreationDate.ToUniversalTime().Ticks`
        ]);
        const startedAtToken = query.stdout.trim();
        if (query.failed || !startedAtToken) return null;
        return { processId, bootId: process.env['COMPUTERNAME'] ?? 'windows', startedAtToken, groupId: processId };
      }
      try {
        const [bootId, stat] = await Promise.all([
          readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
          readFile(`/proc/${processId}/stat`, 'utf8')
        ]);
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        if (fields[0] === 'Z' || !fields[19]) return null;
        return { processId, bootId: bootId.trim(), startedAtToken: fields[19], groupId: processId };
      } catch {
        return null;
      }
    },
    async signal(identity, signal) {
      const current = await authority.identify(identity.processId);
      if (current === null) return 'exited';
      if (current.bootId !== identity.bootId || current.startedAtToken !== identity.startedAtToken) return 'refused';
      if (process.platform === 'win32') {
        const result = await run('taskkill.exe', [
          '/PID',
          String(identity.processId),
          '/T',
          ...(signal === 'SIGKILL' ? ['/F'] : [])
        ]);
        return result.failed ? 'refused' : 'sent';
      }
      try {
        process.kill(-identity.groupId, signal);
        return 'sent';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'refused';
      }
    },
    async members(identity) {
      if (process.platform === 'win32') return [identity];
      const result = await run('ps', ['-eo', 'pid=,pgid=,stat=']);
      if (result.failed) return null;
      const processIds = result.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(
          (fields) => fields.length === 3 && Number(fields[1]) === identity.groupId && !fields[2]?.startsWith('Z')
        )
        .map((fields) => Number(fields[0]));
      const identified = await Promise.all(processIds.map((processId) => authority.identify(processId)));
      if (identified.some((value) => value === null)) return null;
      return identified.map((value) => ({ ...(value as OwnedProcessIdentity), groupId: identity.groupId }));
    }
  };
  return authority;
}

/**
 * Captures identity immediately and returns one idempotent, bounded terminator.
 * @param processId - Spawned root process id.
 * @param options - Identity authority and escalation deadlines.
 * @returns A termination operation whose callers share one result.
 */
export function createOwnedTreeTerminator(
  processId: number | undefined,
  options: OwnedTreeTerminationOptions
): () => Promise<OwnedTreeTerminationResult> {
  const authority = options.authority ?? createProcessTreeAuthority();
  const identity = processId === undefined ? Promise.resolve(null) : authority.identify(processId);
  let termination: Promise<OwnedTreeTerminationResult> | undefined;

  return () => {
    termination ??= (async () => {
      const owned = await identity;
      if (owned === null) return 'failed';
      const current = await authority.identify(owned.processId);
      if (current === null) return 'graceful';
      if (current.bootId !== owned.bootId || current.startedAtToken !== owned.startedAtToken) return 'failed';
      const members = authority.members ? await authority.members(owned) : [owned];
      if (members === null || members.length === 0) return 'failed';
      const graceful = await authority.signal(owned, 'SIGTERM');
      if (graceful === 'refused') return 'failed';
      const waitForMembers = async (timeoutMs: number): Promise<'exited' | 'active' | 'unknown'> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
          let active = false;
          for (const member of members) {
            const observed = await authority.identify(member.processId);
            if (observed === null) continue;
            if (observed.bootId !== member.bootId || observed.startedAtToken !== member.startedAtToken)
              return 'unknown';
            active = true;
          }
          if (!active) return 'exited';
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await delay(Math.min(10, remaining));
        }
        return 'active';
      };
      if (graceful === 'exited' || (await waitForMembers(options.gracefulTimeoutMs)) === 'exited') return 'graceful';
      let forceAuthority: OwnedProcessIdentity | undefined;
      for (const member of members) {
        const observed = await authority.identify(member.processId);
        if (observed?.bootId === member.bootId && observed.startedAtToken === member.startedAtToken) {
          forceAuthority = member;
          break;
        }
      }
      if (!forceAuthority) return 'failed';
      const forced = await authority.signal(forceAuthority, 'SIGKILL');
      if (forced === 'refused') return 'failed';
      return forced === 'exited' || (await waitForMembers(options.forceTimeoutMs)) === 'exited' ? 'forced' : 'failed';
    })();
    return termination;
  };
}

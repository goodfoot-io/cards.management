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
        // fields[2] is /proc's real `pgrp` column. Provider roots are no longer
        // spawned detached, so they usually share their launcher's process
        // group rather than leading their own — this must be the OS-reported
        // group, never a synthesized value assumed equal to processId.
        const groupId = Number(fields[2]);
        if (!Number.isSafeInteger(groupId)) return null;
        return { processId, bootId: bootId.trim(), startedAtToken: fields[19], groupId };
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
      // Providers may share their launcher's process group instead of leading
      // their own, so a group-wide `-pgid` signal could reach the launcher and
      // unrelated siblings in it. Signal only this individually
      // identity-revalidated member PID; callers are responsible for walking
      // every member of the owned tree.
      if (!Number.isSafeInteger(identity.processId) || identity.processId <= 1) {
        return 'refused';
      }
      try {
        process.kill(identity.processId, signal);
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
 * TERM's, then (after a grace window) KILL's every member of `members`
 * individually — never a single group-wide signal — rescanning group
 * membership via `authority.members` before the force phase so a late fork
 * during the graceful window isn't missed.
 *
 * Shared by {@link createOwnedTreeTerminator} (action-tree cleanup) and the
 * branch-cleanup worker's own deadline enforcement over its git descendants,
 * so both use the same identity-checked TERM/KILL discipline instead of a
 * bare `setTimeout`/promise-race abandonment.
 *
 * @param members - Identity-verified members to signal. Must not include a
 *   process the caller wants left alone (e.g. its own control identity) —
 *   this signals every member passed in.
 * @param authority - Identity and signaling authority.
 * @param options - Escalation deadlines, plus an optional process id to keep
 *   excluded from the force-phase rescan (the rescan walks the whole process
 *   group again, which would otherwise reintroduce a caller's own live,
 *   deliberately-excluded identity).
 * @returns The outcome of the escalation.
 */
export async function terminateProcessMembers(
  members: readonly OwnedProcessIdentity[],
  authority: ProcessTreeAuthority,
  options: Pick<OwnedTreeTerminationOptions, 'gracefulTimeoutMs' | 'forceTimeoutMs'> & {
    readonly excludeProcessId?: number;
  }
): Promise<OwnedTreeTerminationResult> {
  if (members.length === 0) return 'graceful';
  // Never a single group-wide signal: every member is its own verified PID,
  // so each is TERM'd/KILL'd individually and a refusal on any one of them
  // fails the whole operation closed.
  const signalMembers = async (
    targets: readonly OwnedProcessIdentity[],
    signal: NodeJS.Signals
  ): Promise<'sent' | 'exited' | 'refused'> => {
    let allExited = true;
    for (const target of targets) {
      const outcome = await authority.signal(target, signal);
      if (outcome === 'refused') return 'refused';
      if (outcome !== 'exited') allExited = false;
    }
    return allExited ? 'exited' : 'sent';
  };
  const waitForMembers = async (
    targets: readonly OwnedProcessIdentity[],
    timeoutMs: number
  ): Promise<'exited' | 'active' | 'unknown'> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      let active = false;
      for (const member of targets) {
        const observed = await authority.identify(member.processId);
        if (observed === null) continue;
        if (observed.bootId !== member.bootId || observed.startedAtToken !== member.startedAtToken) return 'unknown';
        active = true;
      }
      if (!active) return 'exited';
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(10, remaining));
    }
    return 'active';
  };
  const graceful = await signalMembers(members, 'SIGTERM');
  if (graceful === 'refused') return 'failed';
  if (graceful === 'exited' || (await waitForMembers(members, options.gracefulTimeoutMs)) === 'exited') {
    return 'graceful';
  }
  // Rescan before force: the graceful window may have let the tree gain or
  // lose members (e.g. a late fork), so force must not act on a stale set.
  const rescanned = authority.members ? await authority.members(members[0] as OwnedProcessIdentity) : members;
  if (rescanned === null || rescanned.length === 0) return 'failed';
  const forceMembers =
    options.excludeProcessId === undefined
      ? rescanned
      : rescanned.filter((member) => member.processId !== options.excludeProcessId);
  if (forceMembers.length === 0) return 'graceful';
  const forced = await signalMembers(forceMembers, 'SIGKILL');
  if (forced === 'refused') return 'failed';
  return forced === 'exited' || (await waitForMembers(forceMembers, options.forceTimeoutMs)) === 'exited'
    ? 'forced'
    : 'failed';
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
      return terminateProcessMembers(members, authority, options);
    })();
    return termination;
  };
}
